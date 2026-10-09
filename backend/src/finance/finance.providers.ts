import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { StripeClientService, toCents } from '../integrations/stripe-client.service';
import { Payout } from '../database/entities';

export interface TransferResult {
  ref: string;
  provider: 'stripe' | 'mock';
  /** instant cash-out: Stripe payout id on the connected account (card payout in minutes) */
  instantRef?: string;
  /** instant cash-out asked for but done as a standard transfer (why) */
  instantFallback?: string;
}

export interface StripeBalanceResult {
  /** net cash-in reported by the provider for the period (charges - refunds), CAD */
  net: number;
  source: 'stripe' | 'mock';
  error?: string;
}

/**
 * Payout provider adapter (Stripe Connect: "separate charges and transfers") + Stripe balance adapter for reconciliation.
 * Without a Stripe key payouts are mocked ONLY when the dev mock is allowed (NODE_ENV != production, ALLOW_MOCK_PAYMENTS=true);
 * otherwise they fail closed (a payout is never marked paid without a real transfer).
 */
@Injectable()
export class FinanceProviders {
  private readonly logger = new Logger('FinanceProviders');

  constructor(private stripeClient: StripeClientService) {}

  get mode(): 'stripe' | 'mock' | 'none' {
    return this.stripeClient.provider();
  }

  private client(): any {
    return this.stripeClient.client();
  }

  /** Is the connected account able to receive an INSTANT payout (eligible debit card on file)? */
  async instantEligible(accountId: string): Promise<{ ok: boolean; reason?: string }> {
    const stripe = this.client();
    if (!stripe) return { ok: false, reason: 'Instant payouts need Stripe' };
    try {
      const list = await stripe.accounts.listExternalAccounts(accountId, { object: 'card', limit: 10 });
      const card = (list.data ?? []).find((c: any) => (c.available_payout_methods ?? []).includes('instant'));
      if (card) return { ok: true };
      return { ok: false, reason: 'No eligible debit card on the Stripe account: add a Visa or Mastercard debit card in the payout settings to cash out instantly' };
    } catch (e: any) {
      return { ok: false, reason: `Could not check instant payout eligibility: ${String(e?.message ?? e).slice(0, 160)}` };
    }
  }

  /**
   * Move net funds to a merchant / driver (a Stripe transfer to the connected account; idempotent per payout id).
   * Throws on failure (caller marks the payout FAILED). `instant` additionally pays the transferred amount out to the party's debit card.
   */
  async transfer(payout: Payout, destinationAccountId: string | null, opts: { instant?: boolean } = {}): Promise<TransferResult> {
    const stripe = this.client();
    if (!stripe) {
      if (!this.stripeClient.mockAllowed()) throw new Error('Payout provider (Stripe) is not configured');
      return { ref: `mock_tr_${randomUUID().slice(0, 12)}`, provider: 'mock' };
    }
    if (!destinationAccountId) throw new Error('No Stripe Connect account on file for this party');
    const t = await stripe.transfers.create(
      {
        amount: toCents(payout.net),
        currency: 'cad',
        destination: destinationAccountId,
        description: `FORKSY payout ${payout.periodStart}..${payout.periodEnd}`,
        transfer_group: payout.batchId ? `batch_${payout.batchId}` : `payout_${payout.id}`,
        metadata: { payoutId: payout.id, batchId: payout.batchId ?? '', partyType: payout.partyType, partyId: payout.partyId, instant: String(payout.instant) },
      },
      { idempotencyKey: `payout_${payout.id}` },
    );
    const out: TransferResult = { ref: t.id, provider: 'stripe' };
    if (opts.instant) {
      try {
        const p = await stripe.payouts.create(
          { amount: toCents(payout.net), currency: 'cad', method: 'instant', metadata: { payoutId: payout.id, partyId: payout.partyId } },
          { stripeAccount: destinationAccountId, idempotencyKey: `payout_${payout.id}_instant` },
        );
        out.instantRef = p.id;
      } catch (e: any) {
        // the money is already on the party's Stripe balance: it follows their normal payout schedule
        out.instantFallback = `Instant payout was not possible (${String(e?.message ?? e).slice(0, 160)}); the money is on the Stripe account and arrives with the normal schedule`;
      }
    }
    return out;
  }

  /**
   * Net money the provider reports for [from, to): charges - refunds. Mock provider reports `mockNet` (computed from captured Payment rows).
   */
  async balanceFor(from: Date, to: Date, mockNet: number): Promise<StripeBalanceResult> {
    const stripe = this.client();
    if (!stripe) {
      if (!this.stripeClient.mockAllowed()) return { net: 0, source: 'mock', error: 'Stripe is not configured' }; // fail closed: reconciliation cannot pass on mock numbers
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
