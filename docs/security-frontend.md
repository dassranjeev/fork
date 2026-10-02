# Front-end security (Admin Console and Restaurant Portal)

Scope: `admin/` (React CRA). Backend hardening is tracked separately. "Hack free" cannot be guaranteed; this is
defence in depth: escape on output, sanitise where HTML is a feature, strict CSP, short-lived sessions, no third-party
runtime requests, dependency hygiene.

## Findings

| # | Severity | Issue | Fix | Evidence |
|---|---|---|---|---|
| 1 | High | ApexCharts tooltips build HTML with `innerHTML` from series names / categories / x values (chart labels come from API data such as restaurant and driver names). | `chartSafe()` in `src/lib/safe.js`, applied in every chart component (`ui/charts.jsx`). | Before: with a mutated API response, `/analytics/drivers` rendered `<script>` inside `.apexcharts-tooltip-title` (test failed). After: smoke test passes in both CSP-on and CSP-off modes. |
| 2 | High | `public/chat-demo.html` is same-origin with the admin (shares localStorage tokens) and built HTML with `innerHTML` from API/socket values, loaded socket.io from a CDN without SRI, and used a big inline script. | Script moved to `chat-demo.js`; every value passed through `esc()`; attachments restricted to http(s)/relative; socket.io self-hosted (`public/socket.io.min.js`); own strict CSP meta; removed from production builds by `scripts/postbuild.mjs`. | Smoke test loads the page with stubbed API responses full of payloads: nothing executes. |
| 3 | High | Leaflet `divIcon` HTML string interpolated `color` and `glyph` (data) into markup (`ui/map.jsx`). | `safeColor()` allow-list + `escapeHtml()`. | Code review; smoke test feeds `color` payloads. |
| 4 | Medium | Invoice HTML (portal finance) written with `window.open().document.write()` into a same-origin window (full access to tokens if the HTML were ever hostile). | Sanitised with DOMPurify (`sanitizeDocument`) and opened as a blob document with `noopener`. | Code. |
| 5 | Medium | `href`/`src` taken from data (attachments, document URLs, avatars, banners, QR codes) allowed `javascript:` / `data:` URLs. | `safeUrl()` / `safeImgUrl()` in `src/lib/safe.js` used at all sinks; all `_blank` links have `rel="noopener noreferrer"`. | Smoke test injects `javascript:`, `data:`, `vbscript:`, protocol-relative URLs into every URL-like field and asserts none reach the DOM. |
| 6 | Medium | Icons were fetched at runtime from `api.iconify.design`, `api.unisvg.com`, `api.simplesvg.com` (third-party requests, leaks usage, blocked by a strict CSP). | Icons bundled offline (`scripts/build-icons.mjs` -> `src/lib/icons.generated.js`, `@iconify/react/offline`). Run `npm run icons` after adding an icon. | Smoke test asserts there are no requests to hosts other than the app, the API and OSM tiles. |
| 7 | Medium | Google Fonts `@import` in `style.css` (third-party, CSP). | Inter self-hosted (`public/assets/css/inter.css`, `public/assets/fonts/inter/`). | CSP has no font host. |
| 8 | Medium | No CSP / referrer policy / frame protection. | CSP + referrer `<meta>` in `public/index.html` (origins from `REACT_APP_CSP_*`), `public/frame-guard.js` frame-busting fallback. Note `frame-ancestors` cannot be set by meta: send it as a header (below). | Smoke test in CSP mode: zero unexpected violations on all admin and portal pages. |
| 9 | Medium | Logout did not clear `forksy.*` keys, no idle timeout, authenticated pages restorable via back button / bfcache. | `clearAppStorage()`; `IdleGuard` (admin 30 min, portal 8 h, KDS exempt, 60 s warning, cross-tab activity); logout does a hard `location.replace('/sign-in')`; `pageshow` reload when restored without a token; cross-tab logout via `storage` event. | Verified in Playwright: after logout `localStorage` is empty and back does not show the app; fake-clock test logs out to `/sign-in?reason=idle` with empty storage. |
| 10 | Medium | Tokens in localStorage (any XSS is fatal). | Not changed: the backend has no httpOnly-cookie flow (`/auth/refresh` takes the token in the body). See recommendation below. Impersonation token stays in sessionStorage. | `backend/src/auth` has no cookie handling. |
| 11 | Low | Upload inputs did not validate type or size. | `validateUpload()` (10 MB; PNG/JPEG/WebP/GIF/PDF; SVG and HTML rejected) in `http.upload` and the chat uploader. | Code. |
| 12 | Low | Missing `autocomplete` on login / password forms. | `username`, `current-password`, `new-password`, `one-time-code`. | Code. |
| 13 | Low | Vulnerable / unused dependencies. | `npm audit fix` (70 -> 33 advisories, 0 critical), `react-router-dom` -> 6.30, unused `xlsx` (no fix available) removed, `dompurify` added. | See Dependencies. |
| 14 | Info | `GENERATE_SOURCEMAP=false`, `INLINE_RUNTIME_CHUNK=false` added to `.env` / `.env.example`; build verified: no inline script, no `.map` files. | | `npm run build` |

Already fine: React escapes all text; no `dangerouslySetInnerHTML`, `eval`, `new Function`, `document.write` or `innerHTML`
in the routed app (the only previous `document.write` was fixed in 4). Leaflet popups/tooltips are React portals (text).
Settings secrets are never prefilled (`isSecret` -> blank, "leave blank to keep"). No `console.log` in routed code.
Open redirect: sign-in uses router `state.from` (not a URL parameter); `safeInternalPath()` is available if a `?next=` is added.
Route guards: unauthenticated `/`, `/portal`, `/orders/..`, `/portal/kds` -> `/sign-in`; owner token at `/` or `/orders` -> `/portal`
with zero `/admin/*` API calls; admin token at `/portal` -> `/` (auth state is resolved via `/auth/me` before any route renders).

### Template leftovers
`src/components`, `src/pages`, `src/masterLayout`, `src/hook` are WowDash demo code that is not routed and not bundled
(jQuery, DataTables, Quill `innerHTML`, console.log live there). Delete them when convenient; if one is ever routed, review it first.

## Client-side authorization is cosmetic (notes for the backend)
Menu hiding and `can()` only affect the UI. Every `/admin/*`, `/restaurant/*` call must enforce role, permission, tenant
(restaurantId/merchantId ownership) and refund limits server-side. Specifically verify: restaurant users cannot pass another
`restaurantId`; staff without a permission get 403 on the API, not just a hidden button; `/uploads` enforces type/size/content
sniffing and serves with `X-Content-Type-Options: nosniff` and `Content-Disposition` for non-images (stored SVG/HTML upload =
XSS on the API origin); socket.io rooms are derived from the token only.

## Recommended backend change: tokens
Move the refresh token to an `HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth` cookie, keep the access token in memory
only (restore via refresh on page load), rotate refresh tokens and revoke on reuse. Until then localStorage tokens mean an XSS
equals account takeover, which is why the CSP and escaping above matter.

## Dependencies
`npm audit` (admin): before 70 (14 low, 16 moderate, 37 high, 3 critical); after safe fixes 33 (9 low, 8 moderate, 16 high, 0 critical).
`tools/pg`: 0. Remaining are almost all the `react-scripts` 5 toolchain (webpack-dev-server, svgo/@svgr, postcss, workbox,
serialize-javascript, jest/jsdom, nth-check): dev/build time only, not shipped to browsers. Shipped runtime items:
`react-router` 6.x moderate (open redirect via backslash in `<Link>`/`navigate` and SSR-only deserialisation; we only navigate
to static or internal paths; fix needs v7), `react-quill`/`quill` and `uuid` (only used by unrouted template code).
`xlsx` (no fix available) was removed. Recommendation: migrate from CRA to Vite (and React Router 7) to clear the toolchain
advisories; do not use `npm audit fix --force` (it installs `react-scripts@0.0.0`).

## Production headers

Build: `GENERATE_SOURCEMAP=false INLINE_RUNTIME_CHUNK=false REACT_APP_API_URL=https://api.example.com/api/v1 REACT_APP_WS_URL=https://api.example.com REACT_APP_CSP_CONNECT="https://api.example.com wss://api.example.com" REACT_APP_CSP_IMG="https://api.example.com" npm run build`
(do not include `ws://localhost:3000` or `http://localhost:4000` in production). The meta CSP is baked into `build/index.html`;
send the same policy as a header and add `frame-ancestors 'none'` (not allowed in meta).

### nginx
```nginx
add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.tile.openstreetmap.org https://api.example.com; font-src 'self' data:; connect-src 'self' https://api.example.com wss://api.example.com; media-src 'self' blob: https://api.example.com; object-src 'none'; base-uri 'self'; form-action 'self'; frame-src 'none'; frame-ancestors 'none'; worker-src 'self' blob:; upgrade-insecure-requests" always;
add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
add_header X-Frame-Options "DENY" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=()" always;
add_header Cross-Origin-Opener-Policy "same-origin" always;

location = /index.html { add_header Cache-Control "no-store"; }          # + repeat the headers above
location /static/ { add_header Cache-Control "public, max-age=31536000, immutable"; }
location / { try_files $uri /index.html; }
```
(`add_header` is not inherited into a location that defines its own, so repeat or `include` the header block.)

### Cloudflare (Transform Rules -> Modify Response Header, or `_headers` on Pages)
```
/*
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.tile.openstreetmap.org https://api.example.com; font-src 'self' data:; connect-src 'self' https://api.example.com wss://api.example.com; object-src 'none'; base-uri 'self'; form-action 'self'; frame-src 'none'; frame-ancestors 'none'
  Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()
/index.html
  Cache-Control: no-store
/static/*
  Cache-Control: public, max-age=31536000, immutable
```
Also set `Cache-Control: no-store` on authenticated API responses (backend) so the back button and shared proxies never cache data.

## Residual risks
- Tokens in localStorage (needs the backend cookie flow).
- `style-src 'unsafe-inline'` is required by Bootstrap/WowDash, ApexCharts and Leaflet inline styles; script-src has no inline or eval. CSS injection is therefore not blocked (low impact: no scripts, no data exfil without img/connect to attacker hosts, which the CSP forbids).
- Dev server: CRA dev needs the websocket origin in `connect-src` (`ws://localhost:3000`, set in `.env`); never ship that.
- Meta CSP cannot send `frame-ancestors`, `report-uri` or apply to the first bytes before the tag; headers are the real control.
- CRA 5 toolchain advisories (build-time) until a Vite migration.
- Server must also validate uploads and sanitise stored content; this layer does not replace that.

## Regression test
`node admin/test/xss-smoke.mjs` (needs Playwright: `PLAYWRIGHT_DIR=<folder with node_modules/playwright>` if it is not installed in `admin/`).
Env: `BASE_URL`, `API_URL`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `OWNER_EMAIL`, `OWNER_PASSWORD`, `CSP_ONLY=1`, `NOCSP_ONLY=1`, `HEADED=1`, `MAX_DETAIL`.
Logs in once per account, rewrites GET API responses with payloads (`<img onerror>`, `<script>`, `"><svg/onload>`, `javascript:` URLs,
`{{constructor...}}`, colour break-outs), sweeps every sidebar link plus detail pages with chart hovering, in CSP-on and CSP-off modes, and
asserts: no `window.__xss`, no dialogs, no inline handlers / `javascript:` links / iframes / payload scripts in the DOM, no page errors,
no third-party requests, no unexpected CSP violations, and `chat-demo.html` with hostile stubbed responses. Exit code 1 on failure.
