import { Global, Injectable, Module } from '@nestjs/common';
import { InjectDataSource, InjectRepository, TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { randomInt } from 'crypto';
import { City, MenuItem, Restaurant, RestaurantClosure, RestaurantHours, Zone } from '../database/entities';
import { RestaurantStatus, DayPart } from '../common/enums';
import { pointInPolygon, haversineKm } from '../common/geo.util';
import { SettingsService } from '../settings/settings.service';

// --------------------------------------------------------------------- time helpers
/** Wall-clock parts of `date` in an IANA time zone. */
export function zonedParts(date: Date, timeZone = 'America/Toronto') {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  });
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(date)) p[part.type] = part.value;
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  const hour = p.hour === '24' ? 0 : +p.hour;
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: hour * 60 + +p.minute, dow };
}

const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + (m || 0);
};

export function daypartOf(minutes: number): DayPart {
  if (minutes >= 5 * 60 && minutes < 11 * 60) return DayPart.BREAKFAST;
  if (minutes >= 11 * 60 && minutes < 16 * 60) return DayPart.LUNCH;
  if (minutes >= 16 * 60 && minutes < 22 * 60) return DayPart.DINNER;
  return DayPart.LATE_NIGHT;
}

export interface OpenStatus {
  open: boolean;
  /** why it is closed: HOURS | CLOSURE | PAUSED | NOT_LIVE | BUSY_PAUSE */
  reason?: string;
  opensAt?: Date | null;
  closesAt?: Date | null;
}

/**
 * Restaurant availability (hours, holiday closures, pauses, scheduling slots).
 * Used by discovery (customer app), checkout validation (orders) and the restaurant portal.
 */
@Injectable()
export class AvailabilityService {
  constructor(
    @InjectRepository(Restaurant) private restaurants: Repository<Restaurant>,
    @InjectRepository(RestaurantHours) private hours: Repository<RestaurantHours>,
    @InjectRepository(RestaurantClosure) private closures: Repository<RestaurantClosure>,
    @InjectRepository(City) private cities: Repository<City>,
  ) {}

  async timezoneFor(restaurant: Pick<Restaurant, 'cityId'>): Promise<string> {
    if (!restaurant.cityId) return 'America/Toronto';
    return (await this.cities.findOne({ where: { id: restaurant.cityId } }))?.timezone ?? 'America/Toronto';
  }

  /** Is the restaurant open (and accepting orders) at `at`? */
  async status(restaurant: Restaurant, at = new Date()): Promise<OpenStatus> {
    if (restaurant.status !== RestaurantStatus.LIVE) return { open: false, reason: 'NOT_LIVE' };
    if (!restaurant.acceptingOrders) return { open: false, reason: 'PAUSED' };
    if (restaurant.pausedUntil && restaurant.pausedUntil > at) return { open: false, reason: 'BUSY_PAUSE', opensAt: restaurant.pausedUntil };
    const tz = await this.timezoneFor(restaurant);
    const { date, minutes, dow } = zonedParts(at, tz);
    const closure = await this.closures
      .createQueryBuilder('c')
      .where('c.restaurantId = :id AND c.startDate <= :d AND c.endDate >= :d', { id: restaurant.id, d: date })
      .getOne();
    let slots = await this.hours.find({ where: { restaurantId: restaurant.id, dayOfWeek: dow } });
    if (closure) {
      if (closure.closed) return { open: false, reason: 'CLOSURE' };
      if (closure.openTime && closure.closeTime) slots = [{ openTime: closure.openTime, closeTime: closure.closeTime, closed: false } as RestaurantHours];
    }
    const allHours = await this.hours.count({ where: { restaurantId: restaurant.id } });
    if (allHours === 0) return { open: true }; // no hours configured => always open
    for (const s of slots) {
      if (s.closed) continue;
      const o = toMin(s.openTime);
      let c = toMin(s.closeTime);
      const overnight = c <= o; // e.g. 18:00 - 02:00
      const openNow = overnight ? minutes >= o || minutes < c : minutes >= o && minutes < c;
      if (openNow) {
        const minsLeft = overnight ? (minutes >= o ? 1440 - minutes + c : c - minutes) : c - minutes;
        return { open: true, closesAt: new Date(at.getTime() + minsLeft * 60_000) };
      }
    }
    return { open: false, reason: 'HOURS', opensAt: await this.nextOpening(restaurant, at) };
  }

  /** Next time the restaurant opens (looks up to 7 days ahead). */
  async nextOpening(restaurant: Restaurant, from = new Date()): Promise<Date | null> {
    const tz = await this.timezoneFor(restaurant);
    const all = await this.hours.find({ where: { restaurantId: restaurant.id } });
    if (!all.length) return null;
    for (let d = 0; d < 8; d++) {
      const probe = new Date(from.getTime() + d * 86400_000);
      const { minutes, dow } = zonedParts(probe, tz);
      const todays = all.filter((h) => h.dayOfWeek === dow && !h.closed).sort((a, b) => toMin(a.openTime) - toMin(b.openTime));
      for (const s of todays) {
        const o = toMin(s.openTime);
        if (d > 0 || o > minutes) return new Date(probe.getTime() + (o - minutes) * 60_000);
      }
    }
    return null;
  }

  /** Can this restaurant take an order for time `at` (ASAP = now, scheduled = future slot)? */
  async canOrderAt(restaurant: Restaurant, at: Date | null): Promise<{ ok: boolean; reason?: string }> {
    if (restaurant.status !== RestaurantStatus.LIVE) return { ok: false, reason: 'Restaurant is not live' };
    if (!at) {
      const s = await this.status(restaurant);
      return s.open ? { ok: true } : { ok: false, reason: `Restaurant is closed (${s.reason})` };
    }
    if (!restaurant.scheduledEnabled) return { ok: false, reason: 'Restaurant does not accept scheduled orders' };
    // Scheduled: check hours at that time, ignoring live pause flags
    const tz = await this.timezoneFor(restaurant);
    const { date, minutes, dow } = zonedParts(at, tz);
    const closure = await this.closures
      .createQueryBuilder('c')
      .where('c.restaurantId = :id AND c.startDate <= :d AND c.endDate >= :d AND c.closed = true', { id: restaurant.id, d: date })
      .getOne();
    if (closure) return { ok: false, reason: 'Restaurant is closed that day' };
    const all = await this.hours.find({ where: { restaurantId: restaurant.id } });
    if (!all.length) return { ok: true };
    const inHours = all
      .filter((h) => h.dayOfWeek === dow && !h.closed)
      .some((h) => {
        const o = toMin(h.openTime);
        const c = toMin(h.closeTime);
        return c <= o ? minutes >= o || minutes < c : minutes >= o && minutes < c;
      });
    return inHours ? { ok: true } : { ok: false, reason: 'Restaurant is closed at the selected time' };
  }

  /** Scheduled-order slots for a date (YYYY-MM-DD in restaurant tz). Capacity is checked by the caller against orders. */
  async slots(restaurant: Restaurant, dateStr: string): Promise<Date[]> {
    const tz = await this.timezoneFor(restaurant);
    const anchor = new Date(`${dateStr}T12:00:00Z`);
    const { dow } = zonedParts(anchor, tz);
    const hrs = (await this.hours.find({ where: { restaurantId: restaurant.id, dayOfWeek: dow } })).filter((h) => !h.closed);
    const step = restaurant.slotMinutes || 15;
    const out: Date[] = [];
    const earliest = Date.now() + (restaurant.scheduleLeadMin ?? 45) * 60_000;
    // Convert zoned wall clock -> UTC by probing the offset for that date
    const offsetMin = (() => {
      const p = zonedParts(anchor, tz);
      return p.minutes - (anchor.getUTCHours() * 60 + anchor.getUTCMinutes());
    })();
    for (const h of hrs) {
      const o = toMin(h.openTime);
      let c = toMin(h.closeTime);
      if (c <= o) c += 1440;
      for (let m = o; m + step <= c; m += step) {
        const utc = new Date(Date.UTC(+dateStr.slice(0, 4), +dateStr.slice(5, 7) - 1, +dateStr.slice(8, 10)) + (m - offsetMin) * 60_000);
        if (utc.getTime() >= earliest) out.push(utc);
      }
    }
    return out;
  }

  /** Effective prep time including busy mode. */
  prepTime(restaurant: Restaurant, pickup = false) {
    return (pickup ? restaurant.pickupPrepTimeMin : restaurant.prepTimeMin) + (restaurant.busyExtraPrepMin || 0);
  }

  /** Is a menu item sellable at this instant (availability toggle + daypart)? */
  itemSellable(item: MenuItem, at = new Date(), tz = 'America/Toronto') {
    if (!item.active || !item.available) return false;
    if (item.dayparts?.length) return item.dayparts.includes(daypartOf(zonedParts(at, tz).minutes));
    return true;
  }
}

/** Zone / city resolution from coordinates. */
@Injectable()
export class GeoService {
  constructor(
    @InjectRepository(Zone) private zones: Repository<Zone>,
    @InjectRepository(City) private cities: Repository<City>,
  ) {}

  /** Zone whose polygon contains the point (falls back to nearest zone centre within its radius). */
  async resolveZone(lat: number, lng: number): Promise<Zone | null> {
    const zs = await this.zones.find({ where: { active: true } });
    const inside = zs.find((z) => pointInPolygon(lat, lng, z.polygon));
    if (inside) return inside;
    let best: { z: Zone; d: number } | null = null;
    for (const z of zs) {
      if (z.polygon?.length >= 3) continue; // polygons are authoritative
      const d = haversineKm(lat, lng, z.centerLat, z.centerLng);
      const r = z.deliveryRadiusKm ?? 8;
      if (d <= r && (!best || d < best.d)) best = { z, d };
    }
    return best?.z ?? null;
  }

  async cityFor(zone: Zone | null) {
    return zone ? this.cities.findOne({ where: { id: zone.cityId } }) : null;
  }

  /** Effective zone settings: zone override -> city default. */
  effective(zone: Zone | null, city: City | null) {
    return {
      baseFee: zone?.baseFee ?? city?.baseDeliveryFee ?? 1.99,
      perKmFee: zone?.perKmFee ?? city?.perKmFee ?? 0.5,
      minimumOrder: zone?.minimumOrder ?? 0,
      radiusKm: (zone?.busyMode && zone.busyRadiusKm ? zone.busyRadiusKm : zone?.deliveryRadiusKm) ?? 5,
      maxRadiusKm: zone?.maxDeliveryRadiusKm ?? 12,
      busyMultiplier: zone?.busyMode ? zone.busyMultiplier : 1,
    };
  }
}

/** Human-friendly unique codes. */
@Injectable()
export class CodesService {
  constructor(@InjectDataSource() private ds: DataSource) {}

  private async unique(table: string, column: string, make: () => string) {
    for (let i = 0; i < 12; i++) {
      const c = make();
      const rows = await this.ds.query(`SELECT 1 FROM "${table}" WHERE "${column}" = $1 LIMIT 1`, [c]);
      if (!rows.length) return c;
    }
    return make() + randomInt(10, 99);
  }

  orderCode() {
    return this.unique('orders', 'code', () => `FK-${randomInt(100000, 999999)}`);
  }
  ticketNumber() {
    return this.unique('tickets', 'number', () => `T-${randomInt(100000, 999999)}`);
  }
  invoiceNumber(prefix = 'INV') {
    const ym = new Date().toISOString().slice(0, 7).replace('-', '');
    return this.unique('invoices', 'number', () => `${prefix}-${ym}-${randomInt(1000, 9999)}`);
  }
  /** 4-digit pickup / handoff code */
  pin(length = 4) {
    return String(randomInt(10 ** (length - 1), 10 ** length - 1));
  }
}

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([Restaurant, RestaurantHours, RestaurantClosure, City, Zone])],
  providers: [AvailabilityService, GeoService, CodesService],
  exports: [AvailabilityService, GeoService, CodesService],
})
export class CoreModule {}
