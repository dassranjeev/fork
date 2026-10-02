import { Body, Controller, ForbiddenException, Headers, Logger, Post, Req, UnauthorizedException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { createHmac, timingSafeEqual } from 'crypto';
import { Public } from '../common/decorators';
import { CertnAdapter } from './adapters/certn.adapter';
import { DriversAdminService } from './drivers-admin.service';

/**
 * Certn calls this when a background check result is ready (SOP-02 step 2).
 * Authenticated with a shared secret (CERTN_WEBHOOK_SECRET): either an HMAC-SHA256 of the raw JSON body in
 * `X-Certn-Signature` (hex) or the secret itself in `X-Webhook-Secret`. Without the secret configured the endpoint
 * is closed in production (a forged "CLEAR" would otherwise approve a driver's background check).
 */
@Controller('public/webhooks/certn')
@Public()
export class CertnWebhookController {
  private readonly logger = new Logger('CertnWebhook');

  constructor(
    private certn: CertnAdapter,
    private drivers: DriversAdminService,
  ) {}

  private authentic(raw: Buffer | undefined, sig?: string, plain?: string): boolean {
    const secret = process.env.CERTN_WEBHOOK_SECRET ?? '';
    if (!secret) return process.env.NODE_ENV !== 'production'; // dev convenience only
    const eq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
    if (plain && eq(plain, secret)) return true;
    if (sig) {
      const expected = createHmac("sha256", secret).update(raw ?? Buffer.alloc(0)).digest('hex');
      return eq(sig.trim().toLowerCase(), expected);
    }
    return false;
  }

  @Post()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async handle(@Body() body: any, @Headers('x-certn-signature') sig?: string, @Headers('x-webhook-secret') plain?: string, @Req() req?: any) {
    if (!this.authentic(req?.rawBody, sig, plain)) {
      this.logger.warn(`Rejected unauthenticated Certn webhook from ${req?.ip}`);
      throw new UnauthorizedException();
    }
    if (!body || typeof body !== 'object') throw new ForbiddenException();
    const result = this.certn.parseWebhook(body);
    if (!result) {
      this.logger.warn('Unrecognised Certn webhook payload');
      return { ok: false };
    }
    const applied = await this.drivers.applyBackgroundResult(result);
    return { ok: applied };
  }
}
