import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { OnEvent } from '@nestjs/event-emitter';
import { Cron } from '@nestjs/schedule';
import { In, Repository } from 'typeorm';
import { Order, OrderItem, Restaurant } from '../database/entities';
import { ActorType, FulfilmentMode, OrderStatus, RestaurantStatus } from '../common/enums';
import { Events, OrderStatusEvent } from '../common/contracts';
import { haversineKm } from '../common/geo.util';
import { SettingsService } from '../settings/settings.service';
import { RealtimeService } from '../realtime/realtime.module';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/auth.types';
import { NotificationsService } from '../notifications/notifications.service';
import { OrdersService } from './orders.service';

export interface AutomationConfig {
  /** accept new orders automatically (prep time estimated from the kitchen load) */
  autoAccept: boolean;
  /** move an accepted order to PREPARING (kitchen ticket starts) without a tap */
  autoStartPrep: boolean;
  /** mark the order READY when its prep time has elapsed (the kitchen can still mark it earlier or extend the time) */
  autoReady: boolean;
}

export type AutomationOverrides = { [K in keyof AutomationConfig]?: boolean | null };
const KEYS: (keyof AutomationConfig)[] = ['autoAccept', 'autoStartPrep', 'autoReady'];

const SYSTEM = (name: string) => ({ type: ActorType.SYSTEM, id: null, name });

/** an order driven entirely by the system moves through these steps with no taps; every step is written to the order timeline as "Auto: ..." */
@Injectable()
export class OrderAutomationService {
  private readonly logger = new Logger('OrderAutomation');
  private ticking = false;
  private arrivalSeen = new Set<string>();
  private coords = new Map<string, { lat: number | null; lng: number | null; at: number }>();

  constructor(
    @InjectRepository(Order) private orders: Repository<Order>,
    @InjectRepository(OrderItem) private items: Repository<OrderItem>,
    @InjectRepository(Restaurant) private restaurants: Repository<Restaurant>,
    private ordersService: OrdersService,
    private settings: SettingsService,
    private rt: RealtimeService,
    private audit: AuditService,
    private notifications: NotificationsService,
  ) {}

  // ------------------------------------------------------------------ configuration (platform default, restaurant override)
  private platform(): AutomationConfig {
    return {
      autoAccept: this.settings.get<boolean>('automation.orders.autoAccept', true),
      autoStartPrep: this.settings.get<boolean>('automation.orders.autoStartPrep', true),
      autoReady: this.settings.get<boolean>('automation.orders.autoReady', true),
    };
  }

  overridesOf(r: Pick<Restaurant, 'meta'>): AutomationOverrides {
    const o = (r.meta?.automation ?? {}) as Record<string, unknown>;
    const out: AutomationOverrides = {};
    for (const k of KEYS) out[k] = typeof o[k] === 'boolean' ? (o[k] as boolean) : null;
    return out;
  }

  effective(r: Pick<Restaurant, 'meta'>): AutomationConfig {
    const base = this.platform();
    const o = this.overridesOf(r);
    return { autoAccept: o.autoAccept ?? base.autoAccept, autoStartPrep: o.autoStartPrep ?? base.autoStartPrep, autoReady: o.autoReady ?? base.autoReady };
  }

  async view(restaurantId: string) {
    const r = await this.restaurants.findOne({ where: { id: restaurantId } });
    if (!r) throw new NotFoundException('Restaurant not found');
    return { restaurantId, overrides: this.overridesOf(r), effective: this.effective(r), platformDefaults: this.platform() };
  }

  /** value true / false = this restaurant's own choice; null = follow the platform default */
  async update(restaurantId: string, patch: AutomationOverrides, actor: AuthUser | null, req?: any) {
    const r = await this.restaurants.findOne({ where: { id: restaurantId } });
    if (!r) throw new NotFoundException('Restaurant not found');
    const before = this.overridesOf(r);
    const next: Record<string, boolean> = {};
    for (const k of KEYS) {
      const v = patch[k] !== undefined ? patch[k] : before[k];
      if (v !== undefined && v !== null && typeof v !== 'boolean') throw new BadRequestException(`${k} must be true, false or null`);
      if (typeof v === 'boolean') next[k] = v;
    }
    r.meta = { ...(r.meta ?? {}), automation: next };
    await this.restaurants.save(r);
    const after = this.overridesOf(r);
    if (req) await this.audit.logReq(req, 'restaurant.automation', 'restaurant', r.id, before, after);
    else await this.audit.log({ actor, action: 'restaurant.automation', entity: 'restaurant', entityId: r.id, before, after });
    return this.view(restaurantId);
  }

  // ------------------------------------------------------------------ 1. placement -> accepted
  @OnEvent(Events.ORDER_RELEASED, { async: true })
  async onPlaced({ order }: { order: Order }) {
    try {
      await this.autoAccept(order.id);
    } catch (e) {
      this.logger.warn(`auto-accept ${order.code}: ${(e as Error).message}`);
    }
  }

  /** Why an order was not auto-accepted (null = it can be). */
  private async blocker(order: Order, r: Restaurant): Promise<string | null> {
    if (!this.effective(r).autoAccept) return 'restaurant accepts manually';
    if (r.status !== RestaurantStatus.LIVE) return `restaurant is ${r.status}`;
    if (!r.acceptingOrders) return 'restaurant is not accepting orders';
    if (this.settings.get<boolean>('orders.newOrdersPaused', false)) return 'new orders are paused platform-wide';
    const cap = Number(this.settings.get<number>('automation.orders.autoAccept.maxActive', 12));
    if (cap > 0) {
      const busy = await this.orders.count({ where: { restaurantId: r.id, status: In([OrderStatus.ACCEPTED, OrderStatus.PREPARING]) } });
      if (busy >= cap) return `kitchen already has ${busy} active orders (limit ${cap})`;
    }
    return null;
  }

  /** Prep estimate: the quoted prep time + the kitchen load right now (each order already in the kitchen beyond the free slots adds a little). */
  async prepEstimate(order: Order): Promise<number> {
    const base = order.prepTimeMin ?? 20;
    const free = Number(this.settings.get<number>('automation.prep.freeSlots', 3));
    const per = Number(this.settings.get<number>('automation.prep.minutesPerExtraOrder', 1));
    const cap = Number(this.settings.get<number>('automation.prep.maxExtraMinutes', 15));
    if (per <= 0) return base;
    const inKitchen = await this.orders.count({ where: { restaurantId: order.restaurantId, status: In([OrderStatus.ACCEPTED, OrderStatus.PREPARING]) } });
    const extra = Math.min(cap, Math.max(0, inKitchen - free) * per);
    return Math.round(base + extra);
  }

  async autoAccept(orderId: string): Promise<boolean> {
    const order = await this.orders.findOne({ where: { id: orderId } });
    if (!order || order.status !== OrderStatus.PLACED) return false;
    const r = await this.restaurants.findOne({ where: { id: order.restaurantId } });
    if (!r) return false;
    const why = await this.blocker(order, r);
    if (why) {
      this.logger.debug(`${order.code} left for manual acceptance: ${why}`);
      return false;
    }
    const prepTimeMin = await this.prepEstimate(order);
    await this.ordersService.transition(order.id, OrderStatus.ACCEPTED, SYSTEM('Auto: accepted'), { prepTimeMin, note: `Auto-accepted (prep ${prepTimeMin} min)` });
    return true;
  }

  // ------------------------------------------------------------------ 2. accepted -> preparing
  @OnEvent(Events.ORDER_STATUS_CHANGED, { async: true })
  async onStatus(e: OrderStatusEvent) {
    try {
      if (e.to !== OrderStatus.ACCEPTED || e.actor?.type === ActorType.CUSTOMER) return;
      const order = await this.orders.findOne({ where: { id: e.order.id } });
      if (order && (await this.startDue(order))) await this.startPrep(order.id);
    } catch (err) {
      this.logger.warn(`auto-start ${e.order?.code}: ${(err as Error).message}`);
    }
  }

  /** Scheduled orders start cooking so that the food is ready for the driver: scheduledFor - drive time - prep time. */
  private startAt(order: Order): Date | null {
    if (!order.isScheduled || !order.scheduledFor) return null;
    const drive = Number(this.settings.get<number>('automation.scheduled.driveMinutes', 20));
    const lead = order.fulfilment === FulfilmentMode.PICKUP ? 0 : drive;
    return new Date(order.scheduledFor.getTime() - (lead + (order.prepTimeMin ?? 20)) * 60_000);
  }

  private async startDue(order: Order): Promise<boolean> {
    if (order.status !== OrderStatus.ACCEPTED && order.status !== OrderStatus.DRIVER_ASSIGNED) return false;
    const r = await this.restaurants.findOne({ where: { id: order.restaurantId } });
    if (!r || !this.effective(r).autoStartPrep) return false;
    const at = this.startAt(order);
    return !at || at.getTime() <= Date.now();
  }

  async startPrep(orderId: string): Promise<void> {
    const order = await this.orders.findOne({ where: { id: orderId } });
    if (!order) return;
    const scheduledStart = this.startAt(order);
    await this.ordersService.transition(orderId, OrderStatus.PREPARING, SYSTEM('Auto: prep started'), { note: 'Auto: kitchen ticket started' });
    await this.items.update({ orderId, kitchenStatus: 'NEW' }, { kitchenStatus: 'PREPARING' });
    // scheduled orders: ready time counts from the moment cooking really starts
    if (scheduledStart) await this.orders.update(orderId, { estimatedReadyAt: new Date(Date.now() + (order.prepTimeMin ?? 20) * 60_000) });
  }

  // ------------------------------------------------------------------ 3. preparing -> ready (timer), plus scheduled starts
  @Cron('*/15 * * * * *')
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const cache = new Map<string, Restaurant | null>();
      const rest = async (id: string) => {
        if (!cache.has(id)) cache.set(id, await this.restaurants.findOne({ where: { id } }));
        return cache.get(id)!;
      };

      // scheduled / deferred starts and accepted orders whose start was missed (restart, restaurant switched the option on later)
      const accepted = await this.orders.find({ where: { status: In([OrderStatus.ACCEPTED, OrderStatus.DRIVER_ASSIGNED]) }, take: 200 });
      for (const o of accepted) {
        if (await this.startDue(o)) await this.startPrep(o.id).catch((e) => this.logger.warn(`auto-start ${o.code}: ${e.message}`));
      }

      // a driver is waiting at the restaurant: warn the kitchen shortly before the wait-time charge starts (once per order)
      const wcfg = this.ordersService.waitFeeConfig();
      if (wcfg.enabled) {
        const waiting = await this.orders
          .createQueryBuilder('o')
          .where('o.status IN (:...st) AND o.driverId IS NOT NULL AND o.driverArrivedRestaurantAt IS NOT NULL AND o.pickedUpAt IS NULL', { st: [OrderStatus.PREPARING, OrderStatus.READY, OrderStatus.DRIVER_ASSIGNED, OrderStatus.ACCEPTED] })
          .andWhere("COALESCE(o.meta ->> 'waitWarned', 'false') <> 'true'")
          .take(100)
          .getMany();
        for (const o of waiting) {
          const start = this.ordersService.waitClockStart(o);
          if (!start) continue;
          const waited = (Date.now() - start.getTime()) / 60_000;
          if (waited < Math.max(0, wcfg.graceMinutes - 2)) continue;
          const startsIn = waited >= wcfg.graceMinutes ? 'now' : `in ${Math.max(1, Math.ceil(wcfg.graceMinutes - waited))} min`;
          await this.orders.query(`UPDATE orders SET meta = jsonb_set(COALESCE(meta, '{}'::jsonb), '{waitWarned}', 'true') WHERE id = $1`, [o.id]);
          await this.notifications.notifyRestaurant(o.restaurantId, 'driver.waiting', { code: o.code, perMinute: `$${wcfg.perMinute.toFixed(2)}`, startsIn }, { orderId: o.id }).catch(() => undefined);
        }
      }

      // prep time elapsed -> READY (the driver search starts from the READY event)
      const grace = Number(this.settings.get<number>('automation.orders.autoReady.graceSec', 0)) * 1000;
      const preparing = await this.orders.find({ where: { status: OrderStatus.PREPARING }, take: 200 });
      for (const o of preparing) {
        if (!o.estimatedReadyAt || o.estimatedReadyAt.getTime() + grace > Date.now()) continue;
        const r = await rest(o.restaurantId);
        if (!r || !this.effective(r).autoReady) continue;
        try {
          await this.items.update({ orderId: o.id }, { kitchenStatus: 'READY' });
          await this.ordersService.transition(o.id, OrderStatus.READY, SYSTEM('Auto: ready'), { note: 'Auto: prep time elapsed - order marked ready' });
        } catch (e) {
          this.logger.warn(`auto-ready ${o.code}: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      this.logger.warn(`automation tick failed: ${(e as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  // ------------------------------------------------------------------ 4. driver arrival by GPS
  /** pings arrive every ~4 s while on a trip (DriverLocationService emits Events.DRIVER_LOCATION) */
  @OnEvent(Events.DRIVER_LOCATION, { async: true })
  async onDriverLocation(p: { driverId: string; lat: number; lng: number; active: Order[] }) {
    try {
      if (!this.settings.get<boolean>('automation.driver.autoArrive', true)) return;
      const meters = Number(this.settings.get<number>('automation.driver.autoArriveMeters', 80)) / 1000;
      for (const o of p.active ?? []) {
        // cheap geometry first, on the cached active-order data: only a driver standing at a destination costs a database read
        const restaurant = await this.restaurantCoords(o);
        const nearR = !!restaurant && restaurant.lat != null && restaurant.lng != null && haversineKm(p.lat, p.lng, restaurant.lat, restaurant.lng) <= meters;
        const addr = o.deliveryAddress;
        const nearC = o.fulfilment !== FulfilmentMode.PICKUP && addr?.lat != null && addr?.lng != null && haversineKm(p.lat, p.lng, Number(addr.lat), Number(addr.lng)) <= meters;
        if (!nearR && !nearC) continue;
        // the cached status can be a few seconds old (the driver may have just picked the order up): decide on fresh data
        const fresh = await this.orders.findOne({ where: { id: o.id }, select: ['id', 'status', 'driverArrivedRestaurantAt', 'driverArrivedCustomerAt'] });
        if (!fresh) continue;
        let stage: 'RESTAURANT' | 'CUSTOMER' | null = null;
        if (nearR && [OrderStatus.DRIVER_ASSIGNED, OrderStatus.PREPARING, OrderStatus.READY].includes(fresh.status) && !fresh.driverArrivedRestaurantAt) stage = 'RESTAURANT';
        else if (nearC && [OrderStatus.PICKED_UP, OrderStatus.ON_THE_WAY].includes(fresh.status) && !fresh.driverArrivedCustomerAt) stage = 'CUSTOMER';
        if (!stage) continue;
        const key = `${o.id}:${stage}`;
        if (this.arrivalSeen.has(key)) continue;
        this.arrivalSeen.add(key);
        if (this.arrivalSeen.size > 5000) this.arrivalSeen.clear();
        await this.ordersService.driverArrived(o.id, stage, SYSTEM(`Auto: driver arrived at ${stage.toLowerCase()} (GPS)`), { lat: p.lat, lng: p.lng });
      }
    } catch (e) {
      this.logger.debug(`auto-arrive failed: ${(e as Error).message}`);
    }
  }

  private async restaurantCoords(o: Order): Promise<{ lat: number | null; lng: number | null } | null> {
    const rel = (o as any).restaurant as Restaurant | undefined;
    if (rel?.lat != null && rel?.lng != null) return { lat: Number(rel.lat), lng: Number(rel.lng) };
    const hit = this.coords.get(o.restaurantId);
    if (hit && Date.now() - hit.at < 600_000) return hit;
    const r = await this.restaurants.findOne({ where: { id: o.restaurantId }, select: ['id', 'lat', 'lng'] });
    const c = { lat: r?.lat != null ? Number(r.lat) : null, lng: r?.lng != null ? Number(r.lng) : null, at: Date.now() };
    this.coords.set(o.restaurantId, c);
    return c;
  }
}
