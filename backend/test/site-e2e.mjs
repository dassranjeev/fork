#!/usr/bin/env node
/**
 * Website General settings end-to-end test: REAL HTTP against a running API (+ SQL for the audit trail and clean-up). docs/site-settings.md
 *
 *   API=http://localhost:4500/api/v1 ADMIN_PASSWORD=<super admin> DEMO_PASSWORD=<demo accounts> PGPASSWORD=<postgres> PGDATABASE=<db> node backend/test/site-e2e.mjs
 *
 * The API must run with WEB_URL=https://app.example.ca and PUBLIC_URL=http://localhost:<its port> (the test checks the addresses it builds), on a seeded database with the demo stores.
 * Everything the run changes is put back (sections reset, role permission removed, uploaded pictures deleted).
 */
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { request as httpRequest } from 'node:http';
const require = createRequire(import.meta.url);
const { Client } = require('pg');

const API = (process.env.API || 'http://localhost:4500/api/v1').replace(/\/$/, '');
const ORIGIN = API.replace(/\/api\/v1$/, '');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const DEMO_PASSWORD = process.env.DEMO_PASSWORD;
if (!ADMIN_PASSWORD || !DEMO_PASSWORD || !process.env.PGPASSWORD) {
  console.error('Set ADMIN_PASSWORD, DEMO_PASSWORD and PGPASSWORD (and PGDATABASE).');
  process.exit(2);
}
const pg = new Client({ host: process.env.PGHOST || 'localhost', port: +(process.env.PGPORT || 5432), user: process.env.PGUSER || 'postgres', password: process.env.PGPASSWORD, database: process.env.PGDATABASE || 'forky_reg' });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`.slice(0, 600)}`);
};
const section = (s) => console.log(`\n--- ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ip = 70;
async function raw(method, path, token, body, headers = {}) {
  for (let i = 0; i < 4; i++) {
    const isForm = body instanceof FormData;
    const r = await fetch(`${API}${path}`, { method, headers: { 'x-forwarded-for': `10.77.5.${(ip = (ip % 250) + 1)}`, ...(isForm || body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : isForm ? body : typeof body === 'string' ? body : JSON.stringify(body) });
    if (r.status === 429) { await sleep(8000); continue; }
    return r;
  }
}
async function api(method, path, token, body, headers) {
  const r = await raw(method, path, token, body, headers);
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch { /* not JSON */ }
  return { s: r.status, j, text, h: r.headers };
}
async function login(identifier, password, app) {
  const r = await api('POST', '/auth/login', null, { identifier, password, ...(app ? { app } : {}) });
  const d = r.j?.data || r.j;
  if (!d?.accessToken) throw new Error(`login failed for ${identifier}: ${r.s} ${r.text.slice(0, 200)}`);
  return d.accessToken;
}

// a solid PNG of any size (small after compression)
const crcT = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
const png = (w, h, rgb = [255, 105, 23]) => {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgb).flat())]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
};
const gif = (w, h) => { const b = Buffer.alloc(40); b.write('GIF89a', 0, 'latin1'); b.writeUInt16LE(w, 6); b.writeUInt16LE(h, 8); return b; };
const upload = (token, slot, bytes, name = 'pic.png', type = 'image/png') => {
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type }), name);
  return api('POST', `/admin/site/branding/${slot}`, token, fd);
};
const sha = (alg, text) => `${alg}-${createHash(alg).update(text, 'utf8').digest('base64')}`;
const SECTIONS = ['general', 'branding', 'seo', 'geo', 'aeo', 'aio', 'footer', 'integrations', 'scripts'];

async function main() {
  await pg.connect();
  const uploadedUrls = [];
  const admin = await login('admin@forky.ca', ADMIN_PASSWORD);
  const marketing = await login('marketing@forky.ca', DEMO_PASSWORD);
  const support = await login('support@forky.ca', DEMO_PASSWORD);
  const customer = await login('customer1@demo.forky.ca', DEMO_PASSWORD, 'customer');
  const marketingRole = ((await api('GET', '/admin/roles', admin)).j?.data || (await api('GET', '/admin/roles', admin)).j || []).find?.((r) => r.name === 'Marketing Manager');
  const originalPermissions = marketingRole?.permissions;
  try {
    // baseline: every section at its defaults
    for (const s of SECTIONS) await api('POST', `/admin/site/${s}/reset`, admin);

    // ============================================================ A. who may do what
    section('A. access control');
    let r = await api('GET', '/admin/site', null);
    check('no sign-in: 401', r.s === 401, r.s);
    r = await api('GET', '/admin/site', customer);
    check('a customer: 403', r.s === 403, r.s);
    r = await api('GET', '/admin/site', support);
    check('staff without the site permission: 403', r.s === 403, r.s);
    r = await api('GET', '/admin/site', marketing);
    check('the Marketing Manager role of this database has no site permission yet: 403', r.s === 403, r.s);
    check('the Super Admin may read', (r = await api('GET', '/admin/site', admin)).s === 200 && SECTIONS.every((s) => r.j.sections[s]), r.s);
    const grant = await api('PATCH', `/admin/roles/${marketingRole.id}`, admin, { permissions: { ...originalPermissions, site: ['view', 'edit'] } });
    check('the site permission can be given to a role through the roles API', grant.s < 300, grant);
    r = await api('GET', '/admin/site', marketing);
    check('...and then the Marketing Manager can read', r.s === 200, r.s);
    r = await api('PATCH', '/admin/site/general', marketing, { tagline: 'Set by marketing' });
    check('...and change a section', r.s === 200 && r.j.value.tagline === 'Set by marketing', r);
    r = await api('PATCH', '/admin/site/scripts', marketing, { enabled: true, customCss: 'a{}' });
    check('custom CSS / JavaScript: only a Super Admin (403 SITE_CODE_SUPER_ADMIN_ONLY)', r.s === 403 && r.j?.code === 'SITE_CODE_SUPER_ADMIN_ONLY', r);
    r = await api('PUT', '/admin/site/scripts', marketing, { enabled: true });
    check('...also with PUT', r.s === 403, r.s);
    r = await api('POST', '/admin/site/scripts/reset', marketing);
    check('...and reset', r.s === 403, r.s);

    // ============================================================ B. what a form needs
    section('B. defaults, schema, options');
    r = await api('GET', '/admin/site', admin);
    check('every section is there with a version and "isDefault"', SECTIONS.every((s) => typeof r.j.sections[s].version === 'number' && 'isDefault' in r.j.sections[s]) && typeof r.j.version === 'string', Object.keys(r.j.sections));
    r = await api('GET', '/admin/site/schema', admin);
    check('the schema describes every field of every section (type, limits, defaults)', SECTIONS.every((s) => r.j[s]?.type === 'object') && r.j.seo.fields.titleTemplate.max === 100 && r.j.seo.fields.titleTemplate.type === 'string' && Array.isArray(r.j.general.fields.social.of.fields.network.values) && r.j.scripts.fields.customCss.max === 60000, Object.keys(r.j || {}));
    r = await api('GET', '/admin/site/options', admin);
    check('the options hold the lists for dropdowns (social networks, AI crawlers, picture slots)', r.j.socialNetworks.includes('instagram') && r.j.aiCrawlers.some((c) => c.bot === 'GPTBot') && r.j.brandingSlots.some((s) => s.slot === 'favicon' && s.minWidth === 32 && s.square === true) && r.j.superAdminOnly.includes('scripts'), r.j);
    r = await api('GET', '/admin/site/bogus', admin);
    check('an unknown section: 404 that lists the sections', r.s === 404 && /general/.test(JSON.stringify(r.j)), r);
    r = await api('GET', '/admin/site/general', admin);
    check('one section by name', r.s === 200 && r.j.value.siteName === 'FORKY' && r.j.value.timezone === 'America/Toronto', r.j?.value?.siteName);

    // ============================================================ C. writing
    section('C. saving and validating');
    r = await api('PATCH', '/admin/site/general', admin, { siteName: 'Test Eats', tagline: 'Fresh food, fast' });
    const v1 = r.j.version;
    check('PATCH changes only what is sent and bumps the version', r.s === 200 && r.j.value.siteName === 'Test Eats' && r.j.value.timezone === 'America/Toronto' && r.j.changed === true && v1 >= 1, r.j);
    r = await api('PATCH', '/admin/site/general', admin, { siteName: 'Test Eats', tagline: 'Fresh food, fast' });
    check('saving the same values again changes nothing (same version, changed=false)', r.s === 200 && r.j.changed === false && r.j.version === v1, r.j);
    r = await api('PATCH', '/admin/site/general', admin, { siteName: 5, colour: 'red', themeColor: 'orange', social: [{ network: 'myspace', url: 'https://x.com/a' }] });
    check('wrong values: 400 SITE_SETTINGS_INVALID with every problem and its path', r.s === 400 && r.j.code === 'SITE_SETTINGS_INVALID' && ['general.siteName', 'general.colour', 'general.themeColor', 'general.social[0].network'].every((p) => r.j.details.some((d) => d.path === p)), r.j);
    check('...and nothing was saved', (await api('GET', '/admin/site/general', admin)).j.version === v1);
    r = await api('PATCH', '/admin/site/general', admin, { tagline: 'Fresh <b>food</b><script>alert(1)</script> daily' });
    check('markup in a text is stripped on the way in', r.s === 200 && r.j.value.tagline === 'Fresh food daily', r.j?.value?.tagline);
    r = await api('PUT', '/admin/site/seo', admin, { titleTemplate: '%s - {siteName}', defaultTitle: 'Test Eats home' });
    check('PUT replaces the section: what is left out goes back to its default', r.s === 200 && r.j.value.titleTemplate === '%s - {siteName}' && r.j.value.metaDescription.startsWith('Order from local') && r.j.value.robots.index === true && r.j.value.privatePaths.includes('/order/checkout'), r.j);
    r = await api('PATCH', '/admin/site/seo', admin, { titleTemplate: 'no placeholder' });
    check('a rule that needs two fields: the title template must hold %s', r.s === 400 && r.j.details.some((d) => d.path === 'seo.titleTemplate'), r.j);
    r = await api('PATCH', '/admin/site/seo', admin, { extraMetaTags: [{ kind: 'http-equiv', key: 'refresh', content: '0;url=https://evil.example' }] });
    check('a meta tag that redirects is refused', r.s === 400 && r.j.details.some((d) => d.path === 'seo.extraMetaTags[0].key'), r.j);
    r = await api('PATCH', '/admin/site/footer', admin, { bottomLinks: [{ label: 'Hack', url: 'javascript:alert(1)', newTab: false }] });
    check('a footer link with javascript: is refused', r.s === 400, r);
    r = await api('PATCH', '/admin/site/footer', admin, { columns: [{ title: 'Company', links: [{ label: 'About', url: '/order/about', newTab: false }, { label: 'Careers', url: 'https://example.com/jobs', newTab: true }] }], bottomLinks: [{ label: 'Terms', url: '/order/terms', newTab: false }, { label: 'Privacy', url: '/order/privacy', newTab: false }], legalText: 'All prices in CAD.' });
    check('the footer is saved (columns, links, legal text)', r.s === 200 && r.j.value.columns[0].links.length === 2 && r.j.value.bottomLinks[1].label === 'Privacy', r);
    r = await api('PATCH', '/admin/site/integrations', admin, { googleAnalyticsId: 'G-TEST1234AB', googleTagManagerId: 'not-an-id' });
    check('an analytics id must look right', r.s === 400 && r.j.details.some((d) => d.path === 'integrations.googleTagManagerId'), r.j);
    r = await api('PATCH', '/admin/site/integrations', admin, { googleAnalyticsId: 'G-TEST1234AB' });
    check('...and a good one is saved', r.s === 200 && r.j.value.googleAnalyticsId === 'G-TEST1234AB', r);
    r = await api('PATCH', '/admin/site/general', admin, { contact: { email: 'hello@example.ca', supportEmail: null, phone: '+1 905 555 0100', address: { line1: '1 Square One Dr', line2: '', city: 'Mississauga', region: 'ON', postalCode: 'L5B 0A1', country: 'CA' } }, social: [{ network: 'instagram', url: 'https://instagram.com/testeats' }, { network: 'x', url: 'https://x.com/testeats' }], siteUrl: 'https://eats.example.ca' });
    check('contact details, social profiles and the site address are saved', r.s === 200 && r.j.value.contact.address.city === 'Mississauga' && r.j.value.social.length === 2 && r.j.value.siteUrl === 'https://eats.example.ca', r);
    await api('PATCH', '/admin/site/general', admin, { siteUrl: null });

    // ============================================================ D. logo and icons
    section('D. logo and icons');
    r = await upload(admin, 'logo', png(240, 80));
    check('a logo is uploaded, checked and put in the branding section', r.s === 201 && /\/uploads\/[0-9a-f-]+\.png$/.test(r.j.url) && r.j.width === 240 && r.j.height === 80 && r.j.branding.logoUrl === r.j.url && r.j.field === 'logoUrl', r);
    if (r.j?.url) uploadedUrls.push(r.j.url);
    const logoUrl = r.j?.url;
    const served = await fetch(`${ORIGIN}${new URL(logoUrl).pathname}`);
    check('the uploaded logo is served as a picture', served.status === 200 && /image\/png/.test(served.headers.get('content-type') || ''), served.status);
    r = await upload(admin, 'favicon', png(64, 32));
    check('a favicon that is not square is refused (400 SITE_IMAGE_REJECTED) with the size', r.s === 400 && r.j.code === 'SITE_IMAGE_REJECTED' && /square/.test(r.j.message) && /64 x 32/.test(r.j.message), r.j);
    r = await upload(admin, 'favicon', png(16, 16));
    check('...or too small', r.s === 400 && /at least 32/.test(r.j.message), r.j);
    r = await upload(admin, 'favicon', gif(64, 64), 'icon.gif', 'image/gif');
    check('...or the wrong format (GIF)', r.s === 400 && /PNG or WEBP/.test(r.j.message), r.j);
    r = await upload(admin, 'favicon', png(48, 48));
    check('a square favicon of 48 px is accepted', r.s === 201 && r.j.branding.faviconUrl === r.j.url, r);
    if (r.j?.url) uploadedUrls.push(r.j.url);
    r = await upload(admin, 'apple-touch-icon', png(100, 100));
    check('an iPhone icon under 180 px is refused', r.s === 400, r.j);
    r = await upload(admin, 'apple-touch-icon', png(180, 180));
    check('...180 px is accepted', r.s === 201, r);
    if (r.j?.url) uploadedUrls.push(r.j.url);
    r = await upload(admin, 'og-image', png(800, 800));
    check('a share picture must be wide', r.s === 400 && /wide/.test(r.j.message), r.j);
    r = await upload(admin, 'og-image', png(1200, 630));
    check('1200 x 630 is accepted as the share picture', r.s === 201, r);
    if (r.j?.url) uploadedUrls.push(r.j.url);
    for (const [slot, size] of [['pwa-icon-192', 192], ['pwa-icon-512', 512]]) {
      r = await upload(admin, slot, png(size, size));
      check(`${slot} (${size} px) is accepted`, r.s === 201, r);
      if (r.j?.url) uploadedUrls.push(r.j.url);
    }
    r = await upload(admin, 'logo', Buffer.from('this is a text file, not a picture'), 'notes.txt', 'text/plain');
    check('a file that is not a picture is refused', r.s === 400 || r.s === 415, r);
    r = await upload(admin, 'banner', png(100, 100));
    check('an unknown slot: 404', r.s === 404, r.s);
    r = await upload(support, 'logo', png(240, 80));
    check('staff without the permission cannot upload: 403', r.s === 403, r.s);
    r = await upload(marketing, 'logo-square', png(200, 200));
    check('the Marketing Manager (site:edit) can', r.s === 201, r);
    if (r.j?.url) uploadedUrls.push(r.j.url);
    r = await api('DELETE', '/admin/site/branding/logo-square', admin);
    check('a picture can be removed', r.s === 200 && r.j.url === null && r.j.branding.logoSquareUrl === null, r);
    r = await api('GET', '/admin/site/branding/revisions', admin);
    check('every upload is a revision with a note', r.s === 200 && r.j.some((x) => /Logo uploaded/.test(x.note || '')) && r.j.some((x) => /Favicon uploaded/.test(x.note || '')), r.j);

    // ============================================================ E. what the website reads
    section('E. public config and the page head');
    r = await api('GET', '/public/site', null);
    const cfg = r.j;
    check('the public config needs no sign-in and is cacheable', r.s === 200 && /max-age=60/.test(r.h.get('cache-control') || '') && !!r.h.get('etag'), [r.s, r.h.get('cache-control')]);
    check('it holds the site name, language, theme colour and the copyright with its placeholders filled', cfg.site.name === 'Test Eats' && cfg.site.language === 'en-CA' && cfg.site.themeColor === '#ff6917' && /^© \d{4} Test Eats\. All rights reserved\.$/.test(cfg.site.copyright), cfg.site);
    check('the site address falls back to WEB_URL', cfg.site.url === 'https://app.example.ca', cfg.site.url);
    check('pictures are full addresses', cfg.branding.logo === logoUrl && cfg.branding.favicon?.startsWith('http') && cfg.branding.ogImage?.startsWith('http') && cfg.branding.logoAlt === 'Test Eats', cfg.branding);
    check('contact, social profiles and the footer are there', cfg.contact.email === 'hello@example.ca' && cfg.social.length === 2 && cfg.footer.columns[0].links.length === 2 && cfg.footer.copyright === cfg.site.copyright, cfg.footer);
    check('analytics ids and links to the generated files are there', cfg.integrations.googleAnalyticsId === 'G-TEST1234AB' && cfg.files.robots.endsWith('/api/v1/public/site/robots.txt') && cfg.files.head.endsWith('/public/site/head'), cfg.files);
    check('"version" is a short fingerprint', /^[0-9a-f]{12}$/.test(cfg.version), cfg.version);
    // (Node's fetch does not hand a 304 back for a hand-made If-None-Match, so this check uses the plain http client)
    const e304 = await new Promise((resolve, reject) => { const u = new URL(`${API}/public/site`); const q = httpRequest({ host: u.hostname, port: u.port, path: u.pathname, headers: { 'if-none-match': r.h.get('etag') } }, (res) => { res.resume(); resolve(res.statusCode); }); q.on('error', reject); q.end(); });
    check('a repeated request with the ETag is answered 304', e304 === 304, e304);
    r = await api('GET', '/public/site?sections=site,branding', null);
    check('?sections= returns only those parts', Object.keys(r.j).filter((k) => !['version', 'files'].includes(k)).sort().join() === 'branding,site', Object.keys(r.j));
    const before = cfg.version;
    await api('PATCH', '/admin/site/general', admin, { tagline: 'Changed for the version test' });
    check('saving anything changes the version', (await api('GET', '/public/site', null)).j.version !== before);

    r = await api('GET', '/public/site/head?path=/order&lang=en-CA', null);
    check('head of the home page: title, description, canonical, robots, Open Graph, structured data', r.s === 200 && r.j.title === 'Test Eats home' && r.j.canonical === 'https://app.example.ca/order' && /^index, follow/.test(r.j.robots) && r.j.meta.some((m) => m.property === 'og:image') && r.j.jsonLd.some((j) => j['@type'] === 'Organization' && j.name === 'Test Eats' && j.sameAs.length === 2 && j.email === 'hello@example.ca') && r.j.jsonLd.some((j) => j['@type'] === 'WebSite'), r.j);
    check('...with the icons and the manifest linked', r.j.link.some((l) => l.rel === 'icon') && r.j.link.some((l) => l.rel === 'apple-touch-icon') && r.j.link.some((l) => l.rel === 'manifest'), r.j.link);
    check('...and the same as ready-made HTML', typeof r.j.html === 'string' && r.j.html.startsWith('<title>Test Eats home</title>') && r.j.html.includes('application/ld+json') && !/<\/script><script/i.test(r.j.html));
    r = await api('GET', '/public/site/head?path=/order/r/fresh-basket-supermarket', null);
    const store = r.j.jsonLd?.find?.((j) => j['@type'] === 'GroceryStore');
    check('head of a store page: the store title, canonical and a GroceryStore with address, hours and an order link', r.s === 200 && r.j.source === 'store' && /^Fresh Basket Supermarket - grocery store delivery in Mississauga/.test(r.j.title) && r.j.canonical === 'https://app.example.ca/order/r/fresh-basket-supermarket' && store?.address?.addressLocality === 'Mississauga' && store.openingHoursSpecification?.length > 3 && store.potentialAction['@type'] === 'OrderAction', r.j);
    r = await api('GET', '/public/site/head?path=/order/r/no-such-store', null);
    check('head of a store that does not exist: noindex', r.s === 200 && r.j.source === 'not-found' && r.j.robots === 'noindex, nofollow', r.j);
    r = await api('GET', '/public/site/head?path=' + encodeURIComponent('/order?t=GROCERY&sort=x'), null);
    check('head of a kind-of-store page', r.j.source === 'store-type' && /^Grocery stores in /.test(r.j.title) && r.j.canonical === 'https://app.example.ca/order?t=GROCERY', r.j);
    r = await api('GET', '/public/site/head?path=/order/checkout', null);
    check('head of a private page: noindex, no structured data', r.j.robots === 'noindex, nofollow' && r.j.jsonLd.length === 0 && r.j.source === 'private', r.j);
    check('head: a path is required and must start with /', (await api('GET', '/public/site/head', null)).s === 400 && (await api('GET', '/public/site/head?path=order', null)).s === 400 && (await api('GET', '/public/site/head?path=/order&lang=<x>', null)).s === 400);

    // ============================================================ F. SEO / GEO / AEO / AIO
    section('F. SEO, GEO, AEO, AIO');
    await api('PATCH', '/admin/site/seo', admin, { pages: [{ path: '/order/about', title: 'About {siteName}', description: 'Who we are', robots: null, canonicalUrl: null, ogImageUrl: null, keywords: ['about'] }], extraMetaTags: [{ kind: 'name', key: 'author', content: 'Test Eats Inc' }], verification: { google: 'abc123', bing: null, yandex: null, baidu: null, pinterest: null, facebookDomain: null } });
    r = await api('GET', '/public/site/head?path=/order/about', null);
    check('SEO: a page rule sets title and description, extra meta tags and the verification code are added', r.j.title === 'About Test Eats - Test Eats' || r.j.title === 'About Test Eats - Test Eats' || /^About Test Eats/.test(r.j.title), r.j.title);
    check('...', r.j.description === 'Who we are' && r.j.meta.some((m) => m.name === 'author' && m.content === 'Test Eats Inc') && r.j.meta.some((m) => m.name === 'google-site-verification' && m.content === 'abc123') && r.j.meta.some((m) => m.name === 'keywords' && m.content === 'about'), r.j.meta);
    await api('PATCH', '/admin/site/geo', admin, { local: { enabled: true, businessType: 'FoodEstablishment', region: 'CA-ON', placename: 'Mississauga', position: { lat: 43.5925, lng: -79.6428 }, priceRange: '$$', serviceAreas: [{ name: 'Mississauga', type: 'City', lat: 43.589, lng: -79.644, radiusKm: 15 }, { name: 'Brampton', type: 'City', lat: null, lng: null, radiusKm: null }], hours: [{ days: ['Monday', 'Tuesday'], opens: '09:00', closes: '21:00' }] }, generative: { enabled: true, entityName: 'Test Eats', entityDescription: 'Test Eats delivers food and groceries in Mississauga and Brampton.', keyFacts: ['Delivery from $2.99', 'Open every day', 'Pay online'], differentiators: ['Groceries and restaurants in one order'], terminology: [{ term: 'Pickup', definition: 'Collect at the store' }], sources: [{ title: 'About', url: '/order/about' }], lastReviewed: '2026-10-01' } });
    r = await api('GET', '/public/site/head?path=/order', null);
    const orgLd = r.j.jsonLd.find((j) => j['@type'] === 'FoodEstablishment' || j['@type'] === 'Organization');
    check('GEO: geo meta tags and the area served in the Organization data', r.j.meta.some((m) => m.name === 'geo.region' && m.content === 'CA-ON') && r.j.meta.some((m) => m.name === 'geo.position' && m.content === '43.5925;-79.6428') && orgLd?.['@type'] === 'FoodEstablishment' && orgLd.areaServed?.length === 2 && orgLd.geo?.latitude === 43.5925 && orgLd.openingHoursSpecification?.[0]?.dayOfWeek?.length === 2 && /delivers food and groceries/.test(orgLd.description), orgLd);
    r = await api('PATCH', '/admin/site/geo', admin, { local: { enabled: true, businessType: 'Organization', region: 'Ontario', placename: null, position: { lat: 43, lng: null }, priceRange: null, serviceAreas: [], hours: [] } });
    check('GEO: a bad region and a half position are refused', r.s === 400 && r.j.details.some((d) => d.path === 'geo.local.region') && r.j.details.some((d) => d.path === 'geo.local.position'), r.j);
    await api('PATCH', '/admin/site/aeo', admin, { faq: { enabled: true, includeCmsFaqs: false, pages: ['/order'], items: [{ question: 'Where do you deliver?', answer: 'Mississauga and Brampton.', category: null, language: null }, { question: 'How much is delivery?', answer: 'From $2.99.', category: 'Fees', language: null }] }, howTo: [{ name: 'How to order', description: null, totalTime: 'PT5M', pages: ['/order'], steps: [{ name: 'Choose a store', text: 'Pick a restaurant or grocery store.', url: null }, { name: 'Pay', text: 'Pay by card.', url: '/order/checkout' }] }], speakable: { enabled: true, cssSelectors: ['h1'], pages: [] } });
    r = await api('GET', '/public/site/head?path=/order', null);
    check('AEO: FAQPage, HowTo and speakable structured data on the home page', r.j.jsonLd.some((j) => j['@type'] === 'FAQPage' && j.mainEntity.length === 2) && r.j.jsonLd.some((j) => j['@type'] === 'HowTo' && j.step.length === 2 && j.totalTime === 'PT5M') && r.j.jsonLd.some((j) => j.speakable?.cssSelector?.[0] === 'h1'), r.j.jsonLd.map((j) => j['@type']));
    r = await api('GET', '/public/site/faq', null);
    check('AEO: the FAQ is also a plain list', r.s === 200 && r.j.enabled === true && r.j.items.length === 2, r.j);
    r = await api('GET', '/public/site/head?path=/order/r/fresh-basket-supermarket', null);
    check('...and does not show on other pages', r.j.jsonLd.every((j) => j['@type'] !== 'FAQPage'));
    await api('PATCH', '/admin/site/aio', admin, { crawlers: [{ bot: 'GPTBot', policy: 'disallow' }, { bot: 'ClaudeBot', policy: 'disallow' }, { bot: 'PerplexityBot', policy: 'allow' }], snippets: { noai: true, noSnippet: false } });
    r = await api('GET', '/public/site/head?path=/order', null);
    check('AIO: noai, noimageai in the robots meta tag', /noai, noimageai/.test(r.j.robots), r.j.robots);
    r = await api('GET', '/public/site/robots.txt', null);
    check('robots.txt: plain text with the rules, the AI crawler policies and the sitemap', r.s === 200 && /text\/plain/.test(r.h.get('content-type')) && r.text.includes('Disallow: /portal') && r.text.includes('User-agent: GPTBot\nUser-agent: ClaudeBot\nDisallow: /') && r.text.includes('User-agent: PerplexityBot\nAllow: /') && /Sitemap: http:\/\/localhost:\d+\/api\/v1\/public\/site\/sitemap\.xml/.test(r.text), r.text);
    r = await api('GET', '/public/site/sitemap.xml', null);
    check('sitemap.xml: XML with the home page, the kinds of store and the live stores, never a private page', r.s === 200 && /xml/.test(r.h.get('content-type')) && r.text.includes('<loc>https://app.example.ca/order</loc>') && r.text.includes('<loc>https://app.example.ca/order/r/fresh-basket-supermarket</loc>') && r.text.includes('?t=GROCERY') && !r.text.includes('checkout') && /<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/.test(r.text), r.text.slice(0, 500));
    r = await api('GET', '/public/site/llms.txt', null);
    check('llms.txt: Markdown with the company summary, key facts, areas, stores and the FAQ', r.s === 200 && /markdown/.test(r.h.get('content-type')) && r.text.startsWith('# Test Eats') && r.text.includes('> Test Eats delivers food and groceries') && r.text.includes('- Delivery from $2.99') && r.text.includes('- Brampton (City)') && r.text.includes('[Fresh Basket Supermarket](https://app.example.ca/order/r/fresh-basket-supermarket)') && r.text.includes('- Where do you deliver?'), r.text.slice(0, 700));
    r = await api('GET', '/public/site/llms-full.txt', null);
    check('llms-full.txt: with the answers and the terms', r.s === 200 && r.text.includes('### Where do you deliver?') && r.text.includes('Mississauga and Brampton.') && r.text.includes('**Pickup**'), r.text.slice(0, 300));
    r = await api('GET', '/public/site/manifest.webmanifest', null);
    check('manifest: name, start page, colours and the two app icons (+ maskable)', r.s === 200 && /manifest\+json/.test(r.h.get('content-type')) && r.j.name === 'Test Eats' && r.j.start_url === 'https://app.example.ca/order' && r.j.icons.length === 3 && r.j.icons[0].sizes === '192x192', r.j);
    // switched off: 404
    await api('PATCH', '/admin/site/seo', admin, { robotsTxt: { enabled: false, disallowAll: false, rules: [], sitemapUrls: [], extra: '' }, sitemap: { ...(await api('GET', '/admin/site/seo', admin)).j.value.sitemap, enabled: false } });
    check('robots.txt and sitemap.xml answer 404 when switched off', (await api('GET', '/public/site/robots.txt', null)).s === 404 && (await api('GET', '/public/site/sitemap.xml', null)).s === 404);
    await api('POST', '/admin/site/seo/reset', admin);
    await api('PATCH', '/admin/site/aio', admin, { llmsTxt: { ...(await api('GET', '/admin/site/aio', admin)).j.value.llmsTxt, enabled: false } });
    check('llms.txt answers 404 when switched off', (await api('GET', '/public/site/llms.txt', null)).s === 404);
    r = await api('PATCH', '/admin/site/seo', admin, { robots: { index: false, follow: true, maxSnippet: -1, maxImagePreview: 'large', maxVideoPreview: -1, noarchive: false, notranslate: false } });
    check('seo.robots.index=false puts noindex on every public page', (await api('GET', '/public/site/head?path=/order', null)).j.robots === 'noindex, nofollow');
    r = await api('GET', '/admin/site/checks', admin);
    check('the checks report: errors first, with the section and field', r.s === 200 && r.j.summary.errors >= 1 && r.j.checks[0].level === 'error' && r.j.checks.some((c) => c.id === 'noindex-all' && c.section === 'seo' && c.field === 'robots.index') && r.j.checks.every((c) => c.id && c.message && c.area), r.j.summary);
    await api('POST', '/admin/site/seo/reset', admin);

    // ============================================================ G. custom CSS and JavaScript
    section('G. custom CSS and JavaScript (Super Admin)');
    const css = `/* big */\n${'.row > .col-md-4 { margin: 0 }\n'.repeat(1700)}a > b::after { content: "}"; }`.slice(0, 59_000) + '\nbody { color: #123; }';
    const headJs = 'window.__siteTest = (1 < 2 && 3 > 2) ? "</div>" : "x";\n' + '// padding\n'.repeat(4500);
    const bodyJs = 'for (let i = 0; i < 3; i++) { document.title += "<" + i + ">"; }\n' + '// padding\n'.repeat(4500);
    r = await api('PUT', '/admin/site/scripts', admin, { enabled: true, customCss: css, headJs, bodyJs, notes: 'e2e' });
    check('~150 KB of CSS and JavaScript is accepted (this route takes bigger bodies)', r.s === 200 && r.j.changed === true, r.s + ' ' + (r.text || '').slice(0, 200));
    r = await api('GET', '/admin/site/scripts', admin);
    check('the code comes back byte for byte (< > & quotes untouched, nothing stripped)', r.j.value.customCss === css && r.j.value.headJs === headJs && r.j.value.bodyJs === bodyJs && r.j.value.enabled === true);
    r = await api('GET', '/public/site/custom.css', null);
    check('custom.css is served as CSS, readable from any origin, exactly as saved', r.s === 200 && /text\/css/.test(r.h.get('content-type')) && r.h.get('access-control-allow-origin') === '*' && r.text === css, [r.s, r.h.get('content-type')]);
    r = await api('GET', '/public/site/head.js', null);
    check('head.js is served as JavaScript', r.s === 200 && /javascript/.test(r.h.get('content-type')) && r.text === headJs);
    r = await api('GET', '/public/site/body.js', null);
    check('body.js too', r.s === 200 && r.text === bodyJs);
    const pc = (await api('GET', '/public/site?sections=scripts', null)).j.scripts;
    check('the public config lists the code with addresses, sizes and hashes (for CSP and integrity)', pc.enabled === true && /custom\.css\?v=[0-9a-f]{10}$/.test(pc.customCss.url) && pc.customCss.bytes === Buffer.byteLength(css) && pc.customCss.sha256 === sha('sha256', css) && pc.headJs.sha384 === sha('sha384', headJs) && pc.bodyJs.sha256 === sha('sha256', bodyJs), pc);
    r = await api('PATCH', '/admin/site/scripts', admin, { headJs: 'function ( {' });
    check('JavaScript with a syntax error is refused and nothing changes', r.s === 400 && r.j.details.some((d) => d.path === 'scripts.headJs' && /syntax error/.test(d.message)), r.j);
    r = await api('PATCH', '/admin/site/scripts', admin, { customCss: 'a { color: red; } </style><script>alert(1)</script>' });
    check('CSS that tries to close its tag is refused', r.s === 400 && r.j.details.some((d) => d.path === 'scripts.customCss'), r.j);
    r = await api('PATCH', '/admin/site/scripts', admin, { bodyJs: '</script><script>alert(1)' });
    check('JavaScript with a script tag is refused', r.s === 400, r.s);
    r = await api('PATCH', '/admin/site/scripts', admin, { customCss: 'x'.repeat(60_001) });
    check('more than 60 000 characters is refused', r.s === 400, r.s);
    check('the page head is not touched by custom code (it is never inlined there)', !(await api('GET', '/public/site/head?path=/order', null)).text.includes('__siteTest'));
    const auditRows = (await pg.query(`SELECT action, "after"::text AS after FROM audit_logs WHERE action = 'site.scripts.update' ORDER BY "createdAt" DESC LIMIT 5`)).rows;
    check('the audit trail has the change, with sizes and a fingerprint but not the code', auditRows.length >= 1 && !auditRows[0].after.includes('window.__siteTest') && /sha256/.test(auditRows[0].after) && /"bytes"/.test(auditRows[0].after), auditRows[0]?.after?.slice(0, 200));
    const auditAny = (await pg.query(`SELECT COUNT(*)::int AS n FROM audit_logs WHERE action LIKE 'site.%'`)).rows[0].n;
    check('every change of the site settings is in the audit log', auditAny >= 10, auditAny);
    r = await api('PATCH', '/admin/site/scripts', admin, { enabled: false });
    check('the kill switch: enabled=false takes the code off the website (404, nothing in the public config)', r.s === 200 && (await api('GET', '/public/site/custom.css', null)).s === 404 && (await api('GET', '/public/site/head.js', null)).s === 404 && (await api('GET', '/public/site?sections=scripts', null)).j.scripts.customCss === null);
    check('...and the code is still saved', (await api('GET', '/admin/site/scripts', admin)).j.value.customCss === css);

    // ============================================================ H. revisions
    section('H. revisions');
    await api('PATCH', '/admin/site/general', admin, { siteName: 'Revision One' });
    await api('PATCH', '/admin/site/general', admin, { siteName: 'Revision Two' });
    r = await api('GET', '/admin/site/general/revisions', admin);
    check('revisions list: newest first, who and when', r.s === 200 && r.j.length >= 3 && r.j[0].version > r.j[1].version && r.j[0].createdByName && r.j[0].createdAt, r.j.slice(0, 2));
    const vOne = r.j.find((x) => x.version === r.j[1].version).version;
    r = await api('GET', `/admin/site/general/revisions/${vOne}`, admin);
    check('one revision holds its values', r.s === 200 && r.j.value.siteName === 'Revision One', r.j);
    r = await api('POST', `/admin/site/general/revisions/${vOne}/restore`, admin);
    check('restore puts the old values back as a new version', r.s === 201 || r.s === 200, r);
    r = await api('GET', '/admin/site/general', admin);
    check('...the site name is back to "Revision One"', r.j.value.siteName === 'Revision One', r.j.value.siteName);
    r = await api('GET', '/admin/site/general/revisions', admin);
    check('...noted as a restore', /restored version/.test(r.j[0].note || ''), r.j[0]);
    check('a version that is not kept: 404', (await api('GET', '/admin/site/general/revisions/9999', admin)).s === 404);
    r = await api('POST', `/admin/site/scripts/revisions/1/restore`, marketing);
    check('restoring custom code is Super Admin only too', r.s === 403, r.s);
    r = await api('POST', '/admin/site/general/reset', admin);
    check('reset puts a section back to its defaults', r.s < 300 && r.j.value.siteName === 'FORKY' && r.j.value.social.length === 0, r.j?.value?.siteName);
  } finally {
    // ---- put everything back
    for (const s of SECTIONS) await api('POST', `/admin/site/${s}/reset`, admin).catch(() => undefined);
    if (marketingRole) await api('PATCH', `/admin/roles/${marketingRole.id}`, admin, { permissions: originalPermissions }).catch(() => undefined);
    await pg.query(`DELETE FROM site_setting_revisions`).catch(() => undefined);
    await pg.query(`DELETE FROM site_settings`).catch(() => undefined);
    for (const u of uploadedUrls) {
      const f = new URL(u).pathname.split('/').pop();
      await pg.query(`DELETE FROM uploaded_files WHERE filename = $1`, [f]).catch(() => undefined);
      try { unlinkSync(join(process.cwd(), 'backend', 'uploads', f)); } catch { /* the API may run from another folder */ }
      try { unlinkSync(join(process.cwd(), 'uploads', f)); } catch { /* ignore */ }
    }
    await pg.end();
  }
  const fails = results.filter((x) => !x.ok);
  console.log(`\nSUMMARY ${results.length - fails.length}/${results.length} passed`);
  if (fails.length) console.log(`  FAILED: ${fails.map((f) => f.name).join('\n          ')}`);
  process.exit(fails.length ? 1 : 0);
}
main().catch((e) => { console.error('crashed', e); process.exit(1); });
