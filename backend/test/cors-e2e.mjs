#!/usr/bin/env node
/**
 * CORS end-to-end check over real HTTP: a running API started with
 *   CORS_ORIGINS=https://app.forky.ca,https://forky.ca,https://*.forky.ca
 * must answer preflights and calls (HTTP and Socket.IO) for forky.ca and every subdomain, and refuse look-alikes and other sites.
 *   API_ORIGIN=http://localhost:4500 node backend/test/cors-e2e.mjs
 */
const ORIGIN = (process.env.API_ORIGIN || 'http://localhost:4500').replace(/\/$/, '');
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`); if (!ok) failed++; };
let ip = 30;
const call = (method, path, origin, extra = {}) => fetch(`${ORIGIN}${path}`, { method, headers: { 'x-forwarded-for': `10.66.7.${(ip = (ip % 250) + 1)}`, ...(origin ? { origin } : {}), ...extra } });
const acao = (r) => r.headers.get('access-control-allow-origin');

const allowed = ['https://app.forky.ca', 'https://forky.ca', 'https://shop.forky.ca', 'https://a.b.forky.ca', 'https://SHOP.forky.ca'];
const refused = ['https://evilforky.ca', 'https://forky.ca.evil.com', 'http://shop.forky.ca', 'https://shop.forky.ca:8443', 'https://example.com', 'http://localhost:3000'];

for (const o of allowed) {
  const g = await call('GET', '/api/v1/public/site', o);
  check(`GET from ${o}: allowed (Access-Control-Allow-Origin = the origin, Vary: Origin)`, g.status === 200 && acao(g)?.toLowerCase() === o.toLowerCase() && /origin/i.test(g.headers.get('vary') || ''), [g.status, acao(g)]);
}
for (const o of refused) {
  const g = await call('GET', '/api/v1/public/site', o);
  check(`GET from ${o}: no CORS header (the browser blocks the answer)`, acao(g) === null, acao(g));
}
const pf = await call('OPTIONS', '/api/v1/auth/login', 'https://shop.forky.ca', { 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' });
check('preflight of a sign-in from a subdomain: 204 with the methods and headers the website needs', pf.status === 204 && acao(pf) === 'https://shop.forky.ca' && /POST/.test(pf.headers.get('access-control-allow-methods') || '') && /authorization/i.test(pf.headers.get('access-control-allow-headers') || '') && pf.headers.get('access-control-allow-credentials') === 'true', [pf.status, acao(pf), pf.headers.get('access-control-allow-methods')]);
const pfx = await call('OPTIONS', '/api/v1/auth/login', 'https://evilforky.ca', { 'access-control-request-method': 'POST' });
check('preflight from a look-alike: no allow header', acao(pfx) === null, acao(pfx));
for (const [m, p] of [['PATCH', '/api/v1/admin/site/general'], ['PUT', '/api/v1/admin/site/seo'], ['DELETE', '/api/v1/restaurant/menu/items/x']]) {
  const r = await call('OPTIONS', p, 'https://admin.forky.ca', { 'access-control-request-method': m, 'access-control-request-headers': 'authorization,content-type' });
  check(`preflight for ${m} ${p} from admin.forky.ca`, r.status === 204 && acao(r) === 'https://admin.forky.ca' && new RegExp(m).test(r.headers.get('access-control-allow-methods') || ''), [r.status, r.headers.get('access-control-allow-methods')]);
}
const none = await call('GET', '/api/v1/public/site', null);
check('a call without an Origin header (app, curl, server) still works', none.status === 200, none.status);
const ws = await call('GET', '/socket.io/?EIO=4&transport=polling', 'https://shop.forky.ca');
check('Socket.IO from a subdomain: allowed', ws.status === 200 && acao(ws) === 'https://shop.forky.ca', [ws.status, acao(ws)]);
const wsx = await call('GET', '/socket.io/?EIO=4&transport=polling', 'https://evilforky.ca');
check('Socket.IO from a look-alike: no CORS header', acao(wsx) === null, acao(wsx));
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall CORS end-to-end checks passed');
process.exit(failed ? 1 : 0);
