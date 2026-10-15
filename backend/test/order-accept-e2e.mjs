#!/usr/bin/env node
/**
 * FORKSY order acceptance test: REAL HTTP against a running API (+ read-only SQL on notifications).
 *
 * Proves what the restaurant is told when a customer places an order, and that nothing is ever left unanswered:
 *   - the restaurant accepts MANUALLY  -> the order waits in PLACED, the restaurant gets the loud `order.placed` alert (alarm + the Accept / Reject popup
 *     of the portal) and NOT the quiet notice; accepting (with a prep time) and rejecting (with a reason, the customer is refunded) work
 *   - the restaurant accepts AUTOMATICALLY -> the order is ACCEPTED by itself, the restaurant gets the quiet `order.auto_accepted` notice and NO alarm
 *   - automatic acceptance blocked at that moment (kitchen at its limit) -> the order is left for a person with the loud alert, and is accepted
 *     automatically (with the quiet notice) as soon as the blocker is gone
 *   - the order the popup shows (GET /restaurant/orders/:id) carries items, total, prep time and the answer deadline
 *
 * Run (API and Postgres must be up and seeded with the demo data; the API on mock payments or with test payments):
 *
 *   API=http://localhost:4000/api/v1 ADMIN_PASSWORD=<super-admin password> DEMO_PASSWORD=<demo-account password> \
 *   PGPASSWORD=<postgres password> node backend/test/order-accept-e2e.mjs
 *
 * Optional env: SLUG (restaurant, default napoli-wood-fired-pizza-city-centre), ADMIN_EMAIL, PGHOST / PGPORT / PGUSER / PGDATABASE.
 * It temporarily sets orders.customerCancelGraceSeconds to 0 and automation.orders.autoAccept.maxActive, and restores both (and the
 * restaurant's automation override) in a finally block. Takes about a minute (the retry sweep runs every 15 s).
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Client } = require('pg');

const API = (process.env.API || 'http://localhost:4000/api/v1').replace(/\/$/, '');
const SLUG = process.env.SLUG || 'napoli-wood-fired-pizza-city-centre';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@forksy.ca';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const DEMO_PASSWORD = process.env.DEMO_PASSWORD;
if (!ADMIN_PASSWORD || !DEMO_PASSWORD || !process.env.PGPASSWORD) {
  console.error('Set ADMIN_PASSWORD, DEMO_PASSWORD and PGPASSWORD (see the header of this file).');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra) => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && extra !== undefined ? '  -> ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 300) : ''}`);
};

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
/** the customer also gets an `order.placed` (their own confirmation): only what the RESTAURANT's people received counts here */
let customerId = null;
/** the notification events the restaurant received for one order */
const eventsFor = async (orderId) => (await pg.query(`SELECT DISTINCT event FROM notifications WHERE data->>'orderId' = $1 AND "userId" <> $2 AND event IN ('order.placed', 'order.auto_accepted')`, [orderId, customerId])).rows.map((r) => r.event);
/** (staff member, channel) pairs that got the same alert more than once */
const duplicates = async (orderId, event) => (await pg.query(`SELECT "userId", channel, COUNT(*) n FROM notifications WHERE data->>'orderId' = $1 AND event = $2 AND "userId" <> $3 GROUP BY 1, 2 HAVING COUNT(*) > 1`, [orderId, event, customerId])).rows;

let home;
async function place(customerToken, qty = 2) {
  if (!home) home = await api('GET', '/public/restaurants/' + SLUG);
  const menu = home.j.menu; const cats = Array.isArray(menu) ? menu : menu?.categories || [];
  let item;
  for (const ct of cats) { for (const i of ct.items || []) { if (!(i.modifierGroups || []).some((g) => g.minSelect > 0 || g.required)) { item = i; break; } } if (item) break; }
  const restId = home.j.id || home.j.restaurant?.id;
  await api('POST', '/customer/cart/replace', customerToken, { restaurantId: restId, items: [{ menuItemId: item.id, quantity: qty }] });
  const addrs = (await api('GET', '/customer/addresses', customerToken)).j;
  const addressId = addrs.find((a) => a.isDefault).id;
  const po = await api('POST', '/customer/orders', customerToken, { type: 'DELIVERY', addressId, tip: 2, paymentMethod: 'CARD', paymentToken: 'pm_mock' });
  return { oid: po.j?.id, po, restId, itemName: item.name };
}
const cancel = (admin, orderId) => api('POST', `/admin/orders/${orderId}/cancel`, admin, { reason: 'order-accept-e2e cleanup', restaurantApproval: { contactName: 'Order Accept E2E', channel: 'CHAT' } });
const statusOf = async (token, orderId) => (await api('GET', `/customer/orders/${orderId}`, token)).j?.status;
async function waitStatus(token, orderId, want, ms) {
  const end = Date.now() + ms;
  let st;
  while (Date.now() < end) { st = await statusOf(token, orderId); if (st === want) return st; await sleep(1000); }
  return st;
}

async function main() {
  await pg.connect();
  const S = {};
  S.admin = (await login(ADMIN_EMAIL, ADMIN_PASSWORD)).accessToken;
  const c1 = await login('customer1@demo.forksy.ca', DEMO_PASSWORD, 'customer'); S.c1 = c1.accessToken;
  customerId = (await api('GET', '/auth/me', S.c1)).j.id;
  check('customer identified (their own order.placed confirmation is left out of the restaurant checks)', !!customerId);
  const settingOf = async (group, key) => ((await api('GET', `/admin/settings?group=${group}`, S.admin)).j.data || []).find((s) => s.key === key);
  const origGrace = (await settingOf('orders', 'orders.customerCancelGraceSeconds'))?.value ?? 120;
  const origCap = (await settingOf('automation', 'automation.orders.autoAccept.maxActive'))?.value ?? 12;
  let rid = null; const placed = [];
  try {
    let r = await api('PUT', '/admin/settings', S.admin, { values: { 'orders.customerCancelGraceSeconds': 0 } }); check('customer cancel grace set to 0 for the run (the order goes to the restaurant at once)', r.s < 300, r);
    // a first order only finds the restaurant id and the owner's token
    const probe = await place(S.c1); placed.push(probe.oid); rid = probe.restId; await cancel(S.admin, probe.oid);
    const imp = await api('POST', `/admin/restaurants/${rid}/impersonate`, S.admin, {});
    const owner = imp.j && (imp.j.accessToken || (imp.j.data && imp.j.data.accessToken)); check('impersonation token for the restaurant owner', !!owner, imp);
    const q = `?restaurantId=${rid}`;
    const setAuto = (v) => api('PATCH', '/restaurant/automation' + q, owner, { autoAccept: v });

    // ============================================================ A. manual acceptance: the loud alert + popup, then Accept
    console.log('--- manual acceptance');
    r = await setAuto(false); check('restaurant switches to manual acceptance', r.s < 300 && r.j.effective.autoAccept === false, r);
    const a = await place(S.c1, 2); placed.push(a.oid); check('order A placed', a.po.s < 300 && a.oid, a.po.j);
    await sleep(4000);
    check('A: the order waits in PLACED (nobody accepted it)', (await statusOf(S.c1, a.oid)) === 'PLACED');
    let ev = await eventsFor(a.oid);
    check('A: the restaurant got the LOUD alert (order.placed)', ev.includes('order.placed'), ev);
    const staffAlerted = Number((await pg.query(`SELECT COUNT(DISTINCT "userId") n FROM notifications WHERE data->>'orderId' = $1 AND "userId" <> $2 AND event = 'order.placed'`, [a.oid, customerId])).rows[0].n);
    check('A: the staff of the restaurant are alerted', staffAlerted >= 1, staffAlerted);
    check('A: and not the quiet "accepted automatically" notice', !ev.includes('order.auto_accepted'), ev);
    check('A: nobody gets the alert twice', (await duplicates(a.oid, 'order.placed')).length === 0, await duplicates(a.oid, 'order.placed'));
    const list = (await api('GET', `/restaurant/orders${q}&limit=100`, owner)).j;
    check('A: the portal order list has it as PLACED (this is what the popup syncs)', (list.data || []).some((o) => o.id === a.oid && o.status === 'PLACED'), (list.data || []).map((o) => o.id + ':' + o.status).slice(0, 5));
    const det = (await api('GET', `/restaurant/orders/${a.oid}${q}`, owner)).j;
    const o = det.order || {};
    check('A: the popup gets items, total, prep time and the answer deadline', Array.isArray(o.items) && o.items.length > 0 && Number(o.total) > 0 && o.prepTimeMin > 0 && !!o.acceptDeadlineAt, { items: o.items?.length, total: o.total, prep: o.prepTimeMin, deadline: o.acceptDeadlineAt });
    check('A: the answer deadline is in the future (the order is auto-rejected after it)', new Date(o.acceptDeadlineAt).getTime() > Date.now(), o.acceptDeadlineAt);
    r = await api('POST', `/restaurant/orders/${a.oid}/accept${q}`, S.c1, { prepTimeMin: 20 }); check('A: a customer cannot accept an order', r.s === 401 || r.s === 403, r.s);
    r = await api('POST', `/restaurant/orders/${a.oid}/accept${q}`, owner, { prepTimeMin: 0 }); check('A: a prep time of 0 is refused', r.s === 400, r.s);
    r = await api('POST', `/restaurant/orders/${a.oid}/accept${q}`, owner, { prepTimeMin: 25 }); check('A: Accept with a prep time of 25 min works', r.s < 300, r);
    const after = (await api('GET', `/restaurant/orders/${a.oid}${q}`, owner)).j.order;
    check('A: the order is ACCEPTED with the prep time the restaurant chose', after.status === 'ACCEPTED' || after.status === 'PREPARING', after.status);
    check('A: prep time is 25 min', Number(after.prepTimeMin) === 25, after.prepTimeMin);
    r = await api('POST', `/restaurant/orders/${a.oid}/accept${q}`, owner, { prepTimeMin: 25 }); check('A: answering twice is refused', r.s >= 400 && r.s < 500, r.s);
    await cancel(S.admin, a.oid);

    // ============================================================ B. manual acceptance: Reject with a reason
    console.log('--- reject');
    const b = await place(S.c1); placed.push(b.oid); check('order B placed', b.po.s < 300 && b.oid, b.po.j);
    await sleep(2500);
    check('B: waits in PLACED', (await statusOf(S.c1, b.oid)) === 'PLACED');
    r = await api('POST', `/restaurant/orders/${b.oid}/reject${q}`, owner, { reason: 'NOPE' }); check('B: an unknown reject reason is refused', r.s === 400, r.s);
    r = await api('POST', `/restaurant/orders/${b.oid}/reject${q}`, owner, { reason: 'BUSY', note: 'Kitchen is full tonight' }); check('B: Reject with a reason works', r.s < 300, r);
    const rb = (await api('GET', `/customer/orders/${b.oid}`, S.c1)).j;
    check('B: the order is REJECTED', rb.status === 'REJECTED', rb.status);
    check('B: the customer is refunded (paymentStatus REFUNDED)', rb.paymentStatus === 'REFUNDED', rb.paymentStatus);

    // ============================================================ C. automatic acceptance: accepted by itself, quiet notice, no alarm
    console.log('--- automatic acceptance');
    r = await setAuto(null); check('back to the platform default (accept automatically)', r.s < 300 && r.j.effective.autoAccept === true, r);
    const c = await place(S.c1); placed.push(c.oid); check('order C placed', c.po.s < 300 && c.oid, c.po.j);
    const stC = await waitStatus(S.c1, c.oid, 'ACCEPTED', 12000);
    const stC2 = stC === 'ACCEPTED' ? stC : await statusOf(S.c1, c.oid);
    check('C: accepted by itself, nobody clicked anything', ['ACCEPTED', 'PREPARING'].includes(stC2), stC2);
    await sleep(1500);
    ev = await eventsFor(c.oid);
    check('C: the restaurant got the QUIET notice (order.auto_accepted)', ev.includes('order.auto_accepted'), ev);
    check('C: and NO loud alert (no alarm, no popup)', !ev.includes('order.placed'), ev);
    await cancel(S.admin, c.oid);

    // ============================================================ D. automatic acceptance blocked at that moment: loud alert, accepted as soon as it clears
    console.log('--- blocked, then cleared');
    r = await api('PUT', '/admin/settings', S.admin, { values: { 'automation.orders.autoAccept.maxActive': 1 } }); check('kitchen limit set to 1 active order', r.s < 300, r);
    const d1 = await place(S.c1); placed.push(d1.oid); check('order D1 placed', d1.po.s < 300 && d1.oid, d1.po.j);
    check('D1: accepted automatically (the kitchen was empty)', ['ACCEPTED', 'PREPARING'].includes(await waitStatus(S.c1, d1.oid, 'ACCEPTED', 12000)) || ['ACCEPTED', 'PREPARING'].includes(await statusOf(S.c1, d1.oid)));
    const d2 = await place(S.c1); placed.push(d2.oid); check('order D2 placed', d2.po.s < 300 && d2.oid, d2.po.j);
    await sleep(4000);
    check('D2: NOT accepted automatically: the kitchen is at its limit', (await statusOf(S.c1, d2.oid)) === 'PLACED');
    ev = await eventsFor(d2.oid);
    check('D2: so the restaurant got the LOUD alert (somebody has to accept it)', ev.includes('order.placed') && !ev.includes('order.auto_accepted'), ev);
    r = await api('PUT', '/admin/settings', S.admin, { values: { 'automation.orders.autoAccept.maxActive': 0 } }); check('kitchen limit lifted', r.s < 300, r);
    const stD2 = await waitStatus(S.c1, d2.oid, 'ACCEPTED', 40000);
    check('D2: accepted automatically within 40 s of the blocker clearing (the sweep retries every 15 s)', ['ACCEPTED', 'PREPARING'].includes(stD2) || ['ACCEPTED', 'PREPARING'].includes(await statusOf(S.c1, d2.oid)), stD2);
    await sleep(1500);
    ev = await eventsFor(d2.oid);
    check('D2: and the restaurant is told, quietly, that it was accepted for them', ev.includes('order.auto_accepted'), ev);
    await cancel(S.admin, d1.oid); await cancel(S.admin, d2.oid);

    // ============================================================ E. manual restaurants are never accepted behind their back by the retry sweep
    console.log('--- manual stays manual');
    r = await setAuto(false); check('manual acceptance again', r.s < 300 && r.j.effective.autoAccept === false, r);
    const e1 = await place(S.c1); placed.push(e1.oid);
    await sleep(35000);
    check('E: after two sweeps the order still waits for a person', (await statusOf(S.c1, e1.oid)) === 'PLACED');
    ev = await eventsFor(e1.oid);
    check('E: loud alert only', ev.includes('order.placed') && !ev.includes('order.auto_accepted'), ev);
    await cancel(S.admin, e1.oid);
  } finally {
    if (rid) {
      const imp = await api('POST', `/admin/restaurants/${rid}/impersonate`, S.admin, {});
      const owner = imp.j && (imp.j.accessToken || (imp.j.data && imp.j.data.accessToken));
      if (owner) await api('PATCH', `/restaurant/automation?restaurantId=${rid}`, owner, { autoAccept: null });
    }
    await api('PUT', '/admin/settings', S.admin, { values: { 'orders.customerCancelGraceSeconds': origGrace, 'automation.orders.autoAccept.maxActive': origCap } });
    for (const id of placed) if (id) await cancel(S.admin, id);
    await pg.end();
  }
  const failed = results.filter((x) => !x.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) { console.log('FAILED:\n' + failed.map((x) => ' - ' + x.name).join('\n')); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
