/**
 * FCM HTTP v1 adapter against a LOCAL FAKE (fake OAuth token endpoint + fake FCM endpoint). Google itself is not contacted, so this
 * proves the request shapes, the RS256 service-account JWT, token caching / refresh, error handling and dead-token removal, NOT that
 * Google accepts them with a real service account.
 *
 *   cd backend && npx ts-node --transpile-only test/notifications-fcm.test.ts
 */
import { createServer } from 'http';
import { createVerify, generateKeyPairSync } from 'crypto';
import { FcmService } from '../src/notifications/fcm.service';

let n = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  n++;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail !== undefined ? '  -> ' + JSON.stringify(detail).slice(0, 300) : ''}`);
};

async function main() {
  process.env.PUSH_RETRY_BASE_MS = '20';
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const oauth: { body: string; at: number }[] = [];
  const sends: { path: string; auth: string; body: any }[] = [];
  const plan: number[] = []; // statuses for upcoming FCM sends
  let tokenSeq = 0;
  let tokenTtl = 3600;
  const bodyOf = (req: any) => new Promise<string>((r) => { const c: Buffer[] = []; req.on('data', (d: Buffer) => c.push(d)); req.on('end', () => r(Buffer.concat(c).toString())); });
  const server = createServer(async (req, res) => {
    const body = await bodyOf(req);
    if (req.url === '/token') {
      oauth.push({ body, at: Date.now() });
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ access_token: `tok-${++tokenSeq}`, expires_in: tokenTtl, token_type: 'Bearer' }));
    }
    const status = plan.length ? plan.shift()! : 200;
    sends.push({ path: req.url!, auth: String(req.headers.authorization), body: JSON.parse(body || '{}') });
    res.writeHead(status, { 'content-type': 'application/json' });
    if (status === 404) return res.end(JSON.stringify({ error: { code: 404, status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } }));
    if (status === 200) return res.end(JSON.stringify({ name: 'projects/p/messages/1' }));
    return res.end(JSON.stringify({ error: { code: status, status: 'UNAVAILABLE' } }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port;
  process.env.FCM_API_BASE = `http://127.0.0.1:${port}`;
  process.env.FCM_TOKEN_URI = `http://127.0.0.1:${port}/token`;
  process.env.FCM_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: 'svc@forky-test.iam.gserviceaccount.com', private_key: pem, project_id: 'forky-test' });

  // in-memory device token repo
  const rows: any[] = [
    { id: 'd1', userId: 'u1', token: 'tok-android-1', platform: 'android', failures: 0 },
    { id: 'd2', userId: 'u1', token: 'tok-ios-1', platform: 'ios', failures: 0 },
  ];
  const repo: any = {
    find: async ({ where }: any) => rows.filter((r) => r.userId === where.userId),
    update: async (id: string, patch: any) => Object.assign(rows.find((r) => r.id === id) ?? {}, patch),
    delete: async (id: string) => { const i = rows.findIndex((r) => r.id === id); if (i >= 0) rows.splice(i, 1); },
    createQueryBuilder: () => {
      const b: any = { update: () => b, set: () => b, where: (_: string, p: any) => { b.id = p.id; return b; }, execute: async () => { const r = rows.find((x) => x.id === b.id); if (r) r.failures++; } };
      return b;
    },
  };
  const settings: any = { get: () => '' };
  const fcm = new FcmService(settings, repo);
  const payload: any = { title: 'New delivery offer', body: 'Pizza - 1.2 km', url: '/driver-demo.html?offer=1', icon: '/x.png', badge: '/y.png', event: 'driver.offer', tag: 'offer:1', critical: true, data: { offerId: 'o1', seconds: 30 }, ts: Date.now() };

  check('configured() true with the service account JSON from the environment', fcm.configured());
  // JWT shape + signature
  const sa = fcm.serviceAccount()!;
  const jwt = fcm.signJwt(sa, `http://127.0.0.1:${port}/token`, 1_700_000_000);
  const [h, c, s] = jwt.split('.');
  const hv = JSON.parse(Buffer.from(h, 'base64url').toString());
  const cv = JSON.parse(Buffer.from(c, 'base64url').toString());
  check('JWT header is RS256 / JWT', hv.alg === 'RS256' && hv.typ === 'JWT', hv);
  check('JWT claims: iss, scope firebase.messaging, aud, 1 h lifetime', cv.iss === sa.client_email && cv.scope === 'https://www.googleapis.com/auth/firebase.messaging' && cv.exp - cv.iat === 3600 && cv.aud.endsWith('/token'), cv);
  const v = createVerify('RSA-SHA256').update(`${h}.${c}`);
  check('JWT RS256 signature verifies with the service account public key', v.verify(publicKey, Buffer.from(s, 'base64url')));

  // send: OAuth once, two devices
  let r = await fcm.sendToUser('u1', payload, { urgency: 'high', ttl: 35 });
  check('2 devices: both sent', r.sent === 2 && r.failed === 0, r);
  check('OAuth: one token request (jwt-bearer grant with an assertion)', oauth.length === 1 && /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer/.test(oauth[0].body) && /assertion=[\w-]+\.[\w-]+\.[\w-]+/.test(oauth[0].body), oauth);
  check('FCM v1 path /v1/projects/<id>/messages:send with Bearer token', sends.length === 2 && sends.every((x) => x.path === '/v1/projects/forky-test/messages:send' && x.auth === 'Bearer tok-1'), sends.map((x) => [x.path, x.auth]));
  const m = sends.map((x) => x.body.message).find((x: any) => x.token === 'tok-android-1');
  check('message: token + notification + string-only data', m.token === 'tok-android-1' && m.notification.title === payload.title && Object.values(m.data).every((x) => typeof x === 'string') && m.data.offerId === 'o1' && m.data.seconds === '30' && m.data.url === payload.url, m);
  check('urgency high -> android priority HIGH, apns-priority 10, TTL 35s, collapse key', m.android.priority === 'HIGH' && m.apns.headers['apns-priority'] === '10' && m.android.ttl === '35s' && m.android.collapse_key === 'offer:1' && m.android.notification.channel_id === 'critical', m);
  // token cached
  await fcm.sendToUser('u1', payload, { urgency: 'normal', ttl: 600 });
  check('access token is cached (still 1 OAuth request)', oauth.length === 1, oauth.length);
  check('normal urgency -> NORMAL / apns 5', sends[2].body.message.android.priority === 'NORMAL' && sends[2].body.message.apns.headers['apns-priority'] === '5', sends[2].body.message);

  // 404 UNREGISTERED removes the token
  plan.push(404);
  r = await fcm.sendToUser('u1', payload, { urgency: 'high', ttl: 30 });
  check('UNREGISTERED token is deleted', r.removed === 1 && rows.length === 1, { r, rows });
  // 503 then 200 -> retried
  plan.push(503, 200);
  const before = sends.length;
  r = await fcm.sendToUser('u1', payload, { urgency: 'high', ttl: 30 });
  check('503 is retried and then delivered', r.sent === 1 && sends.length - before === 2, { r, n: sends.length - before });
  // 3x 500 -> failed, counter
  plan.push(500, 500, 500);
  const f0 = rows[0].failures;
  r = await fcm.sendToUser('u1', payload, { urgency: 'high', ttl: 30 });
  check('persistent 500: gives up after 3 attempts, failure counter + 1', r.failed === 1 && r.attempts === 3 && rows[0].failures === f0 + 1, { r, f: rows[0].failures });
  // 401 -> token refreshed once
  plan.push(401, 200);
  const o0 = oauth.length;
  r = await fcm.sendToUser('u1', payload, { urgency: 'high', ttl: 30 });
  check('401: access token refreshed once, then sent', r.sent === 1 && oauth.length === o0 + 1 && sends[sends.length - 1].auth === `Bearer tok-${tokenSeq}`, { r, o: oauth.length - o0 });
  // unknown user -> skipped
  r = await fcm.sendToUser('nobody', payload, { urgency: 'high', ttl: 30 });
  check('no device token: skipped, no request', r.sent === 0 && !!r.skipped, r);
  // not configured
  delete process.env.FCM_SERVICE_ACCOUNT_JSON;
  check('not configured when the JSON is missing (legacy server key is ignored)', !fcm.configured());
  process.env.FCM_SERVER_KEY = 'legacy-key';
  r = await fcm.sendToUser('u1', payload, { urgency: 'high', ttl: 30 });
  check('legacy FCM_SERVER_KEY no longer sends anything', r.sent === 0 && r.skipped === 'FCM is not configured', r);
  // settings secret path
  const fcm2 = new FcmService({ get: (k: string) => (k === 'notifications.fcm.serviceAccountJson' ? JSON.stringify({ client_email: 'a@b.c', private_key: pem, project_id: 'p2' }) : '') } as any, repo);
  check('service account can come from the secret setting notifications.fcm.serviceAccountJson', fcm2.configured() && fcm2.serviceAccount()!.project_id === 'p2');
  server.close();
  console.log(`\nRESULT ${n - failed}/${n} passed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('CRASH', e); process.exit(2); });
