import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';
import { ActorType, OrderStatus, RestaurantServiceMode } from '../common/enums';
import { Events, OfferRespondedEvent, OrderStatusEvent, ReviewCreatedEvent, StatusChangedEvent } from '../common/contracts';
import { DriverProfile, Order } from '../database/entities';
import { SettingsService } from '../settings/settings.service';
import { NotificationsService } from './notifications.service';

const money = (n: any) => `$${Number(n ?? 0).toFixed(2)}`;
const clock = (d?: Date | string | null) => (d ? new Date(d).toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Toronto' }) : '');

/**
 * Turns the domain events of the platform (order placed / released / status changed / late, offer expired, review created, service
 * mode changed) into the notifications that no service raises itself. This is where the gaps of the event audit (docs/notifications.md)
 * are closed without touching every business service. Handlers never throw.
 */
@Injectable()
export class EventNotifierService {
  private readonly logger = new Logger('EventNotifier');
  private names = new Map<string, { name: string; at: number }>();

  constructor(
    private n: NotificationsService,
    private ds: DataSource,
    private settings: SettingsService,
  ) {}

  private safe<T>(label: string, fn: () => Promise<T>) {
    return fn().catch((e: any) => this.logger.warn(`${label}: ${e.message}`));
  }

  private async restaurantName(id: string): Promise<string> {
    const hit = this.names.get(id);
    if (hit && Date.now() - hit.at < 120_000) return hit.name;
    const rows: { name: string }[] = await this.ds.query(`SELECT name FROM restaurants WHERE id = $1`, [id]);
    const name = rows[0]?.name ?? 'the restaurant';
    this.names.set(id, { name, at: Date.now() });
    if (this.names.size > 2000) this.names.clear();
    return name;
  }

  private async driver(driverId?: string | null) {
    if (!driverId) return null;
    const d = await this.ds.getRepository(DriverProfile).findOne({ where: { id: driverId }, relations: ['user'] });
    if (!d) return null;
    const name = `${d.user?.firstName ?? 'Your driver'} ${d.user?.lastName?.[0] ? d.user.lastName[0] + '.' : ''}`.trim();
    return { userId: d.userId, name, vehicle: d.vehicleType as string };
  }

  private released(o: Pick<Order, 'kitchenReleaseAt' | 'kitchenReleasedAt'>) {
    return !o.kitchenReleaseAt || !!o.kitchenReleasedAt;
  }

  // ---------------------------------------------------------------- order placed / released
  @OnEvent(Events.ORDER_PLACED)
  onPlaced({ order }: { order: Order }) {
    return this.safe('order.placed', async () => {
      const grace = Number(this.settings.get<number>('orders.customerCancelGraceSeconds', 120));
      const until = order.kitchenReleaseAt ?? (grace > 0 ? new Date(order.createdAt.getTime() + grace * 1000) : null);
      const mins = grace >= 60 ? `${Math.round(grace / 60)} min` : `${grace} s`;
      await this.n.notify({
        userId: order.customerId,
        audience: 'CUSTOMER',
        event: 'order.placed',
        vars: { code: order.code, restaurant: await this.restaurantName(order.restaurantId), total: money(order.total), cancelNote: grace > 0 ? `You can cancel it free for the next ${mins}.` : '' },
        data: { orderId: order.id, ...(until && grace > 0 ? { cancelUntil: until.toISOString() } : {}) },
      });
    });
  }

  @OnEvent(Events.ORDER_RELEASED)
  onReleased({ order }: { order: Order }) {
    return this.safe('order.sent_to_restaurant', async () =>
      this.n.notify({ userId: order.customerId, audience: 'CUSTOMER', event: 'order.sent_to_restaurant', vars: { code: order.code, restaurant: await this.restaurantName(order.restaurantId) }, data: { orderId: order.id } }),
    );
  }

  // ---------------------------------------------------------------- status changes
  @OnEvent(Events.ORDER_STATUS_CHANGED)
  onStatus({ order, to }: OrderStatusEvent) {
    return this.safe('order.status', async () => {
      const data = { orderId: order.id };
      if (to === OrderStatus.PREPARING) {
        await this.n.notify({ userId: order.customerId, audience: 'CUSTOMER', event: 'order.preparing', vars: { code: order.code, restaurant: await this.restaurantName(order.restaurantId) }, data });
      } else if (to === OrderStatus.ON_THE_WAY) {
        await this.n.notify({
          userId: order.customerId,
          audience: 'CUSTOMER',
          event: 'order.on_the_way',
          vars: { code: order.code, eta: order.estimatedDeliveryAt ? `Estimated arrival ${clock(order.estimatedDeliveryAt)}.` : '' },
          data,
        });
      } else if (to === OrderStatus.READY && order.driverId) {
        const d = await this.driver(order.driverId);
        if (d) await this.n.notify({ userId: d.userId, audience: 'DRIVER', event: 'order.ready', vars: { code: order.code, restaurant: await this.restaurantName(order.restaurantId) }, data });
      } else if (to === OrderStatus.PICKED_UP && this.released(order)) {
        const d = await this.driver(order.driverId);
        await this.n.notifyRestaurant(order.restaurantId, 'order.picked_up', { code: order.code, driverName: d?.name ?? 'The driver' }, data);
      }
    });
  }

  @OnEvent(Events.ORDER_DELIVERED)
  onDelivered({ order }: OrderStatusEvent) {
    return this.safe('order.delivered', async () => {
      const data = { orderId: order.id };
      const d = await this.driver(order.driverId);
      if (d) await this.n.notify({ userId: d.userId, audience: 'DRIVER', event: 'order.delivered', vars: { code: order.code, earnings: money(order.driverPay) }, data });
      if (this.released(order)) await this.n.notifyRestaurant(order.restaurantId, 'order.delivered', { code: order.code }, data);
    });
  }

  @OnEvent(Events.ORDER_CANCELLED)
  onCancelled({ order, actor }: OrderStatusEvent) {
    return this.safe('order.cancelled', async () => {
      const data = { orderId: order.id };
      const vars = { code: order.code, reason: order.cancelReason ?? order.rejectReason ?? '' };
      // a held order (customer's cancellation window) was never shown to the restaurant: nothing to tell it
      if (this.released(order) && actor?.type !== ActorType.RESTAURANT && order.status !== OrderStatus.REJECTED) {
        await this.n.notifyRestaurant(order.restaurantId, 'order.cancelled', vars, data);
      }
      const d = await this.driver(order.driverId);
      if (d) await this.n.notify({ userId: d.userId, audience: 'DRIVER', event: 'order.cancelled', vars, data });
    });
  }

  // ---------------------------------------------------------------- late / overdue
  @OnEvent(Events.ORDER_LATE)
  onLate({ orderId }: { orderId: string; code: string }) {
    return this.safe('order.late', async () => {
      const o = await this.ds.getRepository(Order).findOne({ where: { id: orderId } });
      if (!o) return;
      const data = { orderId: o.id };
      const ext = Number(this.settings.get<number>('orders.lateEtaExtensionMin', 10));
      const eta = clock(new Date(Date.now() + ext * 60_000));
      await this.n.notify({ userId: o.customerId, audience: 'CUSTOMER', event: 'order.late', vars: { code: o.code, eta }, data });
      if (o.status === OrderStatus.PREPARING) await this.n.notifyRestaurant(o.restaurantId, 'order.prep_overdue', { code: o.code }, data);
      const d = await this.driver(o.driverId);
      if (d && [OrderStatus.READY, OrderStatus.PICKED_UP, OrderStatus.ON_THE_WAY].includes(o.status)) await this.n.notify({ userId: d.userId, audience: 'DRIVER', event: 'order.late', vars: { code: o.code }, data });
      // the ops room already received the realtime `order.late`; staff get the notification rows / pushes here
      await this.n.notifyStaff('order.late', { code: o.code, reason: o.status }, data);
    });
  }

  // ---------------------------------------------------------------- delivery offers
  @OnEvent(Events.OFFER_RESPONDED)
  onOffer(e: OfferRespondedEvent) {
    if (e.status !== 'EXPIRED') return;
    return this.safe('driver.offer_expired', async () => {
      const d = await this.driver(e.driverId);
      const o = await this.ds.getRepository(Order).findOne({ where: { id: e.orderId }, select: ['id', 'restaurantId'] });
      if (d) await this.n.notify({ userId: d.userId, audience: 'DRIVER', event: 'driver.offer_expired', vars: { restaurant: o ? await this.restaurantName(o.restaurantId) : '' }, data: { offerId: e.offerId, orderId: e.orderId } });
    });
  }

  // ---------------------------------------------------------------- reviews
  @OnEvent(Events.REVIEW_CREATED)
  onReview(e: ReviewCreatedEvent) {
    if (e.restaurantRating == null) return;
    return this.safe('review.received', async () => {
      const o = await this.ds.getRepository(Order).findOne({ where: { id: e.orderId }, select: ['id', 'code'] });
      await this.n.notifyRestaurant(e.restaurantId, 'review.received', { rating: e.restaurantRating, code: o?.code ?? '' }, { reviewId: e.reviewId, orderId: e.orderId });
    });
  }

  // ---------------------------------------------------------------- store paused / resumed
  @OnEvent(Events.RESTAURANT_SERVICE_MODE_CHANGED)
  onServiceMode(e: StatusChangedEvent & { resumeAt?: Date | null }) {
    return this.safe('store.mode', async () => {
      if (e.from === e.to) return;
      const byRestaurant = e.actor?.type === ActorType.RESTAURANT;
      const by = !e.actor ? 'automatically' : byRestaurant ? 'by your team' : 'by FORKSY';
      const until = e.resumeAt ? ` It will reopen at ${clock(e.resumeAt)}.` : '';
      let event: string;
      let mode: string;
      if (e.to === RestaurantServiceMode.CLOSED) {
        event = 'store.paused';
        mode = `Your store stopped taking orders ${by}.${until}`;
      } else if (e.to === RestaurantServiceMode.PICKUP_ONLY) {
        event = 'store.paused';
        mode = `Delivery was turned off ${by}: pickup orders only.${until}`;
      } else {
        event = 'store.resumed';
        mode = `Your store is taking orders again (${by === 'automatically' ? 'switched back automatically' : by}).`;
      }
      await this.n.notifyRestaurant(e.id, event, { mode }, { restaurantId: e.id }, byRestaurant ? e.actor?.id : undefined);
    });
  }
}
