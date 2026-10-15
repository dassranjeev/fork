import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { MenuItem, MenuItemModifierGroup, ModifierGroup, Order, OrderEvent, OrderItem } from '../database/entities';
import { ActorType, OrderStatus, RefundChargedTo, RefundType } from '../common/enums';
import { stockUse, unitPriceOf } from '../common/store-types';
import { NotificationsService } from '../notifications/notifications.service';
import { RealtimeService } from '../realtime/realtime.module';
import { RefundsService } from './refunds.service';
import { round2 } from './pricing.math';

/** What a basket line takes from the shelves (a quote line or an order item). */
export interface StockLine {
  menuItemId: string | null;
  quantity: number;
  sellBy?: string | null;
  weightUnit?: string | null;
  stepSize?: number | string | null;
}

/** Stock taken for an order that is being created: undone if the order cannot be completed. */
export interface Reservation {
  menuItemId: string;
  use: number;
}

export interface PickInput {
  status: 'PICKED' | 'OUT_OF_STOCK' | 'REPLACED';
  /** weighed products: what the scale says, in the product's weight unit */
  actualWeight?: number;
  replacementItemId?: string;
  replacementQuantity?: number;
  note?: string;
}

export interface PickActor {
  type: ActorType;
  id?: string | null;
  name?: string;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const LIVE_PICKING = [OrderStatus.ACCEPTED, OrderStatus.DRIVER_ASSIGNED, OrderStatus.PREPARING, OrderStatus.READY];

/**
 * Grocery / retail order handling that has no place in the restaurant flow (docs/store-types.md):
 *  - stock: shelves are counted down when an order is placed and counted back when it is cancelled or rejected
 *  - picking: the store goes through the basket line by line: found (weighed products are weighed), out of stock (refund), replaced (the customer
 *    pays the lower price). The money is refunded as it happens, the customer is told, and the order timeline records it.
 * Standalone on purpose: OrdersService calls the stock methods, the portal calls pick(); neither needs the other here.
 */
@Injectable()
export class RetailService {
  private readonly logger = new Logger(RetailService.name);

  constructor(
    @InjectRepository(Order) private orders: Repository<Order>,
    @InjectRepository(OrderItem) private items: Repository<OrderItem>,
    @InjectRepository(OrderEvent) private events: Repository<OrderEvent>,
    @InjectRepository(MenuItem) private menu: Repository<MenuItem>,
    private refunds: RefundsService,
    private notifications: NotificationsService,
    private realtime: RealtimeService,
  ) {}

  // ------------------------------------------------------------------ stock
  private rowsOf(raw: any): any[] {
    return Array.isArray(raw) && Array.isArray(raw[0]) ? raw[0] : Array.isArray(raw) ? raw : [];
  }

  /**
   * Takes the basket's stock off the shelves, atomically per product (two orders can never both take the last one). Products without stock tracking are
   * skipped. Throws INSUFFICIENT_STOCK (and gives back what it already took) when a tracked product has too little left.
   */
  async reserve(lines: StockLine[]): Promise<Reservation[]> {
    const want = new Map<string, number>();
    for (const l of lines) {
      if (!l.menuItemId) continue;
      const use = stockUse({ sellBy: l.sellBy ?? 'UNIT', weightUnit: l.weightUnit ?? 'KG', stepSize: l.stepSize ?? 1, price: 0 }, l.quantity);
      want.set(l.menuItemId, round3((want.get(l.menuItemId) ?? 0) + use));
    }
    const done: Reservation[] = [];
    for (const [id, use] of want) {
      const rows = this.rowsOf(
        await this.menu.query(
          `UPDATE menu_items SET "stockQty" = "stockQty" - $2, "updatedAt" = now() WHERE id = $1 AND "trackStock" = true AND COALESCE("stockQty", 0) >= $2 RETURNING id, name, "restaurantId", "stockQty", "lowStockThreshold"`,
          [id, use],
        ),
      );
      if (rows.length) {
        done.push({ menuItemId: id, use });
        const now = Number(rows[0].stockQty);
        const threshold = rows[0].lowStockThreshold == null ? null : Number(rows[0].lowStockThreshold);
        // tell the store when a product runs low (once: only when this order takes it across the line)
        if (threshold != null && now <= threshold && now + use > threshold) {
          this.notifications.notifyRestaurant(rows[0].restaurantId, 'stock.low', { item: rows[0].name, left: now <= 0 ? 'none' : String(now) }, { menuItemId: id }).catch(() => undefined);
        }
        continue;
      }
      const cur = await this.menu.findOne({ where: { id }, select: ['id', 'name', 'trackStock', 'stockQty', 'sellBy', 'weightUnit'] });
      if (cur?.trackStock) {
        await this.release(done);
        const left = Number(cur.stockQty ?? 0);
        const label = cur.sellBy === 'WEIGHT' ? `${left} ${String(cur.weightUnit).toLowerCase()}` : String(left);
        throw new BadRequestException({ message: left <= 0 ? `"${cur.name}" just sold out` : `Only ${label} of "${cur.name}" left`, code: 'INSUFFICIENT_STOCK', details: { menuItemId: id, name: cur.name, available: left } });
      }
    }
    return done;
  }

  /** Gives reserved stock back (the order could not be completed). */
  async release(reservations: Reservation[]): Promise<void> {
    for (const r of reservations) {
      await this.menu.query(`UPDATE menu_items SET "stockQty" = COALESCE("stockQty", 0) + $2, "updatedAt" = now() WHERE id = $1 AND "trackStock" = true`, [r.menuItemId, r.use]).catch((e) => this.logger.warn(`could not release stock of ${r.menuItemId}: ${e.message}`));
    }
  }

  /**
   * An order was cancelled / rejected: its products go back on the shelves. Lines the store found out of stock stay at zero; a replaced line gives back the
   * replacement it took. The caller makes this once per order (order.meta.stockRestored).
   */
  async restoreFor(order: Order): Promise<void> {
    const items = order.items?.length ? order.items : await this.items.find({ where: { orderId: order.id } });
    const back: Reservation[] = [];
    for (const i of items) {
      if (i.removed || i.pickStatus === 'OUT_OF_STOCK') continue;
      if (i.pickStatus === 'REPLACED') {
        if (i.replacement?.menuItemId) {
          const repl = await this.menu.findOne({ where: { id: i.replacement.menuItemId }, select: ['id', 'sellBy', 'weightUnit', 'stepSize'] });
          if (repl) back.push({ menuItemId: repl.id, use: stockUse(repl as any, i.replacement.quantity) });
        }
        continue;
      }
      if (!i.menuItemId) continue;
      back.push({ menuItemId: i.menuItemId, use: stockUse({ sellBy: i.sellBy, weightUnit: i.weightUnit, stepSize: i.stepSize, price: 0 }, i.quantity) });
    }
    await this.release(back);
  }

  // ------------------------------------------------------------------ age-restricted products
  /**
   * The recipient could not show valid ID (checked by the driver at the door): the age-restricted lines are NOT handed over. They are removed from the
   * order, refunded and go back on the shelves; the rest of the order stays delivered.
   */
  async refuseAgeRestricted(order: Order, actor: PickActor): Promise<void> {
    const lines = (await this.items.find({ where: { orderId: order.id } })).filter((i) => (i.minAge ?? 0) > 0 && !i.removed);
    if (!lines.length) return;
    let back = 0;
    const restock: Reservation[] = [];
    for (const i of lines) {
      back += Math.max(0, this.lineRemaining(i));
      i.idRefused = true;
      i.removed = true;
      i.removedReason = 'ID not shown: age-restricted product not handed over';
      i.adjustmentRefund = round2(Number(i.lineTotal) + Number(i.taxAmount));
      await this.items.save(i);
      if (i.menuItemId && i.pickStatus !== 'OUT_OF_STOCK') restock.push({ menuItemId: i.menuItemId, use: stockUse({ sellBy: i.sellBy, weightUnit: i.weightUnit, stepSize: i.stepSize, price: 0 }, i.quantity) });
    }
    await this.release(restock);
    back = round2(back);
    await this.addEvent(order.id, 'ID_CHECK_REFUSED', actor, `ID not shown: ${lines.map((l) => l.name).join(', ')} not handed over${back >= 0.01 ? `, ${this.money(back)} refunded` : ''}`, { minAge: order.minAge, refund: back, items: lines.map((l) => l.id) });
    if (back >= 0.01) {
      await this.refunds.issue({ orderId: order.id, amount: back, type: RefundType.REFUND, chargedTo: RefundChargedTo.RESTAURANT, reasonCode: 'ID_CHECK_FAILED', notes: `ID not shown for: ${lines.map((l) => l.name).join(', ')}`, actor: { type: ActorType.SYSTEM, staff: false }, auto: true });
    }
    await this.notifications
      .notify({ userId: order.customerId, audience: 'CUSTOMER', event: 'order.id_check_failed', data: { orderId: order.id }, vars: { code: order.code, minAge: String(order.minAge), amount: this.money(back) } })
      .catch(() => undefined);
  }

  // ------------------------------------------------------------------ picking
  private async addEvent(orderId: string, type: string, actor: PickActor, note: string, data: Record<string, any>) {
    await this.events.insert({ orderId, type, fromStatus: null, toStatus: null, actorType: actor.type, actorId: actor.id ?? null, note, data });
  }

  private money(n: number) {
    return `$${round2(n).toFixed(2)}`;
  }

  /** Money still to give back for a line: the whole line (with tax) minus what was already refunded for it. */
  private lineRemaining(i: OrderItem) {
    return round2(Number(i.lineTotal) + Number(i.taxAmount) - Number(i.adjustmentRefund ?? 0));
  }

  /**
   * One step of the picking list. PICKED (a weighed product needs `actualWeight`: the customer pays for the weight up to the estimate, never more, and
   * the difference is refunded), OUT_OF_STOCK (the line is removed and refunded; the product shows as sold out), REPLACED (another product of the store
   * instead: the customer pays the LOWER of the two prices, the difference is refunded; only when the customer allowed substitutions).
   * Returns the order and whether every line is now gone (the caller then cancels the empty order).
   */
  async pick(orderId: string, restaurantId: string, itemId: string, dto: PickInput, actor: PickActor): Promise<{ order: Order; allRemoved: boolean }> {
    const order = await this.orders.findOne({ where: { id: orderId, restaurantId }, relations: ['items'] });
    if (!order) throw new NotFoundException('Order not found');
    if (!LIVE_PICKING.includes(order.status)) throw new BadRequestException('Products can only be picked while the order is being prepared (accepted, preparing or ready for the driver)');
    const item = order.items.find((i) => i.id === itemId);
    if (!item) throw new NotFoundException('Order item not found');
    if (item.removed || item.pickStatus === 'OUT_OF_STOCK') throw new BadRequestException('This product was already marked out of stock');
    if (item.pickStatus === 'REPLACED') throw new BadRequestException('This product was already replaced');

    if (dto.status === 'PICKED') await this.markPicked(order, item, dto, actor);
    else if (dto.status === 'OUT_OF_STOCK') await this.markOutOfStock(order, item, dto, actor);
    else if (dto.status === 'REPLACED') await this.markReplaced(order, item, dto, actor);
    else throw new BadRequestException('status must be PICKED, OUT_OF_STOCK or REPLACED');

    this.realtime.emitToOrder(order.id, 'order.item_picked', { orderId: order.id, itemId, status: dto.status });
    const fresh = await this.orders.findOneOrFail({ where: { id: orderId }, relations: ['items'] });
    return { order: fresh, allRemoved: fresh.items.length > 0 && fresh.items.every((i) => i.removed) };
  }

  private async markPicked(order: Order, item: OrderItem, dto: PickInput, actor: PickActor) {
    if (item.sellBy !== 'WEIGHT') {
      item.pickStatus = 'PICKED';
      await this.items.save(item);
      await this.addEvent(order.id, 'ITEM_PICKED', actor, `${item.quantity} x ${item.name} picked`, { orderItemId: item.id });
      return;
    }
    const actual = round3(Number(dto.actualWeight));
    if (!(actual > 0)) throw new BadRequestException('Weigh the product: actualWeight (in the product\'s weight unit) is required');
    const estimated = Number(item.estimatedWeight ?? 0);
    const ratio = estimated > 0 ? Math.min(actual, estimated) / estimated : 1;
    // the customer is charged for the estimated weight at most: heavier is the store's, lighter is refunded
    const target = round2((Number(item.lineTotal) + Number(item.taxAmount)) * (1 - ratio));
    if (target + 0.004 < Number(item.adjustmentRefund ?? 0)) {
      throw new ConflictException('The customer was already refunded for a lighter weight: a weight cannot be corrected upwards');
    }
    const delta = round2(target - Number(item.adjustmentRefund ?? 0));
    item.actualWeight = actual;
    item.pickStatus = 'PICKED';
    item.adjustmentRefund = target;
    await this.items.save(item);
    const unit = String(item.weightUnit).toLowerCase();
    await this.addEvent(order.id, 'ITEM_WEIGHED', actor, `${item.name}: weighed ${actual} ${unit} (ordered about ${estimated} ${unit})${delta >= 0.01 ? `, ${this.money(delta)} refunded` : ''}`, { orderItemId: item.id, actual, estimated, refund: delta });
    if (delta >= 0.01) {
      await this.refunds.issue({ orderId: order.id, amount: delta, type: RefundType.REFUND, chargedTo: RefundChargedTo.RESTAURANT, reasonCode: 'WEIGHT_ADJUSTMENT', notes: `${item.name}: weighed ${actual} ${unit}, ordered about ${estimated} ${unit}`, actor: { type: ActorType.SYSTEM, staff: false }, auto: true });
      await this.notifications
        .notify({ userId: order.customerId, audience: 'CUSTOMER', event: 'order.weight_adjusted', data: { orderId: order.id }, vars: { code: order.code, item: item.name, weight: `${actual} ${unit}`, amount: this.money(delta) } })
        .catch(() => undefined);
    }
  }

  private async markOutOfStock(order: Order, item: OrderItem, dto: PickInput, actor: PickActor) {
    const back = this.lineRemaining(item);
    item.pickStatus = 'OUT_OF_STOCK';
    item.removed = true;
    item.removedReason = (dto.note ?? 'Out of stock').slice(0, 200);
    item.adjustmentRefund = round2(Number(item.lineTotal) + Number(item.taxAmount));
    await this.items.save(item);
    // the shelf is empty: other customers must not be able to order it
    if (item.menuItemId) await this.menu.query(`UPDATE menu_items SET "stockQty" = 0, "updatedAt" = now() WHERE id = $1 AND "trackStock" = true`, [item.menuItemId]);
    await this.addEvent(order.id, 'ITEM_OUT_OF_STOCK', actor, `${item.name} is out of stock${back >= 0.01 ? `, ${this.money(back)} refunded` : ''}`, { orderItemId: item.id, refund: back });
    if (back >= 0.01) {
      await this.refunds.issue({ orderId: order.id, amount: back, type: RefundType.REFUND, chargedTo: RefundChargedTo.RESTAURANT, reasonCode: 'MISSING_ITEM', notes: `${item.name}: out of stock`, actor: { type: ActorType.SYSTEM, staff: false }, auto: true });
    }
    await this.notifications
      .notify({ userId: order.customerId, audience: 'CUSTOMER', event: 'order.item_out_of_stock', data: { orderId: order.id }, vars: { code: order.code, item: item.name, amount: this.money(back) } })
      .catch(() => undefined);
  }

  private async markReplaced(order: Order, item: OrderItem, dto: PickInput, actor: PickActor) {
    if (item.substitution === 'REFUND') throw new BadRequestException('The customer asked for a refund instead of a replacement: mark it out of stock');
    if (!dto.replacementItemId) throw new BadRequestException('replacementItemId is required to replace a product');
    if (dto.replacementItemId === item.menuItemId) throw new BadRequestException('A product cannot replace itself');
    const repl = await this.menu.findOne({ where: { id: dto.replacementItemId, restaurantId: order.restaurantId, active: true } });
    if (!repl) throw new NotFoundException('The replacement product was not found in this store');
    if (!repl.available) throw new BadRequestException(`"${repl.name}" is not available`);
    // a replacement has to be orderable as it is: no required options to choose
    const links = await this.menu.manager.getRepository(MenuItemModifierGroup).find({ where: { menuItemId: repl.id } });
    if (links.length) {
      const groups = await this.menu.manager.getRepository(ModifierGroup).find({ where: { id: In(links.map((l) => l.groupId)) } });
      if (groups.some((g) => g.required || g.minSelect > 0)) throw new BadRequestException(`"${repl.name}" has options that must be chosen and cannot be used as a replacement`);
    }
    const qty = Math.floor(dto.replacementQuantity ?? item.quantity);
    if (!(qty >= 1 && qty <= 99)) throw new BadRequestException('replacementQuantity must be between 1 and 99');
    // the replacement leaves the shelf (throws INSUFFICIENT_STOCK when it is not there)
    await this.reserve([{ menuItemId: repl.id, quantity: qty, sellBy: repl.sellBy, weightUnit: repl.weightUnit, stepSize: repl.stepSize }]);

    const unit = unitPriceOf(repl);
    const lineTotal = Number(item.lineTotal);
    const keep = Math.min(lineTotal, round2(unit * qty)); // the customer never pays more than for what they ordered
    const ratio = lineTotal > 0 ? keep / lineTotal : 1;
    const back = round2((lineTotal + Number(item.taxAmount)) * (1 - ratio) - Number(item.adjustmentRefund ?? 0));
    item.pickStatus = 'REPLACED';
    item.replacement = { menuItemId: repl.id, name: repl.name, quantity: qty, unitPrice: unit, packSize: repl.packSize ?? null };
    item.adjustmentRefund = round2(Number(item.adjustmentRefund ?? 0) + Math.max(0, back));
    await this.items.save(item);
    if (item.menuItemId) await this.menu.query(`UPDATE menu_items SET "stockQty" = 0, "updatedAt" = now() WHERE id = $1 AND "trackStock" = true`, [item.menuItemId]);
    await this.addEvent(order.id, 'ITEM_REPLACED', actor, `${item.name} replaced with ${qty} x ${repl.name}${back >= 0.01 ? `, ${this.money(back)} refunded (price difference)` : ''}`, { orderItemId: item.id, replacementItemId: repl.id, quantity: qty, refund: Math.max(0, back) });
    if (back >= 0.01) {
      await this.refunds.issue({ orderId: order.id, amount: back, type: RefundType.REFUND, chargedTo: RefundChargedTo.RESTAURANT, reasonCode: 'SUBSTITUTION_PRICE_DIFFERENCE', notes: `${item.name} replaced with ${repl.name}`, actor: { type: ActorType.SYSTEM, staff: false }, auto: true });
    }
    await this.notifications
      .notify({ userId: order.customerId, audience: 'CUSTOMER', event: 'order.item_replaced', data: { orderId: order.id }, vars: { code: order.code, item: item.name, replacement: repl.name, amount: this.money(Math.max(0, back)) } })
      .catch(() => undefined);
  }
}
