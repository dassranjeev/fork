import { ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { InjectThrottlerOptions, InjectThrottlerStorage, ThrottlerGuard, ThrottlerModuleOptions, ThrottlerOptions, ThrottlerStorage } from '@nestjs/throttler';
import { clientIp } from './security';

/**
 * Rate-limit tiers (all per minute, in-memory storage - use ThrottlerStorageRedisService when running >1 instance):
 *
 *  default  per tracker + route     authenticated user: 300   anonymous IP: 120
 *  write    per tracker + route     POST/PUT/PATCH/DELETE: 120 (auth) / 40 (anon)
 *  global   per tracker, all routes authenticated user: 1200  anonymous IP: 400
 *  ip       per IP, all routes      3000  (many users behind one NAT / office; stops one IP spraying many tokens)
 *
 * Tracker = verified JWT subject (`u:<id>`) when a valid token is presented, otherwise the client IP (`ip:<ip>`).
 * A forged / invalid token never creates its own bucket - it falls back to the IP bucket, so it can't be used to dodge limits.
 * Sensitive routes override `default` with @Throttle({ default: { limit, ttl } }) (login, OTP, reset, promo, gift card ...).
 */
export const THROTTLE_PROFILE = {
  defaultAuth: 300,
  defaultAnon: 120,
  writeAuth: 120,
  writeAnon: 40,
  globalAuth: 1200,
  globalAnon: 400,
  ip: 3000,
};

const isAuthed = (req: any) => typeof req?._tracker === 'string' && req._tracker.startsWith('u:');
const isWrite = (ctx: ExecutionContext) => !['GET', 'HEAD', 'OPTIONS'].includes(ctx.switchToHttp().getRequest().method);
const reqOf = (ctx: ExecutionContext) => ctx.switchToHttp().getRequest();

export function throttlerDefinitions(): ThrottlerOptions[] {
  const T = THROTTLE_PROFILE;
  return [
    { name: 'default', ttl: 60_000, limit: (c) => (isAuthed(reqOf(c)) ? T.defaultAuth : T.defaultAnon) },
    { name: 'write', ttl: 60_000, limit: (c) => (isAuthed(reqOf(c)) ? T.writeAuth : T.writeAnon), skipIf: (c) => !isWrite(c) },
    {
      name: 'global',
      ttl: 60_000,
      limit: (c) => (isAuthed(reqOf(c)) ? T.globalAuth : T.globalAnon),
      generateKey: (_c, tracker, name) => `${name}:${tracker}`,
    },
    {
      name: 'ip',
      ttl: 60_000,
      limit: T.ip,
      getTracker: (req) => `ip:${clientIp(req)}`,
      generateKey: (_c, tracker, name) => `${name}:${tracker}`,
    },
  ];
}

@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storage: ThrottlerStorage,
    reflector: Reflector,
    private jwt: JwtService,
    private config: ConfigService,
  ) {
    super(options, storage, reflector);
  }

  protected async getTracker(req: Record<string, any>): Promise<string> {
    if (req._tracker) return req._tracker;
    let tracker = `ip:${clientIp(req)}`;
    const h = req.headers?.authorization as string | undefined;
    if (h && /^Bearer /i.test(h) && h.length < 4096) {
      try {
        const p: any = this.jwt.verify(h.slice(7), { secret: this.config.get('jwt.secret'), algorithms: ['HS256'], issuer: this.config.get('jwt.issuer'), audience: this.config.get('jwt.audience') });
        if (p?.sub && !p.pending2fa) tracker = `u:${p.sub}`;
      } catch {
        /* invalid/expired token: counted against the IP */
      }
    }
    req._tracker = tracker;
    return tracker;
  }

  /** Keep the real IP available to downstream code / logs even when the tracker is a user id. */
  protected async throwThrottlingException(context: ExecutionContext, detail: any): Promise<void> {
    const req = context.switchToHttp().getRequest();
    // surfaced to AuditService by the exception filter (rate-limit hits are security events)
    req._rateLimited = { tracker: detail?.tracker, key: detail?.key };
    return super.throwThrottlingException(context, detail);
  }
}
