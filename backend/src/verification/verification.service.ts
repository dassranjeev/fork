import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AuthUser } from '../common/auth.types';
import { Events, SubjectRegisteredEvent } from '../common/contracts';
import { VerificationAudience, VerificationMethod } from '../common/enums';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { BackgroundCheckResult } from '../drivers/adapters/certn.adapter';
import {
  POLICY_KEYS,
  VerificationChoice,
  VerificationPolicy,
  certnStatus,
  describeMode,
  readPolicy,
} from './verification-policy';
import { AudienceHandler, ForceItemResult, ForceOutcome, RegistrationResult } from './verification.types';
import { DriverVerification } from './driver-verification';
import { BusinessVerification } from './business-verification';
import { ForceVerificationDto, SubjectsQuery, UpdatePolicyDto } from './verification.dto';

/** Of a big force batch only this many Certn checks are started inside the request; the sweeper starts the rest, a few dozen a minute. */
const IMMEDIATE_CHECKS = 20;
/** Batches up to this size take accounts off the road inside the request; bigger ones are left to the sweeper (which runs every minute). */
const INLINE_BLOCK_LIMIT = 50;
const CHECKS_PER_SWEEP = 40;

/**
 * Registration and verification of drivers and businesses (docs/verification.md).
 *
 * The Super Admin sets, per audience, whether registration is instant and which verification method applies (manual review or the
 * Certn check). New sign-ups are handled by that policy; "Force verification" puts accounts that were admitted without verification
 * through the method. This service is the single entry point; DriverVerification and BusinessVerification hold what differs.
 */
@Injectable()
export class VerificationService {
  private readonly logger = new Logger('Verification');
  private sweeping = false;

  constructor(
    private settings: SettingsService,
    private audit: AuditService,
    private drivers: DriverVerification,
    private businesses: BusinessVerification,
  ) {}

  private handler(audience: VerificationAudience): AudienceHandler {
    return audience === VerificationAudience.DRIVER ? this.drivers : this.businesses;
  }

  policy(audience: VerificationAudience): VerificationPolicy {
    return readPolicy(this.settings, audience);
  }

  // ------------------------------------------------------------------ registration
  /** A driver or business signed up. Applies the policy and tells the auth layer what to say to the new account. Never throws: on a failure the account stays in the manual queue. */
  @OnEvent(Events.VERIFICATION_SUBJECT_REGISTERED)
  async onRegistered(e: SubjectRegisteredEvent): Promise<RegistrationResult | null> {
    const audience = e.audience === 'DRIVER' ? VerificationAudience.DRIVER : VerificationAudience.BUSINESS;
    try {
      return await this.handler(audience).onRegistered(e.id, this.policy(audience));
    } catch (err: any) {
      this.logger.error(`could not apply the registration policy to ${e.audience} ${e.id}: ${err.message}`);
      return null;
    }
  }

  // ------------------------------------------------------------------ policy
  private view(audience: VerificationAudience) {
    const p = this.policy(audience);
    return {
      instant: p.instant,
      method: p.method,
      mode: p.mode,
      description: describeMode(audience, p.mode),
      modes: {
        INSTANT: describeMode(audience, VerificationMethod.INSTANT),
        MANUAL: describeMode(audience, VerificationMethod.MANUAL),
        AUTOMATIC: describeMode(audience, VerificationMethod.AUTOMATIC),
      },
    };
  }

  /** Everything the Verification page shows: the policy, Certn readiness and how many accounts are in each state. */
  async overview() {
    const [driverCounts, businessCounts] = await Promise.all([this.drivers.counts(), this.businesses.counts()]);
    return {
      certn: certnStatus(),
      drivers: { policy: this.view(VerificationAudience.DRIVER), counts: driverCounts },
      businesses: { policy: this.view(VerificationAudience.BUSINESS), counts: businessCounts },
    };
  }

  async updatePolicy(dto: UpdatePolicyDto, actor: AuthUser, req?: any) {
    const certn = certnStatus();
    const before = { drivers: this.policy(VerificationAudience.DRIVER), businesses: this.policy(VerificationAudience.BUSINESS) };
    const changes: [string, boolean | string][] = [];
    for (const [audience, patch] of [
      [VerificationAudience.DRIVER, dto.drivers],
      [VerificationAudience.BUSINESS, dto.businesses],
    ] as const) {
      if (!patch) continue;
      if (patch.method === VerificationMethod.AUTOMATIC && !certn.ready) {
        throw new BadRequestException({ message: certn.reason ?? 'Certn is not ready', code: 'CERTN_NOT_READY' } as any);
      }
      if (patch.instant !== undefined) changes.push([POLICY_KEYS[audience].instant, patch.instant]);
      if (patch.method !== undefined) changes.push([POLICY_KEYS[audience].method, patch.method]);
    }
    if (!changes.length) throw new BadRequestException('Nothing to change: send drivers and/or businesses with instant and/or method');
    for (const [key, value] of changes) await this.settings.set(key, value);
    const after = { drivers: this.policy(VerificationAudience.DRIVER), businesses: this.policy(VerificationAudience.BUSINESS) };
    await this.audit.logReq(req, 'verification.policy_update', 'settings', undefined, before, after);
    return { drivers: this.view(VerificationAudience.DRIVER), businesses: this.view(VerificationAudience.BUSINESS) };
  }

  // ------------------------------------------------------------------ Certn
  /** The Certn result (webhook or mock): settled on the driver or business that holds this reference. */
  async applyCertnResult(r: BackgroundCheckResult): Promise<boolean> {
    const driver = await this.drivers.applyResult(r);
    if (driver !== null) return driver;
    return (await this.businesses.applyResult(r)) ?? false;
  }

  // ------------------------------------------------------------------ one account
  details(audience: VerificationAudience, id: string) {
    return this.handler(audience).details(id, this.policy(audience));
  }

  startCheck(audience: VerificationAudience, id: string, actor: AuthUser) {
    return this.handler(audience).startCheck(id, actor);
  }

  verify(audience: VerificationAudience, id: string, actor: AuthUser, dto: { note?: string; override?: boolean }) {
    return this.handler(audience).verify(id, actor, dto, this.policy(audience));
  }

  reject(audience: VerificationAudience, id: string, actor: AuthUser, reason: string) {
    return this.handler(audience).reject(id, actor, reason);
  }

  listSubjects(q: SubjectsQuery) {
    return this.handler(q.audience).list({ status: q.status, search: q.search, page: q.page, limit: q.limit });
  }

  // ------------------------------------------------------------------ force verification
  /**
   * Puts every UNVERIFIED account (or the given ones) through the verification method: the account is marked PENDING with a deadline
   * (`graceDays` from now; 0 = at once), told what to do, and, for the automatic method, a Certn check is started. At the deadline an
   * account that is still not verified is taken off the road (drivers) or off line (businesses) until it is; it comes back by itself
   * when verified. Drivers on a trip and businesses with orders in progress are taken off when that work ends.
   */
  async force(dto: ForceVerificationDto, actor: AuthUser, req?: any) {
    if (!!dto.ids?.length === !!dto.all) throw new BadRequestException('Send either ids or all: true');
    const policy = this.policy(dto.audience);
    const method: VerificationChoice = dto.method ?? policy.method;
    if (method === VerificationMethod.AUTOMATIC) {
      const certn = certnStatus();
      if (!certn.ready) throw new BadRequestException({ message: certn.reason ?? 'Certn is not ready', code: 'CERTN_NOT_READY' } as any);
    }
    const graceDays = dto.graceDays ?? 0;
    const dueAt = new Date(Date.now() + graceDays * 86_400_000);
    const handler = this.handler(dto.audience);
    const { targets, skipped } = await handler.forceTargets(dto.ids);
    const items: ForceItemResult[] = [...skipped];
    let started = 0;
    for (const id of targets) {
      try {
        const startCheckNow = method === VerificationMethod.AUTOMATIC && started < IMMEDIATE_CHECKS;
        if (startCheckNow) started++;
        items.push(await handler.force(id, { method, dueAt, actor, reason: dto.reason, startCheckNow, blockNow: targets.length <= INLINE_BLOCK_LIMIT }));
      } catch (e: any) {
        this.logger.error(`force verification failed for ${dto.audience} ${id}: ${e.message}`);
        items.push({ id, name: '', outcome: 'FAILED', note: e.message });
      }
    }
    const outcomes: Record<ForceOutcome, number> = { BLOCKED: 0, DEFERRED: 0, GRACE: 0, VERIFIED: 0, SKIPPED: 0, FAILED: 0 };
    for (const i of items) outcomes[i.outcome]++;
    await this.audit.logReq(req, 'verification.force', dto.audience === VerificationAudience.DRIVER ? 'driver' : 'merchant', undefined, undefined, {
      audience: dto.audience,
      method,
      graceDays,
      all: !!dto.all,
      requested: dto.ids?.length ?? null,
      matched: targets.length,
      outcomes,
      reason: dto.reason ?? null,
    });
    return { audience: dto.audience, method, graceDays, dueAt, matched: targets.length, outcomes, items: items.slice(0, 200), itemsTruncated: items.length > 200 };
  }

  // ------------------------------------------------------------------ the sweeper
  /**
   * Every minute: takes accounts that passed their verification deadline off the road, starts Certn checks that could not be started
   * earlier (a few retries, then staff are told), and reminds accounts whose deadline is a day away.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async sweep(): Promise<{ blocked: number; checksStarted: number; reminded: number }> {
    const out = { blocked: 0, checksStarted: 0, reminded: 0 };
    if (this.sweeping) return out;
    this.sweeping = true;
    try {
      for (const h of [this.drivers, this.businesses]) {
        try {
          out.blocked += await h.enforceDue();
        } catch (e: any) {
          this.logger.error(`${h.audience} deadline sweep failed: ${e.message}`);
        }
        try {
          out.checksStarted += await h.retryChecks(CHECKS_PER_SWEEP);
        } catch (e: any) {
          this.logger.error(`${h.audience} Certn retry sweep failed: ${e.message}`);
        }
        try {
          out.reminded += await h.remind();
        } catch (e: any) {
          this.logger.error(`${h.audience} reminder sweep failed: ${e.message}`);
        }
      }
    } finally {
      this.sweeping = false;
    }
    return out;
  }
}
