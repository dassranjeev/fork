import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { City, DriverOffer, DriverProfile, Order, OrderItem, Restaurant } from '../database/entities';
import { DriverStatus, OfferStatus, OrderStatus, VehicleType } from '../common/enums';
import { haversineKm, haversineSql, roadEstimate } from '../common/geo.util';
import { SettingsService } from '../settings/settings.service';
import { LazyServices } from './lazy';
import { batchCompatible, DEFAULT_WEIGHTS, scoreCandidate, ScoreWeights, vehicleSpeedKmh } from './scoring';
import { RankedCandidate } from './dispatch.types';

const ACTIVE_TRIP_STATUSES = [OrderStatus.DRIVER_ASSIGNED, OrderStatus.PREPARING, OrderStatus.READY, OrderStatus.PICKED_UP, OrderStatus.ON_THE_WAY];
/** time the driver needs to read + accept the offer before heading out (min) */
const ACCEPT_BUFFER_MIN = 0.5;

export interface RankOptions {
  radiusKm?: number;
  excludeIds?: string[];
  /** also return drivers that failed a hard rule (offline, wrong zone, too far, ...) with their reasons */
  includeIneligible?: boolean;
  limit?: number;
  now?: Date;
  /** dispatch boost to add to the estimated pay */
  boost?: number;
}

/** Candidate selection + scoring engine (spec 5.4). */
@Injectable()
export class DispatchRankingService {
  private lazy: LazyServices;

  constructor(
    @InjectRepository(DriverProfile) private drivers: Repository<DriverProfile>,
    @InjectRepository(DriverOffer) private offers: Repository<DriverOffer>,
    @InjectRepository(Order) private orders: Repository<Order>,
    @InjectRepository(OrderItem) private items: Repository<OrderItem>,
    @InjectRepository(City) private cities: Repository<City>,
    @InjectRepository(Restaurant) private restaurants: Repository<Restaurant>,
    private settings: SettingsService,
    moduleRef: ModuleRef,
  ) {
    this.lazy = new LazyServices(moduleRef);
  }

  get weights(): ScoreWeights {
    return { ...DEFAULT_WEIGHTS, ...(this.settings.get<Partial<ScoreWeights>>('dispatch.weights', {}) ?? {}) };
  }

  async city(cityId: string | null): Promise<City> {
    const c = cityId ? await this.cities.findOne({ where: { id: cityId } }) : null;
    return c ?? this.cities.create({ offerTimeoutSec: 30, offersBeforeWiden: 3, maxRadiusWidenings: 2, radiusWidenStepKm: 2, widenBoostAmount: 2, batchMaxOrders: 2, batchMaxDropDistanceKm: 1.5, batchMaxExtraMinutes: 10, driverBaseFare: 3, driverPerKm: 0.6, driverMinPerTrip: 4.5 });
  }

  initialRadiusKm(): number {
    return Number(this.settings.get('dispatch.maxInitialRadiusKm', 4)) || 4;
  }

  /** When the food is (expected to be) ready. */
  expectedReadyAt(order: Order, restaurant: Restaurant | null, now = new Date()): Date {
    if (order.status === OrderStatus.READY) return order.readyAt ? new Date(order.readyAt) : now;
    if (order.estimatedReadyAt) return new Date(order.estimatedReadyAt);
    const prep = order.prepTimeMin ?? restaurant?.prepTimeMin ?? 15;
    const base = order.acceptedAt ? new Date(order.acceptedAt) : now;
    return new Date(base.getTime() + prep * 60_000);
  }

  async estimatePay(order: Order, city: City, pickupKm: number, dropKm: number, dispatchBoost = 0) {
    let base = Math.max(Number(city.driverMinPerTrip ?? 0), Number(city.driverBaseFare ?? 0) + Number(city.driverPerKm ?? 0) * (pickupKm + dropKm));
    let boost = 0;
    const pricing = this.lazy.pricing;
    if (pricing) {
      try {
        const r = await pricing.driverPay({ cityId: order.cityId, zoneId: order.zoneId, pickupKm, dropKm, waitMin: 0, at: new Date() });
        base = r.base;
        boost = r.boost;
      } catch {
        /* fall back to local computation */
      }
    }
    const r2 = (n: number) => Math.round(n * 100) / 100;
    return { base: r2(base), boost: r2(boost + dispatchBoost), total: r2(base + boost + dispatchBoost) };
  }

  /** Ranked drivers for an order. Eligible drivers first (by score), ineligible ones (if requested) after. */
  async rank(order: Order, opts: RankOptions = {}): Promise<RankedCandidate[]> {
    const now = opts.now ?? new Date();
    const restaurant = order.restaurant ?? (await this.restaurants.findOne({ where: { id: order.restaurantId } }));
    if (!restaurant || restaurant.lat == null || restaurant.lng == null) return [];
    const city = await this.city(order.cityId ?? restaurant.cityId);
    const radiusKm = opts.radiusKm ?? this.initialRadiusKm();
    const drop = order.deliveryAddress;
    const dropRoad = order.distanceKm != null
      ? Number(order.distanceKm)
      : drop?.lat != null
        ? roadEstimate(restaurant.lat, restaurant.lng, drop.lat, drop.lng).km
        : 3;
    const readyAt = this.expectedReadyAt(order, restaurant, now);
    const w = this.weights;
    const readyWindow = Number(this.settings.get('dispatch.readyMatchWindowMin', 2));
    const bike = { maxKm: Number(this.settings.get('dispatch.bikeMaxDistanceKm', 4)), maxSubtotal: Number(this.settings.get('dispatch.bikeMaxSubtotal', 80)) };
    const freshSec = Number(this.settings.get('dispatch.locationFreshSec', 120));
    const batching = await this.batchingEnabled(order.cityId);
    const itemCount = Number((await this.items.sum('quantity', { orderId: order.id, removed: false })) ?? 0) || 1;

    const qb = this.drivers
      .createQueryBuilder('d')
      .leftJoinAndSelect('d.user', 'u')
      .where('d.status = :st', { st: DriverStatus.ACTIVE })
      .andWhere('d.lat IS NOT NULL AND d.lng IS NOT NULL')
      .setParameters({ lat: restaurant.lat, lng: restaurant.lng });
    if (opts.excludeIds?.length) qb.andWhere('d.id NOT IN (:...ex)', { ex: opts.excludeIds });
    if (opts.includeIneligible) {
      qb.orderBy(haversineSql('d.lat', 'd.lng'), 'ASC').limit(80);
    } else {
      qb.andWhere('d.isOnline = true')
        .andWhere('d.lastLocationAt >= :fresh', { fresh: new Date(now.getTime() - freshSec * 1000) })
        .andWhere(`${haversineSql('d.lat', 'd.lng')} <= :maxKm`, { maxKm: radiusKm });
    }
    const drivers = await qb.getMany();
    if (!drivers.length) return [];
    const ids = drivers.map((d) => d.id);

    const [active, pending] = await Promise.all([
      this.orders.find({ where: { driverId: In(ids), status: In(ACTIVE_TRIP_STATUSES) }, relations: ['restaurant'] }),
      this.offers
        .createQueryBuilder('o')
        .where('o.driverId IN (:...ids)', { ids })
        .andWhere('o.status = :p AND o.expiresAt > :now AND o.orderId != :oid', { p: OfferStatus.PENDING, now, oid: order.id })
        .getMany(),
    ]);
    const activeBy = new Map<string, Order[]>();
    active.forEach((o) => activeBy.set(o.driverId, [...(activeBy.get(o.driverId) ?? []), o]));
    const busy = new Set(pending.map((p) => p.driverId));

    const out: RankedCandidate[] = [];
    for (const d of drivers) {
      const reasons: string[] = [];
      const straight = haversineKm(d.lat, d.lng, restaurant.lat, restaurant.lng);
      const est = roadEstimate(d.lat, d.lng, restaurant.lat, restaurant.lng, vehicleSpeedKmh(d.vehicleType));
      if (!d.isOnline) reasons.push('OFFLINE');
      if (!d.lastLocationAt || now.getTime() - new Date(d.lastLocationAt).getTime() > freshSec * 1000) reasons.push('STALE_LOCATION');
      if (order.zoneId ? !(d.zoneIds ?? []).includes(order.zoneId) : !!order.cityId && !!d.cityId && d.cityId !== order.cityId) reasons.push('NOT_APPROVED_FOR_ZONE');
      if (straight > radiusKm) reasons.push('OUT_OF_RADIUS');
      if (busy.has(d.id)) reasons.push('HAS_PENDING_OFFER');

      const mine = activeBy.get(d.id) ?? [];
      let compatible = false;
      if (mine.length && batching && mine.length < city.batchMaxOrders) {
        const e = mine[0];
        if (e.restaurant?.lat != null && e.deliveryAddress?.lat != null && drop?.lat != null) {
          compatible = batchCompatible(
            { restaurantLat: e.restaurant.lat, restaurantLng: e.restaurant.lng, dropLat: e.deliveryAddress.lat, dropLng: e.deliveryAddress.lng, pickedUp: [OrderStatus.PICKED_UP, OrderStatus.ON_THE_WAY].includes(e.status) },
            { restaurantLat: restaurant.lat, restaurantLng: restaurant.lng, dropLat: drop.lat, dropLng: drop.lng, pickedUp: false },
            { maxDropKm: Number(city.batchMaxDropDistanceKm), maxExtraMin: city.batchMaxExtraMinutes },
          ).ok;
        }
      }
      const arrivalMs = now.getTime() + (ACCEPT_BUFFER_MIN + est.minutes) * 60_000;
      const slackMin = (readyAt.getTime() - arrivalMs) / 60_000;
      const lastOffer = d.lastOfferAt ? (now.getTime() - new Date(d.lastOfferAt).getTime()) / 60_000 : null;
      const s = scoreCandidate(
        {
          radiusKm: Math.max(radiusKm, 1),
          pickupRoadKm: est.km,
          pickupEtaMin: est.minutes,
          dropRoadKm: dropRoad,
          slackMin,
          readyWindowMin: readyWindow,
          vehicleType: d.vehicleType ?? VehicleType.CAR,
          orderSubtotal: Number(order.subtotal ?? 0),
          itemCount,
          bike,
          activeOrders: mine.length,
          batchingEnabled: batching,
          batchMaxOrders: city.batchMaxOrders,
          batchCompatible: compatible,
          acceptanceRate: Number(d.acceptanceRate ?? 100),
          onTimeRate: Number(d.onTimeRate ?? 100),
          rating: Number(d.rating ?? 5),
          minutesSinceLastOffer: lastOffer,
        },
        w,
      );
      const all = [...reasons, ...s.reasons];
      const pay = await this.estimatePay(order, city, est.km, dropRoad, opts.boost ?? 0);
      out.push({
        driverId: d.id,
        userId: d.userId,
        name: `${d.user?.firstName ?? ''} ${d.user?.lastName ?? ''}`.trim() || 'Driver',
        phone: d.user?.phone ?? null,
        vehicleType: d.vehicleType,
        lat: d.lat,
        lng: d.lng,
        distanceKm: Math.round(est.km * 100) / 100,
        etaMin: est.minutes,
        dropKm: Math.round(dropRoad * 100) / 100,
        estimatedPay: pay.total,
        score: s.score,
        breakdown: s.breakdown,
        factors: s.factors,
        eligible: all.length === 0,
        reasons: all,
        activeOrders: mine.length,
        onTrip: d.onTrip || mine.length > 0,
        lastOfferAt: d.lastOfferAt,
        lastLocationAt: d.lastLocationAt,
      });
    }
    let res = opts.includeIneligible ? out : out.filter((c) => c.eligible);
    res.sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score || a.distanceKm - b.distanceKm);
    if (opts.limit) res = res.slice(0, opts.limit);
    return res;
  }

  async batchingEnabled(cityId?: string | null): Promise<boolean> {
    try {
      return (await this.settings.isFeatureEnabled('order_batching', cityId ?? undefined)) || this.settings.get<boolean>('dispatch.batching.enabled', false) === true;
    } catch {
      return false;
    }
  }
}
