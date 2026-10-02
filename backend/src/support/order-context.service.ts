import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, In, Repository } from 'typeorm';
import {
  CustomerProfile,
  DeviceToken,
  DriverLocationLog,
  DriverProfile,
  Order,
  OrderEvent,
  OrderItem,
  Refund,
  Restaurant,
  Ticket,
  User,
} from '../database/entities';
import { OrderStatus, OrderType, PaymentStatus, RefundChargedTo, RefundStatus, RefundType, TicketCategory } from '../common/enums';
import { haversineKm } from '../common/geo.util';
import { SettingsService } from '../settings/settings.service';
import { ChargedTo, round2 } from './support.constants';

export interface SuggestedLine {
  type: RefundType;
  amount: number;
  chargedTo: ChargedTo;
  reasonCode: string;
  note: string;
}

export interface Suggestion {
  category: TicketCategory;
  rule: string; // spec 9.3 rule name
  action: 'ITEM_REFUND' | 'FULL_REFUND' | 'DELIVERY_FEE_REFUND_AND_CREDIT' | 'PARTIAL_CREDIT' | 'REVIEW' | 'EVIDENCE_CONTRADICTS' | 'NOT_ELIGIBLE' | 'NONE';
  lines: SuggestedLine[];
  totalAmount: number;
  refundableRemaining: number;
  evidenceNeeded: string[];
  warnings: string[];
  reliabilityImpact: boolean;
  /** rule engine hint: this outcome may be applied without an agent when history is good */
  autoEligible: boolean;
  summary: string;
}

const maskPhone = (p?: string | null) => (p ? `***-***-${p.replace(/\D/g, '').slice(-4)}` : null);
const nameOf = (u?: Pick<User, 'firstName' | 'lastName'> | null) => (u ? `${u.firstName} ${u.lastName}`.trim() : null);

/** Order + evidence lookup for agents (SOP-06 step 1) and the rule engine. */
@Injectable()
export class OrderContextService {
  constructor(
    private settings: SettingsService,
    @InjectRepository(Order) private orders: Repository<Order>,
    @InjectRepository(OrderItem) private items: Repository<OrderItem>,
    @InjectRepository(OrderEvent) private events: Repository<OrderEvent>,
    @InjectRepository(Refund) private refunds: Repository<Refund>,
    @InjectRepository(Ticket) private tickets: Repository<Ticket>,
    @InjectRepository(User) private users: Repository<User>,
    @InjectRepository(Restaurant) private restaurants: Repository<Restaurant>,
    @InjectRepository(DriverProfile) private drivers: Repository<DriverProfile>,
    @InjectRepository(DriverLocationLog) private gpsLogs: Repository<DriverLocationLog>,
    @InjectRepository(CustomerProfile) private profiles: Repository<CustomerProfile>,
    @InjectRepository(DeviceToken) private devices: Repository<DeviceToken>,
  ) {}

  // ------------------------------------------------------------------ GPS evidence
  async gpsEvidence(order: Order) {
    if (!order.driverId || !order.deliveryAddress) return { points: 0, confirmsDelivery: null as boolean | null, minDistanceKm: null as number | null, trail: [] as any[], note: 'No driver or delivery address' };
    const from = order.pickedUpAt ?? order.driverAssignedAt ?? order.createdAt;
    const to = order.deliveredAt ?? new Date();
    const logs = await this.gpsLogs.find({
      where: [
        { driverId: order.driverId, orderId: order.id },
        { driverId: order.driverId, createdAt: Between(from, to) },
      ],
      order: { createdAt: 'ASC' },
      take: 2000,
    });
    // de-duplicate rows matched by both conditions
    const uniq = [...new Map(logs.map((l) => [l.id, l])).values()].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const dest = order.deliveryAddress;
    let min: number | null = null;
    let nearestAt: Date | null = null;
    for (const l of uniq) {
      const d = haversineKm(l.lat, l.lng, dest.lat, dest.lng);
      if (min === null || d < min) {
        min = d;
        nearestAt = l.createdAt;
      }
    }
    const step = Math.max(1, Math.ceil(uniq.length / 40));
    const trail = uniq
      .filter((_, i) => i % step === 0 || i === uniq.length - 1)
      .map((l) => ({ lat: l.lat, lng: l.lng, at: l.createdAt, distanceToDropoffKm: round2(haversineKm(l.lat, l.lng, dest.lat, dest.lng)) }));
    return {
      points: uniq.length,
      first: uniq[0]?.createdAt ?? null,
      last: uniq[uniq.length - 1]?.createdAt ?? null,
      minDistanceKm: min === null ? null : Math.round(min * 1000) / 1000,
      nearestAt,
      /** driver came within 150 m of the drop-off pin */
      confirmsDelivery: min === null ? null : min <= 0.15,
      trail,
      note: uniq.length ? undefined : 'No GPS points recorded for this trip',
    };
  }

  // ------------------------------------------------------------------ customer history
  async customerHistory(customerId: string) {
    const since = new Date(Date.now() - 30 * 86400_000);
    const profile = await this.profiles.findOne({ where: { userId: customerId } });
    const refundRows = await this.refunds
      .createQueryBuilder('r')
      .innerJoin(Order, 'o', 'o.id = r."orderId"')
      .select('COUNT(*)', 'n')
      .addSelect('COALESCE(SUM(r.amount),0)', 'total')
      .where('o."customerId" = :c AND r."createdAt" >= :since AND r.status <> :rej AND r.amount > 0', { c: customerId, since, rej: RefundStatus.REJECTED })
      .getRawOne();
    const ticketCount30d = await this.tickets.count({ where: { requesterId: customerId, createdAt: Between(since, new Date()) } });
    const orderCount = await this.orders.count({ where: { customerId } });
    const limit = this.settings.get<number>('security.refundFrequencyLimit30d', 4);
    const refundCount30d = Number(refundRows?.n ?? 0);
    return {
      customerId,
      totalOrders: profile?.totalOrders || orderCount,
      lifetimeSpend: profile?.lifetimeSpend ?? 0,
      refundCount30d,
      refundTotal30d: round2(Number(refundRows?.total ?? 0)),
      ticketCount30d,
      refundFrequencyLimit: limit,
      overRefundLimit: refundCount30d >= limit,
      flags: profile?.flags ?? [],
      fraudFlag: profile?.fraudFlag ?? false,
      isBlocked: profile?.isBlocked ?? false,
      walletBalance: profile?.walletBalance ?? 0,
      internalNotes: profile?.internalNotes ?? null,
    };
  }

  /** "Good history" for instant self-serve credits (spec 9.2). */
  async goodHistory(customerId: string) {
    const h = await this.customerHistory(customerId);
    const reasons: string[] = [];
    if (h.isBlocked) reasons.push('Account is blocked');
    if (h.fraudFlag) reasons.push('Account has a fraud flag');
    if (h.flags.length) reasons.push(`Account flags: ${h.flags.join(', ')}`);
    if (h.overRefundLimit) reasons.push(`${h.refundCount30d} refunds in 30 days (limit ${h.refundFrequencyLimit})`);
    return { good: reasons.length === 0, reasons, history: h };
  }

  /** Device fingerprint heuristics (spec 9.3 fraud controls). */
  async deviceCheck(customerId: string, fingerprint?: string | null) {
    const known = (await this.devices.find({ where: { userId: customerId } })).map((d) => d.fingerprint).filter((f): f is string => !!f);
    const result = { fingerprint: fingerprint ?? null, knownFingerprints: known.length, mismatch: false, sharedWithAccounts: 0, suspicious: false, reasons: [] as string[] };
    if (!fingerprint) return result;
    if (known.length && !known.includes(fingerprint)) {
      result.mismatch = true;
      result.reasons.push('Report submitted from a device not previously seen on this account');
    }
    const others = await this.devices
      .createQueryBuilder('d')
      .select('COUNT(DISTINCT d."userId")', 'n')
      .where('d.fingerprint = :f AND d."userId" <> :u', { f: fingerprint, u: customerId })
      .getRawOne();
    result.sharedWithAccounts = Number(others?.n ?? 0);
    if (result.sharedWithAccounts >= 2) result.reasons.push(`Device is shared with ${result.sharedWithAccounts} other accounts`);
    result.suspicious = result.mismatch || result.sharedWithAccounts >= 2;
    return result;
  }

  // ------------------------------------------------------------------ full context
  async summaryFor(order: Order) {
    const [restaurant, driver, customer] = await Promise.all([
      this.restaurants.findOne({ where: { id: order.restaurantId } }),
      order.driverId ? this.drivers.findOne({ where: { id: order.driverId }, relations: { user: true } }) : null,
      this.users.findOne({ where: { id: order.customerId } }),
    ]);
    const eta = order.estimatedDeliveryAt;
    const end = order.deliveredAt ?? (order.cancelledAt ? null : new Date());
    const minutesLate = eta && end ? Math.max(0, Math.round((end.getTime() - eta.getTime()) / 60000)) : 0;
    return {
      order: {
        id: order.id,
        code: order.code,
        status: order.status,
        type: order.type,
        fulfilment: order.fulfilment,
        placedAt: order.createdAt,
        acceptedAt: order.acceptedAt,
        readyAt: order.readyAt,
        pickedUpAt: order.pickedUpAt,
        deliveredAt: order.deliveredAt,
        cancelledAt: order.cancelledAt,
        cancelReason: order.cancelReason,
        cancelledBy: order.cancelledBy,
        estimatedDeliveryAt: order.estimatedDeliveryAt,
        minutesLate,
        isLate: order.isLate,
        subtotal: order.subtotal,
        deliveryFee: order.deliveryFee,
        serviceFee: order.serviceFee,
        taxAmount: order.taxAmount,
        tip: order.tip,
        discountTotal: order.discountTotal,
        total: order.total,
        paymentStatus: order.paymentStatus,
        paymentMethod: order.paymentMethod,
        deliveryAddress: order.deliveryAddress,
        contactless: order.contactless,
        requiresPin: order.requiresPin,
        proofPhotoUrl: order.proofPhotoUrl,
        customerNotes: order.customerNotes,
      },
      restaurant: restaurant ? { id: restaurant.id, name: restaurant.name, phone: restaurant.phone, reliabilityScore: restaurant.reliabilityScore, rating: restaurant.rating } : null,
      driver: driver ? { id: driver.id, userId: driver.userId, name: nameOf(driver.user), phoneMasked: maskPhone(driver.user?.phone), rating: driver.rating, onTimeRate: driver.onTimeRate, status: driver.status } : null,
      customer: customer ? { id: customer.id, name: nameOf(customer), email: customer.email, phoneMasked: maskPhone(customer.phone) } : null,
    };
  }

  async context(orderId: string) {
    const order = await this.orders.findOne({ where: { id: orderId } });
    if (!order) return null;
    const [summary, items, timeline, gps, history, refunds] = await Promise.all([
      this.summaryFor(order),
      this.items.find({ where: { orderId }, order: { createdAt: 'ASC' } }),
      this.events.find({ where: { orderId }, order: { createdAt: 'ASC' } }),
      this.gpsEvidence(order),
      this.customerHistory(order.customerId),
      this.refunds.find({ where: { orderId }, order: { createdAt: 'ASC' } }),
    ]);
    return {
      ...summary,
      items: items.map((i) => ({ id: i.id, name: i.name, quantity: i.quantity, unitPrice: i.unitPrice, lineTotal: i.lineTotal, taxAmount: i.taxAmount, modifiers: i.modifiers, notes: i.notes, removed: i.removed })),
      timeline: timeline.map((e) => ({ at: e.createdAt, type: e.type, from: e.fromStatus, to: e.toStatus, actorType: e.actorType, note: e.note })),
      gps,
      deliveryEvidence: {
        proofPhotoUrl: order.proofPhotoUrl,
        photoPresent: !!order.proofPhotoUrl,
        gpsConfirmsDelivery: gps.confirmsDelivery,
        deliveredAt: order.deliveredAt,
        driverArrivedCustomerAt: order.driverArrivedCustomerAt,
        pinRequired: order.requiresPin,
      },
      customerHistory: history,
      refunds: refunds.map((r) => ({ id: r.id, amount: r.amount, type: r.type, chargedTo: r.chargedTo, reasonCode: r.reasonCode, status: r.status, createdAt: r.createdAt, ticketId: r.ticketId, auto: r.auto })),
    };
  }

  // ------------------------------------------------------------------ refund rule table (spec 9.3)
  async refundedSoFar(orderId: string) {
    const rows = await this.refunds.find({ where: { orderId } });
    return round2(rows.filter((r) => r.status !== RefundStatus.REJECTED).reduce((s, r) => s + Number(r.amount), 0));
  }

  /**
   * Apply the refund rule table to an order + claimed category.
   * itemIds = OrderItem ids the requester says are missing / wrong / poor quality.
   */
  async suggest(orderId: string, category: TicketCategory, itemIds: string[] = [], excludeTicketId?: string): Promise<Suggestion> {
    const order = await this.orders.findOne({ where: { id: orderId } });
    const base: Suggestion = {
      category,
      rule: 'MANUAL_REVIEW',
      action: 'REVIEW',
      lines: [],
      totalAmount: 0,
      refundableRemaining: 0,
      evidenceNeeded: [],
      warnings: [],
      reliabilityImpact: false,
      autoEligible: false,
      summary: 'No automatic rule for this category; review manually.',
    };
    if (!order) return { ...base, action: 'NONE', summary: 'No order linked to this ticket.' };
    const already = await this.refundedSoFar(order.id);
    const remaining = round2(Math.max(0, Number(order.total) - already));
    base.refundableRemaining = remaining;
    if (already > 0) base.warnings.push(`$${already.toFixed(2)} already refunded/credited on this order`);
    const cap = (n: number) => round2(Math.min(n, remaining));
    const done = order.status === OrderStatus.DELIVERED || order.status === OrderStatus.COLLECTED;

    switch (category) {
      case TicketCategory.MISSING_ITEM:
      case TicketCategory.WRONG_ITEM: {
        const all = await this.items.find({ where: { orderId: order.id } });
        const affected = itemIds.length ? all.filter((i) => itemIds.includes(i.id)) : [];
        if (!affected.length) {
          return { ...base, rule: 'MISSING_WRONG_ITEM', evidenceNeeded: ['Photo', 'Order ticket'], warnings: [...base.warnings, 'No affected items selected - choose items to price the refund'], summary: 'Missing/wrong item -> item refund or credit, charged to the restaurant. Select the affected items.' };
        }
        const amount = cap(affected.reduce((s, i) => s + Number(i.lineTotal) + Number(i.taxAmount), 0));
        const label = category === TicketCategory.MISSING_ITEM ? 'MISSING_ITEM' : 'WRONG_ITEM';
        return {
          ...base,
          rule: 'MISSING_WRONG_ITEM',
          action: 'ITEM_REFUND',
          lines: amount > 0 ? [{ type: RefundType.CREDIT, amount, chargedTo: 'RESTAURANT', reasonCode: label, note: `${label}: ${affected.map((i) => `${i.quantity}x ${i.name}`).join(', ')}` }] : [],
          totalAmount: amount,
          evidenceNeeded: category === TicketCategory.WRONG_ITEM ? ['Photo of what was received'] : ['Order ticket'],
          autoEligible: done && amount > 0,
          summary: 'Item refund or credit for the affected items (incl. tax), charged to the restaurant.',
        };
      }
      case TicketCategory.NEVER_ARRIVED: {
        const gps = await this.gpsEvidence(order);
        const photo = !!order.proofPhotoUrl;
        const confirms = gps.confirmsDelivery === true || (photo && done);
        const priorDriverClaims = order.driverId
          ? await this.tickets
              .createQueryBuilder('t')
              .where('t.driverId = :d AND t.category = :c AND t."createdAt" >= :since', { d: order.driverId, c: TicketCategory.NEVER_ARRIVED, since: new Date(Date.now() - 60 * 86400_000) })
              .andWhere(excludeTicketId ? 't.id <> :ex' : '1=1', { ex: excludeTicketId })
              .getCount()
          : 0;
        if (confirms) {
          return {
            ...base,
            rule: 'NEVER_ARRIVED',
            action: 'EVIDENCE_CONTRADICTS',
            evidenceNeeded: ['Driver GPS trail', 'Delivery photo'],
            warnings: [...base.warnings, gps.confirmsDelivery ? `GPS shows the driver ${Math.round((gps.minDistanceKm ?? 0) * 1000)} m from the drop-off pin` : 'Delivery photo exists', 'Do not refund automatically; review with the customer first'],
            summary: 'Evidence (GPS / delivery photo) indicates the order was delivered. Agent review required.',
          };
        }
        const chargedTo: ChargedTo = priorDriverClaims >= 1 ? 'DRIVER' : 'PLATFORM';
        const amount = cap(Number(order.total));
        return {
          ...base,
          rule: 'NEVER_ARRIVED',
          action: 'FULL_REFUND',
          lines: amount > 0 ? [{ type: RefundType.REFUND, amount, chargedTo, reasonCode: 'NEVER_ARRIVED', note: chargedTo === 'DRIVER' ? 'Repeat never-arrived claims for this driver' : 'GPS and delivery photo do not confirm delivery' }] : [],
          totalAmount: amount,
          evidenceNeeded: ['Driver GPS trail', 'Delivery photo'],
          warnings: [...base.warnings, ...(priorDriverClaims ? [`Driver has ${priorDriverClaims} other never-arrived ticket(s) in 60 days`] : []), ...(gps.points === 0 ? ['No GPS points recorded for this trip'] : [])],
          // never auto-refund an order that is still in progress, was cancelled/rejected, is a pickup order or was not paid: those go to an agent
          autoEligible: amount > 0 && done && order.type === OrderType.DELIVERY && order.paymentStatus === PaymentStatus.CAPTURED,
          summary: `GPS/photo do not confirm delivery -> full refund charged to ${chargedTo.toLowerCase()}.`,
        };
      }
      case TicketCategory.VERY_LATE: {
        const threshold = this.settings.get<number>('support.veryLateMinutes', 30);
        const summary = await this.summaryFor(order);
        const late = summary.order.minutesLate;
        if (late < threshold || order.status === OrderStatus.CANCELLED || order.status === OrderStatus.REJECTED) {
          return { ...base, rule: 'VERY_LATE', action: 'NOT_ELIGIBLE', evidenceNeeded: ['Timestamps'], warnings: [...base.warnings, `Order was ${late} min past ETA (threshold ${threshold})`], summary: `Not very late (needs > ${threshold} min past ETA).` };
        }
        const feeRefund = cap(Number(order.deliveryFee));
        const credit = round2(Math.min(this.settings.get<number>('support.lateCreditAmount', 5), Math.max(0, remaining - feeRefund)));
        const lines: SuggestedLine[] = [];
        if (feeRefund > 0) lines.push({ type: RefundType.REFUND, amount: feeRefund, chargedTo: 'PLATFORM', reasonCode: 'LATE', note: `Delivery fee refund - ${late} min past ETA` });
        if (credit > 0) lines.push({ type: RefundType.CREDIT, amount: credit, chargedTo: 'PLATFORM', reasonCode: 'LATE', note: `Late-order credit - ${late} min past ETA` });
        return {
          ...base,
          rule: 'VERY_LATE',
          action: 'DELIVERY_FEE_REFUND_AND_CREDIT',
          lines,
          totalAmount: round2(feeRefund + credit),
          evidenceNeeded: ['Timestamps'],
          autoEligible: lines.length > 0,
          summary: `${late} min past ETA -> delivery fee refund + credit, charged to the platform.`,
        };
      }
      case TicketCategory.FOOD_QUALITY: {
        const all = await this.items.find({ where: { orderId: order.id } });
        const affected = itemIds.length ? all.filter((i) => itemIds.includes(i.id)) : all;
        const basis = affected.reduce((s, i) => s + Number(i.lineTotal), 0);
        const amount = cap(Math.min(round2(basis * 0.5), 20));
        return {
          ...base,
          rule: 'FOOD_QUALITY',
          action: 'PARTIAL_CREDIT',
          lines: amount > 0 ? [{ type: RefundType.CREDIT, amount, chargedTo: 'RESTAURANT', reasonCode: 'QUALITY', note: 'Food quality - partial credit (50% of affected items, max $20)' }] : [],
          totalAmount: amount,
          evidenceNeeded: ['Photo', 'Rating'],
          warnings: [...base.warnings, 'Case is reviewed: check photo and the customer rating before approving'],
          autoEligible: done && amount > 0,
          summary: 'Partial credit charged to the restaurant; case reviewed.',
        };
      }
      case TicketCategory.RESTAURANT_CANCELLED: {
        const afterAccept = !!order.acceptedAt && order.status === OrderStatus.CANCELLED && order.cancelledBy === 'RESTAURANT';
        if (!afterAccept) {
          return { ...base, rule: 'RESTAURANT_CANCELLED', action: 'NOT_ELIGIBLE', evidenceNeeded: ['Timestamps'], warnings: [...base.warnings, 'Order was not cancelled by the restaurant after it was accepted'], summary: 'Restaurant did not cancel this order after accepting it.' };
        }
        const amount = cap(Number(order.total));
        return {
          ...base,
          rule: 'RESTAURANT_CANCELLED',
          action: 'FULL_REFUND',
          lines: amount > 0 ? [{ type: RefundType.REFUND, amount, chargedTo: 'RESTAURANT', reasonCode: 'RESTAURANT_CANCELLED', note: 'Restaurant cancelled after accepting' }] : [],
          totalAmount: amount,
          evidenceNeeded: ['Timestamps'],
          reliabilityImpact: true,
          autoEligible: amount > 0,
          summary: 'Full refund charged to the restaurant (counts against its reliability score).',
        };
      }
      default:
        return base;
    }
  }

  chargedToEnum(c: ChargedTo): RefundChargedTo {
    return c as RefundChargedTo;
  }

  async usersByIds(ids: string[]) {
    if (!ids.length) return new Map<string, User>();
    const rows = await this.users.find({ where: { id: In(ids) } });
    return new Map(rows.map((u) => [u.id, u]));
  }
}
