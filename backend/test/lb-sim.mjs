#!/usr/bin/env node
/**
 * A tiny local load balancer, so the System Health page's load-balancing view can be tried (and tested) on one machine.
 *
 *   node backend/test/lb-sim.mjs --listen 4100 --to http://localhost:4101,http://localhost:4102 [--policy round-robin] [--health-uri /api/v1/ready]
 *
 *   --policy  round-robin (default) | random | weighted:90,10 (one weight per upstream, to simulate a skewed balancer) | sticky (by client address)
 *   --health-uri  every upstream is probed every 2 s, like Caddy's `health_uri`: one that answers a non-2xx status (for example an instance that a
 *                 Super Admin DRAINED, which answers 503 on /api/v1/ready) gets no new requests until it answers 2xx again. Default /api/v1/ready.
 *
 * Control (no auth, local use only):  GET /__lb/stats   POST /__lb/policy?value=weighted:80,20
 * Only plain HTTP is proxied (no websocket upgrade): connect realtime clients straight to an instance.
 */
import http from 'node:http';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']] : acc), []),
);
const listen = Number(args.listen || 4100);
const upstreams = String(args.to || '')
  .split(',')
  .filter(Boolean)
  .map((u) => ({ url: new URL(u), healthy: true, served: 0, lastStatus: null }));
if (!upstreams.length) {
  console.error('usage: node lb-sim.mjs --listen 4100 --to http://localhost:4101,http://localhost:4102 [--policy round-robin|random|weighted:90,10|sticky] [--health-uri /api/v1/ready]');
  process.exit(2);
}
let policy = String(args.policy || 'round-robin');
const healthUri = String(args['health-uri'] || '/api/v1/ready');
const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });
let rr = 0;

function pick(req) {
  const live = upstreams.filter((u) => u.healthy);
  if (!live.length) return null;
  if (policy === 'random') return live[Math.floor(Math.random() * live.length)];
  if (policy.startsWith('weighted:')) {
    const w = policy.slice(9).split(',').map(Number);
    const weights = upstreams.map((u, i) => (u.healthy ? Math.max(0, w[i] ?? 1) : 0));
    const total = weights.reduce((a, b) => a + b, 0) || 1;
    let r = Math.random() * total;
    for (let i = 0; i < upstreams.length; i++) {
      r -= weights[i];
      if (r < 0 && weights[i] > 0) return upstreams[i];
    }
    return live[0];
  }
  if (policy === 'sticky') {
    const key = String(req.socket.remoteAddress || '');
    let h = 0;
    for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return live[h % live.length];
  }
  return live[rr++ % live.length]; // round-robin over the healthy ones
}

const server = http.createServer((req, res) => {
  if (req.url?.startsWith('/__lb/stats')) {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ policy, healthUri, upstreams: upstreams.map((u) => ({ url: u.url.href, healthy: u.healthy, served: u.served, lastStatus: u.lastStatus })) }));
  }
  if (req.url?.startsWith('/__lb/policy') && req.method === 'POST') {
    const v = new URL(req.url, 'http://x').searchParams.get('value');
    if (v) policy = v;
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ policy }));
  }
  const target = pick(req);
  if (!target) {
    res.statusCode = 503;
    return res.end('no healthy upstream');
  }
  target.served++;
  const peer = req.socket.remoteAddress || '';
  const up = http.request(
    {
      agent,
      hostname: target.url.hostname,
      port: target.url.port,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, 'x-forwarded-for': [req.headers['x-forwarded-for'], peer].filter(Boolean).join(', '), 'x-forwarded-proto': 'http', 'x-forwarded-host': req.headers.host },
    },
    (r) => {
      res.writeHead(r.statusCode || 502, r.headers);
      r.pipe(res);
    },
  );
  up.on('error', () => {
    target.healthy = false; // dial failed: out of rotation until the health probe sees it again
    if (!res.headersSent) res.statusCode = 502;
    res.end('bad gateway');
  });
  req.pipe(up);
});

async function probe() {
  await Promise.all(
    upstreams.map(
      (u) =>
        new Promise((resolve) => {
          const r = http.get({ hostname: u.url.hostname, port: u.url.port, path: healthUri, timeout: 1500 }, (resp) => {
            u.lastStatus = resp.statusCode;
            u.healthy = (resp.statusCode || 0) >= 200 && (resp.statusCode || 0) < 300;
            resp.resume();
            resolve();
          });
          r.on('timeout', () => r.destroy(new Error('timeout')));
          r.on('error', () => {
            u.lastStatus = 0;
            u.healthy = false;
            resolve();
          });
        }),
    ),
  );
}
await probe();
setInterval(probe, 2000).unref();
server.listen(listen, () => console.log(`lb-sim listening on :${listen} -> ${upstreams.map((u) => u.url.href).join(', ')} (policy ${policy}, health ${healthUri})`));
