import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { DriverLocationLog, DriverProfile, Order } from '../database/entities';
import { OrderStatus } from '../common/enums';
import { roadEstimate } from '../common/geo.util';
import { RealtimeService } from '../realtime/realtime.module';
import { LazyServices } from './lazy';

export interface DriverLocationInput {
  driverId: string;
  lat: number;
  lng: number;
  heading?: number | null;
  speed?: number | null;
  orderId?: string | null;
  /** false when the websocket gateway already re-broadcast the ping (socket path) */
  emit?: boolean;
}

const TRIP_LOG_MS = 4_500; // spec 10.3: every 4-5 s while on a trip
const IDLE_LOG_MS = 30_000;
const PROFILE_WRITE_MS = 3_000;
const ETA_MS = 15_000;
const ACTIVE_CACHE_MS = 8_000;
const ON_TRIP_STATUSES = [OrderStatus.DRIVER_ASSIGNED, OrderStatus.PREPARING, OrderStatus.READY, OrderStatus.PICKED_UP, OrderStatus.ON_THE_WAY];

/**
 * Single place where a driver GPS ping is persisted. Used by the WebSocket hook (below) and by the
 * DriversModule REST endpoint (`POST /driver/location` -> `DriverLocationService.record`).
 */
@Injectable()
export class DriverLocationService implements OnModuleInit {
  private readonly logger = new Logger('DriverLocation');
  private lastLog = new Map<string, number>();
  private lastProfile = new Map<string, number>();
  private lastEta = new Map<string, number>();
  private activeCache = new Map<string, { at: number; orders: Order[] }>();
  private lazy: LazyServices;

  constructor(
    @InjectRepository(DriverProfile) private drivers: Repository<DriverProfile>,
    @InjectRepository(DriverLocationLog) private logs: Repository<DriverLocationLog>,
    @InjectRepository(Order) private orders: Repository<Order>,
    private rt: RealtimeService,
    moduleRef: ModuleRef,
  ) {
    this.lazy = new LazyServices(moduleRef);
  }

  onModuleInit() {
    // websocket pings: the gateway already emitted driver.location to ops + order rooms, we only persist
    this.rt.locationHook = (p) => {
      this.record({ driverId: p.driverId, lat: p.lat, lng: p.lng, heading: p.heading, orderId: p.orderId, emit: false }).catch((e) =>
        this.logger.warn(`ws location failed: ${e.message}`),
      );
    };
  }

  /** Active (in-flight) orders for a driver, cached for a few seconds. */
  async activeOrders(driverId: string): Promise<Order[]> {
    const c = this.activeCache.get(driverId);
    if (c && Date.now() - c.at < ACTIVE_CACHE_MS) return c.orders;
    const orders = await this.orders.find({ where: { driverId, status: In(ON_TRIP_STATUSES) }, relations: ['restaurant'] });
    this.activeCache.set(driverId, { at: Date.now(), orders });
    return orders;
  }

  invalidate(driverId: string) {
    this.activeCache.delete(driverId);
  }

  async record(p: DriverLocationInput): Promise<{ ok: boolean; onTrip: boolean; etaMin?: number | null }> {
    if (!p.driverId || !Number.isFinite(p.lat) || !Number.isFinite(p.lng) || Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180) {
      return { ok: false, onTrip: false };
    }
    const now = Date.now();
    const active = await this.activeOrders(p.driverId);
    const onTrip = active.length > 0;
    const at = new Date(now);

    // 1. driver profile position (throttled)
    if (now - (this.lastProfile.get(p.driverId) ?? 0) >= PROFILE_WRITE_MS) {
      this.lastProfile.set(p.driverId, now);
      await this.drivers.update(p.driverId, { lat: p.lat, lng: p.lng, heading: p.heading ?? null, lastLocationAt: at });
    }

    // 2. GPS trail: 4-5 s on a trip, 30 s otherwise
    const every = onTrip ? TRIP_LOG_MS : IDLE_LOG_MS;
    if (now - (this.lastLog.get(p.driverId) ?? 0) >= every - 250) {
      this.lastLog.set(p.driverId, now);
      const orderId = p.orderId ?? active[0]?.id ?? null;
      await this.logs.insert({ driverId: p.driverId, orderId, lat: p.lat, lng: p.lng, speed: p.speed ?? null });
    }

    // 3. realtime fan-out (REST path only)
    if (p.emit !== false) {
      const payload = { driverId: p.driverId, lat: p.lat, lng: p.lng, heading: p.heading ?? null, speed: p.speed ?? null, orderId: p.orderId ?? active[0]?.id ?? null, at: at.toISOString() };
      this.rt.emitToOps('driver.location', payload);
      const rooms = new Set<string>(active.map((o) => o.id));
      if (p.orderId) rooms.add(p.orderId);
      rooms.forEach((id) => this.rt.emitToOrder(id, 'driver.location', payload));
    }

    // 4. ETA recompute for in-flight orders
    let etaMin: number | null = null;
    if (onTrip) {
      for (const o of active) {
        const e = await this.updateEta(o, p.lat, p.lng, now).catch(() => null);
        if (e != null && o.id === (p.orderId ?? active[0].id)) etaMin = e;
      }
    }
    return { ok: true, onTrip, etaMin };
  }

  private async updateEta(o: Order, lat: number, lng: number, now: number): Promise<number | null> {
    const beforePickup = [OrderStatus.DRIVER_ASSIGNED, OrderStatus.PREPARING, OrderStatus.READY].includes(o.status);
    const r = o.restaurant;
    const drop = o.deliveryAddress;
    const speed = 28; // driver vehicle speed is not known here; car average
    let etaMin: number | null = null;
    let deliveryAt: Date | null = null;
    if (beforePickup && r?.lat != null && drop?.lat != null) {
      const toR = roadEstimate(lat, lng, r.lat, r.lng, speed);
      const rToC = roadEstimate(r.lat, r.lng, drop.lat, drop.lng, speed);
      const arrive = now + toR.minutes * 60_000;
      const ready = o.estimatedReadyAt ? new Date(o.estimatedReadyAt).getTime() : arrive;
      deliveryAt = new Date(Math.max(arrive, ready) + (rToC.minutes + 2) * 60_000);
      etaMin = toR.minutes;
    } else if (!beforePickup && drop?.lat != null) {
      const toC = roadEstimate(lat, lng, drop.lat, drop.lng, speed);
      deliveryAt = new Date(now + toC.minutes * 60_000);
      etaMin = toC.minutes;
    }
    if (!deliveryAt) return null;
    if (now - (this.lastEta.get(o.id) ?? 0) < ETA_MS) return etaMin;
    this.lastEta.set(o.id, now);
    const svc = this.lazy.orders;
    if (svc) await svc.setEta(o.id, undefined, deliveryAt);
    else {
      await this.orders.update(o.id, { estimatedDeliveryAt: deliveryAt });
      this.rt.emitToOrder(o.id, 'order.eta', { orderId: o.id, estimatedDeliveryAt: deliveryAt.toISOString(), driverEtaMin: etaMin });
    }
    return etaMin;
  }
}
