#!/usr/bin/env node
/**
 * System Health end-to-end test: REAL HTTP + websockets against a running API (development data or any database with the demo accounts).
 *
 *   API=http://localhost:4000/api/v1 ADMIN_PASSWORD=... DEMO_PASSWORD=... node backend/test/system-health-e2e.mjs
 *
 * Optional: ADMIN_EMAIL (default admin@forky.ca), STAFF_EMAIL (default ops@forky.ca), CUSTOMER_EMAIL (default customer1@demo.forky.ca),
 *           WS (default: API origin).
 * Needs socket.io-client (it is an admin/ dependency: run `npm install` there once).
 *
 * Proves: only a Super Admin can read the page, stream it or drain an instance (staff and customers are refused, also on the websocket);
 * the data is complete and sane; traffic shows up in the numbers; the last instance can not be drained; thresholds from Platform Settings
 * change the verdict. The login endpoint is throttled (about 10 per minute per IP): three logins are used.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const requireFromAdmin = createRequire(path.join(here, '..', '..', 'admin', 'package.json'));
const { io } = requireFromAdmin('socket.io-client');

const API = (process.env.API || 'http://localhost:4000/api/v1').replace(/\/$/, '');
const WS = process.env.WS || new URL(API).origin;
const ADMIN = { identifier: process.env.ADMIN_EMAIL || 'admin@forky.ca', password: process.env.ADMIN_PASSWORD };
const STAFF = { identifier: process.env.STAFF_EMAIL || 'ops@forky.ca', password: process.env.DEMO_PASSWORD };
const CUSTOMER = { identifier: process.env.CUSTOMER_EMAIL || 'customer1@demo.forky.ca', password: process.env.DEMO_PASSWORD };
if (!ADMIN.password || !STAFF.password) {
  console.error('Set ADMIN_PASSWORD and DEMO_PASSWORD (see the header of this file).');
  process.exit(2);
}

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : detail ? `  -> ${detail}` : ''}`);
  if (!ok) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (method, p, token, body) => {
  const r = await fetch(API + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = null;
  try {
    j = await r.json();
  } catch {
    /* empty */
  }
  return { s: r.status, j };
};
const login = async (who, app) => {
  const r = await api('POST', '/auth/login', null, { ...who, app });
  if (!r.j?.accessToken) throw new Error(`login failed for ${who.identifier}: HTTP ${r.s} ${JSON.stringify(r.j)?.slice(0, 120)}`);
  return r.j.accessToken;
};

/** connect a socket, send system.subscribe, collect system.health events for `ms` */
function watch(token, ms) {
  return new Promise((resolve) => {
    const events = [];
    let ack = null;
    const sock = io(WS, { auth: { token }, transports: ['websocket'], reconnection: false });
    sock.on('system.health', (e) => events.push(e));
    sock.on('connected', () => sock.emit('system.subscribe', {}, (a) => (ack = a)));
    sock.on('connect_error', () => resolve({ events, ack: { ok: false, error: 'connect_error' } }));
    setTimeout(() => {
      sock.close();
      resolve({ events, ack });
    }, ms);
  });
}

const main = async () => {
  const [admin, staff, customer] = [await login(ADMIN, 'admin'), await login(STAFF, 'admin'), await login(CUSTOMER, 'customer')];

  // ---- public probes --------------------------------------------------------------------------------------------------------
  const ready = await api('GET', '/ready');
  check('GET /ready is public and says ready', ready.s === 200 && ready.j?.ready === true, JSON.stringify(ready));
  check('GET /health (Docker liveness) still works', (await api('GET', '/health')).s === 200);

  // ---- who may read it -------------------------------------------------------------------------------------------------------
  for (const [name, p] of [['health', '/admin/system/health'], ['whoami', '/admin/system/whoami']]) {
    check(`no token: ${name} is 401`, (await api('GET', p)).s === 401);
    check(`customer: ${name} is 403`, (await api('GET', p, customer)).s === 403);
    check(`staff (not a Super Admin): ${name} is 403`, (await api('GET', p, staff)).s === 403);
  }
  check('staff cannot drain an instance (403)', (await api('POST', '/admin/system/instances/x/drain', staff)).s === 403);
  check('customer cannot drain an instance (403)', (await api('POST', '/admin/system/instances/x/drain', customer)).s === 403);

  // ---- data ---------------------------------------------------------------------------------------------------------------------
  // the heartbeat publishes every ~2 s: wait for this instance to appear
  let h;
  for (let i = 0; i < 10; i++) {
    h = (await api('GET', '/admin/system/health', admin)).j;
    if (h?.instances?.some((x) => x.self && x.status === 'up' && x.metrics?.process)) break;
    await sleep(1000);
  }
  check('Super Admin: health snapshot is returned', !!h && ['ok', 'warn', 'crit'].includes(h.status), JSON.stringify(h)?.slice(0, 200));
  const me = h?.instances?.find((x) => x.self);
  check('this API instance is listed, up, and marked as "self"', !!me && me.status === 'up' && me.id === h.self);
  check('instance has identity fields (host, pid, version, node, start time, uptime)', !!me && !!me.hostname && me.pid > 0 && !!me.version && /^v\d+/.test(me.nodeVersion) && !!me.startedAt && me.uptimeSec >= 0);
  const m = me?.metrics ?? {};
  check('process numbers: RSS, heap, CPU %, event-loop delay', m.process?.rssMb > 10 && m.process?.heapUsedMb > 1 && typeof m.process?.cpuPct === 'number' && typeof m.process?.eventLoop?.p99 === 'number');
  check('host numbers: CPU %, cores, RAM total / available / used %, disk', m.host?.cpus >= 1 && typeof m.host?.cpuPct === 'number' && m.host?.memTotalMb > 100 && m.host?.memAvailableMb > 0 && m.host?.memUsedPct >= 0 && m.host?.memUsedPct <= 100 && !!m.host?.diskRoot);
  check('database pool numbers are present', typeof m.db?.poolTotal === 'number' && typeof m.db?.poolIdle === 'number');
  check('top-level totals are consistent', h.totals?.instancesUp >= 1 && h.totals?.instancesTotal >= 1 && typeof h.totals?.rps === 'number' && typeof h.totals?.p95 === 'number');
  check('database stats: ping, connections of max, size, version', !!h.db && h.db.pingMs >= 0 && h.db.connections?.max > 0 && h.db.sizeMb > 0 && !!h.db.version);
  check('dependency checks include database, clock and Stripe', ['database', 'clock', 'stripe'].every((k) => h.checks?.some((c) => c.key === k)), JSON.stringify(h.checks?.map((c) => c.key)));
  check('the proxy-headers check is present for a REST call', h.checks?.some((c) => c.key === 'proxy'));
  check('scale-out readiness lists the 5 known blockers', h.readiness?.blockers?.length === 5 && h.readiness.blockers.every((b) => b.key && b.label && b.detail));
  check('chart series exist for this instance (rps, p95, cpu, rss, lag, host cpu and memory)', ['rps', 'p95', 'err', 'cpu', 'rss', 'lag', 'hcpu', 'hmem'].every((k) => Array.isArray(h.series?.perInstance?.[h.self]?.[k])));
  check('thresholds are returned (the page colours with them)', h.thresholds?.cpuWarnPct > 0 && h.thresholds?.p95WarnMs > 0);
  const single = h.totals.instancesTotal === 1;
  check(single ? 'one instance: the balance verdict says there is no load balancing' : 'several instances: a balance verdict is given', single ? h.balance?.state === 'single' : ['balanced', 'skewed', 'unbalanced', 'idle'].includes(h.balance?.state));
  const who = (await api('GET', '/admin/system/whoami', admin)).j;
  check('whoami answers with this instance id (used by the balance test)', who?.instanceId === h.self && !!who.servedAt, JSON.stringify(who));

  // ---- traffic shows up ------------------------------------------------------------------------------------------------------
  const before = me?.metrics?.requests?.total ?? 0;
  await Promise.all(Array.from({ length: 40 }, () => api('GET', '/public/delivery-options')));
  await api('GET', '/this-route-does-not-exist');
  let after = before;
  let route;
  for (let i = 0; i < 10; i++) {
    await sleep(1000);
    const x = (await api('GET', '/admin/system/health', admin)).j;
    after = x.instances.find((i2) => i2.self)?.metrics?.requests?.total ?? 0;
    route = x.routes?.find((r) => r.route.endsWith('/public/delivery-options'));
    if (after >= before + 41 && route) break;
  }
  check('40 requests show up in the request counter (health / system routes are not counted)', after >= before + 41 && after < before + 60, `before ${before}, after ${after}`);
  check('the busiest routes list the pattern, not a raw URL', !!route && route.count >= 40 && route.route.startsWith('GET /api/v1/'));
  check('unknown URLs are grouped under one "(unmatched)" key (no cardinality blow-up)', !!(await api('GET', '/admin/system/health', admin)).j.routes.find((r) => r.route === 'GET (unmatched)'));

  // ---- drain safety ----------------------------------------------------------------------------------------------------------
  const drainSelf = await api('POST', `/admin/system/instances/${encodeURIComponent(h.self)}/drain`, admin);
  check('draining the LAST instance is refused (it would take the site offline)', drainSelf.s === 400 && /last instance/i.test(drainSelf.j?.message || ''), JSON.stringify(drainSelf));
  check('draining an unknown instance is 404', (await api('POST', '/admin/system/instances/does-not-exist/drain', admin)).s === 404);
  check('an invalid instance id is rejected (400)', (await api('POST', '/admin/system/instances/bad%20id%3B%20drop/drain', admin)).s === 400);
  const resume = await api('POST', `/admin/system/instances/${encodeURIComponent(h.self)}/resume`, admin);
  check('resume on an instance that is not draining is harmless', resume.s === 201 && resume.j?.draining === false, JSON.stringify(resume));
  check('/ready is still 200 after the refused drain', (await api('GET', '/ready')).s === 200);

  // ---- thresholds from Platform Settings ---------------------------------------------------------------------------------
  const keys = (await api('GET', '/admin/settings', admin)).j;
  const flat = JSON.stringify(keys);
  check('Platform Settings lists the system health thresholds', flat.includes('system.health.cpuWarnPct'));
  let restored = true;
  try {
    const put = await api('PUT', '/admin/settings', admin, { values: { 'system.health.cpuWarnPct': 0 } });
    restored = false;
    let warned = false;
    for (let i = 0; i < 8 && !warned; i++) {
      await sleep(1000);
      const x = (await api('GET', '/admin/system/health', admin)).j;
      warned = x.thresholds?.cpuWarnPct === 0 && x.issues?.some((it) => it.area === 'cpu');
    }
    check('lowering the CPU warning to 0% immediately raises a CPU issue (setting is honoured)', put.s < 300 && warned, JSON.stringify(put));
  } finally {
    if (!restored) await api('PUT', '/admin/settings', admin, { values: { 'system.health.cpuWarnPct': 75 } });
  }

  // ---- websocket: only a Super Admin can subscribe ---------------------------------------------------------------------------
  const [sa, st, cu] = await Promise.all([watch(admin, 7000), watch(staff, 5000), watch(customer, 5000)]);
  check('Super Admin socket: subscribe is acknowledged', sa.ack?.ok === true, JSON.stringify(sa.ack));
  check('Super Admin socket: receives live snapshots about every 2 s (at least 2 in 7 s)', sa.events.length >= 2, `got ${sa.events.length}`);
  check('a pushed snapshot has the same shape as the REST one', !!sa.events[0]?.instances?.length && !!sa.events[0]?.totals && !!sa.events[0]?.hosts?.length);
  check('staff socket: subscribe is refused', st.ack?.ok === false && st.ack?.error === 'forbidden', JSON.stringify(st.ack));
  check('staff socket: receives NO health events', st.events.length === 0, `got ${st.events.length}`);
  check('customer socket: subscribe is refused and nothing is received', cu.ack?.ok === false && cu.events.length === 0, JSON.stringify(cu.ack));

  console.log(failed ? `\n${failed} check(s) FAILED` : '\nall system-health e2e checks passed');
  process.exit(failed ? 1 : 0);
};

main().catch((e) => {
  console.error('test crashed:', e);
  process.exit(1);
});
