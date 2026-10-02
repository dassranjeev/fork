import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { SettingsService } from '../settings/settings.service';
import { Payout } from '../database/entities';

export interface TransferResult {
  ref: string;
  provider: 'stripe' | 'mock';
}

export interface StripeBalanceResult {
  /** net cash-in reported by the provider for the period (charges - refunds), CAD */
  net: number;
  source: 'stripe' | 'mock';
  error?: string;
}

/**
 * Payout provider adapter (Stripe Connect transfers) + Stripe balance adapter for reconciliation.
 * With no Stripe secret key configured everything is mocked deterministically.
 */
@Injectable()
export class FinanceProviders {
  private readonly logger = new Logger('FinanceProviders');
  private cached: { key: string; client: any } | null = null;

  constructor(
    private settings: SettingsService,
    private config: ConfigService,
  ) {}

  private key(): string {
    return this.settings.get<string>('payments.stripe.secretKey', '') || this.config.get<string>('stripe.secretKey') || '';
  }

  get mode(): 'stripe' | 'mock' {
    return this.key() ? 'stripe' : 'mock';
  }

  private client(): any {
    const key = this.key();
    if (!key) return null;
    if (!this.cached || this.cached.key !== key) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Stripe = require('stripe');
      this.cached = { key, client: new (Stripe.default ?? Stripe)(key) };
    }
    return this.cached.client;
  }

  /** Move net funds to a merchant / driver. Throws on failure (caller marks the payout FAILED). */
  async transfer(payout: Payout, destinationAccountId: string | null): Promise<TransferResult> {
    const stripe = this.client();
    if (!stripe) {
      // the mock transfer is a development convenience: in production a payout without a real provider must FAIL, never be marked paid
      if (process.env.NODE_ENV === 'production') throw new Error('Payout provider (Stripe) is not configured');
      return { ref: `mock_tr_${randomUUID().slice(0, 12)}`, provider: 'mock' };
    }
    if (!destinationAccountId) throw new Error('No Stripe Connect account on file for this party');
    const t = await stripe.transfers.create(
      {
        amount: Math.round(payout.net * 100),
        currency: 'cad',
        destination: destinationAccountId,
        description: `FORKSY payout ${payout.periodStart}..${payout.periodEnd}`,
        metadata: { payoutId: payout.id, partyType: payout.partyType, partyId: payout.partyId, instant: String(payout.instant) },
      },
      { idempotencyKey: `payout_${payout.id}` },
    );
    return { ref: t.id, provider: 'stripe' };
  }

  /**
   * Net money the provider reports for [from, to): charges - refunds. Mock provider reports `mockNet` (computed from captured Payment rows).
   */
  async balanceFor(from: Date, to: Date, mockNet: number): Promise<StripeBalanceResult> {
    const stripe = this.client();
    if (!stripe) {
      if (process.env.NODE_ENV === 'production') return { net: 0, source: 'mock', error: 'Stripe is not configured' }; // fail closed: reconciliation cannot pass on mock numbers
      return { net: mockNet, source: 'mock' };
    }
    try {
      let total = 0;
      const list = stripe.balanceTransactions.list({
        created: { gte: Math.floor(from.getTime() / 1000), lt: Math.floor(to.getTime() / 1000) },
        limit: 100,
      });
      for await (const bt of list) {
        if (bt.currency && bt.currency !== 'cad') continue;
        if (['charge', 'payment'].includes(bt.type)) total += bt.amount;
        else if (['refund', 'payment_refund', 'adjustment'].includes(bt.type)) total += bt.amount; // negative amounts
      }
      return { net: total / 100, source: 'stripe' };
    } catch (e: any) {
      this.logger.warn(`Stripe balance lookup failed: ${e.message}`);
      return { net: mockNet, source: 'mock', error: String(e.message ?? e).slice(0, 200) };
    }
  }
}
