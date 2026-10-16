/**
 * Unit tests of the website's General settings (no server, no database): the schema (validation, defaults, the rules that need more than one field, custom CSS / JavaScript checks)
 * and the generators (page head, JSON-LD, robots.txt, sitemap.xml, llms.txt, manifest, picture sizes). Docs: docs/site-settings.md.
 *
 *   cd backend && npx ts-node --transpile-only test/site.test.ts
 *
 * Prints PASS / FAIL per check and exits 1 on any FAIL.
 */
import 'reflect-metadata';
import { imageSize } from '../src/common/image-size';
import { SECTION_NAMES, SectionName, defaultSection, describe, validateSection } from '../src/site/site.schema';
import {
  SiteCfg,
  SiteEnv,
  StoreFacts,
  buildHead,
  faqsFor,
  fill,
  isPrivatePath,
  jsonForScript,
  normalisePath,
  pathMatches,
  renderLlmsTxt,
  renderManifest,
  renderRobotsTxt,
  renderSitemap,
  robotsMeta,
  truncate,
} from '../src/site/site.render';

let failed = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const env: SiteEnv = { webUrl: 'https://app.example.ca', publicUrl: 'https://api.example.ca' };
const cfgWith = (patch: Partial<Record<SectionName, any>> = {}): SiteCfg => {
  const o: any = {};
  for (const n of SECTION_NAMES) o[n] = { ...defaultSection(n), ...(patch[n] ?? {}) };
  return o as SiteCfg;
};
const problems = (name: SectionName, input: any) => validateSection(name, input).problems;
const has = (name: SectionName, input: any, path: string) => problems(name, input).some((p) => p.path === path || p.path.startsWith(`${path}[`) || p.path.startsWith(`${path}.`));
const sec = (name: SectionName, patch: any) => ({ ...defaultSection(name), ...patch });

// ================================================================== schema
for (const n of SECTION_NAMES) check(`${n}: the defaults are valid`, problems(n, defaultSection(n)).length === 0, problems(n, defaultSection(n)));
check('an empty body of a section gives its defaults (nothing missing)', SECTION_NAMES.every((n) => eq(Object.keys(validateSection(n, {}).value).sort(), Object.keys(defaultSection(n)).sort())));
check('describe() explains every section (type, fields, limits)', SECTION_NAMES.every((n) => describe({ ...({} as any), ...(require('../src/site/site.schema').SCHEMAS[n]) }).type === 'object'));
check('an unknown field is refused, with its name', has('seo', sec('seo', { colour: 'red' }), 'seo.colour'), problems('seo', sec('seo', { colour: 'red' })));
check('an unknown field deeper down is refused too', has('seo', sec('seo', { robots: { index: true, bogus: 1 } }), 'seo.robots.bogus'));
check('__proto__ is not a field', has('general', JSON.parse('{"__proto__": {"x": 1}}'), 'general.__proto__'));
check('a number where text is expected is refused', has('general', sec('general', { siteName: 5 }), 'general.siteName'));
check('text longer than its limit is refused', has('general', sec('general', { siteName: 'x'.repeat(81) }), 'general.siteName'));
check('a required text cannot be empty', has('general', sec('general', { siteName: '   ' }), 'general.siteName'));
check('text is trimmed', validateSection('general', sec('general', { tagline: '  Hello  ' })).value.tagline === 'Hello');
check('control characters are refused', has('general', sec('general', { tagline: 'a\u0007b' }), 'general.tagline'));
check('a new line in a one-line field is refused', has('general', sec('general', { tagline: 'a\nb' }), 'general.tagline'));
check('HTML in a text is refused', has('general', sec('general', { tagline: 'Hi <b>there</b>' }), 'general.tagline'));
check('a colour must be #rgb or #rrggbb and is lower-cased', has('general', sec('general', { themeColor: 'orange' }), 'general.themeColor') && validateSection('general', sec('general', { themeColor: '#FF6917' })).value.themeColor === '#ff6917');
check('an address must be http(s) or a path of the site (no javascript:, data:)', has('footer', sec('footer', { bottomLinks: [{ label: 'x', url: 'javascript:alert(1)', newTab: false }] }), 'footer.bottomLinks') && !has('footer', sec('footer', { bottomLinks: [{ label: 'Terms', url: '/order/terms', newTab: false }, { label: 'Ext', url: 'https://example.com/a?b=1', newTab: true }] }), 'footer.bottomLinks'));
check('a picture must be our own jpg/png/webp/gif upload or an https picture', has('branding', sec('branding', { logoUrl: '/uploads/a.heic' }), 'branding.logoUrl') && has('branding', sec('branding', { logoUrl: 'data:image/png;base64,AAAA' }), 'branding.logoUrl') && !has('branding', sec('branding', { logoUrl: 'https://cdn.example.com/l.png' }), 'branding.logoUrl') && !has('branding', sec('branding', { logoUrl: '/uploads/ab12.png' }), 'branding.logoUrl'));
check('an empty nullable field becomes null', validateSection('branding', sec('branding', { logoUrl: '' })).value.logoUrl === null);
check('a language tag must look like en-CA', has('general', sec('general', { defaultLanguage: 'english', supportedLanguages: ['english'] }), 'general.defaultLanguage'));
check('the default language must be among the supported ones', has('general', sec('general', { defaultLanguage: 'fr-CA', supportedLanguages: ['en-CA'] }), 'general.supportedLanguages'));
check('a time zone must exist', has('general', sec('general', { timezone: 'Mars/Olympus' }), 'general.timezone') && !has('general', sec('general', { timezone: 'America/Toronto' }), 'general.timezone'));
check('the copyright line only knows its placeholders', has('general', sec('general', { copyright: '© {year} {company}' }), 'general.copyright') && !has('general', sec('general', { copyright: '© {year} {legalName}' }), 'general.copyright'));
check('social profiles: a known network and an address', has('general', sec('general', { social: [{ network: 'myspace', url: 'https://x.com/a' }] }), 'general.social') && !has('general', sec('general', { social: [{ network: 'instagram', url: 'https://instagram.com/forky' }] }), 'general.social'));
check('a list over its limit is refused', has('general', sec('general', { social: Array.from({ length: 13 }, () => ({ network: 'x', url: 'https://x.com/a' })) }), 'general.social'));
check('a unique list refuses a repeat', has('seo', sec('seo', { metaKeywords: ['food', 'food'] }), 'seo.metaKeywords'));
check('the title template needs %s exactly once', has('seo', sec('seo', { titleTemplate: '{siteName}' }), 'seo.titleTemplate') && has('seo', sec('seo', { titleTemplate: '%s %s' }), 'seo.titleTemplate') && !has('seo', sec('seo', { titleTemplate: '%s | {siteName}' }), 'seo.titleTemplate'));
check('store templates only know the store placeholders', has('seo', sec('seo', { templates: { store: { title: '{name} {bogus}', description: 'x' }, storeType: { title: 'x', description: 'x' } } }), 'seo.templates.store.title'));
check('meta tags that change security or navigation are refused', ['refresh', 'Set-Cookie', 'content-security-policy', 'viewport', 'charset'].every((k) => has('seo', sec('seo', { extraMetaTags: [{ kind: 'http-equiv', key: k, content: '0' }] }), 'seo.extraMetaTags')) && !has('seo', sec('seo', { extraMetaTags: [{ kind: 'name', key: 'author', content: 'Forky' }] }), 'seo.extraMetaTags'));
check('a meta tag needs its content', has('seo', sec('seo', { extraMetaTags: [{ kind: 'name', key: 'author', content: '' }] }), 'seo.extraMetaTags[0].content'));
check('an alternate link needs a language or a type', has('seo', sec('seo', { extraLinkTags: [{ rel: 'alternate', href: 'https://x.ca/fr', hreflang: null, type: null, crossorigin: false }] }), 'seo.extraLinkTags[0]'));
check('page rules: a path is listed once, and robots must be robots directives', has('seo', sec('seo', { pages: [{ path: '/a', title: null, description: null, robots: null, canonicalUrl: null, ogImageUrl: null, keywords: [] }, { path: '/a', title: null, description: null, robots: null, canonicalUrl: null, ogImageUrl: null, keywords: [] }] }), 'seo.pages[1].path') && has('seo', sec('seo', { pages: [{ path: '/a', title: null, description: null, robots: 'banana', canonicalUrl: null, ogImageUrl: null, keywords: [] }] }), 'seo.pages[0].robots') && !has('seo', sec('seo', { pages: [{ path: '/a', title: null, description: null, robots: 'noindex, nofollow', canonicalUrl: null, ogImageUrl: null, keywords: [] }] }), 'seo.pages[0].robots'));
check('JSON-LD blocks need an @type and no script tag', has('seo', sec('seo', { structuredData: { ...defaultSection('seo').structuredData, extraJsonLd: [{ name: 'x' }] } }), 'seo.structuredData.extraJsonLd[0]') && has('seo', sec('seo', { structuredData: { ...defaultSection('seo').structuredData, extraJsonLd: [{ '@type': 'Thing', name: '</script><script>x' }] } }), 'seo.structuredData.extraJsonLd[0]') && !has('seo', sec('seo', { structuredData: { ...defaultSection('seo').structuredData, extraJsonLd: [{ '@context': 'https://schema.org', '@type': 'Thing', name: 'x' }] } }), 'seo.structuredData.extraJsonLd'));
check('robots.txt rules: a path starts with / and has no spaces', has('seo', sec('seo', { robotsTxt: { ...defaultSection('seo').robotsTxt, rules: [{ userAgent: '*', allow: [], disallow: ['admin'], crawlDelay: null }] } }), 'seo.robotsTxt.rules[0].disallow'));
check('geo: a weekday appears in one row only, a position needs both numbers, a region looks like CA-ON', has('geo', sec('geo', { local: { ...defaultSection('geo').local, hours: [{ days: ['Monday'], opens: '09:00', closes: '17:00' }, { days: ['Monday'], opens: '10:00', closes: '12:00' }] } }), 'geo.local.hours') && has('geo', sec('geo', { local: { ...defaultSection('geo').local, position: { lat: 43.6, lng: null } } }), 'geo.local.position') && has('geo', sec('geo', { local: { ...defaultSection('geo').local, region: 'Ontario' } }), 'geo.local.region'));
check('opening time must be HH:MM', has('geo', sec('geo', { local: { ...defaultSection('geo').local, hours: [{ days: ['Monday'], opens: '9am', closes: '17:00' }] } }), 'geo.local.hours[0].opens'));
check('aeo: speakable needs a selector, a selector is plain, a duration is ISO 8601', has('aeo', sec('aeo', { speakable: { enabled: true, cssSelectors: [], pages: [] } }), 'aeo.speakable.cssSelectors') && has('aeo', sec('aeo', { speakable: { enabled: true, cssSelectors: ['h1<script>'], pages: [] } }), 'aeo.speakable.cssSelectors[0]') && has('aeo', sec('aeo', { howTo: [{ name: 'How to order', description: null, totalTime: '15 minutes', pages: [], steps: [] }] }), 'aeo.howTo[0].totalTime') && !has('aeo', sec('aeo', { howTo: [{ name: 'How to order', description: null, totalTime: 'PT15M', pages: ['/order'], steps: [{ name: 'Pick', text: 'Pick a store', url: null }] }] }), 'aeo.howTo'));
check('aio: a crawler is listed once and policies are known', has('aio', sec('aio', { crawlers: [{ bot: 'GPTBot', policy: 'allow' }, { bot: 'gptbot', policy: 'disallow' }] }), 'aio.crawlers[1].bot') && has('aio', sec('aio', { crawlers: [{ bot: 'GPTBot', policy: 'maybe' }] }), 'aio.crawlers[0].policy'));
check('analytics ids must look like their kind', has('integrations', sec('integrations', { googleAnalyticsId: 'UA-1' }), 'integrations.googleAnalyticsId') && has('integrations', sec('integrations', { googleTagManagerId: 'G-ABCDEFG' }), 'integrations.googleTagManagerId') && has('integrations', sec('integrations', { metaPixelId: 'abc' }), 'integrations.metaPixelId') && !has('integrations', sec('integrations', { googleAnalyticsId: 'G-ABCD1234EF', googleTagManagerId: 'GTM-ABC123', metaPixelId: '1234567890' }), 'integrations'));

// ---- custom code
const code = (patch: any) => problems('scripts', sec('scripts', { enabled: true, ...patch }));
check('scripts: normal CSS and JavaScript are accepted and kept byte for byte', (() => { const css = 'a > b { color: red; }\n/* note */\n.x::after { content: "}"; }'; const js = 'for (let i = 0; i < 3; i++) { if (i < 2 && i > 0) console.log("<b>", i); }\n'; const r = validateSection('scripts', sec('scripts', { enabled: true, customCss: css, headJs: js, bodyJs: js })); return r.problems.length === 0 && r.value.customCss === css && r.value.headJs === js; })());
check('scripts: CSS cannot close its own tag or hold script features', code({ customCss: 'a{}</style><script>x</script>' }).length > 0 && code({ customCss: 'a { width: expression(alert(1)); }' }).length > 0 && code({ customCss: 'a { background: url(javascript:alert(1)); }' }).length > 0);
check('scripts: @import only from https', code({ customCss: '@import url("http://x.com/a.css");' }).length > 0 && code({ customCss: '@import url("https://fonts.example.com/a.css");' }).length === 0);
check('scripts: unbalanced braces and open comments are caught', code({ customCss: 'a { color: red;' }).length > 0 && code({ customCss: 'a { color: red; } }' }).length > 0 && code({ customCss: 'a { } /* never closed' }).length > 0 && code({ customCss: 'a::before { content: "}"; }' }).length === 0);
check('scripts: JavaScript with a syntax error is refused (compiled, never run)', code({ headJs: 'function ( {' }).some((p) => /syntax error/.test(p.message)) && code({ bodyJs: 'const a = ;' }).length > 0);
check('scripts: a <script> tag or HTML comment inside the JavaScript is refused', code({ headJs: '</script><script>alert(1)' }).length > 0 && code({ bodyJs: '<!-- x' }).length > 0);
check('scripts: the code is never run while it is checked', (() => { (globalThis as any).__site_test_ran = false; code({ headJs: 'globalThis.__site_test_ran = true;' }); return (globalThis as any).__site_test_ran === false; })());
check('scripts: size limit of 60 000 characters', code({ customCss: `a{}${' '.repeat(60_000)}` }).length > 0);
check('scripts: every problem names the field', code({ customCss: 'a {', headJs: 'let x =' }).map((p) => p.path).sort().join() === 'scripts.customCss,scripts.headJs');

// ================================================================== generators
check('pathMatches: exact and wildcard', pathMatches('/order/login', '/order/login') && pathMatches('/order/track/*', '/order/track/abc') && !pathMatches('/order/login', '/order/login/x') && pathMatches('/portal*', '/portal/menu') && pathMatches('/portal*', '/portal'));
check('normalisePath: query, hash, double and trailing slashes', (() => { const r = normalisePath('/order//r/x/?a=1#top'); return r.path === '/order/r/x' && r.query.get('a') === '1' && normalisePath('order').path === '/order' && normalisePath('/').path === '/'; })());
check('private pages are found by the default list', ['/order/checkout', '/order/track/abc', '/portal/menu'].every((p) => isPrivatePath(cfgWith(), p)) && !isPrivatePath(cfgWith(), '/order/r/fresh-basket'));
check('robots meta: index, follow and the preview limits by default', robotsMeta(cfgWith()) === 'index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1');
check('robots meta: noindex wins, nosnippet replaces the limits, noai adds its tags', robotsMeta(cfgWith(), { noindex: true }) === 'noindex, nofollow' && robotsMeta(cfgWith({ aio: { ...defaultSection('aio'), snippets: { noai: true, noSnippet: true } } })).includes('nosnippet') && robotsMeta(cfgWith({ aio: { ...defaultSection('aio'), snippets: { noai: true, noSnippet: false } } })).includes('noai, noimageai'));
check('robots meta: seo.robots.index=false makes every page noindex', robotsMeta(cfgWith({ seo: { robots: { ...defaultSection('seo').robots, index: false } } })) === 'noindex, nofollow');
check('fill: placeholders, spacing and dangling separators', fill('{name} - {storeType} delivery in {city} | {siteName}', { name: 'Fresh', storeType: 'grocery store', city: '', siteName: 'FORKY' }) === 'Fresh - grocery store delivery in | FORKY' && fill('{a} - {b}', { a: 'x' }) === 'x');
check('truncate cuts at a word and adds an ellipsis', truncate('one two three four five six', 15).endsWith('…') && truncate('short', 15) === 'short' && truncate('one two three four five six', 15).length <= 15);
check('jsonForScript never contains "<" (the tag cannot be closed from inside)', !jsonForScript({ a: '</script><script>alert(1)</script>' }).includes('<') && JSON.parse(jsonForScript({ a: '</script>' })).a === '</script>');

const store: StoreFacts = {
  slug: 'fresh-basket-supermarket',
  name: 'Fresh Basket Supermarket',
  storeType: 'GROCERY',
  storeTypeLabel: 'Grocery store',
  storeTypePlural: 'Grocery stores',
  retail: true,
  description: 'Fresh produce, dairy and pantry goods picked for you.',
  logoUrl: '/uploads/logo.png',
  coverUrl: null,
  phone: '+14165551234',
  addressLine1: '200 Rathburn Rd W',
  city: 'Mississauga',
  province: 'ON',
  postalCode: 'L5B 4C1',
  lat: 43.59,
  lng: -79.64,
  cuisines: ['Grocery', 'Supermarket'],
  priceLevel: 2,
  rating: 4.6,
  ratingCount: 120,
  minimumOrder: 20,
  updatedAt: new Date('2026-10-01T12:00:00Z'),
  hours: [
    { dayOfWeek: 0, openTime: '09:00', closeTime: '18:00', closed: false },
    { dayOfWeek: 1, openTime: '08:00', closeTime: '22:00', closed: false },
    { dayOfWeek: 2, openTime: '00:00', closeTime: '00:00', closed: false },
    { dayOfWeek: 3, openTime: '08:00', closeTime: '22:00', closed: true },
  ],
};

// ---- the head of the home page
const home = buildHead(cfgWith(), env, { path: '/order', lang: 'en-CA' });
check('home: default title, description, canonical, robots', home.title === 'FORKY - food and groceries delivered' && home.description.startsWith('Order from local') && home.canonical === 'https://app.example.ca/order' && home.robots === 'index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1' && home.source === 'home');
check('home: Open Graph, Twitter, theme colour and the canonical / manifest links', home.meta.some((m) => m.property === 'og:title') && home.meta.some((m) => m.name === 'twitter:card') && home.meta.some((m) => m.name === 'theme-color' && m.content === '#ff6917') && home.link.some((l) => l.rel === 'canonical') && home.link.some((l) => l.rel === 'manifest' && l.href === 'https://api.example.ca/api/v1/public/site/manifest.webmanifest'));
check('home: Organization and WebSite structured data', home.jsonLd.some((j: any) => j['@type'] === 'Organization' && j.name === 'FORKY') && home.jsonLd.some((j: any) => j['@type'] === 'WebSite' && j.potentialAction?.['@type'] === 'SearchAction'));
check('home: the same head as ready-made HTML, escaped, with no way out of the script tag', home.html.startsWith('<title>') && home.html.includes('<link rel="canonical"') && home.html.includes('application/ld+json') && !/<\/script><script/i.test(home.html));
const custom = cfgWith({ general: { ...defaultSection('general'), siteName: 'Fork & Spoon <"x">', tagline: 'Good food' }, seo: { ...defaultSection('seo'), defaultTitle: 'Fork & Spoon', metaDescription: 'A "quoted" description & more' }, branding: { ...defaultSection('branding'), ogImageUrl: '/uploads/og.png', faviconUrl: '/uploads/fav.png', appleTouchIconUrl: '/uploads/touch.png' } });
const ch = buildHead(custom, env, { path: '/order', lang: 'en' });
check('head: titles and descriptions are escaped in the HTML', ch.html.includes('<title>Fork &amp; Spoon</title>') && ch.html.includes('content="A &quot;quoted&quot; description &amp; more"'));
check('head: pictures are full addresses (uploads come from the API) and icons are linked', ch.meta.some((m) => m.property === 'og:image' && m.content === 'https://api.example.ca/uploads/og.png') && ch.link.some((l) => l.rel === 'icon' && l.href === 'https://api.example.ca/uploads/fav.png' && l.type === 'image/png') && ch.link.some((l) => l.rel === 'apple-touch-icon' && l.sizes === '180x180'));
check('head: extra meta and link tags are added', (() => { const h = buildHead(cfgWith({ seo: { ...defaultSection('seo'), extraMetaTags: [{ kind: 'name', key: 'author', content: 'Forky Inc' }, { kind: 'property', key: 'fb:app_id', content: '123' }], extraLinkTags: [{ rel: 'preconnect', href: 'https://fonts.gstatic.com', hreflang: null, type: null, crossorigin: true }], verification: { ...defaultSection('seo').verification, google: 'abc123' } } }), env, { path: '/order', lang: 'en' }); return h.meta.some((m) => m.name === 'author') && h.meta.some((m) => m.property === 'fb:app_id') && h.link.some((l) => l.rel === 'preconnect' && l.crossorigin === 'anonymous') && h.meta.some((m) => m.name === 'google-site-verification' && m.content === 'abc123'); })());
check('head: geo meta tags when a position is set', (() => { const h = buildHead(cfgWith({ geo: { ...defaultSection('geo'), local: { ...defaultSection('geo').local, region: 'CA-ON', placename: 'Mississauga', position: { lat: 43.59, lng: -79.64 } } } }), env, { path: '/order', lang: 'en' }); return h.meta.some((m) => m.name === 'geo.region' && m.content === 'CA-ON') && h.meta.some((m) => m.name === 'geo.position' && m.content === '43.59;-79.64') && h.meta.some((m) => m.name === 'ICBM'); })());

// ---- private pages
const priv = buildHead(cfgWith(), env, { path: '/order/checkout?x=1', lang: 'en' });
check('a private page is noindex, nofollow, has no structured data, canonical without the query', priv.robots === 'noindex, nofollow' && priv.jsonLd.length === 0 && priv.canonical === 'https://app.example.ca/order/checkout' && priv.source === 'private');
check('the admin console and the portal are never indexed', buildHead(cfgWith(), env, { path: '/', lang: 'en' }).robots === 'noindex, nofollow' && buildHead(cfgWith(), env, { path: '/portal/menu', lang: 'en' }).robots === 'noindex, nofollow');

// ---- a store page
const sh = buildHead(cfgWith(), env, { path: '/order/r/fresh-basket-supermarket', lang: 'en', store });
check('store: title and description come from the templates', sh.title === 'Fresh Basket Supermarket - grocery store delivery in Mississauga | FORKY' && sh.description.startsWith('Order from Fresh Basket Supermarket, a grocery store in Mississauga'), [sh.title, sh.description]);
check('store: canonical, source and the share picture fall back to the logo', sh.canonical === 'https://app.example.ca/order/r/fresh-basket-supermarket' && sh.source === 'store' && sh.meta.some((m) => m.property === 'og:image' && m.content === 'https://api.example.ca/uploads/logo.png'));
const ld: any = sh.jsonLd.find((j: any) => j['@type'] === 'GroceryStore');
check('store: a GroceryStore with address, geo, rating, price range and an order link', !!ld && ld.address.streetAddress === '200 Rathburn Rd W' && ld.geo.latitude === 43.59 && ld.aggregateRating.reviewCount === 120 && ld.aggregateRating.ratingValue === 4.6 && ld.priceRange === '$$' && ld.potentialAction['@type'] === 'OrderAction' && ld.servesCuisine === undefined, ld);
check('store: opening hours use weekday names, 00:00-00:00 means all day, closed days are left out', ld.openingHoursSpecification.length === 3 && ld.openingHoursSpecification[0].dayOfWeek === 'Sunday' && ld.openingHoursSpecification[1].dayOfWeek === 'Monday' && ld.openingHoursSpecification[2].closes === '23:59', ld.openingHoursSpecification);
check('store: a breadcrumb trail', sh.jsonLd.some((j: any) => j['@type'] === 'BreadcrumbList' && j.itemListElement.length === 2));
check('store: no rating is claimed without ratings', (() => { const h = buildHead(cfgWith(), env, { path: '/order/r/x', lang: 'en', store: { ...store, ratingCount: 0, rating: null } }); return !(h.jsonLd.find((j: any) => j['@type'] === 'GroceryStore') as any).aggregateRating; })());
check('store: a restaurant names its cuisines in structured data', (() => { const h = buildHead(cfgWith(), env, { path: '/order/r/x', lang: 'en', store: { ...store, storeType: 'RESTAURANT', storeTypeLabel: 'Restaurant', storeTypePlural: 'Restaurants', retail: false, cuisines: ['Pizza', 'Italian'] } }); const r: any = h.jsonLd.find((j: any) => j['@type'] === 'Restaurant'); return eq(r?.servesCuisine, ['Pizza', 'Italian']); })());
check('store: switched off by the setting', buildHead(cfgWith({ seo: { ...defaultSection('seo'), structuredData: { ...defaultSection('seo').structuredData, localBusinessForStores: false, breadcrumbs: false } } }), env, { path: '/order/r/x', lang: 'en', store }).jsonLd.length === 0);
const missing = buildHead(cfgWith(), env, { path: '/order/r/nothing', lang: 'en', storeMissing: true });
check('a store that does not exist is noindex', missing.robots === 'noindex, nofollow' && missing.source === 'not-found');
const st = buildHead(cfgWith(), env, { path: '/order?t=GROCERY&sort=rating', lang: 'en', storeType: { type: 'GROCERY', label: 'Grocery store', plural: 'Grocery stores', count: 3 } });
check('a kind-of-store page: its own title, a canonical that keeps ?t but not other filters', st.title === 'Grocery stores in Mississauga | FORKY' && st.canonical === 'https://app.example.ca/order?t=GROCERY' && st.source === 'store-type', [st.title, st.canonical]);

// ---- page rules
const ruled = cfgWith({ seo: { ...defaultSection('seo'), pages: [{ path: '/order/login', title: 'Sign in', description: 'Sign in to {siteName}', robots: null, canonicalUrl: null, ogImageUrl: null, keywords: [] }, { path: '/order/help*', title: null, description: null, robots: 'noindex', canonicalUrl: '/order/help', ogImageUrl: null, keywords: ['help'] }, { path: '/order/help/orders', title: 'Orders help', description: null, robots: null, canonicalUrl: null, ogImageUrl: null, keywords: [] }] } });
check('page rule: title and description of a page, still noindex because the page is private', (() => { const h = buildHead(ruled, env, { path: '/order/login', lang: 'en' }); return h.title === 'Sign in | FORKY' && h.description === 'Sign in to FORKY' && h.robots === 'noindex, nofollow'; })());
check('page rule: an exact rule beats a pattern, a pattern can set robots and canonical', (() => { const a = buildHead(ruled, env, { path: '/order/help/orders', lang: 'en' }); const b = buildHead(ruled, env, { path: '/order/help/payments', lang: 'en' }); return a.title === 'Orders help | FORKY' && b.robots === 'noindex' && b.canonical === 'https://app.example.ca/order/help' && b.meta.some((m) => m.name === 'keywords' && m.content === 'help'); })());

// ---- answers: FAQ, HowTo, speakable
const faqCfg = cfgWith({
  aeo: {
    ...defaultSection('aeo'),
    faq: { enabled: true, includeCmsFaqs: true, pages: ['/order'], items: [{ question: 'Where do you deliver?', answer: 'Mississauga and Brampton.', category: null, language: null }, { question: 'Quelle langue?', answer: 'Le francais.', category: null, language: 'fr-CA' }] },
    howTo: [{ name: 'How to order', description: 'Three steps', totalTime: 'PT5M', pages: ['/order'], steps: [{ name: 'Pick', text: 'Pick a store', url: null }, { name: 'Pay', text: 'Pay online', url: '/order/checkout' }] }],
    speakable: { enabled: true, cssSelectors: ['h1', '.answer'], pages: [] },
  },
});
const cms = [{ question: 'where do you deliver?', answer: 'duplicate of the first', language: 'en' }, { question: 'Can I pay by card?', answer: 'Yes, by card.', language: 'en' }];
check('FAQ: own entries and the CMS ones, no repeats, only the page language', (() => { const l = faqsFor(faqCfg, cms, 'en-CA'); return l.length === 2 && l[0].answer === 'Mississauga and Brampton.' && l[1].question === 'Can I pay by card?'; })());
check('FAQ: switched off or without CMS', faqsFor(cfgWith({ aeo: { ...defaultSection('aeo'), faq: { ...defaultSection('aeo').faq, enabled: false } } }), cms, 'en').length === 0 && faqsFor(cfgWith({ aeo: { ...defaultSection('aeo'), faq: { ...defaultSection('aeo').faq, includeCmsFaqs: false } } }), cms, 'en').length === 0);
const fh = buildHead(faqCfg, env, { path: '/order', lang: 'en-CA', cmsFaqs: cms });
check('FAQPage, HowTo and speakable structured data on the configured pages', fh.jsonLd.some((j: any) => j['@type'] === 'FAQPage' && j.mainEntity.length === 2 && j.mainEntity[0].acceptedAnswer.text === 'Mississauga and Brampton.') && fh.jsonLd.some((j: any) => j['@type'] === 'HowTo' && j.step.length === 2 && j.step[1].url === 'https://app.example.ca/order/checkout') && fh.jsonLd.some((j: any) => j.speakable?.cssSelector?.length === 2));
check('...and not on other pages', buildHead(faqCfg, env, { path: '/order/r/x', lang: 'en', store, cmsFaqs: cms }).jsonLd.every((j: any) => j['@type'] !== 'FAQPage' && j['@type'] !== 'HowTo'));

// ---- robots.txt
const robots = renderRobotsTxt(cfgWith(), env)!;
check('robots.txt: the rules, a sitemap line, no AI sections when nothing is set', robots.includes('User-agent: *') && robots.includes('Disallow: /portal') && robots.includes('Allow: /order') && robots.includes('Sitemap: https://api.example.ca/api/v1/public/site/sitemap.xml') && !robots.includes('GPTBot'));
const aiRobots = renderRobotsTxt(cfgWith({ aio: { ...defaultSection('aio'), crawlers: [{ bot: 'GPTBot', policy: 'disallow' }, { bot: 'ClaudeBot', policy: 'disallow' }, { bot: 'PerplexityBot', policy: 'allow' }, { bot: 'CCBot', policy: 'default' }] } }), env)!;
check('robots.txt: AI crawlers grouped by policy, "default" says nothing', aiRobots.includes('User-agent: GPTBot\nUser-agent: ClaudeBot\nDisallow: /') && aiRobots.includes('User-agent: PerplexityBot\nAllow: /') && !aiRobots.includes('CCBot'));
check('robots.txt: disallowAll blocks everything and drops the other rules', (() => { const r = renderRobotsTxt(cfgWith({ seo: { ...defaultSection('seo'), robotsTxt: { ...defaultSection('seo').robotsTxt, disallowAll: true } } }), env)!; return r.includes('User-agent: *\nDisallow: /\n') && !r.includes('/portal'); })());
check('robots.txt: switched off gives nothing, extra lines are kept, the sitemap address can be set', renderRobotsTxt(cfgWith({ seo: { ...defaultSection('seo'), robotsTxt: { ...defaultSection('seo').robotsTxt, enabled: false } } }), env) === null && renderRobotsTxt(cfgWith({ seo: { ...defaultSection('seo'), robotsTxt: { ...defaultSection('seo').robotsTxt, extra: 'Host: app.example.ca', sitemapUrls: ['/sitemap.xml'] } } }), env)!.includes('Sitemap: https://app.example.ca/sitemap.xml') && renderRobotsTxt(cfgWith({ seo: { ...defaultSection('seo'), robotsTxt: { ...defaultSection('seo').robotsTxt, extra: 'Host: app.example.ca' } } }), env)!.endsWith('Host: app.example.ca\n'));

// ---- sitemap
const types = [{ type: 'GROCERY', label: 'Grocery store', plural: 'Grocery stores', count: 2 }, { type: 'CAFE', label: 'Cafe', plural: 'Cafes', count: 0 }];
const map = renderSitemap(cfgWith(), env, [{ slug: 'a-b', updatedAt: new Date('2026-10-02T10:00:00Z') }, { slug: 'fish-&-chips', updatedAt: new Date('2026-10-03T10:00:00Z') }], types)!;
check('sitemap: home, kinds of store that have stores, every store, with dates', map.startsWith('<?xml') && map.includes('<loc>https://app.example.ca/order</loc>') && map.includes('<loc>https://app.example.ca/order?t=GROCERY</loc>') && !map.includes('t=CAFE') && map.includes('<loc>https://app.example.ca/order/r/a-b</loc>') && map.includes('<lastmod>2026-10-02</lastmod>'));
check('sitemap: XML special characters are escaped', map.includes('fish-&amp;-chips') && !map.includes('fish-&-chips'));
check('sitemap: private pages never appear, even as extra pages', !renderSitemap(cfgWith({ seo: { ...defaultSection('seo'), sitemap: { ...defaultSection('seo').sitemap, extraPages: [{ path: '/order/checkout', changefreq: 'daily', priority: 0.5 }, { path: '/order/about', changefreq: 'monthly', priority: 0.4 }] } } }), env, [], types)!.includes('checkout') && renderSitemap(cfgWith({ seo: { ...defaultSection('seo'), sitemap: { ...defaultSection('seo').sitemap, extraPages: [{ path: '/order/about', changefreq: 'monthly', priority: 0.4 }] } } }), env, [], types)!.includes('/order/about'));
check('sitemap: the limit is respected and a switched-off sitemap gives nothing', (renderSitemap(cfgWith({ seo: { ...defaultSection('seo'), sitemap: { ...defaultSection('seo').sitemap, maxUrls: 100 } } }), env, Array.from({ length: 300 }, (_, i) => ({ slug: `s${i}`, updatedAt: new Date() })), types)!.match(/<url>/g) ?? []).length === 100 && renderSitemap(cfgWith({ seo: { ...defaultSection('seo'), sitemap: { ...defaultSection('seo').sitemap, enabled: false } } }), env, [], types) === null);

// ---- llms.txt
const llmsCfg = cfgWith({
  general: { ...defaultSection('general'), siteName: 'FORKY' },
  geo: { ...defaultSection('geo'), generative: { ...defaultSection('geo').generative, entityDescription: 'FORKY delivers food and groceries in Mississauga and Brampton.', keyFacts: ['Delivery fees start at $2.99', 'Open 7 days a week'], terminology: [{ term: 'Pickup', definition: 'Collect your order at the store' }], sources: [{ title: 'About us', url: '/order/about' }], lastReviewed: '2026-10-01' }, local: { ...defaultSection('geo').local, serviceAreas: [{ name: 'Mississauga', type: 'City', lat: null, lng: null, radiusKm: null }, { name: 'Brampton', type: 'City', lat: null, lng: null, radiusKm: null }] } },
  aio: { ...defaultSection('aio'), license: { usage: 'attribution-required', text: 'Please cite FORKY.', contactUrl: null }, llmsTxt: { ...defaultSection('aio').llmsTxt, sections: [{ title: 'Help', links: [{ title: 'Delivery fees', url: '/order/help/fees', description: 'What delivery costs' }] }], extraMarkdown: 'Thank you.' } },
  aeo: faqCfg.aeo,
});
const llms = renderLlmsTxt(llmsCfg, env, [store], cms, false)!;
check('llms.txt: title, summary, key facts, areas, stores, FAQ questions, sources, the use of the content', llms.startsWith('# FORKY\n\n> FORKY delivers food and groceries in Mississauga and Brampton.') && llms.includes('## Key facts') && llms.includes('- Delivery fees start at $2.99') && llms.includes('## Where it operates') && llms.includes('- Mississauga (City)') && llms.includes('[Fresh Basket Supermarket](https://app.example.ca/order/r/fresh-basket-supermarket): Grocery store, Mississauga') && llms.includes('- Where do you deliver?') && llms.includes('[About us](https://app.example.ca/order/about)') && llms.includes('with attribution') && llms.includes('Please cite FORKY.') && llms.includes('Facts last reviewed: 2026-10-01.') && llms.trim().endsWith('Thank you.'), llms);
check('llms.txt: own link sections use full addresses', llms.includes('- [Delivery fees](https://app.example.ca/order/help/fees): What delivery costs'));
const full = renderLlmsTxt(llmsCfg, env, [store], cms, true)!;
check('llms-full.txt: the answers, the terms and the store descriptions too', full.includes('### Where do you deliver?') && full.includes('Mississauga and Brampton.') && full.includes('## Terms') && full.includes('**Pickup**') && full.includes('Fresh produce, dairy and pantry goods picked for you.') && !llms.includes('## Terms'));
check('llms.txt: switched off gives nothing; "not-allowed" says so', renderLlmsTxt(cfgWith({ aio: { ...defaultSection('aio'), llmsTxt: { ...defaultSection('aio').llmsTxt, enabled: false } } }), env, [], [], false) === null && renderLlmsTxt(cfgWith({ aio: { ...defaultSection('aio'), license: { usage: 'not-allowed', text: '', contactUrl: null } } }), env, [], [], false)!.includes('may not be used'));

// ---- manifest
const mf: any = renderManifest(cfgWith({ branding: { ...defaultSection('branding'), pwaIcon192Url: '/uploads/i192.png', pwaIcon512Url: '/uploads/i512.png' } }), env);
check('manifest: name, start page, colours and the app icons', mf.name === 'FORKY' && mf.start_url === 'https://app.example.ca/order' && mf.display === 'standalone' && mf.theme_color === '#ff6917' && mf.icons.length === 3 && mf.icons[0].src === 'https://api.example.ca/uploads/i192.png' && mf.icons.some((i: any) => i.purpose === 'maskable'));
check('manifest: no icons when none are uploaded', (renderManifest(cfgWith(), env) as any).icons === undefined);

// ---- picture sizes (read from the file header)
const png = Buffer.alloc(33);
Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
png.writeUInt32BE(13, 8);
png.write('IHDR', 12, 'latin1');
png.writeUInt32BE(512, 16);
png.writeUInt32BE(256, 20);
check('picture size: PNG', eq(imageSize(png), { width: 512, height: 256, type: 'png' }));
const gif = Buffer.alloc(30);
gif.write('GIF89a', 0, 'latin1');
gif.writeUInt16LE(40, 6);
gif.writeUInt16LE(30, 8);
check('picture size: GIF', eq(imageSize(gif), { width: 40, height: 30, type: 'gif' }));
const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
check('picture size: JPEG (800 x 600)', eq(imageSize(jpg), { width: 800, height: 600, type: 'jpg' }), imageSize(jpg));
const webp = Buffer.alloc(30);
webp.write('RIFF', 0, 'latin1');
webp.write('WEBP', 8, 'latin1');
webp.write('VP8X', 12, 'latin1');
webp.writeUIntLE(1199, 24, 3);
webp.writeUIntLE(629, 27, 3);
check('picture size: WebP (extended, 1200 x 630)', eq(imageSize(webp), { width: 1200, height: 630, type: 'webp' }), imageSize(webp));
check('picture size: anything else is not a picture', imageSize(Buffer.from('this is not a picture at all, just text')) === null && imageSize(Buffer.alloc(10)) === null);

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall site settings checks passed');
process.exit(failed ? 1 : 0);
