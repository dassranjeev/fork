import { randomUUID } from 'crypto';
import { DataSource, EntityManager, In, Like } from 'typeorm';
import { SeedOptions } from '../database/seed-types';
import {
  Address,
  City,
  CommissionTier,
  DriverProfile,
  LedgerEntry,
  MenuItem,
  MenuItemModifierGroup,
  ModifierGroup,
  ModifierOption,
  Order,
  OrderEvent,
  OrderItem,
  Payment,
  Promotion,
  Refund,
  Restaurant,
  Review,
  TaxClass,
  User,
  Zone,
} from '../database/entities';
import {
  ActorType,
  DriverStatus,
  FulfilmentMode,
  LedgerType,
  OrderStatus,
  OrderType,
  PartyType,
  PaymentMethod,
  PaymentStatus,
  RefundChargedTo,
  RefundStatus,
  RefundType,
  RestaurantStatus,
} from '../common/enums';
import { haversineKm, roadEstimate } from '../common/geo.util';
import { computeMoney, round2 } from './pricing.math';
import { recomputeRatingAggregates } from './rating-aggregates.service';

/**
 * Demo orders. Marker for idempotency: every seeded order has a code `FK-D00001`...; if any order with that
 * prefix exists the whole seed is skipped (real orders use `FK-<6 digits>`). Everything is inserted in one
 * transaction, so the marker can never exist without the full data set.
 */
const CODE_PREFIX = 'FK-D';
const HISTORICAL = 500;
const DAY = 86_400_000;
const MIN = 60_000;
const HST_OFFSET_HOURS = 4; // America/Toronto in EDT; only used to shape the time-of-day distribution

// ---------------------------------------------------------------- deterministic RNG
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260930);
const chance = (p: number) => rand() < p;
const between = (a: number, b: number) => a + rand() * (b - a);
const int = (a: number, b: number) => Math.floor(between(a, b + 1));
const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];
function weighted<T>(entries: [T, number][]): T {
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = rand() * total;
  for (const [v, w] of entries) {
    r -= w;
    if (r <= 0) return v;
  }
  return entries[entries.length - 1][0];
}

// ---------------------------------------------------------------- reference data
const CANCEL_CUSTOMER = ['Changed my mind', 'Ordered by mistake', 'Wait time too long', 'Wrong address selected'];
const CANCEL_RESTAURANT = ['Item out of stock', 'Kitchen equipment issue', 'Closing early today'];
const CANCEL_STAFF = ['Customer unreachable', 'Kitchen closed unexpectedly', 'Duplicate order'];
const REJECT_RESTAURANT = ['Too busy right now', 'Item unavailable', 'Closing soon'];
const NOTES = ['Please ring the bell twice', 'Leave at the door', 'No cutlery please', 'Extra napkins please', 'Allergy: please double check the sauce', 'Buzz code 4821'];
const RESTAURANT_COMMENTS: Record<number, string[]> = {
  5: ['Delicious, arrived hot and on time!', 'Best in Mississauga, will order again.', 'Generous portions and great flavour.', 'Perfect as always.'],
  4: ['Really good, just a little salty.', 'Tasty food, packaging could be better.', 'Great meal, slightly longer wait than quoted.'],
  3: ['Average. Food was lukewarm.', 'Okay but portions were small.'],
  2: ['Order was missing an item.', 'Food arrived cold and soggy.'],
  1: ['Wrong order, very disappointed.', 'Never again, terrible quality.'],
};
const DRIVER_COMMENTS: Record<number, string[]> = {
  5: ['Super friendly driver!', 'Fast and careful delivery.', 'Great communication.'],
  4: ['Good delivery.', 'Polite driver.'],
  3: ['Delivery was slow.'],
  2: ['Driver could not find the address.'],
  1: ['Driver was rude.'],
};
const RESTAURANT_TAGS = ['Great food', 'Good value', 'Fresh', 'Well packaged', 'Fast prep'];
const DRIVER_TAGS = ['Friendly', 'On time', 'Careful handling', 'Good communication'];
const REFUND_NOTES: Record<string, string> = {
  MISSING_ITEM: 'Customer reported an item missing from the bag',
  QUALITY: 'Food quality issue reported by customer',
  LATE: 'Delivery was more than 25 minutes late - delivery fee refunded',
  NEVER_ARRIVED: 'Driver marked delivered but customer never received the order',
};

interface SeedRestaurant {
  r: Restaurant;
  items: MenuItem[];
  commissionTier: CommissionTier | null;
}

interface Line {
  item: MenuItem;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  taxAmount: number;
  taxClassCode: string;
  modifiers: { groupName: string; optionId: string; name: string; priceDelta: number }[];
}

interface Step {
  to: OrderStatus;
  at: Date;
  actor: ActorType;
  actorId: string | null;
  note?: string;
}

interface Spec {
  kind: 'DELIVERY' | 'PICKUP';
  /** terminal outcome for historical orders, or the live status for active ones */
  outcome: 'COMPLETED' | 'CANCELLED' | 'REJECTED' | OrderStatus;
  placedAt?: Date;
  driverId?: string | null;
  unassigned?: boolean;
}

interface Ctx {
  now: number;
  restaurants: SeedRestaurant[];
  customers: { id: string; firstName: string; addresses: Address[] }[];
  drivers: DriverProfile[];
  cities: Map<string, City>;
  zones: Map<string, Zone>;
  taxRates: Map<string, number>;
  defaultRate: number;
  defaultTier: CommissionTier | null;
  modifiers: Map<string, { group: ModifierGroup; options: ModifierOption[] }[]>; // menuItemId -> groups
  promos: Map<string, Promotion>;
  welcomeUsed: Set<string>;
}

interface Bundle {
  orders: Record<string, any>[];
  items: Record<string, any>[];
  events: Record<string, any>[];
  payments: Record<string, any>[];
  ledger: Record<string, any>[];
  refunds: Record<string, any>[];
  reviews: Record<string, any>[];
}

// ---------------------------------------------------------------- entry point
export async function seedOrders(ds: DataSource, opts: SeedOptions): Promise<void> {
  if (!opts.demo) return;

  const existing = await ds.getRepository(Order).count({ where: { code: Like(`${CODE_PREFIX}%`) } });
  if (existing > 0) {
    console.log(`  = demo orders already seeded (${existing}) - skipped`);
    return;
  }

  const ctx = await loadContext(ds);
  if (!ctx) return;

  const bundle: Bundle = { orders: [], items: [], events: [], payments: [], ledger: [], refunds: [], reviews: [] };
  const specs = buildSpecs(ctx);
  let seq = 0;
  for (const spec of specs) {
    const code = `${CODE_PREFIX}${String(++seq).padStart(5, '0')}`;
    buildOrder(ctx, spec, code, bundle);
  }

  await ds.transaction(async (em) => {
    await bulk(em, Order, bundle.orders, 120);
    await bulk(em, OrderItem, bundle.items, 500);
    await bulk(em, OrderEvent, bundle.events, 500);
    await bulk(em, Payment, bundle.payments, 500);
    await bulk(em, Refund, bundle.refunds, 300);
    await bulk(em, LedgerEntry, bundle.ledger, 500);
    await bulk(em, Review, bundle.reviews, 300);

    // live trips: mark the assigned drivers as on a trip
    const tripDrivers = [...new Set(bundle.orders.filter((o) => o.driverId && ACTIVE.has(o.status)).map((o) => o.driverId as string))];
    if (tripDrivers.length) await em.update(DriverProfile, { id: In(tripDrivers) }, { onTrip: true, isOnline: true });
    // keep at least one active driver free and online so a fresh order can be dispatched in a demo
    const activeDrivers = await em.find(DriverProfile, { where: { status: DriverStatus.ACTIVE } });
    const freeIds = activeDrivers.map((d) => d.id).filter((id) => !tripDrivers.includes(id));
    if (freeIds.length) await em.update(DriverProfile, { id: In(freeIds) }, { onTrip: false, isOnline: true });

    await recomputeRatingAggregates(em);
  });

  const hist = bundle.orders.filter((o) => !ACTIVE.has(o.status));
  const count = (s: OrderStatus) => bundle.orders.filter((o) => o.status === s).length;
  console.log(
    `  + ${bundle.orders.length} demo orders (${hist.length} historical, ${bundle.orders.length - hist.length} active): ` +
      `${count(OrderStatus.DELIVERED)} delivered, ${count(OrderStatus.COLLECTED)} collected, ${count(OrderStatus.CANCELLED)} cancelled, ${count(OrderStatus.REJECTED)} rejected; ` +
      `${bundle.items.length} items, ${bundle.events.length} events, ${bundle.payments.length} payments, ${bundle.ledger.length} ledger rows, ${bundle.refunds.length} refunds, ${bundle.reviews.length} reviews`,
  );
}

const ACTIVE = new Set<string>([
  OrderStatus.PLACED,
  OrderStatus.ACCEPTED,
  OrderStatus.DRIVER_ASSIGNED,
  OrderStatus.PREPARING,
  OrderStatus.READY,
  OrderStatus.PICKED_UP,
  OrderStatus.ON_THE_WAY,
]);

async function bulk(em: EntityManager, entity: any, rows: Record<string, any>[], size: number) {
  for (let i = 0; i < rows.length; i += size) {
    await em.createQueryBuilder().insert().into(entity).values(rows.slice(i, i + size)).execute();
  }
}

// ---------------------------------------------------------------- loading
async function loadContext(ds: DataSource): Promise<Ctx | null> {
  const restaurantRows = await ds.getRepository(Restaurant).find({ where: { status: RestaurantStatus.LIVE } });
  const rIds = restaurantRows.map((r) => r.id);
  const menuItems = rIds.length ? await ds.getRepository(MenuItem).find({ where: { restaurantId: In(rIds), active: true, available: true } }) : [];
  const tiers = await ds.getRepository(CommissionTier).find();
  const tierById = new Map(tiers.map((t) => [t.id, t]));
  const restaurants: SeedRestaurant[] = restaurantRows
    .map((r) => ({ r, items: menuItems.filter((i) => i.restaurantId === r.id), commissionTier: r.commissionTierId ? tierById.get(r.commissionTierId) ?? null : null }))
    .filter((x) => x.items.length > 0 && x.r.lat != null && x.r.lng != null);

  const users = await ds.getRepository(User).find({ where: { email: Like('customer%@demo.forksy.ca') } });
  const addresses = users.length ? await ds.getRepository(Address).find({ where: { customerId: In(users.map((u) => u.id)) } }) : [];
  const customers = users
    .sort((a, b) => a.email!.localeCompare(b.email!, 'en', { numeric: true }))
    .map((u) => ({ id: u.id, firstName: u.firstName ?? 'Customer', addresses: addresses.filter((a) => a.customerId === u.id && a.lat != null && a.lng != null) }))
    .filter((c) => c.addresses.length > 0);

  const demoDriverUsers = await ds.getRepository(User).find({ where: { email: Like('driver%@demo.forksy.ca') } });
  const drivers = demoDriverUsers.length
    ? (await ds.getRepository(DriverProfile).find({ where: { userId: In(demoDriverUsers.map((u) => u.id)), status: DriverStatus.ACTIVE } })).sort((a, b) => {
        const ea = demoDriverUsers.find((u) => u.id === a.userId)!.email!;
        const eb = demoDriverUsers.find((u) => u.id === b.userId)!.email!;
        return ea.localeCompare(eb, 'en', { numeric: true });
      })
    : [];

  if (!restaurants.length || !customers.length || !drivers.length) {
    console.log(`  ! skipping demo orders: need restaurants (${restaurants.length}), customers (${customers.length}) and active drivers (${drivers.length}) - run earlier seeds first`);
    return null;
  }

  const links = await ds.getRepository(MenuItemModifierGroup).find({ where: { menuItemId: In(menuItems.map((i) => i.id)) } });
  const groupIds = [...new Set(links.map((l) => l.groupId))];
  const groups = groupIds.length ? await ds.getRepository(ModifierGroup).find({ where: { id: In(groupIds) } }) : [];
  const options = groupIds.length ? await ds.getRepository(ModifierOption).find({ where: { groupId: In(groupIds), available: true } }) : [];
  const modifiers = new Map<string, { group: ModifierGroup; options: ModifierOption[] }[]>();
  for (const l of links.sort((a, b) => a.sortOrder - b.sortOrder)) {
    const g = groups.find((x) => x.id === l.groupId);
    if (!g) continue;
    const opts = options.filter((o) => o.groupId === g.id).sort((a, b) => a.sortOrder - b.sortOrder);
    if (!opts.length) continue;
    const arr = modifiers.get(l.menuItemId) ?? [];
    arr.push({ group: g, options: opts });
    modifiers.set(l.menuItemId, arr);
  }

  const taxes = await ds.getRepository(TaxClass).find({ where: { active: true } });
  const defaultRate = (taxes.find((t) => t.code === 'HST_ON') ?? taxes.find((t) => t.isDefault))?.ratePct ?? 13;
  const promos = new Map((await ds.getRepository(Promotion).find()).filter((p) => p.code).map((p) => [p.code!, p]));

  return {
    now: Date.now(),
    restaurants,
    customers,
    drivers,
    cities: new Map((await ds.getRepository(City).find()).map((c) => [c.id, c])),
    zones: new Map((await ds.getRepository(Zone).find()).map((z) => [z.id, z])),
    taxRates: new Map(taxes.map((t) => [t.code, t.ratePct])),
    defaultRate,
    defaultTier: tiers.find((t) => t.isDefault && t.active) ?? null,
    modifiers,
    promos,
    welcomeUsed: new Set(),
  };
}

// ---------------------------------------------------------------- specs
function randomHistoricalTime(now: number): Date {
  const local = new Date(now - HST_OFFSET_HOURS * 3600_000);
  const dow = [1.0, 0.7, 0.7, 0.8, 0.9, 1.3, 1.4];
  for (;;) {
    const daysAgo = Math.floor(60 * Math.pow(rand(), 1.15)); // slightly more recent volume (growth)
    const day = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - daysAgo));
    if (rand() > dow[day.getUTCDay()] / 1.4) continue;
    const hour = weighted<number>([[10, 0.02], [11, 0.06], [12, 0.12], [13, 0.1], [14, 0.04], [15, 0.02], [16, 0.03], [17, 0.1], [18, 0.19], [19, 0.19], [20, 0.1], [21, 0.03]]);
    const t = day.getTime() + HST_OFFSET_HOURS * 3600_000 + hour * 3600_000 + Math.floor(rand() * 60) * MIN + Math.floor(rand() * 60) * 1000;
    if (t < now - 4 * 3600_000) return new Date(t);
  }
}

function buildSpecs(ctx: Ctx): Spec[] {
  const specs: Spec[] = [];
  for (let i = 0; i < HISTORICAL; i++) {
    const outcome = weighted<Spec['outcome']>([['COMPLETED', 0.88], ['CANCELLED', 0.06], ['REJECTED', 0.06]]);
    specs.push({ kind: chance(0.16) ? 'PICKUP' : 'DELIVERY', outcome, placedAt: randomHistoricalTime(ctx.now) });
  }
  specs.sort((a, b) => a.placedAt!.getTime() - b.placedAt!.getTime());

  // live orders: at most one per driver (first drivers are the online ones)
  const d = ctx.drivers;
  const live: Spec[] = [
    { kind: 'DELIVERY', outcome: OrderStatus.PLACED },
    { kind: 'DELIVERY', outcome: OrderStatus.PLACED },
    { kind: 'PICKUP', outcome: OrderStatus.PLACED },
    { kind: 'DELIVERY', outcome: OrderStatus.ACCEPTED },
    { kind: 'DELIVERY', outcome: OrderStatus.ACCEPTED },
    { kind: 'PICKUP', outcome: OrderStatus.ACCEPTED },
    { kind: 'DELIVERY', outcome: OrderStatus.DRIVER_ASSIGNED, driverId: d[0]?.id },
    { kind: 'DELIVERY', outcome: OrderStatus.PREPARING, driverId: d[1]?.id },
    { kind: 'PICKUP', outcome: OrderStatus.PREPARING },
    { kind: 'DELIVERY', outcome: OrderStatus.READY, unassigned: true },
    { kind: 'PICKUP', outcome: OrderStatus.READY },
    { kind: 'DELIVERY', outcome: OrderStatus.PICKED_UP, driverId: d[2]?.id },
    { kind: 'DELIVERY', outcome: OrderStatus.ON_THE_WAY, driverId: d[3]?.id },
    { kind: 'DELIVERY', outcome: OrderStatus.ON_THE_WAY, driverId: d[4]?.id },
  ];
  return [...specs, ...live];
}

// ---------------------------------------------------------------- building one order
function chooseLines(ctx: Ctx, sr: SeedRestaurant, pickup: boolean, minSubtotal: number): Line[] {
  const n = weighted<number>([[1, 0.25], [2, 0.4], [3, 0.25], [4, 0.1]]);
  const used = new Set<string>();
  const lines: Line[] = [];
  const add = () => {
    const pool = sr.items.filter((i) => !used.has(i.id));
    if (!pool.length) return false;
    const item = pick(pool);
    used.add(item.id);
    const mods: Line['modifiers'] = [];
    for (const { group, options } of ctx.modifiers.get(item.id) ?? []) {
      const max = group.maxSelect > 0 ? Math.min(group.maxSelect, options.length) : options.length;
      const min = group.required ? Math.max(1, group.minSelect) : group.minSelect;
      const count = Math.min(max, group.required || min > 0 ? Math.max(min, 1) : chance(0.35) ? int(1, Math.min(2, max)) : 0);
      const chosen = [...options].sort(() => rand() - 0.5).slice(0, count);
      for (const o of chosen) mods.push({ groupName: group.name, optionId: o.id, name: o.name, priceDelta: o.priceDelta });
    }
    const base = pickup && item.pickupPrice != null ? item.pickupPrice : item.price;
    const unitPrice = round2(base + mods.reduce((s, m) => s + m.priceDelta, 0));
    const quantity = weighted<number>([[1, 0.75], [2, 0.2], [3, 0.05]]);
    const lineTotal = round2(unitPrice * quantity);
    const taxClassCode = item.taxClassCode ?? 'HST_ON';
    const rate = ctx.taxRates.get(taxClassCode) ?? ctx.defaultRate;
    lines.push({ item, quantity, unitPrice, lineTotal, taxAmount: round2((lineTotal * rate) / 100), taxClassCode, modifiers: mods });
    return true;
  };
  for (let i = 0; i < n; i++) add();
  while (round2(lines.reduce((s, l) => s + l.lineTotal, 0)) < minSubtotal && add()) {
    /* keep adding until the delivery minimum is met */
  }
  return lines;
}

function buildOrder(ctx: Ctx, spec: Spec, code: string, out: Bundle) {
  // ---- customer, fulfilment, restaurant, address (delivery radius like the real quote: straight line within the restaurant radius)
  let customer = pick(ctx.customers.slice(0, Math.max(6, Math.floor(ctx.customers.length * (0.4 + rand() * 0.6)))));
  let kind = spec.kind;
  let address: Address | null = null;
  let sr: SeedRestaurant | null = null;
  if (kind === 'DELIVERY') {
    for (let tries = 0; tries < 30 && !address; tries++) {
      const c = tries === 0 ? customer : pick(ctx.customers);
      const a = pick(c.addresses);
      const near = ctx.restaurants.filter((x) => haversineKm(x.r.lat!, x.r.lng!, a.lat!, a.lng!) <= (x.r.deliveryRadiusKm || 6));
      if (near.length) {
        customer = c;
        address = a;
        sr = pick(near);
      }
    }
    if (!address) kind = 'PICKUP';
  }
  if (!sr) sr = pick(ctx.restaurants);
  const r = sr.r;
  const zone = r.zoneId ? ctx.zones.get(r.zoneId) ?? null : null;
  const city = ctx.cities.get(r.cityId ?? zone?.cityId ?? '') ?? [...ctx.cities.values()][0];
  const pickup = kind === 'PICKUP';
  const fulfilment = pickup ? FulfilmentMode.PICKUP : FulfilmentMode.PLATFORM_DRIVER;
  const est = address ? roadEstimate(r.lat!, r.lng!, address.lat!, address.lng!) : { km: 0, minutes: 0 };
  const distanceKm = pickup ? null : Math.round(est.km * 1000) / 1000;

  // ---- lines + money (same formulas as PricingService.quote / computeMoney)
  const minOrder = pickup ? 0 : Math.max(r.minimumOrder ?? 0, zone?.minimumOrder ?? 0);
  const lines = chooseLines(ctx, sr, pickup, minOrder);
  const subtotal = round2(lines.reduce((s, l) => s + l.lineTotal, 0));
  const foodTax = round2(lines.reduce((s, l) => s + l.taxAmount, 0));
  const baseFee = zone?.baseFee ?? city?.baseDeliveryFee ?? 1.99;
  const perKm = zone?.perKmFee ?? city?.perKmFee ?? 0.5;
  const deliveryFee = pickup ? 0 : round2(baseFee + perKm * (distanceKm ?? 0));
  const serviceFee = round2(Math.min(((city?.serviceFeePct ?? 10) * subtotal) / 100, city?.serviceFeeCap ?? 5));
  const smallOrderFee = subtotal < (city?.smallOrderThreshold ?? 15) ? round2(city?.smallOrderFee ?? 2) : 0;

  const completed = spec.outcome === 'COMPLETED';
  let tip = 0;
  if (!pickup && (completed || ACTIVE.has(spec.outcome as string)) && chance(0.78)) {
    tip = chance(0.5) ? pick([2, 3, 4, 5, 6]) : Math.round((subtotal * pick([0.1, 0.15, 0.18, 0.2])) * 2) / 2;
  } else if (pickup && chance(0.1)) tip = pick([1, 2]);

  // promotions (platform funded), only for codes seeded by the marketing seed
  let discountTotal = 0;
  let promoCode: string | null = null;
  let promotionId: string | null = null;
  const tryPromo = (c: string, amt: number) => {
    const p = ctx.promos.get(c);
    if (!p || amt <= 0) return false;
    discountTotal = Math.min(round2(amt), round2(subtotal + deliveryFee));
    promoCode = c;
    promotionId = p.id;
    return true;
  };
  if (!ctx.welcomeUsed.has(customer.id) && chance(0.25) && tryPromo('WELCOME10', (subtotal * 10) / 100)) ctx.welcomeUsed.add(customer.id);
  else if (!pickup && chance(0.08)) tryPromo('FREEDEL', deliveryFee);
  else if (subtotal >= 25 && chance(0.06)) tryPromo('SAVE5', 5);
  const platformPromoAmount = discountTotal;
  const restaurantPromoAmount = 0;

  const tier = sr.commissionTier ?? ctx.defaultTier;
  const commissionPct = pickup
    ? r.pickupCommissionPct ?? tier?.pickupPct ?? 8
    : r.deliveryCommissionPct ?? tier?.deliveryPct ?? 20;
  const money = computeMoney({
    subtotal,
    foodTax,
    deliveryFee,
    serviceFee,
    smallOrderFee,
    tip,
    discountTotal,
    platformPromoAmount,
    restaurantPromoAmount,
    fulfilment,
    feeTaxRatePct: ctx.defaultRate,
    taxOnDeliveryFee: true,
    taxOnFees: true,
    commissionPct,
  });

  // ---- driver pay (PricingService.driverPay without incentives; boost stored separately)
  let driverId: string | null = null;
  let driverPay = 0;
  let driverBoost = 0;
  const needsDriver = !pickup && (completed || (ACTIVE.has(spec.outcome as string) && !!spec.driverId));
  if (needsDriver) {
    driverId = spec.driverId ?? pick(ctx.drivers).id;
    const raw = (city?.driverBaseFare ?? 3) + (city?.driverPerKm ?? 0.6) * (distanceKm ?? 0);
    driverPay = round2(Math.max(raw, city?.driverMinPerTrip ?? 4.5));
    if (completed && chance(0.1)) driverBoost = pick([1.5, 2, 3]);
  }

  // ---- timeline
  const prepNominal = (r.prepTimeMin ?? 20) + pick([0, 0, 0, 5, 10]);
  const acceptM = between(0.5, 3.5);
  const assignM = between(1, 4);
  const prepStartM = between(0.5, 2);
  const lateRestaurant = completed && chance(pickup ? 0.05 : 0.1);
  const lateDriver = completed && !pickup && chance(0.04);
  const prepActualM = prepNominal * between(0.85, 1.1) + (lateRestaurant ? between(14, 30) : 0);
  const pickedUpM = between(0.5, 4) + (lateDriver ? between(12, 25) : 0);
  const onWayM = between(0.5, 1.5);
  const driveM = Math.max(3, est.minutes * between(0.9, 1.2));
  const collectM = between(2, 14);

  const offsets: { to: OrderStatus; m: number; actor: ActorType }[] = [{ to: OrderStatus.PLACED, m: 0, actor: ActorType.CUSTOMER }];
  let cum = 0;
  const push = (to: OrderStatus, dm: number, actor: ActorType) => {
    cum += dm;
    offsets.push({ to, m: cum, actor });
  };
  const wantsFull = completed || ACTIVE.has(spec.outcome as string);
  if (wantsFull) {
    push(OrderStatus.ACCEPTED, acceptM, ActorType.RESTAURANT);
    if (!pickup && driverId) push(OrderStatus.DRIVER_ASSIGNED, assignM, ActorType.SYSTEM);
    push(OrderStatus.PREPARING, prepStartM, ActorType.RESTAURANT);
    push(OrderStatus.READY, prepActualM, ActorType.RESTAURANT);
    if (pickup) push(OrderStatus.COLLECTED, collectM, ActorType.RESTAURANT);
    else {
      if (driverId) push(OrderStatus.PICKED_UP, pickedUpM, ActorType.DRIVER);
      if (driverId) push(OrderStatus.ON_THE_WAY, onWayM, ActorType.DRIVER);
      if (driverId) push(OrderStatus.DELIVERED, driveM, ActorType.DRIVER);
    }
  }
  // truncate to the target status
  let steps = offsets;
  let finalStatus: OrderStatus;
  let cancelledBy: ActorType | null = null;
  let cancelReason: string | null = null;
  let rejectReason: string | null = null;

  if (completed) {
    finalStatus = pickup ? OrderStatus.COLLECTED : OrderStatus.DELIVERED;
  } else if (ACTIVE.has(spec.outcome as string)) {
    finalStatus = spec.outcome as OrderStatus;
    let idx = offsets.findIndex((o) => o.to === finalStatus);
    if (idx < 0) idx = offsets.map((o) => ACTIVE.has(o.to)).lastIndexOf(true); // e.g. unassigned READY / pickup fallback
    steps = offsets.slice(0, idx + 1);
    finalStatus = steps[steps.length - 1].to;
  } else if (spec.outcome === 'CANCELLED') {
    finalStatus = OrderStatus.CANCELLED;
    const how = weighted<'C' | 'R' | 'S'>([['C', 0.45], ['R', 0.3], ['S', 0.25]]);
    steps = [{ to: OrderStatus.PLACED, m: 0, actor: ActorType.CUSTOMER }];
    let t = 0;
    const seq: [OrderStatus, number, ActorType][] = [[OrderStatus.ACCEPTED, acceptM, ActorType.RESTAURANT], [OrderStatus.PREPARING, prepStartM + 1, ActorType.RESTAURANT]];
    for (const [to, dm, actor] of seq.slice(0, how === 'R' ? 1 : how === 'S' ? 2 : 0)) {
      t += dm;
      steps.push({ to, m: t, actor });
    }
    cancelledBy = how === 'C' ? ActorType.CUSTOMER : how === 'R' ? ActorType.RESTAURANT : ActorType.STAFF;
    cancelReason = pick(how === 'C' ? CANCEL_CUSTOMER : how === 'R' ? CANCEL_RESTAURANT : CANCEL_STAFF);
    steps.push({ to: OrderStatus.CANCELLED, m: t + between(1, 6), actor: cancelledBy });
  } else {
    finalStatus = OrderStatus.REJECTED;
    const system = chance(0.3);
    cancelledBy = system ? ActorType.SYSTEM : ActorType.RESTAURANT;
    rejectReason = system ? 'No response within 180 seconds' : pick(REJECT_RESTAURANT);
    steps = [{ to: OrderStatus.PLACED, m: 0, actor: ActorType.CUSTOMER }, { to: OrderStatus.REJECTED, m: system ? 3 : between(0.5, 2.8), actor: cancelledBy }];
  }

  // anchor the clock
  const lastM = steps[steps.length - 1].m;
  let placedAt: Date;
  if (spec.placedAt) placedAt = spec.placedAt;
  else placedAt = new Date(ctx.now - (lastM + (finalStatus === OrderStatus.PLACED ? between(0.3, 1.6) : between(0.5, 2.5))) * MIN);
  const at = (m: number) => new Date(placedAt.getTime() + m * MIN);
  const timeline: Step[] = steps.map((s) => ({
    to: s.to,
    at: at(s.m),
    actor: s.actor,
    actorId: s.actor === ActorType.CUSTOMER ? customer.id : s.actor === ActorType.RESTAURANT ? r.id : s.actor === ActorType.DRIVER ? driverId : null,
    note: s.to === OrderStatus.CANCELLED ? cancelReason ?? undefined : s.to === OrderStatus.REJECTED ? rejectReason ?? undefined : undefined,
  }));
  const tAt = (st: OrderStatus) => timeline.find((s) => s.to === st)?.at ?? null;

  const acceptedAt = tAt(OrderStatus.ACCEPTED);
  const estimatedReadyAt = acceptedAt ? new Date(acceptedAt.getTime() + prepNominal * MIN) : null;
  // quoted ETA: realistic allowance for assignment, prep variance, pickup and drive time
  const estimatedDeliveryAt = pickup
    ? estimatedReadyAt && new Date(estimatedReadyAt.getTime() + (prepStartM + prepNominal * 0.1 + 14) * MIN)
    : new Date(placedAt.getTime() + (acceptM + assignM + prepStartM + prepNominal * 1.1 + 3 + est.minutes * 1.2 + 5) * MIN);
  const finishedAt = tAt(pickup ? OrderStatus.COLLECTED : OrderStatus.DELIVERED);
  const isLate = !!finishedAt && !!estimatedDeliveryAt && finishedAt.getTime() > estimatedDeliveryAt.getTime() + 5 * MIN;
  const cancelledAt = tAt(OrderStatus.CANCELLED) ?? tAt(OrderStatus.REJECTED);
  const live = ACTIVE.has(finalStatus);
  const isUnassigned = !pickup && live && !driverId && [OrderStatus.PREPARING, OrderStatus.READY].includes(finalStatus) && !!spec.unassigned;

  const orderId = randomUUID();
  const method = weighted<PaymentMethod>([[PaymentMethod.CARD, 0.7], [PaymentMethod.APPLE_PAY, 0.15], [PaymentMethod.GOOGLE_PAY, 0.15]]);
  const intentId = `pi_mock_${orderId.replace(/-/g, '').slice(0, 20)}`;
  const total = money.total;
  const readyAt = tAt(OrderStatus.READY);
  const pickedUpAt = tAt(OrderStatus.PICKED_UP);
  const feeRevenue = round2((pickup ? 0 : deliveryFee) + serviceFee + smallOrderFee - platformPromoAmount);
  const platformRevenue = completed ? round2(feeRevenue + money.commissionAmount) : 0;

  // ---- refunds (completed orders only)
  const refundRows: Record<string, any>[] = [];
  // the card is charged when the order is placed; a rejected / cancelled order is refunded in full
  let paymentStatus: PaymentStatus = live || completed ? PaymentStatus.CAPTURED : PaymentStatus.REFUNDED;
  const refundPayments: Record<string, any>[] = [];
  const refundLedger: Record<string, any>[] = [];
  const refundEvents: Record<string, any>[] = [];
  if (completed && finishedAt) {
    const wantRefund = chance(isLate && !pickup ? 0.3 : 0.035);
    if (wantRefund) {
      const reason = isLate && !pickup && chance(0.7) ? 'LATE' : weighted<string>([['MISSING_ITEM', 0.45], ['QUALITY', 0.4], ['NEVER_ARRIVED', pickup ? 0 : 0.15]]);
      let amount: number;
      let chargedTo: RefundChargedTo;
      if (reason === 'LATE') {
        amount = deliveryFee > 0 ? deliveryFee : serviceFee;
        chargedTo = RefundChargedTo.PLATFORM;
      } else if (reason === 'MISSING_ITEM') {
        const l = pick(lines);
        amount = round2(l.unitPrice * (1 + (ctx.taxRates.get(l.taxClassCode) ?? ctx.defaultRate) / 100));
        chargedTo = chance(0.7) ? RefundChargedTo.RESTAURANT : RefundChargedTo.PLATFORM;
      } else if (reason === 'QUALITY') {
        amount = chance(0.35) ? round2(subtotal + foodTax) : round2((subtotal + foodTax) * pick([0.3, 0.5]));
        chargedTo = RefundChargedTo.RESTAURANT;
      } else {
        amount = total;
        chargedTo = RefundChargedTo.DRIVER;
      }
      amount = Math.min(round2(amount), total);
      if (amount > 0) {
        const processedAt = new Date(Math.min(finishedAt.getTime() + between(20, 600) * MIN, ctx.now - 60_000));
        const auto = amount < 15 && reason !== 'NEVER_ARRIVED';
        const refundId = randomUUID();
        refundRows.push({
          id: refundId,
          orderId,
          ticketId: null,
          amount,
          type: RefundType.REFUND,
          chargedTo,
          reasonCode: reason,
          notes: REFUND_NOTES[reason],
          status: RefundStatus.PROCESSED,
          createdById: null,
          createdByType: auto ? 'SYSTEM' : 'STAFF',
          approvedById: null,
          processedAt,
          auto,
          createdAt: processedAt,
          updatedAt: processedAt,
        });
        paymentStatus = amount >= total - 0.01 ? PaymentStatus.REFUNDED : PaymentStatus.PARTIALLY_REFUNDED;
        refundPayments.push({ id: randomUUID(), orderId, provider: 'mock', kind: 'REFUND', amount, currency: 'CAD', status: 'SUCCEEDED', externalId: `re_mock_${refundId.replace(/-/g, '').slice(0, 20)}`, meta: { reason }, createdAt: processedAt, updatedAt: processedAt });
        const ledgerBase = { orderId, type: LedgerType.REFUND, amount: -amount, currency: 'CAD', description: `Refund: ${reason}`, payoutId: null, meta: null, createdAt: processedAt, updatedAt: processedAt };
        if (chargedTo === RefundChargedTo.RESTAURANT) refundLedger.push({ id: randomUUID(), ...ledgerBase, partyType: PartyType.RESTAURANT, partyId: r.merchantId, restaurantId: r.id });
        else if (chargedTo === RefundChargedTo.DRIVER && driverId) refundLedger.push({ id: randomUUID(), ...ledgerBase, partyType: PartyType.DRIVER, partyId: driverId, restaurantId: null });
        else refundLedger.push({ id: randomUUID(), ...ledgerBase, partyType: PartyType.PLATFORM, partyId: null, restaurantId: null });
        refundEvents.push({ id: randomUUID(), orderId, type: 'REFUND', fromStatus: null, toStatus: null, actorType: auto ? ActorType.SYSTEM : ActorType.STAFF, actorId: null, note: `Refund $${amount.toFixed(2)} (${reason})`, data: { amount, reasonCode: reason, chargedTo }, createdAt: processedAt, updatedAt: processedAt });
      }
    }
  }

  const lastAt = timeline[timeline.length - 1].at;
  out.orders.push({
    id: orderId,
    code,
    customerId: customer.id,
    restaurantId: r.id,
    driverId,
    zoneId: r.zoneId ?? zone?.id ?? null,
    cityId: r.cityId ?? city?.id ?? null,
    type: pickup ? OrderType.PICKUP : OrderType.DELIVERY,
    fulfilment,
    status: finalStatus,
    deliveryAddress: address
      ? { label: address.label, line1: address.line1, line2: address.line2, city: address.city, province: address.province, postalCode: address.postalCode, lat: address.lat, lng: address.lng, dropoffNotes: address.dropoffNotes }
      : null,
    isScheduled: false,
    scheduledFor: null,
    prepTimeMin: acceptedAt ? prepNominal : null,
    estimatedReadyAt,
    estimatedDeliveryAt,
    acceptDeadlineAt: new Date(placedAt.getTime() + 180_000),
    acceptedAt,
    driverAssignedAt: tAt(OrderStatus.DRIVER_ASSIGNED),
    preparingAt: tAt(OrderStatus.PREPARING),
    readyAt,
    pickedUpAt,
    onTheWayAt: tAt(OrderStatus.ON_THE_WAY),
    deliveredAt: finishedAt,
    cancelledAt,
    driverArrivedRestaurantAt: driverId && readyAt && pickedUpAt ? new Date(Math.min(pickedUpAt.getTime() - 30_000, readyAt.getTime()) - between(0, 2) * MIN) : null,
    driverArrivedCustomerAt: driverId && finishedAt ? new Date(finishedAt.getTime() - 60_000) : null,
    subtotal,
    deliveryFee,
    serviceFee,
    smallOrderFee,
    taxAmount: money.taxAmount,
    tip,
    discountTotal,
    platformPromoAmount,
    restaurantPromoAmount,
    walletUsed: 0,
    total,
    promotionId,
    promoCode,
    commissionPct,
    commissionAmount: money.commissionAmount,
    restaurantPayout: money.restaurantPayout,
    driverPay,
    driverBoost,
    platformRevenue,
    distanceKm,
    paymentMethod: method,
    paymentStatus,
    paymentIntentId: intentId,
    tipEditableUntil: finishedAt && tip > 0 ? new Date(finishedAt.getTime() + 60 * MIN) : null,
    pickupCode: pickup ? String(int(1000, 9999)) : null,
    deliveryPin: !pickup && total >= 100 ? String(int(1000, 9999)) : null,
    requiresPin: !pickup && total >= 100,
    contactless: !pickup && chance(0.3),
    proofPhotoUrl: !pickup && finalStatus === OrderStatus.DELIVERED ? `/uploads/demo/proof-${code.toLowerCase()}.jpg` : null,
    customerNotes: chance(0.15) ? pick(NOTES) : null,
    hasAllergyFlag: lines.some((l) => l.item.allergens?.includes('nuts')) && chance(0.3),
    isLate,
    escalationLevel: isLate ? (lateRestaurant ? 1 : 2) : isUnassigned ? 2 : 0,
    unassignedFlag: isUnassigned,
    cancelReason,
    cancelledBy,
    cancellationFee: 0,
    rejectReason,
    source: chance(0.85) ? 'app' : 'web',
    meta: { seed: true },
    createdAt: placedAt,
    updatedAt: lastAt,
  });

  // ---- items
  const kitchen = (): 'NEW' | 'PREPARING' | 'READY' =>
    [OrderStatus.PLACED, OrderStatus.ACCEPTED, OrderStatus.DRIVER_ASSIGNED].includes(finalStatus) ? 'NEW' : finalStatus === OrderStatus.PREPARING ? 'PREPARING' : 'READY';
  for (const l of lines) {
    out.items.push({
      id: randomUUID(),
      orderId,
      menuItemId: l.item.id,
      name: l.item.name,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      lineTotal: l.lineTotal,
      taxAmount: l.taxAmount,
      taxClassCode: l.taxClassCode,
      modifiers: l.modifiers,
      notes: null,
      stationId: l.item.stationId,
      allergens: l.item.allergens ?? [],
      kitchenStatus: kitchen(),
      removed: false,
      removedReason: null,
      createdAt: placedAt,
      updatedAt: placedAt,
    });
  }

  // ---- events
  let prev: OrderStatus | null = null;
  for (const s of timeline) {
    out.events.push({
      id: randomUUID(),
      orderId,
      type: 'STATUS_CHANGE',
      fromStatus: prev,
      toStatus: s.to,
      actorType: s.actor,
      actorId: s.actorId,
      note: s.note ?? null,
      data: { from: prev, to: s.to },
      createdAt: s.at,
      updatedAt: s.at,
    });
    prev = s.to;
  }
  if (isLate && finishedAt && estimatedDeliveryAt) {
    const flagAt = new Date(estimatedDeliveryAt.getTime() + 5 * MIN);
    out.events.push({ id: randomUUID(), orderId, type: 'FLAG', fromStatus: null, toStatus: null, actorType: ActorType.SYSTEM, actorId: null, note: 'Order is running late', data: { flag: 'LATE', lateByMin: Math.round((finishedAt.getTime() - estimatedDeliveryAt.getTime()) / MIN) }, createdAt: flagAt, updatedAt: flagAt });
  }
  out.events.push(...refundEvents);

  // ---- payments
  // the card is charged the moment the order is placed ...
  out.payments.push({ id: randomUUID(), orderId, provider: 'mock', kind: 'CAPTURE', amount: total, currency: 'CAD', status: 'SUCCEEDED', externalId: `${intentId}_cap`, meta: null, createdAt: placedAt, updatedAt: placedAt });
  // ... and goes back in full when the order is rejected or cancelled
  if (!live && !completed && cancelledAt) {
    out.payments.push({ id: randomUUID(), orderId, provider: 'mock', kind: 'REFUND', amount: total, currency: 'CAD', status: 'SUCCEEDED', externalId: `re_mock_${orderId.replace(/-/g, '').slice(0, 20)}`, meta: { reason: 'ORDER_CANCELLED' }, createdAt: cancelledAt, updatedAt: cancelledAt });
  }
  out.payments.push(...refundPayments);
  out.refunds.push(...refundRows);

  // ---- ledger: mirrors LedgerService.settleOrder for DELIVERED / COLLECTED
  if (completed && finishedAt) {
    const row = (p: Partial<Record<string, any>>) =>
      out.ledger.push({ id: randomUUID(), orderId, currency: 'CAD', payoutId: null, meta: null, restaurantId: null, partyId: null, createdAt: finishedAt, updatedAt: finishedAt, ...p });
    const restaurantRow = (type: LedgerType, amount: number, description: string) =>
      row({ partyType: PartyType.RESTAURANT, partyId: r.merchantId, restaurantId: r.id, type, amount, description });
    restaurantRow(LedgerType.SALE, round2(subtotal + money.taxAmount), `Order ${code}`);
    if (money.commissionAmount > 0) restaurantRow(LedgerType.COMMISSION, -money.commissionAmount, `Commission on ${code}`);
    if (restaurantPromoAmount > 0) restaurantRow(LedgerType.RESTAURANT_PROMO, -restaurantPromoAmount, `Restaurant-funded promo on ${code}`);
    if (driverId) {
      if (driverPay > 0) row({ partyType: PartyType.DRIVER, partyId: driverId, type: LedgerType.DELIVERY_PAY, amount: driverPay, description: `Delivery pay for ${code}` });
      if (tip > 0) row({ partyType: PartyType.DRIVER, partyId: driverId, type: LedgerType.TIP, amount: tip, description: `Tip on ${code}` });
      if (driverBoost > 0) row({ partyType: PartyType.DRIVER, partyId: driverId, type: LedgerType.BOOST, amount: driverBoost, description: `Incentive boost on ${code}` });
    }
    if (feeRevenue !== 0) row({ partyType: PartyType.PLATFORM, partyId: null, type: LedgerType.FEE_REVENUE, amount: feeRevenue, description: `Fees on ${code}` });
    if (money.commissionAmount > 0) row({ partyType: PartyType.PLATFORM, partyId: null, type: LedgerType.COMMISSION_REVENUE, amount: money.commissionAmount, description: `Commission revenue on ${code}` });
    out.ledger.push(...refundLedger);
  }

  // ---- review (about 55% of completed orders)
  if (completed && finishedAt && chance(0.55)) {
    const base = weighted<number>([[5, 0.55], [4, 0.25], [3, 0.1], [2, 0.06], [1, 0.04]]);
    const restaurantRating = Math.max(1, base - (refundRows.length ? 1 : 0));
    const driverRating = driverId ? Math.max(1, base - (isLate ? 1 : 0)) : null;
    const createdAt = new Date(Math.min(finishedAt.getTime() + between(15, 600) * MIN, ctx.now - 30_000));
    const replies = restaurantRating <= 3 && chance(0.6);
    out.reviews.push({
      id: randomUUID(),
      orderId,
      customerId: customer.id,
      restaurantId: r.id,
      driverId,
      restaurantRating,
      driverRating,
      restaurantTags: restaurantRating >= 4 ? [pick(RESTAURANT_TAGS)] : [],
      driverTags: driverRating && driverRating >= 4 ? [pick(DRIVER_TAGS)] : [],
      comment: chance(0.7) ? pick(RESTAURANT_COMMENTS[restaurantRating]) : null,
      driverComment: driverRating && chance(0.4) ? pick(DRIVER_COMMENTS[driverRating]) : null,
      reply: replies ? `Thanks for letting us know, ${customer.firstName}. We're sorry this missed the mark and have shared your feedback with the kitchen.` : null,
      repliedAt: replies ? new Date(Math.min(createdAt.getTime() + between(60, 1440) * MIN, ctx.now - 10_000)) : null,
      status: 'VISIBLE',
      createdAt,
      updatedAt: createdAt,
    });
  }
}
