#!/usr/bin/env node
/**
 * FAKE Google Maps Platform server for FORKSY's automated tests. Port 4244 (override with PORT). One server stands in for every Google host:
 *   GOOGLE_API_BASE=http://localhost:4244  GOOGLE_MAPS_API_KEY=AIza...  -> point the FORKSY API at it
 *
 * Implements only what FORKSY calls, with the real response shapes:
 *   POST /v1/places:autocomplete                  (Places API New: input, sessionToken, includedRegionCodes, locationRestriction | locationBias)   header X-Goog-Api-Key
 *   GET  /v1/places/{placeId}?sessionToken        header X-Goog-FieldMask                                                                         header X-Goog-Api-Key
 *   GET  /maps/api/geocode/json?latlng&key        (Geocoding API, answers HTTP 200 with "status")
 *   POST /directions/v2:computeRoutes             (Routes API: routes[].distanceMeters, duration "123s")                                          header X-Goog-Api-Key
 *   POST /v1/createSession?key                    (Map Tiles API session)
 *   GET  /v1/2dtiles/{z}/{x}/{y}?session&key      (a 1x1 PNG)
 * A key containing "INVALID" is rejected like Google rejects a bad key (400 API_KEY_INVALID on the new APIs, status REQUEST_DENIED on Geocoding).
 * Plus GET /_fake/stats, POST /_fake/reset and GET /_fake/fail-routes?n=2 (the next n route calls answer 503).
 * Route distance = 1.4 x the straight line (so it differs from Mapbox's 1.5 and from the built-in 1.3 estimate), 36 km/h.
 */
import http from 'node:http';

const PORT = Number(process.env.PORT || 4244);

const STREETS = [
  ['1', 'City Centre Dr', 'Mississauga', 'L5B 2G3', 43.5929, -79.6414],
  ['100', 'City Centre Dr', 'Mississauga', 'L5B 2C9', 43.5934, -79.6433],
  ['300', 'Dundas St W', 'Mississauga', 'L5B 1H4', 43.5851, -79.6496],
  ['7070', 'Kennedy Rd', 'Mississauga', 'L5S 1R9', 43.6531, -79.7143],
  ['25', 'Queen St E', 'Brampton', 'L6V 1A3', 43.6853, -79.7599],
  ['150', 'Main St N', 'Brampton', 'L6V 1N8', 43.6911, -79.7621],
  ['1', 'Yonge St', 'Toronto', 'M5E 1W7', 43.6444, -79.3747],
  ['123', 'Main Street', 'Ottawa', 'K1S 3N3', 45.4186, -75.6753], // outside the GTA box: proves the locationRestriction filter
];
const row = (r) => ({ number: r[0], street: r[1], city: r[2], postcode: r[3], lat: r[4], lng: r[5] });
const idOf = (r) => `ChIJfake${Buffer.from(`${r[0]}|${r[1]}|${r[2]}`).toString('base64url')}`;
const fromId = (id) => {
  try {
    const [n, s, c] = Buffer.from(String(id).replace(/^ChIJfake/, ''), 'base64url').toString().split('|');
    return STREETS.find((r) => r[0] === n && r[1] === s && r[2] === c);
  } catch { return null; }
};
const full = (p) => `${p.number} ${p.street}, ${p.city}, ON ${p.postcode}, Canada`;
const comps = (p) => [
  { longText: p.number, shortText: p.number, types: ['street_number'] },
  { longText: p.street, shortText: p.street, types: ['route'] },
  { longText: p.city, shortText: p.city, types: ['locality', 'political'] },
  { longText: 'Ontario', shortText: 'ON', types: ['administrative_area_level_1', 'political'] },
  { longText: 'Canada', shortText: 'CA', types: ['country', 'political'] },
  { longText: p.postcode, shortText: p.postcode, types: ['postal_code'] },
];
const geoComps = (p) => comps(p).map((c) => ({ long_name: c.longText, short_name: c.shortText, types: c.types }));

const zero = () => ({ autocomplete: 0, details: 0, geocode: 0, routes: 0, session: 0, tiles: 0, unauthorized: 0, lastAutocomplete: null });
let stats = zero();
let failRoutes = 0;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const hav = (a, b) => { const R = 6371; const rad = (d) => (d * Math.PI) / 180; const dLat = rad(b.lat - a.lat); const dLng = rad(b.lng - a.lng); const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); };

const readBody = (req) => new Promise((resolve) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => { try { resolve(c.length ? JSON.parse(Buffer.concat(c).toString()) : {}); } catch { resolve({}); } }); });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const q = url.searchParams;
  const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (url.pathname === '/_fake/stats') return send(200, stats);
  if (url.pathname === '/_fake/reset') { stats = zero(); failRoutes = 0; return send(200, { ok: true }); }
  if (url.pathname === '/_fake/fail-routes') { failRoutes = Number(q.get('n') || 1); return send(200, { failRoutes }); }

  const key = String(req.headers['x-goog-api-key'] || q.get('key') || '');
  const legacy = url.pathname.startsWith('/maps/api/');
  if (!/^AIza/.test(key) || /INVALID/i.test(key)) {
    stats.unauthorized++;
    if (legacy) return send(200, { status: 'REQUEST_DENIED', error_message: 'The provided API key is invalid.', results: [] });
    return send(400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'API key not valid. Please pass a valid API key.', details: [{ reason: 'API_KEY_INVALID' }] } });
  }

  if (url.pathname === '/v1/places:autocomplete' && req.method === 'POST') {
    stats.autocomplete++;
    const b = await readBody(req);
    stats.lastAutocomplete = b;
    const norm = (s) => String(s).toLowerCase().replace(/[,.]/g, ' ').replace(/\s+/g, ' ').trim();
    const text = norm(b.input || '');
    if (!text) return send(400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'input is required' } });
    if (!b.sessionToken) return send(400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'sessionToken is required' } });
    let rows = STREETS.map(row).filter((p) => norm(full(p)).includes(text) || norm(`${p.number} ${p.street}`).includes(text));
    const regions = (b.includedRegionCodes || []).map((x) => String(x).toLowerCase());
    if (regions.length && !regions.includes('ca')) rows = [];
    const rect = b.locationRestriction?.rectangle;
    if (rect) rows = rows.filter((p) => p.lng >= rect.low.longitude && p.lat >= rect.low.latitude && p.lng <= rect.high.longitude && p.lat <= rect.high.latitude);
    const c = b.locationBias?.circle?.center;
    if (c) rows.sort((a, z) => Math.hypot(a.lng - c.longitude, a.lat - c.latitude) - Math.hypot(z.lng - c.longitude, z.lat - c.latitude));
    return send(200, {
      suggestions: rows.slice(0, 5).map((p) => {
        const r = STREETS.find((s) => s[0] === p.number && s[1] === p.street && s[2] === p.city);
        return { placePrediction: { place: `places/${idOf(r)}`, placeId: idOf(r), text: { text: full(p), matches: [] }, structuredFormat: { mainText: { text: `${p.number} ${p.street}` }, secondaryText: { text: `${p.city}, ON, Canada` } }, types: ['street_address', 'geocode'] } };
      }),
    });
  }
  const pl = /^\/v1\/places\/([^/]+)$/.exec(url.pathname);
  if (pl && req.method === 'GET') {
    stats.details++;
    if (!q.get('sessionToken')) return send(400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'sessionToken is required' } });
    if (!req.headers['x-goog-fieldmask']) return send(400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'FieldMask is required' } });
    const r = fromId(decodeURIComponent(pl[1]));
    if (!r) return send(404, { error: { code: 404, status: 'NOT_FOUND', message: 'Place not found' } });
    const p = row(r);
    return send(200, { id: idOf(r), formattedAddress: full(p), location: { latitude: p.lat, longitude: p.lng }, addressComponents: comps(p) });
  }
  if (url.pathname === '/maps/api/geocode/json') {
    stats.geocode++;
    const [lat, lng] = String(q.get('latlng') || '').split(',').map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return send(200, { status: 'INVALID_REQUEST', results: [] });
    let best = null;
    for (const r of STREETS) { const d = Math.hypot(r[5] - lng, r[4] - lat); if (!best || d < best.d) best = { d, r }; }
    if (!best || best.d > 0.02) return send(200, { status: 'ZERO_RESULTS', results: [] });
    const p = row(best.r);
    return send(200, { status: 'OK', results: [{ formatted_address: full(p), address_components: geoComps(p), geometry: { location: { lat: p.lat, lng: p.lng } }, place_id: idOf(best.r), types: ['street_address'] }] });
  }
  if (url.pathname === '/directions/v2:computeRoutes' && req.method === 'POST') {
    stats.routes++;
    if (failRoutes > 0) { failRoutes--; return send(503, { error: { code: 503, status: 'UNAVAILABLE', message: 'The service is currently unavailable.' } }); }
    const b = await readBody(req);
    const o = b.origin?.location?.latLng; const d = b.destination?.location?.latLng;
    if (!o || !d || b.travelMode !== 'DRIVE') return send(400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'origin, destination and travelMode DRIVE are required' } });
    if (!req.headers['x-goog-fieldmask']) return send(400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'FieldMask is required' } });
    const meters = Math.round(hav({ lat: o.latitude, lng: o.longitude }, { lat: d.latitude, lng: d.longitude }) * 1.4 * 1000);
    return send(200, { routes: [{ distanceMeters: meters, duration: `${Math.round(meters / 10)}s` }] });
  }
  if (url.pathname === '/v1/createSession' && req.method === 'POST') {
    stats.session++;
    const b = await readBody(req);
    if (!b.mapType) return send(400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'mapType is required' } });
    return send(200, { session: `fakeSession${stats.session}`, expiry: String(Math.floor(Date.now() / 1000) + 14 * 86400), tileWidth: 256, tileHeight: 256, imageFormat: 'png' });
  }
  if (/^\/v1\/2dtiles\/\d+\/\d+\/\d+$/.test(url.pathname)) {
    stats.tiles++;
    if (!q.get('session')) return send(400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'session is required' } });
    res.writeHead(200, { 'content-type': 'image/png' });
    return res.end(PNG);
  }
  return send(404, { error: { code: 404, status: 'NOT_FOUND', message: `Not found: ${req.method} ${url.pathname}` } });
});

server.listen(PORT, () => console.log(`FAKE Google Maps listening on http://localhost:${PORT}`));
