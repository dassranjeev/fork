import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, LessThan, Not, Repository } from 'typeorm';
import { StripeIntent } from '../database/entities';
import { SettingsService } from '../settings/settings.service';
import { PaymentsService } from '../orders/payments.service';
import { TopUpService } from './topup.service';

/**
 * Card holds must not linger. Every 10 minutes:
 *  - ORDER intents older than payments.abandonedIntentMinutes (60) that never became an order are cancelled at Stripe (the customer's money is released);
 *  - wallet top-up / gift card intents that were PAID but never credited (the browser closed, the webhook was missed) are fulfilled;
 *  - top-up / gift card intents that were never paid are cancelled after the same delay.
 */
@Injectable()
export class AbandonedIntentsService {
  private readonly logger = new Logger('AbandonedIntents');
  private running = false;

  constructor(
    @InjectRepository(StripeIntent) private intents: Repository<StripeIntent>,
    private settings: SettingsService,
    private payments: PaymentsService,
    private topups: TopUpService,
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async sweepCron() {
    await this.sweep().catch((e) => this.logger.error(`sweep failed: ${e.message}`));
  }

  /** Returns what was done (used by tests). `olderThanMinutes` overrides the setting. */
  async sweep(olderThanMinutes?: number): Promise<{ cancelled: number; fulfilled: number; skipped: number }> {
    const out = { cancelled: 0, fulfilled: 0, skipped: 0 };
    if (this.running) return out;
    this.running = true;
    try {
      const minutes = Math.max(0, Number(olderThanMinutes ?? this.settings.get('payments.abandonedIntentMinutes', 60)));
      const cutoff = new Date(Date.now() - minutes * 60_000);
      // never paid / never used
      const stale = await this.intents.find({ where: { purpose: 'ORDER', orderId: IsNull(), canceledAt: IsNull(), status: Not(In(['canceled', 'succeeded'])), createdAt: LessThan(cutoff) }, take: 200 });
      for (const row of stale) {
        try {
          if (await this.payments.cancelAbandoned(row)) out.cancelled++;
          else out.skipped++;
        } catch (e: any) {
          out.skipped++;
          this.logger.warn(`could not cancel ${row.intentId}: ${e?.code ?? e?.message}`);
        }
      }
      // wallet top-ups / gift cards
      const money = await this.intents.find({ where: { purpose: In(['TOPUP', 'GIFT_CARD']), consumedAt: IsNull(), canceledAt: IsNull(), status: Not(In(['canceled'])), createdAt: LessThan(new Date(Date.now() - Math.min(minutes, 2) * 60_000)) }, take: 200 });
      for (const row of money) {
        try {
          const r = await this.topups.fulfil(row.intentId);
          if (r.status === 'credited' || r.status === 'issued') out.fulfilled++;
          else if (r.status === 'not_paid' && row.createdAt < cutoff) {
            if (await this.payments.cancelAbandoned(row)) out.cancelled++;
          }
        } catch (e: any) {
          out.skipped++;
          this.logger.warn(`could not settle ${row.intentId}: ${e?.code ?? e?.message}`);
        }
      }
      if (out.cancelled || out.fulfilled) this.logger.log(`abandoned intents: cancelled ${out.cancelled}, fulfilled ${out.fulfilled}`);
    } finally {
      this.running = false;
    }
    return out;
  }
}
