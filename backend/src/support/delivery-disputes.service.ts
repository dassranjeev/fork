import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Cron } from '@nestjs/schedule';
import { Repository } from 'typeorm';
import { CustomerProfile, DriverProfile, Order, Ticket } from '../database/entities';
import { ActorType, DisputeOutcome, OrderStatus, TicketCategory, TicketTier } from '../common/enums';
import { AuthUser } from '../common/auth.types';
import { SettingsService } from '../settings/settings.service';
import { AuditService } from '../audit/audit.service';
import { OrdersService } from '../orders/orders.service';
import { ProofService } from '../orders/proof.service';
import { TicketsService } from './tickets.service';

interface StrikeEntry {
  ticketId: string;
  orderId: string;
  at: string;
  reason: string;
  reversed?: boolean;
}

/**
 * "Order never arrived" disputes versus the delivery evidence record:
 *  - VALID proof (PIN verified, or a clean in-geofence photo) -> no auto-refund; the ticket goes to Tier 2 with the evidence attached.
 *  - missing / weak / flagged proof -> the existing refund path stays, and the driver gets a delivery-dispute strike.
 *  - staff record the OUTCOME (UPHELD_DELIVERED | NOT_DELIVERED | INCONCLUSIVE), which corrects the strike and the customer's false-claim counter.
 */
@Injectable()
export class DeliveryDisputesService {
  private readonly logger = new Logger(DeliveryDisputesService.name);

  constructor(
    private settings: SettingsService,
    private proof: ProofService,
    private tickets: TicketsService,
    private orders: OrdersService,
    private audit: AuditService,
    @InjectRepository(DriverProfile) private drivers: Repository<DriverProfile>,
    @InjectRepository(CustomerProfile) private profiles: Repository<CustomerProfile>,
    @InjectRepository(Ticket) private ticketRepo: Repository<Ticket>,
  ) {}

  /** Called by self-serve right after a NEVER_ARRIVED ticket is created. Returns whether valid proof routed it to a human. */
  async onNeverArrivedClaim(order: Order, ticket: Ticket): Promise<{ validProof: boolean; strike: boolean }> {
    const done = order.status === OrderStatus.DELIVERED || order.status === OrderStatus.COLLECTED;
    if (!done || !order.driverId) return { validProof: false, strike: false };
    const p = await this.proof.find(order.id);
    if (p?.proofType === 'HANDED_OVER') {
      // the customer turned the PIN off and the driver reported handing it over in person: nothing to verify, but not the driver's fault either
      await this.proof.patchReview(p.id, { disputeTicketId: ticket.id });
      if (ticket.tier !== TicketTier.TIER2 && ticket.tier !== TicketTier.FINANCE) await this.tickets.escalate(ticket.id, { type: 'SYSTEM' }, { tier: TicketTier.TIER2, reason: 'Hand-over without PIN or photo - review required' });
      await this.tickets.sysNote(ticket.id, `The customer turned the delivery PIN off and the driver reported handing the order to the customer in person (${p.distanceMeters ?? '?'} m from the drop-off pin, delivered ${p.deliveredAt.toISOString()}). There is no PIN or photo to verify. No automatic refund and no driver strike - review with both parties.`);
      await this.ticketRepo.update(ticket.id, { meta: { ...(ticket.meta ?? {}), proofOnFile: false, handedOver: true, proofType: p.proofType } } as any);
      return { validProof: true, strike: false };
    }
    if (this.proof.isValid(p)) {
      if (p!.reviewStatus !== 'REVIEWED') await this.proof.patchReview(p!.id, { reviewStatus: 'NEEDS_REVIEW', disputeTicketId: ticket.id });
      else await this.proof.patchReview(p!.id, { disputeTicketId: ticket.id });
      if (ticket.tier !== TicketTier.TIER2 && ticket.tier !== TicketTier.FINANCE) {
        await this.tickets.escalate(ticket.id, { type: 'SYSTEM' }, { tier: TicketTier.TIER2, reason: 'Proof on file - review required' });
      }
      await this.tickets.sysNote(
        ticket.id,
        `Proof on file - review required. Delivery proof: ${p!.proofType}${p!.pinVerified ? ' (customer PIN verified)' : ''}, ${p!.distanceMeters ?? '?'} m from the drop-off pin, delivered ${p!.deliveredAt.toISOString()}. No automatic refund was issued.`,
      );
      await this.ticketRepo.update(ticket.id, { meta: { ...(ticket.meta ?? {}), proofOnFile: true, proofType: p!.proofType } } as any);
      return { validProof: true, strike: false };
    }
    await this.addStrike(order, ticket.id, p ? `weak or flagged proof (${p.proofType}${p.flags.length ? ': ' + p.flags.join(',') : ''})` : 'no delivery proof on file');
    await this.tickets.sysNote(ticket.id, p ? `Proof is weak/flagged (${p.flags.join(', ') || p.proofType}) - refund path kept; driver delivery-dispute strike recorded.` : 'No delivery proof on file - refund path kept; driver delivery-dispute strike recorded.');
    return { validProof: false, strike: true };
  }

  // ------------------------------------------------------------------ strikes
  private log(p: DriverProfile): StrikeEntry[] {
    return Array.isArray(p.meta?.deliveryDisputeLog) ? (p.meta.deliveryDisputeLog as StrikeEntry[]) : [];
  }

  private async saveLog(p: DriverProfile, log: StrikeEntry[]) {
    const cutoff = Date.now() - 30 * 86400_000;
    const active = log.filter((s) => !s.reversed && new Date(s.at).getTime() >= cutoff).length;
    const total = log.filter((s) => !s.reversed).length;
    await this.drivers.update(p.id, { meta: { ...(p.meta ?? {}), deliveryDisputeLog: log.slice(-200) }, deliveryDisputes30d: active, deliveryDisputesTotal: total } as any);
  }

  async addStrike(order: Order, ticketId: string, reason: string) {
    const p = await this.drivers.findOne({ where: { id: order.driverId! } });
    if (!p) return;
    const log = this.log(p);
    const existing = log.find((s) => s.ticketId === ticketId);
    if (existing) existing.reversed = false;
    else log.push({ ticketId, orderId: order.id, at: new Date().toISOString(), reason });
    await this.saveLog(p, log);
  }

  async reverseStrike(order: Order, ticketId: string) {
    const p = order.driverId ? await this.drivers.findOne({ where: { id: order.driverId } }) : null;
    if (!p) return;
    const log = this.log(p);
    const s = log.find((x) => x.ticketId === ticketId);
    if (s && !s.reversed) {
      s.reversed = true;
      await this.saveLog(p, log);
    }
  }

  @Cron('0 15 3 * * *')
  async recomputeStrikes() {
    try {
      const rows = await this.drivers.createQueryBuilder('d').where('d.deliveryDisputesTotal > 0 OR d.deliveryDisputes30d > 0').getMany();
      for (const p of rows) await this.saveLog(p, this.log(p));
    } catch (e) {
      this.logger.warn(`strike recompute failed: ${(e as Error).message}`);
    }
  }

  // ------------------------------------------------------------------ outcome
  async recordOutcome(ticketId: string, user: AuthUser, outcome: DisputeOutcome, note?: string) {
    const ticket = await this.tickets.get(ticketId);
    if (!ticket.orderId) throw new BadRequestException('This ticket is not linked to an order');
    if (ticket.category !== TicketCategory.NEVER_ARRIVED) throw new BadRequestException('Delivery outcomes apply to "order never arrived" tickets');
    const order = await this.orders.getById(ticket.orderId, []);
    const prev: DisputeOutcome | null = ticket.meta?.deliveryOutcome?.outcome ?? null;
    if (prev === outcome) return { ticketId, outcome, unchanged: true };

    // undo the previous verdict's side effects
    if (prev === DisputeOutcome.UPHELD_DELIVERED && ticket.requesterId) await this.bumpFalseClaims(ticket.requesterId, -1, false);
    // apply the new one
    if (outcome === DisputeOutcome.UPHELD_DELIVERED) {
      await this.reverseStrike(order, ticketId);
      if (ticket.requesterId) await this.bumpFalseClaims(ticket.requesterId, +1, true);
    } else if (outcome === DisputeOutcome.NOT_DELIVERED) {
      if (order.driverId) await this.addStrike(order, ticketId, 'staff confirmed: not delivered');
    }
    const meta = { ...(ticket.meta ?? {}), deliveryOutcome: { outcome, note: note ?? null, byId: user.id, at: new Date().toISOString() } };
    await this.ticketRepo.update(ticketId, { meta } as any);
    const proof = await this.proof.find(order.id);
    if (proof) await this.proof.patchReview(proof.id, { disputeOutcome: outcome, disputeOutcomeById: user.id, disputeOutcomeAt: new Date(), disputeTicketId: ticketId, reviewStatus: 'REVIEWED', reviewedById: user.id, reviewedAt: new Date(), reviewNote: note ?? null });
    await this.orders.addEvent(order.id, 'DELIVERY_DISPUTE_OUTCOME', { type: ActorType.STAFF, id: user.id }, note, { outcome, ticketId });
    await this.tickets.sysNote(ticketId, `Delivery dispute outcome recorded by ${user.name ?? user.email ?? 'staff'}: ${outcome}${note ? ' - ' + note : ''}`);
    await this.audit.log({ actor: user, action: 'support.delivery_outcome', entity: 'Ticket', entityId: ticketId, before: { outcome: prev }, after: { outcome, orderId: order.id } });
    return { ticketId, orderId: order.id, outcome, previous: prev };
  }

  private async bumpFalseClaims(customerId: string, delta: number, flagIfRepeated: boolean) {
    const prof = await this.profiles.findOne({ where: { userId: customerId } });
    if (!prof) return;
    const n = Math.max(0, (prof.falseDeliveryClaims ?? 0) + delta);
    const patch: Partial<CustomerProfile> = { falseDeliveryClaims: n };
    const threshold = this.settings.get<number>('support.falseClaimFlagThreshold', 2);
    if (flagIfRepeated && n >= threshold) {
      // flagged for review (tickets route to Tier 2, no instant credits) - NOT blocked
      patch.fraudFlag = true;
      patch.flags = [...new Set([...(prof.flags ?? []), 'FALSE_DELIVERY_CLAIMS'])];
    }
    await this.profiles.update(prof.id, patch as any);
  }

  async strikesFor(driverId: string) {
    const p = await this.drivers.findOne({ where: { id: driverId } });
    if (!p) throw new NotFoundException('Driver not found');
    return { deliveryDisputes30d: p.deliveryDisputes30d, deliveryDisputesTotal: p.deliveryDisputesTotal, log: this.log(p).slice(-20).reverse() };
  }
}
