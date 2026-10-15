import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, LessThan, Not, Repository } from 'typeorm';
import { StripeIntent } from '../database/entities';
import { SettingsService } from '../settings/settings.service';
import { PaymentsService } from '../orders/payments.service';
import { TopUpService } from './topup.service';

/**
 * Money must not be left in limbo. Every 5 minutes:
 *  - ORDER payments that went through (the card was charged at checkout) but never became an order, because the customer closed the page or lost the
 *    connection after paying, are REFUNDED once they are older than payments.paidWithoutOrderMinutes (10);
 *  - ORDER intents that were never paid and are older than payments.abandonedIntentMinutes (60) are cancelled at Stripe;
 *  - wallet top-up / gift card intents that were PAID but never credited (the browser closed, the webhook was missed) are fulfilled;
 *  - top-up / gift card intents that were never paid are cancelled after the same delay as the unpaid order intents.
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

  @Cron('0 */5 * * * *')
  async sweepCron() {
    await this.sweep().catch((e) => this.logger.error(`sweep failed: ${e.message}`));
  }

  /** Returns what was done (used by tests). `olderThanMinutes` overrides both settings. */
  async sweep(olderThanMinutes?: number): Promise<{ cancelled: number; refunded: number; fulfilled: number; skipped: number }> {
    const out = { cancelled: 0, refunded: 0, fulfilled: 0, skipped: 0 };
    if (this.running) return out;
    this.running = true;
    try {
      const minutes = Math.max(0, Number(olderThanMinutes ?? this.settings.get('payments.abandonedIntentMinutes', 60)));
      const paidMinutes = Math.max(0, Number(olderThanMinutes ?? this.settings.get('payments.paidWithoutOrderMinutes', 10)));
      const cutoff = new Date(Date.now() - minutes * 60_000);

      // paid, but no order took the payment: give the money back. The payment itself must be at least `paidMinutes` old (Stripe's charge time is checked too),
      // so a customer whose page is still placing the order is never refunded under their feet.
      const paid = await this.intents.find({ where: { purpose: 'ORDER', orderId: IsNull(), canceledAt: IsNull(), status: 'succeeded', updatedAt: LessThan(new Date(Date.now() - paidMinutes * 60_000)) }, take: 200 });
      for (const row of paid) {
        try {
          const r = await this.payments.cancelAbandoned(row, { minAgeMinutes: paidMinutes });
          if (r === 'refunded') out.refunded++;
          else if (r === 'cancelled') out.cancelled++;
          else out.skipped++;
        } catch (e: any) {
          out.skipped++;
          this.logger.warn(`could not refund the unused payment ${row.intentId}: ${e?.code ?? e?.message}`);
        }
      }

      // never paid / never used (the status stored here can be stale when a webhook was missed: Stripe is asked, and a payment that did go through is refunded)
      const stale = await this.intents.find({ where: { purpose: 'ORDER', orderId: IsNull(), canceledAt: IsNull(), status: Not(In(['canceled', 'succeeded'])), createdAt: LessThan(cutoff) }, take: 200 });
      for (const row of stale) {
        try {
          const r = await this.payments.cancelAbandoned(row, { minAgeMinutes: paidMinutes });
          if (r === 'refunded') out.refunded++;
          else if (r === 'cancelled') out.cancelled++;
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
            if ((await this.payments.cancelAbandoned(row)) === 'cancelled') out.cancelled++;
          }
        } catch (e: any) {
          out.skipped++;
          this.logger.warn(`could not settle ${row.intentId}: ${e?.code ?? e?.message}`);
        }
      }
      if (out.cancelled || out.refunded || out.fulfilled) this.logger.log(`abandoned intents: cancelled ${out.cancelled}, refunded ${out.refunded}, fulfilled ${out.fulfilled}`);
    } finally {
      this.running = false;
    }
    return out;
  }
}
