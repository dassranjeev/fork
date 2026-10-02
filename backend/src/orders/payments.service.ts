import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { CustomerProfile, Order, Payment } from '../database/entities';
import { IPaymentsService } from '../common/contracts';
import { SettingsService } from '../settings/settings.service';

/**
 * Card data never touches our servers (PCI DSS SAQ-A scope) - this service only ever
 * handles provider tokens/intent ids.
 *
 *  - With a Stripe secret key (setting `payments.stripe.secretKey` or env STRIPE_SECRET_KEY) every call goes to Stripe
 *    (manual-capture PaymentIntents: authorize at checkout, capture on delivery, cancel on reject, refunds).
 *  - Without a key a deterministic MOCK provider is used - DEVELOPMENT ONLY. It is explicit and impossible in production:
 *    when NODE_ENV=production and no key is configured every payment operation FAILS CLOSED (no free orders).
 */
@Injectable()
export class PaymentsService implements IPaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private cached: { key: string; client: any } | null = null;

  constructor(
    @InjectRepository(Payment) private payments: Repository<Payment>,
    @InjectRepository(CustomerProfile) private profiles: Repository<CustomerProfile>,
    private settings: SettingsService,
  ) {
    if (process.env.NODE_ENV !== 'production') this.logger.warn('Payments: MOCK provider active when no Stripe key is set (development only)');
  }

  private key(): string {
    return this.settings.get<string>('payments.stripe.secretKey', '') || process.env.STRIPE_SECRET_KEY || '';
  }

  /** Mock payments are a dev convenience. Never allowed in production, whatever the settings say. */
  private mockAllowed(): boolean {
    return process.env.NODE_ENV !== 'production' && process.env.PAYMENTS_ALLOW_MOCK !== 'false';
  }

  private stripe(): any | null {
    const key = this.key();
    if (!key) return null;
    if (!this.cached || this.cached.key !== key) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Stripe = require('stripe');
      this.cached = { key, client: new (Stripe.default ?? Stripe)(key, { maxNetworkRetries: 2, timeout: 20_000 }) };
    }
    return this.cached.client;
  }

  /** Stripe client, the mock marker (null) or a hard failure in production. */
  private provider(): any | null {
    const s = this.stripe();
    if (s) return s;
    if (this.mockAllowed()) return null;
    this.logger.error('Payment attempted but STRIPE_SECRET_KEY is not configured - refusing (mock payments are disabled in production)');
    throw new ServiceUnavailableException('Payments are temporarily unavailable');
  }

  private mockId(prefix: string) {
    return `${prefix}_mock_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  }
  private isMock(id?: string | null) {
    return !id || id.includes('_mock_');
  }
  private cents(n: number) {
    return Math.round((n + Number.EPSILON) * 100);
  }

  private async record(order: Order, kind: Payment['kind'], amount: number, provider: string, externalId: string | null, status: Payment['status'] = 'SUCCEEDED', meta?: any) {
    await this.payments.insert({ orderId: order.id, provider, kind, amount, status, externalId, ...(meta ? { meta } : {}) } as any);
  }

  async authorize(order: Order, opts: { paymentToken?: string; amount: number; customerEmail?: string | null }): Promise<{ ok: boolean; intentId?: string; clientSecret?: string; error?: string }> {
    const stripe = this.provider();
    if (!stripe) {
      const intentId = this.mockId('pi');
      await this.record(order, 'AUTHORIZE', opts.amount, 'mock', intentId);
      return { ok: true, intentId, clientSecret: `${intentId}_secret` };
    }
    if (!opts.paymentToken || typeof opts.paymentToken !== 'string' || !/^pm_[A-Za-z0-9_]+$/.test(opts.paymentToken)) return { ok: false, error: 'A valid payment method is required' };
    if (!(opts.amount > 0) || opts.amount > 5000) return { ok: false, error: 'Invalid payment amount' };
    try {
      const prof = await this.profiles.findOne({ where: { userId: order.customerId } });
      const pm = await stripe.paymentMethods.retrieve(opts.paymentToken);
      // a saved card may only be used by the customer it belongs to
      if (pm.customer && pm.customer !== prof?.stripeCustomerId) return { ok: false, error: 'Payment method not available' };
      const intent = await stripe.paymentIntents.create(
        {
          amount: this.cents(opts.amount),
          currency: 'cad',
          capture_method: 'manual',
          confirm: true,
          payment_method: opts.paymentToken,
          ...(pm.customer ? { customer: pm.customer } : {}),
          automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
          receipt_email: opts.customerEmail ?? undefined,
          metadata: { orderId: order.id, orderCode: order.code, customerId: order.customerId },
        },
        { idempotencyKey: `order-${order.id}-authorize` },
      );
      if (intent.status !== 'requires_capture') {
        await stripe.paymentIntents.cancel(intent.id).catch(() => undefined);
        await this.record(order, 'AUTHORIZE', opts.amount, 'stripe', intent.id, 'FAILED', { status: intent.status });
        return { ok: false, error: 'Your card could not be authorised. Please use another payment method.' };
      }
      await this.record(order, 'AUTHORIZE', opts.amount, 'stripe', intent.id);
      return { ok: true, intentId: intent.id, clientSecret: intent.client_secret ?? undefined };
    } catch (e: any) {
      this.logger.warn(`authorize failed for order ${order.code}: ${e?.code ?? e?.message}`);
      return { ok: false, error: e?.type === 'StripeCardError' ? 'Your card was declined.' : 'Payment could not be processed. Please try again.' };
    }
  }

  async capture(order: Order, amount?: number): Promise<void> {
    const amt = amount ?? Number(order.total);
    const stripe = this.provider();
    if (!stripe || this.isMock(order.paymentIntentId)) {
      if (!this.mockAllowed()) throw new ServiceUnavailableException('Payments are temporarily unavailable');
      return this.record(order, 'CAPTURE', amt, 'mock', order.paymentIntentId ? `${order.paymentIntentId}_cap` : this.mockId('ch'));
    }
    const intent = await stripe.paymentIntents.capture(order.paymentIntentId!, { amount_to_capture: this.cents(amt) }, { idempotencyKey: `order-${order.id}-capture-${this.cents(amt)}` });
    await this.record(order, 'CAPTURE', amt, 'stripe', intent.latest_charge ?? intent.id);
  }

  async release(order: Order): Promise<void> {
    const stripe = this.provider();
    if (!stripe || this.isMock(order.paymentIntentId)) {
      if (!this.mockAllowed()) throw new ServiceUnavailableException('Payments are temporarily unavailable');
      return this.record(order, 'RELEASE', Number(order.total), 'mock', order.paymentIntentId ? `${order.paymentIntentId}_void` : this.mockId('void'));
    }
    await stripe.paymentIntents.cancel(order.paymentIntentId!).catch((e: any) => {
      if (e?.code !== 'payment_intent_unexpected_state') throw e; // already captured / cancelled
    });
    await this.record(order, 'RELEASE', Number(order.total), 'stripe', order.paymentIntentId!);
  }

  async refund(order: Order, amount: number, reason?: string): Promise<{ externalId?: string }> {
    const stripe = this.provider();
    if (!stripe || this.isMock(order.paymentIntentId)) {
      if (!this.mockAllowed()) throw new ServiceUnavailableException('Payments are temporarily unavailable');
      const externalId = this.mockId('re');
      await this.record(order, 'REFUND', amount, 'mock', externalId, 'SUCCEEDED', reason ? { reason } : null);
      return { externalId };
    }
    const r = await stripe.refunds.create({ payment_intent: order.paymentIntentId!, amount: this.cents(amount), metadata: { orderId: order.id, reason: (reason ?? '').slice(0, 200) } }, { idempotencyKey: `refund-${order.id}-${randomUUID()}` });
    await this.record(order, 'REFUND', amount, 'stripe', r.id, 'SUCCEEDED', reason ? { reason } : null);
    return { externalId: r.id };
  }

  async adjustTip(order: Order, newTip: number): Promise<void> {
    const delta = round2(newTip - Number(order.tip));
    if (delta === 0) return;
    const stripe = this.provider();
    if (!stripe || this.isMock(order.paymentIntentId)) {
      if (!this.mockAllowed()) throw new ServiceUnavailableException('Payments are temporarily unavailable');
      return this.record(order, 'TIP_ADJUST', delta, 'mock', this.mockId('tip'));
    }
    const intent = await stripe.paymentIntents.retrieve(order.paymentIntentId!);
    if (intent.status === 'requires_capture') {
      await stripe.paymentIntents.update(intent.id, { amount: this.cents(Number(order.total) + delta) });
      return this.record(order, 'TIP_ADJUST', delta, 'stripe', intent.id);
    }
    if (delta > 0) {
      // already captured: charge the extra tip off-session on the same card; if the bank refuses, the tip change is refused
      const extra = await stripe.paymentIntents.create(
        { amount: this.cents(delta), currency: 'cad', confirm: true, off_session: true, payment_method: intent.payment_method, customer: intent.customer ?? undefined, metadata: { orderId: order.id, kind: 'tip' } },
        { idempotencyKey: `order-${order.id}-tip-${this.cents(newTip)}` },
      );
      if (extra.status !== 'succeeded') throw new ServiceUnavailableException('The extra tip could not be charged to your card');
      return this.record(order, 'TIP_ADJUST', delta, 'stripe', extra.id);
    }
    const r = await stripe.refunds.create({ payment_intent: intent.id, amount: this.cents(-delta), metadata: { orderId: order.id, kind: 'tip' } });
    await this.record(order, 'TIP_ADJUST', delta, 'stripe', r.id);
  }

  private async stripeCustomer(stripe: any, customerId: string): Promise<string> {
    const prof = await this.profiles.findOne({ where: { userId: customerId } });
    if (prof?.stripeCustomerId) return prof.stripeCustomerId;
    const c = await stripe.customers.create({ metadata: { forksyUserId: customerId } });
    if (prof) await this.profiles.update({ userId: customerId }, { stripeCustomerId: c.id });
    return c.id;
  }

  async createSetupIntent(customerId: string): Promise<{ clientSecret: string; customerId?: string }> {
    const stripe = this.provider();
    if (!stripe) return { clientSecret: this.mockId('seti') + '_secret', customerId: this.mockId('cus') };
    const cus = await this.stripeCustomer(stripe, customerId);
    const si = await stripe.setupIntents.create({ customer: cus, usage: 'off_session', automatic_payment_methods: { enabled: true, allow_redirects: 'never' } });
    return { clientSecret: si.client_secret, customerId: cus };
  }

  async listPaymentMethods(customerId: string): Promise<{ id: string; brand: string; last4: string; expMonth: number; expYear: number; isDefault?: boolean }[]> {
    const stripe = this.provider();
    if (!stripe) return [];
    const prof = await this.profiles.findOne({ where: { userId: customerId } });
    if (!prof?.stripeCustomerId) return [];
    const list = await stripe.paymentMethods.list({ customer: prof.stripeCustomerId, type: 'card', limit: 20 });
    return list.data.map((p: any) => ({ id: p.id, brand: p.card.brand, last4: p.card.last4, expMonth: p.card.exp_month, expYear: p.card.exp_year }));
  }

  async detachPaymentMethod(customerId: string, paymentMethodId: string): Promise<void> {
    const stripe = this.provider();
    if (!stripe) return; // mock: nothing persisted server-side to detach
    const prof = await this.profiles.findOne({ where: { userId: customerId } });
    const pm = await stripe.paymentMethods.retrieve(paymentMethodId).catch(() => null);
    // ownership check: only detach a card that belongs to THIS customer's Stripe customer
    if (!pm || !prof?.stripeCustomerId || pm.customer !== prof.stripeCustomerId) return;
    await stripe.paymentMethods.detach(paymentMethodId);
  }
}

function round2(n: number) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
