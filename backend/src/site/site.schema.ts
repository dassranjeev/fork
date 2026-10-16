import { Script } from 'vm';
import { cleanImageUrl } from '../common/image-url';
import { isSafeUrl } from '../common/security';

/**
 * The site settings (General settings of the website: branding, title, footer, meta tags, SEO, GEO, AEO, AIO, custom CSS / JS) are described ONCE here, as data:
 * the same description validates a save, fills the defaults, and is served to the admin front-end (GET /admin/site/schema) so a form can be built from it.
 * docs/site-settings.md.
 */
export const BRAND_NAME = 'FORKY';

export type Format =
  | 'plain' // text without < >
  | 'url' // http(s) address or a path of this site
  | 'image' // our own upload (jpg, png, webp, gif) or an https picture
  | 'email'
  | 'phone'
  | 'color'
  | 'locale'
  | 'timezone'
  | 'path' // starts with /, no spaces; may end with *
  | 'token' // letters, digits, . _ -
  | 'selector' // a simple CSS selector
  | 'duration' // ISO 8601, PT10M
  | 'time' // HH:MM
  | 'handle' // @name
  | 'date' // YYYY-MM-DD
  | 'code'; // free text kept exactly as sent (custom CSS / JS): see validateCode

export type Field =
  | { t: 'string'; max: number; min?: number; format?: Format; default: string | null; nullable?: boolean; help?: string; multiline?: boolean }
  | { t: 'bool'; default: boolean; help?: string }
  | { t: 'int'; min: number; max: number; default: number | null; nullable?: boolean; help?: string }
  | { t: 'number'; min: number; max: number; default: number | null; nullable?: boolean; help?: string }
  | { t: 'enum'; values: readonly string[]; default: string | null; nullable?: boolean; help?: string }
  | { t: 'array'; of: Field; max: number; unique?: boolean; help?: string }
  | { t: 'object'; fields: Record<string, Field>; help?: string }
  | { t: 'json'; maxBytes: number; max?: number; help?: string };

const s = (max: number, def: string | null = '', o: Partial<Extract<Field, { t: 'string' }>> = {}): Field => ({ t: 'string', max, default: def, ...o });
const nul = (max: number, o: Partial<Extract<Field, { t: 'string' }>> = {}): Field => ({ t: 'string', max, default: null, nullable: true, ...o });
const b = (def: boolean, help?: string): Field => ({ t: 'bool', default: def, help });
const arr = (of: Field, max: number, o: { unique?: boolean; help?: string } = {}): Field => ({ t: 'array', of, max, ...o });
type ObjectField = Extract<Field, { t: 'object' }>;
const obj = (fields: Record<string, Field>, help?: string): ObjectField => ({ t: 'object', fields, help });
const en = (values: readonly string[], def: string | null, o: { nullable?: boolean; help?: string } = {}): Field => ({ t: 'enum', values, default: def, ...o });

// ------------------------------------------------------------------ enumerations (also served by GET /admin/site/options)
export const SOCIAL_NETWORKS = ['facebook', 'instagram', 'x', 'tiktok', 'youtube', 'linkedin', 'pinterest', 'snapchat', 'whatsapp', 'telegram', 'other'] as const;
export const CHANGEFREQ = ['always', 'hourly', 'daily', 'weekly', 'monthly', 'yearly', 'never'] as const;
export const IMAGE_PREVIEW = ['none', 'standard', 'large'] as const;
export const AI_CRAWLERS = [
  { bot: 'GPTBot', owner: 'OpenAI', purpose: 'training' },
  { bot: 'OAI-SearchBot', owner: 'OpenAI', purpose: 'search results in ChatGPT' },
  { bot: 'ChatGPT-User', owner: 'OpenAI', purpose: 'a person asks ChatGPT to open a page' },
  { bot: 'ClaudeBot', owner: 'Anthropic', purpose: 'training' },
  { bot: 'Claude-SearchBot', owner: 'Anthropic', purpose: 'search results in Claude' },
  { bot: 'Claude-User', owner: 'Anthropic', purpose: 'a person asks Claude to open a page' },
  { bot: 'PerplexityBot', owner: 'Perplexity', purpose: 'search results' },
  { bot: 'Perplexity-User', owner: 'Perplexity', purpose: 'a person asks Perplexity to open a page' },
  { bot: 'Google-Extended', owner: 'Google', purpose: 'Gemini training and grounding (not Google Search)' },
  { bot: 'Applebot-Extended', owner: 'Apple', purpose: 'Apple Intelligence training' },
  { bot: 'CCBot', owner: 'Common Crawl', purpose: 'open web archive used for training' },
  { bot: 'Bytespider', owner: 'ByteDance', purpose: 'training' },
  { bot: 'Amazonbot', owner: 'Amazon', purpose: 'Alexa and AI answers' },
  { bot: 'meta-externalagent', owner: 'Meta', purpose: 'training' },
  { bot: 'cohere-ai', owner: 'Cohere', purpose: 'training' },
  { bot: 'DuckAssistBot', owner: 'DuckDuckGo', purpose: 'AI answers' },
  { bot: 'MistralAI-User', owner: 'Mistral', purpose: 'a person asks Le Chat to open a page' },
] as const;
export const AI_POLICIES = ['default', 'allow', 'disallow'] as const;
export const LOCAL_BUSINESS_TYPES = ['Organization', 'LocalBusiness', 'FoodEstablishment', 'Restaurant', 'GroceryStore', 'Store'] as const;
export const AREA_TYPES = ['City', 'AdministrativeArea', 'State', 'Country', 'PostalCode'] as const;
export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;
export const META_KINDS = ['name', 'property', 'http-equiv'] as const;
export const LINK_RELS = ['preconnect', 'dns-prefetch', 'preload', 'alternate', 'me', 'author', 'license', 'help', 'search', 'manifest', 'mask-icon'] as const;
export const LICENSE_USES = ['allowed', 'attribution-required', 'search-only', 'not-allowed'] as const;
/** meta tags / http-equiv values a settings screen must never be able to set (they change how the page is secured or navigated) */
export const BLOCKED_META_KEYS = ['refresh', 'set-cookie', 'content-security-policy', 'content-security-policy-report-only', 'x-frame-options', 'location', 'default-style', 'charset', 'viewport'];
/** placeholders usable in titles and descriptions of store pages */
export const STORE_PLACEHOLDERS = ['name', 'storeType', 'storeTypes', 'city', 'region', 'cuisines', 'description', 'rating', 'minimumOrder', 'siteName', 'tagline', 'year'] as const;
export const PAGE_PLACEHOLDERS = ['siteName', 'tagline', 'year', 'city'] as const;
export const COPYRIGHT_PLACEHOLDERS = ['year', 'siteName', 'legalName'] as const;

export const SECTION_NAMES = ['general', 'branding', 'seo', 'geo', 'aeo', 'aio', 'footer', 'integrations', 'scripts'] as const;
export type SectionName = (typeof SECTION_NAMES)[number];

const link = obj({ label: s(60, ''), url: s(500, '', { format: 'url' }), newTab: b(false) });
const jsonLdBlock: Field = { t: 'json', maxBytes: 20_000, help: 'A schema.org object: {"@context":"https://schema.org","@type":"...",...}' };

export const SCHEMAS: Record<SectionName, ObjectField> = {
  // ================================================================== general
  general: obj({
    siteName: s(80, BRAND_NAME, { min: 1, help: 'The name of the website: used in titles, the manifest, structured data and the copyright line' }),
    tagline: s(160, 'Food and groceries delivered in Mississauga and Brampton'),
    legalName: nul(120, { help: 'The registered company name (copyright line, structured data)' }),
    siteUrl: nul(300, { format: 'url', help: 'The public address of the customer website, e.g. https://app.example.ca. Empty = the WEB_URL of the server' }),
    defaultLanguage: s(12, 'en-CA', { format: 'locale' }),
    supportedLanguages: arr(s(12, 'en-CA', { format: 'locale' }), 10, { unique: true }),
    timezone: s(60, 'America/Toronto', { format: 'timezone' }),
    themeColor: s(7, '#ff6917', { format: 'color', help: 'Browser toolbar colour on phones' }),
    backgroundColor: s(7, '#ffffff', { format: 'color', help: 'Splash screen colour of the installed web app' }),
    copyright: s(200, '© {year} {legalName}. All rights reserved.', { help: 'Placeholders: {year} {siteName} {legalName}' }),
    contact: obj({
      email: nul(120, { format: 'email' }),
      supportEmail: nul(120, { format: 'email' }),
      phone: nul(30, { format: 'phone' }),
      address: obj({ line1: s(120, ''), line2: s(120, ''), city: s(80, 'Mississauga'), region: s(40, 'ON'), postalCode: s(12, ''), country: s(2, 'CA', { min: 2 }) }),
    }),
    social: arr(obj({ network: en(SOCIAL_NETWORKS, 'other'), url: s(300, '', { format: 'url', min: 1 }) }), 12, { help: 'Profiles of the company: shown in the footer and used as sameAs in structured data' }),
    appLinks: obj({ iosUrl: nul(300, { format: 'url' }), androidUrl: nul(300, { format: 'url' }) }),
  }),

  // ================================================================== branding
  branding: obj({
    logoUrl: nul(500, { format: 'image', help: 'Main logo (light backgrounds)' }),
    logoDarkUrl: nul(500, { format: 'image', help: 'Logo for dark backgrounds' }),
    logoSquareUrl: nul(500, { format: 'image', help: 'Square logo / avatar (structured data, assistant, chat)' }),
    logoAlt: s(120, '', { help: 'Alternative text of the logo; empty = the site name' }),
    faviconUrl: nul(500, { format: 'image', help: 'Browser tab icon, square, 32 px or more' }),
    appleTouchIconUrl: nul(500, { format: 'image', help: 'iPhone home screen icon, square, 180 px or more' }),
    pwaIcon192Url: nul(500, { format: 'image', help: 'Installed web app icon, square, 192 px or more' }),
    pwaIcon512Url: nul(500, { format: 'image', help: 'Installed web app icon, square, 512 px or more' }),
    ogImageUrl: nul(500, { format: 'image', help: 'Picture shown when a link is shared (Facebook, WhatsApp, LinkedIn...), 1200x630 recommended' }),
    twitterImageUrl: nul(500, { format: 'image', help: 'Picture of a shared link on X; empty = the share picture above' }),
    primaryColor: nul(7, { format: 'color' }),
    secondaryColor: nul(7, { format: 'color' }),
    accentColor: nul(7, { format: 'color' }),
  }),

  // ================================================================== seo
  seo: obj({
    defaultTitle: s(70, `${BRAND_NAME} - food and groceries delivered`, { min: 1, help: 'Title of pages that have none of their own (and of the home page)' }),
    titleTemplate: s(100, '%s | {siteName}', { min: 2, help: 'Title of every other page: %s is the page title. Placeholders: {siteName} {tagline}' }),
    metaDescription: s(320, 'Order from local restaurants, cafes, bakeries and grocery stores in Mississauga and Brampton. Fast delivery or pickup.', { help: '50 to 160 characters works best' }),
    metaKeywords: arr(s(40, '', { min: 1 }), 20, { unique: true, help: 'Old-style keywords: search engines ignore them, some directories still read them' }),
    robots: obj(
      {
        index: b(true, 'false adds noindex to every page: use it on a test site only'),
        follow: b(true),
        maxSnippet: { t: 'int', min: -1, max: 1000, default: -1, help: '-1 = no limit' } as Field,
        maxImagePreview: en(IMAGE_PREVIEW, 'large'),
        maxVideoPreview: { t: 'int', min: -1, max: 600, default: -1 } as Field,
        noarchive: b(false),
        notranslate: b(false),
      },
      'The robots meta tag of every public page',
    ),
    canonicalStripQuery: b(true, 'The canonical address of a page ignores ?filters (it keeps the page itself)'),
    canonicalKeepParams: arr(s(30, '', { format: 'token', min: 1 }), 10, { unique: true, help: 'Query parameters that make a different page (the canonical keeps them), e.g. t for the kind of store' }),
    openGraph: obj({
      enabled: b(true),
      type: en(['website', 'article', 'business.business', 'restaurant.restaurant'], 'website'),
      siteName: nul(80, { help: 'Empty = the site name' }),
      locale: s(12, 'en_CA'),
      localeAlternates: arr(s(12, '', { min: 2 }), 5, { unique: true }),
    }),
    twitter: obj({ enabled: b(true), card: en(['summary', 'summary_large_image'], 'summary_large_image'), site: nul(31, { format: 'handle' }), creator: nul(31, { format: 'handle' }) }),
    verification: obj({
      google: nul(120, { format: 'token' }),
      bing: nul(120, { format: 'token' }),
      yandex: nul(120, { format: 'token' }),
      baidu: nul(120, { format: 'token' }),
      pinterest: nul(120, { format: 'token' }),
      facebookDomain: nul(120, { format: 'token' }),
    }),
    extraMetaTags: arr(obj({ kind: en(META_KINDS, 'name'), key: s(60, '', { min: 1, format: 'token' }), content: s(500, '') }), 30, { help: 'More <meta> tags on every page. Tags that change security or navigation (refresh, set-cookie, content-security-policy...) are refused' }),
    extraLinkTags: arr(obj({ rel: en(LINK_RELS, 'preconnect'), href: s(500, '', { format: 'url', min: 1 }), hreflang: nul(12, { format: 'locale' }), type: nul(60, { format: 'token' }), crossorigin: b(false) }), 20, { help: 'More <link> tags on every page (preconnect, alternate languages...)' }),
    templates: obj(
      {
        store: obj({ title: s(140, '{name} - {storeType} delivery in {city}'), description: s(320, 'Order from {name}, a {storeType} in {city}, for delivery or pickup. {description}') }),
        storeType: obj({ title: s(140, '{storeTypes} in {city}'), description: s(320, 'Browse {storeTypes} near you in {city} and have your order delivered or ready for pickup.') }),
      },
      'Titles and descriptions of store pages and kind-of-store pages. Placeholders of a store: {name} {storeType} {storeTypes} {city} {region} {cuisines} {description} {rating} {minimumOrder} {siteName} {tagline} {year}',
    ),
    pages: arr(
      obj({
        path: s(200, '', { format: 'path', min: 1, help: 'A page of the customer website, e.g. /order/login. A trailing * matches everything below it' }),
        title: nul(140),
        description: nul(320),
        robots: nul(120, { help: 'e.g. noindex,nofollow (replaces the default for this page)' }),
        canonicalUrl: nul(500, { format: 'url' }),
        ogImageUrl: nul(500, { format: 'image' }),
        keywords: arr(s(40, '', { min: 1 }), 20),
      }),
      100,
      { help: 'Meta tags of a particular page (first match wins, exact paths before patterns)' },
    ),
    privatePaths: arr(s(200, '', { format: 'path', min: 1 }), 40, {
      unique: true,
      help: 'Pages that are never indexed (noindex,nofollow) and kept out of the sitemap',
    }),
    robotsTxt: obj({
      enabled: b(true),
      disallowAll: b(false, 'Blocks every crawler from the whole site: for a test site'),
      rules: arr(obj({ userAgent: s(60, '*', { format: 'token', min: 1 }), allow: arr(s(200, '', { format: 'path', min: 1 }), 50), disallow: arr(s(200, '', { format: 'path', min: 1 }), 50), crawlDelay: { t: 'int', min: 0, max: 60, default: null, nullable: true } as Field }), 20),
      sitemapUrls: arr(s(300, '', { format: 'url', min: 1 }), 5, { help: 'Empty = the sitemap of this API' }),
      extra: s(2000, '', { multiline: true, help: 'Extra lines added at the end, kept as they are (no HTML)' }),
    }),
    sitemap: obj({
      enabled: b(true),
      includeStores: b(true),
      includeStoreTypes: b(true),
      includeHome: b(true),
      changefreq: en(CHANGEFREQ, 'daily'),
      priority: { t: 'number', min: 0, max: 1, default: 0.7 } as Field,
      maxUrls: { t: 'int', min: 100, max: 50_000, default: 5000 } as Field,
      extraPages: arr(obj({ path: s(200, '', { format: 'path', min: 1 }), changefreq: en(CHANGEFREQ, 'monthly'), priority: { t: 'number', min: 0, max: 1, default: 0.5 } as Field }), 100),
    }),
    structuredData: obj({
      organization: b(true, 'Organization: name, logo, contact, social profiles'),
      website: b(true, 'WebSite with a search box'),
      breadcrumbs: b(true),
      localBusinessForStores: b(true, 'A LocalBusiness (Restaurant, GroceryStore...) for every store page: address, hours, rating, order link'),
      storeListOnHome: b(true, 'An ItemList of stores on the home page'),
      extraJsonLd: arr(jsonLdBlock, 10, { help: 'More schema.org blocks added on the home page' }),
    }),
  }),

  // ================================================================== geo (Generative Engine Optimization + local / geographic signals)
  geo: obj(
    {
      generative: obj(
        {
          enabled: b(true, 'Facts about the company for AI assistants and answer engines: llms.txt, the Organization description, quotes'),
          entityName: nul(80, { help: 'How the company should be named in AI answers; empty = the site name' }),
          entityDescription: s(800, '', { multiline: true, help: 'Two or three plain sentences: what the company is, where it works, who it is for' }),
          keyFacts: arr(s(240, '', { min: 1 }), 20, { help: 'Short, checkable facts: delivery area, how it works, fees, hours' }),
          differentiators: arr(s(240, '', { min: 1 }), 10),
          terminology: arr(obj({ term: s(80, '', { min: 1 }), definition: s(300, '', { min: 1 }) }), 30),
          sources: arr(obj({ title: s(120, '', { min: 1 }), url: s(300, '', { format: 'url', min: 1 }) }), 20, { help: 'Official pages an answer can cite' }),
          lastReviewed: nul(10, { format: 'date', help: 'When these facts were last checked (YYYY-MM-DD)' }),
        },
        'Generative Engine Optimization',
      ),
      local: obj(
        {
          enabled: b(true, 'Geographic signals: geo meta tags and the area served in structured data'),
          businessType: en(LOCAL_BUSINESS_TYPES, 'Organization'),
          region: nul(10, { help: 'ISO 3166-2, e.g. CA-ON' }),
          placename: nul(80, { help: 'e.g. Mississauga' }),
          position: obj({ lat: { t: 'number', min: -90, max: 90, default: null, nullable: true } as Field, lng: { t: 'number', min: -180, max: 180, default: null, nullable: true } as Field }),
          priceRange: nul(10),
          serviceAreas: arr(obj({ name: s(80, '', { min: 1 }), type: en(AREA_TYPES, 'City'), lat: { t: 'number', min: -90, max: 90, default: null, nullable: true } as Field, lng: { t: 'number', min: -180, max: 180, default: null, nullable: true } as Field, radiusKm: { t: 'number', min: 0, max: 500, default: null, nullable: true } as Field }), 40),
          hours: arr(obj({ days: arr(en(WEEKDAYS, 'Monday'), 7, { unique: true }), opens: s(5, '09:00', { format: 'time' }), closes: s(5, '21:00', { format: 'time' }) }), 14, { help: 'Opening hours of the company (customer service); stores have their own' }),
        },
        'Local and geographic signals',
      ),
    },
    'GEO',
  ),

  // ================================================================== aeo (Answer Engine Optimization)
  aeo: obj(
    {
      faq: obj({
        enabled: b(true, 'FAQPage structured data and the public FAQ list'),
        includeCmsFaqs: b(true, 'Also use the active customer questions of Content > FAQ'),
        pages: arr(s(200, '', { format: 'path', min: 1 }), 20, { unique: true, help: 'Pages that carry the FAQ structured data' }),
        items: arr(obj({ question: s(200, '', { min: 3 }), answer: s(1000, '', { min: 3, multiline: true }), category: nul(60), language: nul(12, { format: 'locale' }) }), 100),
      }),
      howTo: arr(
        obj({
          name: s(120, '', { min: 3 }),
          description: nul(300),
          totalTime: nul(20, { format: 'duration', help: 'ISO 8601, e.g. PT15M' }),
          pages: arr(s(200, '', { format: 'path', min: 1 }), 10, { unique: true }),
          steps: arr(obj({ name: s(100, '', { min: 1 }), text: s(500, '', { min: 1 }), url: nul(300, { format: 'url' }) }), 20),
        }),
        10,
        { help: 'Step-by-step guides (HowTo structured data)' },
      ),
      speakable: obj({ enabled: b(false, 'Marks parts of a page voice assistants may read aloud'), cssSelectors: arr(s(100, '', { format: 'selector', min: 1 }), 10, { unique: true }), pages: arr(s(200, '', { format: 'path', min: 1 }), 20, { unique: true }) }),
    },
    'AEO',
  ),

  // ================================================================== aio (AI search and AI overviews)
  aio: obj(
    {
      crawlers: arr(obj({ bot: s(60, '', { format: 'token', min: 1 }), policy: en(AI_POLICIES, 'default') }), 40, { help: 'What each AI crawler may do (written into robots.txt). default = say nothing' }),
      llmsTxt: obj({
        enabled: b(true, 'Publishes /llms.txt: a short, clean summary of the site for AI assistants'),
        title: nul(80, { help: 'Empty = the site name' }),
        summary: s(500, '', { multiline: true, help: 'One or two sentences under the title; empty = the entity description' }),
        sections: arr(obj({ title: s(60, '', { min: 1 }), links: arr(obj({ title: s(100, '', { min: 1 }), url: s(300, '', { format: 'url', min: 1 }), description: s(200, '') }), 30) }), 10),
        includeStores: b(true, 'List the live stores'),
        maxStores: { t: 'int', min: 0, max: 200, default: 30 } as Field,
        includeFaq: b(true),
        extraMarkdown: s(4000, '', { multiline: true, help: 'Extra Markdown at the end, kept as it is (no HTML)' }),
      }),
      license: obj({
        usage: en(LICENSE_USES, 'allowed', { help: 'How AI products may use the public content' }),
        text: s(300, '', { help: 'A sentence shown in llms.txt, e.g. "Please cite FORKY and link to the page."' }),
        contactUrl: nul(300, { format: 'url' }),
      }),
      snippets: obj({
        noai: b(false, 'Adds noai, noimageai to the robots meta tag: asks AI products not to train on the pages'),
        noSnippet: b(false, 'nosnippet: no text excerpts in search results and AI overviews'),
      }),
    },
    'AIO',
  ),

  // ================================================================== footer
  footer: obj({
    columns: arr(obj({ title: s(60, '', { min: 1 }), links: arr(link, 12) }), 6),
    bottomLinks: arr(obj({ label: s(60, '', { min: 1 }), url: s(500, '', { format: 'url', min: 1 }), newTab: b(false) }), 10, { help: 'Terms, privacy, accessibility...' }),
    legalText: s(500, '', { multiline: true }),
    showSocial: b(true),
    showAppLinks: b(true),
    showContact: b(true),
    showLanguageSwitcher: b(true),
  }),

  // ================================================================== integrations
  integrations: obj({
    googleAnalyticsId: nul(30, { format: 'token', help: 'G-XXXXXXXXXX' }),
    googleTagManagerId: nul(30, { format: 'token', help: 'GTM-XXXXXXX' }),
    googleAdsId: nul(30, { format: 'token', help: 'AW-XXXXXXXXX' }),
    metaPixelId: nul(30, { format: 'token', help: 'digits' }),
    microsoftClarityId: nul(30, { format: 'token' }),
    tiktokPixelId: nul(40, { format: 'token' }),
    consentRequired: b(true, 'The website loads these only after the visitor agreed (cookie banner)'),
  }),

  // ================================================================== scripts (custom CSS / JavaScript: Super Admin only)
  scripts: obj({
    enabled: b(false, 'Kill switch: false = nothing below is published'),
    customCss: s(60_000, '', { format: 'code', multiline: true, help: 'CSS added to every page' }),
    headJs: s(60_000, '', { format: 'code', multiline: true, help: 'JavaScript that runs early (in <head>)' }),
    bodyJs: s(60_000, '', { format: 'code', multiline: true, help: 'JavaScript that runs at the end of <body>' }),
    notes: s(300, '', { help: 'What this code is for (not published)' }),
  }),
};

// ------------------------------------------------------------------ defaults
export function defaultOf(f: Field): any {
  switch (f.t) {
    case 'object': return Object.fromEntries(Object.entries(f.fields).map(([k, v]) => [k, defaultOf(v)]));
    case 'array': return [];
    case 'json': return null;
    default: return (f as any).default;
  }
}

/** Starting values that are lists (they cannot be written inline in the schema above) */
const LIST_DEFAULTS: Partial<Record<SectionName, (d: any) => void>> = {
  general: (d) => {
    d.supportedLanguages = ['en-CA', 'fr-CA'];
  },
  seo: (d) => {
    d.privatePaths = ['/order/login', '/order/checkout', '/order/orders', '/order/track/*', '/order/wallet', '/order/notifications', '/order/account', '/order/handoff', '/order/payouts/*', '/portal*', '/driver-demo.html'];
    d.robotsTxt.rules = [{ userAgent: '*', allow: ['/order'], disallow: ['/portal', '/order/login', '/order/checkout', '/order/orders', '/order/track/', '/order/wallet', '/order/notifications', '/order/account', '/order/handoff', '/order/payouts/'], crawlDelay: null }];
    d.canonicalKeepParams = ['t'];
    d.openGraph.localeAlternates = ['fr_CA'];
    d.structuredData.extraJsonLd = [];
  },
  aeo: (d) => {
    d.faq.pages = ['/order'];
  },
  aio: (d) => {
    d.crawlers = AI_CRAWLERS.map((c) => ({ bot: c.bot, policy: 'default' }));
  },
};

export function defaultSection(name: SectionName): any {
  const d = defaultOf(SCHEMAS[name]);
  LIST_DEFAULTS[name]?.(d);
  return d;
}

// ------------------------------------------------------------------ validation
export interface Problem {
  path: string;
  message: string;
}

const RE = {
  email: /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/,
  phone: /^\+?[0-9 ()\-.]{7,30}$/,
  color: /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/,
  locale: /^[a-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/,
  path: /^\/[A-Za-z0-9\-._~%!$&'()+,;=:@/]*\*?$/,
  token: /^[A-Za-z0-9._\-*]+$/,
  selector: /^[A-Za-z0-9_\-.#\[\]="':>+~*(), ]{1,100}$/,
  duration: /^P(?=\d|T\d)(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+S)?)?$/,
  time: /^(?:[01]\d|2[0-3]):[0-5]\d$/,
  handle: /^@?[A-Za-z0-9_]{1,30}$/,
  date: /^\d{4}-\d{2}-\d{2}$/,
};

function checkString(f: Extract<Field, { t: 'string' }>, v: string, path: string, out: Problem[]): string | null {
  let x = v;
  if (f.format !== 'code') x = x.trim();
  if (f.format !== 'code' && /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(x)) {
    out.push({ path, message: 'contains control characters' });
    return null;
  }
  if (f.multiline !== true && /[\r\n]/.test(x) && f.format !== 'code') {
    out.push({ path, message: 'must be one line' });
    return null;
  }
  if (x.length > f.max) {
    out.push({ path, message: `is longer than ${f.max} characters` });
    return null;
  }
  if (x === '') {
    if (f.nullable) return null;
    if ((f.min ?? 0) > 0) {
      out.push({ path, message: 'is required' });
      return null;
    }
    return '';
  }
  if (f.min && x.length < f.min) {
    out.push({ path, message: `must be at least ${f.min} characters` });
    return null;
  }
  const bad = (m: string) => {
    out.push({ path, message: m });
    return null;
  };
  switch (f.format) {
    case 'plain':
    case undefined:
      if (/[<>]/.test(x) && f.multiline !== true) return bad('must not contain < or >');
      if (/<\s*\/?\s*[a-zA-Z!]/.test(x)) return bad('must be plain text without HTML');
      return x;
    case 'url':
      return isSafeUrl(x) ? x : bad('must be an http(s) address or a path of this site');
    case 'image':
      try {
        return cleanImageUrl(x, path);
      } catch (e: any) {
        return bad(String(e?.response?.message ?? 'is not a valid picture address').replace(`${path}: `, ''));
      }
    case 'email': return RE.email.test(x) ? x : bad('is not an email address');
    case 'phone': return RE.phone.test(x) ? x : bad('is not a phone number');
    case 'color': return RE.color.test(x) ? x.toLowerCase() : bad('must be a colour like #ff6917');
    case 'locale': return RE.locale.test(x) ? x : bad('must be a language tag like en-CA');
    case 'timezone':
      try {
        new Intl.DateTimeFormat('en', { timeZone: x });
        return x;
      } catch {
        return bad('is not a time zone name (e.g. America/Toronto)');
      }
    case 'path': return RE.path.test(x) ? x : bad('must start with / and contain no spaces (a trailing * matches everything below)');
    case 'token': return RE.token.test(x) ? x : bad('may only contain letters, digits and . _ - *');
    case 'selector': return RE.selector.test(x) ? x : bad('is not a simple CSS selector');
    case 'duration': return RE.duration.test(x) ? x : bad('must be an ISO 8601 duration like PT15M');
    case 'time': return RE.time.test(x) ? x : bad('must be a time like 09:30');
    case 'handle': return RE.handle.test(x) ? (x.startsWith('@') ? x : `@${x}`) : bad('must be a handle like @forky');
    case 'date': return RE.date.test(x) && !Number.isNaN(Date.parse(x)) ? x : bad('must be a date like 2026-10-16');
    case 'code': return x;
  }
  return x;
}

/** Validates `input` against the field and returns the cleaned value (defaults filled for missing keys). Problems are collected, not thrown. */
export function validateField(f: Field, input: unknown, path: string, out: Problem[]): any {
  const isNull = input === null || input === undefined;
  switch (f.t) {
    case 'string': {
      if (isNull) return f.nullable ? null : f.default ?? '';
      if (typeof input !== 'string') {
        out.push({ path, message: 'must be text' });
        return f.default;
      }
      const r = checkString(f, input, path, out);
      return r === null && !f.nullable ? f.default ?? '' : r;
    }
    case 'bool':
      if (isNull) return f.default;
      if (typeof input !== 'boolean') {
        out.push({ path, message: 'must be true or false' });
        return f.default;
      }
      return input;
    case 'int':
    case 'number': {
      if (isNull) return f.nullable ? null : f.default;
      if (typeof input !== 'number' || !Number.isFinite(input) || (f.t === 'int' && !Number.isInteger(input))) {
        out.push({ path, message: f.t === 'int' ? 'must be a whole number' : 'must be a number' });
        return f.default;
      }
      if (input < f.min || input > f.max) {
        out.push({ path, message: `must be between ${f.min} and ${f.max}` });
        return f.default;
      }
      return input;
    }
    case 'enum': {
      if (isNull) return f.nullable ? null : f.default;
      if (typeof input !== 'string' || !f.values.includes(input)) {
        out.push({ path, message: `must be one of: ${f.values.join(', ')}` });
        return f.default;
      }
      return input;
    }
    case 'array': {
      if (isNull) return [];
      if (!Array.isArray(input)) {
        out.push({ path, message: 'must be a list' });
        return [];
      }
      if (input.length > f.max) {
        out.push({ path, message: `can hold at most ${f.max} entries` });
        return [];
      }
      const items = input.map((v, i) => validateField(f.of, v, `${path}[${i}]`, out));
      if (f.unique) {
        const seen = new Set<string>();
        items.forEach((v, i) => {
          const k = JSON.stringify(v);
          if (seen.has(k)) out.push({ path: `${path}[${i}]`, message: 'is listed twice' });
          seen.add(k);
        });
      }
      return items;
    }
    case 'object': {
      if (isNull) return defaultOf(f);
      if (typeof input !== 'object' || Array.isArray(input)) {
        out.push({ path, message: 'must be an object' });
        return defaultOf(f);
      }
      const src = input as Record<string, unknown>;
      for (const k of Object.keys(src)) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype' || !(k in f.fields)) out.push({ path: path ? `${path}.${k}` : k, message: 'is not a known field' });
      }
      const res: Record<string, any> = {};
      for (const [k, sub] of Object.entries(f.fields)) res[k] = validateField(sub, src[k], path ? `${path}.${k}` : k, out);
      return res;
    }
    case 'json': {
      if (isNull) return null;
      if (typeof input !== 'object' || Array.isArray(input)) {
        out.push({ path, message: 'must be a JSON object' });
        return null;
      }
      const text = JSON.stringify(input);
      if (text.length > f.maxBytes) {
        out.push({ path, message: `is larger than ${f.maxBytes} bytes` });
        return null;
      }
      const o = input as Record<string, any>;
      if (typeof o['@type'] !== 'string' && !Array.isArray(o['@type']) && !o['@graph']) out.push({ path, message: 'needs an "@type" (a schema.org type)' });
      if (/<\s*\/?\s*script/i.test(text)) out.push({ path, message: 'must not contain script tags' });
      return JSON.parse(text);
    }
  }
}

// ------------------------------------------------------------------ rules that need more than one field
const placeholders = (text: string) => [...text.matchAll(/\{([A-Za-z]+)\}/g)].map((m) => m[1]);
function onlyPlaceholders(text: string, allowed: readonly string[], path: string, out: Problem[]) {
  for (const p of placeholders(text)) if (!allowed.includes(p)) out.push({ path, message: `{${p}} is not a placeholder here (use: ${allowed.map((a) => `{${a}}`).join(' ')})` });
}

/** The code fields: size is checked by the schema; here the syntax and the sequences that would break out of their <style> / <script> tag. */
export function validateCode(name: 'customCss' | 'headJs' | 'bodyJs', code: string, out: Problem[]) {
  const path = `scripts.${name}`;
  if (!code.trim()) return;
  if (/\u0000/.test(code)) out.push({ path, message: 'contains a NUL character' });
  if (name === 'customCss') {
    if (/<\s*\/?\s*(style|script)/i.test(code) || /<!--|-->/.test(code)) out.push({ path, message: 'must be plain CSS: no <style>, <script> or HTML comments' });
    if (/expression\s*\(|javascript\s*:|behavior\s*:|-moz-binding/i.test(code)) out.push({ path, message: 'uses a script-in-CSS feature that is not allowed' });
    for (const m of code.matchAll(/@import\s+(?:url\()?\s*['"]?([^'")\s;]+)/gi)) if (!/^https:\/\//i.test(m[1])) out.push({ path, message: '@import needs an https:// address' });
    let depth = 0;
    let inStr: string | null = null;
    for (let i = 0; i < code.length; i++) {
      const c = code[i];
      if (inStr) {
        if (c === '\\') i++;
        else if (c === inStr) inStr = null;
        continue;
      }
      if (c === '/' && code[i + 1] === '*') {
        const end = code.indexOf('*/', i + 2);
        if (end < 0) {
          out.push({ path, message: 'has a comment that is never closed' });
          return;
        }
        i = end + 1;
      } else if (c === '"' || c === "'") inStr = c;
      else if (c === '{') depth++;
      else if (c === '}' && --depth < 0) {
        out.push({ path, message: 'has a } without a matching {' });
        return;
      }
    }
    if (depth !== 0) out.push({ path, message: 'has a { that is never closed' });
    return;
  }
  if (/<\s*\/?\s*script/i.test(code) || /<!--/.test(code)) out.push({ path, message: 'must be plain JavaScript: no <script> tags or HTML comments' });
  try {
    // syntax check only: compiling does not run the code
    new Script(code, { filename: `${name}.js` });
  } catch (e: any) {
    out.push({ path, message: `has a JavaScript syntax error: ${String(e?.message ?? e).slice(0, 160)}` });
  }
}

export function validateSection(name: SectionName, input: unknown): { value: any; problems: Problem[] } {
  const probs: Problem[] = [];
  const value = validateField(SCHEMAS[name], input, '', probs);
  const problems = probs.map((p) => ({ path: p.path ? `${name}.${p.path}` : name, message: p.message }));
  extra(name, value, problems);
  return { value, problems };
}

function extra(name: SectionName, v: any, out: Problem[]) {
  if (name === 'general') {
    onlyPlaceholders(v.copyright, COPYRIGHT_PLACEHOLDERS, 'general.copyright', out);
    if (!v.supportedLanguages.includes(v.defaultLanguage)) out.push({ path: 'general.supportedLanguages', message: `must include the default language ${v.defaultLanguage}` });
  }
  if (name === 'seo') {
    if ((v.titleTemplate.match(/%s/g) ?? []).length !== 1) out.push({ path: 'seo.titleTemplate', message: 'must contain %s exactly once' });
    onlyPlaceholders(v.titleTemplate.replace('%s', ''), ['siteName', 'tagline'], 'seo.titleTemplate', out);
    for (const k of ['title', 'description'] as const) {
      onlyPlaceholders(v.templates.store[k], STORE_PLACEHOLDERS, `seo.templates.store.${k}`, out);
      onlyPlaceholders(v.templates.storeType[k], STORE_PLACEHOLDERS, `seo.templates.storeType.${k}`, out);
    }
    v.extraMetaTags.forEach((t: any, i: number) => {
      if (BLOCKED_META_KEYS.includes(String(t.key).toLowerCase())) out.push({ path: `seo.extraMetaTags[${i}].key`, message: `${t.key} cannot be set here (it changes how pages are secured or navigated)` });
      if (!t.content && t.key) out.push({ path: `seo.extraMetaTags[${i}].content`, message: 'is required' });
    });
    v.extraLinkTags.forEach((t: any, i: number) => {
      if (t.rel === 'alternate' && !t.hreflang && !t.type) out.push({ path: `seo.extraLinkTags[${i}]`, message: 'an alternate link needs a language (hreflang) or a type' });
    });
    const seen = new Set<string>();
    v.pages.forEach((p: any, i: number) => {
      if (seen.has(p.path)) out.push({ path: `seo.pages[${i}].path`, message: 'is listed twice' });
      seen.add(p.path);
      if (p.title) onlyPlaceholders(p.title, PAGE_PLACEHOLDERS, `seo.pages[${i}].title`, out);
      if (p.description) onlyPlaceholders(p.description, PAGE_PLACEHOLDERS, `seo.pages[${i}].description`, out);
      if (p.robots && !/^(?:(?:no)?index|(?:no)?follow|noarchive|nosnippet|noimageindex|notranslate|none|all|max-[a-z-]+:\s*-?\d+|max-image-preview:\s*(?:none|standard|large)|unavailable_after:[^,]+)(?:\s*,\s*(?:(?:no)?index|(?:no)?follow|noarchive|nosnippet|noimageindex|notranslate|none|all|max-[a-z-]+:\s*-?\d+|max-image-preview:\s*(?:none|standard|large)|unavailable_after:[^,]+))*$/i.test(p.robots)) {
        out.push({ path: `seo.pages[${i}].robots`, message: 'must be robots directives like noindex,nofollow' });
      }
    });
    onlyPlaceholders(v.defaultTitle, ['siteName', 'tagline'], 'seo.defaultTitle', out);
    v.robotsTxt.rules.forEach((r: any, i: number) => {
      for (const k of ['allow', 'disallow'] as const) r[k].forEach((p: string, j: number) => { if (/\s/.test(p)) out.push({ path: `seo.robotsTxt.rules[${i}].${k}[${j}]`, message: 'must not contain spaces' }); });
    });
    if (/<|>/.test(v.robotsTxt.extra)) out.push({ path: 'seo.robotsTxt.extra', message: 'must be plain text lines (no HTML)' });
  }
  if (name === 'geo') {
    const days = v.local.hours.flatMap((h: any) => h.days);
    if (new Set(days).size !== days.length) out.push({ path: 'geo.local.hours', message: 'a weekday appears in two rows' });
    v.local.hours.forEach((h: any, i: number) => {
      if (!h.days.length) out.push({ path: `geo.local.hours[${i}].days`, message: 'needs at least one weekday' });
    });
    const p = v.local.position;
    if ((p.lat === null) !== (p.lng === null)) out.push({ path: 'geo.local.position', message: 'needs both lat and lng' });
    if (v.local.region && !/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/.test(v.local.region)) out.push({ path: 'geo.local.region', message: 'must look like CA-ON' });
  }
  if (name === 'aeo') {
    v.speakable.cssSelectors.forEach((c: string, i: number) => { if (/[<>]/.test(c)) out.push({ path: `aeo.speakable.cssSelectors[${i}]`, message: 'is not a CSS selector' }); });
    if (v.speakable.enabled && !v.speakable.cssSelectors.length) out.push({ path: 'aeo.speakable.cssSelectors', message: 'needs at least one selector when speakable is on' });
  }
  if (name === 'aio') {
    const names = new Set<string>();
    v.crawlers.forEach((c: any, i: number) => {
      const k = String(c.bot).toLowerCase();
      if (names.has(k)) out.push({ path: `aio.crawlers[${i}].bot`, message: 'is listed twice' });
      names.add(k);
    });
    if (/<|>/.test(v.llmsTxt.extraMarkdown)) out.push({ path: 'aio.llmsTxt.extraMarkdown', message: 'must be Markdown without HTML' });
  }
  if (name === 'footer') {
    // a footer link is shown exactly as saved: only the labels need to be plain text
    v.columns.forEach((c: any, i: number) => c.links.forEach((l: any, j: number) => { if (!l.label) out.push({ path: `footer.columns[${i}].links[${j}].label`, message: 'is required' }); if (!l.url) out.push({ path: `footer.columns[${i}].links[${j}].url`, message: 'is required' }); }));
  }
  if (name === 'integrations') {
    const rules: [string, RegExp, string][] = [
      ['googleAnalyticsId', /^G-[A-Z0-9]{4,20}$/, 'must look like G-XXXXXXXXXX'],
      ['googleTagManagerId', /^GTM-[A-Z0-9]{4,12}$/, 'must look like GTM-XXXXXXX'],
      ['googleAdsId', /^AW-\d{6,14}$/, 'must look like AW-123456789'],
      ['metaPixelId', /^\d{6,20}$/, 'must be digits'],
      ['microsoftClarityId', /^[a-z0-9]{6,20}$/, 'must be the letters and digits of the Clarity project id'],
      ['tiktokPixelId', /^[A-Z0-9]{8,30}$/, 'must be the letters and digits of the pixel id'],
    ];
    for (const [k, re, msg] of rules) if (v[k] && !re.test(v[k])) out.push({ path: `integrations.${k}`, message: msg });
  }
  if (name === 'scripts') {
    for (const k of ['customCss', 'headJs', 'bodyJs'] as const) validateCode(k, v[k], out);
  }
}

/** The description of the sections for a form builder (GET /admin/site/schema). */
export function describe(f: Field): any {
  switch (f.t) {
    case 'object': return { type: 'object', help: f.help, fields: Object.fromEntries(Object.entries(f.fields).map(([k, v]) => [k, describe(v)])) };
    case 'array': return { type: 'array', max: f.max, unique: f.unique || undefined, help: f.help, of: describe(f.of) };
    case 'string': return { type: 'string', format: f.format ?? 'plain', max: f.max, min: f.min, nullable: f.nullable || undefined, multiline: f.multiline || undefined, default: f.default, help: f.help };
    case 'enum': return { type: 'enum', values: f.values, nullable: f.nullable || undefined, default: f.default, help: f.help };
    case 'int':
    case 'number': return { type: f.t, min: f.min, max: f.max, nullable: f.nullable || undefined, default: f.default, help: f.help };
    case 'bool': return { type: 'boolean', default: f.default, help: f.help };
    case 'json': return { type: 'json', maxBytes: f.maxBytes, help: f.help };
  }
}

