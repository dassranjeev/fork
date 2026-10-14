import { BadRequestException, HttpStatus, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { StripeIntent } from '../database/entities';
import { SettingsService } from '../settings/settings.service';
import { StripeClientService, toCents } from '../integrations/stripe-client.service';
import { PaymentsService, payError } from '../orders/payments.service';
import { WalletService } from '../orders/wallet.service';
import { GiftCardsService } from '../marketing/gift-cards.service';

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const isMockId = (id?: string | null) => !!id && id.includes('_mock_');
const mockId = (prefix: string) => `${prefix}_mock_${randomUUID().replace(/-/g, '').slice(0, 20)}`;

export interface FulfilResult {
  status: 'credited' | 'issued' | 'already' | 'not_paid' | 'ignored';
  paymentStatus?: string;
  balance?: number;
  amount?: number;
  giftCard?: { id: string; code: string; amount: number };
}

/**
 * Money that is not an order but still goes through Stripe: wallet top-ups and gift-card purchases.
 * A PaymentIntent with AUTOMATIC capture is created here, the page pays it with the Payment Element, and the credit / gift card is
 * handed out EXACTLY ONCE: whichever of {confirm endpoint, payment_intent.succeeded webhook, clean-up cron} gets there first claims
 * the row (UPDATE ... WHERE consumedAt IS NULL), the others see "already".
 */
@Injectable()
export class TopUpService {
  private readonly logger = new Logger('TopUp');

  constructor(
    @InjectRepository(StripeIntent) private intents: Repository<StripeIntent>,
    private stripeClient: StripeClientService,
    private settings: SettingsService,
    private payments: PaymentsService,
    private wallet: WalletService,
    private moduleRef: ModuleRef,
  ) {}

  private giftCards(): GiftCardsService {
    return this.moduleRef.get(GiftCardsService, { strict: false });
  }

  private async newIntent(customerId: string, purpose: 'TOPUP' | 'GIFT_CARD', amount: number, meta: Record<string, any>, description: string) {
    const stripe = this.stripeClient.client();
    const cfg = this.stripeClient.config();
    if (!stripe) {
      if (!this.stripeClient.mockAllowed()) throw new ServiceUnavailableException('Payments are temporarily unavailable');
      const row = await this.intents.save(this.intents.create({ intentId: mockId('pi'), customerId, purpose, amount, currency: 'cad', status: 'requires_payment_method', meta }));
      return { intentId: row.intentId, clientSecret: `${row.intentId}_secret_mock`, amount, currency: 'cad', publishableKey: null, mock: true };
    }
    const pi = await this.payments.retryMissingCustomer(customerId, async () => {
      const customer = await this.payments.stripeCustomer(stripe, customerId);
      return stripe.paymentIntents.create(
        {
          amount: toCents(amount),
          currency: 'cad',
          customer,
          automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
          description,
          metadata: { customerId, purpose },
        },
        { idempotencyKey: `${purpose.toLowerCase()}-${customerId}-${randomUUID()}` },
      );
    });
    await this.intents.save(this.intents.create({ intentId: pi.id, customerId, purpose, amount, currency: 'cad', status: pi.status, meta }));
    return { intentId: pi.id, clientSecret: pi.client_secret, amount, currency: 'cad', publishableKey: cfg.publishableKey || null, mock: false };
  }

  // ------------------------------------------------------------------ wallet top-up
  async createTopUpIntent(customerId: string, amount: number) {
    if (!this.settings.get<boolean>('payments.walletEnabled', true)) throw new BadRequestException('Wallet top-ups are switched off');
    const min = Number(this.settings.get('payments.topUpMin', 5));
    const max = Number(this.settings.get('payments.topUpMax', 500));
    const a = round2(amount);
    if (!Number.isFinite(a) || a < min || a > max) throw new BadRequestException(`Top-up amount must be between $${min.toFixed(2)} and $${max.toFixed(2)}`);
    return this.newIntent(customerId, 'TOPUP', a, {}, 'FORKY wallet top-up');
  }

  async createGiftCardIntent(customerId: string, input: { amount: number; recipientEmail?: string; message?: string }) {
    if (!this.settings.get<boolean>('payments.giftCardsEnabled', true)) throw new BadRequestException('Gift cards are switched off');
    const a = round2(input.amount);
    if (!Number.isFinite(a) || a < 10 || a > 500) throw new BadRequestException('Gift card amount must be between $10.00 and $500.00');
    return this.newIntent(customerId, 'GIFT_CARD', a, { recipientEmail: input.recipientEmail ?? null, message: input.message ?? null }, 'FORKY gift card');
  }

  // ------------------------------------------------------------------ fulfilment (exactly once)
  /** The customer's page says "paid": verify with Stripe and credit / issue. Safe to call any number of times. */
  async confirm(customerId: string, intentId: string): Promise<FulfilResult> {
    const row = await this.intents.findOne({ where: { intentId } });
    if (!row || row.customerId !== customerId || row.purpose === 'ORDER') throw payError(HttpStatus.BAD_REQUEST, 'PAYMENT_INTENT_INVALID', 'This payment was not found.');
    return this.fulfil(intentId, { mockPaid: true });
  }

  /** Credit the wallet / issue the gift card for a paid intent. Used by confirm, the webhook and the cron. */
  async fulfil(intentId: string, opts: { mockPaid?: boolean } = {}): Promise<FulfilResult> {
    const row = await this.intents.findOne({ where: { intentId } });
    if (!row || row.purpose === 'ORDER') return { status: 'ignored' };
    if (row.consumedAt) return { status: 'already', amount: Number(row.amount), balance: row.meta?.balanceAfter, giftCard: row.meta?.giftCard };
    // 1. is it really paid? (never trust the browser: ask Stripe)
    if (isMockId(intentId)) {
      if (!this.stripeClient.mockAllowed() || !opts.mockPaid) return { status: 'not_paid' };
    } else {
      const stripe = this.stripeClient.client();
      if (!stripe) throw new ServiceUnavailableException('Payments are temporarily unavailable');
      const pi = await stripe.paymentIntents.retrieve(intentId);
      await this.intents.update({ id: row.id }, { status: pi.status });
      if (pi.status !== 'succeeded') return { status: 'not_paid', paymentStatus: pi.status };
      if (pi.amount !== toCents(Number(row.amount)) || pi.currency !== 'cad' || pi.metadata?.customerId !== row.customerId) {
        this.logger.error(`Intent ${intentId} paid ${pi.amount} but expected ${toCents(Number(row.amount))} for customer ${row.customerId}: NOT credited`);
        throw payError(HttpStatus.CONFLICT, 'PAYMENT_AMOUNT_MISMATCH', 'The paid amount does not match. Support has been notified.');
      }
    }
    // 2. claim (exactly once)
    const claim = await this.intents.createQueryBuilder().update(StripeIntent).set({ consumedAt: new Date(), status: 'succeeded' }).where('id = :id AND "consumedAt" IS NULL', { id: row.id }).execute();
    if (!claim.affected) return { status: 'already', amount: Number(row.amount) };
    try {
      if (row.purpose === 'TOPUP') {
        const balance = await this.wallet.credit(row.customerId, Number(row.amount), 'TOPUP', { note: `Wallet top-up (${intentId})` });
        await this.intents.update({ id: row.id }, { meta: { ...(row.meta ?? {}), balanceAfter: balance } } as any);
        return { status: 'credited', amount: Number(row.amount), balance };
      }
      const cards = await this.giftCards().issue({ amount: Number(row.amount), count: 1, recipientEmail: row.meta?.recipientEmail ?? null, message: row.meta?.message ?? undefined, issuedById: row.customerId });
      const gc = { id: cards[0].id, code: cards[0].code, amount: Number(row.amount) };
      await this.intents.update({ id: row.id }, { meta: { ...(row.meta ?? {}), giftCard: gc } } as any);
      return { status: 'issued', amount: Number(row.amount), giftCard: gc };
    } catch (e) {
      // un-claim so the webhook / a retry can finish the job
      await this.intents.update({ id: row.id }, { consumedAt: null });
      this.logger.error(`fulfilment of ${intentId} failed: ${(e as Error).message}`);
      throw e;
    }
  }
}
