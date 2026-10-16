import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { In, Repository } from 'typeorm';
import { AuthUser } from '../common/auth.types';
import { RestaurantStatus, UserType } from '../common/enums';
import { imageSize } from '../common/image-size';
import { profileOf, STORE_TYPES, isStoreType } from '../common/store-types';
import { AuditService } from '../audit/audit.service';
import { Faq, Restaurant, RestaurantHours, SiteSetting, SiteSettingRevision } from '../database/entities';
import { UploadsService } from '../uploads/uploads.module';
import {
  FaqFact,
  Head,
  SiteCfg,
  SiteEnv,
  StoreFacts,
  StoreTypeFact,
  assetUrl,
  buildHead,
  faqsFor,
  fileUrls,
  fill,
  normalisePath,
  renderLlmsTxt,
  renderManifest,
  renderRobotsTxt,
  renderSitemap,
  robotsMeta,
  sha,
  siteUrl,
  truncate,
} from './site.render';
import { AI_CRAWLERS, AREA_TYPES, CHANGEFREQ, COPYRIGHT_PLACEHOLDERS, IMAGE_PREVIEW, LICENSE_USES, LINK_RELS, META_KINDS, SCHEMAS, SECTION_NAMES, SOCIAL_NETWORKS, STORE_PLACEHOLDERS, SectionName, WEEKDAYS, defaultSection, describe, validateSection } from './site.schema';

/** the picture slots of the branding section: which field they fill and what a picture must be to be accepted */
export const BRANDING_SLOTS: Record<string, { field: string; label: string; maxBytes: number; minWidth: number; minHeight: number; square?: boolean; ratio?: [number, number]; formats: string[] }> = {
  logo: { field: 'logoUrl', label: 'Logo', maxBytes: 2 * 1024 * 1024, minWidth: 64, minHeight: 24, formats: ['png', 'jpg', 'webp'] },
  'logo-dark': { field: 'logoDarkUrl', label: 'Logo for dark backgrounds', maxBytes: 2 * 1024 * 1024, minWidth: 64, minHeight: 24, formats: ['png', 'jpg', 'webp'] },
  'logo-square': { field: 'logoSquareUrl', label: 'Square logo', maxBytes: 2 * 1024 * 1024, minWidth: 128, minHeight: 128, square: true, formats: ['png', 'jpg', 'webp'] },
  favicon: { field: 'faviconUrl', label: 'Favicon', maxBytes: 512 * 1024, minWidth: 32, minHeight: 32, square: true, formats: ['png', 'webp'] },
  'apple-touch-icon': { field: 'appleTouchIconUrl', label: 'Home screen icon (iPhone)', maxBytes: 1024 * 1024, minWidth: 180, minHeight: 180, square: true, formats: ['png'] },
  'pwa-icon-192': { field: 'pwaIcon192Url', label: 'App icon 192', maxBytes: 1024 * 1024, minWidth: 192, minHeight: 192, square: true, formats: ['png', 'webp'] },
  'pwa-icon-512': { field: 'pwaIcon512Url', label: 'App icon 512', maxBytes: 2 * 1024 * 1024, minWidth: 512, minHeight: 512, square: true, formats: ['png', 'webp'] },
  'og-image': { field: 'ogImageUrl', label: 'Share picture', maxBytes: 5 * 1024 * 1024, minWidth: 600, minHeight: 315, ratio: [1.6, 2.2], formats: ['png', 'jpg', 'webp'] },
  'twitter-image': { field: 'twitterImageUrl', label: 'Share picture on X', maxBytes: 5 * 1024 * 1024, minWidth: 300, minHeight: 157, ratio: [1.3, 2.2], formats: ['png', 'jpg', 'webp'] },
};

const KEEP_REVISIONS = 50;
const HEAD_TTL_MS = 60_000;
const HEAD_MAX = 500;

export interface SavedSection {
  section: SectionName;
  value: any;
  version: number;
  updatedAt: Date | null;
  updatedByName: string | null;
  /** nothing was ever saved: these are the defaults */
  isDefault: boolean;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

@Injectable()
export class SiteService {
  private rows = new Map<SectionName, SiteSetting | null>();
  private loaded = false;
  private headCache = new Map<string, { at: number; head: Head }>();
  private cmsCache: { at: number; items: FaqFact[] } | null = null;

  constructor(
    @InjectRepository(SiteSetting) private settings: Repository<SiteSetting>,
    @InjectRepository(SiteSettingRevision) private revisionRepo: Repository<SiteSettingRevision>,
    @InjectRepository(Restaurant) private restaurants: Repository<Restaurant>,
    @InjectRepository(RestaurantHours) private hours: Repository<RestaurantHours>,
    @InjectRepository(Faq) private faqs: Repository<Faq>,
    private config: ConfigService,
    private audit: AuditService,
    private uploads: UploadsService,
  ) {}

  // ------------------------------------------------------------------ reading
  env(): SiteEnv {
    return { webUrl: String(this.config.get('webUrl') ?? 'http://localhost:3000').replace(/\/+$/, ''), publicUrl: String(this.config.get('publicUrl') ?? 'http://localhost:4000').replace(/\/+$/, '') };
  }

  private async load(force = false) {
    if (this.loaded && !force) return;
    const rows = await this.settings.find();
    this.rows.clear();
    for (const r of rows) if ((SECTION_NAMES as readonly string[]).includes(r.section)) this.rows.set(r.section as SectionName, r);
    this.loaded = true;
  }

  private invalidate() {
    this.loaded = false;
    this.headCache.clear();
    this.cmsCache = null;
  }

  assertSection(name: string): SectionName {
    if (!(SECTION_NAMES as readonly string[]).includes(name)) throw new NotFoundException(`Unknown section "${name}" (sections: ${SECTION_NAMES.join(', ')})`);
    return name as SectionName;
  }

  async section(name: SectionName): Promise<SavedSection> {
    await this.load();
    const row = this.rows.get(name);
    if (!row) return { section: name, value: defaultSection(name), version: 0, updatedAt: null, updatedByName: null, isDefault: true };
    // a value saved by an older version of the schema is read through the current one (new fields get their defaults)
    const { value } = validateSection(name, row.value);
    return { section: name, value, version: row.version, updatedAt: row.updatedAt, updatedByName: row.updatedByName, isDefault: false };
  }

  async all(): Promise<SavedSection[]> {
    await this.load();
    return Promise.all(SECTION_NAMES.map((n) => this.section(n)));
  }

  /** every section with its defaults filled in: what the generators work from */
  async cfg(): Promise<SiteCfg> {
    const list = await this.all();
    return Object.fromEntries(list.map((s) => [s.section, s.value])) as unknown as SiteCfg;
  }

  /** changes whenever anything is saved: front-ends can cache by it */
  async version(): Promise<string> {
    const list = await this.all();
    return createHash('sha256').update(list.map((s) => `${s.section}:${s.version}`).join('|')).digest('hex').slice(0, 12);
  }

  // ------------------------------------------------------------------ writing
  private fail(problems: { path: string; message: string }[]): never {
    throw new BadRequestException({ message: `The settings are not valid: ${problems.slice(0, 3).map((p) => `${p.path} ${p.message}`).join('; ')}${problems.length > 3 ? ` (+${problems.length - 3} more)` : ''}`, code: 'SITE_SETTINGS_INVALID', details: problems });
  }

  private assertMayWrite(name: SectionName, actor: AuthUser) {
    if (name === 'scripts' && actor.type !== UserType.SUPER_ADMIN) {
      throw new ForbiddenException({ message: 'Custom CSS and JavaScript run on every page of the website: only a Super Admin can change them', code: 'SITE_CODE_SUPER_ADMIN_ONLY' });
    }
  }

  /**
   * Saves a section. `replace`: the body is the whole section (fields left out go back to their defaults). `merge`: the body holds only the top-level fields to change.
   * The result is validated as a whole; nothing is saved when any field is wrong. Every save is a revision and an audit entry.
   */
  async save(name: SectionName, mode: 'replace' | 'merge', input: unknown, actor: AuthUser, note?: string): Promise<SavedSection & { changed: boolean }> {
    this.assertMayWrite(name, actor);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BadRequestException({ message: 'The body must be a JSON object', code: 'SITE_SETTINGS_INVALID' });
    const current = await this.section(name);
    const base = mode === 'merge' ? current.value : defaultSection(name);
    const merged = { ...base, ...(input as Record<string, unknown>) };
    const { value, problems } = validateSection(name, merged);
    if (problems.length) this.fail(problems);
    if (same(value, current.value) && !current.isDefault) return { ...current, changed: false };
    const version = current.version + 1;
    const who = this.actorName(actor);
    await this.settings.manager.transaction(async (m) => {
      await m.getRepository(SiteSettingRevision).insert({ section: name, version, value, createdBy: actor.id ?? null, createdByName: who, note: note ?? (mode === 'merge' ? 'saved' : 'replaced') });
      const row = await m.getRepository(SiteSetting).findOne({ where: { section: name } });
      if (row) await m.getRepository(SiteSetting).update(row.id, { value, version, updatedBy: actor.id ?? null, updatedByName: who });
      else await m.getRepository(SiteSetting).insert({ section: name, value, version, updatedBy: actor.id ?? null, updatedByName: who });
      const old = await m.getRepository(SiteSettingRevision).find({ where: { section: name }, order: { version: 'DESC' }, skip: KEEP_REVISIONS, select: ['id'] });
      if (old.length) await m.getRepository(SiteSettingRevision).delete(old.map((o) => o.id));
    });
    this.invalidate();
    await this.audit.log({ actor, action: `site.${name}.update`, entity: 'site_setting', entityId: name, before: this.forAudit(name, current.value), after: this.forAudit(name, value) });
    const saved = await this.section(name);
    return { ...saved, changed: true };
  }

  async reset(name: SectionName, actor: AuthUser) {
    return this.save(name, 'replace', {}, actor, 'reset to defaults');
  }

  /** the audit trail keeps what changed, not the custom code itself: sizes and fingerprints */
  private forAudit(name: SectionName, value: any) {
    if (name !== 'scripts') return value;
    const f = (code: string) => ({ bytes: Buffer.byteLength(code ?? '', 'utf8'), sha256: code ? sha('sha256', code) : null });
    return { enabled: value.enabled, customCss: f(value.customCss), headJs: f(value.headJs), bodyJs: f(value.bodyJs), notes: value.notes };
  }

  private actorName(actor: AuthUser): string {
    return (actor as any).email ?? (actor as any).name ?? actor.id ?? 'unknown';
  }

  async revisions(name: SectionName, limit = 20) {
    const rows = await this.revisionRepo.find({ where: { section: name }, order: { version: 'DESC' }, take: Math.min(Math.max(limit, 1), KEEP_REVISIONS) });
    return rows.map((r) => ({ version: r.version, createdAt: r.createdAt, createdByName: r.createdByName, note: r.note, bytes: JSON.stringify(r.value).length }));
  }

  async revision(name: SectionName, version: number) {
    const r = await this.revisionRepo.findOne({ where: { section: name, version } });
    if (!r) throw new NotFoundException(`Version ${version} of ${name} is not kept (the newest ${KEEP_REVISIONS} are)`);
    return { version: r.version, createdAt: r.createdAt, createdByName: r.createdByName, note: r.note, value: r.value };
  }

  async restore(name: SectionName, version: number, actor: AuthUser) {
    this.assertMayWrite(name, actor);
    const r = await this.revision(name, version);
    return this.save(name, 'replace', r.value, actor, `restored version ${version}`);
  }

  // ------------------------------------------------------------------ pictures of the branding section
  async uploadBranding(slot: string, file: { buffer: Buffer; originalname: string; size: number } | undefined, actor: AuthUser) {
    const rule = BRANDING_SLOTS[slot];
    if (!rule) throw new NotFoundException(`Unknown picture slot "${slot}" (slots: ${Object.keys(BRANDING_SLOTS).join(', ')})`);
    if (!file) throw new BadRequestException('file is required (multipart field "file")');
    const bad = (m: string) => new BadRequestException({ message: `${rule.label}: ${m}`, code: 'SITE_IMAGE_REJECTED', details: { slot } });
    if (file.size > rule.maxBytes) throw bad(`the file is larger than ${Math.round(rule.maxBytes / 1024)} KB`);
    const dim = imageSize(file.buffer);
    if (!dim) throw bad('is not a PNG, JPEG or WebP picture the server can read');
    if (!rule.formats.includes(dim.type)) throw bad(`must be ${rule.formats.map((f) => f.toUpperCase()).join(' or ')} (this one is ${dim.type.toUpperCase()})`);
    if (dim.width < rule.minWidth || dim.height < rule.minHeight) throw bad(`must be at least ${rule.minWidth} x ${rule.minHeight} pixels (this one is ${dim.width} x ${dim.height})`);
    if (rule.square && Math.abs(dim.width / dim.height - 1) > 0.02) throw bad(`must be square (this one is ${dim.width} x ${dim.height})`);
    if (rule.ratio) {
      const r = dim.width / dim.height;
      if (r < rule.ratio[0] || r > rule.ratio[1]) throw bad(`must be wide, about 1.91 : 1 like 1200 x 630 (this one is ${dim.width} x ${dim.height})`);
    }
    const stored = await this.uploads.store(file, actor, ['image']);
    const saved = await this.save('branding', 'merge', { [rule.field]: stored.url }, actor, `${rule.label} uploaded`);
    return { slot, field: rule.field, url: stored.url, width: dim.width, height: dim.height, bytes: file.size, version: saved.version, branding: saved.value };
  }

  async clearBranding(slot: string, actor: AuthUser) {
    const rule = BRANDING_SLOTS[slot];
    if (!rule) throw new NotFoundException(`Unknown picture slot "${slot}" (slots: ${Object.keys(BRANDING_SLOTS).join(', ')})`);
    const saved = await this.save('branding', 'merge', { [rule.field]: null }, actor, `${rule.label} removed`);
    return { slot, field: rule.field, url: null, version: saved.version, branding: saved.value };
  }

  // ------------------------------------------------------------------ facts about stores and questions
  private async storeFacts(rows: Restaurant[]): Promise<StoreFacts[]> {
    if (!rows.length) return [];
    const hours = await this.hours.find({ where: { restaurantId: In(rows.map((r) => r.id)) } });
    return rows.map((r) => {
      const p = profileOf(r.storeType);
      return {
        slug: r.slug,
        name: r.name,
        storeType: r.storeType,
        storeTypeLabel: p.label,
        storeTypePlural: p.pluralLabel,
        retail: p.retail,
        description: r.description,
        logoUrl: r.logoUrl,
        coverUrl: r.coverUrl,
        phone: r.phone,
        addressLine1: r.addressLine1,
        city: r.city,
        province: r.province,
        postalCode: r.postalCode,
        lat: r.lat,
        lng: r.lng,
        cuisines: (r.cuisines ?? []).map((c) => c.name),
        priceLevel: r.priceLevel,
        rating: r.rating,
        ratingCount: r.ratingCount,
        minimumOrder: r.minimumOrder,
        updatedAt: r.updatedAt,
        hours: hours.filter((h) => h.restaurantId === r.id).map((h) => ({ dayOfWeek: h.dayOfWeek, openTime: h.openTime, closeTime: h.closeTime, closed: h.closed })),
      };
    });
  }

  private liveStores(limit: number, withCuisines = true) {
    return this.restaurants.find({ where: { status: RestaurantStatus.LIVE }, relations: withCuisines ? ['cuisines'] : [], order: { isFeatured: 'DESC', rating: 'DESC', name: 'ASC' }, take: limit });
  }

  private async storeTypeCounts(): Promise<StoreTypeFact[]> {
    const raw = await this.restaurants.createQueryBuilder('r').select('r.storeType', 'type').addSelect('COUNT(*)', 'n').where('r.status = :s', { s: RestaurantStatus.LIVE }).groupBy('r.storeType').getRawMany<{ type: string; n: string }>();
    const n = new Map(raw.map((r) => [r.type, +r.n]));
    return STORE_TYPES.map((t) => ({ type: t, label: profileOf(t).label, plural: profileOf(t).pluralLabel, count: n.get(t) ?? 0 }));
  }

  private async cmsFaqs(): Promise<FaqFact[]> {
    if (this.cmsCache && Date.now() - this.cmsCache.at < HEAD_TTL_MS) return this.cmsCache.items;
    const rows = await this.faqs.find({ where: { active: true, audience: 'CUSTOMER' }, order: { sortOrder: 'ASC' }, take: 100 });
    const items = rows.map((f) => ({ question: f.question, answer: truncate(String(f.answer).replace(/<[^>]*>/g, ' '), 1000), category: f.category, language: f.language }));
    this.cmsCache = { at: Date.now(), items };
    return items;
  }

  // ------------------------------------------------------------------ what the website reads
  /** the head of one page of the customer website: title, description, meta tags, links, structured data, ready-made HTML */
  async head(rawPath: string, lang?: string): Promise<Head> {
    const version = await this.version();
    const key = `${version}|${lang ?? ''}|${rawPath}`;
    const hit = this.headCache.get(key);
    if (hit && Date.now() - hit.at < HEAD_TTL_MS) return hit.head;
    const cfg = await this.cfg();
    const env = this.env();
    const { path, query } = normalisePath(rawPath);
    const facts: Parameters<typeof buildHead>[2] = { path: rawPath, lang: lang || cfg.general.defaultLanguage };
    const m = /^\/order\/r\/([a-z0-9][a-z0-9-]{0,100})$/.exec(path);
    if (m) {
      const r = await this.restaurants.findOne({ where: { slug: m[1], status: RestaurantStatus.LIVE }, relations: ['cuisines'] });
      if (r) facts.store = (await this.storeFacts([r]))[0];
      else facts.storeMissing = true;
    } else if (path === '/order' || path === '/') {
      const t = String(query.get('t') ?? '').toUpperCase();
      if (isStoreType(t)) facts.storeType = (await this.storeTypeCounts()).find((x) => x.type === t) ?? null;
      else if (cfg.seo.structuredData.storeListOnHome) facts.homeStores = await this.storeFacts(await this.liveStores(10));
    }
    if (cfg.aeo.faq.enabled && cfg.aeo.faq.includeCmsFaqs) facts.cmsFaqs = await this.cmsFaqs();
    const head = buildHead(cfg, env, facts);
    if (this.headCache.size >= HEAD_MAX) this.headCache.clear();
    this.headCache.set(key, { at: Date.now(), head });
    return head;
  }

  /** the settings in the shape a website wants: pictures as full addresses, texts with their placeholders filled, the FAQ resolved */
  async publicConfig(only?: string[]) {
    const cfg = await this.cfg();
    const env = this.env();
    const g = cfg.general;
    const b = cfg.branding;
    const base = siteUrl(cfg, env);
    const vars = { year: new Date().getFullYear(), siteName: g.siteName, legalName: g.legalName || g.siteName };
    const a = (u: string | null) => assetUrl(u, env);
    const cms = cfg.aeo.faq.enabled && cfg.aeo.faq.includeCmsFaqs ? await this.cmsFaqs() : [];
    const code = (kind: 'customCss' | 'headJs' | 'bodyJs', url: string) => {
      const text: string = cfg.scripts[kind] ?? '';
      const live = cfg.scripts.enabled && !!text.trim();
      return live ? { url: `${url}?v=${createHash('sha1').update(text).digest('hex').slice(0, 10)}`, bytes: Buffer.byteLength(text, 'utf8'), sha256: sha('sha256', text), sha384: sha('sha384', text) } : null;
    };
    const f = fileUrls(env);
    const all: Record<string, unknown> = {
      site: { name: g.siteName, tagline: g.tagline, legalName: g.legalName, url: base, language: g.defaultLanguage, languages: g.supportedLanguages, timezone: g.timezone, themeColor: g.themeColor, backgroundColor: g.backgroundColor, copyright: fill(g.copyright, vars) },
      contact: g.contact,
      social: g.social,
      appLinks: g.appLinks,
      branding: { logo: a(b.logoUrl), logoDark: a(b.logoDarkUrl), logoSquare: a(b.logoSquareUrl), logoAlt: b.logoAlt || g.siteName, favicon: a(b.faviconUrl), appleTouchIcon: a(b.appleTouchIconUrl), pwaIcon192: a(b.pwaIcon192Url), pwaIcon512: a(b.pwaIcon512Url), ogImage: a(b.ogImageUrl), twitterImage: a(b.twitterImageUrl || b.ogImageUrl), colors: { primary: b.primaryColor, secondary: b.secondaryColor, accent: b.accentColor } },
      seo: { title: cfg.seo.defaultTitle, titleTemplate: cfg.seo.titleTemplate, description: cfg.seo.metaDescription, keywords: cfg.seo.metaKeywords, robots: robotsMeta(cfg), openGraph: cfg.seo.openGraph, twitter: cfg.seo.twitter, verification: cfg.seo.verification, extraMetaTags: cfg.seo.extraMetaTags, extraLinkTags: cfg.seo.extraLinkTags, privatePaths: cfg.seo.privatePaths, pages: cfg.seo.pages },
      footer: { columns: cfg.footer.columns, bottomLinks: cfg.footer.bottomLinks, legalText: cfg.footer.legalText, copyright: fill(g.copyright, vars), showSocial: cfg.footer.showSocial, showAppLinks: cfg.footer.showAppLinks, showContact: cfg.footer.showContact, showLanguageSwitcher: cfg.footer.showLanguageSwitcher },
      geo: { generative: cfg.geo.generative.enabled ? cfg.geo.generative : null, local: cfg.geo.local.enabled ? cfg.geo.local : null },
      aeo: { faq: { enabled: cfg.aeo.faq.enabled, pages: cfg.aeo.faq.pages, items: faqsFor(cfg, cms, g.defaultLanguage) }, howTo: cfg.aeo.howTo, speakable: cfg.aeo.speakable },
      aio: { llmsTxt: { enabled: cfg.aio.llmsTxt.enabled, url: f.llms, fullUrl: f.llmsFull }, license: cfg.aio.license, crawlers: cfg.aio.crawlers.filter((c: any) => c.policy !== 'default'), snippets: cfg.aio.snippets },
      integrations: cfg.integrations,
      scripts: { enabled: cfg.scripts.enabled, customCss: code('customCss', f.customCss), headJs: code('headJs', f.headJs), bodyJs: code('bodyJs', f.bodyJs) },
    };
    const wanted = only?.length ? only : Object.keys(all);
    return {
      version: await this.version(),
      ...Object.fromEntries(Object.entries(all).filter(([k]) => wanted.includes(k))),
      files: { ...f, head: `${env.publicUrl}/api/v1/public/site/head`, faq: `${env.publicUrl}/api/v1/public/site/faq` },
    };
  }

  async faqList(lang?: string) {
    const cfg = await this.cfg();
    const cms = cfg.aeo.faq.enabled && cfg.aeo.faq.includeCmsFaqs ? await this.cmsFaqs() : [];
    return { enabled: cfg.aeo.faq.enabled, language: lang || cfg.general.defaultLanguage, items: faqsFor(cfg, cms, lang || cfg.general.defaultLanguage) };
  }

  async robotsTxt() {
    return renderRobotsTxt(await this.cfg(), this.env());
  }

  async sitemapXml() {
    const cfg = await this.cfg();
    const sm = cfg.seo.sitemap;
    if (!sm.enabled) return null;
    const stores = sm.includeStores ? (await this.restaurants.find({ where: { status: RestaurantStatus.LIVE }, select: ['slug', 'updatedAt'], order: { name: 'ASC' }, take: sm.maxUrls })).map((r) => ({ slug: r.slug, updatedAt: r.updatedAt })) : [];
    return renderSitemap(cfg, this.env(), stores, sm.includeStoreTypes ? await this.storeTypeCounts() : []);
  }

  async llmsTxt(full: boolean) {
    const cfg = await this.cfg();
    if (!cfg.aio.llmsTxt.enabled) return null;
    const stores = cfg.aio.llmsTxt.includeStores ? await this.storeFacts(await this.liveStores(Math.max(cfg.aio.llmsTxt.maxStores, 0))) : [];
    const cms = cfg.aeo.faq.enabled && cfg.aeo.faq.includeCmsFaqs ? await this.cmsFaqs() : [];
    return renderLlmsTxt(cfg, this.env(), stores, cms, full);
  }

  async manifest() {
    return renderManifest(await this.cfg(), this.env());
  }

  /** the custom code, as text: null when the code is switched off or empty */
  async code(kind: 'customCss' | 'headJs' | 'bodyJs'): Promise<string | null> {
    const s = (await this.cfg()).scripts;
    return s.enabled && String(s[kind]).trim() ? s[kind] : null;
  }

  // ------------------------------------------------------------------ for the admin screens
  schema() {
    return Object.fromEntries(SECTION_NAMES.map((n) => [n, describe(SCHEMAS[n])]));
  }

  options() {
    return {
      sections: SECTION_NAMES,
      socialNetworks: SOCIAL_NETWORKS,
      changefreq: CHANGEFREQ,
      imagePreview: IMAGE_PREVIEW,
      aiCrawlers: AI_CRAWLERS,
      aiPolicies: ['default', 'allow', 'disallow'],
      licenseUses: LICENSE_USES,
      linkRels: LINK_RELS,
      metaKinds: META_KINDS,
      areaTypes: AREA_TYPES,
      weekdays: WEEKDAYS,
      placeholders: { store: STORE_PLACEHOLDERS, copyright: COPYRIGHT_PLACEHOLDERS, title: ['siteName', 'tagline'] },
      brandingSlots: Object.entries(BRANDING_SLOTS).map(([slot, r]) => ({ slot, field: r.field, label: r.label, maxBytes: r.maxBytes, minWidth: r.minWidth, minHeight: r.minHeight, square: !!r.square, ratio: r.ratio ?? null, formats: r.formats })),
      superAdminOnly: ['scripts'],
    };
  }

  /** what is missing or wrong, in plain words, by area */
  async checks() {
    const cfg = await this.cfg();
    const env = this.env();
    const out: { id: string; area: string; level: 'error' | 'warning' | 'info'; message: string; section: string; field?: string }[] = [];
    const add = (area: string, level: 'error' | 'warning' | 'info', section: string, id: string, message: string, field?: string) => out.push({ id, area, level, message, section, field });
    const base = siteUrl(cfg, env);
    if (/^https?:\/\/(localhost|127\.|0\.0\.0\.0)/i.test(base)) add('seo', 'error', 'general', 'site-url-local', `The website address is ${base}: search engines and shared links would point at a local address. Set the real address in general.siteUrl (or WEB_URL).`, 'siteUrl');
    if (!cfg.seo.robots.index) add('seo', 'error', 'seo', 'noindex-all', 'Every page is marked noindex: the site is hidden from search engines.', 'robots.index');
    if (cfg.seo.robotsTxt.disallowAll) add('seo', 'error', 'seo', 'robots-disallow-all', 'robots.txt blocks every crawler from the whole site.', 'robotsTxt.disallowAll');
    if (!cfg.seo.robotsTxt.enabled) add('seo', 'info', 'seo', 'robots-off', 'The generated robots.txt is switched off.', 'robotsTxt.enabled');
    if (!cfg.seo.sitemap.enabled) add('seo', 'warning', 'seo', 'sitemap-off', 'The sitemap is switched off: search engines find new stores more slowly.', 'sitemap.enabled');
    const dl = cfg.seo.metaDescription.length;
    if (dl < 50) add('seo', 'warning', 'seo', 'description-short', `The description has ${dl} characters: 50 to 160 works best.`, 'metaDescription');
    else if (dl > 160) add('seo', 'warning', 'seo', 'description-long', `The description has ${dl} characters: search results cut it near 160.`, 'metaDescription');
    if (cfg.seo.defaultTitle.length > 60) add('seo', 'info', 'seo', 'title-long', `The default title has ${cfg.seo.defaultTitle.length} characters: search results cut it near 60.`, 'defaultTitle');
    if (!Object.values(cfg.seo.verification).some(Boolean)) add('seo', 'info', 'seo', 'no-verification', 'No search engine verification code is set (Google Search Console, Bing).', 'verification');
    if (!cfg.branding.logoUrl) add('branding', 'warning', 'branding', 'no-logo', 'No logo is uploaded.', 'logoUrl');
    if (!cfg.branding.faviconUrl) add('branding', 'warning', 'branding', 'no-favicon', 'No favicon (the icon in the browser tab) is uploaded.', 'faviconUrl');
    if (!cfg.branding.ogImageUrl) add('branding', 'warning', 'branding', 'no-og-image', 'No share picture: links shared on social media show no picture.', 'ogImageUrl');
    if (!cfg.branding.appleTouchIconUrl) add('branding', 'info', 'branding', 'no-touch-icon', 'No home screen icon for iPhones.', 'appleTouchIconUrl');
    if (!cfg.branding.pwaIcon192Url || !cfg.branding.pwaIcon512Url) add('branding', 'info', 'branding', 'no-pwa-icons', 'The installable web app needs a 192 and a 512 pixel icon.', 'pwaIcon512Url');
    if (!cfg.general.contact.email && !cfg.general.contact.phone) add('general', 'info', 'general', 'no-contact', 'No contact email or phone: structured data and the footer have nothing to show.', 'contact');
    if (!cfg.general.social.length) add('general', 'info', 'general', 'no-social', 'No social profiles: the footer and structured data (sameAs) list none.', 'social');
    if (cfg.geo.generative.enabled && !cfg.geo.generative.entityDescription.trim()) add('geo', 'warning', 'geo', 'no-entity-description', 'No description of the company for AI assistants (geo.generative.entityDescription).', 'generative.entityDescription');
    if (cfg.geo.generative.enabled && cfg.geo.generative.keyFacts.length < 3) add('geo', 'info', 'geo', 'few-facts', 'Fewer than 3 key facts: AI answers have little to quote.', 'generative.keyFacts');
    if (cfg.geo.local.enabled && !cfg.geo.local.serviceAreas.length) add('geo', 'info', 'geo', 'no-service-area', 'No service areas: structured data does not say where you deliver.', 'local.serviceAreas');
    if (cfg.geo.local.enabled && cfg.geo.local.position.lat === null) add('geo', 'info', 'geo', 'no-position', 'No map position for the geo meta tags.', 'local.position');
    const faq = await this.faqList();
    if (cfg.aeo.faq.enabled && !faq.items.length) add('aeo', 'warning', 'aeo', 'no-faq', 'The FAQ is on but empty: add questions here or in Content > FAQ.', 'faq.items');
    if (!cfg.aio.llmsTxt.enabled) add('aio', 'info', 'aio', 'llms-off', '/llms.txt is switched off.', 'llmsTxt.enabled');
    if (!cfg.aio.crawlers.some((c: any) => c.policy !== 'default')) add('aio', 'info', 'aio', 'ai-crawlers-default', 'robots.txt does not say anything about AI crawlers (GPTBot, ClaudeBot, PerplexityBot...).', 'crawlers');
    if (cfg.scripts.enabled && (cfg.scripts.customCss.trim() || cfg.scripts.headJs.trim() || cfg.scripts.bodyJs.trim())) add('scripts', 'info', 'scripts', 'code-live', 'Custom CSS / JavaScript is published on every page.', 'enabled');
    const analytics = ['googleAnalyticsId', 'googleTagManagerId', 'metaPixelId', 'googleAdsId', 'microsoftClarityId', 'tiktokPixelId'].some((k) => cfg.integrations[k]);
    if (analytics && !cfg.integrations.consentRequired) add('scripts', 'warning', 'integrations', 'analytics-no-consent', 'Analytics / advertising scripts are set to load without the visitor agreeing.', 'consentRequired');
    if (!cfg.footer.columns.length) add('footer', 'info', 'footer', 'no-footer-links', 'The footer has no link columns.', 'columns');
    const order = { error: 0, warning: 1, info: 2 };
    out.sort((x, y) => order[x.level] - order[y.level]);
    return { summary: { errors: out.filter((c) => c.level === 'error').length, warnings: out.filter((c) => c.level === 'warning').length, infos: out.filter((c) => c.level === 'info').length }, checks: out };
  }
}
