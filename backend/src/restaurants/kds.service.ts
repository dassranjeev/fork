import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, Repository } from 'typeorm';
import { Order, OrderItem, Restaurant } from '../database/entities';
import { OrderStatus } from '../common/enums';
import { AuthUser } from '../common/auth.types';
import { OrdersService } from '../orders/orders.service';
import { restaurantActor } from './restaurants.util';

const DONE_STATUSES = [OrderStatus.PICKED_UP, OrderStatus.COLLECTED];
const ACTIVE_STATUSES = [OrderStatus.ACCEPTED, OrderStatus.DRIVER_ASSIGNED, OrderStatus.PREPARING, OrderStatus.READY];

export type KdsOp = { opId?: string; op: 'start' | 'bump' | 'ready' | 'item'; orderId: string; stationId?: string; itemId?: string; status?: string };

/**
 * Kitchen Display System: columns New -> Preparing -> Ready -> Picked up, station routing/bump,
 * colour-timer data (elapsedMin/dueInMin) and a kitchen load indicator (spec §4 KDS).
 * Order-level status still flows through OrdersService.transition (single source of truth);
 * OrderItem.kitchenStatus gives per-ticket / per-station granularity within that order.
 */
@Injectable()
export class KdsService {
  constructor(
    @InjectRepository(Order) private orders: Repository<Order>,
    @InjectRepository(OrderItem) private items: Repository<OrderItem>,
    @InjectRepository(Restaurant) private restaurants: Repository<Restaurant>,
    private ordersService: OrdersService,
  ) {}

  private column(status: OrderStatus): 'NEW' | 'PREPARING' | 'READY' | 'PICKED_UP' {
    if (status === OrderStatus.PREPARING) return 'PREPARING';
    if (status === OrderStatus.READY) return 'READY';
    if (DONE_STATUSES.includes(status)) return 'PICKED_UP';
    return 'NEW';
  }

  async board(restaurantId: string, stationId?: string) {
    const r = await this.restaurants.findOne({ where: { id: restaurantId } });
    if (!r) throw new NotFoundException('Restaurant not found');
    const recentMin = r.meta?.kds?.recentPickedUpMinutes ?? 15;
    const cutoff = new Date(Date.now() - recentMin * 60_000);

    const orders = await this.orders
      .createQueryBuilder('o')
      .leftJoinAndSelect('o.items', 'i')
      .where('o.restaurantId = :rid', { rid: restaurantId })
      .andWhere(
        new Brackets((b) =>
          b.where('o.status IN (:...active)', { active: ACTIVE_STATUSES }).orWhere('(o.status IN (:...done) AND o."readyAt" >= :cutoff)', { done: DONE_STATUSES, cutoff }),
        ),
      )
      .orderBy('o.createdAt', 'ASC')
      .getMany();

    const columns: Record<'NEW' | 'PREPARING' | 'READY' | 'PICKED_UP', any[]> = { NEW: [], PREPARING: [], READY: [], PICKED_UP: [] };
    for (const o of orders) {
      const items = (o.items ?? []).filter((i) => !i.removed && (!stationId || i.stationId === stationId));
      if (stationId && !items.length) continue;
      const col = this.column(o.status);
      columns[col].push({
        id: o.id,
        code: o.code,
        status: o.status,
        fulfilment: o.fulfilment,
        acceptedAt: o.acceptedAt,
        estimatedReadyAt: o.estimatedReadyAt,
        elapsedMin: o.acceptedAt ? Math.round((Date.now() - o.acceptedAt.getTime()) / 60_000) : 0,
        dueInMin: o.estimatedReadyAt ? Math.round((o.estimatedReadyAt.getTime() - Date.now()) / 60_000) : null,
        items: items.map((i) => ({ id: i.id, name: i.name, quantity: i.quantity, notes: i.notes, stationId: i.stationId, kitchenStatus: i.kitchenStatus, modifiers: i.modifiers })),
      });
    }
    const capacityTickets = r.meta?.kds?.capacityTickets ?? 12;
    const load = capacityTickets > 0 ? Math.round((columns.PREPARING.length / capacityTickets) * 100) / 100 : 0;
    return { columns, capacityTickets, load, generatedAt: new Date() };
  }

  private async orderFor(restaurantId: string, orderId: string) {
    const order = await this.orders.findOne({ where: { id: orderId, restaurantId }, relations: ['items'] });
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  /** op 'start': begin prep. Transitions ACCEPTED/DRIVER_ASSIGNED -> PREPARING; item tickets NEW -> PREPARING. Idempotent. */
  async start(restaurantId: string, orderId: string, user: AuthUser) {
    const order = await this.orderFor(restaurantId, orderId);
    if (order.status === OrderStatus.ACCEPTED || order.status === OrderStatus.DRIVER_ASSIGNED) {
      await this.ordersService.transition(orderId, OrderStatus.PREPARING, restaurantActor(user));
    } else if (order.status !== OrderStatus.PREPARING) {
      throw new BadRequestException(`Cannot start prep from status ${order.status}`);
    }
    await this.items.update({ orderId, kitchenStatus: 'NEW' }, { kitchenStatus: 'PREPARING' });
    return this.orderFor(restaurantId, orderId);
  }

  /** op 'bump': a station clears its queue - ticket items PREPARING -> READY (order-level READY is a separate explicit action). */
  async bump(restaurantId: string, stationId: string | undefined, _user: AuthUser) {
    const orders = await this.orders.find({ where: { restaurantId, status: OrderStatus.PREPARING }, relations: ['items'] });
    let bumped = 0;
    for (const o of orders) {
      const targets = o.items.filter((i) => !i.removed && i.kitchenStatus === 'PREPARING' && (!stationId || i.stationId === stationId));
      if (!targets.length) continue;
      await this.items.update({ id: In(targets.map((i) => i.id)) }, { kitchenStatus: 'READY' });
      bumped += targets.length;
    }
    return { ok: true, bumped };
  }

  /** op 'ready': whole order ready for handoff/pickup. */
  async ready(restaurantId: string, orderId: string, user: AuthUser) {
    await this.orderFor(restaurantId, orderId);
    await this.items.update({ orderId }, { kitchenStatus: 'READY' });
    return this.ordersService.transition(orderId, OrderStatus.READY, restaurantActor(user));
  }

  /** op 'item': set one ticket's station status directly (fine-grained station routing). */
  async setItemStatus(restaurantId: string, orderItemId: string, status: 'NEW' | 'PREPARING' | 'READY', _user: AuthUser) {
    const item = await this.items.findOne({ where: { id: orderItemId } });
    if (!item) throw new NotFoundException('Order item not found');
    const order = await this.orderFor(restaurantId, item.orderId);
    item.kitchenStatus = status;
    await this.items.save(item);
    return order;
  }

  /** Offline queue replay: ops are applied in order and are each individually idempotent. */
  async sync(restaurantId: string, ops: KdsOp[], user: AuthUser) {
    const results: { opId?: string; ok: boolean; error?: string }[] = [];
    for (const op of ops) {
      try {
        if (op.op === 'start') await this.start(restaurantId, op.orderId, user);
        else if (op.op === 'bump') await this.bump(restaurantId, op.stationId, user);
        else if (op.op === 'ready') await this.ready(restaurantId, op.orderId, user);
        else if (op.op === 'item') {
          if (!op.itemId || !op.status) throw new BadRequestException('item op needs itemId and status');
          await this.setItemStatus(restaurantId, op.itemId, op.status as any, user);
        }
        results.push({ opId: op.opId, ok: true });
      } catch (e: any) {
        results.push({ opId: op.opId, ok: false, error: e.message ?? String(e) });
      }
    }
    return { ok: true, results };
  }
}
