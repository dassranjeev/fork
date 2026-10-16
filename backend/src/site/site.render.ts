import { createHash } from 'crypto';
import { AI_CRAWLERS, WEEKDAYS } from './site.schema';

/**
 * Everything the website needs to put in front of search engines, answer engines and AI assistants, built from the saved site settings.
 * Pure functions (no database, no HTTP) so they can be tested on their own: the service loads the facts (stores, FAQ) and calls these.
 * docs/site-settings.md.
 */
export interface SiteCfg {
  general: any;
  branding: any;
  seo: any;
  geo: any;
  aeo: any;
  aio: any;
  footer: any;
  integrations: any;
  scripts: any;
}

/** where things live: the customer website, and this API (uploads and the generated files are served from it) */
export interface SiteEnv {
  webUrl: string;
  publicUrl: string;
}

export interface StoreFacts {
  slug: string;
  name: string;
  storeType: string;
  storeTypeLabel: string;
  storeTypePlural: string;
  retail: boolean;
  description: string | null;
  logoUrl: string | null;
  coverUrl: string | null;
  phone: string | null;
  addressLine1: string;
  city: string;
  province: string;
  postalCode: string;
  lat: number | null;
  lng: number | null;
  cuisines: string[];
  priceLevel: number | null;
  rating: number | null;
  ratingCount: number;
  minimumOrder: number | null;
  updatedAt: Date;
  /** dayOfWeek 0 = Sunday */
  hours: { dayOfWeek: number; openTime: string; closeTime: string; closed: boolean }[];
}

export interface FaqFact {
  question: string;
  answer: string;
  category?: string | null;
  language?: string | null;
}

export interface StoreTypeFact {
  type: string;
  label: string;
  plural: string;
  count: number;
}

export interface HeadMeta {
  name?: string;
  property?: string;
  httpEquiv?: string;
  content: string;
}
export interface HeadLink {
  rel: string;
  href: string;
  type?: string;
  sizes?: string;
  hreflang?: string;
  crossorigin?: string;
}
export interface Head {
  path: string;
  lang: string;
  htmlLang: string;
  title: string;
  description: string;
  canonical: string;
  robots: string;
  themeColor: string | null;
  meta: HeadMeta[];
  link: HeadLink[];
  jsonLd: Record<string, unknown>[];
  /** the same as a ready-made, escaped HTML snippet for <head> (for server-side rendering, pre-rendering or index.html templates) */
  html: string;
  /** which rule produced this head: page-rule | store | store-type | home | private | default | not-found */
  source: string;
}

// ------------------------------------------------------------------ small helpers
export const sha = (alg: 'sha256' | 'sha384', text: string) => `${alg}-${createHash(alg).update(text, 'utf8').digest('base64')}`;
export const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
/** JSON for a <script type="application/ld+json">: "<" is escaped so the text can never close the tag */
export const jsonForScript = (o: unknown) => JSON.stringify(o).replace(/</g, '\\u003c').replace(new RegExp(String.fromCharCode(0x2028), 'g'), '\\u2028').replace(new RegExp(String.fromCharCode(0x2029), 'g'), '\\u2029');
const capFirst = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const trimSlash = (s: string) => s.replace(/\/+$/, '');
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
export function truncate(s: string, n: number): string {
  const t = squash(s);
  if (t.length <= n) return t;
  const cut = t.slice(0, n - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > n * 0.6 ? cut.slice(0, sp) : cut).replace(/[ ,.;:–-]+$/, '')}…`;
}
export function fill(template: string, vars: Record<string, string | number | null | undefined>): string {
  return squash(template.replace(/\{([A-Za-z]+)\}/g, (_m, k) => String(vars[k] ?? ''))).replace(/\s+([,.;:])/g, '$1').replace(/^[-–|,\s]+|[-–|,\s]+$/g, '');
}

export function siteUrl(cfg: SiteCfg, env: SiteEnv): string {
  return trimSlash(cfg.general.siteUrl || env.webUrl);
}
/** a picture address: our own uploads are served by this API */
export function assetUrl(url: string | null | undefined, env: SiteEnv): string | null {
  if (!url) return null;
  return url.startsWith('/') ? `${trimSlash(env.publicUrl)}${url}` : url;
}
/** an address of a page: a path of the website */
export function pageUrl(url: string, cfg: SiteCfg, env: SiteEnv): string {
  return url.startsWith('/') ? `${siteUrl(cfg, env)}${url}` : url;
}
const apiBase = (env: SiteEnv) => `${trimSlash(env.publicUrl)}/api/v1`;

export const fileUrls = (env: SiteEnv) => ({
  robots: `${apiBase(env)}/public/site/robots.txt`,
  sitemap: `${apiBase(env)}/public/site/sitemap.xml`,
  llms: `${apiBase(env)}/public/site/llms.txt`,
  llmsFull: `${apiBase(env)}/public/site/llms-full.txt`,
  manifest: `${apiBase(env)}/public/site/manifest.webmanifest`,
  customCss: `${apiBase(env)}/public/site/custom.css`,
  headJs: `${apiBase(env)}/public/site/head.js`,
  bodyJs: `${apiBase(env)}/public/site/body.js`,
});

const siteVars = (cfg: SiteCfg) => ({
  siteName: cfg.general.siteName,
  legalName: cfg.general.legalName || cfg.general.siteName,
  tagline: cfg.general.tagline,
  year: new Date().getFullYear(),
  city: cfg.general.contact?.address?.city || '',
});

// ------------------------------------------------------------------ path rules
const prefixOf = (pattern: string) => (pattern.endsWith('*') ? pattern.slice(0, -1) : null);
export function pathMatches(pattern: string, path: string): boolean {
  const pre = prefixOf(pattern);
  if (pre !== null) return path.startsWith(pre);
  return path === pattern || path === `${pattern}/`;
}
export const normalisePath = (raw: string): { path: string; query: URLSearchParams } => {
  let p = String(raw || '/');
  const hash = p.indexOf('#');
  if (hash >= 0) p = p.slice(0, hash);
  const q = p.indexOf('?');
  const query = new URLSearchParams(q >= 0 ? p.slice(q + 1) : '');
  p = q >= 0 ? p.slice(0, q) : p;
  p = p.replace(/\/{2,}/g, '/');
  if (!p.startsWith('/')) p = `/${p}`;
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return { path: p, query };
};
export function isPrivatePath(cfg: SiteCfg, path: string): boolean {
  return (cfg.seo.privatePaths as string[]).some((pat) => pathMatches(pat, path));
}
/** exact page rules first, then patterns, the longest pattern first */
export function pageRule(cfg: SiteCfg, path: string): any | null {
  const pages = cfg.seo.pages as any[];
  const exact = pages.find((p) => !p.path.endsWith('*') && pathMatches(p.path, path));
  if (exact) return exact;
  return pages.filter((p) => p.path.endsWith('*') && pathMatches(p.path, path)).sort((a, b) => b.path.length - a.path.length)[0] ?? null;
}

export function robotsMeta(cfg: SiteCfg, opts: { noindex?: boolean; override?: string | null } = {}): string {
  if (opts.override) return opts.override;
  const r = cfg.seo.robots;
  const parts: string[] = [];
  const noindex = opts.noindex || !r.index;
  parts.push(noindex ? 'noindex' : 'index', noindex || !r.follow ? 'nofollow' : 'follow');
  if (!noindex) {
    if (cfg.aio.snippets.noSnippet) parts.push('nosnippet');
    else {
      parts.push(`max-snippet:${r.maxSnippet}`, `max-image-preview:${r.maxImagePreview}`, `max-video-preview:${r.maxVideoPreview}`);
    }
    if (r.noarchive) parts.push('noarchive');
    if (r.notranslate) parts.push('notranslate');
    if (cfg.aio.snippets.noai) parts.push('noai', 'noimageai');
  }
  return parts.join(', ');
}

const STORE_TYPE_SCHEMA: Record<string, string> = {
  RESTAURANT: 'Restaurant',
  CAFE: 'CafeOrCoffeeShop',
  BAKERY: 'Bakery',
  GROCERY: 'GroceryStore',
  CONVENIENCE: 'ConvenienceStore',
  SPECIALTY: 'FoodEstablishment',
};

// ------------------------------------------------------------------ structured data (JSON-LD)
const org = (cfg: SiteCfg, env: SiteEnv) => {
  const g = cfg.general;
  const id = `${siteUrl(cfg, env)}/#organization`;
  const logo = assetUrl(cfg.branding.logoSquareUrl || cfg.branding.logoUrl, env);
  const a = g.contact?.address ?? {};
  const local = cfg.geo.local;
  const o: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': local.enabled ? local.businessType : 'Organization',
    '@id': id,
    name: (cfg.geo.generative.enabled && cfg.geo.generative.entityName) || g.siteName,
    url: siteUrl(cfg, env),
    description: truncate((cfg.geo.generative.enabled && cfg.geo.generative.entityDescription) || g.tagline, 500),
    slogan: g.tagline || undefined,
    legalName: g.legalName || undefined,
    logo: logo ? { '@type': 'ImageObject', url: logo } : undefined,
    image: assetUrl(cfg.branding.ogImageUrl, env) || logo || undefined,
    email: g.contact?.email || undefined,
    telephone: g.contact?.phone || undefined,
    sameAs: (g.social as any[]).map((s) => s.url).filter(Boolean),
    address: a.line1 || a.city ? { '@type': 'PostalAddress', streetAddress: [a.line1, a.line2].filter(Boolean).join(', ') || undefined, addressLocality: a.city || undefined, addressRegion: a.region || undefined, postalCode: a.postalCode || undefined, addressCountry: a.country || undefined } : undefined,
    contactPoint: g.contact?.supportEmail || g.contact?.phone ? [{ '@type': 'ContactPoint', contactType: 'customer support', email: g.contact.supportEmail || g.contact.email || undefined, telephone: g.contact.phone || undefined, availableLanguage: g.supportedLanguages }] : undefined,
  };
  if (local.enabled) {
    if (local.serviceAreas.length) {
      o.areaServed = local.serviceAreas.map((s: any) => ({
        '@type': s.type === 'City' || s.type === 'AdministrativeArea' || s.type === 'State' || s.type === 'Country' ? s.type : 'Place',
        name: s.name,
        ...(s.lat !== null && s.lng !== null ? { geo: { '@type': 'GeoCoordinates', latitude: s.lat, longitude: s.lng } } : {}),
      }));
    }
    if (local.position.lat !== null) o.geo = { '@type': 'GeoCoordinates', latitude: local.position.lat, longitude: local.position.lng };
    if (local.priceRange) o.priceRange = local.priceRange;
    if (local.hours.length) o.openingHoursSpecification = local.hours.map((h: any) => ({ '@type': 'OpeningHoursSpecification', dayOfWeek: h.days, opens: h.opens, closes: h.closes }));
  }
  if (cfg.geo.generative.enabled && cfg.geo.generative.keyFacts.length) o.knowsAbout = cfg.geo.generative.terminology.map((t: any) => t.term).slice(0, 20);
  return strip(o);
};

/** drops undefined, null and empty values so the JSON-LD stays clean */
function strip<T>(v: T): T {
  if (Array.isArray(v)) return v.map(strip).filter((x) => x !== undefined && x !== null && !(Array.isArray(x) && !x.length)) as unknown as T;
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const y = strip(x);
      if (y === undefined || y === null || y === '' || (Array.isArray(y) && !y.length)) continue;
      out[k] = y;
    }
    return out as T;
  }
  return v;
}

const website = (cfg: SiteCfg, env: SiteEnv) =>
  strip({
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    '@id': `${siteUrl(cfg, env)}/#website`,
    url: siteUrl(cfg, env),
    name: cfg.general.siteName,
    inLanguage: cfg.general.defaultLanguage,
    publisher: { '@id': `${siteUrl(cfg, env)}/#organization` },
    potentialAction: { '@type': 'SearchAction', target: { '@type': 'EntryPoint', urlTemplate: `${siteUrl(cfg, env)}/order?q={search_term_string}` }, 'query-input': 'required name=search_term_string' },
  });

const hhmm = (t: string) => (/^\d{2}:\d{2}/.test(t) ? t.slice(0, 5) : t);
export function storeJsonLd(cfg: SiteCfg, env: SiteEnv, s: StoreFacts): Record<string, unknown> {
  const url = `${siteUrl(cfg, env)}/order/r/${s.slug}`;
  const days = s.hours.filter((h) => !h.closed);
  const hours = days.map((h) => {
    const open = hhmm(h.openTime);
    let close = hhmm(h.closeTime);
    if (open === '00:00' && close === '00:00') close = '23:59'; // open all day
    return { '@type': 'OpeningHoursSpecification', dayOfWeek: WEEKDAYS[(h.dayOfWeek + 6) % 7], opens: open, closes: close };
  });
  return strip({
    '@context': 'https://schema.org',
    '@type': STORE_TYPE_SCHEMA[s.storeType] ?? 'LocalBusiness',
    '@id': `${url}#store`,
    name: s.name,
    url,
    description: s.description ? truncate(s.description, 300) : undefined,
    image: [assetUrl(s.coverUrl, env), assetUrl(s.logoUrl, env)].filter(Boolean),
    telephone: s.phone || undefined,
    priceRange: s.priceLevel ? '$'.repeat(Math.min(4, Math.max(1, s.priceLevel))) : undefined,
    servesCuisine: s.retail ? undefined : s.cuisines,
    address: { '@type': 'PostalAddress', streetAddress: s.addressLine1, addressLocality: s.city, addressRegion: s.province, postalCode: s.postalCode, addressCountry: cfg.general.contact?.address?.country || 'CA' },
    geo: s.lat !== null && s.lng !== null ? { '@type': 'GeoCoordinates', latitude: s.lat, longitude: s.lng } : undefined,
    aggregateRating: s.ratingCount > 0 && s.rating ? { '@type': 'AggregateRating', ratingValue: Number(s.rating), reviewCount: s.ratingCount, bestRating: 5, worstRating: 1 } : undefined,
    openingHoursSpecification: hours,
    potentialAction: { '@type': 'OrderAction', target: { '@type': 'EntryPoint', urlTemplate: url, inLanguage: cfg.general.defaultLanguage, actionPlatform: ['http://schema.org/DesktopWebPlatform', 'http://schema.org/MobileWebPlatform'] }, deliveryMethod: ['http://purl.org/goodrelations/v1#DeliveryModeOwnFleet', 'http://purl.org/goodrelations/v1#DeliveryModePickUp'] },
    parentOrganization: { '@id': `${siteUrl(cfg, env)}/#organization` },
  });
}

export function faqJsonLd(items: FaqFact[]): Record<string, unknown> {
  return { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: items.map((q) => ({ '@type': 'Question', name: q.question, acceptedAnswer: { '@type': 'Answer', text: q.answer } })) };
}

export const langOk = (itemLang: string | null | undefined, lang: string) => !itemLang || itemLang.toLowerCase().startsWith(lang.toLowerCase().slice(0, 2));

export function faqsFor(cfg: SiteCfg, cms: FaqFact[], lang: string): FaqFact[] {
  const a = cfg.aeo.faq;
  if (!a.enabled) return [];
  const own: FaqFact[] = a.items.filter((i: any) => langOk(i.language, lang));
  const fromCms = a.includeCmsFaqs ? cms.filter((i) => langOk(i.language, lang)) : [];
  const seen = new Set<string>();
  return [...own, ...fromCms].filter((q) => {
    const k = q.question.trim().toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ------------------------------------------------------------------ the head of a page
export interface HeadFacts {
  path: string;
  lang: string;
  store?: StoreFacts | null;
  storeType?: StoreTypeFact | null;
  /** the page is a store page (/order/r/:slug) but the store does not exist or is not live */
  storeMissing?: boolean;
  homeStores?: StoreFacts[];
  cmsFaqs?: FaqFact[];
}

export function buildHead(cfg: SiteCfg, env: SiteEnv, facts: HeadFacts): Head {
  const { path, query } = normalisePath(facts.path);
  const lang = (facts.lang || cfg.general.defaultLanguage).replace('_', '-');
  const base = siteUrl(cfg, env);
  const v = siteVars(cfg);
  const isHome = path === '/order' || path === '/';
  const rule = pageRule(cfg, path);
  const priv = isPrivatePath(cfg, path) || path === '/' || path.startsWith('/portal');

  let title: string | null = null;
  let description: string | null = null;
  let source = 'default';
  let image = assetUrl(cfg.branding.ogImageUrl, env);
  let ogType = cfg.seo.openGraph.type as string;
  const jsonLd: Record<string, unknown>[] = [];
  let noindex = false;
  const store = facts.store ?? null;

  if (store) {
    const tv = {
      ...v,
      name: store.name,
      storeType: store.storeTypeLabel.toLowerCase(),
      storeTypes: store.storeTypePlural.toLowerCase(),
      city: store.city,
      region: store.province,
      cuisines: store.cuisines.join(', '),
      description: store.description ? truncate(store.description, 110) : '',
      rating: store.ratingCount > 0 && store.rating ? Number(store.rating).toFixed(1) : '',
      minimumOrder: store.minimumOrder ? `$${Number(store.minimumOrder).toFixed(0)}` : '',
    };
    title = capFirst(fill(cfg.seo.templates.store.title, tv));
    description = capFirst(fill(cfg.seo.templates.store.description, tv));
    image = assetUrl(store.coverUrl || store.logoUrl, env) || image;
    source = 'store';
    if (cfg.seo.structuredData.localBusinessForStores) jsonLd.push(storeJsonLd(cfg, env, store));
    if (cfg.seo.structuredData.breadcrumbs) jsonLd.push(breadcrumbs(cfg, env, [{ name: 'Home', url: `${base}/order` }, { name: store.name, url: `${base}/order/r/${store.slug}` }]));
  } else if (facts.storeMissing) {
    noindex = true;
    source = 'not-found';
  } else if (facts.storeType) {
    const st = facts.storeType;
    const tv = { ...v, storeType: st.label.toLowerCase(), storeTypes: st.plural.toLowerCase(), name: st.plural, region: '', cuisines: '', description: '', rating: '', minimumOrder: '' };
    title = capFirst(fill(cfg.seo.templates.storeType.title, tv));
    description = capFirst(fill(cfg.seo.templates.storeType.description, tv));
    source = 'store-type';
    if (cfg.seo.structuredData.breadcrumbs) jsonLd.push(breadcrumbs(cfg, env, [{ name: 'Home', url: `${base}/order` }, { name: st.plural, url: `${base}/order?t=${st.type}` }]));
  } else if (isHome) {
    source = 'home';
  }

  if (rule) {
    if (rule.title) title = fill(rule.title, v);
    if (rule.description) description = fill(rule.description, v);
    if (rule.ogImageUrl) image = assetUrl(rule.ogImageUrl, env);
    source = source === 'default' ? 'page-rule' : source;
  }
  if (priv && !store && !facts.storeType) {
    noindex = true;
    source = rule ? 'page-rule' : 'private';
  }

  // the page title and description
  const pageTitle = title ? fill(cfg.seo.titleTemplate.replace('%s', title), v) : fill(cfg.seo.defaultTitle, v);
  const desc = truncate(description || cfg.seo.metaDescription || cfg.general.tagline, 320);

  // canonical: the page itself, without filters (except the ones that make a different page)
  const keep = new Set<string>(cfg.seo.canonicalKeepParams as string[]);
  const q = new URLSearchParams();
  for (const [k, val] of query) if (!cfg.seo.canonicalStripQuery || keep.has(k)) q.append(k, val);
  const canonical = rule?.canonicalUrl ? pageUrl(rule.canonicalUrl, cfg, env) : `${base}${path === '/' ? '' : path}${q.toString() ? `?${q}` : ''}`;

  const robots = robotsMeta(cfg, { noindex: noindex || priv, override: rule?.robots ?? null });
  const meta: HeadMeta[] = [{ name: 'description', content: desc }, { name: 'robots', content: robots }];
  if ((cfg.seo.metaKeywords as string[]).length || rule?.keywords?.length) meta.push({ name: 'keywords', content: [...(rule?.keywords?.length ? rule.keywords : cfg.seo.metaKeywords)].join(', ') });
  const themeColor = cfg.general.themeColor || null;
  if (themeColor) meta.push({ name: 'theme-color', content: themeColor });
  meta.push({ name: 'application-name', content: cfg.general.siteName }, { name: 'apple-mobile-web-app-title', content: cfg.general.siteName });
  const ver = cfg.seo.verification;
  if (ver.google) meta.push({ name: 'google-site-verification', content: ver.google });
  if (ver.bing) meta.push({ name: 'msvalidate.01', content: ver.bing });
  if (ver.yandex) meta.push({ name: 'yandex-verification', content: ver.yandex });
  if (ver.baidu) meta.push({ name: 'baidu-site-verification', content: ver.baidu });
  if (ver.pinterest) meta.push({ name: 'p:domain_verify', content: ver.pinterest });
  if (ver.facebookDomain) meta.push({ name: 'facebook-domain-verification', content: ver.facebookDomain });

  const og = cfg.seo.openGraph;
  if (og.enabled) {
    meta.push({ property: 'og:title', content: pageTitle }, { property: 'og:description', content: desc }, { property: 'og:url', content: canonical }, { property: 'og:type', content: ogType }, { property: 'og:site_name', content: og.siteName || cfg.general.siteName }, { property: 'og:locale', content: og.locale });
    for (const l of og.localeAlternates as string[]) meta.push({ property: 'og:locale:alternate', content: l });
    if (image) meta.push({ property: 'og:image', content: image }, { property: 'og:image:alt', content: cfg.branding.logoAlt || cfg.general.siteName });
  }
  const tw = cfg.seo.twitter;
  if (tw.enabled) {
    meta.push({ name: 'twitter:card', content: image ? tw.card : 'summary' }, { name: 'twitter:title', content: pageTitle }, { name: 'twitter:description', content: desc });
    const timg = (store ? image : assetUrl(cfg.branding.twitterImageUrl, env)) || image;
    if (timg) meta.push({ name: 'twitter:image', content: timg });
    if (tw.site) meta.push({ name: 'twitter:site', content: tw.site });
    if (tw.creator) meta.push({ name: 'twitter:creator', content: tw.creator });
  }
  const local = cfg.geo.local;
  if (local.enabled) {
    if (local.region) meta.push({ name: 'geo.region', content: local.region });
    if (local.placename) meta.push({ name: 'geo.placename', content: local.placename });
    if (local.position.lat !== null) meta.push({ name: 'geo.position', content: `${local.position.lat};${local.position.lng}` }, { name: 'ICBM', content: `${local.position.lat}, ${local.position.lng}` });
  }
  for (const t of cfg.seo.extraMetaTags as any[]) {
    meta.push(t.kind === 'property' ? { property: t.key, content: t.content } : t.kind === 'http-equiv' ? { httpEquiv: t.key, content: t.content } : { name: t.key, content: t.content });
  }

  const link: HeadLink[] = [{ rel: 'canonical', href: canonical }];
  const b = cfg.branding;
  const fav = assetUrl(b.faviconUrl, env);
  if (fav) link.push({ rel: 'icon', href: fav, type: mimeOf(fav) });
  const touch = assetUrl(b.appleTouchIconUrl, env);
  if (touch) link.push({ rel: 'apple-touch-icon', href: touch, sizes: '180x180' });
  link.push({ rel: 'manifest', href: fileUrls(env).manifest, crossorigin: 'anonymous' });
  for (const t of cfg.seo.extraLinkTags as any[]) link.push({ rel: t.rel, href: t.href.startsWith('/') ? `${base}${t.href}` : t.href, ...(t.hreflang ? { hreflang: t.hreflang } : {}), ...(t.type ? { type: t.type } : {}), ...(t.crossorigin ? { crossorigin: 'anonymous' } : {}) });

  // structured data that belongs to the page
  const sd = cfg.seo.structuredData;
  if (!noindex && !priv) {
    if (isHome) {
      if (sd.organization) jsonLd.unshift(org(cfg, env));
      if (sd.website) jsonLd.push(website(cfg, env));
      if (sd.storeListOnHome && facts.homeStores?.length) jsonLd.push(storeList(cfg, env, facts.homeStores));
      for (const x of sd.extraJsonLd as any[]) if (x) jsonLd.push(x);
    }
    const faqItems = faqsFor(cfg, facts.cmsFaqs ?? [], lang);
    if (cfg.aeo.faq.enabled && faqItems.length && (cfg.aeo.faq.pages as string[]).some((p) => pathMatches(p, path))) jsonLd.push(faqJsonLd(faqItems.slice(0, 50)));
    for (const h of cfg.aeo.howTo as any[]) {
      if (!(h.pages as string[]).some((p) => pathMatches(p, path)) || !h.steps.length) continue;
      jsonLd.push(strip({ '@context': 'https://schema.org', '@type': 'HowTo', name: h.name, description: h.description, totalTime: h.totalTime, step: h.steps.map((st: any, i: number) => ({ '@type': 'HowToStep', position: i + 1, name: st.name, text: st.text, url: st.url ? pageUrl(st.url, cfg, env) : undefined })) }));
    }
    const sp = cfg.aeo.speakable;
    if (sp.enabled && sp.cssSelectors.length && (!sp.pages.length || (sp.pages as string[]).some((p) => pathMatches(p, path)))) {
      jsonLd.push({ '@context': 'https://schema.org', '@type': 'WebPage', '@id': `${canonical}#webpage`, url: canonical, name: pageTitle, speakable: { '@type': 'SpeakableSpecification', cssSelector: sp.cssSelectors } });
    }
  }

  const head: Head = {
    path,
    lang,
    htmlLang: lang,
    title: pageTitle,
    description: desc,
    canonical,
    robots,
    themeColor,
    meta,
    link,
    jsonLd,
    html: '',
    source,
  };
  head.html = headHtml(head);
  return head;
}

function breadcrumbs(cfg: SiteCfg, env: SiteEnv, crumbs: { name: string; url: string }[]): Record<string, unknown> {
  void cfg;
  void env;
  return { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: crumbs.map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: c.name, item: c.url })) };
}

function storeList(cfg: SiteCfg, env: SiteEnv, stores: StoreFacts[]): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: `${cfg.general.siteName}: stores near you`,
    itemListElement: stores.slice(0, 10).map((s, i) => ({ '@type': 'ListItem', position: i + 1, url: `${siteUrl(cfg, env)}/order/r/${s.slug}`, name: s.name })),
  };
}

function mimeOf(url: string): string | undefined {
  const m = /\.(png|jpe?g|webp|gif)(?:[?#]|$)/i.exec(url);
  if (!m) return undefined;
  return { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }[m[1].toLowerCase()];
}

export function headHtml(h: Head): string {
  const out: string[] = [`<title>${esc(h.title)}</title>`];
  for (const m of h.meta) {
    const attr = m.name ? `name="${esc(m.name)}"` : m.property ? `property="${esc(m.property)}"` : `http-equiv="${esc(m.httpEquiv)}"`;
    out.push(`<meta ${attr} content="${esc(m.content)}">`);
  }
  for (const l of h.link) {
    out.push(`<link rel="${esc(l.rel)}" href="${esc(l.href)}"${l.type ? ` type="${esc(l.type)}"` : ''}${l.sizes ? ` sizes="${esc(l.sizes)}"` : ''}${l.hreflang ? ` hreflang="${esc(l.hreflang)}"` : ''}${l.crossorigin ? ` crossorigin="${esc(l.crossorigin)}"` : ''}>`);
  }
  for (const j of h.jsonLd) out.push(`<script type="application/ld+json">${jsonForScript(j)}</script>`);
  return out.join('\n');
}

// ------------------------------------------------------------------ robots.txt
export function renderRobotsTxt(cfg: SiteCfg, env: SiteEnv): string | null {
  const r = cfg.seo.robotsTxt;
  if (!r.enabled) return null;
  const lines: string[] = [`# robots.txt of ${cfg.general.siteName}`];
  if (r.disallowAll) {
    lines.push('User-agent: *', 'Disallow: /');
  } else {
    for (const rule of r.rules as any[]) {
      lines.push('', `User-agent: ${rule.userAgent}`);
      for (const a of rule.allow) lines.push(`Allow: ${a}`);
      for (const d of rule.disallow) lines.push(`Disallow: ${d}`);
      if (rule.crawlDelay) lines.push(`Crawl-delay: ${rule.crawlDelay}`);
      if (!rule.allow.length && !rule.disallow.length) lines.push('Disallow:');
    }
    const byPolicy: Record<string, string[]> = { allow: [], disallow: [] };
    for (const c of cfg.aio.crawlers as any[]) if (c.policy === 'allow' || c.policy === 'disallow') byPolicy[c.policy].push(c.bot);
    for (const [policy, bots] of Object.entries(byPolicy)) {
      if (!bots.length) continue;
      lines.push('', `# AI crawlers: ${policy}`);
      for (const b of bots) lines.push(`User-agent: ${b}`);
      lines.push(policy === 'allow' ? 'Allow: /' : 'Disallow: /');
    }
  }
  const maps = (r.sitemapUrls as string[]).length ? (r.sitemapUrls as string[]).map((u) => pageUrl(u, cfg, env)) : cfg.seo.sitemap.enabled ? [fileUrls(env).sitemap] : [];
  if (maps.length) lines.push('', ...maps.map((m) => `Sitemap: ${m}`));
  if (r.extra.trim()) lines.push('', r.extra.trim());
  return `${lines.join('\n')}\n`;
}

// ------------------------------------------------------------------ sitemap.xml
const xml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
export function renderSitemap(cfg: SiteCfg, env: SiteEnv, stores: { slug: string; updatedAt: Date }[], storeTypes: StoreTypeFact[]): string | null {
  const sm = cfg.seo.sitemap;
  if (!sm.enabled) return null;
  const base = siteUrl(cfg, env);
  const urls: { loc: string; lastmod?: string; changefreq: string; priority: number }[] = [];
  const add = (path: string, changefreq: string, priority: number, lastmod?: Date) => {
    if (isPrivatePath(cfg, path.split('?')[0])) return;
    urls.push({ loc: `${base}${path}`, changefreq, priority, lastmod: lastmod ? lastmod.toISOString().slice(0, 10) : undefined });
  };
  if (sm.includeHome) add('/order', sm.changefreq, 1);
  if (sm.includeStoreTypes) for (const t of storeTypes) if (t.count > 0) add(`/order?t=${t.type}`, sm.changefreq, Math.max(0.5, sm.priority - 0.1));
  if (sm.includeStores) for (const s of stores) add(`/order/r/${s.slug}`, sm.changefreq, sm.priority, s.updatedAt);
  for (const p of sm.extraPages as any[]) add(p.path.replace(/\*$/, ''), p.changefreq, p.priority);
  const lines = urls.slice(0, sm.maxUrls).map((u) => `  <url><loc>${xml(u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}<changefreq>${u.changefreq}</changefreq><priority>${Number(u.priority).toFixed(1)}</priority></url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${lines.join('\n')}\n</urlset>\n`;
}

// ------------------------------------------------------------------ llms.txt
export function renderLlmsTxt(cfg: SiteCfg, env: SiteEnv, stores: StoreFacts[], cmsFaqs: FaqFact[], full: boolean): string | null {
  const l = cfg.aio.llmsTxt;
  if (!l.enabled) return null;
  const g = cfg.geo.generative;
  const base = siteUrl(cfg, env);
  const name = l.title || (g.enabled && g.entityName) || cfg.general.siteName;
  const out: string[] = [`# ${name}`, ''];
  const summary = l.summary || (g.enabled ? g.entityDescription : '') || cfg.general.tagline;
  if (summary) out.push(...summary.split(/\r?\n/).map((x: string) => `> ${x}`), '');
  if (g.enabled && g.keyFacts.length) out.push('## Key facts', '', ...g.keyFacts.map((f: string) => `- ${f}`), '');
  if (g.enabled && g.differentiators.length) out.push('## What makes it different', '', ...g.differentiators.map((f: string) => `- ${f}`), '');
  const areas = cfg.geo.local.enabled ? (cfg.geo.local.serviceAreas as any[]) : [];
  if (areas.length) out.push('## Where it operates', '', ...areas.map((a) => `- ${a.name}${a.type ? ` (${a.type})` : ''}`), '');
  if (g.enabled && g.terminology.length && full) out.push('## Terms', '', ...g.terminology.map((t: any) => `- **${t.term}**: ${t.definition}`), '');
  for (const sec of l.sections as any[]) {
    out.push(`## ${sec.title}`, '', ...sec.links.map((k: any) => `- [${k.title}](${pageUrl(k.url, cfg, env)})${k.description ? `: ${k.description}` : ''}`), '');
  }
  if (l.includeStores && stores.length) {
    out.push('## Stores', '');
    for (const s of stores.slice(0, l.maxStores)) {
      const bits = [s.storeTypeLabel, s.city, s.retail ? '' : s.cuisines.slice(0, 3).join(', ')].filter(Boolean).join(', ');
      out.push(`- [${s.name}](${base}/order/r/${s.slug}): ${bits}${full && s.description ? `. ${truncate(s.description, 200)}` : ''}`);
    }
    out.push('');
  }
  if (l.includeFaq) {
    const faqs = faqsFor(cfg, cmsFaqs, cfg.general.defaultLanguage);
    if (faqs.length) {
      out.push('## Frequently asked questions', '');
      for (const q of faqs.slice(0, full ? 100 : 12)) out.push(full ? `### ${q.question}\n\n${q.answer}\n` : `- ${q.question}`);
      out.push('');
    }
  }
  if (g.enabled && g.sources.length) out.push('## Sources', '', ...g.sources.map((s: any) => `- [${s.title}](${pageUrl(s.url, cfg, env)})`), '');
  const lic = cfg.aio.license;
  const useText = { allowed: 'AI products may use this public content.', 'attribution-required': 'AI products may use this public content with attribution.', 'search-only': 'This content may be used to answer questions with a link back, not for training.', 'not-allowed': 'This content may not be used by AI products.' }[lic.usage as string];
  out.push('## Use of this content', '', [useText, lic.text, lic.contactUrl ? `Contact: ${pageUrl(lic.contactUrl, cfg, env)}` : ''].filter(Boolean).join(' '), '');
  if (g.enabled && g.lastReviewed) out.push(`Facts last reviewed: ${g.lastReviewed}.`, '');
  if (l.extraMarkdown.trim()) out.push(l.extraMarkdown.trim(), '');
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

// ------------------------------------------------------------------ web app manifest
export function renderManifest(cfg: SiteCfg, env: SiteEnv): Record<string, unknown> {
  const b = cfg.branding;
  const icons: Record<string, string>[] = [];
  const i192 = assetUrl(b.pwaIcon192Url, env);
  const i512 = assetUrl(b.pwaIcon512Url, env);
  if (i192) icons.push({ src: i192, sizes: '192x192', type: mimeOf(i192) ?? 'image/png', purpose: 'any' });
  if (i512) icons.push({ src: i512, sizes: '512x512', type: mimeOf(i512) ?? 'image/png', purpose: 'any' }, { src: i512, sizes: '512x512', type: mimeOf(i512) ?? 'image/png', purpose: 'maskable' });
  return strip({
    id: '/order',
    name: cfg.general.siteName,
    short_name: cfg.general.siteName.slice(0, 12),
    description: cfg.general.tagline,
    start_url: `${siteUrl(cfg, env)}/order`,
    scope: `${siteUrl(cfg, env)}/order`,
    display: 'standalone',
    lang: cfg.general.defaultLanguage,
    theme_color: cfg.general.themeColor,
    background_color: cfg.general.backgroundColor,
    icons,
  });
}

export const KNOWN_AI_BOTS = AI_CRAWLERS.map((c) => c.bot);
