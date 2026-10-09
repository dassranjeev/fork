import { BadRequestException, ConflictException, HttpException, HttpStatus, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { CustomerProfile, Order, Payment, StripeIntent, User } from '../database/entities';
import { PaymentMethod } from '../common/enums';
import { IPaymentsService, Quote } from '../common/contracts';
import { StripeClientService, toCents } from '../integrations/stripe-client.service';
import { WalletService } from './wallet.service';

/** HttpException carrying a machine readable code (the exception filter returns `code`, so the page can react to it). */
export const payError = (status: number, code: string, message: string) => new HttpException({ statusCode: status, message, code }, status);

export const MIN_CARD_AMOUNT = 0.5; // Stripe's minimum charge in CAD

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const isMockId = (id?: string | null) => !!id && id.includes('_mock_');
const mockId = (prefix: string) => `${prefix}_mock_${randomUUID().replace(/-/g, '').slice(0, 20)}`;

export interface IntentOptions {
  /** the customer ticked "save this card for next time" */
  saveCard?: boolean;
  /** pay with a saved card (pm_...): the intent is created with it attached, the browser only handles 3-D Secure */
  paymentMethodId?: string;
  /** keep using / updating this unconfirmed intent instead of creating another one (the quote changed) */
  existingIntentId?: string;
}

export interface Hold {
  intentId: string;
  provider: 'stripe' | 'mock';
  method: PaymentMethod;
  amount: number;
}

/**
 * Card payments, always through Stripe (PCI SAQ-A: card data never touches our servers - the browser talks to Stripe.js).
 *
 *  Checkout:  POST /customer/payments/intent  -> server prices the cart again and creates a manual-capture PaymentIntent
 *             (amount is ALWAYS computed here) -> the page confirms it with the Payment Element -> POST /customer/orders with
 *             paymentIntentId -> verifyHold() retrieves the intent from Stripe and checks owner / status / amount / currency / quote.
 *  Order:     capture on delivery, cancel (release) on cancel / reject, refunds against the intent, tip adjustments.
 *
 *  The mock provider (no Stripe key AND NODE_ENV != production AND ALLOW_MOCK_PAYMENTS=true) exists for automated tests and a developer
 *  machine only. With a Stripe key present it is never used. Order rows whose intent id contains "_mock_" are old demo data: they are
 *  settled without calling Stripe (never in production).
 */
@Injectable()
export class PaymentsService implements IPaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    @InjectRepository(Payment) private payments: Repository<Payment>,
    @InjectRepository(CustomerProfile) private profiles: Repository<CustomerProfile>,
    @InjectRepository(StripeIntent) private intents: Repository<StripeIntent>,
    @InjectRepository(Order) private orders: Repository<Order>,
    @InjectDataSource() private ds: DataSource,
    private stripeClient: StripeClientService,
    private wallet: WalletService,
  ) {
    if (this.stripeClient.mockAllowed()) this.logger.warn('MOCK payments are ACTIVE (no Stripe key + ALLOW_MOCK_PAYMENTS=true): no real money moves. Add the Stripe keys under System > Integrations.');
  }

  /** stripe | mock | none */
  mode() {
    return this.stripeClient.provider();
  }

  /** Stripe client, or null in mock mode, or a 503 when payments are not configured at all. */
  private stripe(): any | null {
    const c = this.stripeClient.client();
    if (c) return c;
    if (this.stripeClient.mockAllowed()) return null;
    this.logger.error('Payment attempted but no Stripe key is configured - refusing (mock payments are not allowed here)');
    throw new ServiceUnavailableException('Payments are temporarily unavailable');
  }

  private async record(order: Pick<Order, 'id'>, kind: Payment['kind'] | 'DISPUTE' | 'DISPUTE_REVERSAL', amount: number, provider: string, externalId: string | null, status: Payment['status'] = 'SUCCEEDED', meta?: any) {
    await this.payments.insert({ orderId: order.id, provider, kind: kind as any, amount, status, externalId, ...(meta ? { meta } : {}) } as any);
  }

  /** What the card is charged for this order: total minus the wallet part, plus tip changes applied to the hold. */
  async cardDue(order: Order): Promise<number> {
    const base = round2(Number(order.total) - Number(order.walletUsed ?? 0));
    const rows = await this.payments.find({ where: { orderId: order.id, kind: 'TIP_ADJUST', status: 'SUCCEEDED' } });
    const holdAdj = rows.filter((r) => r.meta?.phase === 'hold').reduce((a, r) => a + Number(r.amount), 0);
    return round2(base + holdAdj);
  }

  // ------------------------------------------------------------------ Stripe customer
  /**
   * Run a Stripe call that needs the customer. If Stripe no longer knows the stored customer id (deleted in the dashboard, or the account
   * was switched between test and live keys) the stored id is dropped and the call is retried ONCE with a freshly created customer.
   */
  async retryMissingCustomer<T>(customerId: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e: any) {
      if (e?.code === 'resource_missing' && /customer/i.test(String(e?.param ?? e?.message ?? ''))) {
        this.logger.warn(`Stripe does not know the stored customer of ${customerId}: creating a new one`);
        await this.profiles.update({ userId: customerId }, { stripeCustomerId: null as any });
        this.freshCustomer.add(customerId);
        try {
          return await fn();
        } finally {
          this.freshCustomer.delete(customerId);
        }
      }
      throw e;
    }
  }
  private freshCustomer = new Set<string>();

  async stripeCustomer(stripe: any, customerId: string): Promise<string> {
    const prof = await this.profiles.findOne({ where: { userId: customerId } });
    if (prof?.stripeCustomerId && !isMockId(prof.stripeCustomerId)) return prof.stripeCustomerId;
    const user = await this.ds.getRepository(User).findOne({ where: { id: customerId } });
    const c = await stripe.customers.create(
      { email: user?.email ?? undefined, name: user ? `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || undefined : undefined, metadata: { forksyUserId: customerId } },
      { idempotencyKey: this.freshCustomer.has(customerId) ? `customer-${customerId}-${randomUUID()}` : `customer-${customerId}` },
    );
    if (prof) await this.profiles.update({ userId: customerId }, { stripeCustomerId: c.id });
    return c.id;
  }

  // ------------------------------------------------------------------ checkout: create / update the intent
  /**
   * The card part of a priced cart as a PaymentIntent (manual capture = authorise now, capture on delivery).
   * `quote` was computed by the server just now; nothing the browser sends can change the amount.
   */
  async createCheckoutIntent(customerId: string, quote: Quote, hash: string, opts: IntentOptions = {}) {
    return this.retryMissingCustomer(customerId, () => this.createCheckoutIntentInner(customerId, quote, hash, opts));
  }

  private async createCheckoutIntentInner(customerId: string, quote: Quote, hash: string, opts: IntentOptions = {}) {
    const cardAmount = round2(Number(quote.total) - Number(quote.walletUsed));
    const cfg = this.stripeClient.config();
    if (cardAmount <= 0.009) return { required: false, amount: 0, currency: cfg.currency, mock: this.mode() === 'mock', message: 'Your wallet credit covers this order: no card payment is needed.' };
    if (cardAmount < MIN_CARD_AMOUNT) throw new BadRequestException(`Card payments must be at least $${MIN_CARD_AMOUNT.toFixed(2)}. Use more wallet credit or add something to your order.`);
    if (cardAmount > 5000) throw new BadRequestException('Invalid payment amount');
    const stripe = this.stripe();

    if (!stripe) {
      // MOCK (development): remember the intent so ownership / amount / quote are still verified at order time
      let row = opts.existingIntentId ? await this.intents.findOne({ where: { intentId: opts.existingIntentId, customerId, purpose: 'ORDER' } }) : null;
      if (row && (row.orderId || !isMockId(row.intentId))) row = null;
      if (row) {
        row.amount = cardAmount;
        row.quoteHash = hash;
        await this.intents.save(row);
      } else {
        row = await this.intents.save(this.intents.create({ intentId: mockId('pi'), customerId, purpose: 'ORDER', amount: cardAmount, currency: 'cad', quoteHash: hash, status: 'requires_payment_method' }));
      }
      return { required: true, mock: true, intentId: row.intentId, clientSecret: `${row.intentId}_secret_mock`, amount: cardAmount, currency: 'cad', publishableKey: null, status: 'requires_payment_method', updated: !!opts.existingIntentId };
    }

    const customer = await this.stripeCustomer(stripe, customerId);
    let savedPm: string | undefined;
    if (opts.paymentMethodId) {
      const pm = await stripe.paymentMethods.retrieve(opts.paymentMethodId).catch(() => null);
      // a saved card may only be used by the customer it belongs to
      if (!pm || pm.customer !== customer) throw payError(HttpStatus.BAD_REQUEST, 'PAYMENT_METHOD_INVALID', 'That saved card is not available. Choose another card.');
      savedPm = pm.id;
    }
    const metadata = { customerId, quoteHash: hash, purpose: 'ORDER' };

    // the quote changed while the customer is still typing the card: update the SAME unconfirmed intent (the Payment Element stays mounted)
    if (opts.existingIntentId) {
      const row = await this.intents.findOne({ where: { intentId: opts.existingIntentId, customerId, purpose: 'ORDER' } });
      if (row && !row.orderId) {
        const pi = await stripe.paymentIntents.retrieve(row.intentId).catch(() => null);
        if (pi && pi.status === 'requires_payment_method' && !isMockId(pi.id)) {
          const upd = await stripe.paymentIntents.update(pi.id, {
            amount: toCents(cardAmount),
            metadata,
            payment_method: savedPm ?? undefined,
            setup_future_usage: opts.saveCard && !savedPm ? 'off_session' : '',
          });
          row.amount = cardAmount;
          row.quoteHash = hash;
          row.status = upd.status;
          await this.intents.save(row);
          return { required: true, mock: false, intentId: upd.id, clientSecret: upd.client_secret, amount: cardAmount, currency: 'cad', publishableKey: cfg.publishableKey || null, status: upd.status, updated: true };
        }
        // the customer already paid for the OLD cart and then changed it: release that hold now so they are not held twice
        if (pi && pi.status === 'requires_capture' && !isMockId(pi.id)) {
          await stripe.paymentIntents.cancel(pi.id).then(() => this.intents.update({ id: row.id }, { status: 'canceled', canceledAt: new Date() })).catch(() => undefined);
        }
      }
    }

    let pi = await stripe.paymentIntents.create(
      {
        amount: toCents(cardAmount),
        currency: 'cad',
        capture_method: 'manual',
        customer,
        // wallets and cards only: nothing that redirects the customer away from the page
        automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
        ...(savedPm ? { payment_method: savedPm } : {}),
        ...(opts.saveCard && !savedPm ? { setup_future_usage: 'off_session' } : {}),
        description: 'FORKSY order',
        metadata,
      },
      { idempotencyKey: `intent-${customer}-${hash}-${savedPm ?? ''}${opts.saveCard ? 's' : ''}-${Math.floor(Date.now() / 60_000)}` },
    );
    // an idempotent replay returns the ORIGINAL response (a stale status) for an intent that may have moved on (confirmed / cancelled): look again
    if (await this.intents.exist({ where: { intentId: pi.id } })) pi = await stripe.paymentIntents.retrieve(pi.id);
    if (pi.status !== 'requires_payment_method') {
      if (pi.status === 'requires_capture' || pi.status === 'requires_action' || pi.status === 'processing') {
        const known = await this.intents.findOne({ where: { intentId: pi.id } });
        if (known && !known.orderId) return { required: true, mock: false, intentId: pi.id, clientSecret: pi.client_secret, amount: cardAmount, currency: 'cad', publishableKey: cfg.publishableKey || null, status: pi.status, updated: false };
      }
      const fresh = await stripe.paymentIntents.create({
        amount: toCents(cardAmount), currency: 'cad', capture_method: 'manual', customer, automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
        ...(savedPm ? { payment_method: savedPm } : {}), ...(opts.saveCard && !savedPm ? { setup_future_usage: 'off_session' } : {}), description: 'FORKSY order', metadata,
      }, { idempotencyKey: `intent-${randomUUID()}` });
      return this.rememberIntent(customerId, fresh, cardAmount, hash, cfg.publishableKey);
    }
    return this.rememberIntent(customerId, pi, cardAmount, hash, cfg.publishableKey);
  }

  private async rememberIntent(customerId: string, pi: any, amount: number, hash: string, publishableKey: string) {
    const exists = await this.intents.findOne({ where: { intentId: pi.id } });
    if (!exists) await this.intents.save(this.intents.create({ intentId: pi.id, customerId, purpose: 'ORDER', amount, currency: 'cad', quoteHash: hash, status: pi.status }));
    return { required: true, mock: false, intentId: pi.id, clientSecret: pi.client_secret, amount, currency: 'cad', publishableKey: publishableKey || null, status: pi.status, updated: false };
  }

  // ------------------------------------------------------------------ checkout: verify the hold before the order exists
  /**
   * Called by OrdersService.placeOrder BEFORE any order row is written. Returns the hold to bind to the order or throws:
   *   400 PAYMENT_INTENT_REQUIRED / PAYMENT_INTENT_INVALID / PAYMENT_NOT_CONFIRMED
   *   409 PAYMENT_QUOTE_CHANGED (price drifted: re-create the intent), PAYMENT_ACTION_REQUIRED, PAYMENT_INTENT_USED, PAYMENT_INTENT_CANCELED, PAYMENT_PROCESSING
   */
  async verifyHold(customerId: string, o: { paymentIntentId?: string; paymentToken?: string; amount: number; quoteHash: string; declaredMethod: PaymentMethod }): Promise<Hold> {
    const stripe = this.stripe();
    const expectedCents = toCents(o.amount);
    const alreadyUsed = async (id: string) => !!(await this.orders.exist({ where: { paymentIntentId: id } }));

    if (!stripe) {
      // MOCK: an intent created by createCheckoutIntent, or (legacy automated tests) a bare mock token
      if (o.paymentIntentId) {
        const row = await this.intents.findOne({ where: { intentId: o.paymentIntentId } });
        if (!row || row.customerId !== customerId || row.purpose !== 'ORDER' || !isMockId(row.intentId)) throw payError(HttpStatus.BAD_REQUEST, 'PAYMENT_INTENT_INVALID', 'This payment was not found. Please go back to payment and try again.');
        if (row.orderId || (await alreadyUsed(row.intentId))) throw payError(HttpStatus.CONFLICT, 'PAYMENT_INTENT_USED', 'This payment was already used for another order.');
        if (toCents(Number(row.amount)) !== expectedCents || row.quoteHash !== o.quoteHash) throw payError(HttpStatus.CONFLICT, 'PAYMENT_QUOTE_CHANGED', 'Your total changed. Please review it and pay again.');
        return { intentId: row.intentId, provider: 'mock', method: o.declaredMethod, amount: o.amount };
      }
      if (!o.paymentToken) throw payError(HttpStatus.BAD_REQUEST, 'PAYMENT_INTENT_REQUIRED', 'Complete the card payment before placing the order.');
      const row = await this.intents.save(this.intents.create({ intentId: mockId('pi'), customerId, purpose: 'ORDER', amount: o.amount, currency: 'cad', quoteHash: o.quoteHash, status: 'requires_capture' }));
      return { intentId: row.intentId, provider: 'mock', method: o.declaredMethod, amount: o.amount };
    }

    if (!o.paymentIntentId || typeof o.paymentIntentId !== 'string' || !/^pi_[A-Za-z0-9_]+$/.test(o.paymentIntentId)) {
      throw payError(HttpStatus.BAD_REQUEST, 'PAYMENT_INTENT_REQUIRED', 'Complete the card payment before placing the order.');
    }
    const row = await this.intents.findOne({ where: { intentId: o.paymentIntentId } });
    // "not yours" and "does not exist" give the same answer
    if (!row || row.customerId !== customerId || row.purpose !== 'ORDER') throw payError(HttpStatus.BAD_REQUEST, 'PAYMENT_INTENT_INVALID', 'This payment was not found. Please go back to payment and try again.');
    let pi: any;
    try {
      pi = await stripe.paymentIntents.retrieve(row.intentId, { expand: ['latest_charge'] });
    } catch (e: any) {
      this.logger.warn(`verifyHold: Stripe retrieve failed: ${e?.code ?? e?.message}`);
      throw new ServiceUnavailableException('Payments are temporarily unavailable. Please try again in a moment.');
    }
    if (pi.metadata?.customerId !== customerId) throw payError(HttpStatus.BAD_REQUEST, 'PAYMENT_INTENT_INVALID', 'This payment was not found. Please go back to payment and try again.');
    if (row.orderId || (await alreadyUsed(pi.id))) throw payError(HttpStatus.CONFLICT, 'PAYMENT_INTENT_USED', 'This payment was already used for another order.');
    switch (pi.status) {
      case 'requires_capture':
        break;
      case 'requires_action':
      case 'requires_confirmation':
        throw payError(HttpStatus.CONFLICT, 'PAYMENT_ACTION_REQUIRED', 'Your bank needs you to confirm this payment. Please complete the verification and try again.');
      case 'processing':
        throw payError(HttpStatus.CONFLICT, 'PAYMENT_PROCESSING', 'Your payment is still processing. Please wait a moment and try again.');
      case 'canceled':
        throw payError(HttpStatus.CONFLICT, 'PAYMENT_INTENT_CANCELED', 'This payment was cancelled. Please enter your card again.');
      case 'succeeded':
        throw payError(HttpStatus.CONFLICT, 'PAYMENT_INTENT_USED', 'This payment was already used for another order.');
      default:
        throw payError(HttpStatus.BAD_REQUEST, 'PAYMENT_NOT_CONFIRMED', 'Your payment was not completed. Please enter your card details and try again.');
    }
    if (String(pi.currency).toLowerCase() !== 'cad') throw payError(HttpStatus.BAD_REQUEST, 'PAYMENT_INTENT_INVALID', 'Invalid payment currency.');
    // the amount is compared with the price the SERVER just recomputed: a tampered or outdated intent can never place an order
    if (pi.amount !== expectedCents || pi.amount_capturable !== pi.amount || pi.metadata?.quoteHash !== o.quoteHash || row.quoteHash !== o.quoteHash) {
      // the customer's money is on hold for the OLD price: release it now so the page can start again without a double hold
      await stripe.paymentIntents.cancel(pi.id).then(() => this.intents.update({ id: row.id }, { status: 'canceled', canceledAt: new Date() })).catch(() => undefined);
      throw payError(HttpStatus.CONFLICT, 'PAYMENT_QUOTE_CHANGED', 'Your total changed since you entered your card. Please review it and pay again.');
    }
    const wallet = pi.latest_charge?.payment_method_details?.card?.wallet?.type;
    const method = wallet === 'apple_pay' ? PaymentMethod.APPLE_PAY : wallet === 'google_pay' ? PaymentMethod.GOOGLE_PAY : PaymentMethod.CARD;
    return { intentId: pi.id, provider: 'stripe', method, amount: o.amount };
  }

  /** The order row exists (its unique paymentIntentId already claims the intent): link both sides and write the AUTHORIZE record. */
  async bindHold(order: Order, hold: Hold): Promise<void> {
    await this.intents.update({ intentId: hold.intentId }, { orderId: order.id, status: hold.provider === 'mock' ? 'requires_capture' : 'requires_capture' });
    await this.record(order, 'AUTHORIZE', hold.amount, hold.provider, hold.intentId);
    if (hold.provider === 'stripe') {
      const stripe = this.stripeClient.client();
      await stripe?.paymentIntents
        .update(hold.intentId, { metadata: { orderId: order.id, orderCode: order.code }, description: `FORKSY order ${order.code}`, transfer_group: `order_${order.code}` })
        .catch((e: any) => this.logger.warn(`could not tag intent ${hold.intentId} with order ${order.code}: ${e?.code ?? e?.message}`));
    }
  }

  /** The hold was verified but the order could not be created: free the customer's money again. Best effort, never throws. */
  async releaseUnusedHold(hold: Hold, opts: { keepIfUsed?: boolean } = {}): Promise<void> {
    // keepIfUsed: the order insert lost a race for this intent - another order owns the hold, so do not cancel it
    if (opts.keepIfUsed) return;
    await this.intents.update({ intentId: hold.intentId }, { orderId: null }).catch(() => undefined);
    if (hold.provider === 'mock') return;
    try {
      await this.stripeClient.client()?.paymentIntents.cancel(hold.intentId);
      await this.intents.update({ intentId: hold.intentId }, { status: 'canceled', canceledAt: new Date() });
    } catch (e: any) {
      this.logger.warn(`could not release hold ${hold.intentId}: ${e?.code ?? e?.message}`);
    }
  }

  /** Cancel a customer's unused ORDER intent (hold clean-up cron). Returns true when it was cancelled. */
  async cancelAbandoned(row: StripeIntent): Promise<boolean> {
    const stripe = this.stripeClient.client();
    if (!stripe || isMockId(row.intentId)) {
      await this.intents.update({ id: row.id }, { status: 'canceled', canceledAt: new Date() });
      return true;
    }
    try {
      const pi = await stripe.paymentIntents.retrieve(row.intentId);
      if (['requires_payment_method', 'requires_confirmation', 'requires_action', 'requires_capture', 'processing'].includes(pi.status)) {
        await stripe.paymentIntents.cancel(row.intentId, { cancellation_reason: 'abandoned' });
        await this.intents.update({ id: row.id }, { status: 'canceled', canceledAt: new Date() });
        return true;
      }
      await this.intents.update({ id: row.id }, { status: pi.status });
      return false;
    } catch (e: any) {
      if (e?.code === 'payment_intent_unexpected_state') return false;
      throw e;
    }
  }

  // ------------------------------------------------------------------ order lifecycle
  async capture(order: Order, amount?: number): Promise<void> {
    const intentId = order.paymentIntentId;
    const due = amount ?? (await this.cardDue(order));
    if (!intentId) {
      // nothing was charged to a card (wallet covered everything) - there is no gateway payment to capture
      if (this.stripeClient.provider() === 'mock') return this.record(order, 'CAPTURE', due, 'mock', mockId('ch'));
      return;
    }
    if (isMockId(intentId)) {
      if (process.env.NODE_ENV === 'production') throw new ServiceUnavailableException('Payments are temporarily unavailable');
      return this.record(order, 'CAPTURE', due, 'mock', `${intentId}_cap`);
    }
    const stripe = this.stripe();
    if (!stripe) throw new ServiceUnavailableException('Payments are temporarily unavailable');
    if (due <= 0.009) return this.release(order);
    let intent: any;
    try {
      intent = await stripe.paymentIntents.capture(intentId, { amount_to_capture: toCents(due) }, { idempotencyKey: `order-${order.id}-capture-${toCents(due)}` });
    } catch (e: any) {
      if (e?.code === 'payment_intent_unexpected_state') {
        const cur = await stripe.paymentIntents.retrieve(intentId);
        if (cur.status === 'succeeded') intent = cur; // captured already (retry after a crash): fine
        else throw e;
      } else throw e;
    }
    const charge = typeof intent.latest_charge === 'string' ? intent.latest_charge : intent.latest_charge?.id;
    const dup = charge ? await this.payments.exist({ where: { orderId: order.id, kind: 'CAPTURE', externalId: charge } }) : false;
    if (!dup) await this.record(order, 'CAPTURE', due, 'stripe', charge ?? intent.id, 'SUCCEEDED', { intentId });
    await this.intents.update({ intentId }, { status: 'succeeded' });
  }

  async release(order: Order): Promise<void> {
    const intentId = order.paymentIntentId;
    if (!intentId) {
      if (this.stripeClient.provider() === 'mock') return this.record(order, 'RELEASE', Number(order.total), 'mock', mockId('void'));
      return;
    }
    if (isMockId(intentId)) {
      if (process.env.NODE_ENV === 'production') throw new ServiceUnavailableException('Payments are temporarily unavailable');
      return this.record(order, 'RELEASE', Number(order.total), 'mock', `${intentId}_void`);
    }
    const stripe = this.stripe();
    if (!stripe) throw new ServiceUnavailableException('Payments are temporarily unavailable');
    await stripe.paymentIntents.cancel(intentId, { cancellation_reason: 'requested_by_customer' }).catch((e: any) => {
      if (e?.code !== 'payment_intent_unexpected_state') throw e; // already captured / cancelled
    });
    await this.record(order, 'RELEASE', await this.cardDue(order), 'stripe', intentId);
    await this.intents.update({ intentId }, { status: 'canceled', canceledAt: new Date() });
  }

  /**
   * Money back to the customer's card. `refundId` (the FORKSY refund row) makes the Stripe call idempotent: replaying the same
   * refund can never pay twice. Whatever the card cannot take (no card payment, hold not captured yet, more than was charged to the
   * card because part of the order was paid with wallet credit) is returned as `walletCredit` for the caller to credit.
   */
  async refund(order: Order, amount: number, reason?: string, refundId?: string): Promise<{ externalId?: string; cardAmount: number; walletCredit: number }> {
    const intentId = order.paymentIntentId;
    if (isMockId(intentId) || (!intentId && this.stripeClient.provider() === 'mock')) {
      if (process.env.NODE_ENV === 'production') throw new ServiceUnavailableException('Payments are temporarily unavailable');
      const externalId = mockId('re');
      await this.record(order, 'REFUND', amount, 'mock', externalId, 'SUCCEEDED', reason ? { reason } : null);
      return { externalId, cardAmount: amount, walletCredit: 0 };
    }
    if (!intentId) return { cardAmount: 0, walletCredit: round2(amount) };
    const stripe = this.stripe();
    if (!stripe) throw new ServiceUnavailableException('Payments are temporarily unavailable');
    const rows = await this.payments.find({ where: { orderId: order.id, status: 'SUCCEEDED' } });
    const captured = rows.filter((r) => r.kind === 'CAPTURE' || (r.kind === 'TIP_ADJUST' && r.meta?.phase === 'post' && Number(r.amount) > 0)).reduce((a, r) => a + Number(r.amount), 0);
    const refunded = rows.filter((r) => r.kind === 'REFUND' || (r.kind === 'TIP_ADJUST' && r.meta?.phase === 'post' && Number(r.amount) < 0)).reduce((a, r) => a + Math.abs(Number(r.amount)), 0);
    const room = Math.max(0, round2(captured - refunded));
    const toCard = Math.min(round2(amount), room);
    const walletCredit = round2(amount - toCard);
    if (toCard < 0.01) return { cardAmount: 0, walletCredit };
    const r = await stripe.refunds.create(
      { payment_intent: intentId, amount: toCents(toCard), metadata: { orderId: order.id, refundId: refundId ?? '', reason: (reason ?? '').slice(0, 200) } },
      { idempotencyKey: `refund-${refundId ?? `${order.id}-${toCents(toCard)}-${randomUUID()}`}` },
    );
    await this.record(order, 'REFUND', toCard, 'stripe', r.id, 'SUCCEEDED', { intentId, ...(reason ? { reason } : {}) });
    return { externalId: r.id, cardAmount: toCard, walletCredit };
  }

  /** Tip changed after the order was placed. Returns nothing; throws a 400/409 with a clear message when the card cannot take it. */
  async adjustTip(order: Order, newTip: number): Promise<void> {
    const delta = round2(newTip - Number(order.tip));
    if (delta === 0) return;
    const intentId = order.paymentIntentId;
    if (isMockId(intentId) || (!intentId && this.stripeClient.provider() === 'mock')) {
      if (process.env.NODE_ENV === 'production') throw new ServiceUnavailableException('Payments are temporarily unavailable');
      return this.record(order, 'TIP_ADJUST', delta, 'mock', mockId('tip'), 'SUCCEEDED', { phase: 'hold' });
    }
    if (!intentId) {
      // the whole order was paid with FORKSY wallet credit: the tip moves in the wallet
      if (delta > 0) await this.wallet.debit(order.customerId, delta, 'PURCHASE', { orderId: order.id, note: `Extra tip on ${order.code}` });
      else await this.wallet.credit(order.customerId, -delta, 'ADJUSTMENT', { orderId: order.id, note: `Tip reduced on ${order.code}` });
      return this.record(order, 'WALLET', delta, 'wallet', null, 'SUCCEEDED', { phase: 'wallet-tip' });
    }
    const stripe = this.stripe();
    if (!stripe) throw new ServiceUnavailableException('Payments are temporarily unavailable');
    const intent = await stripe.paymentIntents.retrieve(intentId);
    if (intent.status === 'requires_capture') {
      if (delta < 0) {
        // a smaller tip simply means a smaller capture
        return this.record(order, 'TIP_ADJUST', delta, 'stripe', intent.id, 'SUCCEEDED', { phase: 'hold' });
      }
      try {
        // the hold may already cover the new amount (an earlier, lower tip freed some room): only raise it when it does not
        const newDue = round2((await this.cardDue(order)) + delta);
        if (toCents(newDue) > intent.amount_capturable) {
          await stripe.paymentIntents.incrementAuthorization(intent.id, { amount: toCents(newDue) }, { idempotencyKey: `order-${order.id}-tipinc-${toCents(newTip)}` });
        }
        return this.record(order, 'TIP_ADJUST', delta, 'stripe', intent.id, 'SUCCEEDED', { phase: 'hold' });
      } catch (e: any) {
        this.logger.debug(`incrementAuthorization not possible for ${intent.id}: ${e?.code ?? e?.message} - charging the extra tip separately`);
      }
    }
    if (delta > 0) {
      // charge the extra tip as its own payment on the same card (saved cards only); if the bank refuses, the tip change is refused
      const pmId = typeof intent.payment_method === 'string' ? intent.payment_method : intent.payment_method?.id;
      const pm = pmId ? await stripe.paymentMethods.retrieve(pmId).catch(() => null) : null;
      if (!pm || !pm.customer) throw payError(HttpStatus.CONFLICT, 'TIP_CARD_NOT_SAVED', 'This card cannot be charged again for a bigger tip. You can lower the tip, or tip with a saved card next time.');
      let extra: any;
      try {
        extra = await stripe.paymentIntents.create(
          { amount: toCents(delta), currency: 'cad', confirm: true, off_session: true, payment_method: pm.id, customer: pm.customer, description: `FORKSY tip ${order.code}`, metadata: { orderId: order.id, orderCode: order.code, kind: 'tip', customerId: order.customerId } },
          { idempotencyKey: `order-${order.id}-tip-${toCents(newTip)}` },
        );
      } catch (e: any) {
        throw payError(HttpStatus.CONFLICT, 'TIP_CHARGE_FAILED', e?.type === 'StripeCardError' ? 'Your card was declined for the extra tip.' : 'The extra tip could not be charged to your card.');
      }
      if (extra.status !== 'succeeded') throw payError(HttpStatus.CONFLICT, 'TIP_CHARGE_FAILED', 'The extra tip could not be charged to your card');
      return this.record(order, 'TIP_ADJUST', delta, 'stripe', extra.id, 'SUCCEEDED', { phase: 'post', extraIntent: extra.id });
    }
    // already captured and the tip goes down: give the difference back
    const r = await stripe.refunds.create({ payment_intent: intent.id, amount: toCents(-delta), metadata: { orderId: order.id, kind: 'tip' } }, { idempotencyKey: `order-${order.id}-tipref-${toCents(newTip)}` });
    await this.record(order, 'TIP_ADJUST', delta, 'stripe', r.id, 'SUCCEEDED', { phase: 'post' });
  }

  // ------------------------------------------------------------------ saved cards (SetupIntent + Payment Element)
  async createSetupIntent(customerId: string): Promise<{ clientSecret: string; customerId?: string; publishableKey?: string | null; mock?: boolean }> {
    const stripe = this.stripe();
    if (!stripe) return { clientSecret: `${mockId('seti')}_secret_mock`, customerId: mockId('cus'), publishableKey: null, mock: true };
    return this.retryMissingCustomer(customerId, async () => {
      const cus = await this.stripeCustomer(stripe, customerId);
      const si = await stripe.setupIntents.create({ customer: cus, usage: 'off_session', automatic_payment_methods: { enabled: true, allow_redirects: 'never' }, metadata: { customerId } });
      return { clientSecret: si.client_secret, customerId: cus, publishableKey: this.stripeClient.config().publishableKey || null, mock: false };
    });
  }

  async listPaymentMethods(customerId: string): Promise<{ id: string; brand: string; last4: string; expMonth: number; expYear: number; isDefault?: boolean; wallet?: string | null }[]> {
    const stripe = this.stripeClient.client();
    if (!stripe) return [];
    const prof = await this.profiles.findOne({ where: { userId: customerId } });
    if (!prof?.stripeCustomerId || isMockId(prof.stripeCustomerId)) return [];
    const [list, cus] = await Promise.all([
      stripe.paymentMethods.list({ customer: prof.stripeCustomerId, type: 'card', limit: 20 }),
      stripe.customers.retrieve(prof.stripeCustomerId).catch(() => null),
    ]);
    const def = cus && !cus.deleted ? cus.invoice_settings?.default_payment_method : null;
    const defId = typeof def === 'string' ? def : def?.id;
    return list.data.map((p: any) => ({ id: p.id, brand: p.card.brand, last4: p.card.last4, expMonth: p.card.exp_month, expYear: p.card.exp_year, isDefault: p.id === defId, wallet: p.card.wallet?.type ?? null }));
  }

  async setDefaultPaymentMethod(customerId: string, paymentMethodId: string): Promise<void> {
    const stripe = this.stripe();
    if (!stripe) return;
    const prof = await this.profiles.findOne({ where: { userId: customerId } });
    const pm = await stripe.paymentMethods.retrieve(paymentMethodId).catch(() => null);
    if (!pm || !prof?.stripeCustomerId || pm.customer !== prof.stripeCustomerId) throw new BadRequestException('Card not found');
    await stripe.customers.update(prof.stripeCustomerId, { invoice_settings: { default_payment_method: pm.id } });
  }

  async detachPaymentMethod(customerId: string, paymentMethodId: string): Promise<void> {
    const stripe = this.stripe();
    if (!stripe) return; // mock: nothing persisted server-side to detach
    const prof = await this.profiles.findOne({ where: { userId: customerId } });
    const pm = await stripe.paymentMethods.retrieve(paymentMethodId).catch(() => null);
    // ownership check: only detach a card that belongs to THIS customer's Stripe customer
    if (!pm || !prof?.stripeCustomerId || pm.customer !== prof.stripeCustomerId) throw new BadRequestException('Card not found');
    await stripe.paymentMethods.detach(paymentMethodId);
  }

  /** Make sure a card the customer just saved (SetupIntent / setup_future_usage) is the default when they have none. */
  async ensureDefaultPaymentMethod(stripeCustomerId: string, paymentMethodId: string | null | undefined): Promise<void> {
    const stripe = this.stripeClient.client();
    if (!stripe || !paymentMethodId) return;
    const cus = await stripe.customers.retrieve(stripeCustomerId).catch(() => null);
    if (!cus || cus.deleted || cus.invoice_settings?.default_payment_method) return;
    await stripe.customers.update(stripeCustomerId, { invoice_settings: { default_payment_method: paymentMethodId } });
  }
}
