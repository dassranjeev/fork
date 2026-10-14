#!/usr/bin/env node
/**
 * Observes what the read endpoints (GET) really return and writes it as response shapes for the OpenAPI file.
 *
 *   cd backend && ADMIN_PASSWORD=... DEMO_PASSWORD=... npm run openapi:observe
 *
 * Needs a running API with the seeded demo data (API=http://localhost:4000/api/v1 by default) and docs/openapi/openapi.json (the list of routes).
 * It signs in as a Super Admin, a restaurant owner, a driver and a customer, calls every GET route with the account type that route belongs to
 * (ids for path parameters are collected from the list endpoints it has already called), and infers a JSON Schema plus a short example from each JSON answer.
 * Result: docs/openapi/openapi.responses.json, merged into openapi.json by `npm run openapi:export`.
 *
 * Only GET is called (nothing is written, sent or paid). Examples come from DEMO data, are cut short (2 list items), and values under keys such as
 * token / secret / password / hash are replaced. Shapes are inferred from the demo data: a field that is empty in every demo row can be missing or
 * typed too loosely, so treat the result as a very good starting point, not a contract.
 *
 * Optional env: API, ADMIN_EMAIL, OWNER_EMAIL, DRIVER_EMAIL, CUSTOMER_EMAIL, OPENAPI_DIR.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.resolve(process.env.OPENAPI_DIR || path.join(here, '..', '..', 'docs', 'openapi'));
const API = (process.env.API || 'http://localhost:4000/api/v1').replace(/\/$/, '');
const ORIGIN = new URL(API).origin;
const ACCOUNTS = {
  admin: { identifier: process.env.ADMIN_EMAIL || 'admin@forksy.ca', password: process.env.ADMIN_PASSWORD, app: 'admin' },
  restaurant: { identifier: process.env.OWNER_EMAIL || 'owner1@demo-restaurant.ca', password: process.env.DEMO_PASSWORD, app: 'restaurant' },
  driver: { identifier: process.env.DRIVER_EMAIL || 'driver1@demo.forksy.ca', password: process.env.DEMO_PASSWORD, app: 'driver' },
  customer: { identifier: process.env.CUSTOMER_EMAIL || 'customer1@demo.forksy.ca', password: process.env.DEMO_PASSWORD, app: 'customer' },
};
if (!ACCOUNTS.admin.password || !ACCOUNTS.customer.password) {
  console.error('Set ADMIN_PASSWORD and DEMO_PASSWORD (see the header of this file).');
  process.exit(2);
}

// ------------------------------------------------------------------------------------------------ schema inference
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const ISO_D = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i;
const SECRET_KEY = /token|secret|password|passwd|hash|authorization|apikey|api_key|privatekey|botkey|otp|pin$|cvv|cardnumber/i;

const isNullOnly = (s) => s && s.nullable && !s.type && !s.properties && !s.oneOf;

function infer(v, depth = 0) {
  if (v === null || v === undefined) return { nullable: true };
  if (typeof v === 'string') {
    const f = UUID.test(v) ? 'uuid' : ISO_DT.test(v) ? 'date-time' : ISO_D.test(v) ? 'date' : EMAIL.test(v) ? 'email' : null;
    return f ? { type: 'string', format: f } : { type: 'string' };
  }
  if (typeof v === 'number') return Number.isInteger(v) ? { type: 'integer' } : { type: 'number' };
  if (typeof v === 'boolean') return { type: 'boolean' };
  if (Array.isArray(v)) {
    const items = v.slice(0, 12).map((x) => infer(x, depth + 1)).reduce(merge, null);
    return { type: 'array', items: items || {} };
  }
  if (depth > 8) return { type: 'object' };
  const properties = {};
  for (const k of Object.keys(v).slice(0, 250)) properties[k] = infer(v[k], depth + 1);
  return { type: 'object', properties, required: Object.keys(properties).sort() };
}

function merge(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (isNullOnly(a)) return { ...b, nullable: true };
  if (isNullOnly(b)) return { ...a, nullable: true };
  const nullable = a.nullable || b.nullable ? { nullable: true } : {};
  if (a.type !== b.type) {
    if (['integer', 'number'].includes(a.type) && ['integer', 'number'].includes(b.type)) return { type: 'number', ...nullable };
    const strip = ({ nullable: _n, ...rest }) => rest;
    return { oneOf: [strip(a), strip(b)], ...nullable };
  }
  if (a.type === 'object') {
    const keys = new Set([...Object.keys(a.properties || {}), ...Object.keys(b.properties || {})]);
    const properties = {};
    for (const k of [...keys].sort()) properties[k] = merge(a.properties?.[k], b.properties?.[k]);
    const required = (a.required || []).filter((k) => (b.required || []).includes(k));
    return { type: 'object', properties, required, ...nullable };
  }
  if (a.type === 'array') return { type: 'array', items: merge(a.items, b.items) || {}, ...nullable };
  if (a.type === 'string') return { type: 'string', ...(a.format && a.format === b.format ? { format: a.format } : {}), ...nullable };
  return { ...a, ...nullable };
}

/** short, safe example: 2 list items, cut strings, secrets replaced */
function example(v, depth = 0, key = '') {
  if (SECRET_KEY.test(key) && v !== null && typeof v !== 'object') return '<redacted>';
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    // sample embed snippets carry the widget key (public by design, but it looks like a key to every scanner)
    const s = v.replace(/(data-key=")[^"]+(")/g, '$1<bot-key>$2');
    return s.length > 160 ? s.slice(0, 157) + '...' : s;
  }
  if (Array.isArray(v)) return depth > 6 ? [] : v.slice(0, 2).map((x) => example(x, depth + 1, key));
  if (depth > 6) return {};
  return Object.fromEntries(Object.keys(v).slice(0, 40).map((k) => [k, example(v[k], depth + 1, k)]));
}

// ------------------------------------------------------------------------------------------------ http
const tokens = {};
async function login(role) {
  const a = ACCOUNTS[role];
  const r = await fetch(API + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(a) });
  const j = await r.json().catch(() => ({}));
  if (!j.accessToken) {
    console.warn(`  (no ${role} token: HTTP ${r.status} ${JSON.stringify(j).slice(0, 80)}): its routes will be skipped`);
    return;
  }
  tokens[role] = j.accessToken;
  if (role === 'restaurant' && Array.isArray(j.user?.restaurantIds)) for (const id of j.user.restaurantIds) add('restaurant', 'restaurants', 'id', id, 0);
}

async function get(url, role) {
  const headers = role && tokens[role] ? { authorization: `Bearer ${tokens[role]}` } : {};
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(25000) });
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('json')) {
    await r.arrayBuffer().catch(() => {});
    return { status: r.status, json: null, nonJson: ct.split(';')[0] || 'empty' };
  }
  return { status: r.status, json: await r.json().catch(() => null) };
}

// ------------------------------------------------------------------------------------------------ routes and path parameters
const spec = JSON.parse(fs.readFileSync(path.join(DIR, 'openapi.json'), 'utf8'));
const SKIP = /\/(export|download|csv|pdf|photo|image|qr|invoice-file|file|stream|logout)(\/|$|\?)/i;
const gets = [];
// /admin/system/* answers with this machine's hostname, process ids and addresses: never put those into a published file (shapes: docs/system-health.md)
const MACHINE_SPECIFIC = /^\/api\/v1\/admin\/system\//;
for (const [p, item] of Object.entries(spec.paths)) if (item.get && !SKIP.test(p) && !MACHINE_SPECIFIC.test(p)) gets.push({ path: p, op: item.get, key: `GET ${p}` });

const roleOf = (p) => {
  const s = p.replace(/^\/api\/v1\//, '');
  if (s.startsWith('admin/')) return 'admin';
  if (s.startsWith('restaurant/')) return 'restaurant';
  if (s.startsWith('driver/')) return 'driver';
  if (s.startsWith('customer/')) return 'customer';
  if (s.startsWith('public/') || s === 'health' || s === 'ready' || s.startsWith('assistant/')) return null;
  return 'customer'; // shared routes (auth/me, notifications, orders/:id/tracking ...): try a customer first
};
const FALLBACK = { customer: ['admin', 'driver', 'restaurant'], admin: [], restaurant: ['admin'], driver: ['admin'] };

const singular = (w) => w.replace(/ies$/, 'y').replace(/ses$/, 's').replace(/s$/, '');
const pools = new Map(); // `${role}|${kind}|${field}` -> Map(value -> depth of the list route); kind = last static path segment of the list route
const add = (role, kind, field, val, depth = 9) => {
  if (val === undefined || val === null || typeof val === 'object') return;
  for (const k of [`${role}|${kind}|${field}`, `*|${kind}|${field}`]) {
    const m = pools.get(k) ?? pools.set(k, new Map()).get(k);
    if (!m.has(String(val))) m.set(String(val), depth);
  }
};
function mine(routePath, json, role) {
  const segs = routePath.split('/').filter(Boolean);
  const last = segs[segs.length - 1];
  if (!last || last.startsWith('{')) return;
  const rows = [];
  const walk = (v, d) => {
    if (d > 3 || v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const x of v.slice(0, 8)) if (x && typeof x === 'object') rows.push(x);
      return;
    }
    for (const k of Object.keys(v)) if (Array.isArray(v[k])) walk(v[k], d + 1);
  };
  walk(json, 0);
  if (!rows.length && json && typeof json === 'object' && !Array.isArray(json) && json.id) rows.push(json);
  for (const row of rows) for (const f of ['id', 'code', 'slug']) add(role || 'public', last, f, row[f], segs.length);
}
function paramValues(param, tpl, role) {
  const segs = tpl.split('/').filter(Boolean);
  const at = segs.indexOf(`{${param}}`);
  const prev = at > 0 ? segs[at - 1] : '';
  const name = param.replace(/Id$/, '');
  const field = /^(id|[a-z]+Id)$/i.test(param) ? 'id' : param;
  const kinds = [...new Set([prev, name.endsWith('y') ? name.slice(0, -1) + 'ies' : name + 's', name + 'es', prev.replace(/s$/, '') + 's'].filter(Boolean))];
  const found = [];
  for (const kind of kinds) for (const r of [role || 'public', '*']) {
    const m = pools.get(`${r}|${kind}|${field}`);
    if (m) for (const [v, d] of m) if (!found.some((x) => x.v === v)) found.push({ v, d });
  }
  // canonical (shallow) lists first, UUID-looking ids before labels and scope keys
  found.sort((a, b) => a.d - b.d || Number(UUID.test(b.v)) - Number(UUID.test(a.v)));
  return found.slice(0, 3).map((x) => x.v);
}
function queryValue(p) {
  const n = p.name;
  if (p.schema?.enum?.length) return p.schema.enum[0];
  if (/^(from|start|since|dateFrom|startDate)$/i.test(n)) return new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  if (/^(to|end|until|dateTo|endDate)$/i.test(n)) return new Date().toISOString().slice(0, 10);
  if (/^(q|search|query)$/i.test(n)) return 'pizza';
  if (/^(lat|latitude)$/i.test(n)) return '43.589';
  if (/^(lng|lon|longitude)$/i.test(n)) return '-79.6441';
  if (/^date$/i.test(n)) return new Date().toISOString().slice(0, 10);
  if (/sessionToken/i.test(n)) return 'openapi-observer';
  if (/limit|size/i.test(n)) return '5';
  if (/page/i.test(n)) return '1';
  if (p.schema?.type === 'boolean') return 'true';
  if (p.schema?.type === 'integer' || p.schema?.type === 'number') return '1';
  return undefined;
}

// ------------------------------------------------------------------------------------------------ run
const result = {};
const report = { ok: 0, nonJson: 0, noParam: 0, byStatus: {}, serverErrors: [] };

async function attempt(g) {
  const role = roleOf(g.path);
  const params = g.op.parameters || [];
  const pathParams = params.filter((x) => x.in === 'path');
  const candidates = pathParams.map((p) => paramValues(p.name, g.path, role));
  if (candidates.some((c) => !c.length)) {
    g.missing = pathParams[candidates.findIndex((c) => !c.length)].name;
    return 'noParam';
  }
  const order = [role, ...(FALLBACK[role] || [])].filter((as) => !as || tokens[as]);
  if (!order.length) return 'noToken';
  const queryNames = params.filter((x) => x.in === 'query');
  let last = null;
  let usedQuery = [];
  // try up to 3 candidate ids for the path parameters (the first one that is not rejected wins)
  for (let attemptNo = 0; attemptNo < 3; attemptNo++) {
    let url = g.path;
    pathParams.forEach((p, i) => (url = url.replace(`{${p.name}}`, encodeURIComponent(candidates[i][Math.min(attemptNo, candidates[i].length - 1)]))));
    const base = ORIGIN + url;
    for (const as of order) {
      last = await get(base, as);
      if (last.status === 401 || last.status === 403) continue;
      last.as = as;
      // 400: maybe a query parameter is really required; fill the ones the message names
      if (last.status === 400 && last.json?.message) {
        const msg = String(Array.isArray(last.json.message) ? last.json.message.join(' ') : last.json.message);
        const needed = queryNames.filter((p) => new RegExp('\\b' + p.name + '\\b', 'i').test(msg));
        // a route can demand a parameter the generated spec does not declare at all (it reads the request object directly)
        if (!needed.some((p) => p.name === 'restaurantId') && /\brestaurantId\b/.test(msg)) needed.push({ name: 'restaurantId', in: 'query', schema: { type: 'string' } });
        const qs = new URLSearchParams();
        let ok = needed.length > 0;
        for (const p of needed) {
          const v = p.name === 'restaurantId' ? paramValues('restaurantId', '/x/{restaurantId}', 'restaurant')[0] ?? paramValues('restaurantId', '/restaurants/{restaurantId}', 'admin')[0] : queryValue(p);
          if (v === undefined) ok = false;
          else qs.set(p.name, v);
        }
        if (ok) {
          const retry = await get(base + '?' + qs, as);
          if (retry.status === 200) {
            retry.as = as;
            last = retry;
            usedQuery = needed.map((p) => p.name);
          }
        }
      }
      break;
    }
    if (!last || last.status !== 400 || pathParams.length === 0) break; // another id only helps routes that have one
    if (!/invalid|uuid|identifier/i.test(String(last.json?.message || ''))) break;
  }
  if (!last) return 'noToken';
  report.byStatus[last.status] = (report.byStatus[last.status] || 0) + 1;
  if (last.status >= 500) report.serverErrors.push(`${g.key} -> ${last.status}`);
  if (last.status !== 200) return `status ${last.status}${last.json?.message ? ': ' + String(Array.isArray(last.json.message) ? last.json.message[0] : last.json.message).slice(0, 90) : ''}`;
  if (last.nonJson) {
    report.nonJson++;
    return `non-json ${last.nonJson}`;
  }
  mine(g.path, last.json, last.as);
  // query parameters the route demanded (restaurantId is only needed for accounts with several locations: documented as optional)
  const required = usedQuery.filter((n) => n !== 'restaurantId');
  const undeclared = usedQuery.filter((n) => !queryNames.some((p) => p.name === n));
  result[g.key] = { as: last.as || 'public', ...(required.length ? { requiredQuery: required } : {}), ...(undeclared.length ? { undeclaredQuery: undeclared } : {}), schema: infer(last.json), example: example(last.json) };
  report.ok++;
  return 'ok';
}

console.log(`signing in (${API}) ...`);
for (const role of Object.keys(ACCOUNTS)) await login(role);
console.log(`signed in as: ${Object.keys(tokens).join(', ') || 'nobody'}; ${gets.length} GET routes`);

let pending = gets;
const outcome = {};
for (let pass = 1; pass <= 5 && pending.length; pass++) {
  const still = [];
  let progressed = 0;
  // routes without path parameters first: they feed the id pools of the next ones
  pending.sort((a, b) => (a.path.includes('{') ? 1 : 0) - (b.path.includes('{') ? 1 : 0));
  for (let i = 0; i < pending.length; i += 4) {
    const batch = pending.slice(i, i + 4);
    const res = await Promise.all(batch.map((g) => attempt(g).catch((e) => `error ${e.message}`)));
    res.forEach((r, k) => {
      outcome[batch[k].key] = r;
      if (r === 'ok') progressed++;
      else if (r === 'noParam') still.push(batch[k]);
    });
  }
  console.log(`pass ${pass}: ${progressed} new answers, ${still.length} routes still waiting for an id`);
  if (!progressed) break;
  pending = still;
}

fs.writeFileSync(
  path.join(DIR, 'openapi.responses.json'),
  JSON.stringify({ note: 'Response shapes inferred from GET answers on seeded DEMO data by backend/scripts/openapi-observe.mjs. Merged into openapi.json by `npm run openapi:export`.', operations: Object.fromEntries(Object.keys(result).sort().map((k) => [k, result[k]])) }, null, 2) + '\n',
);
const count = (f) => Object.values(outcome).filter(f).length;
console.log('\n=== coverage');
console.log(`GET routes: ${gets.length} | with an observed response: ${report.ok} (${Math.round((report.ok / gets.length) * 100)}%)`);
console.log(`not observed: no id/parameter available ${count((x) => x === 'noParam')}, answered 4xx ${count((x) => /^status 4/.test(x))}, non-JSON ${count((x) => /^non-json/.test(x))}, server errors ${report.serverErrors.length}, no token ${count((x) => x === 'noToken')}`);
console.log('statuses seen:', JSON.stringify(report.byStatus));
if (report.serverErrors.length) console.log('SERVER ERRORS (5xx on demo data: worth a look):\n  ' + report.serverErrors.join('\n  '));
if (process.env.VERBOSE) {
  console.log('WAITING FOR AN ID:');
  for (const g of gets) if (outcome[g.key] === 'noParam') console.log(`  ${g.key}  (needs {${g.missing}})`);
  console.log('ANSWERED 4xx / NON-JSON:');
  for (const g of gets) if (/^(status|non-json)/.test(outcome[g.key] || '')) console.log(`  ${g.key}  -> ${outcome[g.key]}`);
}
console.log(`written: ${path.join(DIR, 'openapi.responses.json')}`);
