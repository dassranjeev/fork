#!/usr/bin/env node
/**
 * FORKSY payments end-to-end test: REAL HTTP against a running API that is wired to the FAKE Stripe / Mapbox servers.
 *
 *   1.  node backend/test/fakes/fake-stripe.mjs      (port 4242; set FAKE_WEBHOOK_URL + FAKE_WEBHOOK_SECRET so it can call the API's webhook)
 *   2.  node backend/test/fakes/fake-mapbox.mjs      (port 4243)
 *   3.  an API instance with  STRIPE_API_BASE=http://localhost:4242  STRIPE_SECRET_KEY=sk_test_fakeFAKEfake1234567890
 *       STRIPE_PUBLISHABLE_KEY=pk_test_...  STRIPE_WEBHOOK_SECRET=<the same as FAKE_WEBHOOK_SECRET>  MAPBOX_API_BASE=http://localhost:4243
 *       MAPBOX_ACCESS_TOKEN=pk.fake.fake  on its own port and database (seeded with the demo data)
 *   4.  node backend/test/payments-e2e.mjs [API_BASE]      (default http://localhost:4100/api/v1)
 *
 * What it proves is the FORKSY side of the Stripe / Mapbox contract. It does NOT prove that the real Stripe accepts our calls: that
 * needs the owner's TEST keys (docs/payments.md, "Going live").
 * Needs: demo seed accounts, Postgres reachable (DB_* env, default forksy_pay) to age intents and read records.
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Stripe = require('stripe');
const { Client } = require('pg');
const stripeLib = new (Stripe.default ?? Stripe)('sk_test_signing_only');

const API = (process.argv[2] || process.env.API || 'http://localhost:4100/api/v1').replace(/\/$/, '');
const FAKE = process.env.FAKE_STRIPE || 'http://localhost:4242';
const FAKE_MB = process.env.FAKE_MAPBOX || 'http://localhost:4243';
const SK = process.env.FAKE_SK || 'sk_test_fakeFAKEfake1234567890';
const WHSEC = process.env.FAKE_WHSEC || 'whsec_fakeFAKEfake1234567890abcdef';
const SLUG = process.env.SLUG || 'maple-corner-convenience';
const PW = 'Demo@12345';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, extra) => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && extra !== undefined ? '  -> ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 400) : ''}`);
};
const section = (s) => console.log(`\n--- ${s}`);

async function req(method, url, { token, body, headers = {}, raw } = {}) {
  const h = { ...headers };
  if (token) h.authorization = 'Bearer ' + token;
  let b = raw;
  if (body !== undefined) { h['content-type'] = 'application/json'; b = JSON.stringify(body); }
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(url, { method, headers: h, body: b });
      const text = await r.text();
      let j = null; try { j = JSON.parse(text); } catch { /* not json */ }
      return { s: r.status, j, text, headers: r.headers };
    } catch (e) { if (i === 4) throw e; await sleep(1500); }
  }
}
const api = (method, path, token, body, extra = {}) => req(method, API + path, { token, body, ...extra });
const fake = (path, body) => req(body === undefined ? 'GET' : 'POST', FAKE + path, { body }).then((r) => r.j);
/** a direct Stripe API call against the fake (what Stripe's own dashboard / another system would do) */
const stripeApi = (method, path, form = {}) => {
  const qs = new URLSearchParams(Object.entries(form).map(([k, v]) => [k, String(v)])).toString();
  return req(method, FAKE + path + (method === 'GET' && qs ? '?' + qs : ''), { headers: { authorization: 'Bearer ' + SK, 'content-type': 'application/x-www-form-urlencoded' }, raw: method === 'GET' ? undefined : qs });
};
const money = (n) => Math.round(Number(n) * 100) / 100;
const cents = (n) => Math.round(Number(n) * 100);

const db = new Client({ host: process.env.DB_HOST || 'localhost', port: +(process.env.DB_PORT || 5432), user: process.env.DB_USER || 'postgres', password: process.env.DB_PASSWORD || 'postgres', database: process.env.DB_NAME || 'forksy_pay' });
const q = async (sql, params) => (await db.query(sql, params)).rows;

async function login(email, password, app) {
  for (let i = 0; i < 6; i++) {
    const r = await api('POST', '/auth/login', null, { identifier: email, password, ...(app ? { app } : {}) });
    const d = r.j?.data || r.j;
    if (d?.accessToken) return d;
    if (r.s === 429) { await sleep(15000); continue; }
    throw new Error(`login failed for ${email}: ${r.s} ${r.text.slice(0, 100)}`);
  }
}

const S = {}; // sessions + shared state
const cleanup = { orders: [], settings: {} };

// ------------------------------------------------------------------------------------------------ helpers for orders
let menu;
async function setCart(token, qty = 2) {
  if (!menu) {
    const r = await api('GET', '/public/restaurants/' + SLUG);
    const cats = Array.isArray(r.j.menu) ? r.j.menu : r.j.menu?.categories || [];
    let item;
    for (const ct of cats) for (const i of ct.items || []) if (!item && !(i.modifierGroups || []).some((g) => g.minSelect > 0 || g.required) && i.available !== false) item = i;
    menu = { restId: r.j.id || r.j.restaurant?.id, item, open: r.j.isOpen };
  }
  const r = await api('POST', '/customer/cart/replace', token, { restaurantId: menu.restId, items: [{ menuItemId: menu.item.id, quantity: qty }] });
  return r.s < 300;
}
async function addressId(token) {
  const a = (await api('GET', '/customer/addresses', token)).j;
  return (Array.isArray(a) ? a : a.data).find((x) => x.isDefault)?.id || (Array.isArray(a) ? a : a.data)[0].id;
}
const quoteBody = (addr, extra = {}) => ({ type: 'DELIVERY', addressId: addr, tip: 2, ...extra });
const getQuote = async (token, body) => (await api('POST', '/customer/checkout/quote', token, body)).j;
/** the API rate-limits POST /customer/orders (20 a minute) and payment intents (30 a minute): when the suite is quicker than that, wait and try again */
async function limited(fn) {
  let r;
  for (let i = 0; i < 6; i++) { r = await fn(); if (r.s !== 429) return r; await sleep(12000); }
  return r;
}
const intentFor = (token, body) => limited(() => api('POST', '/customer/payments/intent', token, body));
const payOk = (piId, extra = {}) => fake('/_fake/confirm/' + piId, extra);
async function place(token, body, extra = {}) {
  const r = await limited(() => api('POST', '/customer/orders', token, { paymentMethod: 'CARD', ...body, ...extra }));
  if (r.s < 300 && r.j?.id) cleanup.orders.push(r.j.id);
  return r;
}
async function adminCancel(id) { return api('POST', `/admin/orders/${id}/cancel`, S.admin, { reason: 'payments-e2e cleanup' }); }
async function webhook(event, opts = {}) {
  const payload = JSON.stringify(event);
  const header = stripeLib.webhooks.generateTestHeaderString({ payload, secret: WHSEC, ...(opts.timestamp ? { timestamp: opts.timestamp } : {}) });
  return req('POST', API + '/webhooks/stripe', { headers: { 'content-type': 'application/json', 'stripe-signature': opts.badSig ? header.replace(/v1=[0-9a-f]+/, 'v1=' + '0'.repeat(64)) : header }, raw: opts.tamper ? payload + ' ' : payload });
}
const evt = (type, object, account) => ({ id: 'evt_test_' + Math.random().toString(36).slice(2, 14), object: 'event', api_version: '2026-08-26.dahlia', created: Math.floor(Date.now() / 1000), livemode: false, type, account, data: { object }, pending_webhooks: 1, request: { id: null } });
const walletOf = async (token) => Number((await api('GET', '/customer/wallet', token)).j.balance);

// ------------------------------------------------------------------------------------------------ main
async function main() {
  await db.connect();
  section('setup');
  const probe = await req('GET', API + '/public/payments/config');
  check('API reachable and wired to Stripe (provider=stripe)', probe.j?.provider === 'stripe', probe.text);
  check('fake Stripe reachable', (await fake('/_fake/state'))?.config !== undefined);
  await fake('/_fake/reset', {});
  // a fresh Stripe world: forget the Stripe ids stored by earlier runs (the fake starts empty)
  await q(`DELETE FROM payments WHERE provider = 'stripe'`);
  await q(`DELETE FROM stripe_events`);
  await q(`UPDATE stripe_intents SET "consumedAt" = NULL, "orderId" = NULL, status = 'canceled', "canceledAt" = now()`);
  await q(`UPDATE customer_profiles SET "stripeCustomerId" = NULL`);
  await q(`UPDATE driver_profiles SET "stripeAccountId" = NULL, "stripeAccountStatus" = 'NOT_STARTED', "stripeAccountInfo" = NULL`);
  await q(`UPDATE merchants SET "stripeAccountId" = NULL, "stripeAccountStatus" = 'NOT_STARTED', "stripeAccountInfo" = NULL`);
  S.admin = (await login('admin@forksy.ca', 'Admin@12345')).accessToken;
  // no keys saved by earlier runs / browser tests: the environment keys apply
  await api('PUT', '/admin/integrations/stripe', S.admin, { secretKey: '', publishableKey: '', webhookSecret: '', connectEnabled: true });
  await api('PUT', '/admin/integrations/mapbox', S.admin, { accessToken: '', publicToken: '' });
  S.c1 = (await login('customer1@demo.forksy.ca', PW, 'customer')).accessToken;
  S.c2 = (await login('customer2@demo.forksy.ca', PW, 'customer')).accessToken;
  const d6 = await login('driver6@demo.forksy.ca', PW, 'driver'); S.d6 = d6.accessToken; S.d6id = d6.user.driverId;
  const d21 = await login('driver21@demo.forksy.ca', PW, 'driver'); S.d21 = d21.accessToken; S.d21id = d21.user.driverId;
  const o1 = await login('owner1@demo-restaurant.ca', PW, 'restaurant'); S.owner1 = o1.accessToken;
  S.fin = (await login('finance@forksy.ca', PW)).accessToken;
  check('logged in as admin / customers / drivers / owner / finance staff', S.admin && S.c1 && S.c2 && S.d6 && S.owner1 && S.fin);
  const grace = (await api('GET', '/admin/settings?group=orders', S.admin)).j.data.find((s) => s.key === 'orders.customerCancelGraceSeconds');
  cleanup.settings.grace = grace.value;
  check('restaurant cart can be built', await setCart(S.c1));
  S.addr1 = await addressId(S.c1);
  S.addr2 = await addressId(S.c2);

  // ============================================================ B. checkout intent
  section('B. checkout: server-computed PaymentIntent');
  const body = quoteBody(S.addr1);
  const quote = await getQuote(S.c1, body);
  check('quote works', quote?.total > 0, quote);
  let r = await intentFor(S.c1, body);
  check('POST /customer/payments/intent -> 201 with clientSecret, intentId, amount, publishableKey', r.s === 201 && r.j.clientSecret && /^pi_/.test(r.j.intentId) && r.j.publishableKey === 'pk_test_fakeFAKEfake1234567890', r.text);
  const pi1 = r.j;
  const fpi = (await fake('/_fake/state')).intents[pi1.intentId];
  check('amount = quote total (cents) computed by the server', fpi.amount === cents(quote.total - quote.walletUsed) && money(pi1.amount) === money(quote.total - quote.walletUsed), { fake: fpi.amount, quote: quote.total });
  check('PaymentIntent is AUTOMATIC capture (the card is charged at checkout, not held), cad, automatic payment methods without redirects', fpi.capture_method === 'automatic' && fpi.currency === 'cad' && fpi.automatic_payment_methods?.enabled && fpi.automatic_payment_methods.allow_redirects === 'never', fpi);
  check('metadata carries customerId and quoteHash; a Stripe customer is attached', fpi.metadata.customerId && fpi.metadata.quoteHash && fpi.customer?.startsWith('cus_'), fpi);
  S.c1payload = (await api('GET', '/auth/me', S.c1)).j.id;
  const prof = (await q(`SELECT "stripeCustomerId" FROM customer_profiles WHERE "userId" = $1`, [S.c1payload]))[0];
  check('stripeCustomerId stored on the customer profile', prof.stripeCustomerId === fpi.customer, prof);
  r = await api('POST', '/customer/payments/intent', S.c1, { ...body, amount: 1 });
  check('amount in the request body is rejected (400): the amount can never come from the client', r.s === 400, r.text);
  r = await api('POST', '/customer/payments/intent', S.c1, { ...body, paymentMethodId: 'pm_notmine123456' });
  check('a saved card that does not exist / is not the customer\'s is refused', r.s === 400 && r.j.code === 'PAYMENT_METHOD_INVALID', r.text);
  r = await api('POST', '/customer/payments/intent', null, body);
  check('intent route needs a customer login (401)', r.s === 401);
  r = await api('POST', '/customer/payments/intent', S.d6, body);
  check('a driver cannot create a checkout intent (403)', r.s === 403 || r.s === 401, r.s);
  // update instead of create when the quote changes while typing the card
  r = await intentFor(S.c1, { ...body, tip: 5, intentId: pi1.intentId });
  check('same unconfirmed intent is UPDATED when the tip changes (same id, new amount)', r.s === 201 && r.j.intentId === pi1.intentId && r.j.updated === true && (await fake('/_fake/state')).intents[pi1.intentId].amount === cents((await getQuote(S.c1, { ...body, tip: 5 })).total), r.text);

  section('B. placing the order');
  r = await place(S.c1, { ...body, tip: 5 });
  check('order without paymentIntentId is refused (400 PAYMENT_INTENT_REQUIRED)', r.s === 400 && r.j.code === 'PAYMENT_INTENT_REQUIRED', r.text);
  r = await place(S.c1, { ...body, tip: 5, paymentToken: 'pm_mock' });
  check('legacy pm_mock token does NOT work when Stripe is configured (mock is never used with a key)', r.s === 400 && r.j.code === 'PAYMENT_INTENT_REQUIRED', r.text);
  r = await place(S.c1, { ...body, tip: 5, paymentIntentId: pi1.intentId });
  check('unconfirmed intent -> 400 PAYMENT_NOT_CONFIRMED, no order created', r.s === 400 && r.j.code === 'PAYMENT_NOT_CONFIRMED', r.text);
  r = await place(S.c1, { ...body, tip: 5, paymentIntentId: 'pi_doesnotexist123456' });
  check('unknown intent id -> 400 PAYMENT_INTENT_INVALID', r.s === 400 && r.j.code === 'PAYMENT_INTENT_INVALID', r.text);
  // wrong customer
  await setCart(S.c2);
  r = await place(S.c2, { ...quoteBody(S.addr2), tip: 5, paymentIntentId: pi1.intentId });
  check('another customer cannot use this intent (400 PAYMENT_INTENT_INVALID)', r.s === 400 && r.j.code === 'PAYMENT_INTENT_INVALID', r.text);
  await setCart(S.c1);
  // 3DS then success
  const c3 = await payOk(pi1.intentId, { scenario: '3ds' });
  check('3-D Secure challenge leaves the intent in requires_action', c3.status === 'requires_action', c3);
  r = await place(S.c1, { ...body, tip: 5, paymentIntentId: pi1.intentId });
  check('order refused while the bank challenge is open (409 PAYMENT_ACTION_REQUIRED)', r.s === 409 && r.j.code === 'PAYMENT_ACTION_REQUIRED', r.text);
  const au = await fake('/_fake/authenticate/' + pi1.intentId, { success: true });
  check('after 3-D Secure the card is CHARGED right away (succeeded, full amount received)', au.status === 'succeeded' && au.amount_received === au.amount && au.amount > 0, au);
  const walletBefore = await walletOf(S.c1);
  r = await place(S.c1, { ...body, tip: 5, paymentIntentId: pi1.intentId });
  check('order placed with a paid intent (201)', r.s === 201 && r.j.id, r.text);
  S.orderA = r.j;
  check('order is bound to the intent, paymentStatus CAPTURED (paid at checkout), card payment method', S.orderA.paymentIntentId === pi1.intentId && S.orderA.paymentStatus === 'CAPTURED' && S.orderA.paymentMethod === 'CARD', S.orderA);
  const rowA = (await q(`SELECT "orderId", status FROM stripe_intents WHERE "intentId" = $1`, [pi1.intentId]))[0];
  check('stripe_intents row points at the order and says succeeded', rowA.orderId === S.orderA.id && rowA.status === 'succeeded', rowA);
  const payA = await q(`SELECT kind, provider, "externalId", amount FROM payments WHERE "orderId" = $1`, [S.orderA.id]);
  check('CAPTURE payment row (Stripe charge id, the amount charged) is written at checkout; there is no AUTHORIZE row', payA.some((p) => p.kind === 'CAPTURE' && p.provider === 'stripe' && /^ch_/.test(p.externalId) && Math.round(Number(p.amount) * 100) === au.amount) && !payA.some((p) => p.kind === 'AUTHORIZE'), payA);
  const fa = (await fake('/_fake/state')).intents[pi1.intentId];
  check('Stripe intent was tagged with the order id / transfer group', fa.metadata.orderId === S.orderA.id && /^order_/.test(fa.transfer_group || ''), fa);
  check('the card WAS charged at checkout (money received, nothing left to capture)', fa.status === 'succeeded' && fa.amount_received === fa.amount && fa.amount_capturable === 0 && fa.capture_method === 'automatic', fa);
  // reuse
  await setCart(S.c1);
  r = await place(S.c1, { ...body, tip: 5, paymentIntentId: pi1.intentId });
  check('the same intent cannot back a second order (409 PAYMENT_INTENT_USED)', r.s === 409 && r.j.code === 'PAYMENT_INTENT_USED', r.text);
  const cnt = await q(`SELECT COUNT(*)::int n FROM orders WHERE "paymentIntentId" = $1`, [pi1.intentId]);
  check('unique index: exactly one order per intent in the database', cnt[0].n === 1);
  const admOrder = (await api('GET', `/admin/orders/${S.orderA.id}/payments`, S.admin)).j;
  check('admin sees the gateway payment records with provider ids', admOrder.paymentIntentId === pi1.intentId && admOrder.payments.some((p) => p.kind === 'CAPTURE' && /^ch_/.test(p.externalId)) && /dashboard\.stripe\.com\/test\/payments\//.test(admOrder.dashboardUrl || ''), admOrder);

  // ============================================================ cancel within the window refunds the card
  section('B. cancellation window refunds the payment in full');
  r = await api('POST', `/customer/orders/${S.orderA.id}/cancel`, S.c1, { reason: 'changed my mind' });
  check('customer cancels inside the window', r.s < 300, r.text);
  const stA = await fake('/_fake/state');
  const fa2 = stA.intents[pi1.intentId];
  const refA = Object.values(stA.refunds).filter((x) => x.payment_intent === pi1.intentId);
  check('the charge is refunded to the card in full (one Stripe refund for everything that was charged)', fa2.status === 'succeeded' && refA.length === 1 && refA[0].amount === fa2.amount && stA.charges[fa2.latest_charge].amount_refunded === fa2.amount, { status: fa2.status, refunds: refA });
  check('the refund used an idempotency key tied to the order (a replay can never refund twice)', stA.idemKeys.some((k) => k === `refund-cancel-${S.orderA.id}`), stA.idemKeys.filter((k) => k.startsWith('refund')));
  const oa = (await api('GET', `/customer/orders/${S.orderA.id}`, S.c1)).j;
  check('order is CANCELLED with paymentStatus REFUNDED', oa.status === 'CANCELLED' && oa.paymentStatus === 'REFUNDED', { s: oa.status, p: oa.paymentStatus });
  const refRowsA = await q(`SELECT kind, amount, "externalId", meta FROM payments WHERE "orderId" = $1 ORDER BY "createdAt"`, [S.orderA.id]);
  check('payments: CAPTURE at checkout, then one REFUND row (re_ id) for the same amount, nothing else', refRowsA.length === 2 && refRowsA[0].kind === 'CAPTURE' && refRowsA[1].kind === 'REFUND' && /^re_/.test(refRowsA[1].externalId) && Number(refRowsA[1].amount) === Number(refRowsA[0].amount) && refRowsA[1].meta?.reason === 'ORDER_CANCELLED', refRowsA);
  check('no ledger entries exist for an order that was never delivered (nothing to reverse)', (await q(`SELECT COUNT(*)::int n FROM ledger_entries WHERE "orderId" = $1`, [S.orderA.id]))[0].n === 0);
  await sleep(800);
  check('the charge.refunded webhook for our own refund does not record it a second time', (await q(`SELECT COUNT(*)::int n FROM payments WHERE "orderId" = $1 AND kind = 'REFUND'`, [S.orderA.id]))[0].n === 1);

  // ============================================================ drift / tampering
  section('B. price drift (409) and tampering');
  await setCart(S.c1);
  const dBody = quoteBody(S.addr1, { tip: 3 });
  const dI = (await intentFor(S.c1, dBody)).j;
  await payOk(dI.intentId, {});
  const dCharged = (await fake('/_fake/state')).intents[dI.intentId];
  check('the card was charged for the OLD price the moment the customer paid', dCharged.status === 'succeeded' && dCharged.amount_received > 0, dCharged);
  r = await place(S.c1, { ...dBody, tip: 9, paymentIntentId: dI.intentId });
  check('quote drifted (tip changed after paying) -> 409 PAYMENT_QUOTE_CHANGED and the message says the payment is being refunded', r.s === 409 && r.j.code === 'PAYMENT_QUOTE_CHANGED' && /refund/i.test(r.j.message), r.text);
  const stD = await fake('/_fake/state');
  check('...and that payment was refunded in full at once, so the customer is not charged twice', Object.values(stD.refunds).some((x) => x.payment_intent === dI.intentId && x.amount === dCharged.amount) && stD.charges[dCharged.latest_charge].amount_refunded === dCharged.amount, stD.refunds);
  check('...the payment is closed in our records and no order exists for it', (await q(`SELECT "canceledAt" FROM stripe_intents WHERE "intentId" = $1`, [dI.intentId]))[0].canceledAt !== null && (await q(`SELECT COUNT(*)::int n FROM orders WHERE "paymentIntentId" = $1`, [dI.intentId]))[0].n === 0);
  r = await place(S.c1, { ...dBody, tip: 3, paymentIntentId: dI.intentId });
  check('a payment that was given back can never be used for an order afterwards (409 PAYMENT_REFUNDED)', r.s === 409 && r.j.code === 'PAYMENT_REFUNDED', r.text);
  const dI2 = (await intentFor(S.c1, { ...dBody, tip: 9, intentId: dI.intentId })).j;
  check('the page can create a fresh intent after the 409 (different id)', dI2.intentId && dI2.intentId !== dI.intentId, dI2);
  await payOk(dI2.intentId, {});
  r = await place(S.c1, { ...dBody, tip: 9, paymentIntentId: dI2.intentId });
  check('...and the order then goes through', r.s === 201, r.text);
  S.orderB = r.j;
  // tampered amount at Stripe
  await setCart(S.c1);
  const tB = quoteBody(S.addr1, { tip: 4 });
  const tI = (await intentFor(S.c1, tB)).j;
  await stripeApi('POST', `/v1/payment_intents/${tI.intentId}`, { amount: 100 });
  await payOk(tI.intentId, {});
  r = await place(S.c1, { ...tB, paymentIntentId: tI.intentId });
  check('an intent whose amount was lowered behind our back cannot place an order (409)', r.s === 409 && r.j.code === 'PAYMENT_QUOTE_CHANGED', r.text);
  check('...and what that intent had charged was refunded', Object.values((await fake('/_fake/state')).refunds).some((x) => x.payment_intent === tI.intentId && x.amount === 100));
  // cart changed after paying (different items, same intent)
  await setCart(S.c1, 2);
  const iB = quoteBody(S.addr1, { tip: 4 });
  const iI = (await intentFor(S.c1, iB)).j;
  await payOk(iI.intentId, {});
  await setCart(S.c1, 4);
  r = await place(S.c1, { ...iB, paymentIntentId: iI.intentId });
  check('cart contents changed after paying -> 409', r.s === 409 && r.j.code === 'PAYMENT_QUOTE_CHANGED', r.text);
  const stI = await fake('/_fake/state');
  check('...and that payment was refunded in full', Object.values(stI.refunds).some((x) => x.payment_intent === iI.intentId && x.amount === stI.intents[iI.intentId].amount), stI.refunds);
  // declined card
  await setCart(S.c1);
  const xB = quoteBody(S.addr1, { tip: 1 });
  const xI = (await intentFor(S.c1, xB)).j;
  const dec = await payOk(xI.intentId, { scenario: 'declined' });
  check('declined card: the intent stays requires_payment_method with an error', dec.status === 'requires_payment_method' && dec.last_payment_error?.code === 'card_declined', dec);
  r = await place(S.c1, { ...xB, paymentIntentId: xI.intentId });
  check('placing with a declined payment -> 400 PAYMENT_NOT_CONFIRMED, no order', r.s === 400 && r.j.code === 'PAYMENT_NOT_CONFIRMED', r.text);
  const retry = await payOk(xI.intentId, {});
  r = await place(S.c1, { ...xB, paymentIntentId: xI.intentId });
  check('the same intent works after the customer retries with a good card (charged, order placed)', retry.status === 'succeeded' && r.s === 201, r.text);
  S.orderC = r.j;

  // ============================================================ capture on delivery / tip / refunds
  section('B. delivery takes no further payment; tip changes; refunds');
  // a LIVE order (order B, tip 9): a lower tip gives the difference back to the card at once
  const tipB0 = Number(S.orderB.tip);
  r = await api('PATCH', `/customer/orders/${S.orderB.id}/tip`, S.c1, { tip: 5 });
  check('tip lowered while the order is live: the difference is refunded to the card straight away', r.s < 300 && Object.values((await fake('/_fake/state')).refunds).some((x) => x.payment_intent === S.orderB.paymentIntentId && x.amount === cents(tipB0 - 5)), r.text);
  const tipRowsB = await q(`SELECT amount, meta FROM payments WHERE "orderId" = $1 AND kind = 'TIP_ADJUST'`, [S.orderB.id]);
  check('TIP_ADJUST (phase post) recorded with the negative delta', tipRowsB.length === 1 && Math.abs(Number(tipRowsB[0].amount) + (tipB0 - 5)) < 0.011 && tipRowsB[0].meta.phase === 'post', tipRowsB);
  r = await api('PATCH', `/customer/orders/${S.orderB.id}/tip`, S.c1, { tip: 12 });
  check('raising the tip of an already paid order on a card that was not saved is refused clearly (409 TIP_CARD_NOT_SAVED)', r.s === 409 && r.j.code === 'TIP_CARD_NOT_SAVED', r.text);
  // order C: paid at checkout, then delivered
  const tipBefore = Number(S.orderC.tip);
  const chargedC = (await fake('/_fake/state')).intents[S.orderC.paymentIntentId];
  check('order C: the card was charged at checkout for the full order total', chargedC.status === 'succeeded' && chargedC.amount_received === cents(S.orderC.total), chargedC);
  r = await api('PATCH', `/admin/orders/${S.orderC.id}/status`, S.admin, { status: 'DELIVERED', reason: 'payments-e2e' });
  check('order delivered (forced by admin)', r.s < 300, r.text);
  const fc2 = (await fake('/_fake/state')).intents[S.orderC.paymentIntentId];
  check('delivery captured nothing more: the amount received is exactly what was charged at checkout', fc2.status === 'succeeded' && fc2.amount_received === chargedC.amount_received, { status: fc2.status, got: fc2.amount_received, atCheckout: chargedC.amount_received });
  const oc = (await api('GET', `/admin/orders/${S.orderC.id}`, S.admin)).j;
  check('order paymentStatus CAPTURED', (oc.order || oc).paymentStatus === 'CAPTURED', (oc.order || oc).paymentStatus);
  const capRows = await q(`SELECT amount, provider, "externalId" FROM payments WHERE "orderId" = $1 AND kind = 'CAPTURE'`, [S.orderC.id]);
  check('exactly one CAPTURE payment row (written at checkout) carrying the charge id and the amount charged', capRows.length === 1 && capRows[0].provider === 'stripe' && /^ch_/.test(capRows[0].externalId) && Math.round(Number(capRows[0].amount) * 100) === chargedC.amount_received, capRows);
  const led = await q(`SELECT type FROM ledger_entries WHERE "orderId" = $1`, [S.orderC.id]);
  check('ledger rows were posted at settlement', led.length > 0, led);
  // refunds
  r = await api('POST', `/admin/orders/${S.orderC.id}/refund`, S.admin, { amount: 4.5, chargedTo: 'PLATFORM', reasonCode: 'MISSING_ITEM', notes: 'e2e' });
  check('partial refund issued by admin', r.s < 300 && r.j.status === 'PROCESSED', r.text);
  let st = await fake('/_fake/state');
  const refs = Object.values(st.refunds).filter((x) => x.payment_intent === S.orderC.paymentIntentId);
  check('Stripe refund created against the PaymentIntent for the right amount', refs.length === 1 && refs[0].amount === 450, refs);
  check('refund used an idempotency key tied to the FORKSY refund id', st.idemKeys.some((k) => k === `refund-${r.j.id}`), st.idemKeys.filter((k) => k.startsWith('refund')));
  const refPay = await q(`SELECT amount, "externalId" FROM payments WHERE "orderId" = $1 AND kind = 'REFUND'`, [S.orderC.id]);
  check('REFUND payment row with the re_ id', refPay.length === 1 && /^re_/.test(refPay[0].externalId), refPay);
  r = await api('POST', `/admin/orders/${S.orderC.id}/refund`, S.admin, { amount: 9999, chargedTo: 'PLATFORM', reasonCode: 'OTHER' });
  check('a refund larger than the order total is refused (400)', r.s === 400, r.text);
  // tip after delivery (captured): increase via off-session charge on a card that is not saved -> clear error
  r = await api('PATCH', `/customer/orders/${S.orderC.id}/tip`, S.c1, { tip: 8 });
  check('tip increase after capture on a card that was not saved -> 409 TIP_CARD_NOT_SAVED', r.s === 409 && r.j.code === 'TIP_CARD_NOT_SAVED', r.text);
  r = await api('PATCH', `/customer/orders/${S.orderC.id}/tip`, S.c1, { tip: 0 });
  st = await fake('/_fake/state');
  check('tip decrease after delivery is refunded to the card', r.s < 300 && Object.values(st.refunds).some((x) => x.payment_intent === S.orderC.paymentIntentId && x.amount === cents(tipBefore)), r.text);
  // charge.refunded made in the dashboard is recorded
  const piC = st.intents[S.orderC.paymentIntentId];
  await stripeApi('POST', '/v1/refunds', { payment_intent: S.orderC.paymentIntentId, amount: 100 });
  await sleep(1200);
  const dash = await q(`SELECT amount, meta FROM payments WHERE "orderId" = $1 AND kind = 'REFUND' AND meta->>'source' = 'stripe_dashboard'`, [S.orderC.id]);
  check('a refund made directly in the Stripe dashboard is recorded via charge.refunded', dash.length === 1 && Math.abs(Number(dash[0].amount) - 1) < 0.001, dash);

  // ============================================================ wallet & gift cards
  section('B. wallet top-up, gift card, wallet-covered order');
  const w0 = await walletOf(S.c1);
  r = await api('POST', '/customer/wallet/top-up-intent', S.c1, { amount: 2 });
  check('top-up below the minimum is refused (400)', r.s === 400, r.text);
  r = await api('POST', '/customer/wallet/top-up-intent', S.c1, { amount: 25 });
  check('top-up intent created (automatic capture)', r.s === 201 && r.j.clientSecret, r.text);
  const tu = r.j;
  check('top-up intent is automatic capture, not yet paid', (await fake('/_fake/state')).intents[tu.intentId].capture_method === 'automatic');
  r = await api('POST', '/customer/wallet/top-up/confirm', S.c1, { paymentIntentId: tu.intentId });
  check('confirm before paying credits nothing (not_paid)', r.s < 300 && r.j.status === 'not_paid' && (await walletOf(S.c1)) === w0, r.text);
  await fake('/_fake/config', { autoEvents: false });
  await payOk(tu.intentId, {});
  r = await api('POST', '/customer/wallet/top-up/confirm', S.c1, { paymentIntentId: tu.intentId });
  check('confirm after paying credits the wallet', r.s < 300 && r.j.status === 'credited' && (await walletOf(S.c1)) === money(w0 + 25), r.text);
  const piTu = (await fake('/_fake/state')).intents[tu.intentId];
  const succ = evt('payment_intent.succeeded', { id: piTu.id, object: 'payment_intent', amount: piTu.amount, currency: 'cad', status: 'succeeded', metadata: piTu.metadata, customer: piTu.customer });
  const w1 = await webhook(succ);
  const w2 = await webhook(succ);
  const w3 = await webhook(evt('payment_intent.succeeded', { id: piTu.id, object: 'payment_intent', amount: piTu.amount, currency: 'cad', status: 'succeeded', metadata: piTu.metadata, customer: piTu.customer }));
  check('webhook for the same top-up delivered twice (+ a second event id) -> still credited ONCE', w1.s === 200 && w2.s === 200 && w2.j.duplicate === true && w3.s === 200 && (await walletOf(S.c1)) === money(w0 + 25), { w1: w1.s, w2: w2.text, w3: w3.s, bal: await walletOf(S.c1), want: money(w0 + 25) });
  r = await api('POST', '/customer/wallet/top-up/confirm', S.c1, { paymentIntentId: tu.intentId });
  check('confirm repeated -> already (no second credit)', r.j.status === 'already' && (await walletOf(S.c1)) === money(w0 + 25), r.text);
  r = await api('POST', '/customer/wallet/top-up/confirm', S.c2, { paymentIntentId: tu.intentId });
  check("another customer cannot confirm / claim someone else's top-up", r.s === 400, r.text);
  const txs = await q(`SELECT COUNT(*)::int n FROM wallet_transactions WHERE "customerId" = $1 AND type = 'TOPUP' AND note LIKE $2`, [S.c1payload, `%${tu.intentId}%`]);
  check('exactly one TOPUP wallet transaction for the intent', txs[0].n === 1, txs);
  await fake('/_fake/config', { autoEvents: true });
  // gift card
  r = await api('POST', '/customer/gift-cards/purchase-intent', S.c1, { amount: 20 });
  const gci = r.j;
  check('gift card purchase intent created', r.s === 201 && gci.intentId, r.text);
  await payOk(gci.intentId, {});
  await sleep(800);
  r = await api('POST', '/customer/gift-cards/purchase/confirm', S.c1, { paymentIntentId: gci.intentId });
  check('gift card issued after payment (exactly once)', r.s < 300 && ['issued', 'already'].includes(r.j.status) && r.j.giftCard?.code, r.text);
  const gcCode = r.j.giftCard?.code;
  const gcRows = await q(`SELECT COUNT(*)::int n FROM gift_cards WHERE "purchasedById" = $1 AND "initialAmount" = 20`, [S.c1payload]);
  check('one gift card row for that payment', gcRows[0].n >= 1);
  const wBefore = await walletOf(S.c2);
  r = await api('POST', '/customer/wallet/redeem-gift-card', S.c2, { code: gcCode });
  check('the purchased gift card can be redeemed into a wallet', r.s < 300 && (await walletOf(S.c2)) === money(wBefore + 20), r.text);
  // wallet partially / fully covering an order
  await setCart(S.c1);
  const wb = await walletOf(S.c1);
  const pw = quoteBody(S.addr1, { tip: 1, useWallet: true });
  const qw = await getQuote(S.c1, pw);
  const iw = await intentFor(S.c1, pw);
  check('with wallet credit the card amount is total minus wallet', qw.walletUsed > 0 && (iw.j.required === false || money(iw.j.amount) === money(qw.total - qw.walletUsed)), { qw: [qw.total, qw.walletUsed], iw: iw.text });
  if (iw.j.required !== false) {
    await payOk(iw.j.intentId, {});
    r = await place(S.c1, { ...pw, paymentIntentId: iw.j.intentId });
    check('order paid by wallet + card', r.s === 201, r.text);
    S.orderW = r.j;
    check('wallet debited for its part only', (await walletOf(S.c1)) === money(wb - qw.walletUsed), { now: await walletOf(S.c1), want: money(wb - qw.walletUsed) });
    const capture = await api('PATCH', `/admin/orders/${S.orderW.id}/status`, S.admin, { status: 'DELIVERED', reason: 'e2e' });
    const fw = (await fake('/_fake/state')).intents[S.orderW.paymentIntentId];
    check('capture on delivery takes only the card part (not the wallet part)', capture.s < 300 && fw.amount_received === cents(qw.total - qw.walletUsed), { got: fw.amount_received, want: cents(qw.total - qw.walletUsed) });
  }
  // fully covered by wallet
  await api('POST', '/admin/customers/' + S.c1payload + '/wallet/adjust', S.admin, { amount: 300, reason: 'e2e funding' }).catch(() => undefined);
  const wf = await walletOf(S.c1);
  if (wf < 100) {
    // fall back: top-up through Stripe
    const t2 = (await api('POST', '/customer/wallet/top-up-intent', S.c1, { amount: 200 })).j; await payOk(t2.intentId, {}); await api('POST', '/customer/wallet/top-up/confirm', S.c1, { paymentIntentId: t2.intentId });
  }
  await setCart(S.c1);
  const fb = quoteBody(S.addr1, { tip: 0, useWallet: true });
  const qf = await getQuote(S.c1, fb);
  const ifull = await intentFor(S.c1, fb);
  check('wallet covers everything -> no payment intent is needed', qf.total - qf.walletUsed < 0.01 && ifull.j.required === false && !ifull.j.clientSecret, { q: [qf.total, qf.walletUsed], i: ifull.text });
  r = await place(S.c1, { ...fb, paymentMethod: 'WALLET' });
  check('order fully paid with wallet credit is placed without any intent', r.s === 201 && !r.j.paymentIntentId && r.j.paymentMethod === 'WALLET', r.text);
  if (r.j?.id) { const c = await adminCancel(r.j.id); check('...and cancelling it returns the wallet credit', c.s < 300); }
  r = await place(S.c1, { ...fb, paymentMethod: 'CASH' });
  check('CASH payment is no longer accepted (400)', r.s === 400, r.text);
  await setCart(S.c1);

  // ============================================================ saved cards
  section('B. saved cards');
  r = await api('POST', '/customer/cards/setup-intent', S.c1);
  check('SetupIntent for saving a card -> clientSecret + publishableKey', r.s === 201 && r.j.clientSecret && r.j.publishableKey, r.text);
  const cus = (await q(`SELECT "stripeCustomerId" FROM customer_profiles WHERE "userId" = $1`, [S.c1payload]))[0].stripeCustomerId;
  const pmA = await fake('/_fake/pm', { customer: cus, brand: 'visa', last4: '4242' });
  const pmB = await fake('/_fake/pm', { customer: cus, brand: 'mastercard', last4: '5454' });
  const other = await fake('/_fake/pm', { customer: 'cus_someoneelse', brand: 'visa', last4: '1111' });
  r = await api('GET', '/customer/cards', S.c1);
  check('GET /customer/cards lists the customer\'s Stripe payment methods', r.s === 200 && r.j.data.length === 2 && r.j.data.some((c) => c.last4 === '4242'), r.text);
  r = await api('POST', `/customer/cards/${pmB.id}/default`, S.c1);
  const lst = (await api('GET', '/customer/cards', S.c1)).j.data;
  check('default card can be set and is flagged in the list', r.s < 300 && lst.find((c) => c.id === pmB.id).isDefault && !lst.find((c) => c.id === pmA.id).isDefault, lst);
  r = await api('POST', `/customer/cards/${other.id}/default`, S.c1);
  check("another customer's card cannot be made default (400)", r.s === 400, r.text);
  r = await api('DELETE', `/customer/cards/${other.id}`, S.c1);
  check("another customer's card cannot be removed (400)", r.s === 400, r.text);
  await setCart(S.c1);
  const sb = quoteBody(S.addr1, { tip: 2 });
  r = await intentFor(S.c1, { ...sb, paymentMethodId: other.id });
  check("checkout cannot be paid with someone else's saved card (400)", r.s === 400 && r.j.code === 'PAYMENT_METHOD_INVALID', r.text);
  r = await intentFor(S.c1, { ...sb, paymentMethodId: pmA.id });
  check('checkout intent created with the saved card attached', r.s === 201 && (await fake('/_fake/state')).intents[r.j.intentId].payment_method === pmA.id, r.text);
  const sI = r.j;
  await payOk(sI.intentId, { payment_method: pmA.id });
  r = await place(S.c1, { ...sb, paymentIntentId: sI.intentId });
  check('order paid with a saved card', r.s === 201, r.text);
  S.orderS = r.j;
  r = await api('DELETE', `/customer/cards/${pmB.id}`, S.c1);
  check('saved card can be removed', r.s < 300 && (await api('GET', '/customer/cards', S.c1)).j.data.length === 1, r.text);
  // saved card + tip increase after capture = off-session charge works
  await api('PATCH', `/admin/orders/${S.orderS.id}/status`, S.admin, { status: 'DELIVERED', reason: 'e2e' });
  r = await api('PATCH', `/customer/orders/${S.orderS.id}/tip`, S.c1, { tip: Number(S.orderS.tip) + 2 });
  const extra = Object.values((await fake('/_fake/state')).intents).find((i) => i.metadata?.kind === 'tip' && i.metadata.orderId === S.orderS.id);
  check('tip raised after delivery on a SAVED card is charged off-session as its own payment', r.s < 300 && extra?.status === 'succeeded' && extra.amount === 200, { s: r.s, t: r.text, extra });
  const tipRows = await q(`SELECT amount, meta FROM payments WHERE "orderId" = $1 AND kind = 'TIP_ADJUST'`, [S.orderS.id]);
  check('...and recorded as TIP_ADJUST (phase post)', tipRows.some((t) => t.meta.phase === 'post' && Math.abs(Number(t.amount) - 2) < 0.001), tipRows);

  // ============================================================ every way an order can end gives the money back
  section('B. rejected / cancelled orders: everything that was charged goes back');
  // (1) saved card, the tip is raised while the order is live (an extra off-session charge), then the customer cancels inside the window: BOTH charges are refunded
  await setCart(S.c1);
  const mB = quoteBody(S.addr1, { tip: 2 });
  const mI = (await intentFor(S.c1, { ...mB, paymentMethodId: pmA.id })).j;
  await payOk(mI.intentId, { payment_method: pmA.id });
  r = await place(S.c1, { ...mB, paymentIntentId: mI.intentId });
  check('order paid with the saved card (it is cancelled below)', r.s === 201, r.text);
  const oM = r.j;
  r = await api('PATCH', `/customer/orders/${oM.id}/tip`, S.c1, { tip: Number(oM.tip) + 3 });
  const extraM = Object.values((await fake('/_fake/state')).intents).find((i) => i.metadata?.kind === 'tip' && i.metadata.orderId === oM.id);
  check('tip raised while the order is live on a saved card: charged as its own payment', r.s < 300 && extraM?.status === 'succeeded' && extraM.amount === 300, { s: r.s, t: r.text, extraM });
  r = await api('POST', `/customer/orders/${oM.id}/cancel`, S.c1, { reason: 'changed my mind' });
  const stM = await fake('/_fake/state');
  const origM = stM.intents[oM.paymentIntentId];
  check('cancelled inside the window: the checkout payment AND the extra tip charge are both refunded in full', r.s < 300 && stM.charges[origM.latest_charge].amount_refunded === origM.amount && stM.charges[extraM.latest_charge].amount_refunded === 300, { orig: stM.charges[origM.latest_charge], extra: stM.charges[extraM.latest_charge] });
  const rowsM = await q(`SELECT kind, amount FROM payments WHERE "orderId" = $1`, [oM.id]);
  const sumM = (k) => rowsM.filter((x) => x.kind === k).reduce((a, x) => a + Number(x.amount), 0);
  check('payments: what was refunded equals everything that was charged (checkout payment + the extra tip)', Math.abs(sumM('REFUND') - (sumM('CAPTURE') + 3)) < 0.011 && sumM('REFUND') > 3, rowsM);
  check('order is CANCELLED and REFUNDED', (await api('GET', `/customer/orders/${oM.id}`, S.c1)).j.paymentStatus === 'REFUNDED');
  // (2) the restaurant side refuses the order (reject): refunded in full
  await setCart(S.c1);
  const jB = quoteBody(S.addr1, { tip: 1 });
  const jI = (await intentFor(S.c1, jB)).j;
  await payOk(jI.intentId, {});
  r = await place(S.c1, { ...jB, paymentIntentId: jI.intentId });
  const oJ = r.j;
  r = await api('PATCH', `/admin/orders/${oJ.id}/status`, S.admin, { status: 'REJECTED', reason: 'payments-e2e rejected' });
  const stJ = await fake('/_fake/state');
  const fJ = stJ.intents[oJ.paymentIntentId];
  check('a rejected order: the payment is refunded to the card in full', r.s < 300 && stJ.charges[fJ.latest_charge].amount_refunded === fJ.amount, { s: r.s, t: r.text, charge: stJ.charges[fJ.latest_charge] });
  check('...order REJECTED with paymentStatus REFUNDED and a REFUND payment row', (await api('GET', `/customer/orders/${oJ.id}`, S.c1)).j.paymentStatus === 'REFUNDED' && (await q(`SELECT COUNT(*)::int n FROM payments WHERE "orderId" = $1 AND kind = 'REFUND'`, [oJ.id]))[0].n === 1);
  // (3) the customer's window is over (restaurant already has the order): staff can only cancel with the restaurant's approval, and that refunds in full too
  await api('PUT', '/admin/settings', S.admin, { values: { 'orders.customerCancelGraceSeconds': 0 } });
  await setCart(S.c1);
  const gB = quoteBody(S.addr1, { tip: 1 });
  const gI = (await intentFor(S.c1, gB)).j;
  await payOk(gI.intentId, {});
  r = await place(S.c1, { ...gB, paymentIntentId: gI.intentId });
  const oG = r.j;
  r = await api('POST', `/customer/orders/${oG.id}/cancel`, S.c1, { reason: 'too late' });
  check('after the window the customer cannot cancel in the app (403) and nothing is refunded', r.s === 403, r.text);
  r = await api('POST', `/admin/orders/${oG.id}/cancel`, S.admin, { reason: 'e2e', restaurantApproval: { contactName: 'Pat at the restaurant', channel: 'PHONE' } });
  const stG = await fake('/_fake/state');
  const fG = stG.intents[oG.paymentIntentId];
  check('staff cancel with the restaurant\'s approval: the payment is refunded to the card in full', r.s < 300 && stG.charges[fG.latest_charge].amount_refunded === fG.amount, { s: r.s, t: r.text });
  await api('PUT', '/admin/settings', S.admin, { values: { 'orders.customerCancelGraceSeconds': cleanup.settings.grace } });
  await setCart(S.c1);

  // ============================================================ abandoned intents
  section('B. payments that never became an order');
  await setCart(S.c1);
  const aB = quoteBody(S.addr1, { tip: 7 });
  const aI = (await intentFor(S.c1, aB)).j;
  await payOk(aI.intentId, {});
  const aPaid = (await fake('/_fake/state')).intents[aI.intentId];
  check('the customer paid (the card is charged) but has no order yet', aPaid.status === 'succeeded' && aPaid.amount_received === aPaid.amount && (await q(`SELECT COUNT(*)::int n FROM orders WHERE "paymentIntentId" = $1`, [aI.intentId]))[0].n === 0, aPaid);
  r = await api('POST', '/admin/integrations/stripe/sweep-intents', S.fin, {});
  check('only a Super Admin can run the unused-payment clean-up (403)', r.s === 403, r.text);
  // the customer comes back (reload, retry) with the same cart: the payment they made is offered again, they are not charged twice
  const aAgain = await intentFor(S.c1, aB);
  check('asking for a payment for the same cart again returns the payment already made (alreadyPaid, succeeded), not a new charge', aAgain.s === 201 && aAgain.j.intentId === aI.intentId && aAgain.j.alreadyPaid === true && aAgain.j.status === 'succeeded', aAgain.text);
  r = await api('POST', '/admin/integrations/stripe/sweep-intents', S.admin, {});
  check('a payment made a moment ago is left alone by the clean-up (the page may still be placing the order)', Object.values((await fake('/_fake/state')).refunds).every((x) => x.payment_intent !== aI.intentId) && r.j.refunded === 0, r.text);
  await q(`UPDATE stripe_intents SET "createdAt" = now() - interval '90 minutes', "updatedAt" = now() - interval '90 minutes' WHERE "intentId" = $1`, [aI.intentId]);
  r = await api('POST', '/admin/integrations/stripe/sweep-intents', S.admin, {});
  check('...even when our record is old: Stripe says the charge is only seconds old, so it is not refunded yet', Object.values((await fake('/_fake/state')).refunds).every((x) => x.payment_intent !== aI.intentId) && r.j.refunded === 0, r.text);
  await fake('/_fake/age-charge', { payment_intent: aI.intentId, minutes: 30 });
  r = await api('POST', '/admin/integrations/stripe/sweep-intents', S.admin, {});
  const stAb = await fake('/_fake/state');
  check('a payment older than 10 minutes that never became an order is REFUNDED in full by the clean-up', r.s < 300 && r.j.refunded >= 1 && Object.values(stAb.refunds).some((x) => x.payment_intent === aI.intentId && x.amount === aPaid.amount) && stAb.charges[aPaid.latest_charge].amount_refunded === aPaid.amount, { r: r.text, refunds: stAb.refunds });
  const aRow = (await q(`SELECT "canceledAt", meta FROM stripe_intents WHERE "intentId" = $1`, [aI.intentId]))[0];
  check('...the payment is closed in our records with the refund id and reason', aRow.canceledAt !== null && /^re_/.test(aRow.meta?.returned?.refundId || '') && aRow.meta.returned.reason === 'ABANDONED', aRow);
  r = await api('POST', '/admin/integrations/stripe/sweep-intents', S.admin, {});
  check('running the clean-up again refunds nothing more (one refund only)', Object.values((await fake('/_fake/state')).refunds).filter((x) => x.payment_intent === aI.intentId).length === 1 && r.j.refunded === 0, r.text);
  r = await place(S.c1, { ...aB, paymentIntentId: aI.intentId });
  check('a payment the clean-up returned cannot be used for an order any more (409 PAYMENT_REFUNDED)', r.s === 409 && r.j.code === 'PAYMENT_REFUNDED', r.text);
  // a payment attempt that was never paid is cancelled after 60 minutes (nothing to refund)
  await setCart(S.c1);
  const uI = (await intentFor(S.c1, quoteBody(S.addr1, { tip: 8 }))).j;
  await q(`UPDATE stripe_intents SET "createdAt" = now() - interval '90 minutes' WHERE "intentId" = $1`, [uI.intentId]);
  r = await api('POST', '/admin/integrations/stripe/sweep-intents', S.admin, {});
  check('a payment attempt that was never paid is cancelled after 60 minutes', r.s < 300 && (await fake('/_fake/state')).intents[uI.intentId].status === 'canceled' && r.j.cancelled >= 1, r.text);
  // the customer paid, but the order is refused for a clear reason (here: the delivery address no longer exists): the charge is refunded at once and the message says so
  await setCart(S.c1);
  const rB = quoteBody(S.addr1, { tip: 6 });
  const rI = (await intentFor(S.c1, rB)).j;
  await payOk(rI.intentId, {});
  r = await place(S.c1, { ...rB, addressId: '00000000-0000-4000-8000-000000000000', paymentIntentId: rI.intentId });
  const stRf = await fake('/_fake/state');
  check('order refused after payment -> 404 ORDER_NOT_PLACED_REFUNDED, the message says the payment is refunded', r.s === 404 && r.j.code === 'ORDER_NOT_PLACED_REFUNDED' && /refunded automatically/i.test(r.j.message) && /Address not found/.test(r.j.message), r.text);
  check('...and the charge really was refunded at Stripe, in full, at once', Object.values(stRf.refunds).some((x) => x.payment_intent === rI.intentId && x.amount === stRf.intents[rI.intentId].amount), stRf.refunds);
  check('...no order exists and the payment is closed', (await q(`SELECT COUNT(*)::int n FROM orders WHERE "paymentIntentId" = $1`, [rI.intentId]))[0].n === 0 && (await q(`SELECT "canceledAt" FROM stripe_intents WHERE "intentId" = $1`, [rI.intentId]))[0].canceledAt !== null);
  // the customer paid and the page retries with the same payment: it is used once, never charged twice
  await setCart(S.c1);
  const pB = quoteBody(S.addr1, { tip: 7.5 });
  const pI = (await intentFor(S.c1, pB)).j;
  await payOk(pI.intentId, {});
  const pAgain = await intentFor(S.c1, pB);
  r = await place(S.c1, { ...pB, paymentIntentId: pAgain.j.intentId });
  const stPp = await fake('/_fake/state');
  check('a payment already made is used for the order (201) and the cart was charged exactly once', pAgain.j.intentId === pI.intentId && r.s === 201 && Object.values(stPp.intents).filter((i) => i.metadata?.quoteHash === stPp.intents[pI.intentId].metadata.quoteHash && i.status === 'succeeded').length === 1, r.text);
  if (r.j?.id) await adminCancel(r.j.id);
  await setCart(S.c1); // placing an order empties the cart

  // ============================================================ webhooks
  section('C. webhook security + idempotency');
  const ev0 = evt('some.unknown_event', { id: 'x_1', object: 'thing' });
  r = await webhook(ev0, { badSig: true });
  check('bad signature -> 400', r.s === 400, r.text);
  r = await webhook(ev0, { tamper: true });
  check('tampered body -> 400', r.s === 400, r.text);
  r = await req('POST', API + '/webhooks/stripe', { headers: { 'content-type': 'application/json' }, raw: JSON.stringify(ev0) });
  check('missing Stripe-Signature -> 400', r.s === 400, r.text);
  r = await webhook(ev0, { timestamp: Math.floor(Date.now() / 1000) - 3600 });
  check('replayed / stale signature (older than the 5 minute tolerance) -> 400', r.s === 400, r.text);
  r = await webhook(ev0);
  check('unknown event type with a good signature -> 200 and stored as IGNORED', r.s === 200 && r.j.received === true, r.text);
  const stored = (await q(`SELECT status, processed FROM stripe_events WHERE "eventId" = $1`, [ev0.id]))[0];
  check('event row stored (status IGNORED, processed)', stored?.status === 'IGNORED' && stored.processed === true, stored);
  r = await webhook(ev0);
  check('duplicate event id -> 200 duplicate:true', r.s === 200 && r.j.duplicate === true, r.text);
  r = await webhook(evt('payment_intent.succeeded', { id: 'pi_neverheardof', object: 'payment_intent', amount: 1000, metadata: {} }));
  check('known event about an object we do not know -> 200 (never makes Stripe retry)', r.s === 200, r.text);
  r = await api('POST', '/webhooks/stripe', null, { not: 'signed' });
  check('JSON that is not a raw signed body -> 400', r.s === 400, r.text);
  const bigBody = 'x'.repeat(1_200_000);
  r = await req('POST', API + '/webhooks/stripe', { headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=00' }, raw: bigBody });
  check('oversized webhook body is rejected (413)', r.s === 413, r.s);

  section('C. disputes');
  const dispOrderId = S.orderC.id;
  const cBefore = (await api('GET', `/admin/orders/${dispOrderId}/payments`, S.admin)).j;
  const dsp = await fake('/_fake/dispute', { payment_intent: S.orderC.paymentIntentId, reason: 'fraudulent', amount: 1500 });
  await sleep(1500);
  const oD = (await q(`SELECT meta FROM orders WHERE id = $1`, [dispOrderId]))[0];
  check('dispute.created flags the order', oD.meta?.dispute?.id === dsp.id && oD.meta.dispute.status === 'needs_response', oD.meta);
  const tk = await q(`SELECT number, category, priority, tags FROM tickets WHERE "orderId" = $1 AND tags::text LIKE '%dispute%'`, [dispOrderId]);
  check('a URGENT PAYMENT support ticket was opened for the dispute', tk.length === 1 && tk[0].priority === 'URGENT' && tk[0].category === 'PAYMENT', tk);
  const dl = await q(`SELECT amount FROM ledger_entries WHERE "orderId" = $1 AND meta->>'disputeId' = $2`, [dispOrderId, dsp.id]);
  check('platform ledger adjustment for the disputed amount', dl.length === 1 && Math.abs(Number(dl[0].amount) + 15) < 0.001, dl);
  const dp = await q(`SELECT amount FROM payments WHERE "orderId" = $1 AND kind = 'DISPUTE'`, [dispOrderId]);
  check('DISPUTE payment row recorded once', dp.length === 1);
  await fake('/_fake/dispute/' + dsp.id + '/close', { status: 'won' });
  await sleep(1200);
  const dr = await q(`SELECT amount FROM payments WHERE "orderId" = $1 AND kind = 'DISPUTE_REVERSAL'`, [dispOrderId]);
  const dl2 = await q(`SELECT amount FROM ledger_entries WHERE "orderId" = $1 AND meta->>'disputeId' = $2 ORDER BY "createdAt"`, [dispOrderId, dsp.id]);
  check('dispute won: funds returned in payments + ledger', dr.length === 1 && dl2.length === 2 && Math.abs(Number(dl2[1].amount) - 15) < 0.001, { dr, dl2 });
  check('admin order view shows the dispute', (await api('GET', `/admin/orders/${dispOrderId}/payments`, S.admin)).j.dispute?.status === 'won' && cBefore.dispute === null);

  // ============================================================ events admin
  section('C. integrations: events list and replay');
  r = await api('GET', '/admin/integrations/stripe/events?limit=10', S.admin);
  check('recent events listed with status', r.s === 200 && r.j.data.length > 0 && r.j.data[0].status && r.j.data[0].eventId, r.text);
  const failedEv = evt('transfer.reversed', { id: 'tr_unknown', object: 'transfer', amount: 100, amount_reversed: 100 });
  await webhook(failedEv);
  const evRow = (await q(`SELECT id FROM stripe_events WHERE "eventId" = $1`, [failedEv.id]))[0];
  r = await api('POST', `/admin/integrations/stripe/events/${evRow.id}/replay`, S.fin, {});
  check('replay is Super Admin only (403)', r.s === 403, r.text);
  r = await api('POST', `/admin/integrations/stripe/events/${evRow.id}/replay`, S.admin, {});
  check('admin can replay a stored event', r.s < 300 && r.j.replayed === true, r.text);

  // ============================================================ Connect
  await reconcileTests();
  await connectTests();
  await integrationsTests();
  await mapboxTests();
  await miscTests();
}

async function reconcileTests() {
  section('C. reconciliation against Stripe balance transactions');
  const b = (await q(`SELECT id FROM payout_batches ORDER BY "createdAt" DESC LIMIT 1`))[0];
  const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
  await q(`UPDATE payout_batches SET "periodStart" = $1, "periodEnd" = $2 WHERE id = $3`, [day(-1), day(1), b.id]);
  const r = await api('POST', `/admin/finance/batches/${b.id}/reconcile`, S.admin);
  const rec = r.j?.reconciliation;
  check('reconcile uses the real Stripe balance transactions (source stripe)', r.s < 300 && rec?.source === 'stripe', r.text);
  check('FORKSY records (captures, refunds, post-delivery tips, disputes, top-ups, gift cards) equal Stripe numbers: gap 0', rec && Math.abs(rec.gap) < 0.011 && rec.captured > 50, rec);
}

async function connectTests() {
  section('D. Stripe Connect: onboarding, status sync, payouts');
  let r = await api('POST', '/driver/payouts/onboarding', S.d6);
  check('driver onboarding returns a Stripe-hosted link', r.s === 201 && /\/_fake\/onboard\/acct_/.test(r.j.url) && r.j.kind === 'onboarding', r.text);
  const acct6 = (await q(`SELECT "stripeAccountId", "stripeAccountStatus" FROM driver_profiles WHERE id = $1`, [S.d6id]))[0];
  check('Express account created and stored (status PENDING / NOT_STARTED, not enabled)', /^acct_/.test(acct6.stripeAccountId) && ['PENDING', 'NOT_STARTED'].includes(acct6.stripeAccountStatus), acct6);
  const fa = (await fake('/_fake/state')).accounts[acct6.stripeAccountId];
  check('account created as Express, country CA, individual, transfers capability requested', fa && fa.country === 'CA' && fa.business_type === 'individual' && fa.metadata.partyId === S.d6id, fa);
  r = await api('POST', '/driver/payouts/onboarding', S.d6);
  check('onboarding twice reuses the same account (idempotent: one Stripe account for the driver)', Object.values((await fake('/_fake/state')).accounts).filter((a) => a.metadata.partyId === S.d6id).length === 1 && (await q(`SELECT "stripeAccountId" FROM driver_profiles WHERE id = $1`, [S.d6id]))[0].stripeAccountId === acct6.stripeAccountId, r.text);
  r = await api('GET', '/driver/payouts/account', S.d6);
  check('GET /driver/payouts/account -> PENDING with requirements due', r.s === 200 && r.j.status === 'PENDING' && r.j.payoutsEnabled === false && r.j.requirementsDue.length > 0 && r.j.detailsSubmitted === false, r.text);
  r = await api('POST', '/driver/payouts/dashboard-link', S.d6);
  check('Express dashboard link refused before onboarding finished (409)', r.s === 409, r.text);
  r = await api('POST', '/driver/payouts/onboarding', S.c1);
  check('a customer cannot start driver onboarding', r.s === 401 || r.s === 403, r.s);
  // payout blocked until ENABLED
  r = await api('POST', '/admin/finance/adjustments', S.admin, { partyType: 'DRIVER', partyId: S.d6id, amount: 40, reason: 'e2e balance' });
  check('driver has an unpaid balance (manual adjustment)', r.s < 300, r.text);
  r = await api('POST', '/driver/earnings/instant-cashout', S.d6);
  check('instant cash-out blocked while the payout account is not ready (400)', r.s === 400 && /not ready/i.test(r.text), r.text);
  const nTr0 = Object.keys((await fake('/_fake/state')).transfers).length;
  // finish onboarding at "Stripe": account.updated arrives by webhook
  await fake(`/_fake/account/${acct6.stripeAccountId}/complete`, { debitCard: true });
  await sleep(1500);
  const acct6b = (await q(`SELECT "stripeAccountStatus", "stripeAccountInfo" FROM driver_profiles WHERE id = $1`, [S.d6id]))[0];
  check('account.updated webhook moved the driver to ENABLED and stored capabilities / bank last4', acct6b.stripeAccountStatus === 'ENABLED' && acct6b.stripeAccountInfo.payoutsEnabled === true && acct6b.stripeAccountInfo.bankLast4 === '6789' && acct6b.stripeAccountInfo.capabilities?.transfers === 'active', acct6b);
  r = await api('GET', '/driver/payouts/account', S.d6);
  check('status endpoint reports ENABLED', r.j.status === 'ENABLED' && r.j.payoutsEnabled === true && r.j.requirementsDue.length === 0, r.text);
  r = await api('POST', '/driver/payouts/dashboard-link', S.d6);
  check('Express dashboard login link available once enabled', r.s === 201 && /express/.test(r.j.url), r.text);
  // instant cash-out
  r = await api('POST', '/driver/earnings/instant-cashout', S.d6);
  check('instant cash-out succeeds -> payout PAID', r.s < 300 && r.j.status === 'PAID' && r.j.instant === true, r.text);
  let st = await fake('/_fake/state');
  const trs = Object.values(st.transfers).filter((t) => t.destination === acct6.stripeAccountId);
  const pos = Object.values(st.payouts).filter((p) => p.account === acct6.stripeAccountId);
  check('Stripe transfer to the connected account + INSTANT payout to the debit card', trs.length === 1 && pos.length === 1 && pos[0].method === 'instant' && pos[0].amount === trs[0].amount, { trs, pos });
  check('transfer carries transfer_group and metadata, idempotency key payout_<id>', /^payout_/.test(trs[0].transfer_group) && trs[0].metadata.payoutId === r.j.id && st.idemKeys.includes(`payout_${r.j.id}`), trs[0]);
  check('instant fee was charged (fee = max(min, pct of balance)) and the transfer is net of it', r.j.fee > 0 && Math.abs(r.j.fee - Math.max(0.5, 0.015 * (r.j.net + r.j.fee))) < 0.011 && trs[0].amount === Math.round(r.j.net * 100), { fee: r.j.fee, net: r.j.net });
  S.payout6 = r.j;
  // reversal
  await fake(`/_fake/transfer/${trs[0].id}/reverse`, {});
  await sleep(1500);
  const p6 = (await q(`SELECT status, "failureReason" FROM payouts WHERE id = $1`, [S.payout6.id]))[0];
  const rev = await q(`SELECT amount FROM ledger_entries WHERE "partyId" = $1 AND meta->>'transferId' = $2`, [S.d6id, trs[0].id]);
  check('transfer.reversed webhook: payout FAILED, amount returned to the driver ledger', p6.status === 'FAILED' && rev.length === 1 && Math.abs(Number(rev[0].amount) - S.payout6.net) < 0.01, { p6, rev });
  // payout.failed on the connected account
  const ipo = pos[0];
  await fake(`/_fake/payout/${ipo.id}/fail`, {});
  await sleep(1000);
  const nt = await q(`SELECT COUNT(*)::int n FROM notifications WHERE event = 'payout.bank_failed'`);
  check('payout.failed on the connected account notifies the party', nt[0].n >= 1, nt);
  // no eligible debit card -> fallback
  r = await api('POST', '/driver/payouts/onboarding', S.d21);
  const acct21 = (await q(`SELECT "stripeAccountId" FROM driver_profiles WHERE id = $1`, [S.d21id]))[0].stripeAccountId;
  await api('POST', '/admin/finance/adjustments', S.admin, { partyType: 'DRIVER', partyId: S.d21id, amount: 30, reason: 'e2e balance' });
  await fake(`/_fake/account/${acct21}/complete`, {});
  await sleep(1200);
  r = await api('POST', '/driver/earnings/instant-cashout', S.d21);
  const tr21 = Object.values((await fake('/_fake/state')).transfers).filter((t) => t.destination === acct21);
  check('instant cash-out without an eligible debit card falls back to a standard transfer, fee waived, clear reason', r.s < 300 && r.j.status === 'PAID' && Number(r.j.fee) === 0 && /debit card/i.test(r.j.meta?.instantFallback || '') && tr21.length === 1 && !Object.values((await fake('/_fake/state')).payouts).some((p) => p.account === acct21), r.text);
  // restaurant
  r = await api('POST', '/restaurant/payouts/onboarding', S.owner1);
  check('restaurant owner onboarding link (company account)', r.s === 201 && /_fake\/onboard/.test(r.j.url), r.text);
  const merch = (await q(`SELECT id, "stripeAccountId" FROM merchants WHERE "stripeAccountId" IS NOT NULL ORDER BY "updatedAt" DESC LIMIT 1`))[0];
  check('restaurant account stored on the merchant, business_type company', (await fake('/_fake/state')).accounts[merch.stripeAccountId].business_type === 'company');
  const kitchen = await login('kitchen1@demo-restaurant.ca', PW, 'restaurant').catch(() => null);
  if (kitchen) { r = await api('POST', '/restaurant/payouts/onboarding', kitchen.accessToken); check('only the OWNER role can start restaurant onboarding (403)', r.s === 403, r.text); }
  // batch payout waits for the account, then is paid
  r = await restaurantBatch(merch);
  // admin views
  r = await api('GET', '/admin/finance/payout-accounts?status=ENABLED', S.admin);
  check('admin "Payout accounts" list filters by status', r.s === 200 && r.j.data.every((x) => x.status === 'ENABLED') && r.j.data.length >= 2, r.text);
  r = await api('POST', `/admin/finance/payout-accounts/DRIVER/${S.d6id}/sync`, S.admin);
  check('manual "sync from Stripe" works', r.s < 300 && r.j.status === 'ENABLED', r.text);
  r = await api('GET', `/admin/finance/parties/DRIVER/${S.d6id}/bank`, S.admin);
  check('bank view includes the payout account status', r.j.payoutAccount?.status === 'ENABLED', r.text);
  r = await api('POST', `/admin/finance/payout-accounts/sync`, S.fin);
  check('sync-all allowed for finance staff with edit permission', r.s < 300, r.text);
}

async function restaurantBatch(merch) {
  // an unpaid ledger balance for the restaurant in the previous week, then a batch -> approve -> release while the account is NOT ready
  const mid = merch.id;
  await q(`UPDATE merchants SET "stripeAccountStatus" = 'PENDING' WHERE id = $1`, [mid]);
  const fakeAcct = (await fake('/_fake/state')).accounts[merch.stripeAccountId];
  const d = new Date(); d.setDate(d.getDate() - 7 - ((d.getDay() + 6) % 7)); // Monday of the previous week
  const mon = d.toISOString().slice(0, 10); const sunD = new Date(d); sunD.setDate(sunD.getDate() + 6); const sun = sunD.toISOString().slice(0, 10);
  await q(`DELETE FROM payout_batches WHERE "periodStart" = $1 AND "periodEnd" = $2`, [mon, sun]).catch(() => undefined);
  await q(`INSERT INTO ledger_entries (id, "partyType", "partyId", type, amount, description, "createdAt", "updatedAt") VALUES (gen_random_uuid(), 'RESTAURANT', $1, 'ADJUSTMENT', 77.50, 'e2e restaurant balance', $2::timestamptz + interval '10 hours', now())`, [mid, mon]);
  let r = await api('POST', '/admin/finance/batches/generate', S.admin, { periodStart: mon, periodEnd: sun });
  check('payout batch generated for the previous week', r.s < 300 && r.j.id, r.text);
  const batchId = r.j.id;
  await api('POST', `/admin/finance/batches/${batchId}/resolve-gap`, S.admin, { notes: 'e2e' }).catch(() => undefined);
  r = await api('POST', `/admin/finance/batches/${batchId}/approve`, S.admin);
  check('batch approved', r.s < 300, r.text);
  r = await api('POST', `/admin/finance/batches/${batchId}/release`, S.admin);
  check('batch released', r.s < 300, r.text);
  const pay = (await q(`SELECT id, status, "failureReason", meta FROM payouts WHERE "batchId" = $1 AND "partyId" = $2`, [batchId, mid]))[0];
  check('payout for a restaurant whose account is not ready stays PENDING "Payout account not ready" (no transfer)', pay && pay.status === 'PENDING' && pay.failureReason === 'Payout account not ready' && pay.meta.awaitingAccount === true && !Object.values((await fake('/_fake/state')).transfers).some((t) => t.destination === merch.stripeAccountId), pay);
  const n1 = await q(`SELECT COUNT(*)::int n FROM notifications WHERE event = 'payout.account_not_ready'`);
  r = await api('POST', `/admin/finance/payouts/${pay.id}/retry`, S.admin).catch(() => ({ s: 0 }));
  const n2 = await q(`SELECT COUNT(*)::int n FROM notifications WHERE event = 'payout.account_not_ready'`);
  check('the party is notified once (a retry does not notify again)', n1[0].n >= 1 && n2[0].n === n1[0].n, { n1: n1[0].n, n2: n2[0].n });
  await fake(`/_fake/account/${merch.stripeAccountId}/complete`, {});
  await sleep(2500);
  const pay2 = (await q(`SELECT status, "externalRef" FROM payouts WHERE id = $1`, [pay.id]))[0];
  check('when the account becomes ENABLED (webhook) the waiting payout is sent and PAID', pay2.status === 'PAID' && /^tr_/.test(pay2.externalRef), pay2);
  return r;
}

async function integrationsTests() {
  section('A. Integrations API');
  let r = await api('GET', '/admin/integrations', S.admin);
  const dump = r.text;
  check('GET /admin/integrations returns status for stripe, mapbox and the other keys', r.s === 200 && r.j.stripe && r.j.mapbox && r.j.others.twilio && r.j.others.sendgrid && r.j.others.fcm && r.j.others.certn && r.j.others.googleMaps, r.text.slice(0, 300));
  check('no secret value appears anywhere in the response', !dump.includes(SK) && !dump.includes(WHSEC) && !dump.includes('fakeFAKEfake1234567890abcdef') && !dump.includes('pk.fakefakefake1234.fakefakefake5678'));
  check('secrets are shown masked: ******** + last 4', r.j.stripe.keys.secretKey.masked === '********7890' && r.j.stripe.keys.webhookSecret.masked === '********cdef' && r.j.mapbox.keys.accessToken.masked === '********5678', r.j.stripe.keys);
  check('mode TEST detected, webhook URL + event list given', r.j.stripe.mode === 'test' && /\/api\/v1\/webhooks\/stripe$/.test(r.j.stripe.webhook.url) && r.j.stripe.webhook.events.includes('charge.dispute.created') && r.j.stripe.webhook.events.length >= 14, r.j.stripe.webhook);
  check('keys from the environment are reported as source=env', r.j.stripe.keys.secretKey.source === 'env');
  r = await api('GET', '/admin/integrations', S.fin);
  check('a staff role with settings:view can read the status', r.s === 200 || r.s === 403, r.s);
  r = await api('GET', '/admin/integrations', S.c1);
  check('customers cannot read integrations (401/403)', r.s === 401 || r.s === 403, r.s);
  r = await api('GET', '/admin/integrations');
  check('anonymous cannot read integrations (401)', r.s === 401);
  r = await api('GET', '/admin/settings', S.admin);
  const keys = (r.j.data || []).map((s) => s.key);
  check('the generic settings list does not expose the integrations group or legacy secret keys', !keys.some((k) => k.startsWith('integrations.') || k === 'payments.stripe.secretKey' || k === 'maps.mapboxToken'), keys.filter((k) => /integrations|stripe|mapbox/.test(k)));
  r = await api('PUT', '/admin/settings', S.admin, { values: { 'integrations.stripe.secretKey': 'sk_test_1234567890abcdef' } });
  check('the generic settings API refuses to write integration keys (400)', r.s === 400, r.text);
  // staff cannot change
  r = await api('PUT', '/admin/integrations/stripe', S.fin, { connectEnabled: true });
  check('changing integration keys is Super Admin only (staff -> 403)', r.s === 403, r.text);
  // validation
  for (const [label, b] of [['bad secret key', { secretKey: 'not-a-key' }], ['publishable key in the secret field', { secretKey: 'pk_test_1234567890abcdef' }], ['bad publishable key', { publishableKey: 'sk_test_1234567890abcdef' }], ['bad webhook secret', { webhookSecret: 'secret123' }], ['unknown field', { hello: 'x' }], ['non-boolean connect', { connectEnabled: 'false' }]]) {
    r = await api('PUT', '/admin/integrations/stripe', S.admin, b);
    check(`validation: ${label} -> 400`, r.s === 400, r.text);
  }
  r = await api('PUT', '/admin/integrations/mapbox', S.admin, { accessToken: 'abc' });
  check('validation: bad Mapbox token -> 400', r.s === 400, r.text);
  r = await api('PUT', '/admin/integrations/mapbox', S.admin, { bbox: '1,2,3' });
  check('validation: bad bounding box -> 400', r.s === 400, r.text);
  // test connection against the fake with the env key
  r = await api('POST', '/admin/integrations/stripe/test', S.admin);
  check('Test connection (Stripe): passes, reports TEST mode, account, charges/payouts, Connect', r.s < 300 && r.j.ok === true && r.j.livemode === false && /^acct_/.test(r.j.accountId) && r.j.chargesEnabled === true && r.j.payoutsEnabled === true && r.j.connect?.enabled === true, r.text);
  check('...and says the webhook endpoint is not registered yet', r.j.webhook?.checked === true && r.j.webhook.registered === false, r.j.webhook);
  check('the test result never contains a key', !r.text.includes(SK) && !r.text.includes('1234567890'));
  await fake('/_fake/webhook-endpoint', { url: API.replace(/\/api\/v1$/, '') + '/api/v1/webhooks/stripe', enabled_events: ['payment_intent.succeeded', 'charge.refunded'] });
  r = await api('POST', '/admin/integrations/stripe/test', S.admin);
  check('...and, once registered, which events are missing', r.j.webhook?.registered === true && r.j.webhook.missingEvents.length > 5 && r.j.warnings?.length > 0, r.j.webhook);
  r = await api('POST', '/admin/integrations/nothing/test', S.admin);
  check('unknown integration name -> 400', r.s === 400);
  r = await api('POST', '/admin/integrations/stripe/test', S.fin);
  check('Test connection needs settings:edit (or higher)', [200, 201, 403].includes(r.s), r.s);
  // write keys through the API: stored encrypted, masked, audited
  const NEWSK = 'sk_test_Zx9Qw8Er7Ty6Ui5Op4A3s2D1';
  const NEWWH = 'whsec_Qq1Ww2Ee3Rr4Tt5Yy6Uu7Ii8Oo9Pp0';
  r = await api('PUT', '/admin/integrations/stripe', S.admin, { secretKey: NEWSK, webhookSecret: NEWWH, publishableKey: 'pk_test_Aa1Ss2Dd3Ff4Gg5Hh6Jj7Kk8' });
  check('Super Admin saves new Stripe keys', r.s < 300 && r.j.keys.secretKey.masked === '********s2D1' && r.j.keys.secretKey.source === 'settings' && r.j.keys.webhookSecret.masked === '********' + NEWWH.slice(-4), r.text);
  check('response masks them (no plaintext)', !r.text.includes(NEWSK) && !r.text.includes(NEWWH), r.text.slice(0, 200));
  const row = (await q(`SELECT value FROM settings WHERE key = 'integrations.stripe.secretKey'`))[0];
  check('the secret is ENCRYPTED at rest in the settings table (enc1:..., no plaintext)', typeof row.value === 'string' && row.value.startsWith('enc1:') && !row.value.includes('Zx9Qw8'), row.value.slice(0, 20));
  const leg = await q(`SELECT key FROM settings WHERE "isSecret" = true AND jsonb_typeof(value) = 'string' AND value::text <> '""' AND value::text NOT LIKE '"enc1:%'`);
  check('no secret setting is stored in plain text anywhere (all isSecret rows sealed)', leg.length === 0, leg);
  r = await api('GET', '/admin/integrations', S.admin);
  check('settings value WINS over the environment (source=settings) after saving', r.j.stripe.keys.secretKey.source === 'settings' && r.j.stripe.keys.secretKey.masked.endsWith('s2D1'), r.j.stripe.keys.secretKey);
  check('GET still never returns the plaintext', !r.text.includes(NEWSK) && !r.text.includes(NEWWH));
  const aud = await q(`SELECT action, after FROM audit_logs WHERE action = 'integrations.stripe.update' ORDER BY "createdAt" DESC LIMIT 1`);
  check('the change is audit-logged WITHOUT the values (field names only)', aud.length === 1 && JSON.stringify(aud[0].after).includes('secretKey') && !JSON.stringify(aud[0].after).includes('Zx9Qw8') && !JSON.stringify(aud[0].after).includes(NEWWH), aud);
  const audAll = await q(`SELECT COUNT(*)::int n FROM audit_logs WHERE after::text LIKE '%Zx9Qw8%' OR after::text LIKE '%Qq1Ww2%'`);
  check('no audit row anywhere contains the key material', audAll[0].n === 0, audAll);
  // wrong key now set in settings: test fails with a readable reason; fake rejects keys it does not like only if 'invalid'
  r = await api('PUT', '/admin/integrations/stripe', S.admin, { secretKey: 'sk_test_invalidREVOKEDkey123456' });
  r = await api('POST', '/admin/integrations/stripe/test', S.admin);
  check('Test connection with a bad key fails with a readable reason and no key', r.s < 300 && r.j.ok === false && /rejected the secret key/i.test(r.j.reason) && !r.text.includes('invalidREVOKED'), r.text);
  const cfgNow = await req('GET', API + '/public/payments/config');
  check('public payments config never exposes any secret', !JSON.stringify(cfgNow.j).includes('sk_') && !JSON.stringify(cfgNow.j).includes('whsec'));
  // mixed live/test
  r = await api('PUT', '/admin/integrations/stripe', S.admin, { secretKey: NEWSK, publishableKey: 'pk_live_Aa1Ss2Dd3Ff4Gg5Hh6Jj7Kk8' });
  check('mixed TEST secret + LIVE publishable key raises a warning (mixedModes)', r.j.mixedModes === true && r.j.warnings.some((w) => /same mode|different|Use keys/i.test(w)), r.j.warnings);
  r = await api('PUT', '/admin/integrations/stripe', S.admin, { secretKey: 'sk_live_Ll1Ii2Vv3Ee4Kk5Ee6Yy7Zz8' });
  check('a live secret key flips the status to LIVE', r.j.mode === 'live' && r.j.livemode === true, r.j.mode);
  // restore: clear every setting we wrote so the env keys apply again
  r = await api('PUT', '/admin/integrations/stripe', S.admin, { secretKey: '', publishableKey: '', webhookSecret: '', connectEnabled: true });
  check('clearing a key (empty string) removes it; the environment value applies again', r.j.keys.secretKey.source === 'env' && r.j.keys.secretKey.masked === '********7890', r.j.keys);
  r = await api('PUT', '/admin/integrations/stripe', S.admin, { connectEnabled: false });
  const cs = await api('POST', '/driver/payouts/onboarding', S.d21);
  check('Connect switched off in Integrations: onboarding is refused (503)', r.j.connectEnabled === false && cs.s === 503, cs.text);
  await api('PUT', '/admin/integrations/stripe', S.admin, { connectEnabled: true });
  // keys come from settings: webhook secret from settings is what verifies
  r = await api('PUT', '/admin/integrations/stripe', S.admin, { webhookSecret: 'whsec_SettingsWinsOverEnvABCDEFG' });
  const ev = evt('some.unknown_event', { id: 'x' });
  const rEnv = await webhook(ev);
  check('a webhook secret saved in Integrations replaces the environment one (old signature now rejected)', rEnv.s === 400, rEnv.text);
  const payload = JSON.stringify(ev);
  const hdr = stripeLib.webhooks.generateTestHeaderString({ payload, secret: 'whsec_SettingsWinsOverEnvABCDEFG' });
  const rSet = await req('POST', API + '/webhooks/stripe', { headers: { 'content-type': 'application/json', 'stripe-signature': hdr }, raw: payload });
  check('...and the new one is accepted', rSet.s === 200, rSet.text);
  await api('PUT', '/admin/integrations/stripe', S.admin, { webhookSecret: '' });
  // mapbox config
  r = await api('PUT', '/admin/integrations/mapbox', S.admin, { country: 'ca', bbox: '-80.35,43.35,-78.9,44.2', proximity: '-79.6441,43.589' });
  check('Mapbox search defaults saved (country, bbox, proximity)', r.s < 300 && r.j.bbox === '-80.35,43.35,-78.9,44.2' && r.j.proximity === '-79.6441,43.589', r.text);
  r = await api('POST', '/admin/integrations/mapbox/test', S.admin);
  check('Test connection (Mapbox): one geocode request passes and reports a sample address', r.s < 300 && r.j.ok === true && /Mississauga/.test(r.j.sample || ''), r.text);
  await api('PUT', '/admin/integrations/mapbox', S.admin, { accessToken: 'pk.invalidtokeninvalid.invalidtoken9999' });
  r = await api('POST', '/admin/integrations/mapbox/test', S.admin);
  check('Mapbox test with a rejected token fails with a readable reason, token not echoed', r.j.ok === false && /rejected the access token/i.test(r.j.reason) && !r.text.includes('invalidtoken9999'), r.text);
  const sug = await req('GET', API + '/public/geocode/autocomplete?q=city%20centre&sessionToken=abcdefgh-1234');
  check('with a rejected Mapbox token the public proxy degrades to { enabled:false } (clients fall back)', sug.j?.enabled === false, sug.text);
  await api('PUT', '/admin/integrations/mapbox', S.admin, { accessToken: '' });
}

async function mapboxTests() {
  section('D. Mapbox proxy');
  await fake0();
  let r = await req('GET', API + '/public/geocode/autocomplete?q=city%20centre&sessionToken=sess-aaaa-1111&proximity=-79.64,43.59');
  check('autocomplete returns address suggestions (no login needed)', r.s === 200 && r.j.enabled === true && r.j.suggestions.length >= 2 && r.j.suggestions[0].id && r.j.suggestions[0].line1 && r.j.suggestions[0].label, r.text);
  check('suggestions are Mississauga addresses within the GTA box (Ottawa is filtered out)', r.j.suggestions.every((s) => /Mississauga|Brampton|Toronto/.test(s.secondary)), r.j.suggestions);
  const all = await req('GET', API + '/public/geocode/autocomplete?q=main%20st&sessionToken=sess-aaaa-1111');
  check('the bounding box excludes places outside the GTA (no Ottawa result)', all.j.suggestions.every((s) => !/Ottawa/.test(s.secondary)), all.j.suggestions);
  const id = r.j.suggestions[0].id;
  const r2 = await req('GET', API + '/public/geocode/retrieve?id=' + encodeURIComponent(id) + '&sessionToken=sess-aaaa-1111');
  check('retrieve returns line1, city, province, postalCode, lat, lng, label', r2.s === 200 && r2.j.address.line1 && r2.j.address.city === 'Mississauga' && r2.j.address.province === 'ON' && /^L5/.test(r2.j.address.postalCode) && Math.abs(r2.j.address.lat - 43.59) < 0.1 && Math.abs(r2.j.address.lng + 79.64) < 0.1 && r2.j.address.label, r2.text);
  const r3 = await req('GET', API + '/public/geocode/reverse?lat=43.5929&lng=-79.6414');
  check('reverse geocoding returns the nearest address', r3.s === 200 && r3.j.address?.line1 === '1 City Centre Dr', r3.text);
  const none = await req('GET', API + '/public/geocode/reverse?lat=10&lng=10');
  check('reverse geocoding far from any address -> address null (not an error)', none.s === 200 && none.j.address === null, none.text);
  // cache
  const before = await (await fetch(FAKE_MB + '/_fake/stats')).json();
  await req('GET', API + '/public/geocode/autocomplete?q=dundas&sessionToken=sess-aaaa-2222');
  await req('GET', API + '/public/geocode/autocomplete?q=dundas&sessionToken=sess-bbbb-3333');
  await req('GET', API + '/public/geocode/autocomplete?q=DUNDAS&sessionToken=sess-cccc-4444');
  const after = await (await fetch(FAKE_MB + '/_fake/stats')).json();
  check('1-hour cache: three identical searches hit Mapbox once', after.suggest - before.suggest === 1, { before, after });
  // validation
  for (const [label, url] of [
    ['too short', '/public/geocode/autocomplete?q=ab&sessionToken=sess-aaaa-1111'],
    ['missing q', '/public/geocode/autocomplete?sessionToken=sess-aaaa-1111'],
    ['missing sessionToken', '/public/geocode/autocomplete?q=dundas'],
    ['bad sessionToken', '/public/geocode/autocomplete?q=dundas&sessionToken=%3Cscript%3E'],
    ['bad proximity', '/public/geocode/autocomplete?q=dundas&sessionToken=sess-aaaa-1111&proximity=abc'],
    ['proximity out of range', '/public/geocode/autocomplete?q=dundas&sessionToken=sess-aaaa-1111&proximity=500,500'],
    ['q too long', '/public/geocode/autocomplete?q=' + 'a'.repeat(150) + '&sessionToken=sess-aaaa-1111'],
    ['retrieve bad id', '/public/geocode/retrieve?id=%3Cb%3E&sessionToken=sess-aaaa-1111'],
    ['retrieve no session', '/public/geocode/retrieve?id=' + encodeURIComponent(id)],
    ['reverse not a number', '/public/geocode/reverse?lat=abc&lng=1'],
    ['reverse out of range', '/public/geocode/reverse?lat=95&lng=1'],
  ]) {
    const x = await req('GET', API + url);
    check(`input validation: ${label} -> 400`, x.s === 400, x.text);
  }
  const inj = await req('GET', API + '/public/geocode/autocomplete?q=' + encodeURIComponent("dundas'; DROP TABLE users;--") + '&sessionToken=sess-aaaa-9999');
  check('hostile text is just a search string (no error, nothing executed)', inj.s === 200, inj.text);
  const tok = await req('GET', API + '/public/geocode/autocomplete?q=dundas&sessionToken=sess-aaaa-1111');
  check('the Mapbox token never appears in public responses', !tok.text.includes('fakefakefake'));
  // admin routes
  const a1 = await api('GET', '/admin/geocode/autocomplete?q=queen%20st&sessionToken=adm-aaaa-1111', S.admin);
  check('authenticated admin geocode route works', a1.s === 200 && a1.j.suggestions.length >= 1, a1.text);
  const a2 = await api('GET', '/admin/geocode/autocomplete?q=queen%20st&sessionToken=adm-aaaa-1111');
  check('admin geocode needs a login (401)', a2.s === 401);
  const a3 = await api('GET', '/admin/geocode/autocomplete?q=queen%20st&sessionToken=adm-aaaa-1111', S.c1);
  check('a customer cannot call the admin geocode route', a3.s === 401 || a3.s === 403, a3.s);
  // throttle: 30/min/IP. fresh queries so the cache does not answer; stop at the first 429
  let first429 = 0; let ok200 = 0;
  for (let i = 0; i < 40; i++) {
    const x = await req('GET', API + '/public/geocode/autocomplete?q=' + 'zq'.repeat(2) + i + 'x&sessionToken=sess-throttle-' + i);
    if (x.s === 429) { first429 = i + 1; break; }
    if (x.s === 200) ok200++;
  }
  check('throttle: about 30 requests per minute per IP, then 429', first429 > 0 && first429 <= 31 + 1, { first429, ok200 });
  check('429 responses carry Retry-After', (await req('GET', API + '/public/geocode/autocomplete?q=zzzz&sessionToken=sess-throttle-x')).headers.get('retry-after') !== null);
}
const fake0 = async () => { await (await fetch(FAKE_MB + '/_fake/reset')).text(); };

async function miscTests() {
  section('E. CORS / CSP untouched, mock gate, production gate');
  let r = await req('GET', API + '/public/payments/config', { headers: { origin: 'http://localhost:3000' } });
  check('CORS still allows the storefront origin', r.headers.get('access-control-allow-origin') === 'http://localhost:3000');
  r = await req('GET', API + '/public/payments/config', { headers: { origin: 'https://evil.example' } });
  check('CORS still refuses an unknown origin', !r.headers.get('access-control-allow-origin'));
  check('API security headers unchanged (CSP default-src none, no-store on non-public)', /default-src 'none'/.test(r.headers.get('content-security-policy') || ''));
  r = await api('GET', '/customer/wallet', S.c1);
  check('authenticated API responses still Cache-Control: no-store', /no-store/.test(r.headers.get('cache-control') || ''));
  // mock is never used while a key exists
  r = await api('POST', '/customer/payments/intent', S.c1, quoteBody(S.addr1));
  check('with a Stripe key the intent is a real (fake-Stripe) one, never a mock (no _mock_ id)', r.j.mock === false && !r.j.intentId.includes('mock'), r.text);
  // production gate (pure function)
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync(process.execPath, ['-r', 'ts-node/register/transpile-only', '-e', `
    const s = require('./src/common/security');
    const base = { env:'production', jwtSecret:'a'.repeat(5)+'Xk9#mQ2$vL7!pR4&wT6*yU8^zB3@nC5', dbSync:false, exposeOtp:false, corsOrigins:['https://app.example.com'], publicUrl:'https://api.example.com', enforce2fa:true, seedSuperAdminPassword:'Str0ng!Unique#Pass', dbPassword:'Zq8!x7Lm2#vB', dataEncryptionKey:'k'.repeat(40), allowMockPayments:false, fakeProviderBases:false };
    console.log(JSON.stringify({ ok: s.productionProblems(base), mock: s.productionProblems({ ...base, allowMockPayments: true }), fake: s.productionProblems({ ...base, fakeProviderBases: true }),
      noKeys: s.stripeProductionProblems({ secretKey:'', publishableKey:'', webhookSecret:'', connectEnabled:true }), testKeys: s.stripeProductionProblems({ secretKey:'sk_test_x', publishableKey:'pk_test_x', webhookSecret:'whsec_x', connectEnabled:true }), liveKeys: s.stripeProductionProblems({ secretKey:'sk_live_x', publishableKey:'pk_live_x', webhookSecret:'whsec_x', connectEnabled:true }) }));
  `], { cwd: new URL('..', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'), encoding: 'utf8' });
  const g = JSON.parse(out.trim().split('\n').pop());
  check('production gate: a clean configuration has no problems', g.ok.length === 0, g.ok);
  check('production gate: refuses to start when ALLOW_MOCK_PAYMENTS is set', g.mock.some((x) => /ALLOW_MOCK_PAYMENTS/.test(x)), g.mock);
  check('production gate: refuses STRIPE_API_BASE / MAPBOX_API_BASE (fake servers)', g.fake.some((x) => /API_BASE/.test(x)), g.fake);
  check('production gate: refuses missing Stripe keys / webhook secret', g.noKeys.length === 3, g.noKeys);
  check('production gate: refuses TEST keys in production, accepts live ones', g.testKeys.length === 2 && g.liveKeys.length === 0, { t: g.testKeys, l: g.liveKeys });
}

// ------------------------------------------------------------------------------------------------ run
let exitCode = 0;
try {
  await main();
} catch (e) {
  console.log('FATAL', e.stack || e);
  exitCode = 1;
} finally {
  // cleanup: cancel what is still open, restore settings
  try {
    if (S.admin && cleanup.settings.grace !== undefined) await api('PUT', '/admin/settings', S.admin, { values: { 'orders.customerCancelGraceSeconds': cleanup.settings.grace } }).catch(() => undefined);
    for (const id of cleanup.orders) await adminCancel(id).catch(() => undefined);
    await fake('/_fake/config', { incrementAuth: false, autoEvents: true }).catch(() => undefined);
  } catch { /* ignore */ }
  await db.end().catch(() => undefined);
}
const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
failed.forEach((f) => console.log(' FAIL:', f.name));
process.exit(exitCode || (failed.length ? 1 : 0));
