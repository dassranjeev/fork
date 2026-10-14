#!/usr/bin/env node
/**
 * FORKY security smoke test - plain Node 18+, no dependencies.
 *
 *   node test/security-smoke.mjs [API_BASE_URL]            (default http://localhost:4000/api/v1)
 *
 * Runs the key attack checks against a RUNNING backend and prints PASS / FAIL per check (exit code 1 on any FAIL):
 *   unauthenticated access, wrong-account-type access, IDOR / cross-tenant access, privilege escalation, mass assignment,
 *   SQL injection (error + time based), stored XSS, forged JWTs, brute-force lockout, rate-limit burst, oversized / deeply
 *   nested bodies, hostile uploads, CORS, webhook authentication.
 *
 * It needs the demo seed accounts (customer1/2, driver1, owner1/2, kitchen1, analyst, admin). Override with env:
 *   DEMO_PASSWORD (default Demo@12345)  ADMIN_EMAIL / ADMIN_PASSWORD (default admin@forky.ca / Admin@12345)
 * The login endpoint is limited to 10/min per IP, so the script logs in once per identity and waits out throttles.
 * Test data it creates is removed again. NEVER point it at production (it deliberately triggers lockouts and rate limits).
 */
import { createHmac } from 'node:crypto';

const BASE = (process.argv[2] || process.env.API || 'http://localhost:4000/api/v1').replace(/\/$/, '');
const ROOT = BASE.replace(/\/api\/v1$/, '');
const PW = process.env.DEMO_PASSWORD || 'Demo@12345';
const ADMIN = [process.env.ADMIN_EMAIL || 'admin@forky.ca', process.env.ADMIN_PASSWORD || 'Admin@12345'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  - ' + detail : ''}`);
};
const section = (s) => console.log(`\n--- ${s}`);

async function http(method, path, { token, body, headers = {}, raw } = {}) {
  const h = { ...headers };
  if (token) h.authorization = 'Bearer ' + token;
  let b;
  if (body !== undefined) {
    h['content-type'] = h['content-type'] || 'application/json';
    b = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const url = path.startsWith('http') ? path : BASE + path;
  const t0 = Date.now();
  try {
    const r = await fetch(url, { method, headers: h, body: b });
    const text = await r.text();
    let json;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, json, text, headers: r.headers, ms: Date.now() - t0 };
  } catch (e) {
    return { status: 0, json: undefined, text: String(e), headers: new Headers(), ms: Date.now() - t0 };
  }
}

async function login(label, identifier, password) {
  for (let i = 0; i < 4; i++) {
    const r = await http('POST', '/auth/login', { body: { identifier, password } });
    if ((r.status === 200 || r.status === 201) && r.json?.accessToken) return { token: r.json.accessToken, user: r.json.user };
    if (r.status === 429) { console.log(`  (login throttled for ${label}, waiting 62 s)`); await sleep(62000); continue; }
    console.log(`  cannot log in as ${label}: HTTP ${r.status} ${r.text.slice(0, 80)}`);
    return null;
  }
  return null;
}

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

(async () => {
  console.log(`FORKY security smoke test against ${BASE}`);
  const health = await http('GET', '/health');
  if (health.status !== 200) { console.log('API not reachable: ' + health.text); process.exit(2); }

  // ------------------------------------------------------------------------------------------------ headers
  section('transport & headers');
  check('X-Powered-By is not disclosed', !health.headers.get('x-powered-by'));
  check('X-Content-Type-Options: nosniff', health.headers.get('x-content-type-options') === 'nosniff');
  check('Content-Security-Policy present', !!health.headers.get('content-security-policy'));
  check('X-Frame-Options / frame-ancestors set', !!health.headers.get('x-frame-options'));
  check('API responses are not cacheable (Cache-Control: no-store)', (health.headers.get('cache-control') || '').includes('no-store'));
  const evil = await http('GET', '/health', { headers: { origin: 'http://evil.example' } });
  check('CORS: untrusted origin gets no Access-Control-Allow-Origin', !evil.headers.get('access-control-allow-origin'));
  const pre = await http('OPTIONS', '/auth/login', { headers: { origin: 'http://evil.example', 'access-control-request-method': 'POST' } });
  check('CORS preflight from untrusted origin is not approved', !pre.headers.get('access-control-allow-origin'));
  const nf = await http('GET', '/definitely/not/here');
  check('404 does not leak internals', nf.status === 404 && !/at .*\.(ts|js):\d+|node_modules|stack/i.test(nf.text));

  // ------------------------------------------------------------------------------------------------ logins
  section('logging in (demo accounts)');
  const who = {};
  for (const [k, id, pw] of [
    ['c1', 'customer1@demo.forky.ca', PW], ['c2', 'customer2@demo.forky.ca', PW], ['d1', 'driver1@demo.forky.ca', PW],
    ['o1', 'owner1@demo-restaurant.ca', PW], ['o2', 'owner2@demo-restaurant.ca', PW], ['k1', 'kitchen1@demo-restaurant.ca', PW],
    ['analyst', 'analyst@forky.ca', PW], ['admin', ADMIN[0], ADMIN[1]],
  ]) who[k] = (await login(k, id, pw)) || {};
  const T = Object.fromEntries(Object.entries(who).map(([k, v]) => [k, v.token]));
  console.log('  tokens:', Object.entries(T).map(([k, v]) => `${k}:${v ? 'ok' : 'MISSING'}`).join(' '));

  // ------------------------------------------------------------------------------------------------ unauthenticated
  section('unauthenticated access to protected routes');
  const U = '00000000-0000-4000-8000-000000000001';
  const protectedRoutes = [
    ['GET', '/auth/me'], ['GET', '/admin/dashboard'], ['GET', '/admin/customers'], ['GET', '/admin/orders'], ['GET', '/admin/finance/payouts'],
    ['GET', '/admin/staff'], ['GET', '/admin/settings'], ['GET', '/admin/audit-logs'], ['PUT', '/admin/settings'], ['POST', '/admin/roles'],
    ['GET', '/restaurant/orders'], ['GET', '/restaurant/finance/payouts'], ['GET', '/driver/earnings'], ['POST', '/driver/location'],
    ['GET', '/customer/orders'], ['GET', '/customer/addresses'], ['GET', '/customer/wallet'], ['POST', '/customer/orders'],
    ['GET', `/orders/${U}/tracking`], ['GET', '/notifications'], ['POST', '/uploads'], ['GET', '/admin/live-map'],
  ];
  let bad = [];
  for (const [m, p] of protectedRoutes) { const r = await http(m, p, { body: m === 'GET' ? undefined : {} }); if (r.status !== 401) bad.push(`${m} ${p} -> ${r.status}`); }
  check(`all ${protectedRoutes.length} protected sample routes return 401 without a token`, bad.length === 0, bad.join('; '));
  const swagger = await http('GET', ROOT + '/docs-json');
  console.log(`  info: Swagger JSON is ${swagger.status === 200 ? 'EXPOSED (fine in development; disabled when NODE_ENV=production)' : 'not exposed'}`);

  // ------------------------------------------------------------------------------------------------ wrong account type
  section('wrong account type (role confusion)');
  const cross = [
    ['customer -> /admin/customers', T.c1, '/admin/customers'], ['customer -> /restaurant/orders', T.c1, '/restaurant/orders'], ['customer -> /driver/earnings', T.c1, '/driver/earnings'],
    ['driver -> /customer/orders', T.d1, '/customer/orders'], ['driver -> /admin/orders', T.d1, '/admin/orders'], ['restaurant -> /admin/staff', T.o1, '/admin/staff'],
    ['restaurant -> /driver/earnings', T.o1, '/driver/earnings'], ['kitchen -> /admin/dashboard', T.k1, '/admin/dashboard'], ['analyst(staff) -> /admin/staff', T.analyst, '/admin/staff'],
  ];
  bad = [];
  for (const [n, tok, p] of cross) { const r = await http('GET', p, { token: tok }); if (r.status !== 403) bad.push(`${n} -> ${r.status}`); }
  check('cross-type requests are refused with 403', bad.length === 0, bad.join('; '));

  // ------------------------------------------------------------------------------------------------ IDOR
  section('IDOR / cross-tenant access');
  const c1Orders = await http('GET', '/customer/orders?limit=1', { token: T.c1 });
  const orderId = c1Orders.json?.data?.[0]?.id;
  if (orderId) {
    let r = await http('GET', `/customer/orders/${orderId}`, { token: T.c2 });
    check("customer2 cannot read customer1's order", r.status === 404 || r.status === 403, 'HTTP ' + r.status);
    r = await http('GET', `/orders/${orderId}/tracking`, { token: T.c2 });
    check("customer2 cannot read customer1's order tracking", r.status === 403 || r.status === 404, 'HTTP ' + r.status);
    r = await http('GET', `/orders/${orderId}/messages`, { token: T.c2 });
    check("customer2 cannot read customer1's order chat", r.status === 403 || r.status === 404, 'HTTP ' + r.status);
    r = await http('POST', `/customer/orders/${orderId}/cancel`, { token: T.c2, body: { reason: 'idor' } });
    check("customer2 cannot cancel customer1's order", r.status === 404 || r.status === 403, 'HTTP ' + r.status);
    r = await http('PATCH', `/customer/orders/${orderId}/tip`, { token: T.c2, body: { tip: 5 } });
    check("customer2 cannot change customer1's tip", r.status === 404 || r.status === 403, 'HTTP ' + r.status);
    r = await http('POST', '/customer/support/tickets', { token: T.c2, body: { orderId, subject: 'idor probe', body: 'x' } });
    check("customer2 cannot open a ticket on customer1's order", r.status === 404 || r.status === 403, 'HTTP ' + r.status);
    r = await http('POST', `/driver/trip/${orderId}/delivered`, { token: T.d1, body: {} });
    check("driver1 cannot complete an order that is not assigned to them", r.status === 404 || r.status === 403 || r.status === 400, 'HTTP ' + r.status);
    r = await http('GET', `/orders/${orderId}/tracking`, { token: T.analyst });
    check('staff WITHOUT the orders permission cannot read order tracking (PIN / phone numbers)', r.status !== 200 || !!who.analyst?.user?.permissions?.orders?.includes('view'), 'HTTP ' + r.status);
  } else console.log('  (customer1 has no orders - order IDOR checks skipped)');
  const addr = await http('GET', '/customer/addresses', { token: T.c1 });
  const addrId = (addr.json?.data || addr.json)?.[0]?.id;
  if (addrId) {
    const r = await http('PATCH', `/customer/addresses/${addrId}`, { token: T.c2, body: { line1: 'hijacked' } });
    check("customer2 cannot edit customer1's address", r.status === 404 || r.status === 403, 'HTTP ' + r.status);
  }
  const o1rids = who.o1?.user?.restaurantIds || [];
  if (o1rids.length) {
    let r = await http('GET', `/restaurant/orders?restaurantId=${o1rids[0]}`, { token: T.o2 });
    check("merchant 2 cannot read merchant 1's orders via ?restaurantId= tampering", r.status === 403 || r.status === 404, 'HTTP ' + r.status);
    r = await http('GET', `/restaurant/menu?restaurantId=${o1rids[0]}`, { token: T.o2 });
    check("merchant 2 cannot read merchant 1's menu via ?restaurantId= tampering", r.status === 403 || r.status === 404, 'HTTP ' + r.status);
    r = await http('PATCH', `/restaurant/store?restaurantId=${o1rids[0]}`, { token: T.o2, body: { description: 'defaced' } });
    check("merchant 2 cannot edit merchant 1's store", r.status === 403 || r.status === 404, 'HTTP ' + r.status);
  }
  for (const [n, p] of [['finance/payouts', '/restaurant/finance/payouts'], ['finance/dashboard', '/restaurant/finance/dashboard'], ['reports/payouts', '/restaurant/reports/payouts']]) {
    const r = await http('GET', p + (o1rids[0] ? `?restaurantId=${o1rids[0]}` : ''), { token: T.k1 });
    check(`KITCHEN role cannot read ${n} (owner-only)`, r.status === 403, 'HTTP ' + r.status);
  }
  const ks = await http('GET', `/restaurant/store${o1rids[0] ? '?restaurantId=' + o1rids[0] : ''}`, { token: T.k1 });
  check('KITCHEN role does not receive tablet code / POS credentials / commission terms', ks.status !== 200 || (!('tabletCode' in ks.json) && !('integrations' in ks.json) && !('deliveryCommissionPct' in ks.json)));

  // ------------------------------------------------------------------------------------------------ privilege escalation / settings
  section('privilege escalation');
  let r = await http('POST', '/admin/roles', { token: T.analyst, body: { name: 'evil', permissions: { staff: ['view'] } } });
  check('read-only staff cannot create a role', r.status === 403, 'HTTP ' + r.status);
  r = await http('PUT', '/admin/settings', { token: T.analyst, body: { values: { 'security.enforce2faStaff': false } } });
  check('read-only staff cannot change settings', r.status === 403, 'HTTP ' + r.status);
  if (T.admin) {
    r = await http('PUT', '/admin/settings', { token: T.admin, body: { values: { 'orders.maxTip': 'not-a-number' } } });
    check('settings values must keep their type (string for a numeric setting is rejected)', r.status === 400, 'HTTP ' + r.status);
    r = await http('POST', '/admin/orders/' + U + '/refund', { token: T.admin, body: { amount: 'abc', chargedTo: 'PLATFORM', reasonCode: 'x' } });
    check('refund amount "abc" (NaN bypass) is rejected', r.status === 400, 'HTTP ' + r.status);
    r = await http('POST', '/admin/orders/' + U + '/refund', { token: T.admin, body: { amount: 1e12, chargedTo: 'PLATFORM', reasonCode: 'x' } });
    check('refund amount 1e12 is rejected', r.status === 400, 'HTTP ' + r.status);
  }

  // ------------------------------------------------------------------------------------------------ mass assignment
  section('mass assignment');
  r = await http('PATCH', '/auth/me', { token: T.c2, body: { firstName: 'Noah', type: 'SUPER_ADMIN', walletBalance: 99999, roleId: U, status: 'ACTIVE', passwordHash: 'x' } });
  check('unknown/privileged fields on PATCH /auth/me are rejected', r.status === 400, 'HTTP ' + r.status);
  r = await http('POST', '/customer/orders', { token: T.c2, body: { type: 'DELIVERY', paymentMethod: 'CARD', total: 0.01, subtotal: 0.01, deliveryFee: 0, discountTotal: 999 } });
  check('client-supplied prices / totals on checkout are rejected', r.status === 400, 'HTTP ' + r.status);
  r = await http('POST', '/auth/customer/register', { body: { firstName: 'a', lastName: 'b', email: `mass${Date.now()}@example.com`, password: 'Str0ngPass!2026x', type: 'SUPER_ADMIN' } });
  check('registration cannot choose the account type', r.status === 400, 'HTTP ' + r.status);

  // ------------------------------------------------------------------------------------------------ injection
  section('SQL injection (error- and time-based)');
  const sqli = ["' OR '1'='1", "'; SELECT pg_sleep(4);--", '1) OR pg_sleep(4) IS NULL--', 'createdAt; SELECT pg_sleep(4)'];
  let slow = [], errs = [];
  for (const pl of sqli) {
    const q = encodeURIComponent(pl);
    for (const [tok, p] of [[T.admin, `/admin/customers?search=${q}&sortBy=${q}&sortDir=${q}`], [T.admin, `/admin/orders?search=${q}&status=${q}&sortBy=${q}`], [T.admin, `/admin/analytics/executive?groupBy=${q}&sortBy=${q}&tz=${q}`],
      [null, `/public/search?q=${q}&sort=${q}&cuisine=${q}`], [T.c1, `/customer/orders?status=${q}&sortBy=${q}&sortDir=${q}`], [T.admin, `/admin/finance/ledger?search=${q}&type=${q}&sortDir=${q}`]]) {
      if (!tok && p.startsWith('/admin')) continue;
      const x = await http('GET', p, { token: tok });
      if (x.ms > 3500) slow.push(`${p.split('?')[0]} ${x.ms}ms`);
      if (x.status >= 500 || /syntax error|QueryFailed|pg_|relation "|column "/i.test(x.text.replace(/pg_sleep/g, ''))) errs.push(`${p.split('?')[0]} -> ${x.status}`);
    }
  }
  check('injected pg_sleep never executes (no response > 3.5 s)', slow.length === 0, slow.join('; '));
  check('injection payloads never cause 5xx / SQL error leakage', errs.length === 0, errs.join('; '));
  r = await http('POST', '/auth/login', { body: { identifier: { $ne: null }, password: { $gt: '' } } });
  check('NoSQL-style object payload on login is rejected (400)', r.status === 400, 'HTTP ' + r.status);
  r = await http('GET', '/admin/customers?sortBy=__proto__&sortDir=ASC;DROP%20TABLE%20users', { token: T.admin });
  check('sortBy=__proto__ / sortDir injection does not 500', r.status < 500, 'HTTP ' + r.status);
  r = await http('POST', '/auth/customer/register', { body: JSON.parse('{"firstName":"a","lastName":"b","email":"proto@example.com","password":"Str0ngPass!2026x","__proto__":{"isAdmin":true}}') });
  check('prototype-pollution key is rejected', r.status === 400, 'HTTP ' + r.status);

  // ------------------------------------------------------------------------------------------------ XSS
  section('stored XSS');
  const payload = '<img src=x onerror=alert(document.cookie)><script>alert(1)</script>"><svg/onload=alert(1)>';
  const orig = who.c2?.user?.firstName || 'Noah';
  r = await http('PATCH', '/auth/me', { token: T.c2, body: { firstName: payload + 'Noah', lastName: 'Patel' } });
  const stored = JSON.stringify(r.json || {});
  check('HTML in a profile name is stripped before it is stored', r.status === 200 && !/<\s*(script|img|svg)|onerror|onload/i.test(stored), stored.slice(0, 80));
  await http('PATCH', '/auth/me', { token: T.c2, body: { firstName: orig, lastName: who.c2?.user?.lastName || 'Patel' } });
  r = await http('POST', '/customer/support/tickets', { token: T.c2, body: { subject: payload, body: payload, attachments: ['javascript:alert(1)', 'https://evil.example/uploads/x.png'] } });
  check('ticket subject/body/attachments are neutralised', r.status < 300 && !/<\s*(script|img|svg)|onerror|javascript:/i.test(JSON.stringify(r.json)) && (r.json?.attachments || []).length === 0, 'HTTP ' + r.status);
  if (T.admin) {
    r = await http('POST', '/admin/banners', { token: T.admin, body: { title: 'x', imageUrl: 'javascript:alert(1)' } });
    check('javascript: URL in an image field is rejected', r.status === 400, 'HTTP ' + r.status);
  }

  // ------------------------------------------------------------------------------------------------ uploads
  section('hostile uploads');
  const up = async (name, buf, type) => {
    const fd = new FormData();
    fd.append('file', new Blob([buf], { type }), name);
    const x = await fetch(BASE + '/uploads', { method: 'POST', headers: { authorization: 'Bearer ' + T.c1 }, body: fd });
    return { status: x.status, json: await x.json().catch(() => ({})) };
  };
  r = await up('x.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script></svg>'), 'image/svg+xml');
  check('SVG upload (script carrier) is rejected', r.status === 415, 'HTTP ' + r.status);
  r = await up('x.png', Buffer.from('<html><script>alert(1)</script></html>'), 'image/png');
  check('HTML disguised as PNG is rejected (magic-byte check)', r.status === 415, 'HTTP ' + r.status);
  r = await up('x.html', Buffer.from('<script>alert(1)</script>'), 'text/html');
  check('.html upload is rejected', r.status === 415, 'HTTP ' + r.status);

  // ------------------------------------------------------------------------------------------------ JWT
  section('JWT forgery');
  const adminId = who.admin?.user?.id || U;
  const forged = [
    ['alg=none', `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: adminId, type: 'SUPER_ADMIN', exp: 9999999999 })}.`],
    ['signed with a well-known secret', (() => { const h = b64({ alg: 'HS256', typ: 'JWT' }); const p = b64({ sub: adminId, type: 'SUPER_ADMIN', iss: 'forky-api', aud: 'forky-clients', exp: 9999999999 }); return `${h}.${p}.${createHmac('sha256', 'change-me-to-a-long-random-string').update(h + '.' + p).digest('base64url')}`; })()],
    ['garbage', 'abc.def.ghi'],
  ];
  bad = [];
  for (const [n, tk] of forged) { const x = await http('GET', '/admin/dashboard', { token: tk }); if (x.status !== 401) bad.push(`${n} -> ${x.status}`); }
  check('forged / malformed tokens are rejected (401)', bad.length === 0, bad.join('; '));

  // ------------------------------------------------------------------------------------------------ webhook
  section('webhooks');
  r = await http('POST', '/public/webhooks/certn', { body: { ref: 'mock_x', status: 'clear' } });
  check('Certn webhook rejects unauthenticated calls', r.status === 401 || r.status === 403, 'HTTP ' + r.status);

  // ------------------------------------------------------------------------------------------------ body limits
  section('request size limits');
  r = await http('POST', '/auth/login', { body: JSON.stringify({ identifier: 'a', password: 'b'.repeat(400 * 1024) }) });
  check('400 KB JSON body is rejected (413)', r.status === 413, 'HTTP ' + r.status);
  r = await http('POST', '/customer/support/tickets', { token: T.c1, body: '{"a":'.repeat(40) + '1' + '}'.repeat(40) });
  check('40-level nested JSON is rejected (400)', r.status === 400, 'HTTP ' + r.status);
  r = await http('POST', '/customer/support/tickets', { token: T.c1, body: { subject: 's', tags: new Array(3000).fill('x') } });
  check('3000-element array is rejected (400)', r.status === 400, 'HTTP ' + r.status);
  r = await http('GET', '/public/search?q=' + 'a'.repeat(70000));
  check('70 KB query string is rejected (431/414)', r.status === 431 || r.status === 414 || r.status === 400, 'HTTP ' + r.status);
  r = await http('GET', '/admin/customers?limit=100000&page=99999999', { token: T.admin });
  check('absurd pagination (limit=100000, page=99999999) is rejected', r.status === 400, 'HTTP ' + r.status);

  // ------------------------------------------------------------------------------------------------ brute force & rate limits (last: they lock things)
  section('brute force & rate limiting');
  const victim = `smoke-victim-${Date.now() % 1e6}@example.com`;
  const codes = [];
  for (let i = 0; i < 9; i++) codes.push((await http('POST', '/auth/login', { body: { identifier: victim, password: 'Wrong-Pass-' + i }, headers: { 'x-forwarded-for': `198.51.100.${i + 10}` } })).status);
  check('repeated wrong passwords end in HTTP 429 even when X-Forwarded-For is rotated', codes.includes(429), codes.join(','));
  const known = await http('POST', '/auth/login', { body: { identifier: 'nobody-here@example.com', password: 'Wrong-Pass-1' }, headers: { 'x-forwarded-for': '198.51.100.99' } });
  check('login failure for unknown accounts is generic (no enumeration)', known.status === 401 || known.status === 429, 'HTTP ' + known.status + ' ' + (known.json?.message || ''));
  await sleep(1000);
  const burst = await Promise.all(Array.from({ length: 220 }, () => http('GET', '/public/cities')));
  const n429 = burst.filter((x) => x.status === 429).length;
  check('burst of 220 anonymous requests from one IP is throttled (429)', n429 > 0, `${n429} x 429, ${burst.filter((x) => x.status === 200).length} x 200`);
  check('throttled responses carry Retry-After', burst.filter((x) => x.status === 429).some((x) => x.headers.get('retry-after')));
  const after = await http('GET', '/customer/addresses', { token: T.c2 });
  check('an authenticated user of the same IP is unaffected by the anonymous flood', after.status === 200, 'HTTP ' + after.status);

  const failed = results.filter((x) => !x.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? ' - FAILED: ' + failed.map((f) => f.name).join(' | ') : ''}`);
  process.exit(failed.length ? 1 : 0);
})();

