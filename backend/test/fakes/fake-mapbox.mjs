#!/usr/bin/env node
/**
 * FAKE Mapbox (Search Box API) server for FORKY's automated tests. Port 4243 (override with PORT).
 *   MAPBOX_API_BASE=http://localhost:4243  MAPBOX_ACCESS_TOKEN=pk.fake.fake...  -> point the FORKY API at it
 *
 * Implements only what FORKY calls, with the real response shapes (April 2026 docs):
 *   GET /search/searchbox/v1/suggest?q&session_token&limit&types&country&bbox&proximity&language&access_token
 *   GET /search/searchbox/v1/retrieve/{mapbox_id}?session_token&access_token
 *   GET /search/searchbox/v1/reverse?longitude&latitude&limit&types&country&access_token
 *   GET /directions/v5/mapbox/driving/{lng,lat;lng,lat}?overview&alternatives&steps&access_token   (distance = 1.5 x the straight line, 40 km/h)
 *   GET /styles/v1/{user}/{style}/tiles/256/{z}/{x}/{y}[@2x]?access_token                          (a 1x1 PNG)
 * Plus  GET /_fake/stats (request counters: proves the FORKY cache), POST /_fake/reset and GET /_fake/fail-directions?n=2 (the next n Directions calls answer 503).
 * A token containing "invalid" is rejected with 401, exactly like Mapbox rejects a bad token.
 */
import http from 'node:http';

const PORT = Number(process.env.PORT || 4243);

const STREETS = [
  ['1', 'City Centre Dr', 'Mississauga', 'L5B 2G3', 43.5929, -79.6414],
  ['100', 'City Centre Dr', 'Mississauga', 'L5B 2C9', 43.5934, -79.6433],
  ['300', 'Dundas St W', 'Mississauga', 'L5B 1H4', 43.5851, -79.6496],
  ['7070', 'Kennedy Rd', 'Mississauga', 'L5S 1R9', 43.6531, -79.7143],
  ['25', 'Queen St E', 'Brampton', 'L6V 1A3', 43.6853, -79.7599],
  ['150', 'Main St N', 'Brampton', 'L6V 1N8', 43.6911, -79.7621],
  ['10', 'Peel Centre Dr', 'Brampton', 'L6T 4B9', 43.7183, -79.7231],
  ['55', 'Mill St N', 'Brampton', 'L6X 1T4', 43.6881, -79.7658],
  ['1', 'Yonge St', 'Toronto', 'M5E 1W7', 43.6444, -79.3747],
  ['123', 'Main Street', 'Ottawa', 'K1S 3N3', 45.4186, -75.6753], // outside the GTA box: proves the bbox filter
];

const place = (r) => ({ number: r[0], street: r[1], city: r[2], postcode: r[3], lat: r[4], lng: r[5] });
const idOf = (r) => Buffer.from(`fake:${r[0]}|${r[1]}|${r[2]}`).toString('base64url');
const fromId = (id) => { try { const [n, s, c] = Buffer.from(id, 'base64url').toString().replace(/^fake:/, '').split('|'); return STREETS.find((r) => r[0] === n && r[1] === s && r[2] === c); } catch { return null; } };
const ctx = (p) => ({
  address: { name: `${p.number} ${p.street}`, address_number: p.number, street_name: p.street },
  street: { name: p.street },
  postcode: { name: p.postcode },
  place: { name: p.city },
  region: { name: 'Ontario', region_code: 'ON', region_code_full: 'CA-ON' },
  country: { name: 'Canada', country_code: 'CA', country_code_alpha_3: 'CAN' },
});
const placeFormatted = (p) => `${p.city}, Ontario ${p.postcode}, Canada`;
const full = (p) => `${p.number} ${p.street}, ${placeFormatted(p)}`;

const zero = () => ({ suggest: 0, retrieve: 0, reverse: 0, directions: 0, tiles: 0, unauthorized: 0 });
let stats = zero();
let failDirections = 0;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const hav = (a, b) => { const R = 6371; const rad = (d) => (d * Math.PI) / 180; const dLat = rad(b[1] - a[1]); const dLng = rad(b[0] - a[0]); const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLng / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const q = url.searchParams;
  const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (url.pathname === '/_fake/stats') return send(200, stats);
  if (url.pathname === '/_fake/reset') { stats = zero(); failDirections = 0; return send(200, { ok: true }); }
  if (url.pathname === '/_fake/fail-directions') { failDirections = Number(q.get('n') || 1); return send(200, { failDirections }); }
  const token = q.get('access_token') || '';
  if (!/^(sk|pk)\./.test(token) || /invalid/i.test(token)) { stats.unauthorized++; return send(401, { message: 'Not Authorized - Invalid Token' }); }

  const tile = /^\/styles\/v1\/([^/]+)\/([^/]+)\/tiles\/256\/(\d+)\/(\d+)\/(\d+)(@2x)?$/.exec(url.pathname);
  if (tile) { stats.tiles++; res.writeHead(200, { 'content-type': 'image/png' }); return res.end(PNG); }
  const dir = /^\/directions\/v5\/mapbox\/driving\/(.+)$/.exec(url.pathname);
  if (dir) {
    stats.directions++;
    if (failDirections > 0) { failDirections--; return send(503, { message: 'Service Unavailable' }); }
    const pts = decodeURIComponent(dir[1]).split(';').map((s) => s.split(',').map(Number));
    if (pts.length !== 2 || pts.some((p) => p.length !== 2 || p.some((n) => !Number.isFinite(n)))) return send(422, { code: 'InvalidInput', message: 'Invalid coordinates' });
    const meters = Math.round(hav(pts[0], pts[1]) * 1.5 * 1000);
    return send(200, { code: 'Ok', routes: [{ distance: meters, duration: Math.round(meters / 11.1), weight: 1, weight_name: 'routability' }], waypoints: [] });
  }
  if (url.pathname === '/search/searchbox/v1/suggest') {
    stats.suggest++;
    const norm = (s) => String(s).toLowerCase().replace(/[,.]/g, ' ').replace(/\s+/g, ' ').trim();
    const text = norm(q.get('q') || '');
    if (!text) return send(400, { message: 'q is required' });
    if (!q.get('session_token')) return send(400, { message: 'session_token is required' });
    const country = (q.get('country') || '').toLowerCase();
    const bbox = (q.get('bbox') || '').split(',').map(Number);
    const prox = (q.get('proximity') || '').split(',').map(Number);
    let rows = STREETS.map(place).filter((p) => norm(full(p)).includes(text) || norm(`${p.number} ${p.street}`).includes(text));
    if (country && country !== 'ca') rows = [];
    if (bbox.length === 4 && bbox.every(Number.isFinite)) rows = rows.filter((p) => p.lng >= bbox[0] && p.lat >= bbox[1] && p.lng <= bbox[2] && p.lat <= bbox[3]);
    if (prox.length === 2 && prox.every(Number.isFinite)) rows.sort((a, b) => Math.hypot(a.lng - prox[0], a.lat - prox[1]) - Math.hypot(b.lng - prox[0], b.lat - prox[1]));
    const limit = Math.min(10, Number(q.get('limit') || 6));
    return send(200, {
      suggestions: rows.slice(0, limit).map((p) => {
        const r = STREETS.find((s) => s[0] === p.number && s[1] === p.street && s[2] === p.city);
        return { name: `${p.number} ${p.street}`, mapbox_id: idOf(r), feature_type: 'address', address: `${p.number} ${p.street}`, full_address: full(p), place_formatted: placeFormatted(p), context: ctx(p), language: 'en', maki: 'marker', metadata: {} };
      }),
      attribution: 'fake mapbox',
      response_id: 'fake',
    });
  }
  const m = /^\/search\/searchbox\/v1\/retrieve\/(.+)$/.exec(url.pathname);
  if (m) {
    stats.retrieve++;
    if (!q.get('session_token')) return send(400, { message: 'session_token is required' });
    const r = fromId(decodeURIComponent(m[1]));
    if (!r) return send(404, { message: 'Not Found' });
    return send(200, feature(place(r)));
  }
  if (url.pathname === '/search/searchbox/v1/reverse') {
    stats.reverse++;
    const lng = Number(q.get('longitude')); const lat = Number(q.get('latitude'));
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return send(400, { message: 'longitude and latitude are required' });
    let best = null;
    for (const r of STREETS) { const d = Math.hypot(r[5] - lng, r[4] - lat); if (!best || d < best.d) best = { d, r }; }
    if (!best || best.d > 0.02) return send(200, { type: 'FeatureCollection', features: [], attribution: 'fake mapbox' });
    return send(200, feature(place(best.r)));
  }
  return send(404, { message: 'Not Found' });
});

function feature(p) {
  const r = STREETS.find((s) => s[0] === p.number && s[1] === p.street && s[2] === p.city);
  return {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lng, p.lat] }, properties: { name: `${p.number} ${p.street}`, mapbox_id: idOf(r), feature_type: 'address', address: `${p.number} ${p.street}`, full_address: full(p), place_formatted: placeFormatted(p), context: ctx(p), coordinates: { longitude: p.lng, latitude: p.lat, accuracy: 'rooftop' } } }],
    attribution: 'fake mapbox',
  };
}

server.listen(PORT, () => console.log(`FAKE Mapbox listening on http://localhost:${PORT}`));
