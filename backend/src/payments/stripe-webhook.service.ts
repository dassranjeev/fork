import { Injectable, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DriverProfile, Merchant, Order, Payment, Payout, StripeEvent, StripeIntent } from '../database/entities';
import { LedgerType, OrderStatus, PartyType, PaymentStatus, TicketCategory } from '../common/enums';
import { NotificationsService } from '../notifications/notifications.service';
import { LedgerService } from '../orders/ledger.service';
import { PayoutsService } from '../finance/payouts.service';
import { TicketsService } from '../support/tickets.service';
import { StripeClientService } from '../integrations/stripe-client.service';
import { PaymentsService } from '../orders/payments.service';
import { ConnectService } from './connect.service';
import { TopUpService } from './topup.service';

const r2 = (n: number) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const cad = (cents: number) => `$${(Number(cents) / 100).toFixed(2)}`;
/** a webhook that keeps failing is eventually answered with 200 so Stripe stops retrying; it stays FAILED for a manual replay */
const MAX_ATTEMPTS = 6;

type Handler = (event: any, obj: any) => Promise<boolean>;

/**
 * Stripe webhook processing. Idempotent: every event id is stored once in stripe_events (unique); a processed event is acknowledged
 * and ignored; a failed one is retried (Stripe retries, or an admin replays it from the Integrations page).
 * Unknown event types are stored as IGNORED and acknowledged (200) - they must never make Stripe retry.
 */
@Injectable()
export class StripeWebhookService {
  private readonly logger = new Logger('StripeWebhook');
  private readonly handlers: Record<string, Handler>;

  constructor(
    @InjectRepository(StripeEvent) private events: Repository<StripeEvent>,
    @InjectRepository(StripeIntent) private intents: Repository<StripeIntent>,
    @InjectRepository(Order) private orders: Repository<Order>,
    @InjectRepository(Payment) private payments: Repository<Payment>,
    @InjectRepository(Payout) private payoutRepo: Repository<Payout>,
    @InjectRepository(Merchant) private merchantRepo: Repository<Merchant>,
    @InjectRepository(DriverProfile) private driverRepo: Repository<DriverProfile>,
    private stripeClient: StripeClientService,
    private topups: TopUpService,
    private connect: ConnectService,
    private payouts: PayoutsService,
    private ledger: LedgerService,
    private notifications: NotificationsService,
    private paymentsSvc: PaymentsService,
    private moduleRef: ModuleRef,
  ) {
    this.handlers = {
      'payment_intent.succeeded': (e, o) => this.onIntent(e, o),
      'payment_intent.amount_capturable_updated': (e, o) => this.onIntent(e, o),
      'payment_intent.payment_failed': (e, o) => this.onIntent(e, o),
      'payment_intent.canceled': (e, o) => this.onIntent(e, o),
      'charge.refunded': (e, o) => this.onChargeRefunded(o),
      'charge.dispute.created': (e, o) => this.onDispute(e.type, o),
      'charge.dispute.updated': (e, o) => this.onDispute(e.type, o),
      'charge.dispute.closed': (e, o) => this.onDispute(e.type, o),
      'setup_intent.succeeded': (e, o) => this.onSetupIntent(o),
      'transfer.created': (e, o) => this.onTransfer(e.type, o),
      'transfer.updated': (e, o) => this.onTransfer(e.type, o),
      'transfer.reversed': (e, o) => this.onTransfer(e.type, o),
      'payout.paid': (e, o) => this.onConnectedPayout(e, o),
      'payout.failed': (e, o) => this.onConnectedPayout(e, o),
      'account.updated': (e, o) => this.onAccountUpdated(o),
    };
  }

  // ------------------------------------------------------------------ entry points
  /** Called with a signature-verified event. Returns what to tell Stripe; throws (=> 500, Stripe retries) only when a KNOWN event failed. */
  async receive(event: any) {
    const obj = event?.data?.object ?? {};
    await this.events
      .createQueryBuilder()
      .insert()
      .values({ eventId: event.id, type: event.type, livemode: !!event.livemode, account: event.account ?? null, objectId: obj.id ?? null, status: 'RECEIVED', payload: event })
      .orIgnore()
      .execute();
    const row = await this.events.findOneOrFail({ where: { eventId: event.id } });
    if (row.processed) return { received: true, duplicate: true, status: row.status };
    const out = await this.process(row, event);
    if (out.failed) {
      if (row.attempts >= MAX_ATTEMPTS) return { received: true, status: 'FAILED', gaveUp: true };
      throw new InternalServerErrorException('Event processing failed'); // Stripe retries with back-off
    }
    return { received: true, status: row.status };
  }

  /** Admin: run a stored event again (e.g. after fixing the cause of a failure). */
  async replay(id: string) {
    const row = await this.events.findOne({ where: { id } });
    if (!row?.payload) throw new NotFoundException('Event not found');
    const out = await this.process(row, row.payload, true);
    return { id: row.id, eventId: row.eventId, status: row.status, error: row.error, replayed: true, failed: out.failed };
  }

  async list(q: { status?: string; type?: string; limit: number }) {
    const qb = this.events.createQueryBuilder('e').select(['e.id', 'e.eventId', 'e.type', 'e.livemode', 'e.account', 'e.objectId', 'e.status', 'e.processed', 'e.processedAt', 'e.error', 'e.attempts', 'e.createdAt']).orderBy('e.createdAt', 'DESC').take(q.limit);
    if (q.status) qb.andWhere('e.status = :s', { s: q.status });
    if (q.type) qb.andWhere('e.type = :t', { t: q.type });
    const [data, total] = await qb.getManyAndCount();
    const failed = await this.events.count({ where: { status: 'FAILED' } });
    return { data, meta: { total, failed } };
  }

  private async process(row: StripeEvent, event: any, force = false): Promise<{ failed: boolean }> {
    const handler = this.handlers[event.type];
    row.attempts += 1;
    if (!handler) {
      row.status = 'IGNORED';
      row.processed = true;
      row.processedAt = new Date();
      row.error = null;
      await this.events.save(row);
      return { failed: false };
    }
    try {
      const handled = await handler(event, event.data?.object ?? {});
      row.status = handled ? 'PROCESSED' : 'IGNORED';
      row.processed = true;
      row.processedAt = new Date();
      row.error = null;
      await this.events.save(row);
      return { failed: false };
    } catch (e: any) {
      row.status = 'FAILED';
      row.error = String(e?.message ?? e).slice(0, 500);
      await this.events.save(row);
      this.logger.error(`event ${event.id} (${event.type}) failed: ${row.error}`);
      if (!force && row.attempts >= MAX_ATTEMPTS) await this.notifications.notifyOps('finance.stripe_alert', { message: `Stripe event ${event.type} (${event.id}) keeps failing: ${row.error}. Replay it from System > Integrations.` }).catch(() => undefined);
      return { failed: true };
    }
  }

  // ------------------------------------------------------------------ payment intents
  private async onIntent(event: any, pi: any): Promise<boolean> {
    const row = await this.intents.findOne({ where: { intentId: pi.id } });
    if (row) await this.intents.update({ id: row.id }, { status: pi.status });
    const purpose = row?.purpose ?? pi.metadata?.purpose;
    if (event.type === 'payment_intent.succeeded') {
      if (purpose === 'TOPUP' || purpose === 'GIFT_CARD') {
        const r = await this.topups.fulfil(pi.id);
        return r.status !== 'ignored';
      }
      // ORDER intents succeed when we capture (delivery / late-cancel fee): make sure the order shows it even if our own write was lost
      const order = await this.orders.findOne({ where: { paymentIntentId: pi.id } });
      if (order && [PaymentStatus.AUTHORIZED, PaymentStatus.PENDING].includes(order.paymentStatus) && [OrderStatus.DELIVERED, OrderStatus.COLLECTED].includes(order.status) && (pi.amount_received ?? 0) > 0) {
        await this.orders.update(order.id, { paymentStatus: PaymentStatus.CAPTURED });
        const charge = typeof pi.latest_charge === 'string' ? pi.latest_charge : pi.latest_charge?.id;
        if (charge && !(await this.payments.exist({ where: { orderId: order.id, kind: 'CAPTURE', externalId: charge } }))) {
          await this.payments.insert({ orderId: order.id, provider: 'stripe', kind: 'CAPTURE', amount: r2(pi.amount_received / 100), status: 'SUCCEEDED', externalId: charge, meta: { intentId: pi.id, via: 'webhook' } } as any);
        }
      }
      return !!row || !!order;
    }
    if (event.type === 'payment_intent.payment_failed') {
      if (row) await this.intents.update({ id: row.id }, { meta: { ...(row.meta ?? {}), lastError: String(pi.last_payment_error?.message ?? pi.last_payment_error?.code ?? 'payment failed').slice(0, 200) } } as any);
      return !!row;
    }
    if (event.type === 'payment_intent.canceled') {
      if (row) await this.intents.update({ id: row.id }, { canceledAt: row.canceledAt ?? new Date() });
      const order = await this.orders.findOne({ where: { paymentIntentId: pi.id } });
      // a hold that disappeared under a live order (it expires after 7 days, or someone cancelled it in the Stripe dashboard)
      if (order && order.paymentStatus === PaymentStatus.AUTHORIZED && ![OrderStatus.CANCELLED, OrderStatus.REJECTED].includes(order.status)) {
        await this.orders.update(order.id, { meta: { ...(order.meta ?? {}), paymentAlert: { at: new Date().toISOString(), reason: 'The card hold was cancelled in Stripe while the order was still active' } } } as any);
        await this.notifications.notifyOps('finance.stripe_alert', { message: `The card hold for order ${order.code} was cancelled in Stripe while the order is ${order.status}. Check the payment before the order is delivered.` }, { orderId: order.id });
      }
      return !!row || !!order;
    }
    return !!row; // amount_capturable_updated: status stored
  }

  private async onSetupIntent(si: any): Promise<boolean> {
    const customer = typeof si.customer === 'string' ? si.customer : si.customer?.id;
    const pm = typeof si.payment_method === 'string' ? si.payment_method : si.payment_method?.id;
    if (!customer || !pm) return false;
    await this.paymentsSvc.ensureDefaultPaymentMethod(customer, pm);
    return true;
  }

  // ------------------------------------------------------------------ refunds and disputes
  /** charge.refunded: keep our records right when a refund was made in the Stripe dashboard (refunds made by FORKY are already recorded). */
  private async onChargeRefunded(charge: any): Promise<boolean> {
    const piId = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id;
    if (!piId) return false;
    const order = await this.orders.findOne({ where: { paymentIntentId: piId } });
    if (!order) return false;
    const rows = await this.payments.find({ where: { orderId: order.id, status: 'SUCCEEDED' } });
    const recorded = rows.filter((r) => r.kind === 'REFUND' || (r.kind === 'TIP_ADJUST' && r.meta?.phase === 'post' && Number(r.amount) < 0)).reduce((a, r) => a + Math.abs(Number(r.amount)), 0);
    const total = r2((charge.amount_refunded ?? 0) / 100);
    const missing = r2(total - recorded);
    if (missing < 0.01) return true;
    await this.payments.insert({ orderId: order.id, provider: 'stripe', kind: 'REFUND', amount: missing, status: 'SUCCEEDED', externalId: charge.id, meta: { intentId: piId, source: 'stripe_dashboard' } } as any);
    await this.orders.update(order.id, { paymentStatus: total >= r2(Number(order.total) - Number(order.walletUsed ?? 0)) - 0.01 ? PaymentStatus.REFUNDED : PaymentStatus.PARTIALLY_REFUNDED });
    await this.ledger.add({ partyType: PartyType.PLATFORM, partyId: null, orderId: order.id, type: LedgerType.REFUND, amount: -missing, description: `Refund made in the Stripe dashboard (${charge.id})` });
    await this.notifications.notifyOps('finance.stripe_alert', { message: `A refund of $${missing.toFixed(2)} for order ${order.code} was made directly in Stripe and has been recorded in FORKY.` }, { orderId: order.id });
    return true;
  }

  private async onDispute(type: string, d: any): Promise<boolean> {
    let piId = typeof d.payment_intent === 'string' ? d.payment_intent : d.payment_intent?.id;
    if (!piId && d.charge && this.stripeClient.client()) {
      const chId = typeof d.charge === 'string' ? d.charge : d.charge?.id;
      const ch = chId ? await this.stripeClient.client().charges.retrieve(chId).catch(() => null) : null;
      piId = typeof ch?.payment_intent === 'string' ? ch.payment_intent : ch?.payment_intent?.id;
    }
    const order = piId ? await this.orders.findOne({ where: { paymentIntentId: piId } }) : null;
    const amount = r2((d.amount ?? 0) / 100);
    const dueBy = d.evidence_details?.due_by ? new Date(d.evidence_details.due_by * 1000).toISOString().slice(0, 10) : 'the deadline shown in Stripe';
    const snapshot = { id: d.id, status: d.status, reason: d.reason, amount, dueBy, updatedAt: new Date().toISOString() };

    if (type === 'charge.dispute.created') {
      if (!order) {
        await this.notifications.notifyOps('finance.dispute', { status: d.status, code: 'unknown order', amount: `$${amount.toFixed(2)}`, reason: d.reason, dueBy }, { disputeId: d.id });
        return true;
      }
      const dup = await this.payments.exist({ where: { orderId: order.id, kind: 'DISPUTE' as any, externalId: d.id } });
      if (dup) return true; // already booked (replay)
      await this.payments.insert({ orderId: order.id, provider: 'stripe', kind: 'DISPUTE', amount, status: 'SUCCEEDED', externalId: d.id, meta: { reason: d.reason, intentId: piId } } as any);
      await this.ledger.add({ partyType: PartyType.PLATFORM, partyId: null, orderId: order.id, type: LedgerType.ADJUSTMENT, amount: -amount, description: `Card dispute ${d.id} (${d.reason}) on ${order.code}`, meta: { disputeId: d.id } });
      await this.orders.update(order.id, { meta: { ...(order.meta ?? {}), dispute: snapshot } } as any);
      const tickets = this.moduleRef.get(TicketsService, { strict: false });
      const t = await tickets.create({
        requesterType: 'STAFF',
        subject: `Card dispute on order ${order.code}: ${d.reason}`,
        body: `The customer's bank opened a dispute (chargeback) of $${amount.toFixed(2)} on order ${order.code}.\nReason: ${d.reason}\nStripe dispute: ${d.id}\nRespond with evidence in the Stripe dashboard before ${dueBy}.`,
        category: TicketCategory.PAYMENT,
        priority: 'URGENT',
        orderId: order.id,
        source: 'AUTO',
        tags: ['dispute', 'chargeback', 'stripe'],
        meta: { disputeId: d.id, intentId: piId },
      });
      await this.orders.update(order.id, { meta: { ...(order.meta ?? {}), dispute: { ...snapshot, ticketId: t.id, ticketNumber: t.number } } } as any);
      await this.notifications.notifyOps('finance.dispute', { status: d.status, code: order.code, amount: `$${amount.toFixed(2)}`, reason: d.reason, dueBy }, { orderId: order.id, disputeId: d.id });
      return true;
    }

    if (!order) return false;
    const prev = order.meta?.dispute ?? {};
    await this.orders.update(order.id, { meta: { ...(order.meta ?? {}), dispute: { ...prev, ...snapshot } } });
    if (prev.ticketId) {
      const tickets = this.moduleRef.get(TicketsService, { strict: false });
      await tickets.sysNote(prev.ticketId, `Stripe dispute ${d.id} is now ${d.status}${type === 'charge.dispute.closed' ? ' (closed)' : ''}.`).catch(() => undefined);
    }
    if (type === 'charge.dispute.closed' && d.status === 'won') {
      const dup = await this.payments.exist({ where: { orderId: order.id, kind: 'DISPUTE_REVERSAL' as any, externalId: d.id } });
      if (!dup) {
        await this.payments.insert({ orderId: order.id, provider: 'stripe', kind: 'DISPUTE_REVERSAL', amount, status: 'SUCCEEDED', externalId: d.id, meta: { intentId: piId } } as any);
        await this.ledger.add({ partyType: PartyType.PLATFORM, partyId: null, orderId: order.id, type: LedgerType.ADJUSTMENT, amount, description: `Card dispute ${d.id} WON: funds returned (${order.code})`, meta: { disputeId: d.id } });
      }
    }
    if (type === 'charge.dispute.closed') await this.notifications.notifyOps('finance.dispute', { status: d.status, code: order.code, amount: `$${amount.toFixed(2)}`, reason: d.reason, dueBy: 'closed' }, { orderId: order.id, disputeId: d.id });
    return true;
  }

  // ------------------------------------------------------------------ Connect
  private async onTransfer(type: string, t: any): Promise<boolean> {
    const p = await this.payoutRepo.findOne({ where: { externalRef: t.id } });
    if (!p) return false;
    if (type === 'transfer.reversed' || (t.reversed && (t.amount_reversed ?? 0) > 0)) {
      await this.payouts.onTransferReversed(t.id, r2((t.amount_reversed ?? 0) / 100));
      return true;
    }
    await this.payoutRepo.update(p.id, { meta: { ...(p.meta ?? {}), transfer: { id: t.id, at: new Date().toISOString(), type } } } as any);
    return true;
  }

  private async onConnectedPayout(event: any, po: any): Promise<boolean> {
    const account = event.account;
    if (!account) return false; // platform-level payout (FORKY's own bank), not a party payout
    const party = await this.payouts.findPartyByAccount(account);
    if (!party) return false;
    if (event.type === 'payout.failed') {
      await this.payouts.onConnectedPayoutFailed(account, po);
    }
    // remember the last bank payout on the party (shown in the admin / portal)
    const repo: Repository<any> = party.type === PartyType.RESTAURANT ? this.merchantRepo : this.driverRepo;
    const row = await repo.findOne({ where: { id: party.id } });
    await repo.update(party.id, { stripeAccountInfo: { ...(row?.stripeAccountInfo ?? {}), lastPayout: { id: po.id, status: event.type === 'payout.paid' ? 'paid' : 'failed', amount: r2((po.amount ?? 0) / 100), at: new Date().toISOString(), method: po.method ?? null, failure: po.failure_code ?? null } } });
    return true;
  }

  private async onAccountUpdated(acct: any): Promise<boolean> {
    return this.connect.applyAccountEvent(acct);
  }
}
