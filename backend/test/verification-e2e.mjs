#!/usr/bin/env node
/**
 * Registration / verification end-to-end test: REAL HTTP against a running API plus direct database access (to move deadlines and to
 * simulate a driver on a trip). It CHANGES the registration policy and creates drivers and restaurants, so run it against a SCRATCH
 * database only (the script refuses to start unless VERIFICATION_E2E_SCRATCH=1):
 *
 *   # scratch database from the migrations + seed, API on its own port:
 *   DB_NAME=forksy_ver DB_SYNC=false npm run migration:run && DB_NAME=forksy_ver DB_SYNC=false npm run seed
 *   DB_NAME=forksy_ver DB_SYNC=false PORT=4100 TRUST_PROXY=1 CERTN_MOCK_DELAY_MS=1500 CERTN_WEBHOOK_SECRET=e2e-secret CERTN_API_KEY= \
 *     npx ts-node --transpile-only -r tsconfig-paths/register src/main.ts
 *   # then:
 *   VERIFICATION_E2E_SCRATCH=1 API=http://localhost:4100/api/v1 DB_NAME=forksy_ver ADMIN_PASSWORD=... DEMO_PASSWORD=... \
 *     CERTN_WEBHOOK_SECRET=e2e-secret node backend/test/verification-e2e.mjs
 *
 * The API must run with TRUST_PROXY=1 (each registration is sent from its own X-Forwarded-For address, which keeps the sign-up
 * rate limits out of the way) and the mock Certn provider (CERTN_API_KEY empty) with a delay of about 1.5 s.
 * Optional: ADMIN_EMAIL (default admin@forksy.ca), DB_HOST / DB_PORT / DB_USER / DB_PASSWORD (default localhost:5432 postgres/postgres).
 * Prints PASS / FAIL per check and exits 1 on any FAIL. The policy is put back to the defaults at the end.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const requireFromBackend = createRequire(path.join(here, '..', 'package.json'));
const { Client } = requireFromBackend('pg');

if (process.env.VERIFICATION_E2E_SCRATCH !== '1') {
  console.error('This test changes the registration policy and creates accounts: run it against a scratch database and set VERIFICATION_E2E_SCRATCH=1 (see the header).');
  process.exit(2);
}
const API = (process.env.API || 'http://localhost:4100/api/v1').replace(/\/$/, '');
const ADMIN = { identifier: process.env.ADMIN_EMAIL || 'admin@forksy.ca', password: process.env.ADMIN_PASSWORD };
const DEMO = process.env.DEMO_PASSWORD;
const WEBHOOK_SECRET = process.env.CERTN_WEBHOOK_SECRET || '';
if (!ADMIN.password || !DEMO) {
  console.error('Set ADMIN_PASSWORD and DEMO_PASSWORD (see the header of this file).');
  process.exit(2);
}

let failed = 0;
let passed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : detail ? `  -> ${detail}` : ''}`);
  ok ? passed++ : failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (v) => JSON.stringify(v)?.slice(0, 220);

let ipCounter = 10;
const nextIp = () => `10.77.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`;
const api = async (method, p, token, body, headers = {}) => {
  const r = await fetch(API + p, {
    method,
    headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp(), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null;
  try {
    j = await r.json();
  } catch {
    /* empty body */
  }
  return { s: r.status, j };
};
const login = async (identifier, password, app) => {
  const r = await api('POST', '/auth/login', null, { identifier, password, app });
  if (!r.j?.accessToken) throw new Error(`login failed for ${identifier}: HTTP ${r.s} ${short(r.j)}`);
  return r.j.accessToken;
};
const waitFor = async (fn, ms = 12000, step = 300) => {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(step);
  }
  return last;
};

const db = new Client({
  host: process.env.DB_HOST || 'localhost',
  port: +(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  database: process.env.DB_NAME || 'forksy_ver',
});
await db.connect();
const sql = async (text, params) => (await db.query(text, params)).rows;

const RUN = Date.now().toString(36);
const STARTED = new Date(Date.now() - 2000); // rows of earlier runs (the scratch database is reused) must not count
let seq = 0;
const uniq = () => `${RUN}${++seq}`;
const phone = () => `+1647${String(Math.floor(1000000 + Math.random() * 8999999))}`;

// ------------------------------------------------------------------ accounts and helpers
const admin = await login(ADMIN.identifier, ADMIN.password, 'admin');
const driverOps = await login('driverops@forksy.ca', DEMO, 'admin');
const success = await login('success@forksy.ca', DEMO, 'admin');
const support = await login('support@forksy.ca', DEMO, 'admin'); // drivers:view and restaurants:view only
const marketing = await login('marketing@forksy.ca', DEMO, 'admin'); // no drivers permission at all
const customer = await login('customer1@demo.forksy.ca', DEMO, 'customer');
const cities = (await api('GET', '/public/cities')).j;
const city = (cities.data || cities)[0];
const adminMe = (await api('GET', '/auth/me', admin)).j;
// restaurant owners must normally enrol in 2FA before they get a session; the scratch instance lets new owners straight in (restored at the end)
const twoFa = await api('PUT', '/admin/settings', admin, { values: { 'security.enforce2faRestaurantOwner': false } });
if (twoFa.s !== 200) throw new Error(`could not relax the owner 2FA setting: HTTP ${twoFa.s} ${short(twoFa.j)}`);

const setPolicy = async (drivers, businesses) => api('PUT', '/admin/verification/policy', admin, { drivers, businesses });
const overview = async () => (await api('GET', '/admin/verification', admin)).j;

/** register a driver through the real sign-up flow; returns { token, profileId, userId, email, res } */
async function registerDriver(tag, { emailExtra = '' } = {}) {
  const ph = phone();
  const email = `e2e.${tag}${emailExtra}.${uniq()}@example.com`;
  const otp = await api('POST', '/auth/driver/otp', null, { phone: ph });
  const res = await api('POST', '/auth/driver/register', null, {
    firstName: `E2E${tag}`,
    lastName: 'Driver',
    phone: ph,
    email,
    password: 'Str0ng!Passw0rd#e2e',
    otpCode: otp.j?.devCode ?? '000000',
    cityId: city.id,
    vehicleType: 'CAR',
  });
  const token = res.j?.accessToken;
  const rows = await sql(`select dp.id, dp."userId" from driver_profiles dp join users u on u.id = dp."userId" where u.email = $1`, [email.toLowerCase()]);
  return { res, token, email, profileId: rows[0]?.id, userId: rows[0]?.userId };
}

/** apply as a restaurant through the real flow; returns { res, token, restaurantId, merchantId, email } */
async function applyRestaurant(tag, { emailExtra = '' } = {}) {
  const email = `e2e.r${tag}${emailExtra}.${uniq()}@example.com`;
  const res = await api('POST', '/auth/restaurant/apply', null, {
    ownerFirstName: `Owner${tag}`,
    ownerLastName: 'E2E',
    email,
    phone: phone(),
    password: 'Str0ng!Passw0rd#e2e',
    businessName: `E2E Business ${tag} ${RUN}`,
    restaurantName: `E2E Bistro ${tag} ${RUN}`,
    addressLine1: '1 City Centre Dr',
    city: 'Mississauga',
    postalCode: 'L5B 1M2',
    cityId: city.id,
  });
  const restaurantId = res.j?.restaurantId;
  const rows = restaurantId ? await sql(`select "merchantId" from restaurants where id = $1`, [restaurantId]) : [];
  return { res, token: res.j?.accessToken, tempToken: res.j?.tempToken, restaurantId, merchantId: rows[0]?.merchantId, email };
}

const driverRow = async (id) => (await sql(`select * from driver_profiles where id = $1`, [id]))[0];
const merchantRow = async (id) => (await sql(`select * from merchants where id = $1`, [id]))[0];
const restaurantRow = async (id) => (await sql(`select * from restaurants where id = $1`, [id]))[0];
const profile = async (token) => (await api('GET', '/driver/profile', token)).j;

try {
  console.log(`\n=== Access control ===`);
  {
    const targets = [
      ['GET', '/admin/verification'],
      ['PUT', '/admin/verification/policy', { drivers: { instant: false } }],
      ['GET', '/admin/verification/subjects?audience=DRIVER'],
      ['POST', '/admin/verification/force', { audience: 'DRIVER', all: true }],
      ['POST', '/admin/verification/sweep'],
    ];
    for (const [m, p, b] of targets) {
      const staff = await api(m, p, driverOps, b);
      check(`staff with the drivers permissions cannot ${m} ${p.split('?')[0]} (403)`, staff.s === 403, `HTTP ${staff.s}`);
    }
    const cust = await api('GET', '/admin/verification', customer);
    check('a customer cannot read the Verification page (403)', cust.s === 403, `HTTP ${cust.s}`);
    const anon = await api('GET', '/admin/verification');
    check('no token: 401', anon.s === 401, `HTTP ${anon.s}`);
    const ov = await api('GET', '/admin/verification', admin);
    check('the Super Admin can read it (200)', ov.s === 200 && ov.j?.drivers && ov.j?.businesses && ov.j?.certn, `HTTP ${ov.s} ${short(ov.j)}`);
    const dflt = ov.j;
    check('default policy: not instant, method MANUAL, for drivers and businesses', !dflt.drivers.policy.instant && dflt.drivers.policy.method === 'MANUAL' && dflt.drivers.policy.mode === 'MANUAL' && !dflt.businesses.policy.instant && dflt.businesses.policy.method === 'MANUAL', short(dflt.drivers.policy));
    check('Certn (mock) is ready in development', dflt.certn.ready === true && dflt.certn.mock === true, short(dflt.certn));
    check('every mode has a description for the page', ['INSTANT', 'MANUAL', 'AUTOMATIC'].every((m) => (dflt.drivers.policy.modes[m] || '').length > 20));
    check('seeded drivers and businesses were backfilled as verified (manual)', dflt.drivers.counts.VERIFIED >= 20 && dflt.businesses.counts.VERIFIED >= 20, short(dflt.drivers.counts));
    check('the Certn status never carries the secret', !JSON.stringify(dflt.certn).includes(WEBHOOK_SECRET || '\u0000none'));

    const list = await api('GET', '/admin/settings', admin);
    const groups = (list.j?.data || []).map((r) => r.group);
    check('the verification settings are not listed on the generic Settings page', !groups.includes('verification') && !(list.j?.data || []).some((r) => String(r.key).startsWith('verification.')));
    const generic = await api('PUT', '/admin/settings', admin, { values: { 'verification.drivers.instant': true } });
    check('the generic Settings endpoint refuses to change them, even for a Super Admin (400)', generic.s === 400, `HTTP ${generic.s} ${short(generic.j)}`);
    check('...and the policy did not change', !(await overview()).drivers.policy.instant);

    for (const [name, body] of [
      ['an empty body', {}],
      ['an unknown method', { drivers: { method: 'INSTANT' } }],
      ['a non-boolean instant', { drivers: { instant: 'yes' } }],
      ['the string "false" as instant (the global pipe would turn it into true)', { businesses: { instant: 'false' } }],
      ['an unknown field', { drivers: { instant: true, bogus: 1 } }],
      ['an unknown audience', { riders: { instant: true } }],
    ]) {
      const r = await api('PUT', '/admin/verification/policy', admin, body);
      check(`policy update rejects ${name} (400)`, r.s === 400, `HTTP ${r.s} ${short(r.j)}`);
    }
  }

  console.log(`\n=== Default policy (manual): sign-up behaves as before ===`);
  const dManual = await registerDriver('manual');
  const rManual = await applyRestaurant('manual');
  {
    check('driver sign-up works and returns tokens', !!dManual.token && dManual.res.s === 201, `HTTP ${dManual.res.s} ${short(dManual.res.j)}`);
    const v = dManual.res.j?.verification;
    check('driver sign-up answers with the verification result: mode MANUAL, status PENDING, account APPLIED', v?.mode === 'MANUAL' && v?.status === 'PENDING' && v?.accountStatus === 'APPLIED' && /reviewing/.test(v?.nextStep || ''), short(v));
    const row = await driverRow(dManual.profileId);
    check('stored: driver APPLIED, verification PENDING, method MANUAL', row.status === 'APPLIED' && row.verificationStatus === 'PENDING' && row.verificationMethod === 'MANUAL', short(row));
    const online = await api('POST', '/driver/online', dManual.token, {});
    check('a new manual driver cannot go online yet (400)', online.s === 400 && /APPLIED/.test(JSON.stringify(online.j)), `HTTP ${online.s} ${short(online.j)}`);
    check('GET /driver/profile carries the verification block', (await profile(dManual.token))?.verification?.status === 'PENDING');
    const clManual = (await api('GET', '/driver/checklist', dManual.token)).j;
    check('manual: the onboarding checklist is unchanged (nothing optional, documents and background check still to do)', clManual?.steps?.every((s) => !s.optional) && clManual.missing.includes('documents_uploaded') && clManual.missing.includes('background_check'), short(clManual?.missing));

    check('restaurant application works', !!(rManual.token || rManual.tempToken) && !!rManual.restaurantId, `HTTP ${rManual.res.s} ${short(rManual.res.j)}`);
    const rv = rManual.res.j?.verification;
    check('restaurant application answers with mode MANUAL, account APPLIED', rv?.mode === 'MANUAL' && rv?.accountStatus === 'APPLIED' && rv?.status === 'PENDING', short(rv));
    const m = await merchantRow(rManual.merchantId);
    const rr = await restaurantRow(rManual.restaurantId);
    check('stored: merchant PENDING / MANUAL, restaurant APPLIED, not accepting orders', m.verificationStatus === 'PENDING' && m.verificationMethod === 'MANUAL' && rr.status === 'APPLIED' && rr.acceptingOrders === false, short(m));
  }

  console.log(`\n=== Instant registration ===`);
  {
    const on = await setPolicy({ instant: true }, { instant: true });
    check('the Super Admin switches instant registration on for drivers and businesses', on.s === 200 && on.j?.drivers?.instant === true && on.j?.businesses?.instant === true, short(on.j));
    const ov = await overview();
    check('overview shows mode INSTANT and keeps the method MANUAL (used when verification is forced)', ov.drivers.policy.mode === 'INSTANT' && ov.drivers.policy.method === 'MANUAL' && ov.businesses.policy.mode === 'INSTANT');
    const audit = await sql(`select action, "actorId" from audit_logs where action = 'verification.policy_update' order by "createdAt" desc limit 1`);
    check('the policy change is in the audit log with the Super Admin as actor', audit[0]?.actorId === adminMe.id, short(audit));
  }
  const dI1 = await registerDriver('instant1');
  {
    const v = dI1.res.j?.verification;
    check('instant driver: mode INSTANT, account ACTIVE straight away, verification UNVERIFIED', v?.mode === 'INSTANT' && v?.accountStatus === 'ACTIVE' && v?.status === 'UNVERIFIED', short(v));
    const p = await profile(dI1.token);
    check('the driver profile is ACTIVE with zones assigned and no document needed', p?.status === 'ACTIVE' && p?.zoneIds?.length > 0, short({ status: p?.status, zones: p?.zoneIds?.length }));
    const row = await driverRow(dI1.profileId);
    check('stored: method INSTANT, UNVERIFIED, welcome boost sent, approvedAt set', row.verificationMethod === 'INSTANT' && row.verificationStatus === 'UNVERIFIED' && row.welcomeBoostSent === true && !!row.approvedAt);
    const blocked = await api('POST', '/driver/online', dI1.token, {});
    check('before the platform worker notice is acknowledged the only blocker is that notice (not documents, not approval)', blocked.s === 400 && /Ontario platform worker notice/.test(JSON.stringify(blocked.j)) && !/LICENCE|INSURANCE|Account status/.test(JSON.stringify(blocked.j)), short(blocked.j));
    const ack = await api('POST', '/driver/notice/ack', dI1.token, {});
    const online = await api('POST', '/driver/online', dI1.token, {});
    check('after acknowledging the notice the instant driver goes online: no extra step', ack.s === 201 && online.s === 201 && online.j?.isOnline === true, `ack ${ack.s} online ${online.s} ${short(online.j)}`);
    const clInstant = (await api('GET', '/driver/checklist', dI1.token)).j;
    const optKeys = (clInstant?.steps || []).filter((s) => s.optional).map((s) => s.key).sort().join();
    check('instant: what staff would have checked is optional in the onboarding checklist (documents, insurance, background check, training, bag); payout details stay to do', optKeys === 'background_check,documents_approved,documents_uploaded,insulated_bag,insurance_confirmed,training' && !clInstant.missing.includes('documents_uploaded') && !clInstant.missing.includes('training') && clInstant.missing.includes('bank') && clInstant.missing.includes('tax'), short({ optKeys, missing: clInstant?.missing }));
  }
  const rI1 = await applyRestaurant('instant1');
  {
    const v = rI1.res.j?.verification;
    check('instant business: mode INSTANT, restaurant LIVE straight away, verification UNVERIFIED', v?.mode === 'INSTANT' && v?.accountStatus === 'LIVE' && v?.status === 'UNVERIFIED', short(v));
    const m = await merchantRow(rI1.merchantId);
    const r = await restaurantRow(rI1.restaurantId);
    check('stored: restaurant LIVE and accepting orders, menu editing allowed, default commission tier set', r.status === 'LIVE' && r.acceptingOrders === true && r.menuEditStatus === 'ALLOWED' && !!r.commissionTierId && !!r.wentLiveAt, short({ s: r.status, a: r.acceptingOrders, me: r.menuEditStatus, tier: r.commissionTierId }));
    check('stored: merchant UNVERIFIED / INSTANT', m.verificationStatus === 'UNVERIFIED' && m.verificationMethod === 'INSTANT');
    const token = rI1.token;
    if (token) {
      const cat = await api('POST', '/restaurant/menu/categories', token, { name: 'Instant starters' });
      check('the new owner can build the menu immediately (menu editing was granted)', cat.s === 201, `HTTP ${cat.s} ${short(cat.j)}`);
    } else {
      check('the owner got a session (or must set up 2FA first)', !!rI1.tempToken, short(rI1.res.j));
    }
    const view = await api('GET', `/admin/restaurants/${rI1.restaurantId}`, admin);
    check('the admin restaurant view carries the business verification state', view.j?.verification?.status === 'UNVERIFIED', short(view.j?.verification));
  }

  console.log(`\n=== Lists, filters and the Verification table ===`);
  {
    const d = await api('GET', '/admin/drivers?verification=UNVERIFIED&limit=50', driverOps);
    check('the drivers list filters by verification and carries the field', d.s === 200 && d.j.data.some((x) => x.id === dI1.profileId && x.verificationStatus === 'UNVERIFIED' && x.verificationMethod === 'INSTANT'), `HTTP ${d.s} ${short(d.j?.data?.length)}`);
    const bad = await api('GET', '/admin/drivers?verification=BOGUS', driverOps);
    check('an unknown verification filter is rejected (400)', bad.s === 400);
    const r = await api('GET', '/admin/restaurants?verification=UNVERIFIED&limit=50', success);
    check('the restaurants list filters by the business verification and carries it on each row', r.s === 200 && r.j.data.some((x) => x.id === rI1.restaurantId && x.verification?.status === 'UNVERIFIED'), `HTTP ${r.s}`);
    const mer = await api('GET', '/admin/restaurants/merchants?verification=UNVERIFIED', success);
    check('the merchants list filters by verification', mer.s === 200 && mer.j.data.some((x) => x.id === rI1.merchantId), `HTTP ${mer.s}`);
    const subs = await api('GET', '/admin/verification/subjects?audience=DRIVER&status=UNVERIFIED', admin);
    check('Super Admin table: unverified drivers include the instant one', subs.s === 200 && subs.j.data.some((x) => x.id === dI1.profileId && x.operating === true), `HTTP ${subs.s}`);
    const subsB = await api('GET', '/admin/verification/subjects?audience=BUSINESS&status=UNVERIFIED', admin);
    check('Super Admin table: unverified businesses include the instant one', subsB.s === 200 && subsB.j.data.some((x) => x.id === rI1.merchantId && x.operating === true && x.owner), `HTTP ${subsB.s}`);
    const search = await api('GET', `/admin/verification/subjects?audience=DRIVER&search=${encodeURIComponent('E2Einstant1')}`, admin);
    check('the table can be searched by name', search.j?.data?.some((x) => x.id === dI1.profileId));
    const noAud = await api('GET', '/admin/verification/subjects', admin);
    check('the table needs an audience (400)', noAud.s === 400);
    const detail = await api('GET', `/admin/verification/drivers/${dI1.profileId}`, driverOps);
    check('staff with drivers:view can read one driver\'s verification card with the checklist', detail.s === 200 && detail.j.gates?.length === 3 && detail.j.canVerify === true && detail.j.verification.effectiveMethod === 'MANUAL', short(detail.j?.gates));
    const noPerm = await api('GET', `/admin/verification/drivers/${dI1.profileId}`, marketing);
    check('a staff account without the drivers permission cannot read it (403)', noPerm.s === 403, `HTTP ${noPerm.s}`);
    const viewOnly = await api('POST', `/admin/verification/drivers/${dI1.profileId}/verify`, support, {});
    check('a view-only account (drivers:view without approve) cannot verify (403)', viewOnly.s === 403, `HTTP ${viewOnly.s}`);
    const viewOnlyB = await api('POST', `/admin/verification/businesses/${rI1.merchantId}/start-check`, support, {});
    check('...nor start a Certn check on a business (403)', viewOnlyB.s === 403, `HTTP ${viewOnlyB.s}`);
    const badId = await api('GET', '/admin/verification/drivers/not-a-uuid', driverOps);
    check('a malformed id is a 400, not a 500', badId.s === 400, `HTTP ${badId.s}`);
    const ghost = await api('GET', '/admin/verification/drivers/00000000-0000-4000-8000-000000000000', driverOps);
    check('an unknown id is a 404', ghost.s === 404, `HTTP ${ghost.s}`);
  }

  console.log(`\n=== Force verification: input rules ===`);
  {
    const cases = [
      ['neither ids nor all', { audience: 'DRIVER' }],
      ['both ids and all', { audience: 'DRIVER', all: true, ids: [dI1.profileId] }],
      ['an empty ids list', { audience: 'DRIVER', ids: [] }],
      ['a non-uuid id', { audience: 'DRIVER', ids: ['x'] }],
      ['more than 90 days of grace', { audience: 'DRIVER', all: true, graceDays: 91 }],
      ['negative grace', { audience: 'DRIVER', all: true, graceDays: -1 }],
      ['an unknown audience', { audience: 'RIDER', all: true }],
      ['an unknown method', { audience: 'DRIVER', all: true, method: 'INSTANT' }],
      ['the string "false" as all (the global pipe would turn it into true and force everyone)', { audience: 'DRIVER', all: 'false' }],
    ];
    for (const [name, body] of cases) {
      const r = await api('POST', '/admin/verification/force', admin, body);
      check(`force rejects ${name} (400)`, r.s === 400, `HTTP ${r.s} ${short(r.j)}`);
    }
    const ghost = await api('POST', '/admin/verification/force', admin, { audience: 'DRIVER', ids: ['00000000-0000-4000-8000-000000000000'] });
    check('an unknown id is skipped, not an error', ghost.s === 201 && ghost.j.outcomes.SKIPPED === 1 && ghost.j.matched === 0, short(ghost.j));
    const verified = (await sql(`select id from driver_profiles where "verificationStatus" = 'VERIFIED' limit 1`))[0];
    const skip = await api('POST', '/admin/verification/force', admin, { audience: 'DRIVER', ids: [verified.id] });
    check('an already verified account is never forced', skip.j?.outcomes?.SKIPPED === 1 && /already VERIFIED/.test(skip.j?.items?.[0]?.note || ''), short(skip.j));
  }

  console.log(`\n=== Force verification (manual method) with a deadline ===`);
  {
    const f = await api('POST', '/admin/verification/force', admin, { audience: 'DRIVER', ids: [dI1.profileId], graceDays: 7, reason: 'e2e' });
    check('forcing with 7 days of grace: the driver keeps working until the deadline', f.s === 201 && f.j.outcomes.GRACE === 1 && f.j.matched === 1 && f.j.method === 'MANUAL', `HTTP ${f.s} ${short(f.j)}`);
    const row = await driverRow(dI1.profileId);
    const due = new Date(row.verificationDueAt).getTime();
    check('stored: PENDING, method MANUAL, forced now, due in about 7 days, still ACTIVE and online', row.verificationStatus === 'PENDING' && row.verificationMethod === 'MANUAL' && row.status === 'ACTIVE' && row.isOnline === true && Math.abs(due - (Date.now() + 7 * 86400e3)) < 60e3 && !!row.verificationForcedAt, short(row));
    const p = await profile(dI1.token);
    check('the driver is told what to do and by when', p?.verification?.status === 'PENDING' && /finish by/i.test(p?.verification?.nextStep || '') && !!p?.verification?.dueAt, short(p?.verification));
    const again = await api('POST', '/admin/verification/force', admin, { audience: 'DRIVER', ids: [dI1.profileId] });
    check('forcing the same driver twice does nothing the second time', again.j?.outcomes?.SKIPPED === 1 && /already PENDING/.test(again.j?.items?.[0]?.note || ''), short(again.j));
    const note = await waitFor(async () => (await sql(`select title, body from notifications where "userId" = $1 and event = 'verification.required' and channel = 'IN_APP'`, [dI1.userId]))[0], 4000);
    check('the driver got a "verification required" notification with the deadline', !!note && /Verification required/.test(note.title) && /by 20\d\d-\d\d-\d\d/.test(note.body) && /upload your documents/i.test(note.body), short(note));
    const a = await sql(`select action, after from audit_logs where action = 'verification.force' and (after->>'graceDays')::int = 7 order by "createdAt" desc limit 1`);
    check('the force is audited with its counts', a[0]?.after?.audience === 'DRIVER' && a[0]?.after?.outcomes?.GRACE === 1 && a[0]?.after?.graceDays === 7 && a[0]?.after?.reason === 'e2e', short(a[0]));
  }

  console.log(`\n=== The deadline sweeper ===`);
  {
    await sql(`update driver_profiles set "onTrip" = true where id = $1`, [dI1.profileId]);
    await sql(`update driver_profiles set "verificationDueAt" = now() - interval '2 minutes' where id = $1`, [dI1.profileId]);
    const s1 = await api('POST', '/admin/verification/sweep', admin);
    const during = await driverRow(dI1.profileId);
    check('a driver on a trip is not taken off the road mid-delivery (deferred)', during.status === 'ACTIVE' && during.isOnline === true, short({ s: during.status, on: during.isOnline, sweep: s1.j }));
    await sql(`update driver_profiles set "onTrip" = false where id = $1`, [dI1.profileId]);
    const s2 = await api('POST', '/admin/verification/sweep', admin);
    const after = await driverRow(dI1.profileId);
    check('once the trip is over the next sweep takes the driver off the road: status DOCS_REVIEW, offline', s2.s === 201 && s2.j.blocked >= 1 && after.status === 'DOCS_REVIEW' && after.isOnline === false, short({ s: after.status, on: after.isOnline, sweep: s2.j }));
    check('the reason is stored and the old status is remembered', /Verification required/.test(after.statusReason || '') && after.meta?.verification?.restoreStatus === 'ACTIVE', short(after.meta));
    const blocked = await api('POST', '/driver/online', dI1.token, {});
    check('the blocked driver cannot go online (400)', blocked.s === 400 && /DOCS_REVIEW/.test(JSON.stringify(blocked.j)), short(blocked.j));
    const s3 = await api('POST', '/admin/verification/sweep', admin);
    check('sweeping again changes nothing', s3.j.blocked === 0 && (await driverRow(dI1.profileId)).status === 'DOCS_REVIEW', short(s3.j));
  }

  console.log(`\n=== Manual verification of a forced driver: checklist, override, restore ===`);
  {
    const v1 = await api('POST', `/admin/verification/drivers/${dI1.profileId}/verify`, driverOps, {});
    check('verify is refused while the checklist is incomplete, with a code and one line per open item (400)', v1.s === 400 && v1.j?.code === 'VERIFICATION_REQUIREMENTS_NOT_MET' && v1.j.details?.length === 3 && /documents/i.test(v1.j.details[0]) && /Insurance/.test(v1.j.details[1]) && /Background check/.test(v1.j.details[2]), short(v1.j));
    const asBool = await api('POST', `/admin/verification/drivers/${dI1.profileId}/verify`, admin, { override: 'false', note: 'string flag must not count as true' });
    check('override must be a real boolean: the string "false" is refused (400), not read as true', asBool.s === 400, `HTTP ${asBool.s} ${short(asBool.j)}`);
    const o1 = await api('POST', `/admin/verification/drivers/${dI1.profileId}/verify`, driverOps, { override: true, note: 'trust me' });
    check('a staff account cannot override the checklist (403)', o1.s === 403, `HTTP ${o1.s} ${short(o1.j)}`);
    const o2 = await api('POST', `/admin/verification/drivers/${dI1.profileId}/verify`, admin, { override: true });
    check('a Super Admin override without a note is refused (400)', o2.s === 400, `HTTP ${o2.s} ${short(o2.j)}`);
    const o3 = await api('POST', `/admin/verification/drivers/${dI1.profileId}/verify`, admin, { override: true, note: 'verified by video call' });
    check('a Super Admin override with a note verifies the driver', o3.s === 201 && o3.j?.verification?.status === 'VERIFIED' && o3.j?.accountStatus === 'ACTIVE', `HTTP ${o3.s} ${short(o3.j)}`);
    const row = await driverRow(dI1.profileId);
    check('stored: VERIFIED by MANUAL, by the Super Admin, back to ACTIVE, deadline cleared, restore memory cleared', row.verificationStatus === 'VERIFIED' && row.verificationMethod === 'MANUAL' && row.verifiedBy === adminMe.id && row.status === 'ACTIVE' && row.verificationDueAt === null && row.meta?.verification?.restoreStatus === null, short(row));
    const online = await api('POST', '/driver/online', dI1.token, {});
    check('the overridden driver can go online again (the override also waives the documents)', online.s === 201 && online.j?.isOnline === true, `HTTP ${online.s} ${short(online.j)}`);
    const a = await sql(`select after from audit_logs where action = 'verification.verify' and "entityId" = $1 order by "createdAt" desc limit 1`, [dI1.profileId]);
    check('the override and its note are audited', a[0]?.after?.overridden === true && a[0]?.after?.note === 'verified by video call' && a[0]?.after?.missing?.length === 3, short(a[0]));
    const again = await api('POST', `/admin/verification/drivers/${dI1.profileId}/verify`, admin, { override: true, note: 'again please' });
    check('verifying an already verified driver is a 400', again.s === 400, `HTTP ${again.s}`);
    const note = (await sql(`select count(*)::int n from notifications where "userId" = $1 and event = 'verification.verified' and channel = 'IN_APP'`, [dI1.userId]))[0];
    check('the driver was told they are verified', note.n === 1, short(note));
  }

  console.log(`\n=== Force immediately (grace 0), then verify through the real checklist ===`);
  const dI2 = await registerDriver('instant2');
  {
    await api('POST', '/driver/notice/ack', dI2.token, {});
    await api('POST', '/driver/online', dI2.token, {});
    const f = await api('POST', '/admin/verification/force', admin, { audience: 'DRIVER', ids: [dI2.profileId] });
    const row = await driverRow(dI2.profileId);
    check('grace 0: the driver is taken off the road at once (BLOCKED) and sent offline', f.s === 201 && f.j.outcomes.BLOCKED === 1 && row.status === 'DOCS_REVIEW' && row.isOnline === false, short(f.j));
    // do the real manual work: upload the 5 documents, staff approve them, confirm insurance, clear the background check
    const types = ['LICENCE', 'VEHICLE_REGISTRATION', 'INSURANCE', 'PHOTO', 'WORK_ELIGIBILITY'];
    const nextYear = new Date(Date.now() + 365 * 86400e3).toISOString().slice(0, 10);
    for (const type of types) await api('POST', '/driver/documents', dI2.token, { type, fileUrl: `/uploads/e2e-${type}.png`, expiresAt: ['LICENCE', 'VEHICLE_REGISTRATION', 'INSURANCE'].includes(type) ? nextYear : undefined });
    const docs = (await api('GET', `/admin/drivers/${dI2.profileId}`, driverOps)).j?.documents || [];
    check('the five documents are on file', docs.length === 5, short(docs.length));
    for (const d of docs) await api('PATCH', `/admin/drivers/${dI2.profileId}/documents/${d.id}`, driverOps, { status: 'APPROVED', expiresAt: ['LICENCE', 'VEHICLE_REGISTRATION', 'INSURANCE'].includes(d.type) ? nextYear : undefined });
    await api('PUT', `/admin/drivers/${dI2.profileId}/insurance`, driverOps, { coversDelivery: true, expiresAt: nextYear });
    const card0 = (await api('GET', `/admin/verification/drivers/${dI2.profileId}`, driverOps)).j;
    check('the checklist shows documents and insurance done, background check still open', card0.gates.find((g) => g.key === 'documents_approved')?.done && card0.gates.find((g) => g.key === 'insurance_confirmed')?.done && !card0.gates.find((g) => g.key === 'background_check')?.done, short(card0.gates));
    const partial = await api('POST', `/admin/verification/drivers/${dI2.profileId}/verify`, driverOps, {});
    check('one open item still blocks the verification', partial.s === 400 && partial.j.details?.length === 1 && /Background check clear/.test(partial.j.details[0]), short(partial.j));
    await api('POST', `/admin/drivers/${dI2.profileId}/background-check/override`, driverOps, { status: 'CLEAR', note: 'checked outside the platform' });
    const done = await api('POST', `/admin/verification/drivers/${dI2.profileId}/verify`, driverOps, { note: 'all good' });
    check('staff verify once every item is done (no override needed)', done.s === 201 && done.j?.verification?.status === 'VERIFIED', `HTTP ${done.s} ${short(done.j)}`);
    const after = await driverRow(dI2.profileId);
    check('the driver is back ACTIVE, verified by staff (MANUAL), and goes online with approved documents', after.status === 'ACTIVE' && after.verificationMethod === 'MANUAL' && after.verifiedBy !== null && after.meta?.verification?.docsWaived !== true, short(after));
    await sleep(1100);
    const online = await api('POST', '/driver/online', dI2.token, {});
    check('...and can go online', online.s === 201, `HTTP ${online.s} ${short(online.j)}`);
  }

  console.log(`\n=== Reject during verification ===`);
  {
    const ok = await api('POST', `/admin/verification/drivers/${dManual.profileId}/reject`, driverOps, { reason: 'Licence photo is unreadable' });
    check('staff reject a driver in the manual queue', ok.s === 201 && ok.j?.verificationStatus === 'REJECTED' && ok.j?.status === 'REJECTED', `HTTP ${ok.s} ${short(ok.j)}`);
    const row = await driverRow(dManual.profileId);
    check('stored: status REJECTED, verification REJECTED, reason kept', row.status === 'REJECTED' && row.verificationStatus === 'REJECTED' && /unreadable/.test(row.statusReason || ''));
    const again = await api('POST', `/admin/verification/drivers/${dManual.profileId}/reject`, driverOps, { reason: 'twice' });
    check('rejecting twice is a 400', again.s === 400);
    const short1 = await api('POST', `/admin/verification/drivers/${dI2.profileId}/reject`, driverOps, { reason: 'x' });
    check('a reason of fewer than 3 characters is a 400', short1.s === 400);
    const active = await api('POST', `/admin/verification/drivers/${dI1.profileId}/reject`, driverOps, { reason: 'no longer needed' });
    check('a verified driver cannot be rejected through verification (400)', active.s === 400, `HTTP ${active.s}`);
  }

  console.log(`\n=== Automatic verification (Certn) ===`);
  {
    const on = await setPolicy({ instant: false, method: 'AUTOMATIC' }, { instant: false, method: 'AUTOMATIC' });
    check('the Super Admin switches to automatic verification (Certn is ready)', on.s === 200 && on.j?.drivers?.mode === 'AUTOMATIC' && on.j?.businesses?.mode === 'AUTOMATIC', short(on.j));
  }
  const dA1 = await registerDriver('auto-clear');
  const dA2 = await registerDriver('auto-flag', { emailExtra: '+consider' });
  const dA3 = await registerDriver('auto-fail', { emailExtra: '+fail' });
  {
    const v = dA1.res.j?.verification;
    check('automatic driver: mode AUTOMATIC, PENDING, account BACKGROUND_CHECK, told about the Certn email', v?.mode === 'AUTOMATIC' && v?.status === 'PENDING' && v?.accountStatus === 'BACKGROUND_CHECK' && /Certn/.test(v?.nextStep || ''), short(v));
    const row = await driverRow(dA1.profileId);
    check('stored: Certn check IN_PROGRESS with a reference, driver in BACKGROUND_CHECK', row.backgroundCheckStatus === 'IN_PROGRESS' && !!row.backgroundCheckRef && row.status === 'BACKGROUND_CHECK' && row.verificationMethod === 'AUTOMATIC');
    const noGo = await api('POST', '/driver/online', dA1.token, {});
    check('while the check runs the driver cannot go online', noGo.s === 400);
    const cleared = await waitFor(async () => (await driverRow(dA1.profileId)).verificationStatus === 'VERIFIED', 12000);
    const done = await driverRow(dA1.profileId);
    check('when Certn comes back clear the driver is verified and ACTIVE automatically, no staff step', cleared && done.status === 'ACTIVE' && done.verificationMethod === 'AUTOMATIC' && done.verifiedBy === null && done.backgroundCheckStatus === 'CLEAR' && done.zoneIds.length > 0, short(done));
    await api('POST', '/driver/notice/ack', dA1.token, {});
    const online = await api('POST', '/driver/online', dA1.token, {});
    check('the automatically verified driver goes online without documents', online.s === 201 && online.j?.isOnline === true, `HTTP ${online.s} ${short(online.j)}`);
    const clAuto = (await api('GET', '/driver/checklist', dA1.token)).j;
    const autoOpt = (clAuto?.steps || []).filter((s) => s.optional).map((s) => s.key).sort().join();
    check('automatic: the Certn check is NOT optional (it is the verification, and it is done), the staff-checked items are', autoOpt === 'documents_approved,documents_uploaded,insulated_bag,insurance_confirmed,training' && clAuto.steps.find((s) => s.key === 'background_check')?.done === true && !clAuto.steps.find((s) => s.key === 'background_check')?.optional, short(autoOpt));
    const note = (await sql(`select count(*)::int n from notifications where "userId" = $1 and event in ('verification.verified','driver.welcome') and channel = 'IN_APP'`, [dA1.userId]))[0];
    check('the driver got the welcome and the verified messages', note.n === 2, short(note));
    const quiet = (await sql(`select count(*)::int n from notifications where event = 'driver.background_check' and body like $1 and "createdAt" > $2`, ['%E2Eauto-clear%', STARTED]))[0];
    check('a clear automatic result does not bother staff (the driver is activated by itself)', quiet.n === 0, short(quiet));

    // a flagged result: a person decides
    const flagged = await waitFor(async () => (await driverRow(dA2.profileId)).verificationStatus === 'NEEDS_REVIEW', 12000);
    const f = await driverRow(dA2.profileId);
    check('a flagged Certn result (CONSIDER) is NOT decided automatically: NEEDS_REVIEW, not active, not rejected', flagged && f.status === 'BACKGROUND_CHECK' && f.backgroundCheckStatus === 'CONSIDER', short({ s: f.status, v: f.verificationStatus, b: f.backgroundCheckStatus }));
    const pf = await profile(dA2.token);
    check('the driver is told "a closer look", with no result details', /closer look/.test(pf?.verification?.nextStep || '') && !/CONSIDER|criminal/i.test(JSON.stringify(pf?.verification)), short(pf?.verification));
    const ops = await sql(`select count(*)::int n from notifications where event = 'driver.background_check' and body like '%CONSIDER%' and "createdAt" > now() - interval '5 minutes'`);
    check('staff are notified about the flagged check', ops[0].n >= 1);
    const oldOverride = await api('POST', `/admin/drivers/${dA2.profileId}/background-check/override`, driverOps, { status: 'CLEAR', note: 'override attempt from the old button' });
    const oldStart = await api('POST', `/admin/drivers/${dA2.profileId}/background-check/start`, driverOps, {});
    check('the old SOP-02 Certn buttons refuse an automatically verified driver and point to the Verification card (400)', oldOverride.s === 400 && /automatically/.test(JSON.stringify(oldOverride.j)) && oldStart.s === 400, `override ${oldOverride.s}, start ${oldStart.s}`);
    const staffVerify = await api('POST', `/admin/verification/drivers/${dA2.profileId}/verify`, driverOps, { note: 'no' });
    check('staff cannot verify a flagged driver without the check being clear (400)', staffVerify.s === 400 && staffVerify.j.code === 'VERIFICATION_REQUIREMENTS_NOT_MET' && staffVerify.j.details?.length === 1 && /Background check clear: CONSIDER/.test(staffVerify.j.details[0]), short(staffVerify.j));
    const retry = await api('POST', `/admin/verification/drivers/${dA2.profileId}/start-check`, driverOps, {});
    check('staff can start the check again (the Certn reference changes, status back to PENDING)', retry.s === 201 && retry.j?.status === 'IN_PROGRESS' && retry.j?.verificationStatus === 'PENDING', `HTTP ${retry.s} ${short(retry.j)}`);
    const dup = await api('POST', `/admin/verification/drivers/${dA2.profileId}/start-check`, driverOps, {});
    check('starting a second check while one is running is a 400', dup.s === 400, `HTTP ${dup.s}`);
    // webhook path: the second result arrives through the public webhook (this one is clear)
    const ref = (await driverRow(dA2.profileId)).backgroundCheckRef;
    const noSecret = await api('POST', '/public/webhooks/certn', null, { id: ref, result: 'clear' });
    check('the Certn webhook refuses a call without the shared secret (401)', noSecret.s === 401, `HTTP ${noSecret.s}`);
    const wrong = await api('POST', '/public/webhooks/certn', null, { id: ref, result: 'clear' }, { 'x-webhook-secret': 'not-the-secret' });
    check('...and one with a wrong secret (401)', wrong.s === 401, `HTTP ${wrong.s}`);
    if (WEBHOOK_SECRET) {
      const hook = await api('POST', '/public/webhooks/certn', null, { id: ref, result: 'clear' }, { 'x-webhook-secret': WEBHOOK_SECRET });
      check('a correct webhook call settles the driver: verified and ACTIVE', hook.s === 201 && hook.j?.ok === true, `HTTP ${hook.s} ${short(hook.j)}`);
      const d = await driverRow(dA2.profileId);
      check('stored: the flagged driver is now VERIFIED (AUTOMATIC) and ACTIVE after the clear result', d.verificationStatus === 'VERIFIED' && d.status === 'ACTIVE' && d.verificationMethod === 'AUTOMATIC', short({ s: d.status, v: d.verificationStatus }));
      const stale = await api('POST', '/public/webhooks/certn', null, { id: ref, result: 'clear' }, { 'x-webhook-secret': WEBHOOK_SECRET });
      check('the same result delivered twice is accepted and changes nothing (idempotent)', stale.s === 201 && (await driverRow(dA2.profileId)).verificationStatus === 'VERIFIED');
      const unknown = await api('POST', '/public/webhooks/certn', null, { id: 'unknown-ref', result: 'clear' }, { 'x-webhook-secret': WEBHOOK_SECRET });
      check('a result for an unknown reference answers ok:false', unknown.j?.ok === false, short(unknown.j));
    }
    // the mock also reports for the restarted check; it must not undo anything
    await sleep(2200);
    check('the late mock result for the restarted check does not disturb the verified driver', (await driverRow(dA2.profileId)).verificationStatus === 'VERIFIED');

    // a failed result is not a rejection either
    await waitFor(async () => (await driverRow(dA3.profileId)).verificationStatus === 'NEEDS_REVIEW', 12000);
    const f3 = await driverRow(dA3.profileId);
    check('a failed Certn result (FAILED) also goes to a person, not to an automatic rejection', f3.verificationStatus === 'NEEDS_REVIEW' && f3.status === 'BACKGROUND_CHECK' && f3.backgroundCheckStatus === 'FAILED', short({ s: f3.status, v: f3.verificationStatus, b: f3.backgroundCheckStatus }));
    const rej = await api('POST', `/admin/verification/drivers/${dA3.profileId}/reject`, driverOps, { reason: 'Background check failed: confirmed with the applicant' });
    check('staff then reject it with a reason', rej.s === 201 && (await driverRow(dA3.profileId)).status === 'REJECTED');
  }

  console.log(`\n=== Automatic verification of businesses ===`);
  const rA1 = await applyRestaurant('auto-clear');
  const rA2 = await applyRestaurant('auto-flag', { emailExtra: '+consider' });
  {
    const v = rA1.res.j?.verification;
    check('automatic business: mode AUTOMATIC, PENDING, restaurant APPLIED while the owner is checked', v?.mode === 'AUTOMATIC' && v?.status === 'PENDING' && v?.accountStatus === 'APPLIED', short(v));
    const m0 = await merchantRow(rA1.merchantId);
    check('stored: the Certn check of the OWNER is running on the merchant', m0.backgroundCheckStatus === 'IN_PROGRESS' && !!m0.backgroundCheckRef && m0.verificationMethod === 'AUTOMATIC', short(m0));
    const live = await waitFor(async () => (await restaurantRow(rA1.restaurantId)).status === 'LIVE', 12000);
    const m = await merchantRow(rA1.merchantId);
    const r = await restaurantRow(rA1.restaurantId);
    check('a clear result takes the business live automatically: merchant VERIFIED (AUTOMATIC), restaurant LIVE and accepting, menu editing allowed', live && m.verificationStatus === 'VERIFIED' && m.verificationMethod === 'AUTOMATIC' && r.acceptingOrders === true && r.menuEditStatus === 'ALLOWED', short({ m: m.verificationStatus, r: r.status }));

    await waitFor(async () => (await merchantRow(rA2.merchantId)).verificationStatus === 'NEEDS_REVIEW', 12000);
    const m2 = await merchantRow(rA2.merchantId);
    const r2 = await restaurantRow(rA2.restaurantId);
    check('a flagged owner check leaves the business waiting for a person (restaurant stays APPLIED)', m2.verificationStatus === 'NEEDS_REVIEW' && m2.backgroundCheckStatus === 'CONSIDER' && r2.status === 'APPLIED', short({ m: m2.verificationStatus, r: r2.status }));
    const quietB = (await sql(`select count(*)::int n from notifications where event = 'restaurant.background_check' and body like $1`, [`%E2E Business auto-clear ${RUN}%`]))[0];
    const loudB = (await sql(`select count(*)::int n from notifications where event = 'restaurant.background_check' and body like $1`, [`%E2E Business auto-flag ${RUN}%`]))[0];
    check('staff hear about the flagged owner check but not about the clear one', quietB.n === 0 && loudB.n >= 1, short({ quietB, loudB }));
    const card = (await api('GET', `/admin/verification/businesses/${rA2.merchantId}`, success)).j;
    check('the business card lists the owner and the checklist (only the Certn item for the automatic method)', card?.owner?.email?.includes('+consider') && card?.gates?.length === 1 && card.gates[0].key === 'background_check' && card.restaurants?.length === 1, short(card));
    const staffNo = await api('POST', `/admin/verification/businesses/${rA2.merchantId}/verify`, success, {});
    check('staff cannot verify it while the check is not clear (400)', staffNo.s === 400 && staffNo.j.code === 'VERIFICATION_REQUIREMENTS_NOT_MET' && /Owner background check clear: CONSIDER/.test(staffNo.j.details?.[0] || ''), short(staffNo.j));
    const denied = await api('POST', `/admin/verification/businesses/${rA2.merchantId}/verify`, driverOps, { override: true, note: 'x' });
    check('staff without restaurants permissions cannot touch businesses (403)', denied.s === 403, `HTTP ${denied.s}`);
    const staffOverride = await api('POST', `/admin/verification/businesses/${rA2.merchantId}/verify`, success, { override: true, note: 'owner confirmed by phone' });
    check('only a Super Admin can override (403 for staff)', staffOverride.s === 403, `HTTP ${staffOverride.s}`);
    const ok = await api('POST', `/admin/verification/businesses/${rA2.merchantId}/verify`, admin, { override: true, note: 'owner confirmed by phone and in person' });
    const after = await restaurantRow(rA2.restaurantId);
    check('a Super Admin override verifies the business and takes its restaurant live', ok.s === 201 && ok.j?.verification?.status === 'VERIFIED' && after.status === 'LIVE', `HTTP ${ok.s} ${short(ok.j)}`);
  }

  console.log(`\n=== Force verification (automatic method): grace, then immediate with restore ===`);
  {
    // new unverified accounts: instant registration on, then switch to automatic and force
    await setPolicy({ instant: true }, { instant: true });
    const dF1 = await registerDriver('force-auto1');
    const dF2 = await registerDriver('force-auto2');
    await api('POST', '/driver/notice/ack', dF2.token, {});
    await api('POST', '/driver/online', dF2.token, {});
    const rF1 = await applyRestaurant('force-auto1');
    await setPolicy({ instant: false, method: 'AUTOMATIC' }, { instant: false, method: 'AUTOMATIC' });

    const g = await api('POST', '/admin/verification/force', admin, { audience: 'DRIVER', ids: [dF1.profileId], graceDays: 5 });
    check('force with the automatic method starts the Certn check and leaves the driver working until the deadline', g.s === 201 && g.j.method === 'AUTOMATIC' && g.j.outcomes.GRACE === 1, short(g.j));
    const r1 = await driverRow(dF1.profileId);
    check('stored: PENDING / AUTOMATIC, Certn IN_PROGRESS, still ACTIVE', r1.verificationStatus === 'PENDING' && r1.verificationMethod === 'AUTOMATIC' && r1.backgroundCheckStatus === 'IN_PROGRESS' && r1.status === 'ACTIVE', short(r1));
    await waitFor(async () => (await driverRow(dF1.profileId)).verificationStatus === 'VERIFIED', 12000);
    const v1 = await driverRow(dF1.profileId);
    check('a clear result verifies the working driver in place: VERIFIED (AUTOMATIC), never interrupted, deadline cleared', v1.verificationStatus === 'VERIFIED' && v1.verificationMethod === 'AUTOMATIC' && v1.status === 'ACTIVE' && v1.verificationDueAt === null, short(v1));

    const imm = await api('POST', '/admin/verification/force', admin, { audience: 'DRIVER', ids: [dF2.profileId] });
    const b = await driverRow(dF2.profileId);
    check('force with grace 0 and the automatic method: taken off the road in BACKGROUND_CHECK while Certn runs', imm.j?.outcomes?.BLOCKED === 1 && b.status === 'BACKGROUND_CHECK' && b.isOnline === false && b.backgroundCheckStatus === 'IN_PROGRESS', short({ f: imm.j, s: b.status }));
    await waitFor(async () => (await driverRow(dF2.profileId)).status === 'ACTIVE', 12000);
    const back = await driverRow(dF2.profileId);
    check('when Certn clears, the driver comes back to ACTIVE by itself (verified, AUTOMATIC)', back.status === 'ACTIVE' && back.verificationStatus === 'VERIFIED' && back.meta?.verification?.restoreStatus === null, short({ s: back.status, v: back.verificationStatus }));

    const fb = await api('POST', '/admin/verification/force', admin, { audience: 'BUSINESS', ids: [rF1.merchantId], graceDays: 3 });
    check('force a business with a grace period: it keeps selling until the deadline', fb.s === 201 && fb.j.outcomes.GRACE === 1 && (await restaurantRow(rF1.restaurantId)).status === 'LIVE', short(fb.j));
    await waitFor(async () => (await merchantRow(rF1.merchantId)).verificationStatus === 'VERIFIED', 12000);
    check('the owner check clears: the business is verified without ever going off line', (await restaurantRow(rF1.restaurantId)).status === 'LIVE');
  }

  console.log(`\n=== Force verification of businesses (manual method), in-flight orders, restore ===`);
  {
    await setPolicy({ instant: true, method: 'MANUAL' }, { instant: true, method: 'MANUAL' });
    const rB = await applyRestaurant('force-manual');
    const rC = await applyRestaurant('force-bulk');
    await setPolicy({ instant: false }, { instant: false });
    // give the restaurant an order that is being prepared (reuse a seeded order)
    const order = (await sql(`select id, status, "restaurantId" from orders where status = 'DELIVERED' limit 1`))[0];
    await sql(`update orders set "restaurantId" = $1, status = 'PREPARING' where id = $2`, [rB.restaurantId, order.id]);
    const f = await api('POST', '/admin/verification/force', admin, { audience: 'BUSINESS', ids: [rB.merchantId], graceDays: 0 });
    check('a business with an order in progress is not taken off line mid-order (DEFERRED)', f.s === 201 && f.j.outcomes.DEFERRED === 1 && (await restaurantRow(rB.restaurantId)).status === 'LIVE', short(f.j));
    await sql(`update orders set status = 'DELIVERED' where id = $1`, [order.id]);
    const s = await api('POST', '/admin/verification/sweep', admin);
    const rr = await restaurantRow(rB.restaurantId);
    check('when the order is finished the next sweep takes the restaurant off line: DOCS_REVIEW, not accepting orders, memory of LIVE kept', s.j.blocked >= 1 && rr.status === 'DOCS_REVIEW' && rr.acceptingOrders === false && rr.meta?.verification?.restoreStatus === 'LIVE' && rr.meta?.verification?.restoreAccepting === true, short({ s: rr.status, sweep: s.j, m: rr.meta?.verification }));
    await sql(`update orders set "restaurantId" = $1 where id = $2`, [order.restaurantId, order.id]);
    const view = await api('GET', `/admin/restaurants/${rB.restaurantId}`, admin);
    check('the restaurant view tells the owner side that verification is pending', view.j?.verification?.status === 'PENDING' && /reviewing/.test(view.j?.verification?.nextStep || ''), short(view.j?.verification));
    const rej = await api('POST', `/admin/verification/businesses/${rC.merchantId}/reject`, success, { reason: 'no longer wanted' });
    check('a business with a live restaurant cannot be rejected through verification, only suspended (400)', rej.s === 400 && /live/.test(JSON.stringify(rej.j)), `HTTP ${rej.s} ${short(rej.j)}`);

    // the real checklist: owner uploads the three required documents, staff approve them, staff verify
    const ownerToken = rB.token || (await login(rB.email, 'Str0ng!Passw0rd#e2e', 'restaurant').catch(() => null));
    if (ownerToken) {
      for (const type of ['BUSINESS_LICENCE', 'HEALTH_CERTIFICATE', 'VOID_CHEQUE']) await api('POST', '/restaurant/store/documents', ownerToken, { type, fileUrl: `/uploads/e2e-${type}.pdf` });
    } else {
      for (const type of ['BUSINESS_LICENCE', 'HEALTH_CERTIFICATE', 'VOID_CHEQUE']) await sql(`insert into restaurant_documents ("restaurantId", type, "fileUrl", status) values ($1, $2, $3, 'PENDING')`, [rB.restaurantId, type, `/uploads/e2e-${type}.pdf`]);
    }
    const missing = await api('POST', `/admin/verification/businesses/${rB.merchantId}/verify`, success, {});
    check('verify is refused until the documents are approved (400, names the restaurant and the documents)', missing.s === 400 && missing.j?.code === 'VERIFICATION_REQUIREMENTS_NOT_MET' && /E2E Bistro/.test(missing.j?.details?.[0] || '') && /BUSINESS_LICENCE/.test(missing.j?.details?.[0] || ''), short(missing.j));
    const docs = (await api('GET', `/admin/restaurants/${rB.restaurantId}/documents`, success)).j || [];
    for (const d of docs) await api('POST', `/admin/restaurants/${rB.restaurantId}/documents/${d.id}/approve`, success, { expiresAt: new Date(Date.now() + 300 * 86400e3).toISOString().slice(0, 10) });
    const ok = await api('POST', `/admin/verification/businesses/${rB.merchantId}/verify`, success, { note: 'documents checked' });
    const after = await restaurantRow(rB.restaurantId);
    check('staff verify once the documents are approved: the restaurant is restored to LIVE and accepting orders, merchant VERIFIED (MANUAL)', ok.s === 201 && after.status === 'LIVE' && after.acceptingOrders === true && (await merchantRow(rB.merchantId)).verificationMethod === 'MANUAL', `HTTP ${ok.s} ${short(ok.j)}`);

    // bulk: force every unverified business at once (all:true)
    const all = await api('POST', '/admin/verification/force', admin, { audience: 'BUSINESS', all: true, graceDays: 30 });
    check('force all: every unverified business (here the instant one) gets a deadline, verified ones are untouched', all.s === 201 && all.j.matched >= 1 && all.j.outcomes.GRACE >= 1 && (await merchantRow(rC.merchantId)).verificationStatus === 'PENDING', short(all.j));
    const verifiedStill = (await overview()).businesses.counts;
    check('the overview counts follow', verifiedStill.PENDING >= 1 && verifiedStill.VERIFIED >= 20, short(verifiedStill));
  }

  console.log(`\n=== Manual registration of a business, verified through the checklist and by the staff go-live ===`);
  {
    await setPolicy({ instant: false, method: 'MANUAL' }, { instant: false, method: 'MANUAL' });
    // R_manual (registered under the default policy at the start): staff go-live marks the business as manually verified
    const ownerToken = rManual.token;
    for (const type of ['BUSINESS_LICENCE', 'HEALTH_CERTIFICATE', 'VOID_CHEQUE']) await api('POST', '/restaurant/store/documents', ownerToken, { type, fileUrl: `/uploads/e2e-${type}.pdf` });
    const docs = (await api('GET', `/admin/restaurants/${rManual.restaurantId}/documents`, success)).j || [];
    for (const d of docs) await api('POST', `/admin/restaurants/${rManual.restaurantId}/documents/${d.id}/approve`, success, { expiresAt: new Date(Date.now() + 300 * 86400e3).toISOString().slice(0, 10) });
    const ok = await api('POST', `/admin/verification/businesses/${rManual.merchantId}/verify`, success, { note: 'documents checked' });
    const r = await restaurantRow(rManual.restaurantId);
    check('"verify and activate" works on a manual applicant: restaurant LIVE with the defaults of a staff go-live', ok.s === 201 && r.status === 'LIVE' && r.acceptingOrders === true && !!r.commissionTierId && r.menuEditStatus === 'ALLOWED', `HTTP ${ok.s} ${short(ok.j)}`);
    check('merchant VERIFIED (MANUAL) by the staff account', (await merchantRow(rManual.merchantId)).verifiedBy !== null);

    // a business that is still in the queue can be rejected: its restaurant and the business are REJECTED
    const rRej = await applyRestaurant('reject');
    const rejOk = await api('POST', `/admin/verification/businesses/${rRej.merchantId}/reject`, success, { reason: 'Business licence belongs to another company' });
    check('staff reject a business that is still in the queue: merchant and restaurant REJECTED', rejOk.s === 201 && (await merchantRow(rRej.merchantId)).verificationStatus === 'REJECTED' && (await restaurantRow(rRej.restaurantId)).status === 'REJECTED', `HTTP ${rejOk.s} ${short(rejOk.j)}`);

    // the classic SOP-01 path still verifies: another manual applicant is taken live with the existing go-live (force)
    const r2 = await applyRestaurant('sop');
    const gl = await api('POST', `/admin/restaurants/${r2.restaurantId}/go-live`, admin, { force: true, reason: 'e2e' });
    const m2 = await merchantRow(r2.merchantId);
    check('SOP-01 go-live by staff marks the business VERIFIED (MANUAL) and the SOP-02 approve marks a driver VERIFIED (MANUAL)', gl.s === 201 && m2.verificationStatus === 'VERIFIED' && m2.verificationMethod === 'MANUAL', `HTTP ${gl.s} ${short(m2)}`);
    const d2 = await registerDriver('sop');
    const ap = await api('POST', `/admin/drivers/${d2.profileId}/approve`, admin, { override: true });
    const dr = await driverRow(d2.profileId);
    check('SOP-02 approve (with override) marks the driver VERIFIED (MANUAL), status APPROVED', ap.s === 201 && dr.verificationStatus === 'VERIFIED' && dr.verificationMethod === 'MANUAL' && dr.status === 'APPROVED', `HTTP ${ap.s} ${short(dr)}`);
  }

  console.log(`\n=== Staff-started checks, force all, reminders and Certn retries ===`);
  {
    // unverified (instant) accounts that staff check WITHOUT forcing anything: no deadline, no interruption
    await setPolicy({ instant: true }, { instant: true });
    const dS = await registerDriver('staffcheck');
    const dS2 = await registerDriver('forceall');
    const rS = await applyRestaurant('staffcheck');
    await setPolicy({ instant: false, method: 'MANUAL' }, { instant: false, method: 'MANUAL' });

    const sc = await api('POST', `/admin/verification/drivers/${dS.profileId}/start-check`, driverOps, {});
    const r0 = await driverRow(dS.profileId);
    check('staff can start a Certn check on a working, unverified driver: PENDING (automatic), no deadline, still ACTIVE', sc.s === 201 && r0.verificationStatus === 'PENDING' && r0.verificationMethod === 'AUTOMATIC' && r0.verificationDueAt === null && r0.status === 'ACTIVE', `HTTP ${sc.s} ${short(sc.j)}`);
    await waitFor(async () => (await driverRow(dS.profileId)).verificationStatus === 'VERIFIED', 12000);
    const r1 = await driverRow(dS.profileId);
    check('...and a clear result verifies it in place (AUTOMATIC) without ever interrupting it', r1.verificationStatus === 'VERIFIED' && r1.verificationMethod === 'AUTOMATIC' && r1.status === 'ACTIVE' && r1.meta?.verification?.restoreStatus == null, short(r1));

    const scb = await api('POST', `/admin/verification/businesses/${rS.merchantId}/start-check`, success, {});
    const m0 = await merchantRow(rS.merchantId);
    check('same for a live, unverified business: the owner is checked, the restaurant stays LIVE', scb.s === 201 && m0.verificationStatus === 'PENDING' && m0.verificationMethod === 'AUTOMATIC' && (await restaurantRow(rS.restaurantId)).status === 'LIVE', `HTTP ${scb.s} ${short(scb.j)}`);
    await waitFor(async () => (await merchantRow(rS.merchantId)).verificationStatus === 'VERIFIED', 12000);
    check('...and the clear result verifies it', (await merchantRow(rS.merchantId)).verificationMethod === 'AUTOMATIC' && (await restaurantRow(rS.restaurantId)).status === 'LIVE');

    // force ALL unverified drivers (the other one registered above, plus any leftovers)
    const all = await api('POST', '/admin/verification/force', admin, { audience: 'DRIVER', all: true, graceDays: 30 });
    const leftovers = (await sql(`select count(*)::int n from driver_profiles where "verificationStatus" = 'UNVERIFIED'`))[0].n;
    check('force all: every unverified driver gets a deadline, verified drivers are untouched, nobody is left unverified', all.s === 201 && all.j.matched >= 1 && all.j.outcomes.GRACE === all.j.matched && (await driverRow(dS2.profileId)).verificationStatus === 'PENDING' && leftovers === 0, short(all.j));
    const viaTable = await api('GET', '/admin/verification/subjects?audience=DRIVER&status=PENDING', admin);
    check('the table shows them as PENDING with a deadline', viaTable.j?.data?.some((x) => x.id === dS2.profileId && x.verificationDueAt && x.verificationForcedAt), short(viaTable.j?.data?.[0]));

    // reminders: a deadline a few hours away
    await sql(`update driver_profiles set "verificationDueAt" = now() + interval '6 hours' where id = $1`, [dS2.profileId]);
    const s1 = await api('POST', '/admin/verification/sweep', admin);
    const required = async () => (await sql(`select count(*)::int n from notifications where "userId" = $1 and event = 'verification.required' and channel = 'IN_APP'`, [dS2.userId]))[0].n;
    await waitFor(async () => (await required()) >= 2, 4000);
    check('a deadline less than a day away triggers a reminder (the force notice plus one reminder)', s1.j.reminded >= 1 && (await required()) === 2, short({ sweep: s1.j, n: await required() }));
    const s2 = await api('POST', '/admin/verification/sweep', admin);
    check('...only one reminder per account', s2.j.reminded === 0 && (await required()) === 2, short(s2.j));

    // Certn retries: an account that should have a check but has none (as after a Certn outage)
    await sql(`update driver_profiles set "verificationMethod" = 'AUTOMATIC', "backgroundCheckStatus" = 'NOT_STARTED', "backgroundCheckRef" = null, "updatedAt" = now() - interval '5 minutes' where id = $1`, [dS2.profileId]);
    const s3 = await api('POST', '/admin/verification/sweep', admin);
    check('the sweeper starts a check that could not be started earlier', s3.j.checksStarted >= 1 && (await driverRow(dS2.profileId)).backgroundCheckStatus === 'IN_PROGRESS', short(s3.j));
    await waitFor(async () => (await driverRow(dS2.profileId)).verificationStatus === 'VERIFIED', 12000);
    check('...and its clear result verifies the driver', (await driverRow(dS2.profileId)).verificationStatus === 'VERIFIED');
  }

  console.log(`\n=== Switching modes never rewrites accounts that are already decided ===`);
  {
    const before = await sql(`select count(*)::int n from driver_profiles where "verificationStatus" = 'VERIFIED'`);
    await setPolicy({ instant: true }, { instant: true });
    await setPolicy({ instant: false }, { instant: false });
    const after = await sql(`select count(*)::int n from driver_profiles where "verificationStatus" = 'VERIFIED'`);
    check('flipping instant registration on and off leaves every verified driver verified', before[0].n === after[0].n, short({ before, after }));
    const m = await sql(`select count(*)::int n from merchants where "verificationStatus" = 'VERIFIED' and "verificationMethod" is null`);
    check('no verified business is left without a method', m[0].n === 0);
  }
} catch (e) {
  console.log(`FAIL  the test run crashed: ${e.stack || e.message}`);
  failed++;
} finally {
  // put the policy back to the defaults
  try {
    await api('PUT', '/admin/verification/policy', admin, { drivers: { instant: false, method: 'MANUAL' }, businesses: { instant: false, method: 'MANUAL' } });
    await api('PUT', '/admin/settings', admin, { values: { 'security.enforce2faRestaurantOwner': true } });
    const ov = await overview();
    check('cleanup: the policy is back to the defaults (not instant, manual)', !ov.drivers.policy.instant && ov.drivers.policy.method === 'MANUAL' && !ov.businesses.policy.instant && ov.businesses.policy.method === 'MANUAL');
  } catch (e) {
    console.log(`FAIL  cleanup failed: ${e.message}`);
    failed++;
  }
  await db.end();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
