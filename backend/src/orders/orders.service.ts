import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { ModuleRef } from '@nestjs/core';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CustomerProfile, DriverProfile, Order, OrderEvent, OrderItem, Restaurant } from '../database/entities';
import { ActorType, DropoffMethod, FulfilmentMode, LedgerType, OrderStatus, OrderType, PaymentMethod, PaymentStatus, PartyType, RefundChargedTo, RefundType } from '../common/enums';
import {
  ActorRef,
  Events,
  IOrdersService,
  IPromotionsService,
  PlaceOrderInput,
  TransitionOpts,
} from '../common/contracts';
import { CodesService } from '../core/core.module';
import { SettingsService } from '../settings/settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RealtimeService } from '../realtime/realtime.module';
import { AuditService } from '../audit/audit.service';
import { PaymentsService } from './payments.service';
import { LedgerService } from './ledger.service';
import { WalletService } from './wallet.service';
import { RefundsService } from './refunds.service';
import { PricingService } from './pricing.service';
import { lazyProvider, round2 } from './pricing.math';
import { ProofService } from './proof.service';
import { cleanAccessCode, cleanNotes, maskCode, methodFromLegacy, openCode, sealCode } from './delivery-instructions';

/** Which statuses a transition may originate from. Missing `to` key = no direct transition allowed. */
const ALLOWED: Partial<Record<OrderStatus, OrderStatus[]>> = {
  [OrderStatus.PLACED]: [OrderStatus.ACCEPTED, OrderStatus.REJECTED, OrderStatus.CANCELLED],
  [OrderStatus.ACCEPTED]: [OrderStatus.DRIVER_ASSIGNED, OrderStatus.PREPARING, OrderStatus.CANCELLED],
  [OrderStatus.DRIVER_ASSIGNED]: [OrderStatus.PREPARING, OrderStatus.CANCELLED],
  [OrderStatus.PREPARING]: [OrderStatus.READY, OrderStatus.DRIVER_ASSIGNED, OrderStatus.CANCELLED],
  [OrderStatus.READY]: [OrderStatus.PICKED_UP, OrderStatus.COLLECTED, OrderStatus.CANCELLED],
  [OrderStatus.PICKED_UP]: [OrderStatus.ON_THE_WAY, OrderStatus.DELIVERED, OrderStatus.CANCELLED],
  [OrderStatus.ON_THE_WAY]: [OrderStatus.DELIVERED, OrderStatus.CANCELLED],
};

const END_STATUSES = new Set([OrderStatus.DELIVERED, OrderStatus.COLLECTED, OrderStatus.CANCELLED, OrderStatus.REJECTED]);

const TIMESTAMP_FIELD: Partial<Record<OrderStatus, keyof Order>> = {
  [OrderStatus.ACCEPTED]: 'acceptedAt',
  [OrderStatus.DRIVER_ASSIGNED]: 'driverAssignedAt',
  [OrderStatus.PREPARING]: 'preparingAt',
  [OrderStatus.READY]: 'readyAt',
  [OrderStatus.PICKED_UP]: 'pickedUpAt',
  [OrderStatus.ON_THE_WAY]: 'onTheWayAt',
  [OrderStatus.DELIVERED]: 'deliveredAt',
  [OrderStatus.COLLECTED]: 'deliveredAt',
  [OrderStatus.CANCELLED]: 'cancelledAt',
  [OrderStatus.REJECTED]: 'cancelledAt',
};

/** event name (see notifications.service.ts DEFAULT_MESSAGES) for each status, when we should tell the customer. */
const CUSTOMER_EVENT: Partial<Record<OrderStatus, string>> = {
  [OrderStatus.ACCEPTED]: 'order.accepted',
  [OrderStatus.REJECTED]: 'order.rejected',
  [OrderStatus.READY]: 'order.ready',
  [OrderStatus.PICKED_UP]: 'order.picked_up',
  [OrderStatus.DELIVERED]: 'order.delivered',
  [OrderStatus.COLLECTED]: 'order.delivered',
  [OrderStatus.CANCELLED]: 'order.cancelled',
};

/**
 * Single entry point for the whole order lifecycle (spec section 7). Every status change goes
 * through `transition()`, which validates the move, stamps timing fields, writes the immutable
 * OrderEvent timeline, pushes realtime + notifications, and (on delivery) triggers payment
 * capture + ledger settlement. Simplifications are called out inline where the full spec nuance
 * was traded for shipping a correct, working core within scope.
 */
/** Constant-time comparison; undefined / empty input never matches. */
function codeMatches(given: string | undefined | null, expected: string): boolean {
  if (typeof given !== 'string' || !given.length || given.length > 32) return false;
  const a = Buffer.from(given.trim());
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

@Injectable()
export class OrdersService implements IOrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    @InjectDataSource() private ds: DataSource,
    @InjectRepository(Order) private orders: Repository<Order>,
    @InjectRepository(OrderItem) private items: Repository<OrderItem>,
    @InjectRepository(OrderEvent) private events: Repository<OrderEvent>,
    @InjectRepository(Restaurant) private restaurants: Repository<Restaurant>,
    @InjectRepository(DriverProfile) private drivers: Repository<DriverProfile>,
    @InjectRepository(CustomerProfile) private customerProfiles: Repository<CustomerProfile>,
    private moduleRef: ModuleRef,
    private pricing: PricingService,
    private payments: PaymentsService,
    private ledger: LedgerService,
    private wallet: WalletService,
    private refunds: RefundsService,
    private codes: CodesService,
    private settings: SettingsService,
    private notifications: NotificationsService,
    private realtime: RealtimeService,
    private audit: AuditService,
    private emitter: EventEmitter2,
    private proof: ProofService,
  ) {}

  private promotions(): IPromotionsService | null {
    return lazyProvider<IPromotionsService>(this.moduleRef, '../marketing/promotions.service', 'PromotionsService');
  }

  // ---------------------------------------------------------------------- create

  async placeOrder(customerId: string, input: PlaceOrderInput): Promise<Order> {
    const quote = await this.pricing.quote(input);
    const restaurant = await this.restaurants.findOne({ where: { id: input.restaurantId } });
    if (!restaurant) throw new NotFoundException('Restaurant not found');

    const code = await this.codes.orderCode();
    const dropoffMethod = methodFromLegacy(input.contactless, input.dropoffMethod);
    if (!Object.values(DropoffMethod).includes(dropoffMethod)) throw new BadRequestException('Unknown delivery method');
    const usePin = input.usePin !== false;
    const requiresPin = this.proof.shouldHavePin(dropoffMethod, quote.total, quote.fulfilment, usePin);
    const autoRejectSec = restaurant.autoRejectSeconds || this.settings.get<number>('orders.autoRejectSeconds', 180);

    const itemRows = quote.lines.map((l) =>
        this.items.create({
          menuItemId: l.menuItemId,
          name: l.name,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          lineTotal: l.lineTotal,
          taxAmount: l.taxAmount,
          taxClassCode: l.taxClassCode,
          modifiers: l.modifiers,
          notes: l.notes ?? null,
          stationId: l.stationId ?? null,
          allergens: l.allergens ?? [],
        }),
    );
    let order = this.orders.create({
      code,
      customerId,
      restaurantId: restaurant.id,
      zoneId: quote.zoneId,
      cityId: quote.cityId,
      type: quote.type,
      fulfilment: quote.fulfilment,
      status: OrderStatus.PLACED,
      deliveryAddress: quote.fulfilment === FulfilmentMode.PICKUP ? null : { ...input.deliveryAddress!, label: input.deliveryAddress?.label },
      isScheduled: !!input.scheduledFor,
      scheduledFor: input.scheduledFor ?? null,
      prepTimeMin: quote.prepTimeMin,
      estimatedReadyAt: new Date(Date.now() + quote.prepTimeMin * 60_000),
      estimatedDeliveryAt: quote.etaMinutes ? new Date(Date.now() + quote.etaMinutes * 60_000) : null,
      acceptDeadlineAt: new Date(Date.now() + autoRejectSec * 1000),
      subtotal: quote.subtotal,
      deliveryFee: quote.deliveryFee,
      serviceFee: quote.serviceFee,
      smallOrderFee: quote.smallOrderFee,
      taxAmount: quote.taxAmount,
      tip: quote.tip,
      discountTotal: quote.discountTotal,
      platformPromoAmount: quote.platformPromoAmount,
      restaurantPromoAmount: quote.restaurantPromoAmount,
      walletUsed: quote.walletUsed,
      total: quote.total,
      promotionId: quote.promotion?.id ?? null,
      promoCode: quote.promotion?.code ?? null,
      commissionPct: quote.commissionPct,
      commissionAmount: quote.commissionAmount,
      restaurantPayout: quote.restaurantPayout,
      distanceKm: quote.distanceKm,
      paymentMethod: input.paymentMethod,
      paymentStatus: PaymentStatus.PENDING,
      pickupCode: quote.fulfilment === FulfilmentMode.OWN_DRIVER ? null : this.codes.pin(4),
      deliveryPin: requiresPin ? this.codes.pin(4) : null,
      requiresPin,
      usePin,
      contactless: dropoffMethod === DropoffMethod.LEAVE_AT_DOOR,
      dropoffMethod,
      dropoffNotes: quote.fulfilment === FulfilmentMode.PICKUP ? null : cleanNotes(input.dropoffNotes),
      accessCode: quote.fulfilment === FulfilmentMode.PICKUP ? null : sealCode(cleanAccessCode(input.accessCode)),
      customerNotes: input.customerNotes?.slice(0, 1000) ?? null,
      hasAllergyFlag: quote.lines.some((l) => l.allergens?.length > 0),
      cancellationFee: 0,
      source: input.source ?? 'app',
      meta: {},
    });
    order = await this.orders.save(order);
    await this.items.save(itemRows.map((i) => Object.assign(i, { orderId: order.id })));

    // Reserve the promo FIRST (atomic: usage limit / budget / per-user limit are enforced inside the redemption). If it is gone, the order is abandoned.
    const promoSvc = quote.promotion ? this.promotions() : null;
    if (quote.promotion && promoSvc) {
      try {
        await promoSvc.redeem(quote.promotion.id, customerId, order.id, quote.discountTotal);
      } catch (e) {
        await this.orders.delete(order.id);
        throw e instanceof BadRequestException ? e : new BadRequestException('This promo code is no longer available. Please remove it and try again.');
      }
    }

    // payment method policy: cash only when enabled; wallet / gift-card payments must fully cover the total
    const cardAmount = round2(quote.total - quote.walletUsed);
    if (input.paymentMethod === PaymentMethod.CASH && !this.settings.get<boolean>('orders.acceptCashPayments', false)) {
      await this.orders.delete(order.id);
      await promoSvc?.unredeem(order.id).catch(() => undefined);
      throw new BadRequestException('Cash payments are not available');
    }
    if ((input.paymentMethod === PaymentMethod.WALLET || input.paymentMethod === PaymentMethod.GIFT_CARD) && cardAmount > 0.009) {
      await this.orders.delete(order.id);
      await promoSvc?.unredeem(order.id).catch(() => undefined);
      throw new BadRequestException('Your wallet balance does not cover this order');
    }
    // authorize the card amount (total minus any wallet applied); only debit the wallet once the hold succeeds.
    try {
      const auth = cardAmount > 0.009 && input.paymentMethod !== PaymentMethod.CASH ? await this.payments.authorize(order, { paymentToken: input.paymentToken, amount: cardAmount, customerEmail: null }) : { ok: true as const, intentId: undefined };
      if (!auth.ok) throw new BadRequestException((auth as any).error || 'Payment authorization failed');
      order.paymentIntentId = auth.intentId ?? null;
      order.paymentStatus = PaymentStatus.AUTHORIZED;
      if (quote.walletUsed > 0) await this.wallet.debit(customerId, quote.walletUsed, 'PURCHASE', { orderId: order.id, note: `Order ${order.code}` });
      order = await this.orders.save(order);
    } catch (e) {
      await promoSvc?.unredeem(order.id).catch(() => undefined);
      await this.orders.delete(order.id);
      throw e;
    }

    await this.customerProfiles.increment({ userId: customerId }, 'totalOrders', 1);
    await this.customerProfiles.update({ userId: customerId }, { lastOrderAt: new Date() } as any);

    await this.addEvent(order.id, 'STATUS_CHANGE', { type: ActorType.CUSTOMER, id: customerId }, undefined, { to: OrderStatus.PLACED });
    this.realtime.emitToRestaurant(restaurant.id, 'order.new', { orderId: order.id, code: order.code });
    this.realtime.emitToOps('order.new', { orderId: order.id, code: order.code, restaurantId: restaurant.id });
    await this.notifications.notifyRestaurant(restaurant.id, 'order.placed', { code: order.code });
    this.emitter.emit(Events.ORDER_PLACED, { order });

    return this.getById(order.id);
  }

  // ---------------------------------------------------------------------- reads

  async getById(id: string, relations: string[] = ['items']): Promise<Order> {
    const order = await this.orders.findOne({ where: { id }, relations });
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  private async getByCode(code: string): Promise<Order> {
    const order = await this.orders.findOne({ where: { code }, relations: ['items'] });
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  // ---------------------------------------------------------------------- transition

  async transition(orderId: string, to: OrderStatus, actor: ActorRef, opts: TransitionOpts = {}): Promise<Order> {
    const order = await this.getById(orderId);
    const from = order.status;
    if (from === to) return order;
    if (END_STATUSES.has(from)) throw new BadRequestException(`Order ${order.code} has already ended (${from})`);
    if (!opts.force && !(ALLOWED[from] ?? []).includes(to)) {
      throw new BadRequestException(`Cannot move order ${order.code} from ${from} to ${to}`);
    }

    // ---- proof-of-handover checks come BEFORE anything is changed. A missing / empty code is a failure, never a pass.
    const isDriver = actor.type === ActorType.DRIVER;
    const staffOverride = actor.type === ActorType.STAFF && !!(actor as any).supportApproved;
    if (to === OrderStatus.PICKED_UP && order.pickupCode && !staffOverride) {
      if (!codeMatches(opts.code, order.pickupCode)) throw new ForbiddenException('Pickup code does not match');
    }
    if (to === OrderStatus.COLLECTED && order.pickupCode && isDriver) {
      if (!codeMatches(opts.code, order.pickupCode)) throw new ForbiddenException('Pickup code does not match');
    }
    if (to === OrderStatus.DELIVERED && order.requiresPin && order.deliveryPin && !staffOverride && !opts.proof) {
      if (!codeMatches(opts.code, order.deliveryPin)) throw new ForbiddenException('Delivery PIN is required and must match');
    }

    // ---- atomic claim: of N concurrent requests for this transition exactly one proceeds (double cancel / double settle protection)
    const claim = await this.orders.createQueryBuilder().update(Order).set({ status: to }).where('id = :id AND status = :from', { id: orderId, from }).execute();
    if (!claim.affected) throw new ConflictException('This order was just updated by someone else. Refresh and try again.');
    try {
      return await this.applyTransition(order, from, to, actor, opts);
    } catch (e) {
      // side effects failed: put the status back so the order is not left half-transitioned
      await this.orders.createQueryBuilder().update(Order).set({ status: from }).where('id = :id AND status = :to', { id: orderId, to }).execute();
      throw e;
    }
  }

  private async applyTransition(order: Order, from: OrderStatus, to: OrderStatus, actor: ActorRef, opts: TransitionOpts): Promise<Order> {
    const field = TIMESTAMP_FIELD[to];
    if (field && !order[field]) (order as any)[field] = new Date();

    if (to === OrderStatus.ACCEPTED) {
      order.prepTimeMin = opts.prepTimeMin ?? order.prepTimeMin;
      order.estimatedReadyAt = new Date(Date.now() + (order.prepTimeMin ?? 20) * 60_000);
    }
    if (to === OrderStatus.REJECTED) {
      order.rejectReason = opts.reason ?? null;
      order.cancelledBy = actor.type;
      await this.payments.release(order);
      order.paymentStatus = PaymentStatus.RELEASED;
      if (order.walletUsed > 0) await this.wallet.credit(order.customerId, order.walletUsed, 'ADJUSTMENT', { orderId: order.id, note: 'Order rejected - wallet portion returned' });
    }
    if (to === OrderStatus.CANCELLED) {
      order.cancelReason = opts.reason ?? null;
      order.cancelledBy = actor.type;
      await this.applyCancellationMoney(order, actor);
    }
    if (to === OrderStatus.DRIVER_ASSIGNED && order.driverId) {
      await this.drivers.update(order.driverId, { onTrip: true });
    }
    if (to === OrderStatus.COLLECTED) {
      await this.settleDelivered(order);
    }
    if (to === OrderStatus.DELIVERED) {
      // evidence first: if it cannot be stored the transition fails and the status is rolled back
      if (opts.proof) await this.proof.persist(order, opts.proof);
      else await this.proof.recordForced(order, actor.id);
      await this.settleDelivered(order);
      if (order.driverId) await this.drivers.update(order.driverId, { onTrip: false });
    }

    order.status = to;
    await this.orders.save(order);
    // an assigned driver must not stay stuck "on trip" when the order is cancelled / rejected (unless they still hold another active order)
    if ((to === OrderStatus.CANCELLED || to === OrderStatus.REJECTED) && order.driverId) {
      const others = await this.orders
        .createQueryBuilder('o')
        .where('o.driverId = :d AND o.id != :id AND o.status IN (:...st)', { d: order.driverId, id: order.id, st: [OrderStatus.DRIVER_ASSIGNED, OrderStatus.PREPARING, OrderStatus.READY, OrderStatus.PICKED_UP, OrderStatus.ON_THE_WAY] })
        .getCount();
      if (!others) await this.drivers.update(order.driverId, { onTrip: false });
    }

    await this.addEvent(order.id, 'STATUS_CHANGE', actor, opts.note ?? opts.reason, { from, to });
    this.realtime.emitToOrder(order.id, 'order.status', { orderId: order.id, status: to });
    this.realtime.emitToRestaurant(order.restaurantId, 'order.status', { orderId: order.id, status: to });
    if (order.driverId) this.realtime.emitToDriver(order.driverId, 'order.status', { orderId: order.id, status: to });

    const evt = CUSTOMER_EVENT[to];
    if (evt) {
      await this.notifications.notify({
        userId: order.customerId,
        audience: 'CUSTOMER',
        event: evt,
        vars: { code: order.code, restaurant: undefined, prepMinutes: order.prepTimeMin, reason: opts.reason, driverName: undefined },
      });
    }

    this.emitter.emit(Events.ORDER_STATUS_CHANGED, { order, from, to, actor });
    if (to === OrderStatus.DELIVERED || to === OrderStatus.COLLECTED) this.emitter.emit(Events.ORDER_DELIVERED, { order, from, to, actor });
    if (to === OrderStatus.CANCELLED || to === OrderStatus.REJECTED) this.emitter.emit(Events.ORDER_CANCELLED, { order, from, to, actor });

    return this.getById(order.id);
  }

  private async settleDelivered(order: Order) {
    if (order.paymentStatus !== PaymentStatus.CAPTURED) {
      await this.payments.capture(order);
      order.paymentStatus = PaymentStatus.CAPTURED;
    }
    await this.ledger.settleOrder(order);
  }

  /** Reject / cancel: release the auth hold, or capture a cancellation fee, per section 7 rules. */
  private async applyCancellationMoney(order: Order, actor: ActorRef) {
    if (order.paymentStatus === PaymentStatus.CAPTURED) return; // already settled elsewhere; nothing to release

    const freeUntil = this.settings.get<string>('orders.freeCancelUntil', 'ACCEPTED');
    const isStaffOrRestaurant = actor.type === ActorType.STAFF || actor.type === ActorType.RESTAURANT;
    const restaurantLate = order.acceptDeadlineAt ? false : order.estimatedReadyAt != null && Date.now() > order.estimatedReadyAt.getTime();

    const freeCancel = order.status === OrderStatus.PLACED || isStaffOrRestaurant || restaurantLate || (freeUntil === order.status);

    if (freeCancel) {
      await this.payments.release(order);
      order.paymentStatus = PaymentStatus.RELEASED;
      if (order.walletUsed > 0) await this.wallet.credit(order.customerId, order.walletUsed, 'ADJUSTMENT', { orderId: order.id, note: 'Order cancelled - wallet portion returned' });
      if (actor.type === ActorType.RESTAURANT && order.status !== OrderStatus.PLACED) {
        // restaurant cancelling after accept counts against its reliability score (section 9.3)
        const penalty = this.settings.get<number>('orders.reliabilityPenaltyPerCancel', 5);
        await this.restaurants.decrement({ id: order.restaurantId }, 'reliabilityScore', penalty);
      }
      return;
    }

    // Customer-initiated cancellation after acceptance, restaurant on time: forfeit the food cost (capped),
    // refund fees + tip. We never actually captured the hold, so "keeping" the fee means capturing just that
    // slice of it; the remainder of the hold is released.
    const capPct = this.settings.get<number>('orders.cancellationFeeMaxPctOfFood', 100);
    const fee = round2(Math.min(Number(order.subtotal) * (capPct / 100), Number(order.total)));
    order.cancellationFee = fee;
    if (fee > 0) {
      await this.payments.capture(order, fee);
      await this.ledger.add({ partyType: PartyType.PLATFORM, partyId: null, orderId: order.id, type: LedgerType.ADJUSTMENT, amount: fee, description: `Late-cancellation fee on ${order.code}` });
    }
    await this.payments.release(order);
    order.paymentStatus = fee > 0 ? PaymentStatus.PARTIALLY_REFUNDED : PaymentStatus.RELEASED;
    if (order.walletUsed > 0) await this.wallet.credit(order.customerId, order.walletUsed, 'ADJUSTMENT', { orderId: order.id, note: 'Order cancelled - wallet portion returned' });
  }

  async cancel(orderId: string, actor: ActorRef, reason: string): Promise<Order> {
    const order = await this.getById(orderId);
    if (order.status !== OrderStatus.PLACED && order.status !== OrderStatus.ACCEPTED && actor.type !== ActorType.STAFF) {
      throw new ForbiddenException('This order can no longer be cancelled from the app - contact support');
    }
    if ((order.status === OrderStatus.PICKED_UP || order.status === OrderStatus.ON_THE_WAY) && actor.type === ActorType.STAFF && !actor.supportApproved) {
      throw new ForbiddenException('Cancelling after pickup needs support approval');
    }
    return this.transition(orderId, OrderStatus.CANCELLED, actor, { reason });
  }

  // ---------------------------------------------------------------------- partial fulfilment

  async removeItem(orderId: string, orderItemId: string, actor: ActorRef, reason: string): Promise<Order> {
    const order = await this.getById(orderId);
    const item = order.items.find((i) => i.id === orderItemId);
    if (!item) throw new NotFoundException('Order item not found');
    if (item.removed) return order;

    item.removed = true;
    item.removedReason = reason;
    await this.items.save(item);

    const amount = round2(Number(item.lineTotal) + Number(item.taxAmount));
    order.meta = { ...order.meta, pendingItemRemoval: { orderItemId, amount, reason, requestedAt: new Date().toISOString() } };
    await this.orders.save(order);

    await this.addEvent(order.id, 'PARTIAL_FULFILMENT', actor, reason, { orderItemId, amount });
    this.realtime.emitToOrder(order.id, 'order.item_removed', { orderId: order.id, orderItemId, amount });
    await this.notifications.notify({ userId: order.customerId, audience: 'CUSTOMER', event: 'order.item_removed', vars: { restaurant: undefined, item: item.name, code: order.code, amount: `$${amount.toFixed(2)}` } });
    return this.getById(order.id);
  }

  async respondToItemRemoval(orderId: string, customerId: string, approve: boolean): Promise<Order> {
    const order = await this.getById(orderId);
    if (order.customerId !== customerId) throw new ForbiddenException('Not your order');
    const pending = order.meta?.pendingItemRemoval;
    if (!pending) throw new BadRequestException('No pending item change on this order');

    if (approve) {
      await this.refunds.issue({
        orderId: order.id,
        amount: pending.amount,
        type: RefundType.REFUND,
        chargedTo: RefundChargedTo.RESTAURANT,
        reasonCode: 'MISSING_ITEM',
        notes: pending.reason,
        actor: { type: ActorType.SYSTEM, staff: false },
        auto: true,
      });
      order.meta = { ...order.meta, pendingItemRemoval: null };
      await this.orders.save(order);
      return this.getById(order.id);
    }
    order.meta = { ...order.meta, pendingItemRemoval: null };
    await this.orders.save(order);
    return this.cancel(orderId, { type: ActorType.CUSTOMER, id: customerId }, 'Declined item substitution');
  }

  // ---------------------------------------------------------------------- misc

  async addEvent(orderId: string, type: string, actor: ActorRef, note?: string, data?: Record<string, any>): Promise<void> {
    await this.events.insert({
      orderId,
      type,
      fromStatus: data?.from ?? null,
      toStatus: data?.to ?? null,
      actorType: actor.type,
      actorId: actor.id ?? null,
      note: note ?? null,
      data: data ?? null,
    });
  }

  async setEta(orderId: string, estimatedReadyAt?: Date | null, estimatedDeliveryAt?: Date | null): Promise<void> {
    const patch: Partial<Order> = {};
    if (estimatedReadyAt !== undefined) patch.estimatedReadyAt = estimatedReadyAt;
    if (estimatedDeliveryAt !== undefined) patch.estimatedDeliveryAt = estimatedDeliveryAt;
    await this.orders.update(orderId, patch);
    this.realtime.emitToOrder(orderId, 'order.eta', { orderId, estimatedReadyAt, estimatedDeliveryAt });
  }

  async updateTip(orderId: string, customerId: string, tip: number): Promise<Order> {
    const order = await this.getById(orderId);
    if (order.customerId !== customerId) throw new ForbiddenException('Not your order');
    // tips can be changed while the order is live, or for N minutes after delivery - never on cancelled orders, never later
    if (order.status === OrderStatus.CANCELLED || order.status === OrderStatus.REJECTED) throw new BadRequestException('This order was cancelled');
    if (order.status === OrderStatus.DELIVERED || order.status === OrderStatus.COLLECTED) {
      const minutes = this.settings.get<number>('orders.tipEditableMinutes', 60);
      const deadline = new Date((order.deliveredAt ?? order.updatedAt).getTime() + minutes * 60_000);
      if (Date.now() > deadline.getTime()) throw new BadRequestException('The tip window for this order has closed');
      order.tipEditableUntil = deadline;
    }
    if (!Number.isFinite(tip)) throw new BadRequestException('Invalid tip');
    const maxTip = this.settings.get<number>('orders.maxTip', 200);
    const newTip = Math.min(Math.max(round2(tip), 0), maxTip);
    const delta = round2(newTip - Number(order.tip));
    if (delta !== 0) {
      await this.payments.adjustTip(order, newTip);
      if ((order.status === OrderStatus.DELIVERED || order.status === OrderStatus.COLLECTED) && order.driverId) {
        await this.ledger.add({ partyType: PartyType.DRIVER, partyId: order.driverId, orderId: order.id, type: LedgerType.TIP, amount: delta, description: `Tip adjustment on ${order.code}` });
      }
    }
    order.tip = newTip;
    await this.orders.save(order);
    if (order.driverId) {
      await this.notifications.notify({ userId: order.driverId, audience: 'DRIVER', event: 'order.tip_updated', vars: { code: order.code, tip: `$${newTip.toFixed(2)}` } });
    }
    return order;
  }

  // ---------------------------------------------------------------------- driver assignment

  /**
   * Assign a driver. Before the food is ready (ACCEPTED/PREPARING) this moves the order to DRIVER_ASSIGNED (legacy flow).
   * When the order is already READY (dispatch.startOn = READY) or later (admin manual (re)assign) the status is NOT moved
   * backwards: the driver is recorded on the order, the timeline gets a DRIVER_ASSIGNED event and everyone is notified.
   */
  async assignDriver(orderId: string, driverId: string, actor: ActorRef, opts: { boost?: number } = {}): Promise<Order> {
    const order = await this.getById(orderId);
    if (order.fulfilment === FulfilmentMode.PICKUP) throw new BadRequestException('Pickup orders do not need a driver');
    if (END_STATUSES.has(order.status)) throw new BadRequestException(`Order ${order.code} has already ended (${order.status})`);
    const prevStatus = order.status;
    order.driverId = driverId;
    if (opts.boost) order.driverBoost = round2(opts.boost);
    const driverPay = await this.pricing.driverPay({ cityId: order.cityId, zoneId: order.zoneId, pickupKm: Number(order.distanceKm ?? 0) / 2, dropKm: Number(order.distanceKm ?? 0) / 2, tip: Number(order.tip) });
    order.driverPay = driverPay.total;
    order.driverAssignedAt = new Date();
    await this.orders.save(order);
    await this.drivers.update(driverId, { onTrip: true });

    let updated: Order;
    if (prevStatus === OrderStatus.ACCEPTED || prevStatus === OrderStatus.PREPARING) {
      updated = await this.transition(orderId, OrderStatus.DRIVER_ASSIGNED, actor);
    } else {
      // READY / DRIVER_ASSIGNED / PICKED_UP / ON_THE_WAY: keep the status, just record the driver on the timeline
      await this.addEvent(order.id, 'DRIVER_ASSIGNED', actor, undefined, { status: prevStatus, driverId });
      this.realtime.emitToOrder(order.id, 'order.driver_assigned', { orderId: order.id, driverId, status: prevStatus });
      this.realtime.emitToRestaurant(order.restaurantId, 'order.driver_assigned', { orderId: order.id, driverId, status: prevStatus });
      updated = await this.getById(order.id);
    }
    this.realtime.emitToDriver(driverId, 'order.assigned', { orderId: order.id, code: order.code });
    this.realtime.emitToOps('order.driver_assigned', { orderId: order.id, code: order.code, driverId });

    const dp = await this.drivers.findOne({ where: { id: driverId }, relations: ['user'] }).catch(() => null);
    const driverName = `${dp?.user?.firstName ?? 'Your driver'} ${dp?.user?.lastName?.[0] ?? ''}`.trim();
    if (dp?.userId) await this.notifications.notify({ userId: dp.userId, audience: 'DRIVER', event: 'offer.accepted', vars: { code: order.code } }).catch(() => undefined);
    await this.notifications.notify({ userId: order.customerId, audience: 'CUSTOMER', event: 'driver.assigned', vars: { code: order.code, driverName, vehicle: dp?.vehicleType ?? 'vehicle' } }).catch(() => undefined);
    await this.notifications.notifyRestaurant(order.restaurantId, 'driver.assigned', { code: order.code, driverName, etaMinutes: 5 }).catch(() => undefined);
    return updated;
  }

  /** Remove the driver. DRIVER_ASSIGNED falls back to ACCEPTED; READY and later keep their status. `redispatch` restarts the driver search. */
  async unassignDriver(orderId: string, actor: ActorRef, reason: string, opts: { redispatch?: boolean } = {}): Promise<Order> {
    const order = await this.getById(orderId);
    if (!order.driverId) return order;
    const afterPickup = [OrderStatus.PICKED_UP, OrderStatus.ON_THE_WAY].includes(order.status);
    if (afterPickup && actor.type === ActorType.STAFF && !actor.supportApproved) {
      throw new ForbiddenException('Unassigning a driver after pickup needs support approval');
    }
    const oldDriverId = order.driverId;
    await this.drivers.update(oldDriverId, { onTrip: false });
    order.driverId = null;
    if (order.status === OrderStatus.DRIVER_ASSIGNED) order.status = OrderStatus.ACCEPTED;
    await this.orders.save(order);
    await this.addEvent(order.id, 'REASSIGN', actor, reason, { status: order.status, driverId: oldDriverId });
    this.realtime.emitToOrder(order.id, 'order.driver_unassigned', { orderId: order.id });
    this.realtime.emitToDriver(oldDriverId, 'order.unassigned', { orderId: order.id });
    if (opts.redispatch) this.emitter.emit(Events.DRIVER_UNASSIGNED, { orderId: order.id, driverId: oldDriverId });
    return this.getById(order.id);
  }

  async driverArrived(orderId: string, stage: 'RESTAURANT' | 'CUSTOMER', actor: ActorRef, opts: { lat?: number; lng?: number } = {}): Promise<Order> {
    const order = await this.getById(orderId);
    const field = stage === 'RESTAURANT' ? 'driverArrivedRestaurantAt' : 'driverArrivedCustomerAt';
    (order as any)[field] = new Date();
    await this.orders.save(order);
    await this.addEvent(order.id, `DRIVER_ARRIVED_${stage}`, actor, undefined, opts);
    this.realtime.emitToOrder(order.id, 'order.driver_arrived', { orderId: order.id, stage });
    if (stage === 'CUSTOMER') {
      // heads-up for the customer, worded for the method they chose
      const m = order.dropoffMethod;
      const pin = order.requiresPin ? order.deliveryPin : null;
      const body =
        m === DropoffMethod.LEAVE_AT_DOOR
          ? `Your driver has arrived with order ${order.code} and will leave it at your door.`
          : m === DropoffMethod.MEET_OUTSIDE
            ? `Your driver has arrived outside with order ${order.code}.${pin ? ` Tell them PIN ${pin}.` : ''}`
            : `Your driver has arrived with order ${order.code}.${pin ? ` Tell them PIN ${pin}.` : ''}`;
      await this.notifications.notify({ userId: order.customerId, audience: 'CUSTOMER', event: 'delivery.driver_arrived', title: 'Your driver has arrived', body, data: { orderId: order.id } }).catch(() => undefined);
    }
    return order;
  }

  // ---------------------------------------------------------------------- delivery instructions
  private static readonly BEFORE_PICKUP = [OrderStatus.PLACED, OrderStatus.ACCEPTED, OrderStatus.DRIVER_ASSIGNED, OrderStatus.PREPARING, OrderStatus.READY];

  /** Customer changes the handoff method / driver instructions / access code until the driver has picked the food up. */
  async updateDeliveryInstructions(orderId: string, customerId: string, patch: { dropoffMethod?: string; usePin?: boolean; dropoffNotes?: string | null; accessCode?: string | null }): Promise<Order> {
    const order = await this.getById(orderId, []);
    if (order.customerId !== customerId) throw new NotFoundException('Order not found');
    if (order.fulfilment === FulfilmentMode.PICKUP) throw new BadRequestException('Pickup orders have no delivery instructions');
    if (!OrdersService.BEFORE_PICKUP.includes(order.status)) throw new BadRequestException('Your driver already has the order - delivery instructions can no longer be changed. Use chat to reach your driver.');
    const set: Partial<Order> = {};
    const before = { method: order.dropoffMethod, requiresPin: order.requiresPin, usePin: order.usePin };
    let method = order.dropoffMethod;
    if (patch.dropoffMethod !== undefined) {
      if (!Object.values(DropoffMethod).includes(patch.dropoffMethod as DropoffMethod)) throw new BadRequestException('Unknown delivery method');
      method = patch.dropoffMethod as DropoffMethod;
      set.dropoffMethod = method;
      set.contactless = method === DropoffMethod.LEAVE_AT_DOOR;
    }
    if (patch.dropoffMethod !== undefined || patch.usePin !== undefined) {
      const usePin = patch.usePin ?? order.usePin;
      set.usePin = usePin;
      const needPin = this.proof.shouldHavePin(method, Number(order.total), order.fulfilment, usePin);
      set.requiresPin = needPin;
      if (needPin && !order.deliveryPin) set.deliveryPin = this.codes.pin(4);
    }
    if (patch.dropoffNotes !== undefined) set.dropoffNotes = cleanNotes(patch.dropoffNotes);
    if (patch.accessCode !== undefined) set.accessCode = sealCode(cleanAccessCode(patch.accessCode));
    if (!Object.keys(set).length) return order;
    await this.orders.update(orderId, set as any);
    const after = await this.getById(orderId, []);
    const rule = this.proof.requirementFor(after);
    await this.addEvent(orderId, 'DELIVERY_INSTRUCTIONS_CHANGED', { type: ActorType.CUSTOMER, id: customerId }, undefined, {
      methodFrom: before.method,
      methodTo: after.dropoffMethod,
      usePinFrom: before.usePin,
      usePinTo: after.usePin,
      notesChanged: patch.dropoffNotes !== undefined,
      accessCodeChanged: patch.accessCode !== undefined, // the code itself is never logged
      proof: rule.rule,
    });
    const payload = { orderId, code: after.code, dropoffMethod: after.dropoffMethod, usePin: after.usePin, dropoffNotes: after.dropoffNotes, proofRule: rule.rule, proofLabel: rule.label, accessCodeChanged: patch.accessCode !== undefined };
    if (after.driverId) {
      this.realtime.emitToDriver(after.driverId, 'order.instructions_changed', payload);
      const dp = await this.drivers.findOne({ where: { id: after.driverId } });
      if (dp?.userId) {
        await this.notifications
          .notify({ userId: dp.userId, audience: 'DRIVER', event: 'delivery.instructions_changed', title: `Delivery instructions updated - ${after.code}`, body: `The customer changed the handoff to "${after.dropoffMethod.replace(/_/g, ' ').toLowerCase()}" (${rule.label}).${after.dropoffNotes ? ' Note: ' + after.dropoffNotes : ''}`, data: { orderId } })
          .catch(() => undefined);
      }
    }
    this.realtime.emitToOrder(orderId, 'order.instructions_changed', { orderId, dropoffMethod: after.dropoffMethod, proofRule: rule.rule });
    return after;
  }

  /** The decrypted access code, or null. Callers decide who may see it. */
  async accessCodeOf(orderId: string): Promise<string | null> {
    const row = await this.orders.createQueryBuilder('o').select('o.accessCode', 'ac').where('o.id = :id', { id: orderId }).getRawOne();
    return openCode(row?.ac);
  }

  /** Staff "Reveal": only once the driver has the food, audit-logged by the caller. */
  async revealAccessCode(orderId: string): Promise<{ accessCode: string | null; purged: boolean }> {
    const order = await this.getById(orderId, []);
    if (!order.pickedUpAt && ![OrderStatus.PICKED_UP, OrderStatus.ON_THE_WAY, OrderStatus.DELIVERED].includes(order.status)) throw new ForbiddenException('The access code can only be revealed after the driver has picked up the order');
    return { accessCode: await this.accessCodeOf(orderId), purged: !!order.accessCodePurgedAt };
  }

  // ---------------------------------------------------------------------- tracking

  async trackingView(orderId: string, viewer?: 'CUSTOMER' | 'DRIVER' | 'RESTAURANT' | 'STAFF'): Promise<any> {
    const order = await this.orders.findOne({ where: { id: orderId }, relations: ['items', 'restaurant'] });
    if (!order) throw new NotFoundException('Order not found');
    const driver = order.driverId ? await this.drivers.findOne({ where: { id: order.driverId }, relations: ['user'] }) : null;
    const timeline = await this.events.find({ where: { orderId }, order: { createdAt: 'ASC' } });
    const full = viewer === 'STAFF' || !viewer;
    const active = [OrderStatus.PICKED_UP, OrderStatus.ON_THE_WAY].includes(order.status);
    const rule = this.proof.requirementFor(order);
    const accessCode = viewer === 'DRIVER' && active && order.driverId ? await this.accessCodeOf(orderId) : null;
    const hasCode = !!(await this.orders.createQueryBuilder('o').select('o.accessCode', 'ac').where('o.id = :id', { id: orderId }).getRawOne())?.ac;
    const proofRow = [OrderStatus.DELIVERED, OrderStatus.COLLECTED].includes(order.status) && order.fulfilment !== FulfilmentMode.PICKUP ? await this.proof.find(orderId) : null;
    const dropoff =
      viewer === 'RESTAURANT'
        ? { method: order.dropoffMethod, contactless: order.dropoffMethod === DropoffMethod.LEAVE_AT_DOOR }
        : {
            method: order.dropoffMethod,
            contactless: order.dropoffMethod === DropoffMethod.LEAVE_AT_DOOR,
            notes: viewer === 'DRIVER' && !order.pickedUpAt ? null : order.dropoffNotes, // drivers see the instructions together with the address
            accessCode, // DRIVER only, from pickup until delivery; staff use the audited reveal action
            accessCodeSet: viewer === 'CUSTOMER' || full ? hasCode : undefined,
            proofRule: rule.rule,
            proofLabel: rule.label,
            exceptionReasons: viewer === 'DRIVER' ? rule.exceptionReasons : undefined,
          };

    return {
      id: order.id,
      code: order.code,
      status: order.status,
      fulfilment: order.fulfilment,
      restaurant: {
        id: order.restaurant.id,
        name: order.restaurant.name,
        address: full || viewer === 'CUSTOMER' ? `${order.restaurant.addressLine1}, ${order.restaurant.city}` : null,
        lat: order.restaurant.lat,
        lng: order.restaurant.lng,
      },
      items: order.items.filter((i) => !i.removed),
      total: order.total,
      pickupCode: viewer === 'DRIVER' || full ? order.pickupCode : viewer === 'CUSTOMER' ? order.pickupCode : null,
      deliveryPin: (viewer === 'CUSTOMER' || full) && order.requiresPin ? order.deliveryPin : null,
      dropoff,
      kitchenNotes: viewer === 'DRIVER' ? null : order.customerNotes,
      deliveryProof: proofRow ? (viewer === 'CUSTOMER' || viewer === 'DRIVER' ? this.proof.customerView(proofRow) : viewer === 'RESTAURANT' ? { proofType: proofRow.proofType, deliveredAt: proofRow.deliveredAt } : this.proof.summary(proofRow)) : null,
      deliveryAddress: viewer === 'DRIVER' && !order.pickedUpAt ? null : viewer === 'RESTAURANT' || !order.deliveryAddress ? (order.deliveryAddress ? { ...order.deliveryAddress, dropoffNotes: undefined } : null) : order.deliveryAddress,
      driver: driver
        ? {
            id: driver.id,
            name: `${driver.user?.firstName ?? 'Your'} ${driver.user?.lastName?.[0] ?? ''}`.trim(),
            vehicleType: driver.vehicleType,
            vehicleColor: driver.vehicleColor,
            licensePlate: driver.licensePlate,
            lat: driver.lat,
            lng: driver.lng,
            phone: full ? driver.user?.phone : null,
          }
        : null,
      estimatedReadyAt: order.estimatedReadyAt,
      estimatedDeliveryAt: order.estimatedDeliveryAt,
      isLate: order.isLate,
      timeline: timeline.map((e) => ({ type: e.type, toStatus: e.toStatus, note: full ? e.note : null, createdAt: e.createdAt })),
    };
  }

  // ---------------------------------------------------------------------- scheduled sweeps

  /** Auto-reject orders the restaurant hasn't actioned within its accept window (section 7). */
  @Cron(CronExpression.EVERY_30_SECONDS)
  async sweepAutoReject() {
    if (this.settings.get<boolean>('orders.newOrdersPaused', false)) return;
    const stale = await this.orders.find({ where: { status: OrderStatus.PLACED } });
    const now = Date.now();
    for (const o of stale) {
      if (o.acceptDeadlineAt && o.acceptDeadlineAt.getTime() < now) {
        await this.transition(o.id, OrderStatus.REJECTED, { type: ActorType.SYSTEM }, { reason: 'Restaurant did not respond in time', force: true }).catch((e) =>
          this.logger.warn(`auto-reject failed for ${o.code}: ${(e as Error).message}`),
        );
      }
    }
  }

  /** Flag orders running behind their quoted ETA so the live map / dispatcher can react. */
  @Cron(CronExpression.EVERY_MINUTE)
  async sweepLateFlags() {
    const active = await this.orders.find({
      where: [{ status: OrderStatus.PREPARING }, { status: OrderStatus.READY }, { status: OrderStatus.PICKED_UP }, { status: OrderStatus.ON_THE_WAY }],
    });
    const now = Date.now();
    for (const o of active) {
      const target = o.estimatedDeliveryAt?.getTime() ?? o.estimatedReadyAt?.getTime();
      const late = !!target && now > target;
      if (late !== o.isLate) {
        await this.orders.update(o.id, { isLate: late });
        if (late) {
          this.realtime.emitToOps('order.late', { orderId: o.id, code: o.code });
          this.emitter.emit(Events.ORDER_LATE, { orderId: o.id, code: o.code });
        }
      }
    }
  }
}
