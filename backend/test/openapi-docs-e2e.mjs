#!/usr/bin/env node
/**
 * The Swagger UI of the API is linked to the OpenAPI file: REAL HTTP against a running API with API docs on (SWAGGER_ENABLED=true, the default in development).
 *
 *   API_ORIGIN=http://localhost:4000 node backend/test/openapi-docs-e2e.mjs
 *
 * Proves: /docs is the Swagger UI, /docs/openapi.json and /docs/openapi.yaml serve the OpenAPI file, /docs-json still works (redirect), the live document says
 * the same as the exported file docs/openapi/openapi.json (same routes, same schemas, the observed response shapes included: the checkout quote), and the page
 * tells where to get the file. Run `cd backend && npm run openapi:export` after changing the API: this test fails when the committed file is stale.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ORIGIN = (process.env.API_ORIGIN || 'http://localhost:4100').replace(/\/$/, '');
const FILE = process.env.OPENAPI_FILE || join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'openapi', 'openapi.json');
let failed = 0;
const check = (name, ok, extra) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && extra !== undefined ? '  -> ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 300) : ''}`);
  if (!ok) failed++;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const ui = await fetch(ORIGIN + '/docs/');
const html = await ui.text();
check('GET /docs is the Swagger UI', ui.status === 200 && /swagger-ui/i.test(html), ui.status);
check('...with a Content-Security-Policy that only applies to the docs page', /script-src/.test(ui.headers.get('content-security-policy') || ''));

const jr = await fetch(ORIGIN + '/docs/openapi.json');
const live = await jr.json().catch(() => null);
check('GET /docs/openapi.json serves the OpenAPI file (JSON, OpenAPI 3)', jr.status === 200 && /json/.test(jr.headers.get('content-type') || '') && /^3\./.test(live?.openapi ?? ''), jr.status);
const yr = await fetch(ORIGIN + '/docs/openapi.yaml');
const yml = await yr.text();
check('GET /docs/openapi.yaml serves the same file as YAML', yr.status === 200 && /^openapi: 3\./m.test(yml) && /paths:/.test(yml), yr.status);
const old = await fetch(ORIGIN + '/docs-json', { redirect: 'manual' });
check('/docs-json (the Nest default that tools expect) redirects to /docs/openapi.json', old.status === 301 && /\/docs\/openapi\.json$/.test(old.headers.get('location') || ''), { s: old.status, l: old.headers.get('location') });
const viaOld = await fetch(ORIGIN + '/docs-json');
check('...and following the redirect gives the file', viaOld.status === 200 && (await viaOld.json()).info?.title === 'FORKSY API');

check('the live page tells where to get the file (links in its description)', /\/docs\/openapi\.json/.test(live?.info?.description ?? '') && /\/docs\/openapi\.yaml/.test(live.info.description) && /raw\.githubusercontent\.com/.test(live.info.description), live?.info?.description?.slice(-300));
check('...and the title and sign-in text are there', live?.info?.title === 'FORKSY API' && /POST \/auth\/login/.test(live.info.description));

const file = JSON.parse(readFileSync(FILE, 'utf8'));
const liveOps = Object.values(live.paths).reduce((n, p) => n + Object.keys(p).length, 0);
const fileOps = Object.values(file.paths).reduce((n, p) => n + Object.keys(p).length, 0);
check('the live document and the exported file have the same routes', same(Object.keys(live.paths), Object.keys(file.paths)) && liveOps === fileOps, { live: liveOps, file: fileOps });
check('...the same schemas (the committed file is not stale)', same(live.components.schemas, file.components.schemas), 'run: cd backend && npm run openapi:export');
check('...the same route groups', same(live['x-tagGroups'], file['x-tagGroups']));
check('...the same operations in detail (responses, parameters, bodies)', same(live.paths, file.paths), (() => { for (const p of Object.keys(file.paths)) if (!same(live.paths[p], file.paths[p])) return p; return ''; })());

const quote = live.paths['/api/v1/customer/checkout/quote']?.post?.responses?.['201']?.content?.['application/json']?.schema;
check('the checkout quote answer is described (it used to be missing): totals, lines, fees, ETA', !!quote && ['total', 'subtotal', 'deliveryFee', 'serviceFee', 'taxAmount', 'tip', 'lines', 'etaMinutes', 'prepTimeMin', 'requiresIdCheck', 'basket', 'storeType'].every((k) => k in (quote.properties ?? {})), Object.keys(quote?.properties ?? {}));
const lines = quote?.properties?.lines?.items?.properties ?? {};
check('...with the line fields, including the grocery ones (weights, SKU, age)', ['name', 'quantity', 'unitPrice', 'lineTotal', 'taxAmount', 'sku', 'sellBy', 'estimatedWeight', 'minAge', 'temperature'].every((k) => k in lines), Object.keys(lines));
const cart = live.paths['/api/v1/customer/cart/replace']?.post?.responses?.['201'];
check('the cart answer is described too', !!cart?.content?.['application/json']?.schema?.properties?.lines);
for (const route of ['/api/v1/public/store-types', '/api/v1/public/stores', '/api/v1/public/stores/{slug}', '/api/v1/public/stores/{slug}/catalog', '/api/v1/public/stores/{slug}/products/{itemId}', '/api/v1/restaurant/menu/items', '/api/v1/restaurant/menu/stock', '/api/v1/restaurant/orders/{id}/items/{itemId}/pick']) {
  check(`documented: ${route}`, !!live.paths[route], route);
}
const pick = live.components.schemas.PickItemDto;
check('the picking request body is documented (status, actualWeight, replacementItemId)', !!pick && ['status', 'actualWeight', 'replacementItemId', 'replacementQuantity', 'note'].every((k) => k in pick.properties) && pick.required?.includes('status'), pick);
const deliver = live.components.schemas.DeliverDto;
check('the delivery body documents the ID check (idChecked / idRefused)', !!deliver && 'idChecked' in deliver.properties && 'idRefused' in deliver.properties, Object.keys(deliver?.properties ?? {}));
const cat = live.paths['/api/v1/public/stores/{slug}/catalog']?.get?.responses?.['200']?.content?.['application/json']?.schema?.properties;
check('the catalog answer is described (products, departments, paging)', !!cat && 'data' in cat && 'categories' in cat && 'meta' in cat, Object.keys(cat ?? {}));
const siteTags = Object.fromEntries((live.tags ?? []).map((t) => [t.name, t.description ?? '']));
const siteOps = Object.entries(live.paths).filter(([p]) => /\/(admin|public)\/site\b/.test(p)).flatMap(([, o]) => Object.values(o));
check('the website settings endpoints are all under "Admin / website settings" or "Public / website settings" (one tag each), described, with a link to the guide', siteOps.length >= 20 && siteOps.every((op) => op.tags?.length === 1 && /website settings$/.test(op.tags[0])) && /site-settings\.md/.test(siteTags['Admin / website settings'] ?? '') && /site-settings\.md/.test(siteTags['Public / website settings'] ?? ''), siteTags);

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall OpenAPI / Swagger checks passed');
process.exit(failed ? 1 : 0);
