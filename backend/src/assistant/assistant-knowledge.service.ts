import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Restaurant, RestaurantHours } from '../database/entities';
import { RestaurantStatus } from '../common/enums';
import { fulfilmentAvailability } from '../common/service-mode';
import { AvailabilityService } from '../core/core.module';
import { DiscoveryService } from '../customers/discovery.service';
import { SettingsService } from '../settings/settings.service';
import { AssistantConfigService } from './assistant-config.service';
import { DirectoryEntry, KItem, Knowledge } from './brain/brain.types';

const MENU_TTL_MS = 10_000;
const DIRECTORY_TTL_MS = 30_000;

/**
 * Builds what the bot may talk about. PRIVACY RULE: a restaurant bot only ever reads ITS OWN restaurant's rows, and only the
 * fields the public restaurant page already shows (menu, hours, fulfilment, minimum, phone, address) plus its FAQ text.
 */
@Injectable()
export class AssistantKnowledgeService {
  private menuCache = new Map<string, { at: number; kb: Omit<Knowledge, 'faqs' | 'assistantName' | 'greeting'> }>();
  private dir: { at: number; entries: DirectoryEntry[] } | null = null;

  constructor(
    @InjectDataSource() private ds: DataSource,
    private discovery: DiscoveryService,
    private availability: AvailabilityService,
    private settings: SettingsService,
    private cfg: AssistantConfigService,
    private config: ConfigService,
  ) {}

  /** make an upload path absolute so the widget on a third-party site can load it; non-http(s) values are dropped */
  absUrl(u: string | null | undefined): string | null {
    if (!u) return null;
    if (/^https?:\/\//i.test(u)) return u;
    if (u.startsWith('/') && !u.startsWith('//')) return `${this.config.get<string>('publicUrl')}${u}`;
    return null;
  }

  private fmtWhen(at: Date | null | undefined, tz: string, now: Date): string | null {
    if (!at) return null;
    const f = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { timeZone: tz, ...o }).format(at);
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    const same = day.format(at) === day.format(now);
    const time = f({ hour: 'numeric', minute: '2-digit' });
    return same ? time : `${f({ weekday: 'short' })} ${time}`;
  }

  /** knowledge for one restaurant; null when it is not public (not LIVE / PAUSED) */
  async forRestaurant(restaurantId: string): Promise<Knowledge | null> {
    const row = await this.ds.getRepository(Restaurant).findOne({ where: { id: restaurantId }, relations: { cuisines: true } });
    if (!row || ![RestaurantStatus.LIVE, RestaurantStatus.PAUSED].includes(row.status)) return null;
    const c = this.cfg.effective(row);
    const hit = this.menuCache.get(row.id);
    const now = new Date();
    let base = hit && now.getTime() - hit.at < MENU_TTL_MS ? hit.kb : null;
    if (!base) {
      base = await this.buildBase(row, now);
      this.menuCache.set(row.id, { at: now.getTime(), kb: base });
      if (this.menuCache.size > 500) this.menuCache.delete(this.menuCache.keys().next().value as string);
    }
    // FAQs are taught entries of the trained knowledge base now (matched by the training engine before the brain runs)
    return { ...base, faqs: [], assistantName: c.name, greeting: c.greeting };
  }

  invalidate(restaurantId?: string) {
    if (restaurantId) this.menuCache.delete(restaurantId);
    else this.menuCache.clear();
    this.dir = null;
  }

  private async buildBase(r: Restaurant, now: Date): Promise<Omit<Knowledge, 'faqs' | 'assistantName' | 'greeting'>> {
    const [menu, hours, st, tz] = await Promise.all([
      this.discovery.buildMenu(r),
      this.ds.getRepository(RestaurantHours).find({ where: { restaurantId: r.id }, order: { dayOfWeek: 'ASC', openTime: 'ASC' } }),
      this.availability.status(r, now),
      this.availability.timezoneFor(r),
    ]);
    const av = fulfilmentAvailability(r);
    const items: KItem[] = [];
    const categories = menu.categories.map((cat) => ({
      id: cat.id,
      name: cat.name,
      description: cat.description,
      itemIds: cat.items.map((i) => i.id),
    }));
    for (const cat of menu.categories) {
      for (const i of cat.items) {
        items.push({
          id: i.id,
          name: i.name,
          description: i.description,
          price: i.price,
          imageUrl: this.absUrl(i.imageUrl),
          dietaryTags: i.dietaryTags ?? [],
          allergens: i.allergens ?? [],
          calories: i.calories ?? null,
          isPopular: !!i.isPopular,
          available: !!i.available,
          categoryId: cat.id,
          category: cat.name,
          groups: i.modifierGroups.map((g) => ({
            id: g.id,
            name: g.name,
            required: g.required,
            min: g.minSelect,
            max: g.maxSelect,
            options: g.options.map((o) => ({ id: o.id, name: o.name, priceDelta: o.priceDelta, isDefault: o.isDefault, available: o.available })),
          })),
        });
      }
    }
    const minCount = this.settings.get<number>('ratings.minCountToShow', 5);
    const address = [r.addressLine1, r.addressLine2, r.city, r.province, r.postalCode].filter((x) => x && String(x).trim()).join(', ');
    const nextOpen = st.open ? null : st.opensAt ?? (await this.availability.nextOpening(r, now));
    return {
      restaurant: {
        id: r.id,
        slug: r.slug,
        name: r.name,
        description: r.description,
        phone: r.phone,
        address,
        logoUrl: this.absUrl(r.logoUrl),
        cuisines: (r.cuisines ?? []).map((x) => x.name),
        minimumOrder: r.minimumOrder ?? 0,
        prepTimeMin: this.availability.prepTime(r),
        pickupPrepTimeMin: this.availability.prepTime(r, true),
        serviceMode: av.serviceMode,
        serviceModeLabel: av.serviceModeLabel,
        deliveryAvailable: av.deliveryAvailable,
        pickupAvailable: av.pickupAvailable,
        orderable: r.status === RestaurantStatus.LIVE && (av.deliveryAvailable || av.pickupAvailable),
        open: st.open,
        opensAtText: this.fmtWhen(nextOpen, tz, now),
        closesAtText: st.open && st.closesAt ? this.fmtWhen(st.closesAt, tz, now) : null,
        timezone: tz,
        pickupInstructions: r.pickupInstructions,
        rating: r.ratingCount >= minCount && r.rating ? Math.round(r.rating * 10) / 10 : null,
      },
      hours: hours.map((h) => ({ dayOfWeek: h.dayOfWeek, openTime: h.openTime, closeTime: h.closeTime, closed: h.closed })),
      categories,
      items,
    };
  }

  // ------------------------------------------------------------------ central directory
  /** Public data of every LIVE restaurant whose assistant is not forced off (used only by the central bot). */
  async directory(): Promise<DirectoryEntry[]> {
    if (this.dir && Date.now() - this.dir.at < DIRECTORY_TTL_MS) return this.dir.entries;
    const now = new Date();
    const rs = await this.ds.getRepository(Restaurant).find({ where: { status: RestaurantStatus.LIVE }, relations: { cuisines: true } });
    const live = rs.filter((r) => !this.cfg.forcedOff(r));
    const dishes: { restaurantId: string; name: string; tags: string[]; category: string | null }[] = await this.ds.query(
      `SELECT m."restaurantId", m.name, m."dietaryTags" AS tags, c.name AS category FROM menu_items m LEFT JOIN menu_categories c ON c.id = m."categoryId" WHERE m.active = true`,
    );
    const byRest = new Map<string, typeof dishes>();
    for (const d of dishes) (byRest.get(d.restaurantId) ?? byRest.set(d.restaurantId, []).get(d.restaurantId)!).push(d);
    const minCount = this.settings.get<number>('ratings.minCountToShow', 5);
    const entries: DirectoryEntry[] = [];
    for (const r of live) {
      const av = fulfilmentAvailability(r);
      const st = await this.availability.status(r, now);
      const ds = byRest.get(r.id) ?? [];
      entries.push({
        id: r.id,
        slug: r.slug,
        name: r.name,
        cuisines: (r.cuisines ?? []).map((c) => c.name),
        logoUrl: this.absUrl(r.logoUrl),
        rating: r.ratingCount >= minCount && r.rating ? Math.round(r.rating * 10) / 10 : null,
        openNow: st.open && (av.deliveryAvailable || av.pickupAvailable),
        deliveryAvailable: av.deliveryAvailable,
        pickupAvailable: av.pickupAvailable,
        dishNames: ds.map((d) => d.name),
        categoryNames: [...new Set(ds.map((d) => d.category).filter((x): x is string => !!x))],
        dietaryTags: [...new Set(ds.flatMap((d) => d.tags ?? []))],
        lat: r.lat,
        lng: r.lng,
      });
    }
    this.dir = { at: Date.now(), entries };
    return entries;
  }
}
