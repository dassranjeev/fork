import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Brackets, DataSource, In } from 'typeorm';
import {
  Banner,
  City,
  Cuisine,
  CustomerProfile,
  Favorite,
  MenuCategory,
  MenuItem,
  MenuItemModifierGroup,
  ModifierGroup,
  ModifierOption,
  Order,
  Promotion,
  Restaurant,
  RestaurantHours,
  Review,
  User,
  Zone,
} from '../database/entities';
import { OrderStatus, RestaurantServiceMode, RestaurantStatus } from '../common/enums';
import { fulfilmentAvailability } from '../common/service-mode';
import { haversineKm, haversineSql, roadEstimate } from '../common/geo.util';
import { AvailabilityService, daypartOf, GeoService, zonedParts } from '../core/core.module';
import { SettingsService } from '../settings/settings.service';
import { assertLatLng, csv, isUuid, maskName, num, parseBool, round2 } from './util';

export interface Loc {
  lat: number;
  lng: number;
  /** false = no coordinates were supplied, city centre was used */
  located: boolean;
  zone: Zone | null;
  city: City | null;
  eff: ReturnType<GeoService['effective']>;
}

export interface RestaurantCard {
  id: string;
  slug: string;
  name: string;
  logoUrl: string | null;
  coverUrl: string | null;
  cuisines: string[];
  rating: number;
  ratingCount: number;
  priceLevel: number;
  distanceKm: number | null;
  etaMinutes: number | null;
  etaRange: { min: number; max: number } | null;
  deliveryFee: number | null;
  minimumOrder: number;
  isOpen: boolean;
  status: { open: boolean; reason: string | null; opensAt: Date | null; closesAt: Date | null };
  nextOpening: Date | null;
  canSchedule: boolean;
  /** service mode right now + what the customer can order (mode-aware; delivery also needs the customer inside the delivery radius) */
  serviceMode: RestaurantServiceMode;
  serviceModeLabel: string;
  deliveryAvailable: boolean;
  pickupAvailable: boolean;
  /** delivery capability + radius ignoring the service mode (lets clients show "closed" stores that normally deliver here) */
  inDeliveryRange: boolean;
  isNew: boolean;
  isFeatured: boolean;
  isFavorite: boolean;
  promo: { label: string; code: string | null } | null;
}

const promoLabel = (p: Promotion) => {
  switch (p.type) {
    case 'PERCENT':
      return `${p.value}% off`;
    case 'FIXED':
      return `$${p.value} off`;
    case 'FREE_DELIVERY':
      return 'Free delivery';
    case 'BOGO':
      return 'Buy one, get one';
    default:
      return 'Free item';
  }
};

const DEFAULT_CENTER = { lat: 43.589, lng: -79.6441 };
const MAX_DISCOVERY_KM = 30;

@Injectable()
export class DiscoveryService {
  constructor(
    @InjectDataSource() private ds: DataSource,
    private availability: AvailabilityService,
    private geo: GeoService,
    private settings: SettingsService,
  ) {}

  // ------------------------------------------------------------------ location
  async resolveLocation(latIn?: number, lngIn?: number): Promise<Loc> {
    assertLatLng(latIn, lngIn);
    const located = latIn !== undefined && lngIn !== undefined;
    let lat = latIn ?? DEFAULT_CENTER.lat;
    let lng = lngIn ?? DEFAULT_CENTER.lng;
    let zone: Zone | null = null;
    let city: City | null = null;
    if (located) {
      zone = await this.geo.resolveZone(lat, lng);
      city = await this.geo.cityFor(zone);
    }
    if (!city) {
      const cities = await this.ds.getRepository(City).find({ where: { active: true }, order: { createdAt: 'ASC' } });
      if (located) {
        city = cities.filter((c) => haversineKm(lat, lng, c.centerLat, c.centerLng) <= 40).sort((a, b) => haversineKm(lat, lng, a.centerLat, a.centerLng) - haversineKm(lat, lng, b.centerLat, b.centerLng))[0] ?? null;
      } else {
        city = cities[0] ?? null;
        if (city) {
          lat = city.centerLat;
          lng = city.centerLng;
        }
      }
    }
    return { lat, lng, located, zone, city, eff: this.geo.effective(zone, city) };
  }

  // ------------------------------------------------------------------ shared building blocks
  private async activePromos(restaurantIds: string[], cityId: string | null) {
    const now = new Date();
    const qb = this.ds
      .getRepository(Promotion)
      .createQueryBuilder('p')
      .where('p.active = true AND p.pendingApproval = false')
      .andWhere('(p.startsAt IS NULL OR p.startsAt <= :now) AND (p.endsAt IS NULL OR p.endsAt >= :now)', { now })
      .andWhere('(p.usageLimit IS NULL OR p.usedCount < p.usageLimit)');
    if (restaurantIds.length) {
      qb.andWhere(new Brackets((b) => b.where('p.restaurantId IN (:...ids)', { ids: restaurantIds }).orWhere('p.restaurantId IS NULL')));
    } else qb.andWhere('p.restaurantId IS NULL');
    const all = await qb.orderBy('p.createdAt', 'DESC').limit(300).getMany();
    return all.filter((p) => !p.cityId || !cityId || p.cityId === cityId);
  }

  private pickPromo(r: Restaurant, promos: Promotion[]) {
    const own = promos.find((p) => p.restaurantId === r.id);
    const platform = promos.find((p) => !p.restaurantId && p.autoApply);
    const p = own ?? platform;
    return p ? { label: promoLabel(p), code: p.code } : null;
  }

  /** Nearby LIVE restaurants (SQL prefilter) with cuisines loaded, nearest first. */
  private async nearby(loc: Loc, limit = 150): Promise<Restaurant[]> {
    const rows = await this.ds
      .getRepository(Restaurant)
      .createQueryBuilder('r')
      .leftJoinAndSelect('r.cuisines', 'c')
      .where('r.status = :live', { live: RestaurantStatus.LIVE })
      .andWhere('r.lat IS NOT NULL AND r.lng IS NOT NULL')
      .andWhere(`${haversineSql('r.lat', 'r.lng')} <= :maxKm`, { lat: loc.lat, lng: loc.lng, maxKm: MAX_DISCOVERY_KM })
      .getMany();
    const d = (r: Restaurant) => haversineKm(loc.lat, loc.lng, r.lat!, r.lng!);
    return rows.sort((a, b) => d(a) - d(b)).slice(0, limit);
  }

  private feeFor(loc: Loc, distanceKm: number) {
    const raw = (loc.eff.baseFee + loc.eff.perKmFee * distanceKm) * (loc.eff.busyMultiplier || 1);
    return round2(raw);
  }

  private async buildCards(list: Restaurant[], loc: Loc, opts: { favorites?: Set<string>; promos?: Promotion[] } = {}): Promise<RestaurantCard[]> {
    const promos = opts.promos ?? (await this.activePromos(list.map((r) => r.id), loc.city?.id ?? null));
    const buffer = this.settings.get<number>('orders.quotedEtaBufferMin', 5);
    const now = new Date();
    return Promise.all(
      list.map(async (r) => {
        const st = await this.availability.status(r, now);
        const nextOpening = st.open ? null : st.opensAt ?? (await this.availability.nextOpening(r, now));
        const km = r.lat != null && r.lng != null ? haversineKm(loc.lat, loc.lng, r.lat, r.lng) : null;
        const radius = Math.min(r.deliveryRadiusKm ?? 5, loc.eff.maxRadiusKm || 12);
        const av = fulfilmentAvailability(r);
        const inDeliveryRange = (r.deliveryEnabled || r.ownDeliveryEnabled) && km !== null && km <= radius;
        const deliveryAvailable = av.deliveryAvailable && inDeliveryRange;
        const pickupAvailable = av.pickupAvailable;
        let eta: number | null = null;
        if (km !== null) {
          const road = roadEstimate(loc.lat, loc.lng, r.lat!, r.lng!);
          eta = deliveryAvailable ? this.availability.prepTime(r) + road.minutes + buffer : this.availability.prepTime(r, true);
        }
        return {
          id: r.id,
          slug: r.slug,
          name: r.name,
          logoUrl: r.logoUrl,
          coverUrl: r.coverUrl,
          cuisines: (r.cuisines ?? []).map((c) => c.name),
          rating: r.rating,
          ratingCount: r.ratingCount,
          priceLevel: r.priceLevel,
          distanceKm: km === null ? null : round2(km),
          etaMinutes: eta,
          etaRange: eta === null ? null : { min: eta, max: eta + 10 },
          deliveryFee: km === null ? null : deliveryAvailable ? (r.ownDeliveryEnabled && !r.deliveryEnabled ? r.ownDeliveryFee : this.feeFor(loc, km)) : 0,
          minimumOrder: Math.max(r.minimumOrder ?? 0, deliveryAvailable ? loc.eff.minimumOrder ?? 0 : 0),
          isOpen: st.open,
          status: { open: st.open, reason: st.reason ?? null, opensAt: st.opensAt ?? null, closesAt: st.closesAt ?? null },
          nextOpening,
          canSchedule: r.scheduledEnabled && !st.open && av.serviceMode !== RestaurantServiceMode.CLOSED,
          serviceMode: av.serviceMode,
          serviceModeLabel: av.serviceModeLabel,
          deliveryAvailable,
          pickupAvailable,
          inDeliveryRange,
          isNew: r.isNew || (!!r.wentLiveAt && now.getTime() - r.wentLiveAt.getTime() < 30 * 86400_000),
          isFeatured: r.isFeatured,
          isFavorite: opts.favorites?.has(r.id) ?? false,
          promo: this.pickPromo(r, promos),
        } satisfies RestaurantCard;
      }),
    );
  }

  private async favoritesOf(customerId?: string) {
    if (!customerId) return new Set<string>();
    const rows = await this.ds.getRepository(Favorite).find({ where: { customerId } });
    return new Set(rows.map((f) => f.restaurantId));
  }

  // ------------------------------------------------------------------ home feed
  async home(latIn?: number, lngIn?: number, customerId?: string) {
    const loc = await this.resolveLocation(latIn, lngIn);
    const [list, favorites] = await Promise.all([this.nearby(loc), this.favoritesOf(customerId)]);
    const promos = await this.activePromos(list.map((r) => r.id), loc.city?.id ?? null);
    const cards = (await this.buildCards(list, loc, { favorites, promos })).filter((c) => c.deliveryAvailable || (c.pickupAvailable && (c.distanceKm ?? 99) <= 10) || (c.serviceMode === RestaurantServiceMode.CLOSED && c.inDeliveryRange));
    // CLOSED stores that normally deliver here stay in the lists (shown as closed, sorted after open ones)
    const deliverable = cards.filter((c) => c.deliveryAvailable || (c.serviceMode === RestaurantServiceMode.CLOSED && c.inDeliveryRange));
    const pickupOnlyStores = cards.filter((c) => c.serviceMode === RestaurantServiceMode.PICKUP_ONLY && c.pickupAvailable);
    const byDistance = (a: RestaurantCard, b: RestaurantCard) => (a.distanceKm ?? 99) - (b.distanceKm ?? 99);
    const openFirst = (a: RestaurantCard, b: RestaurantCard) => Number(b.isOpen) - Number(a.isOpen);
    const score = (c: RestaurantCard) => c.rating * Math.log(c.ratingCount + 2) + (c.isFeatured ? 3 : 0);

    // popular = rating x volume, boosted by real order volume in the last 30 days
    const orderCounts = await this.ds
      .getRepository(Order)
      .createQueryBuilder('o')
      .select('o.restaurantId', 'id')
      .addSelect('COUNT(*)', 'n')
      .where('o.restaurantId IN (:...ids)', { ids: deliverable.map((c) => c.id).concat('00000000-0000-0000-0000-000000000000') })
      .andWhere('o.createdAt > :d', { d: new Date(Date.now() - 30 * 86400_000) })
      .andWhere('o.status IN (:...s)', { s: [OrderStatus.DELIVERED, OrderStatus.COLLECTED] })
      .groupBy('o.restaurantId')
      .getRawMany<{ id: string; n: string }>();
    const volume = new Map(orderCounts.map((r) => [r.id, +r.n]));

    const nearby = [...deliverable].sort((a, b) => openFirst(a, b) || byDistance(a, b));
    const popular = [...deliverable].sort((a, b) => Number(b.isOpen) - Number(a.isOpen) || score(b) + Math.log((volume.get(b.id) ?? 0) + 1) * 2 - (score(a) + Math.log((volume.get(a.id) ?? 0) + 1) * 2));
    const fresh = deliverable.filter((c) => c.isNew).sort((a, b) => Number(b.isOpen) - Number(a.isOpen) || byDistance(a, b));
    const fastest = deliverable.filter((c) => c.isOpen && c.etaMinutes !== null).sort((a, b) => a.etaMinutes! - b.etaMinutes!);
    const deals = deliverable.filter((c) => c.promo).sort((a, b) => Number(b.isOpen) - Number(a.isOpen) || byDistance(a, b));

    // cuisine tiles: active cuisines with count of nearby restaurants
    const cuisineCount = new Map<string, number>();
    for (const r of list) for (const c of r.cuisines ?? []) if (deliverable.some((d) => d.id === r.id)) cuisineCount.set(c.id, (cuisineCount.get(c.id) ?? 0) + 1);
    const cuisines = (await this.ds.getRepository(Cuisine).find({ where: { active: true }, order: { sortOrder: 'ASC', name: 'ASC' } }))
      .map((c) => ({ id: c.id, slug: c.slug, name: c.name, iconUrl: c.iconUrl, restaurantCount: cuisineCount.get(c.id) ?? 0 }))
      .filter((c) => c.restaurantCount > 0);

    const banners = await this.banners(loc.city?.id ?? null, 'HOME');
    const platformPromos = promos.filter((p) => !p.restaurantId && p.code && p.autoApply === false).slice(0, 5).map((p) => ({ id: p.id, code: p.code, name: p.name, description: p.description, label: promoLabel(p), minSubtotal: p.minSubtotal, endsAt: p.endsAt }));

    return {
      location: {
        lat: loc.lat,
        lng: loc.lng,
        located: loc.located,
        serviceable: loc.located ? deliverable.length > 0 || !!loc.zone : true,
        zone: loc.zone ? { id: loc.zone.id, name: loc.zone.name, busy: loc.zone.busyMode } : null,
        city: loc.city ? { id: loc.city.id, name: loc.city.name, timezone: loc.city.timezone } : null,
      },
      banners,
      cuisines,
      nearby: nearby.slice(0, 20),
      pickupOnly: [...pickupOnlyStores].sort(byDistance).slice(0, 20),
      popular: popular.slice(0, 12),
      new: fresh.slice(0, 12),
      deals: deals.slice(0, 12),
      fastest: fastest.slice(0, 12),
      favorites: customerId ? cards.filter((c) => c.isFavorite).slice(0, 12) : [],
      promotions: platformPromos,
      counts: { restaurants: deliverable.length, open: deliverable.filter((c) => c.isOpen).length, pickupOnly: pickupOnlyStores.length },
    };
  }

  async banners(cityId: string | null, placement: Banner['placement'] = 'HOME') {
    const now = new Date();
    const rows = await this.ds
      .getRepository(Banner)
      .createQueryBuilder('b')
      .where('b.active = true AND b.placement = :pl', { pl: placement })
      .andWhere('(b.cityId IS NULL OR b.cityId = :city)', { city: cityId ?? '00000000-0000-0000-0000-000000000000' })
      .andWhere('(b.startsAt IS NULL OR b.startsAt <= :now) AND (b.endsAt IS NULL OR b.endsAt >= :now)', { now })
      .orderBy('b.sortOrder', 'ASC')
      .addOrderBy('b.createdAt', 'DESC')
      .getMany();
    return rows.map((b) => ({ id: b.id, title: b.title, subtitle: b.subtitle, imageUrl: b.imageUrl, link: b.link, placement: b.placement }));
  }

  // ------------------------------------------------------------------ search
  async search(
    q: {
      q?: string;
      lat?: string;
      lng?: string;
      type?: string;
      priceLevel?: string;
      minRating?: string;
      maxFee?: string;
      maxEta?: string;
      dietary?: string;
      excludeAllergens?: string;
      cuisine?: string;
      pickupOnly?: string;
      /** pickup | delivery: only stores where that fulfilment is available right now */
      fulfilment?: string;
      openNow?: string;
      sort?: string;
      page?: string;
      limit?: string;
    },
    customerId?: string,
  ) {
    const loc = await this.resolveLocation(num(q.lat), num(q.lng));
    const text = (q.q ?? '').trim();
    const tokens = text.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
    const type = ['restaurants', 'dishes', 'cuisines'].includes(q.type ?? '') ? q.type! : 'all';
    const page = Math.max(1, num(q.page) ?? 1);
    const limit = Math.min(50, Math.max(1, num(q.limit) ?? 20));
    const fulfilmentFilter = ['pickup', 'delivery'].includes((q.fulfilment ?? '').toLowerCase()) ? (q.fulfilment as string).toLowerCase() : null;
    const pickupOnly = (parseBool(q.pickupOnly) ?? false) || fulfilmentFilter === 'pickup';
    const openNow = parseBool(q.openNow) ?? false;
    const prices = csv(q.priceLevel).map(Number).filter((n) => n >= 1 && n <= 4);
    const minRating = num(q.minRating);
    const maxFee = num(q.maxFee);
    const maxEta = num(q.maxEta);
    const dietary = csv(q.dietary).map((d) => d.toLowerCase());
    const exclude = csv(q.excludeAllergens).map((d) => d.toLowerCase());
    const cuisineSlugs = csv(q.cuisine).map((s) => s.toLowerCase());

    const list = await this.nearby(loc);
    const favorites = await this.favoritesOf(customerId);
    let cards = await this.buildCards(list, loc, { favorites });
    const byId = new Map(list.map((r) => [r.id, r]));

    // reachability: delivery within radius, or pickup within 25 km (pickupOnly shows everything pickup-capable)
    cards = cards.filter((c) =>
      fulfilmentFilter === 'delivery'
        ? c.deliveryAvailable
        : pickupOnly
          ? c.pickupAvailable
          : c.deliveryAvailable || (c.pickupAvailable && (c.distanceKm ?? 99) <= 25) || (c.serviceMode === RestaurantServiceMode.CLOSED && (c.inDeliveryRange || (c.distanceKm ?? 99) <= 25)),
    );
    if (openNow) cards = cards.filter((c) => c.isOpen);
    if (prices.length) cards = cards.filter((c) => prices.includes(c.priceLevel));
    if (minRating !== undefined) cards = cards.filter((c) => c.rating >= minRating);
    if (maxFee !== undefined) cards = cards.filter((c) => pickupOnly || (c.deliveryFee ?? 0) <= maxFee);
    if (maxEta !== undefined) cards = cards.filter((c) => c.etaMinutes !== null && c.etaMinutes <= maxEta);
    if (cuisineSlugs.length) cards = cards.filter((c) => byId.get(c.id)!.cuisines.some((cu) => cuisineSlugs.includes(cu.slug)));

    const ids = cards.map((c) => c.id);
    // dietary: restaurant must offer at least one sellable item for every requested tag
    if (dietary.length && ids.length) {
      let allowed = new Set(ids);
      for (const tag of dietary) {
        const rows = await this.ds
          .getRepository(MenuItem)
          .createQueryBuilder('i')
          .select('DISTINCT i.restaurantId', 'id')
          .where('i.restaurantId IN (:...ids)', { ids })
          .andWhere('i.active = true AND i.available = true')
          .andWhere(`i.dietaryTags @> :tag::jsonb`, { tag: JSON.stringify([tag]) })
          .getRawMany<{ id: string }>();
        const s = new Set(rows.map((r) => r.id));
        allowed = new Set([...allowed].filter((x) => s.has(x)));
      }
      cards = cards.filter((c) => allowed.has(c.id));
    }

    // dish matches
    type DishRow = MenuItem;
    let dishes: DishRow[] = [];
    const cardIds = cards.map((c) => c.id);
    if ((type === 'all' || type === 'dishes') && cardIds.length && (tokens.length || dietary.length)) {
      const qb = this.ds
        .getRepository(MenuItem)
        .createQueryBuilder('i')
        .where('i.restaurantId IN (:...ids)', { ids: cardIds })
        .andWhere('i.active = true');
      tokens.forEach((t, i) => qb.andWhere(`(i.name ILIKE :t${i} OR i.description ILIKE :t${i})`, { [`t${i}`]: `%${t.replace(/[%_\\]/g, (m) => `\\${m}`)}%` }));
      dietary.forEach((d, i) => qb.andWhere(`i.dietaryTags @> :dt${i}::jsonb`, { [`dt${i}`]: JSON.stringify([d]) }));
      dishes = await qb.orderBy('i.isPopular', 'DESC').limit(400).getMany();
      if (exclude.length) dishes = dishes.filter((d) => !d.allergens.some((a) => exclude.includes(String(a).toLowerCase())));
    }
    const dishesByRest = new Map<string, DishRow[]>();
    for (const d of dishes) dishesByRest.set(d.restaurantId, [...(dishesByRest.get(d.restaurantId) ?? []), d]);

    const textMatch = (c: RestaurantCard) => {
      if (!tokens.length) return 0;
      const r = byId.get(c.id)!;
      const hay = `${r.name} ${(r.cuisines ?? []).map((x) => x.name).join(' ')} ${r.description ?? ''}`.toLowerCase();
      if (!tokens.every((t) => hay.includes(t))) return 0;
      const name = r.name.toLowerCase();
      if (name === text.toLowerCase()) return 100;
      if (name.startsWith(tokens[0])) return 80;
      if (name.includes(text.toLowerCase())) return 60;
      return 40;
    };

    let matched = cards
      .map((c) => ({ c, s: textMatch(c), dishCount: dishesByRest.get(c.id)?.length ?? 0 }))
      .filter((x) => (tokens.length ? x.s > 0 || x.dishCount > 0 : true));
    if (type === 'dishes' || type === 'cuisines') matched = type === 'cuisines' ? matched : [];

    const sort = q.sort ?? 'relevance';
    const cmp: Record<string, (a: (typeof matched)[number], b: (typeof matched)[number]) => number> = {
      relevance: (a, b) => Number(b.c.isOpen) - Number(a.c.isOpen) || b.s + b.dishCount * 5 - (a.s + a.dishCount * 5) || (a.c.distanceKm ?? 99) - (b.c.distanceKm ?? 99),
      distance: (a, b) => (a.c.distanceKm ?? 99) - (b.c.distanceKm ?? 99),
      rating: (a, b) => b.c.rating - a.c.rating || b.c.ratingCount - a.c.ratingCount,
      eta: (a, b) => (a.c.etaMinutes ?? 999) - (b.c.etaMinutes ?? 999),
      fee: (a, b) => (a.c.deliveryFee ?? 99) - (b.c.deliveryFee ?? 99),
      price_low: (a, b) => a.c.priceLevel - b.c.priceLevel || b.c.rating - a.c.rating,
      price_high: (a, b) => b.c.priceLevel - a.c.priceLevel || b.c.rating - a.c.rating,
      popular: (a, b) => b.c.ratingCount * b.c.rating - a.c.ratingCount * a.c.rating,
    };
    matched.sort(cmp[sort] ?? cmp.relevance);
    // CLOSED stores always last (stable)
    matched = [...matched.filter((m) => m.c.serviceMode !== RestaurantServiceMode.CLOSED), ...matched.filter((m) => m.c.serviceMode === RestaurantServiceMode.CLOSED)];
    const total = matched.length;
    const restaurants = matched.slice((page - 1) * limit, page * limit).map(({ c }) => ({
      ...c,
      matchedDishes: (dishesByRest.get(c.id) ?? []).slice(0, 3).map((d) => ({ id: d.id, name: d.name, price: d.price, imageUrl: d.imageUrl })),
    }));

    const cardMap = new Map(cards.map((c) => [c.id, c]));
    const dishOut = (type === 'all' || type === 'dishes' ? dishes : [])
      .filter((d) => cardMap.has(d.restaurantId))
      .sort((a, b) => Number(cardMap.get(b.restaurantId)!.isOpen) - Number(cardMap.get(a.restaurantId)!.isOpen) || (cardMap.get(a.restaurantId)!.distanceKm ?? 99) - (cardMap.get(b.restaurantId)!.distanceKm ?? 99))
      .slice(0, type === 'dishes' ? limit : 20)
      .map((d) => {
        const c = cardMap.get(d.restaurantId)!;
        return {
          id: d.id,
          name: d.name,
          description: d.description,
          imageUrl: d.imageUrl,
          price: d.price,
          dietaryTags: d.dietaryTags,
          allergens: d.allergens,
          available: d.available,
          restaurant: { id: c.id, slug: c.slug, name: c.name, logoUrl: c.logoUrl, isOpen: c.isOpen, distanceKm: c.distanceKm, etaMinutes: c.etaMinutes },
        };
      });

    // cuisines: name match over active cuisines, with count of reachable restaurants
    let cuisines: { id: string; slug: string; name: string; iconUrl: string | null; restaurantCount: number }[] = [];
    if (type === 'all' || type === 'cuisines') {
      const all = await this.ds.getRepository(Cuisine).find({ where: { active: true }, order: { sortOrder: 'ASC' } });
      cuisines = all
        .filter((c) => !tokens.length || tokens.every((t) => c.name.toLowerCase().includes(t)))
        .map((c) => ({ id: c.id, slug: c.slug, name: c.name, iconUrl: c.iconUrl, restaurantCount: cards.filter((k) => byId.get(k.id)!.cuisines.some((cu) => cu.id === c.id)).length }))
        .filter((c) => c.restaurantCount > 0);
    }

    return {
      query: text,
      location: { lat: loc.lat, lng: loc.lng, located: loc.located },
      restaurants: type === 'dishes' ? [] : restaurants,
      dishes: dishOut,
      cuisines: type === 'restaurants' || type === 'dishes' ? [] : cuisines,
      meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    };
  }

  // ------------------------------------------------------------------ restaurant page
  async findRestaurant(slugOrId: string): Promise<Restaurant> {
    const repo = this.ds.getRepository(Restaurant);
    const r = await repo.findOne({ where: isUuid(slugOrId) ? { id: slugOrId } : { slug: slugOrId }, relations: { cuisines: true } });
    if (!r || ![RestaurantStatus.LIVE, RestaurantStatus.PAUSED].includes(r.status)) throw new NotFoundException('Restaurant not found');
    return r;
  }

  /** Full menu with modifier groups. `tz` decides which items are inside their daypart right now. */
  async buildMenu(r: Restaurant, opts: { customerAllergens?: string[]; customerDiet?: string[] } = {}) {
    const [cats, items] = await Promise.all([
      this.ds.getRepository(MenuCategory).find({ where: { restaurantId: r.id, active: true }, order: { sortOrder: 'ASC', name: 'ASC' } }),
      this.ds.getRepository(MenuItem).find({ where: { restaurantId: r.id, active: true }, order: { sortOrder: 'ASC', name: 'ASC' } }),
    ]);
    const itemIds = items.map((i) => i.id);
    const links = itemIds.length ? await this.ds.getRepository(MenuItemModifierGroup).find({ where: { menuItemId: In(itemIds) }, order: { sortOrder: 'ASC' } }) : [];
    const groupIds = [...new Set(links.map((l) => l.groupId))];
    const groups = groupIds.length ? await this.ds.getRepository(ModifierGroup).find({ where: { id: In(groupIds) } }) : [];
    const options = groupIds.length ? await this.ds.getRepository(ModifierOption).find({ where: { groupId: In(groupIds) }, order: { sortOrder: 'ASC', name: 'ASC' } }) : [];
    const groupMap = new Map(groups.map((g) => [g.id, g]));
    const tz = await this.availability.timezoneFor(r);
    const now = new Date();
    const part = daypartOf(zonedParts(now, tz).minutes);
    const catMap = new Map(cats.map((c) => [c.id, c]));
    const allergenSet = new Set((opts.customerAllergens ?? []).map((a) => a.toLowerCase()));

    const shape = (i: MenuItem) => {
      const cat = i.categoryId ? catMap.get(i.categoryId) : undefined;
      const catBlocked = !!cat?.dayparts?.length && !cat.dayparts.includes(part);
      const sellable = this.availability.itemSellable(i, now, tz) && !catBlocked;
      const dayBlocked = catBlocked || (!!i.dayparts?.length && !i.dayparts.includes(part));
      return {
        id: i.id,
        name: i.name,
        description: i.description,
        imageUrl: i.imageUrl,
        price: i.price,
        pickupPrice: i.pickupPrice,
        calories: i.calories,
        allergens: i.allergens,
        dietaryTags: i.dietaryTags,
        isPopular: i.isPopular,
        isCombo: i.isCombo,
        dayparts: i.dayparts,
        available: sellable,
        unavailableReason: sellable ? null : !i.available ? 'OUT_OF_STOCK' : dayBlocked ? 'NOT_SERVED_NOW' : 'UNAVAILABLE',
        allergenConflict: i.allergens.filter((a) => allergenSet.has(String(a).toLowerCase())),
        modifierGroups: links
          .filter((l) => l.menuItemId === i.id && groupMap.has(l.groupId))
          .map((l) => {
            const g = groupMap.get(l.groupId)!;
            return {
              id: g.id,
              name: g.name,
              required: g.required || g.minSelect > 0,
              minSelect: g.required ? Math.max(1, g.minSelect) : g.minSelect,
              maxSelect: g.maxSelect,
              options: options.filter((o) => o.groupId === g.id).map((o) => ({ id: o.id, name: o.name, priceDelta: o.priceDelta, isDefault: o.isDefault, available: o.available })),
            };
          }),
      };
    };

    const categories = cats
      .map((c) => ({ id: c.id as string | null, name: c.name, description: c.description, dayparts: c.dayparts, items: items.filter((i) => i.categoryId === c.id).map(shape) }))
      .filter((c) => c.items.length);
    const loose = items.filter((i) => !i.categoryId || !catMap.has(i.categoryId));
    if (loose.length) categories.push({ id: null, name: 'Other', description: null, dayparts: [], items: loose.map(shape) });
    const popular = items.filter((i) => i.isPopular).slice(0, 8).map(shape);
    return { categories, popular };
  }

  async restaurantPage(slugOrId: string, latIn?: number, lngIn?: number, customerId?: string) {
    const r = await this.findRestaurant(slugOrId);
    const loc = await this.resolveLocation(latIn, lngIn);
    let profile: CustomerProfile | null = null;
    if (customerId) profile = await this.ds.getRepository(CustomerProfile).findOne({ where: { userId: customerId } });
    const favorites = await this.favoritesOf(customerId);
    const [card] = await this.buildCards([r], loc, { favorites });
    const [menu, hours, reviews, promos] = await Promise.all([
      this.buildMenu(r, { customerAllergens: profile?.allergens }),
      this.ds.getRepository(RestaurantHours).find({ where: { restaurantId: r.id }, order: { dayOfWeek: 'ASC', openTime: 'ASC' } }),
      this.recentReviews(r.id, 5),
      this.activePromos([r.id], r.cityId),
    ]);
    const relevant = promos.filter((p) => p.restaurantId === r.id || (!p.restaurantId && (p.autoApply || p.code)));
    const tz = await this.availability.timezoneFor(r);
    return {
      restaurant: {
        ...card,
        description: r.description,
        photos: r.photos,
        phone: r.phone,
        website: r.website,
        address: { line1: r.addressLine1, line2: r.addressLine2, city: r.city, province: r.province, postalCode: r.postalCode, lat: r.lat, lng: r.lng },
        timezone: tz,
        deliveryRadiusKm: r.deliveryRadiusKm,
        prepTimeMin: this.availability.prepTime(r),
        pickupPrepTimeMin: this.availability.prepTime(r, true),
        fulfilment: { delivery: r.deliveryEnabled, ownDelivery: r.ownDeliveryEnabled, pickup: r.pickupEnabled, scheduled: r.scheduledEnabled },
        serviceModeUpdatedAt: r.serviceModeUpdatedAt,
        serviceModeResumeAt: r.serviceModeResumeAt,
        pickupInstructions: r.pickupInstructions,
        parkingNotes: r.parkingNotes,
        schedule: { slotMinutes: r.slotMinutes, leadMinutes: r.scheduleLeadMin, maxDaysAhead: this.settings.get<number>('orders.maxScheduleDays', 3) },
        hours: hours.map((h) => ({ dayOfWeek: h.dayOfWeek, openTime: h.openTime, closeTime: h.closeTime, closed: h.closed })),
      },
      promos: relevant.slice(0, 6).map((p) => ({ id: p.id, code: p.code, name: p.name, description: p.description, label: promoLabel(p), minSubtotal: p.minSubtotal, restaurantFunded: !!p.restaurantId, autoApply: p.autoApply, endsAt: p.endsAt })),
      menu,
      reviews,
    };
  }

  async recentReviews(restaurantId: string, limit = 10) {
    const rows = await this.ds
      .getRepository(Review)
      .createQueryBuilder('v')
      .where('v.restaurantId = :id AND v.status = :s AND v.restaurantRating IS NOT NULL', { id: restaurantId, s: 'VISIBLE' })
      .orderBy('v.createdAt', 'DESC')
      .limit(limit)
      .getMany();
    const users = rows.length ? await this.ds.getRepository(User).find({ where: { id: In(rows.map((v) => v.customerId)) } }) : [];
    const um = new Map(users.map((u) => [u.id, u]));
    return rows.map((v) => ({
      id: v.id,
      rating: v.restaurantRating,
      tags: v.restaurantTags,
      comment: v.comment,
      reply: v.reply,
      repliedAt: v.repliedAt,
      author: maskName(um.get(v.customerId)?.firstName, um.get(v.customerId)?.lastName),
      createdAt: v.createdAt,
    }));
  }

  async reviewsPage(slugOrId: string, page = 1, limit = 20) {
    const r = await this.findRestaurant(slugOrId);
    const [rows, total] = await this.ds
      .getRepository(Review)
      .createQueryBuilder('v')
      .where('v.restaurantId = :id AND v.status = :s AND v.restaurantRating IS NOT NULL', { id: r.id, s: 'VISIBLE' })
      .orderBy('v.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
    const users = rows.length ? await this.ds.getRepository(User).find({ where: { id: In(rows.map((v) => v.customerId)) } }) : [];
    const um = new Map(users.map((u) => [u.id, u]));
    return {
      summary: { rating: r.rating, ratingCount: r.ratingCount },
      data: rows.map((v) => ({ id: v.id, rating: v.restaurantRating, tags: v.restaurantTags, comment: v.comment, reply: v.reply, repliedAt: v.repliedAt, author: maskName(um.get(v.customerId)?.firstName, um.get(v.customerId)?.lastName), createdAt: v.createdAt })),
      meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    };
  }

  // ------------------------------------------------------------------ scheduled-order slots
  async slots(slugOrId: string, dateStr: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr ?? '')) throw new BadRequestException('date must be YYYY-MM-DD');
    const r = await this.findRestaurant(slugOrId);
    if (!r.scheduledEnabled || r.serviceMode === RestaurantServiceMode.CLOSED) return { date: dateStr, enabled: false, slotMinutes: r.slotMinutes, timezone: await this.availability.timezoneFor(r), slots: [] };
    const maxDays = this.settings.get<number>('orders.maxScheduleDays', 3);
    const tz = await this.availability.timezoneFor(r);
    const today = zonedParts(new Date(), tz).date;
    const diffDays = Math.round((Date.parse(`${dateStr}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400_000);
    if (diffDays < 0 || diffDays > maxDays) throw new BadRequestException(`Scheduled orders can be placed up to ${maxDays} days ahead`);
    const starts = await this.availability.slots(r, dateStr);
    if (!starts.length) return { date: dateStr, enabled: true, slotMinutes: r.slotMinutes, timezone: tz, slots: [] };
    const step = (r.slotMinutes || 15) * 60_000;
    const booked = await this.ds
      .getRepository(Order)
      .createQueryBuilder('o')
      .select('o.scheduledFor', 'at')
      .addSelect('COUNT(*)', 'n')
      .where('o.restaurantId = :id AND o.isScheduled = true', { id: r.id })
      .andWhere('o.scheduledFor >= :from AND o.scheduledFor < :to', { from: starts[0], to: new Date(starts[starts.length - 1].getTime() + step) })
      .andWhere('o.status NOT IN (:...x)', { x: [OrderStatus.CANCELLED, OrderStatus.REJECTED] })
      .groupBy('o.scheduledFor')
      .getRawMany<{ at: Date; n: string }>();
    const label = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true });
    const cap = r.maxOrdersPerSlot;
    return {
      date: dateStr,
      enabled: true,
      slotMinutes: r.slotMinutes,
      timezone: tz,
      slots: starts.map((s) => {
        const n = booked.filter((b) => Math.abs(new Date(b.at).getTime() - s.getTime()) < step / 2).reduce((a, b) => a + +b.n, 0);
        return { startsAt: s, label: label.format(s), capacity: cap, booked: n, available: n < cap };
      }),
    };
  }
}
