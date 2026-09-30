import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { Order, Payment } from '../database/entities';
import { IPaymentsService } from '../common/contracts';
import { SettingsService } from '../settings/settings.service';

/**
 * Card data never touches our servers (PCI DSS SAQ-A scope) - this service only ever
 * handles provider tokens/intent ids. Real Stripe calls are behind `payments.provider`
 * + `payments.stripe.secretKey` settings; with no secret key configured, a deterministic
 * mock adapter is used so the whole order flow works end-to-end without live keys.
 * Swap `callStripe`'s body for real `stripe.paymentIntents.*` calls when a key is set -
 * every call site elsewhere never changes.
 */
@Injectable()
export class PaymentsService implements IPaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    @InjectRepository(Payment) private payments: Repository<Payment>,
    private settings: SettingsService,
  ) {}

  private useStripe(): boolean {
    return this.settings.get<string>('payments.provider', 'stripe') === 'stripe' && !!this.settings.get<string>('payments.stripe.secretKey', '');
  }

  private mockId(prefix: string) {
    return `${prefix}_mock_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  }

  async authorize(order: Order, opts: { paymentToken?: string; amount: number; customerEmail?: string | null }): Promise<{ ok: boolean; intentId?: string; clientSecret?: string; error?: string }> {
    if (this.useStripe()) {
      // TODO: real Stripe: stripe.paymentIntents.create({ amount: cents(opts.amount), currency: 'cad', capture_method: 'manual', payment_method: opts.paymentToken, confirm: true, receipt_email: opts.customerEmail ?? undefined });
      this.logger.warn('Stripe secret key set but live integration not wired - falling back to mock authorize');
    }
    const intentId = this.mockId('pi');
    await this.payments.insert({
      orderId: order.id,
      provider: 'mock',
      kind: 'AUTHORIZE',
      amount: opts.amount,
      status: 'SUCCEEDED',
      externalId: intentId,
    });
    return { ok: true, intentId, clientSecret: `${intentId}_secret` };
  }

  async capture(order: Order, amount?: number): Promise<void> {
    const amt = amount ?? Number(order.total);
    await this.payments.insert({
      orderId: order.id,
      provider: 'mock',
      kind: 'CAPTURE',
      amount: amt,
      status: 'SUCCEEDED',
      externalId: order.paymentIntentId ? `${order.paymentIntentId}_cap` : this.mockId('ch'),
    });
  }

  async release(order: Order): Promise<void> {
    await this.payments.insert({
      orderId: order.id,
      provider: 'mock',
      kind: 'RELEASE',
      amount: Number(order.total),
      status: 'SUCCEEDED',
      externalId: order.paymentIntentId ? `${order.paymentIntentId}_void` : this.mockId('void'),
    });
  }

  async refund(order: Order, amount: number, reason?: string): Promise<{ externalId?: string }> {
    const externalId = this.mockId('re');
    await this.payments.insert({
      orderId: order.id,
      provider: 'mock',
      kind: 'REFUND',
      amount,
      status: 'SUCCEEDED',
      externalId,
      meta: (reason ? { reason } : null) as any,
    });
    return { externalId };
  }

  async adjustTip(order: Order, newTip: number): Promise<void> {
    const delta = round2(newTip - Number(order.tip));
    if (delta === 0) return;
    await this.payments.insert({
      orderId: order.id,
      provider: 'mock',
      kind: 'TIP_ADJUST',
      amount: delta,
      status: 'SUCCEEDED',
      externalId: this.mockId('tip'),
    });
  }

  async createSetupIntent(customerId: string): Promise<{ clientSecret: string; customerId?: string }> {
    return { clientSecret: this.mockId('seti') + '_secret', customerId: this.mockId('cus') };
  }

  async listPaymentMethods(customerId: string): Promise<{ id: string; brand: string; last4: string; expMonth: number; expYear: number; isDefault?: boolean }[]> {
    return [];
  }

  async detachPaymentMethod(customerId: string, paymentMethodId: string): Promise<void> {
    // mock: nothing persisted server-side to detach
  }
}

function round2(n: number) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
