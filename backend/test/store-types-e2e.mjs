#!/usr/bin/env node
/**
 * FORKSY store types end-to-end test: REAL HTTP against a running API (+ SQL on stock / notifications). docs/store-types.md
 *
 * Proves that one platform serves restaurants, cafes, bakeries AND grocery / convenience / specialty stores:
 *   A  discovery by store type (store-types tiles, home / stores / search filters, barcode lookup, catalog summary vs full menu)
 *   B  the paged catalog of a grocery store (departments, search, in-stock filter, age-restricted filter, sorting, product page, sold-out / low-stock facts)
 *   C  catalog management in the portal (paged product list, SKU / barcode / weight / age rules, licence gate, bulk stock update, CSV round trip)
 *   D  cart + quote (products sold by weight, per-order limits, stock, age confirmation, no "leave at door" for age-restricted baskets, bigger carts for groceries)
 *   E  placing an order takes the stock off the shelf (atomically: two customers cannot both take the last eggs) and cancelling gives it back
 *   F  picking: weighed (lighter = refund, heavier = never charged more), out of stock (refund), replaced (the customer pays the lower price), customer told
 *   G  every product out of stock -> the empty order is cancelled and fully refunded
 *   H  ID check at the door: required, checked (delivered) and refused (age-restricted products not handed over and refunded)
 *
 * Run (API + Postgres up, seeded with the demo data incl. the demo grocery stores; mock payments or test payments):
 *   API=http://localhost:4100/api/v1 ADMIN_PASSWORD=<super admin> DEMO_PASSWORD=<demo accounts> PGPASSWORD=<postgres> PGDATABASE=<db> node backend/test/store-types-e2e.mjs
 * It temporarily sets orders.customerCancelGraceSeconds to 0 and restores it and every stock level it changed in a finally block.
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Client } = require('pg');

const API = (process.env.API || 'http://localhost:4100/api/v1').replace(/\/$/, '');
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@forksy.ca';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const DEMO_PASSWORD = process.env.DEMO_PASSWORD;
if (!ADMIN_PASSWORD || !DEMO_PASSWORD || !process.env.PGPASSWORD) {
  console.error('Set ADMIN_PASSWORD, DEMO_PASSWORD and PGPASSWORD (see the header of this file).');
  process.exit(2);
}
const SUPER = process.env.GROCERY_SLUG || 'fresh-basket-supermarket';
const ASIAN = 'seoul-asian-market';
const BUTCHER = 'prime-cut-halal-butcher';
const RESTO = 'napoli-wood-fired-pizza-city-centre';
const LOC = { lat: 43.5925, lng: -79.6428 }; // City Centre, Mississauga

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra) => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && extra !== undefined ? '  -> ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 380) : ''}`);
};
const section = (s) => console.log(`\n--- ${s}`);
const money = (n) => Math.round(Number(n) * 100) / 100;

async function api(method, path, token, body) {
  for (let i = 0; i < 6; i++) {
    const r = await fetch(API + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    let j = null; try { j = await r.json(); } catch { /* empty body */ }
    if (r.status === 429 && !path.startsWith('/auth/')) { await sleep(12000); continue; }
    return { s: r.status, j };
  }
}
async function login(identifier, password, app) {
  for (let i = 0; i < 5; i++) {
    const r = await api('POST', '/auth/login', null, { identifier, password, ...(app ? { app } : {}) });
    const d = r.j && (r.j.data || r.j);
    if (d && d.accessToken) return d;
    if (r.s === 429) { await sleep(15000); continue; }
    throw new Error(`login failed for ${identifier}: ${r.s}`);
  }
  throw new Error(`login throttled for ${identifier}`);
}
const pg = new Client({ host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5432), user: process.env.PGUSER || 'postgres', password: process.env.PGPASSWORD, database: process.env.PGDATABASE || 'forksy' });
const sql = async (q, p) => (await pg.query(q, p)).rows;

const S = {};
const placed = [];
const stockBefore = new Map(); // item id -> { stockQty, trackStock }

/** catalog of a store: sku -> product (public API, all pages) */
async function skuMap(slug) {
  const m = new Map();
  for (let page = 1; page < 30; page++) {
    const r = await api('GET', `/public/stores/${slug}/catalog?limit=100&page=${page}`);
    for (const p of r.j.data) m.set(p.sku, p);
    if (page >= r.j.meta.totalPages) break;
  }
  return m;
}
const stockOf = async (itemId) => Number((await sql(`SELECT "stockQty" FROM menu_items WHERE id = $1`, [itemId]))[0]?.stockQty);
const orderOf = async (id) => (await api('GET', `/customer/orders/${id}`, S.c1)).j;
const adminOrder = async (id) => { const j = (await api('GET', `/admin/orders/${id}`, S.admin)).j; return j.order || j; };
const cancelAdmin = (id) => api('POST', `/admin/orders/${id}/cancel`, S.admin, { reason: 'store-types-e2e cleanup', restaurantApproval: { contactName: 'Store Types E2E', channel: 'CHAT' } });
const refundsOf = async (orderId) => (await sql(`SELECT amount, "reasonCode", status FROM refunds WHERE "orderId" = $1 ORDER BY "createdAt"`, [orderId])).map((r) => ({ ...r, amount: money(r.amount) }));
const refundSum = async (orderId) => money((await refundsOf(orderId)).filter((r) => r.status === 'PROCESSED').reduce((s, r) => s + r.amount, 0));
const paidBack = async (orderId) => money((await sql(`SELECT COALESCE(SUM(amount), 0) s FROM payments WHERE "orderId" = $1 AND kind = 'REFUND'`, [orderId]))[0].s);
const notifs = async (orderId, userId) => (await sql(`SELECT DISTINCT event FROM notifications WHERE data->>'orderId' = $1 AND "userId" = $2`, [orderId, userId])).map((r) => r.event);

async function setCart(restaurantId, lines) {
  return api('POST', '/customer/cart/replace', S.c1, { restaurantId, items: lines });
}
const quoteBody = (extra = {}) => ({ type: 'DELIVERY', addressId: S.addr, tip: 2, ...extra });
const getQuote = (extra) => api('POST', '/customer/checkout/quote', S.c1, quoteBody(extra));
async function place(extra = {}) {
  const r = await api('POST', '/customer/orders', S.c1, { ...quoteBody(), paymentMethod: 'CARD', paymentToken: 'pm_mock', dropoffMethod: 'HAND_TO_ME', ...extra });
  if (r.j?.id) placed.push(r.j.id);
  return r;
}
async function waitFor(fn, ms = 20000, every = 800) {
  const end = Date.now() + ms;
  let v;
  while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(every); }
  return v;
}

async function main() {
  await pg.connect();
  const origGrace = ((await api('GET', '/admin/settings?group=orders', (S.admin = (await login(ADMIN_EMAIL, ADMIN_PASSWORD)).accessToken))).j.data || []).find((s) => s.key === 'orders.customerCancelGraceSeconds')?.value ?? 120;
  try {
    S.c1d = await login('customer1@demo.forksy.ca', DEMO_PASSWORD, 'customer');
    S.c1 = S.c1d.accessToken;
    S.c1id = (await api('GET', '/auth/me', S.c1)).j.id;
    S.owner = (await login('owner27@demo-restaurant.ca', DEMO_PASSWORD, 'restaurant')).accessToken; // Fresh Basket Supermarket
    S.butcher = (await login('owner29@demo-restaurant.ca', DEMO_PASSWORD, 'restaurant')).accessToken; // Prime Cut Halal Butcher (no alcohol licence)
    const addrs = (await api('GET', '/customer/addresses', S.c1)).j;
    S.addr = (Array.isArray(addrs) ? addrs : addrs.data).find((a) => a.isDefault).id;
    let r = await api('PUT', '/admin/settings', S.admin, { values: { 'orders.customerCancelGraceSeconds': 0 } });
    check('setup: customer cancel window set to 0 for the run', r.s < 300, r);
    // remember every stock level of the three stores before anything changes: restored at the end
    for (const row of await sql(`SELECT i.id, i."stockQty", i."trackStock" FROM menu_items i JOIN restaurants r ON r.id = i."restaurantId" WHERE r.slug = ANY($1)`, [[SUPER, ASIAN, BUTCHER]])) stockBefore.set(row.id, row);

    // ============================================================ A. discovery by store type
    section('A. discovery by store type');
    r = await api('GET', `/public/store-types?lat=${LOC.lat}&lng=${LOC.lng}`);
    const tiles = r.j?.data ?? [];
    const tile = (t) => tiles.find((x) => x.type === t);
    check('GET /public/store-types lists every kind of store', ['RESTAURANT', 'CAFE', 'BAKERY', 'GROCERY', 'CONVENIENCE', 'SPECIALTY'].every((t) => tile(t)), tiles.map((x) => x.type));
    check('restaurants, cafes and bakeries are FOOD; grocery, convenience and specialty are RETAIL', tile('RESTAURANT')?.vertical === 'FOOD' && tile('CAFE')?.vertical === 'FOOD' && tile('BAKERY')?.vertical === 'FOOD' && tile('GROCERY')?.vertical === 'RETAIL' && tile('CONVENIENCE')?.retail === true && tile('SPECIALTY')?.vertical === 'RETAIL');
    check('each tile says how many stores are around and what its products are called', tile('GROCERY')?.count >= 1 && tile('RESTAURANT')?.count >= 1 && tile('GROCERY')?.itemLabelPlural === 'products' && tile('RESTAURANT')?.itemLabelPlural === 'dishes' && tile('GROCERY')?.categoryLabel === 'Department', tile('GROCERY'));
    check('verticals tell food from retail', (r.j?.verticals ?? []).length === 2 && r.j.verticals.every((v) => v.count >= 1), r.j?.verticals);

    r = await api('GET', `/public/home?lat=${LOC.lat}&lng=${LOC.lng}&storeType=GROCERY`);
    const homeNearby = r.j?.nearby ?? [];
    check('home?storeType=GROCERY shows grocery stores only', homeNearby.length >= 1 && homeNearby.every((c) => c.storeType === 'GROCERY') && homeNearby.some((c) => c.slug === SUPER), homeNearby.map((c) => c.slug + ':' + c.storeType));
    check('home keeps the unfiltered store type tiles so the page can switch kind', (r.j?.storeTypes ?? []).length === 6 && r.j.storeTypes.find((t) => t.type === 'RESTAURANT')?.count >= 1 && r.j.filter?.applied === true, r.j?.filter);
    r = await api('GET', `/public/home?lat=${LOC.lat}&lng=${LOC.lng}&vertical=FOOD`);
    check('home?vertical=FOOD shows no grocery store', (r.j?.nearby ?? []).length >= 1 && (r.j.nearby ?? []).every((c) => c.vertical === 'FOOD'), (r.j?.nearby ?? []).map((c) => c.storeType));
    r = await api('GET', `/public/home?lat=${LOC.lat}&lng=${LOC.lng}`);
    check('home without a filter still has everything, split into sections.food and sections.retail', (r.j?.sections?.food ?? []).length >= 1 && (r.j.sections.retail ?? []).length >= 1 && r.j.counts.retail >= 1 && r.j.counts.food >= 1, r.j?.counts);
    check('every card says what kind of store it is', (r.j?.nearby ?? []).every((c) => c.storeType && c.storeTypeLabel && typeof c.retail === 'boolean'));

    r = await api('GET', `/public/stores?lat=${LOC.lat}&lng=${LOC.lng}&storeType=GROCERY,SPECIALTY&limit=50`);
    check('GET /public/stores browses by type (GROCERY,SPECIALTY)', (r.j?.data ?? []).length >= 2 && r.j.data.every((c) => ['GROCERY', 'SPECIALTY'].includes(c.storeType)) && !!r.j.meta, (r.j?.data ?? []).map((c) => c.storeType));
    r = await api('GET', `/public/stores?lat=${LOC.lat}&lng=${LOC.lng}&storeType=BAKERY,CAFE`);
    check('bakeries and cafes are stores of their own kind', (r.j?.data ?? []).length >= 1 && r.j.data.every((c) => ['BAKERY', 'CAFE'].includes(c.storeType)), (r.j?.data ?? []).map((c) => c.slug + ':' + c.storeType));
    r = await api('GET', `/public/stores?lat=${LOC.lat}&lng=${LOC.lng}&storeType=NOPE`);
    check('an unknown store type matches nothing instead of everything', (r.j?.data ?? []).length === 0, r.j?.meta);
    r = await api('GET', `/public/restaurants/${SUPER}`);
    check('/restaurants/:slug and /stores/:slug are the same store', (await api('GET', `/public/stores/${SUPER}`)).j?.restaurant?.id === r.j?.restaurant?.id && !!r.j?.restaurant?.id);

    // ---- search: products, brands, barcodes
    const sm = await skuMap(SUPER);
    const rice = sm.get('FB-PA-001');
    r = await api('GET', `/public/search?lat=${LOC.lat}&lng=${LOC.lng}&q=rice&storeType=GROCERY`);
    check('search finds grocery products and says which store sells them', (r.j?.dishes ?? []).some((d) => /rice/i.test(d.name) && d.restaurant.retail === true && d.restaurant.storeType === 'GROCERY'), (r.j?.dishes ?? []).map((d) => d.name));
    check('a found product carries its catalog facts (sku, brand, pack size, stock, temperature)', (r.j?.dishes ?? []).some((d) => d.sku && d.brand && d.packSize && d.inStock === true && d.temperature), (r.j?.dishes ?? [])[0]);
    r = await api('GET', `/public/search?lat=${LOC.lat}&lng=${LOC.lng}&q=${rice.barcode}`);
    const stores = new Set((r.j?.dishes ?? []).map((d) => d.restaurant.slug));
    check('a barcode finds the same product in every store that sells it (supermarket + Asian market)', stores.has(SUPER) && stores.has(ASIAN), [...stores]);
    r = await api('GET', `/public/search?lat=${LOC.lat}&lng=${LOC.lng}&barcode=${rice.barcode}&storeType=GROCERY`);
    check('barcode= works as a filter as well', (r.j?.dishes ?? []).length >= 2, r.j?.filter);
    r = await api('GET', `/public/search?lat=${LOC.lat}&lng=${LOC.lng}&q=tilda`);
    check('a brand name is searchable', (r.j?.dishes ?? []).some((d) => d.brand === 'Tilda'));

    // ---- store page: restaurants keep the full menu, grocery stores get a summary
    r = await api('GET', `/public/stores/${SUPER}?perCategory=3`);
    const page = r.j;
    check('grocery store page: menu.mode CATALOG, truncated to 3 products per department, with the product count of every department', page.menu?.mode === 'CATALOG' && page.menu.truncated === true && page.menu.categories.every((c) => c.items.length <= 3 && c.itemCount >= c.items.length) && page.menu.categories.some((c) => c.itemCount > c.items.length), { mode: page.menu?.mode, truncated: page.menu?.truncated });
    r = await api('GET', `/public/stores/${SUPER}?menu=full`);
    check('?menu=full returns every product of a grocery store too', r.j.menu.mode === 'MENU' && r.j.menu.truncated === false && r.j.menu.categories.reduce((n, c) => n + c.items.length, 0) === r.j.menu.itemCount, { mode: r.j.menu.mode });
    r = await api('GET', `/public/stores/${RESTO}?menu=summary&perCategory=2`);
    check('a restaurant can ask for a summary too', r.j.menu.truncated === true && r.j.menu.categories.every((c) => c.items.length <= 2));
    check('grocery store page says how the store works (labels + limits)', page.restaurant.store?.retail === true && page.restaurant.store.categoryLabel === 'Department' && page.restaurant.store.limits.maxQtyPerLine === 99, page.restaurant.store);
    check('the whole store is counted (menu.itemCount)', page.menu.itemCount >= 40, page.menu.itemCount);
    r = await api('GET', `/public/stores/${RESTO}`);
    check('restaurant page keeps the whole menu as before (mode MENU, nothing truncated)', r.j.menu.mode === 'MENU' && r.j.menu.truncated === false && r.j.menu.categories.every((c) => c.itemCount === c.items.length) && r.j.restaurant.store.retail === false, { mode: r.j.menu?.mode });

    // ============================================================ B. the catalog of a grocery store
    section('B. paged catalog of a grocery store');
    r = await api('GET', `/public/stores/${SUPER}/catalog?limit=10&page=1`);
    check('catalog is paged (10 per page, total, pages)', r.j.data.length === 10 && r.j.meta.total >= 40 && r.j.meta.totalPages >= 4 && r.j.meta.page === 1, r.j.meta);
    const p2 = await api('GET', `/public/stores/${SUPER}/catalog?limit=10&page=2`);
    check('page 2 has other products', p2.j.data.length === 10 && !p2.j.data.some((d) => r.j.data.some((x) => x.id === d.id)));
    check('the catalog lists the departments with their product counts', r.j.categories.length >= 8 && r.j.categories.every((c) => c.itemCount >= 1) && r.j.categories.some((c) => c.name === 'Produce'), r.j.categories.map((c) => c.name));
    const produce = r.j.categories.find((c) => c.name === 'Produce');
    r = await api('GET', `/public/stores/${SUPER}/catalog?categoryId=${produce.id}&limit=50`);
    check('one department (Produce)', r.j.meta.total === produce.itemCount && r.j.data.every((d) => d.categoryId === produce.id));
    r = await api('GET', `/public/stores/${SUPER}/catalog?q=milk`);
    check('search inside the store by name', r.j.data.length >= 1 && r.j.data.every((d) => /milk/i.test(d.name + (d.description ?? ''))), r.j.data.map((d) => d.name));
    r = await api('GET', `/public/stores/${SUPER}/catalog?q=neilson`);
    check('search inside the store by brand', r.j.data.some((d) => d.brand === 'Neilson'));
    r = await api('GET', `/public/stores/${SUPER}/catalog?q=${rice.barcode}`);
    check('search inside the store by barcode', r.j.data.length === 1 && r.j.data[0].sku === 'FB-PA-001', r.j.data.map((d) => d.sku));
    r = await api('GET', `/public/stores/${SUPER}/catalog?limit=100`);
    check('without inStock the sold-out sourdough is listed but cannot be bought', r.j.data.some((d) => d.sku === 'FB-B-001' && d.available === false && d.inStock === false && d.unavailableReason === 'OUT_OF_STOCK'), r.j.data.find((d) => d.sku === 'FB-B-001'));
    r = await api('GET', `/public/stores/${SUPER}/catalog?limit=100&inStock=true`);
    check('inStock=true hides sold-out products', !r.j.data.some((d) => d.sku === 'FB-B-001') && r.j.meta.total >= 40);
    r = await api('GET', `/public/stores/${SUPER}/catalog?restricted=true`);
    check('restricted=true lists the age-restricted products (beer and wine, 19+)', r.j.data.length === 3 && r.j.data.every((d) => d.minAge === 19 && d.ageRestricted === true), r.j.data.map((d) => d.name));
    r = await api('GET', `/public/stores/${SUPER}/catalog?categoryId=${produce.id}&sort=price_low&limit=50`);
    check('sorted by price, lowest first', r.j.data.every((d, i, a) => i === 0 || Number(a[i - 1].price) <= Number(d.price)));
    r = await api('GET', `/public/stores/${SUPER}/catalog?categoryId=not-an-id`);
    check('a bad categoryId is a 400, not a crash', r.s === 400, r.s);
    const bananas = sm.get('FB-P-001');
    check('products sold by weight say so: per kg, step, price of one step', bananas.sellBy === 'WEIGHT' && bananas.weightUnit === 'KG' && bananas.stepSize === 0.5 && money(bananas.stepPrice) === 1.09 && /kg/i.test(bananas.stepLabel ?? ''), bananas);
    const eggs = sm.get('FB-D-002');
    check('low stock is flagged and the most one can order is capped by stock and per-order limit', eggs.lowStock === true && eggs.maxQuantity === 3 && eggs.maxPerOrder === 4, { low: eggs.lowStock, max: eggs.maxQuantity });
    const lager = sm.get('FB-A-001');
    check('age-restricted product: minAge 19, cold chain / pack facts present', lager.minAge === 19 && lager.packSize === '6 x 355 ml' && lager.maxQuantity === 4, lager);
    check('cold chain: chilled and frozen products are marked', sm.get('FB-D-001').temperature === 'CHILLED' && sm.get('FB-F-001').temperature === 'FROZEN' && sm.get('FB-PA-001').temperature === 'AMBIENT');
    r = await api('GET', `/public/stores/${SUPER}/products/${bananas.id}`);
    check('one product page', r.j.product?.id === bananas.id && r.j.store?.retail === true && r.j.category?.name === 'Produce', r.j);
    r = await api('GET', `/public/stores/${SUPER}/products/${rice.id.replace(/.$/, '0')}`);
    check('an unknown product is a 404', r.s === 404, r.s);

    // ============================================================ C. catalog management in the portal
    section('C. catalog management');
    const ownerQ = '';
    r = await api('GET', '/restaurant/menu/items?limit=10', S.owner);
    check('GET /restaurant/menu/items is a paged product list with stock counts', r.s === 200 && r.j.data.length === 10 && r.j.meta.total >= 40 && r.j.counts.tracked >= 30 && r.j.counts.outOfStock >= 1 && r.j.counts.lowStock >= 1, r.j?.counts);
    r = await api('GET', '/restaurant/menu/items?stock=out', S.owner);
    check('filter: sold out', r.j.data.length >= 1 && r.j.data.every((i) => i.stockState === 'OUT') && r.j.data.some((i) => i.sku === 'FB-B-001'), r.j.data.map((i) => i.sku));
    r = await api('GET', '/restaurant/menu/items?stock=low', S.owner);
    check('filter: low stock', r.j.data.some((i) => i.sku === 'FB-D-002') && r.j.data.every((i) => i.stockState === 'LOW'));
    r = await api('GET', '/restaurant/menu/items?q=FB-D-00&sortBy=sku', S.owner);
    check('search by SKU, sorted by SKU', r.j.data.length === 5 && r.j.data.every((i, k, a) => k === 0 || a[k - 1].sku <= i.sku), r.j.data.map((i) => i.sku));
    r = await api('GET', '/restaurant/menu/items?sortBy=hack;drop', S.owner);
    check('an unknown sort column is refused (400), never put into SQL', r.s === 400, r.s);

    r = await api('GET', '/restaurant/dashboard', S.owner);
    check('the portal dashboard says what kind of store this is (storeType, retail, the words for its items and groups)', r.j.restaurant.storeType === 'GROCERY' && r.j.restaurant.retail === true && r.j.restaurant.categoryLabel === 'Department' && r.j.restaurant.itemLabelPlural === 'products', r.j.restaurant);
    r = await api('GET', '/restaurant/menu?items=false', S.owner);
    check('menu?items=false is the light structure for big catalogs: departments with their product counts and no items', r.s === 200 && r.j.categories.length >= 8 && r.j.categories.every((c) => c.itemCount >= 1 && c.items.length === 0) && r.j.counts.items >= 40 && !!r.j.access && Array.isArray(r.j.modifierGroups), { s: r.s, cats: r.j?.categories?.length });
    r = await api('GET', '/restaurant/menu/items?search=milk', S.owner);
    check('the paged list also takes the portal list parameter "search" (same as q)', r.s === 200 && r.j.data.some((i) => /Milk/.test(i.name)), r);
    const cats = (await api('GET', '/restaurant/menu', S.owner)).j.categories;
    const pantryId = cats.find((c) => c.name === 'Pantry').id;
    const newItem = { name: 'E2E Test Honey', price: 6.5, categoryId: pantryId, taxClassCode: 'ZERO_RATED', sku: 'E2E-HONEY-1', barcode: '0123456789012', brand: 'Test', packSize: '500 g', trackStock: true, stockQty: 10, lowStockThreshold: 2 };
    r = await api('POST', '/restaurant/menu/items', S.owner, newItem);
    check('create a product with SKU, barcode, brand, pack size and stock', r.s < 300 && r.j.sku === 'E2E-HONEY-1' && Number(r.j.stockQty) === 10 && r.j.trackStock === true, r);
    const honeyId = r.j?.id;
    r = await api('POST', '/restaurant/menu/items', S.owner, { ...newItem, name: 'E2E Dup' });
    check('the same SKU twice in a store is refused (409)', r.s === 409, r);
    r = await api('POST', '/restaurant/menu/items', S.owner, { ...newItem, name: 'E2E Bad Code', sku: 'E2E-X', barcode: '12ab' });
    check('a barcode that is not 6 to 14 digits is refused (400)', r.s === 400, r);
    r = await api('POST', '/restaurant/menu/items', S.owner, { name: 'E2E Weighed', price: 5, sellBy: 'WEIGHT', sku: 'E2E-W' });
    check('a product sold by weight needs a step size (400)', r.s === 400, r);
    r = await api('POST', '/restaurant/menu/items', S.owner, { name: 'E2E Tracked', price: 5, trackStock: true, sku: 'E2E-T' });
    check('tracking stock needs a stock level (400)', r.s === 400, r);
    r = await api('POST', '/restaurant/menu/items', S.owner, { name: 'E2E Half', price: 5, trackStock: true, stockQty: 2.5, sku: 'E2E-H' });
    check('pieces are whole numbers (400 for 2.5 pieces)', r.s === 400, r);
    r = await api('POST', '/restaurant/menu/items', S.owner, { name: 'E2E Age', price: 5, minAge: 17, sku: 'E2E-A' });
    check('only real ages can be set (18, 19, 21)', r.s === 400, r);
    r = await api('POST', '/restaurant/menu/items', S.owner, { name: 'E2E Wine', price: 15, minAge: 19, sku: 'E2E-WINE', categoryId: pantryId });
    check('a store with an approved liquor licence may list age-restricted products', r.s < 300 && r.j.minAge === 19, r);
    const wineId = r.j?.id;
    r = await api('POST', '/restaurant/menu/items', S.butcher, { name: 'E2E Butcher Beer', price: 12, minAge: 19, sku: 'E2E-BEER' });
    check('a store WITHOUT a liquor / tobacco licence may not (400 LICENCE_REQUIRED)', r.s === 400 && r.j?.code === 'LICENCE_REQUIRED', r);
    r = await api('PATCH', `/restaurant/menu/items/${honeyId}`, S.owner, { stockQty: 7 });
    check('PATCH keeps what it does not mention (partial update)', r.s < 300 && Number(r.j.stockQty) === 7 && r.j.sku === 'E2E-HONEY-1' && r.j.brand === 'Test', r);
    r = await api('PATCH', `/restaurant/menu/items/${honeyId}`, S.owner, { sku: 'FB-D-001' });
    check('changing to a SKU that another product has is refused (409)', r.s === 409, r);

    // bulk stock (by sku, barcode, id) - what a POS / inventory feed sends
    r = await api('POST', '/restaurant/menu/stock', S.owner, { updates: [{ sku: 'E2E-HONEY-1', delta: 5 }, { barcode: '0123456789012', delta: -2 }, { sku: 'FB-PA-003', stockQty: 90 }, { sku: 'NO-SUCH-SKU', stockQty: 1 }, { sku: 'FB-PA-002' }, { sku: 'FB-PA-004', stockQty: 2.5 }] });
    check('bulk stock update: counted by SKU, barcode and absolute level (2 products change); unknown SKUs, empty rows and fractions are reported, nothing else changes', r.s < 300 && r.j.updated === 2 && r.j.notFound.length === 1 && r.j.errors.length === 2, r);
    check('...and the numbers are right (7 + 5 - 2 = 10 honey)', (await stockOf(honeyId)) === 10);
    r = await api('POST', '/restaurant/menu/stock', S.owner, { updates: [{ sku: 'E2E-HONEY-1', stockQty: 0 }] });
    r = await api('GET', `/public/stores/${SUPER}/catalog?q=E2E-HONEY`, null);
    check('a product counted down to 0 is sold out in the public catalog at once', r.j.data[0]?.inStock === false && r.j.data[0]?.available === false, r.j.data[0]);
    r = await api('POST', '/restaurant/menu/stock', S.owner, { updates: [] });
    check('an empty stock update is a 400', r.s === 400, r.s);
    r = await api('POST', '/restaurant/menu/stock', S.c1, { updates: [{ sku: 'FB-PA-003', stockQty: 1 }] });
    check('customers cannot change stock', r.s === 401 || r.s === 403, r.s);
    r = await api('GET', '/restaurant/menu/csv', S.owner);
    const csv = r.j?.csv ?? '';
    check('CSV export has the catalog columns', /,sku,barcode,brand,pack_size,sell_by,weight_unit,step_size,track_stock,stock_qty,low_stock,max_per_order,min_age,temperature/.test(csv.split('\n')[0]) && /FB-P-001/.test(csv) && /WEIGHT/.test(csv), csv.split('\n')[0]);
    const csvIn = 'category,name,price,sku,stock_qty,barcode\r\nPantry,Rice (renamed by the file),9.99,FB-PA-001,55,\r\nPantry,E2E CSV New,3.25,E2E-CSV-1,9,998877665544\r\n';
    r = await api('POST', '/restaurant/menu/csv', S.owner, { csv: csvIn, mode: 'merge' });
    check('CSV import (merge): matches by SKU, updates stock, creates new products', r.s < 300 && r.j.created === 1 && r.j.updated === 1, r);
    const afterCsv = await skuMap(SUPER);
    check('...the renamed product kept its other facts (brand, weight) and got the new stock', afterCsv.get('FB-PA-001')?.name === 'Rice (renamed by the file)' && afterCsv.get('FB-PA-001').brand === 'Tilda' && afterCsv.get('E2E-CSV-1')?.inStock === true);
    r = await api('POST', '/restaurant/menu/csv', S.owner, { csv: 'category,name,price,sku,barcode\r\nPantry,A,1,DUPSKU,\r\nPantry,B,1,DUPSKU,\r\nPantry,C,1,X,12\r\n' });
    check('CSV with a repeated SKU or a bad barcode is refused as a whole (nothing imported)', r.s === 400 && (r.j?.details ?? []).length === 2, r);
    r = await api('POST', '/restaurant/menu/csv', S.butcher, { csv: 'category,name,price,min_age\r\nBeef & Lamb,Beer,10,19\r\n' });
    check('CSV with age-restricted products needs the licence too', r.s === 400 && r.j?.code === 'LICENCE_REQUIRED', r);
    // clean the test products
    for (const id of [honeyId, wineId, afterCsv.get('E2E-CSV-1')?.id].filter(Boolean)) await api('DELETE', `/restaurant/menu/items/${id}`, S.owner);
    await api('PATCH', `/restaurant/menu/items/${(await skuMap(SUPER)).get('FB-PA-001').id}`, S.owner, { name: 'Basmati Rice' });


    // ============================================================ D. cart + quote
    section('D. cart and quote');
    const cur = await skuMap(SUPER);
    const P = (sku) => cur.get(sku);
    const restId = (await api('GET', `/public/stores/${SUPER}`)).j.restaurant.id;
    r = await setCart(restId, [{ menuItemId: P('FB-P-001').id, quantity: 2 }, { menuItemId: P('FB-D-001').id, quantity: 2 }, { menuItemId: P('FB-A-001').id, quantity: 1 }, { menuItemId: P('FB-D-002').id, quantity: 1, substitution: 'REFUND' }]);
    check('cart accepts weighed, piece, age-restricted products and a "refund, no replacement" choice', r.s < 300 && r.j.lines.length === 4, r);
    const cart = (await api('GET', '/customer/cart', S.c1)).j;
    const cl = (sku) => cart.lines.find((l) => l.sku === sku);
    check('cart lines carry weights: 2 steps of 0.5 kg = ~1 kg at 1.09 per step', cl('FB-P-001').sellBy === 'WEIGHT' && cl('FB-P-001').estimatedWeight === 1 && money(cl('FB-P-001').unitPrice) === 1.09 && money(cl('FB-P-001').lineTotal) === 2.18 && /1 kg/.test(cl('FB-P-001').weightLabel), cl('FB-P-001'));
    check('cart: substitution preference kept per line (REFUND vs default ALLOW)', cl('FB-D-002').substitution === 'REFUND' && cl('FB-D-001').substitution === 'ALLOW');
    check('cart says the basket needs an ID check (19+) and summarises it (units, weighed, chilled)', cart.requiresIdCheck === true && cart.minAge === 19 && cart.basket.weighed === 1 && cart.basket.chilled >= 2 && cart.basket.estimatedKg === 1, { id: cart.requiresIdCheck, basket: cart.basket });
    check('cart tells the store type and the most each line can hold', cart.restaurant.storeType === 'GROCERY' && cart.restaurant.retail === true && cl('FB-D-001').maxQuantity >= 20);

    r = await getQuote();
    check('quote refuses an age-restricted basket until the customer confirms their age (400 AGE_CONFIRMATION_REQUIRED)', r.s === 400 && r.j.code === 'AGE_CONFIRMATION_REQUIRED' && r.j.details?.minAge === 19, r);
    r = await getQuote({ ageConfirmed: 'false' });
    check('the string "false" does not count as a confirmation', r.s === 400, r);
    r = await getQuote({ ageConfirmed: true, dropoffMethod: 'LEAVE_AT_DOOR' });
    check('...and age-restricted products can never be left at the door (400 ID_CHECK_NO_LEAVE_AT_DOOR)', r.s === 400 && r.j.code === 'ID_CHECK_NO_LEAVE_AT_DOOR', r);
    r = await getQuote({ ageConfirmed: true });
    const q = r.j;
    check('quote with the age confirmed: requiresIdCheck, minAge, basket, store type', r.s < 300 && q.requiresIdCheck === true && q.minAge === 19 && q.storeType === 'GROCERY' && q.basket.units >= 5, r);
    const ql = (sku) => q.lines.find((l) => l.sku === sku);
    check('quote lines: weighed line priced per step with the estimated weight; ZERO_RATED groceries carry no tax, beer 13% HST', money(ql('FB-P-001').lineTotal) === 2.18 && ql('FB-P-001').estimatedWeight === 1 && money(ql('FB-P-001').taxAmount) === 0 && money(ql('FB-A-001').taxAmount) === money(14.95 * 0.13), { w: ql('FB-P-001'), a: ql('FB-A-001') });
    check('quote: retail prep time is longer than the store\'s base (a basket takes time to pick)', q.prepTimeMin >= 11 && q.storeType === 'GROCERY', q.prepTimeMin);

    r = await setCart(restId, [{ menuItemId: P('FB-D-002').id, quantity: 4 }]);
    check('cart: more eggs than the shelf holds is refused (400 INSUFFICIENT_STOCK)', r.s === 400 && r.j.code === 'INSUFFICIENT_STOCK', r);
    r = await setCart(restId, [{ menuItemId: P('FB-A-001').id, quantity: 5 }]);
    check('cart: more than the per-order limit (4 lagers) is refused (400 MAX_PER_ORDER)', r.s === 400 && r.j.code === 'MAX_PER_ORDER', r);
    r = await setCart(restId, [{ menuItemId: P('FB-S-003').id, quantity: 75 }]);
    check('a grocery cart line may hold 99 (here 75 chocolate bars)', r.s < 300 && r.j.lines[0].quantity === 75, r);
    const restoId = (await api('GET', `/public/stores/${RESTO}`)).j.restaurant.id;
    const dish = (await api('GET', `/public/stores/${RESTO}/catalog?limit=50`)).j.data.find((d) => d.modifierGroups.every((g) => !g.required) && d.available);
    r = await setCart(restoId, [{ menuItemId: dish.id, quantity: 60 }]);
    check('a restaurant cart line stops at 50', r.s === 400, r);
    await api('POST', '/restaurant/menu/stock', S.owner, { updates: [{ sku: 'FB-S-003', stockQty: 500 }] });
    r = await setCart(restId, [{ menuItemId: P('FB-S-003').id, quantity: 99 }]);
    check('99 is the most a grocery line takes', r.s < 300, r);
    r = await api('POST', '/customer/cart/items', S.c1, { menuItemId: P('FB-S-003').id, quantity: 1 });
    check('...and one more on top of it is capped at 99', r.s < 300 && r.j.lines[0].quantity === 99, r.j?.lines?.[0]?.quantity);

    // ============================================================ E. placing an order takes stock; cancelling returns it
    section('E. stock follows orders');
    const milk0 = await stockOf(P('FB-D-001').id);
    const ban0 = await stockOf(P('FB-P-001').id);
    r = await setCart(restId, [{ menuItemId: P('FB-P-001').id, quantity: 2 }, { menuItemId: P('FB-D-001').id, quantity: 2 }, { menuItemId: P('FB-PA-002').id, quantity: 6 }]);
    r = await place();
    check('order placed (grocery, weighed + pieces)', r.s < 300 && r.j.id, r);
    const o1 = r.j;
    check('order records the basket and no ID check', o1.requiresIdCheck === false && o1.basket?.units === 10 && o1.basket.weighed === 1, o1.basket);
    check('stock taken off the shelf: milk -2, bananas -1 kg (2 steps of 0.5)', (await stockOf(P('FB-D-001').id)) === milk0 - 2 && (await stockOf(P('FB-P-001').id)) === ban0 - 1, { milk: await stockOf(P('FB-D-001').id), bananas: await stockOf(P('FB-P-001').id) });
    const d1 = await orderOf(o1.id);
    check('order items keep the weighed facts and prices', d1.items.find((i) => i.sku === 'FB-P-001')?.sellBy === 'WEIGHT' && Number(d1.items.find((i) => i.sku === 'FB-P-001').estimatedWeight) === 1 && d1.statusLabel && d1.retail === true && d1.picking?.lines === 3, { label: d1.statusLabel, picking: d1.picking });
    check('the customer reads the status in grocery words once accepted', await waitFor(async () => /confirmed|picking/i.test((await orderOf(o1.id)).statusLabel), 15000), (await orderOf(o1.id)).statusLabel);
    r = await cancelAdmin(o1.id);
    check('order cancelled (admin, with the store\'s approval)', r.s < 300, r);
    check('cancelling puts the products back on the shelf', (await stockOf(P('FB-D-001').id)) === milk0 && (await stockOf(P('FB-P-001').id)) === ban0, { milk: await stockOf(P('FB-D-001').id), bananas: await stockOf(P('FB-P-001').id) });
    check('...and refunds the customer in full', (await orderOf(o1.id)).paymentStatus === 'REFUNDED' && (await paidBack(o1.id)) === money(o1.total), { back: await paidBack(o1.id), total: o1.total });
    // a second cancel must not put the stock back again
    await cancelAdmin(o1.id);
    check('stock is restored once per order (a repeated cancel changes nothing)', (await stockOf(P('FB-D-001').id)) === milk0);

    // the last eggs: two customers at once
    section('E2. the last eggs (concurrency)');
    await api('POST', '/restaurant/menu/stock', S.owner, { updates: [{ sku: 'FB-D-002', stockQty: 3 }] });
    r = await setCart(restId, [{ menuItemId: P('FB-D-002').id, quantity: 2 }, { menuItemId: P('FB-PA-002').id, quantity: 8 }]);
    check('the cart for the race is valid', r.s < 300, r);
    const c2 = await login('customer2@demo.forksy.ca', DEMO_PASSWORD, 'customer');
    const addr2 = (await api('GET', '/customer/addresses', c2.accessToken)).j;
    const addr2Id = (Array.isArray(addr2) ? addr2 : addr2.data).find((a) => a.isDefault).id;
    await api('POST', '/customer/cart/replace', c2.accessToken, { restaurantId: restId, items: [{ menuItemId: P('FB-D-002').id, quantity: 2 }, { menuItemId: P('FB-PA-002').id, quantity: 8 }] });
    const both = await Promise.all([
      api('POST', '/customer/orders', S.c1, { ...quoteBody(), paymentMethod: 'CARD', paymentToken: 'pm_mock', dropoffMethod: 'HAND_TO_ME' }),
      api('POST', '/customer/orders', c2.accessToken, { type: 'DELIVERY', addressId: addr2Id, tip: 2, paymentMethod: 'CARD', paymentToken: 'pm_mock', dropoffMethod: 'HAND_TO_ME' }),
    ]);
    both.forEach((x) => x.j?.id && placed.push(x.j.id));
    const okOnes = both.filter((x) => x.s < 300);
    const refused = both.filter((x) => x.s >= 400);
    check('two customers each want 2 of the last 3 eggs: exactly one order is placed', okOnes.length === 1 && refused.length === 1, both.map((x) => x.s + ':' + (x.j?.code || x.j?.message || '')));
    check('the other is refused with INSUFFICIENT_STOCK', refused[0]?.j?.code === 'INSUFFICIENT_STOCK', refused[0]?.j);
    check('only 2 eggs left the shelf (never negative)', (await stockOf(P('FB-D-002').id)) === 1, await stockOf(P('FB-D-002').id));
    if (okOnes[0]) await cancelAdmin(okOnes[0].j.id);
    check('cancelled: the eggs are back (3)', (await stockOf(P('FB-D-002').id)) === 3, await stockOf(P('FB-D-002').id));

    // ============================================================ F. picking
    section('F. picking: weights, out of stock, replacements');
    await api('POST', '/restaurant/menu/stock', S.owner, { updates: [{ sku: 'FB-D-002', stockQty: 3 }] });
    r = await setCart(restId, [
      { menuItemId: P('FB-P-001').id, quantity: 2 }, // bananas 1 kg
      { menuItemId: P('FB-M-001').id, quantity: 2 }, // chicken 1 kg
      { menuItemId: P('FB-D-002').id, quantity: 1, substitution: 'REFUND' }, // eggs: refund only
      { menuItemId: P('FB-B-004').id, quantity: 1 }, // croissants: replacement allowed
      { menuItemId: P('FB-D-001').id, quantity: 1 }, // milk
    ]);
    r = await place();
    check('picking order placed', r.s < 300 && r.j.id, r);
    const o2 = r.j;
    const accepted = await waitFor(async () => ['ACCEPTED', 'PREPARING'].includes((await adminOrder(o2.id)).status), 20000);
    check('the store accepted it automatically', !!accepted);
    const portal = async () => (await api('GET', `/restaurant/orders/${o2.id}`, S.owner)).j.order;
    let po = await portal();
    const line = (sku) => po.items.find((i) => i.sku === sku);
    const paid = money(po.total);
    const pick = (sku, body) => api('POST', `/restaurant/orders/${o2.id}/items/${line(sku).id}/pick`, S.owner, body);

    const touched0 = po.updatedAt;
    r = await pick('FB-P-001', { status: 'PICKED' });
    check('a weighed product needs its weight (400)', r.s === 400, r);
    r = await pick('FB-P-001', { status: 'PICKED', actualWeight: 0.9 });
    await sleep(300);
    po = await portal();
    check('every picking step touches the order (the screens refresh an order when its updatedAt moves)', po.updatedAt !== touched0, { before: touched0, after: po.updatedAt });
    check('weighed lighter than ordered (0.9 kg of ~1 kg): picked, 10% of the line refunded', r.s < 300 && (await refundsOf(o2.id)).some((x) => x.reasonCode === 'WEIGHT_ADJUSTMENT' && x.amount === 0.22), await refundsOf(o2.id));
    po = await portal();
    check('...the line shows the weight and what was given back', Number(line('FB-P-001').actualWeight) === 0.9 && money(line('FB-P-001').adjustmentRefund) === 0.22 && line('FB-P-001').pickStatus === 'PICKED');
    r = await pick('FB-P-001', { status: 'PICKED', actualWeight: 1.3 });
    check('weighed heavier than the estimate after a refund: a weight cannot be raised again (409)', r.s === 409, r);
    r = await pick('FB-M-001', { status: 'PICKED', actualWeight: 1.25 });
    check('weighed heavier than ordered (1.25 of ~1 kg): the customer is charged for the estimate only, nothing more is taken, nothing refunded', r.s < 300 && !(await refundsOf(o2.id)).some((x) => x.amount > 0.22) && money(line('FB-M-001').adjustmentRefund) === 0, await refundsOf(o2.id));
    r = await pick('FB-D-002', { status: 'REPLACED', replacementItemId: P('FB-D-004').id });
    check('a replacement is refused when the customer wanted a refund instead (400)', r.s === 400, r);
    r = await pick('FB-D-002', { status: 'OUT_OF_STOCK' });
    check('out of stock: the line is removed and refunded at once', r.s < 300 && (await refundsOf(o2.id)).some((x) => x.reasonCode === 'MISSING_ITEM' && x.amount === 4.79), await refundsOf(o2.id));
    check('...and the shelf shows it as sold out for everyone', (await stockOf(P('FB-D-002').id)) === 0 && (await api('GET', `/public/stores/${SUPER}/catalog?q=eggs`)).j.data[0]?.available === false);
    r = await pick('FB-B-004', { status: 'REPLACED', replacementItemId: P('FB-B-004').id });
    check('a product cannot replace itself (400)', r.s === 400, r);
    r = await pick('FB-B-004', { status: 'REPLACED', replacementItemId: P('FB-B-003').id });
    check('replaced (croissants 5.49 -> bagels 3.99): the customer pays the LOWER price, the difference is refunded', r.s < 300 && (await refundsOf(o2.id)).some((x) => x.reasonCode === 'SUBSTITUTION_PRICE_DIFFERENCE' && x.amount === 1.5), await refundsOf(o2.id));
    po = await portal();
    check('...the line records the replacement; stock moved (bagels -1, croissants 0)', line('FB-B-004').pickStatus === 'REPLACED' && line('FB-B-004').replacement?.name === 'Plain Bagels' && (await stockOf(P('FB-B-004').id)) === 0, line('FB-B-004'));
    r = await pick('FB-D-001', { status: 'PICKED' });
    check('a piece product is simply picked', r.s < 300 && !(await refundsOf(o2.id)).some((x) => x.amount === 5.49));
    r = await pick('FB-D-001', { status: 'OUT_OF_STOCK' });
    check('...and can still be marked out of stock afterwards (damaged on the way to the bag): refunded', r.s < 300 && (await refundsOf(o2.id)).some((x) => x.reasonCode === 'MISSING_ITEM' && x.amount === 5.49), await refundsOf(o2.id));
    const cd = await orderOf(o2.id);
    check('the customer sees where picking is (2 picked, 1 replaced, 2 out of stock, none pending) and the removed lines stay on the order', cd.picking?.picked === 2 && cd.picking.replaced === 1 && cd.picking.outOfStock === 2 && cd.picking.pending === 0 && cd.items.filter((i) => i.removed).length === 2, cd.picking);
    const tr = (await api('GET', `/orders/${o2.id}/tracking`, S.c1)).j;
    check('tracking lists removed lines with their refund, never to the driver', Array.isArray(tr.removedItems) && tr.removedItems.some((x) => x.name === 'Large White Eggs' && x.refunded > 0) && tr.picking?.replaced === 1 && tr.statusLabel, { removed: tr.removedItems, picking: tr.picking });
    const ev = await notifs(o2.id, S.c1id);
    check('the customer was told (weight, out of stock, replacement)', ['order.weight_adjusted', 'order.item_out_of_stock', 'order.item_replaced'].every((e) => ev.includes(e)), ev);
    const sum = await refundSum(o2.id);
    check('the refunds add up exactly: 0.22 weight + 4.79 eggs + 1.50 replacement + 5.49 milk = 12.00', sum === 12, { sum, paid });
    r = await api('POST', `/restaurant/orders/${o2.id}/items/${line('FB-M-001').id}/pick`, S.c1, { status: 'PICKED', actualWeight: 1 });
    check('a customer cannot pick', r.s === 401 || r.s === 403, r.s);
    await cancelAdmin(o2.id);
    const after = await orderOf(o2.id);
    check('cancelling afterwards refunds only what is left: in total the customer gets back exactly what was paid', after.paymentStatus === 'REFUNDED' && (await paidBack(o2.id)) === paid, { status: after.paymentStatus, back: await paidBack(o2.id), paid });
    check('...bananas and chicken (picked) went back on the shelf; the eggs, milk and croissants that were found missing did not', (await stockOf(P('FB-P-001').id)) > 0 && (await stockOf(P('FB-D-002').id)) === 0 && (await stockOf(P('FB-B-004').id)) === 0, { eggs: await stockOf(P('FB-D-002').id), croissants: await stockOf(P('FB-B-004').id) });

    // ============================================================ G. everything out of stock
    section('G. every product out of stock');
    await api('POST', '/restaurant/menu/stock', S.owner, { updates: [{ sku: 'FB-D-002', stockQty: 3 }, { sku: 'FB-B-004', stockQty: 12 }, { sku: 'FB-D-001', stockQty: milk0 }] });
    r = await setCart(restId, [{ menuItemId: P('FB-D-002').id, quantity: 1 }, { menuItemId: P('FB-PA-006').id, quantity: 4 }]);
    check('cart for the empty-order case is valid', r.s < 300, r);
    r = await place();
    const o3 = r.j;
    check('small order placed', r.s < 300 && o3.id, r);
    await waitFor(async () => ['ACCEPTED', 'PREPARING'].includes((await adminOrder(o3.id)).status), 20000);
    const items3 = (await api('GET', `/restaurant/orders/${o3.id}`, S.owner)).j.order.items;
    for (const it of items3) r = await api('POST', `/restaurant/orders/${o3.id}/items/${it.id}/pick`, S.owner, { status: 'OUT_OF_STOCK' });
    const fin = await orderOf(o3.id);
    check('when every product is out of stock the empty order is cancelled', fin.status === 'CANCELLED', fin.status);
    check('...and the customer got everything back (paid back in total = paid)', fin.paymentStatus === 'REFUNDED' && (await paidBack(o3.id)) === money(o3.total), { s: fin.paymentStatus, back: await paidBack(o3.id), total: o3.total });

    // ============================================================ H. the ID check at the door
    section('H. ID check at hand-over');
    const drv = await login('driver6@demo.forksy.ca', DEMO_PASSWORD, 'driver');
    const dTok = drv.accessToken;
    const ping = (lat, lng) => api('POST', '/driver/location', dTok, { lat, lng });
    const rest = (await api('GET', `/public/stores/${SUPER}`)).j.restaurant;
    await api('POST', '/driver/online', dTok, {});
    await api('PUT', '/admin/settings', S.admin, { values: { 'orders.customerCancelGraceSeconds': 0 } });
    async function deliverOrder(label, sku, finalBody) {
      await api('POST', '/restaurant/menu/stock', S.owner, { updates: [{ sku: 'FB-A-001', stockQty: 24 }] });
      await setCart(restId, [{ menuItemId: P('FB-A-001').id, quantity: 1 }, { menuItemId: P(sku).id, quantity: 1 }]);
      const pr = await place({ ageConfirmed: true });
      check(`${label}: order with beer placed (ID check required)`, pr.s < 300 && pr.j.requiresIdCheck === true && pr.j.minAge === 19 && pr.j.ageConfirmed === true, pr);
      const o = pr.j;
      await waitFor(async () => ['ACCEPTED', 'PREPARING'].includes((await adminOrder(o.id)).status), 20000);
      let a;
      for (let k = 0; k < 4; k++) { // the automation may change the status at the same moment (409): try again
        a = await api('POST', `/admin/orders/${o.id}/reassign-driver`, S.admin, { driverId: drv.user.driverId, reason: 'store-types-e2e' });
        if (a.s !== 409) break;
        await sleep(1500);
      }
      check(`${label}: a driver is assigned`, a.s < 300, a);
      check(`${label}: the kitchen starts preparing (the automation checks every 15 s)`, !!(await waitFor(async () => (await adminOrder(o.id)).status === 'PREPARING', 40000, 1500)));
      const rd = await api('POST', `/restaurant/orders/${o.id}/ready`, S.owner);
      check(`${label}: the store marks it ready`, rd.s < 300, rd);
      await ping(rest.address.lat, rest.address.lng);
      const ar = await api('POST', `/driver/trip/${o.id}/arrived-restaurant`, dTok, { lat: rest.address.lat, lng: rest.address.lng });
      check(`${label}: the driver arrives at the store`, ar.s < 300, ar);
      const co = await orderOf(o.id);
      const pk = await api('POST', `/driver/trip/${o.id}/picked-up`, dTok, { code: String(co.pickupCode) });
      check(`${label}: the driver picks it up`, pk.s < 300, pk);
      const D = { lat: co.deliveryAddress.lat, lng: co.deliveryAddress.lng };
      await ping(D.lat, D.lng);
      const ac = await api('POST', `/driver/trip/${o.id}/arrived-customer`, dTok, { lat: D.lat, lng: D.lng });
      check(`${label}: the driver arrives at the customer`, ac.s < 300, ac);
      const trip = (await api('GET', `/orders/${o.id}/tracking`, dTok)).j;
      check(`${label}: the driver app is told an ID check is needed (minAge)`, trip.idCheck?.required === true && trip.idCheck.minAge === 19 && trip.basket?.units === 2, trip.idCheck);
      const blind = await api('POST', `/driver/trip/${o.id}/delivered`, dTok, { pin: co.deliveryPin, lat: D.lat, lng: D.lng });
      check(`${label}: delivering without checking ID is refused (400 ID_CHECK_REQUIRED)`, blind.s === 400 && blind.j?.code === 'ID_CHECK_REQUIRED', blind);
      const both = await api('POST', `/driver/trip/${o.id}/delivered`, dTok, { pin: co.deliveryPin, lat: D.lat, lng: D.lng, idChecked: true, idRefused: true });
      check(`${label}: idChecked and idRefused together are refused (400)`, both.s === 400, both);
      const fin = await api('POST', `/driver/trip/${o.id}/delivered`, dTok, { pin: co.deliveryPin, lat: D.lat, lng: D.lng, ...finalBody });
      return { o, fin, co };
    }
    const beerStock0 = 24;
    const ok = await deliverOrder('ID shown', 'FB-D-001', { idChecked: true });
    check('ID shown: delivered, nothing removed, nothing refunded', ok.fin.s < 300 && ok.fin.j?.status === 'DELIVERED' && (await refundsOf(ok.o.id)).length === 0, ok.fin);
    const okOrder = await orderOf(ok.o.id);
    check('...the proof records the ID check', okOrder.idCheck?.result === 'CHECKED' && okOrder.items.every((i) => !i.removed), okOrder.idCheck);
    check('...and the beer stays sold: stock is 23', (await stockOf(P('FB-A-001').id)) === beerStock0 - 1, await stockOf(P('FB-A-001').id));
    const no = await deliverOrder('ID refused', 'FB-D-001', { idRefused: true });
    check('ID refused: the order is still DELIVERED (the milk is handed over)', no.fin.s < 300 && no.fin.j?.status === 'DELIVERED', no.fin);
    const noOrder = await orderOf(no.o.id);
    const beerLine = noOrder.items.find((i) => i.sku === 'FB-A-001');
    check('...the beer was NOT handed over: removed, flagged and refunded with tax', beerLine.removed === true && beerLine.idRefused === true && money(beerLine.adjustmentRefund) === money(14.95 * 1.13) && (await refundsOf(no.o.id)).some((x) => x.reasonCode === 'ID_CHECK_FAILED' && x.amount === money(14.95 * 1.13)), { line: beerLine, refunds: await refundsOf(no.o.id) });
    check('...the milk is not refunded', !noOrder.items.find((i) => i.sku === 'FB-D-001').removed);
    check('...the beer goes back on the shelf (24 again: it was taken at checkout and returned)', (await stockOf(P('FB-A-001').id)) === beerStock0, await stockOf(P('FB-A-001').id));
    check('...the customer was told', (await notifs(no.o.id, S.c1id)).includes('order.id_check_failed'));
    check('...the timeline records it', (await api('GET', `/orders/${no.o.id}/tracking`, S.c1)).j.timeline.some((e) => e.type === 'ID_CHECK_REFUSED'));

    // ============================================================ I. onboarding and administration by store type
    section('I. store types in onboarding and administration');
    const tag = Math.random().toString(36).slice(2, 8);
    const created = [];
    const mk = (name, storeType, extra = {}) => api('POST', '/admin/restaurants', S.admin, { name, storeType, merchant: { businessName: name + ' Ltd' }, addressLine1: '1 Test St', city: 'Mississauga', postalCode: 'L5B 1M2', lat: 43.5925, lng: -79.6428, ...extra });
    r = await mk(`E2E Grocer ${tag}`, 'GROCERY');
    const g = r.j?.restaurant;
    created.push(g?.id);
    check('admin creates a GROCERY store: it starts with grocery defaults (30 min picking, $20 minimum, no kitchen display, 8 km)', r.s < 300 && g?.storeType === 'GROCERY' && g.prepTimeMin === 30 && Number(g.minimumOrder) === 20 && g.kdsEnabled === false && Number(g.deliveryRadiusKm) === 8, r);
    check('...and no tier of its own: the grocery tier applies when an order is priced', g?.commissionTierId == null, g?.commissionTierId);
    r = await mk(`E2E Bistro ${tag}`, undefined);
    const bi = r.j?.restaurant;
    created.push(bi?.id);
    check('a store created without a type is a RESTAURANT with the old defaults (20 min, kitchen display on)', bi?.storeType === 'RESTAURANT' && bi.prepTimeMin === 20 && bi.kdsEnabled === true && bi.commissionTierId, bi);
    r = await mk(`E2E Bakery ${tag}`, 'BAKERY');
    created.push(r.j?.restaurant?.id);
    check('a BAKERY is food service (kitchen display on, 15 min)', r.j?.restaurant?.storeType === 'BAKERY' && r.j.restaurant.kdsEnabled === true && r.j.restaurant.prepTimeMin === 15, r.j?.restaurant);
    r = await mk(`E2E Bad ${tag}`, 'SPACESHIP');
    check('an unknown store type is refused (400)', r.s === 400, r);
    r = await api('GET', `/admin/restaurants?storeType=GROCERY&limit=100`, S.admin);
    check('admin list filter: storeType=GROCERY', r.j.data.some((x) => x.id === g.id) && r.j.data.every((x) => x.storeType === 'GROCERY') && !r.j.data.some((x) => x.id === bi.id), r.j.data.map((x) => x.name + ':' + x.storeType));
    r = await api('GET', `/admin/restaurants?vertical=RETAIL&limit=100`, S.admin);
    check('admin list filter: vertical=RETAIL (grocery, convenience, specialty)', r.j.data.length >= 5 && r.j.data.every((x) => ['GROCERY', 'CONVENIENCE', 'SPECIALTY'].includes(x.storeType)), r.j.data.map((x) => x.storeType));
    r = await api('PATCH', `/admin/restaurants/${g.id}`, S.admin, { storeType: 'SPECIALTY' });
    check('admin changes the type of a store (GROCERY -> SPECIALTY)', r.s < 300 && r.j.storeType === 'SPECIALTY', r);
    r = await api('PATCH', `/admin/restaurants/${g.id}`, S.admin, { storeType: 'NOPE' });
    check('...an unknown type is refused (400)', r.s === 400, r);
    r = await api('PATCH', '/restaurant/store', S.owner, { storeType: 'RESTAURANT' });
    check('a store owner cannot change the store type (400: it changes documents, commission and behaviour)', r.s === 400, r);
    check('(the supermarket is still a GROCERY after all that)', (await api('GET', `/public/stores/${SUPER}`)).j.restaurant.storeType === 'GROCERY');

    // sign-up as a grocery store: the documents asked for depend on the type
    const rnd = Math.random().toString(36).slice(2, 8);
    r = await api('POST', '/auth/restaurant/apply', null, {
      ownerFirstName: 'Gro', ownerLastName: 'Cer', email: `grocer.${rnd}@example.com`, phone: `+1647${String(Math.floor(1000000 + Math.random() * 8999999))}`, password: 'Str0ng!Passw0rd#e2e',
      businessName: `E2E Apply Grocer ${rnd}`, restaurantName: `E2E Apply Grocer ${rnd}`, addressLine1: '1 City Centre Dr', city: 'Mississauga', postalCode: 'L5B 1M2', storeType: 'GROCERY',
    });
    const applied = r.j;
    check('a grocery store can apply on its own (sign-up with storeType GROCERY)', r.s < 300 && !!applied?.accessToken && !!applied.restaurantId, r);
    if (applied?.accessToken) {
      created.push(applied.restaurantId);
      const cl = (await api('GET', '/restaurant/store/documents/checklist', applied.accessToken)).j;
      const types = (cl.items ?? []).map((i) => i.type);
      check('its document checklist asks for a food premises permit and no health certificate (retail list)', types.includes('FOOD_PREMISES_PERMIT') && types.includes('BUSINESS_LICENCE') && !types.includes('HEALTH_CERTIFICATE'), types);
      const adm = (await api('GET', `/admin/restaurants/${applied.restaurantId}`, S.admin)).j;
      check('the application shows its type to the admin', (adm.restaurant ?? adm).storeType === 'GROCERY', (adm.restaurant ?? adm).storeType);
    }
    const clSuper = (await api('GET', '/restaurant/store/documents/checklist', S.owner)).j;
    const superTypes = (clSuper.items ?? []).map((i) => i.type);
    check('a store that lists age-restricted products also needs the licence for them (approved in the demo)', superTypes.includes('LIQUOR_LICENCE') && clSuper.items.find((i) => i.type === 'LIQUOR_LICENCE').status === 'APPROVED' && clSuper.allApproved === true, clSuper);

    // the commission tier made for retail applies to a store without a tier of its own
    const rowT = (await sql(`SELECT r.id, r."commissionTierId" FROM restaurants r WHERE r.slug = $1`, [ASIAN]))[0];
    await api('PATCH', `/admin/restaurants/${rowT.id}/commission`, S.admin, { commissionTierId: null });
    const asianPage = (await api('GET', `/public/stores/${ASIAN}`)).j;
    const aMenu = (await skuMap(ASIAN)).get('SA-R-001');
    // price a basket at the Asian market for pickup (no delivery range needed) as customer 1
    await api('POST', '/customer/cart/replace', S.c1, { restaurantId: asianPage.restaurant.id, items: [{ menuItemId: aMenu.id, quantity: 2 }] });
    r = await api('POST', '/customer/checkout/quote', S.c1, { type: 'PICKUP' });
    check('a retail store without a tier of its own is priced on the grocery tier (12% delivery / 4% pickup)', r.s < 300 && r.j.commissionPct === 4, r.j?.commissionPct);
    await api('PATCH', `/admin/restaurants/${rowT.id}/commission`, S.admin, { commissionTierId: rowT.commissionTierId });
    r = await api('POST', '/customer/checkout/quote', S.c1, { type: 'PICKUP' });
    check('the tier it was given explicitly wins again once set', r.s < 300 && r.j.commissionPct === 4, r.j?.commissionPct);
    await api('POST', '/customer/cart/clear', S.c1).catch(() => undefined);
    await api('DELETE', '/customer/cart', S.c1).catch(() => undefined);
    // a restaurant is still priced on the standard tier
    await api('POST', '/customer/cart/replace', S.c1, { restaurantId: restoId, items: [{ menuItemId: dish.id, quantity: 1 }] });
    r = await api('POST', '/customer/checkout/quote', S.c1, { type: 'PICKUP' });
    check('a restaurant is still priced on its own tier (pickup 8%)', r.s < 300 && r.j.commissionPct === 8, r.j?.commissionPct);
    await api('DELETE', '/customer/cart', S.c1).catch(() => undefined);
    // tidy: the stores this section made are rejected (hidden from customers)
    for (const id of created.filter(Boolean)) await api('POST', `/admin/restaurants/${id}/reject`, S.admin, { reason: 'store-types-e2e cleanup' });
  } finally {
    // ------------------------------------------------------------ restore everything this run changed
    for (const id of placed) { try { const st = await adminOrder(id); if (st?.status && !['DELIVERED', 'CANCELLED', 'REJECTED', 'COLLECTED'].includes(st.status)) await cancelAdmin(id); } catch { /* best effort */ } }
    for (const [id, row] of stockBefore) await pg.query(`UPDATE menu_items SET "stockQty" = $2, "trackStock" = $3 WHERE id = $1`, [id, row.stockQty, row.trackStock]).catch(() => undefined);
    await api('PUT', '/admin/settings', S.admin, { values: { 'orders.customerCancelGraceSeconds': origGrace } });
    await pg.end();
  }
  const fails = results.filter((x) => !x.ok);
  console.log(`\nSUMMARY ${results.length - fails.length}/${results.length} passed`);
  fails.forEach((x) => console.log('  FAILED:', x.name));
  process.exit(fails.length ? 1 : 0);
}
main().catch((e) => { console.error('CRASH', e); process.exit(1); });
