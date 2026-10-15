# FORKSY – Security

Scope of this document: the **backend** (`backend/`, NestJS + TypeORM + PostgreSQL + Socket.IO). The admin console
(`admin/`) is hardened separately – see `docs/security-frontend.md`.

> **Honest limits.** No system can be guaranteed "hack free". This hardening removes every weakness found by a code
> review plus live attack testing of the owner's own app, and adds layered controls so that the next, unknown bug has a
> smaller blast radius. It is not a substitute for an independent penetration test, for infrastructure protection
> against volumetric DDoS (section 7), or for operational discipline (patching, secret handling, monitoring).
> Everything marked *Fixed* below was reproduced with a real request first and re-tested afterwards; the evidence
> files are in `docs/security-evidence/`.

---

## 1. Threat model (summary)

| Asset | Attacker | Main abuse paths considered |
|---|---|---|
| Money (payments, wallet, refunds, payouts, tips, promos) | malicious customer / driver / restaurant / insider | free orders, refund inflation, double-spend/redeem races, tip/credit minting, payout tampering, fake deliveries |
| Accounts and sessions | anonymous internet | credential stuffing, brute force, OTP/2FA guessing, token forgery, user enumeration, session fixation/replay |
| Tenant data (customers, merchants, drivers) | authenticated user of another tenant | IDOR / BOLA, `?restaurantId=` tampering, role confusion, staff privilege escalation, mass assignment |
| Platform integrity | anonymous / authenticated | injection (SQL, NoSQL-style, CSV/formula), stored XSS into the admin console / portals, malicious uploads, SSRF, webhook forgery |
| Availability | anonymous / authenticated | request floods, slowloris, oversized / deeply nested bodies, expensive queries, socket floods, notification fan-out |
| Operator mistakes | us | insecure defaults reaching production (demo accounts, default JWT secret, mock payments, open Swagger) |

Trust boundaries: Internet → (CDN/WAF/LB) → API (`/api/v1`, Socket.IO) → PostgreSQL. The API is the only component
that talks to the database; apps never receive card data (Stripe tokens only).

---

## 2. Findings log

Severity: **Critical** (direct loss of money / full takeover) · **High** · **Medium** · **Low**.
"Evidence" files live in `docs/security-evidence/`; *before* = vulnerable behaviour reproduced, *after* = blocked.

### Critical

| ID | Issue | Exploit evidence (before → after) | Fix | Status |
|---|---|---|---|---|
| F-01 | **Forgeable super-admin token.** `JWT_SECRET` fell back to / was set to a published default (`change-me-to-a-long-random-string`, also in `.env.example`); a token signed with it was accepted. No `iss`/`aud`, algorithm not pinned. | `atk1`: forged JWT with the default secret → **200** (super admin) → **401** | Dev secret rotated; production gate refuses default/short/low-entropy secrets; HS256 pinned, `iss`/`aud` required (`jwt.strategy.ts`, `auth.module.ts`) | Fixed |
| F-02 | **Payments always succeeded.** `PaymentsService.authorize()` inserted a mock `SUCCEEDED` payment whatever `paymentToken`/`paymentMethod` was sent – even in production, even with a Stripe key ("TODO"). Mock payout transfers and mock reconciliation could also run in production. `CASH` was never disabled. | code path reproduced in review; checkout with `paymentToken: "x"` → order AUTHORIZED → CAPTURED without any charge | Real Stripe PaymentIntents (manual capture/cancel/refund, ownership check of saved cards, idempotency keys); **fail closed**: production + no key ⇒ 503, mock only when `NODE_ENV!=production`; payouts/reconciliation fail closed; cash only when the setting allows; wallet/gift-card method must cover the total (`payments.service.ts`, `finance.providers.ts`, `orders.service.ts`) | Fixed – **needs QA with live Stripe keys** |
| F-03 | **Staff privilege escalation.** A user with `roles:edit` could add any permission (and unlimited refunds) to *their own role*; `staff:edit` could assign any role, create accounts in stronger roles, reset password + 2FA of a Finance Manager, read the returned temporary password and log in as them. | `staff_before2.txt`: S1 role self-edit **200**, finance dashboard **403 → 200**; S3 create staff in stronger role **201**; S4 password+2FA reset and **account takeover**; S5 revoke sessions **201** → all **403** (`staff_after.txt`) | Privilege ceiling (cannot grant/edit/act on anything above your own permissions or refund limit), no self role edit/change, only Super Admin sets unlimited refund limit, reserved role names, UUID pipes, every staff/role change audited as `security.*` (`staff.module.ts`) | Fixed |
| F-04 | **Refund cap bypass.** `POST /admin/orders/:id/refund` accepted `"abc"`, `"NaN"`, `"1e308"`, `999999` for a $343 order (NaN poisoned the cap arithmetic); no locking so 6 concurrent refunds of 70 % all succeeded; approve could double-settle. | `refund_before.txt`: 4 bad amounts **201 PROCESSED**, 6 concurrent **201×6** → after: **400×6**, race **201,400×5** | Strict numeric DTO + `Number.isFinite`, cap check under a row lock (pending refunds count), atomic approve/reject claim, four-eyes rule (`refunds.service.ts`, `admin-orders.controller.ts`) | Fixed |

### High

| ID | Issue | Evidence | Fix | Status |
|---|---|---|---|---|
| F-05 | **Unauthenticated Certn webhook** could mark any driver's background check CLEAR (and the mock auto-cleared drivers in production). | `atk1` A3: **201** → **401** (needs `CERTN_WEBHOOK_SECRET`; HMAC or shared secret, timing-safe; mock disabled in production) | `certn-webhook.controller.ts`, `certn.adapter.ts` | Fixed |
| F-06 | **Delivery PIN / pickup code bypass.** An omitted or empty code skipped the check: a driver could complete a high-value (PIN) order with `{}`. | `pin_before.txt`: delivered with no PIN → **DELIVERED, CAPTURED** → `pin_after.txt`: **403**, order stays PICKED_UP | Codes mandatory when the order requires them, constant-time compare, non-empty DTOs; arrival ("arrived at customer") required; geofence now `delivery.proof.geofenceMeters` (default 150 m, enforced) plus photo/PIN proof rules (`orders/proof.service.ts`, see proof-of-delivery.md) | Fixed |
| F-07 | **Tip edit window never closed.** `PATCH /customer/orders/:id/tip` three days after delivery minted a $147 driver ledger credit (and works on cancelled orders). | `tip_before.txt`: **200**, ledger 3 → 150 → `tip_after.txt`: **400** window closed | Window anchored on `deliveredAt`, no tips on cancelled orders, finite-number check | Fixed |
| F-08 | **Single-use promo race.** Check-then-redeem without locking: 8 concurrent checkouts with a `usageLimit=1` code. | `logic_before2.txt` L10: **7 of 8** orders discounted, `usedCount=7` → `logic_after.txt`: **1**, `usedCount=1` | Atomic conditional UPDATE + advisory lock for per-user limit; promo reserved atomically while the order is created (the card was already charged and verified) and released again on failure | Fixed |
| F-09 | **Self-serve "never arrived" auto-refunded the full total** for undelivered, cancelled or pickup orders. | `logic_before.txt` L1: **refund $26.13 auto-issued** on a just-placed order → after: no refund, routed to an agent | Auto-eligible only for delivered, captured delivery orders (`order-context.service.ts`) | Fixed |
| F-10 | **Rate limit and brute-force protection bypass via `X-Forwarded-For`** (`trust proxy 1` + code that trusted the header). 14 failed logins from "different" IPs were never throttled. | `atk1_before`: `401×14` → `atk1_after`/`load_after`: lockout after 5, `429` | `TRUST_PROXY` hop count (default 0 = header ignored) and one `clientIp()` helper everywhere | Fixed |
| F-11 | **Any `settings:edit` staff could disable security settings** (2FA enforcement, password length, approval thresholds → string). | `logic_before.txt` L6: **200**, `enforce2faStaff=false`, `passwordMinLength=1`, threshold `"unlimited"` → **403** | Privileged key families Super-Admin-only, value must keep its JSON type, denial audited; `isSecret` never public | Fixed |
| F-12 | **Stored XSS everywhere.** No input sanitising; names, addresses, notes, tickets, menu text, CMS, FAQ, campaigns, banners (`javascript:` URLs) were stored raw and rendered by the portals. | `xss_after.txt`: 11 field groups with `<img onerror>`, `<script>`, `"><svg/onload>`, `javascript:` → all neutralised (before: no code path stripped anything) | Global `InputSanitizerInterceptor`: tags/control/bidi characters stripped, URL fields must be http(s)/relative, CMS/FAQ through a strict `sanitize-html` allow-list, prototype-pollution keys rejected (`common/security.ts`, `input.interceptor.ts`) | Fixed |
| F-13 | **Hostile uploads.** Extension allow-list only (SVG allowed), client MIME trusted, served inline from the API origin. | `upload_after.txt` | Magic-byte detection, random server-side names, per-type size caps, SVG/HTML/JS rejected, served with `nosniff`, sandbox CSP, `attachment` for non-images, legacy svg/html forced to download (`uploads.module.ts`) | Fixed |
| F-14 | **Social sign-in accepted any Google/Apple token** (no audience check) – a token minted for another app logs into ours. | code review | `GOOGLE_CLIENT_IDS`/`APPLE_CLIENT_IDS` audience check, verified-email only, closed in production when unset | Fixed |
| F-15 | **Restaurant finance data and secrets visible to every portal role.** KITCHEN/CASHIER read payouts, invoices, ledger, sales/commission reports, tablet activation code and POS credentials. | `logic_before.txt` L4: **200 ×4, EXPOSED** → **403**, hidden | Finance controller owner-only; sales/promotion reports managers+, payouts owner; store view redacted for non-managers | Fixed |
| F-16 | **Driver bank details changeable with a stolen token**, instant cash-out immediately afterwards. | `logic_before.txt` L7: **200**, bank = attacker → **400** (password required) | `currentPassword` re-auth, 24 h cash-out hold after a change, ACTIVE drivers only | Fixed |
| F-17 | **Driver GPS injected into any order** (REST `orderId`, Socket.IO `driver.location` spread the raw body, so `driverId`/fields could be spoofed). | `logic_before.txt` L5: 1 GPS row attached to the victim order → 0; `socket_after.txt` S5 | Only the driver's own active orders; identity from the authenticated socket; fixed field set; range checks; event rate limit | Fixed |
| F-18 | **Order tracking (driver phone, PIN, address) and chat readable/writable by any staff user**, regardless of permissions or city scope. | code review; smoke test | `orders:view`/`orders:edit` required, city/zone scope applied | Fixed |
| F-19 | **Tickets could be filed against other customers' orders / arbitrary restaurants; unvalidated attachments** (`javascript:` URLs). | `logic_before.txt` L2: **201 LINKED** → **404**; attachments filtered | Order ownership check, attachment whitelist (own uploads only) | Fixed |
| F-20 | **Races on money state:** double cancel/credit, offer accept, payout approve/release, campaign send, shift capacity. | code review (static) + order-transition claim exercised by the lifecycle regression | Atomic `UPDATE … WHERE status = :from` claims with rollback on failure; dual control for payouts; adjustments > `finance.maxManualAdjustment` need a Super Admin | Fixed |
| F-21 | **Mass assignment / untyped bodies:** `Partial<Dto>` bodies (stations, canned replies) bypassed validation; primitive `@Body('x')` fields; `PageQueryDto & {…}` queries skipped validation. | review | DTO classes everywhere, global `whitelist + forbidNonWhitelisted` (strict string pipe rejects objects/arrays in string fields: NoSQL-style `{"$ne":null}`), safety-net paging limits | Fixed |
| F-22 | **5 MB JSON body limit**, 4 MB bodies processed; no nesting/array/string limits. | `atk1_before` A2: processed → **413**; deep/array/long strings **400** | 100 kb default, 2 MB for the CSV import only, structural limits in the sanitiser | Fixed |
| F-23 | **Socket.IO** CORS `origin:true`, no size/rate/connection limits, blocked users could connect, `zone.subscribe`/`order.subscribe` unvalidated. | `atk1_before` A6b: ACAO echoed evil origin → null; `socket_after.txt` | Origin allow-list, 16 KB messages, ping timeouts, per-IP/per-user connection caps, per-socket event limits, status + token-version check at connect | Fixed |

### Medium

| ID | Issue | Fix |
|---|---|---|
| F-24 | User enumeration by timing (bcrypt skipped for unknown accounts), by "account locked" message, by forgot-password "wait a moment" | Dummy bcrypt of the same cost, identical `429`/`401` bodies, generic forgot-password (`authn_after.txt` A8: 365 ms known vs 336 ms unknown, previously 90 ms vs 340 ms) |
| F-25 | Weak brute-force protection (5 tries/account, 15 min flat lock; none for 2FA/OTP/reset) | Per-account **and** per-IP progressive lockout (doubling to 24 h) across login, 2FA, OTP, reset (`login-protection.service.ts`) |
| F-26 | Access tokens survived password change / logout-all / block; refresh rotation was racy | Exact `tokenVersion` revocation, atomic refresh rotation + reuse detection, `change-password` returns fresh tokens (`authn_after.txt` A2–A5) |
| F-27 | TOTP: no attempt limit, replay allowed, seed in plaintext | Lockout, one-time codes, AES-256-GCM sealing (`DATA_ENCRYPTION_KEY`) (`twofa_after.txt`) |
| F-28 | Weak password policy (min 8, the setting could only lower it) | Min 10 (setting, floor 8), letters+digits, common-password block-list, max 128 (bcrypt), hashes upgraded to cost 12 |
| F-29 | Impersonation (`/admin/restaurants/:id/impersonate`): `restaurants:edit`, 2 h, bank/staff routes reachable | `restaurants:approve`, 1 h, `@NoImpersonation` on bank, staff, auth routes; audited as before |
| F-30 | CSV/Excel formula injection in 6 exports (payout export had no quoting at all) | One shared `common/csv.ts` (`csv_before.txt`: `=HYPERLINK(…)` live → `'=HYPERLINK` neutralised) |
| F-31 | Swagger (`/docs`, `/docs-json`) enabled in every environment | Off by default in production (`SWAGGER_ENABLED`), dev CSP scoped to `/docs` |
| F-32 | Error handler echoed DB constraint details (PII), reflected URL/query; 500 on bad `sortDir`, invalid dates, missing rows | Generic production messages, path without query, mapped to 400/404, `sortDir`/`sortBy` whitelisted (own-property lookup) |
| F-33 | Insecure defaults reaching production (`EXPOSE_OTP=true`, `DB_SYNC=true`, localhost CORS, demo accounts, default admin password, no 2FA) | **Production safety gate** (section 4) – the process refuses to start |
| F-34 | Production mock SMS/email adapters logged OTP bodies | Never logged in production |
| F-35 | Unsubscribe token: `'change-me'` fallback secret, `===` compare | No fallback, constant-time compare |
| F-36 | `security.ipAllowlist` setting existed but was not enforced | Enforced for staff/super-admin (exact IPs + IPv4 CIDR) |
| F-37 | Slowloris: 30 s connection check interval; unlimited header count; idle sockets | `headersTimeout 15 s` (+3 s check), `requestTimeout 60 s`, `maxConnections`, `maxHeadersCount`; slowloris dropped after **20 s** (Node defaults: header timeout 60 s + a 30 s check interval, i.e. up to ~90 s) |
| F-38 | Expensive dashboards/exports: no statement timeout, no limits, no caching | `statement_timeout` 15 s + pool limits, 5 s micro-cache + single-flight on analytics, exports 10/min, paging caps (`page ≤ 10 000`, `limit ≤ 500/1000`) |
| F-39 | Campaign send: double-send race, unbounded audience, no batching | Atomic claim, 50 000 cap, 25-per-batch pacing |
| F-40 | SMS pumping / mail bombing on OTP endpoints | ≤ 5 codes per target+purpose per hour, strict per-route throttles |
| F-41 | Staff create/reset returned temporary passwords with weak randomness | `crypto` randomness, rank check. *(The one-time password is still returned in the response because the console shows it – see residual risks.)* |

### Low

| ID | Issue | Fix / status |
|---|---|---|
| F-42 | Shift booking ignored zone/status; capacity race | zone + ACTIVE + advisory lock – Fixed |
| F-43 | `deleteCategory?moveItemsTo=` accepted another merchant's category id | ownership check – Fixed |
| F-44 | `npm audit`: js-yaml (via `@nestjs/swagger`), uuid | override + `uuid@11` → **0 vulnerabilities** |
| F-45 | Google API key literal in `admin/src/components/NotificationLayer.jsx` (template placeholder) | outside this scope (frontend) – **report to the frontend owner**; restrict/rotate the key |
| F-46 | KITCHEN role may reject orders / remove items (portal role granularity) | Not changed – business decision |
| F-47 | Guest checkout pre-hijack (guest session for someone else's email) | **Open (Low)** – needs email verification of guests |

Checked and found clean: all 651 operations (`routes_before/after.txt`): every non-public route returns 401 unauthenticated and 403 for the wrong account type; no `child_process`/`eval`; no server-side fetch of user-supplied URLs (SSRF) – all outbound calls go to fixed hosts; no `new RegExp(userInput)`; all raw SQL is parameterised or built from constants/whitelists (`fuzz_sqli`: 2 520 requests × 10 payloads on every GET route, **0 time-based hits**, no SQL error leakage); committed secrets: none (git history contains only `.env.example` placeholders; `.gitignore` covers `.env*`, `uploads/`, logs).

---

## 3. Security controls now in place

| Area | Control | Where |
|---|---|---|
| AuthN | bcrypt cost 12, policy + block-list, progressive lockout (account + IP), generic errors, constant-time-ish login, TOTP with replay/attempt protection, sealed seeds, refresh rotation + reuse detection, exact access-token revocation, pending-2FA token confined, social audience check | `auth/*` |
| JWT | HS256 pinned, `iss`/`aud`, 15 min access TTL, `tv` revocation counter | `auth.module.ts`, `jwt.strategy.ts` |
| AuthZ | global JWT → account type → permission → restaurant-role guards; privilege ceiling for staff; owner-only finance; tenant checks on every id; admin IP allow-list | `common/guards.ts`, services |
| Input | whitelist + forbid unknown, strict strings, structural limits, sanitiser, URL rules, UUID pipes, paging caps | `main.ts`, `common/*` |
| Output | JSON only; HTML escaped in server-built HTML (invoices); text/plain emails; CSV neutralised; CMS rich text allow-listed; `nosniff` everywhere | |
| Transport/headers | helmet (strict API CSP, HSTS in prod, no-referrer, frame deny, CORP cross-origin for images), `Cache-Control: no-store` for authenticated API responses, `Permissions-Policy`, explicit CORS allow-list | `main.ts` |
| Abuse | 4-tier throttling keyed by verified user id else IP (default/write/global/ip) + strict per-route limits (login 10, forgot/OTP 5, gift card 5, promo 15, uploads 30, exports 10 per minute), body 100 kb, socket limits, DB statement timeout, micro-cache | `common/throttle.ts` |
| Money | atomic state claims, row locks, strict numbers, dual control, adjustment caps, fail-closed payments | `orders/*`, `finance/*` |
| Uploads | magic bytes, random names, caps, safe serving | `uploads.module.ts` |
| Audit | `auth.login`, `auth.login_failed`, `auth.lockout_*`, `auth.password_*`, `security.rate_limited`, `security.access_denied`, `security.settings_denied`, `security.staff_role_change`, `security.role_permissions_changed`, `security.super_admin_created`, `security.staff_password_reset`, `security.staff_2fa_reset`, `restaurant.impersonate`; append-only table | `AuditService`, `filters.ts` |
| Supply chain | `npm audit` = 0, overrides documented, lockfile committed | `package.json` |
| Push notifications | browser subscription endpoints are validated against SSRF (production: https + known push-service hosts only, no IPs / credentials / private hosts, no redirects followed); VAPID key pair generated once and stored encrypted (secretbox); pushes carry only registry copy rendered with allow-listed variables + allow-listed ids (never PIN, access / pickup code, phone, address, card or proof data; `scrubPush` as a second line; one-time codes are never pushed); subscriptions bound to the logged-in user, moved on re-subscribe, removed on logout (clients unsubscribe first), on 404 / 410 and after 20 consecutive failures; every notification route is scoped to the caller (foreign ids -> 404); service worker only opens same-origin relative URLs; admin kill switches and test sends audited and permission-gated (`notifications` module); FCM service-account JSON is a masked secret; legacy FCM server-key path removed | `notifications/*`, `admin/public/sw.js`, `docs/notifications.md` |

### Public (unauthenticated) routes and why they exist

`/auth/login, /auth/2fa/verify, /auth/refresh, /auth/logout, /auth/forgot-password, /auth/reset-password, /auth/otp/request, /auth/otp/verify, /auth/customer/register, /auth/social, /auth/driver/otp, /auth/driver/register, /auth/restaurant/apply` – credential and sign-up flows (all throttled; generic errors).
`GET /health` – liveness for the load balancer (db up/down, uptime only).
`GET /public/config, /public/status` – app bootstrap/maintenance banner (only settings flagged `isPublic` and **never** `isSecret`).
`GET /public/cities, /cuisines, /zones/resolve, /home, /search, /restaurants/:slug(+/reviews,/slots), /deals, /banners, /cms, /faqs` – storefront.
`POST /public/guest/session` – guest checkout (10/min/IP). `GET /public/unsubscribe` – CASL one-click link (HMAC token).
`POST /public/webhooks/certn` – authenticated by `CERTN_WEBHOOK_SECRET`.
Everything else needs a JWT; every `/admin/*` handler (362) has an explicit `@Permission`.

### Behaviour changes other clients must know about

1. Unknown JSON fields are rejected with 400 (`VALIDATION_FORBID_UNKNOWN=false` returns to silently stripping).
2. `POST /driver/trip/:id/delivered` takes `pin` (not `code`) and requires "arrived at customer" first; `PUT /driver/bank` requires `currentPassword`.
3. `POST /auth/change-password` returns new tokens; the old access/refresh tokens stop working; same for logout-all, reset, block.
4. Login/OTP/reset failures use generic text and HTTP 429 when throttled/locked.
5. Plain-text fields no longer accept HTML tags (they are stripped); CMS/FAQ keep a safe subset. SVG uploads are refused.
6. Restaurant finance is owner-only; sales/promotion reports managers+.
7. Settings under `security.*`, `payments.*`, approval thresholds are Super-Admin-only.

---

## 4. Production safety gate

`NODE_ENV=production` **refuses to boot** (clear message, exit 1, no override flag) unless:

* `JWT_SECRET` ≥ 32 random chars (not a known default), `DATA_ENCRYPTION_KEY` ≥ 32 chars
* `DB_SYNC` is not `true`, `EXPOSE_OTP` is not `true`
* `CORS_ORIGINS` are explicit `https://` origins (no localhost, no `*`), `PUBLIC_URL` is https
* `STRIPE_SECRET_KEY` is a live key and `STRIPE_WEBHOOK_SECRET` is set
* `ENFORCE_2FA=true`, `SEED_SUPERADMIN_PASSWORD` is not a known default, `DB_PASSWORD` is not a default
* and, after connecting to the database: **no demo accounts** (`@demo.forksy.ca`, `@demo-restaurant.ca`) exist and **no super admin still has a known default password**.

Verified: `security-evidence/gate_*.txt`. Development mock behaviours (mock payments, mock Certn, OTP in responses, SMS/email
console adapters) log a warning at boot and are impossible when `NODE_ENV=production`.

---

## 5. Production deployment checklist

**Environment** – copy `backend/.env.example`; set at least: `NODE_ENV=production`, `PUBLIC_URL`, `CORS_ORIGINS`, `TRUST_PROXY` (=1 behind one proxy/LB, =2 behind Cloudflare + LB), `DB_*` (dedicated user, TLS: `DB_SSL=true`), `JWT_SECRET`, `DATA_ENCRYPTION_KEY` (both `openssl rand -base64 48`, stored in a secrets manager, never in git), `ENFORCE_2FA=true`, `STRIPE_*`, `CERTN_*`, `GOOGLE_CLIENT_IDS`/`APPLE_CLIENT_IDS`, Twilio/SendGrid/FCM keys. Do **not** run `npm run seed` with demo data; create the first super admin with a unique strong password, enrol 2FA, remove demo rows.

**TLS and edge** – terminate TLS 1.2+/1.3 at the edge (HSTS is sent by the app in production); redirect HTTP→HTTPS; run the app on a private network only reachable from the proxy/LB; block direct access to port 4000 (origin lock: allow only Cloudflare IP ranges or use Authenticated Origin Pulls).

**Database** – migrations instead of `synchronize` (implemented: `node dist/database/migrate`, the API refuses to start while any are pending, see [deployment.md](deployment.md)); a runtime role *without* `SUPERUSER`/`CREATEDB`/`CREATE` (a separate migration role); `statement_timeout` is already set by the app; TLS `verify-full`; PgBouncer; automated encrypted backups with point-in-time recovery and a *tested* restore; private subnet; disk encryption. The audit table is append-only via trigger – keep it that way.

**Secrets** – cloud secrets manager (rotate JWT secret = logs everybody out; rotate `DATA_ENCRYPTION_KEY` needs re-sealing of TOTP seeds); never log them (the app does not).

**Files** – replace local disk with a private bucket (ca-central-1) + short-lived signed URLs, malware scanning (ClamAV / provider), separate domain for user content. Documents such as driver licences are currently reachable by anyone who knows the (random, unguessable) URL.

**Operations** – ship logs to a SIEM; alert on `auth.lockout_*`, `security.rate_limited` spikes, `security.access_denied`, `security.settings_denied`, `security.staff_role_change`, `security.staff_password_reset`, `restaurant.impersonate`, payout approve/release; uptime and 5xx alerts; dependency scanning in CI (`npm audit --audit-level=high`, Dependabot/Renovate), secret scanning (gitleaks), SAST (CodeQL/semgrep), container image scanning (Trivy), non-root read-only containers; run `test/security-smoke.mjs` against staging on every release.

**Scaling** – the throttler and lockout counters are in-memory: with more than one instance use a shared store (`@nest-lab/throttler-storage-redis` for the throttler, Redis for `LoginProtection`) or enforce the same limits at the edge.

---

## 6. Reverse proxy / WAF recommendations

**Cloudflare (or equivalent CDN/WAF)** – proxy (orange cloud) the API hostname; SSL mode *Full (strict)*, min TLS 1.2, *Always Use HTTPS*, HSTS; enable the *Managed* + *OWASP Core* rulesets (paranoia level 2), *Bot Fight Mode*, *Browser Integrity Check*, *Under Attack mode* runbook for incidents; rate-limiting rules (per IP, 1 minute window):
`/api/v1/auth/*` 20 req → block 10 min · `/api/v1/auth/login|otp|forgot-password|reset-password` 10 req → block 30 min · `/api/v1/uploads` 30 req · `/api/v1/*` 600 req → managed challenge · `/socket.io/*` 60 req; geo/ASN rules if the business is Canada-only; cache `GET /api/v1/public/*` for 30–60 s (the app sends no `no-store` on those) and bypass cache for everything else; request size limit 1 MB (12 MB for `/api/v1/uploads`).

**nginx / LB** – `client_max_body_size 1m;` (uploads location: `12m`), `client_header_timeout 15s; client_body_timeout 30s; send_timeout 30s; keepalive_timeout 15s;`, `large_client_header_buffers 4 8k;`, `limit_req_zone $binary_remote_addr zone=api:20m rate=20r/s;` + `limit_conn_zone`, overwrite `X-Forwarded-For` with `$remote_addr` (or the Cloudflare real-IP module) so it cannot be forged, set `TRUST_PROXY` to the number of hops, health check `/api/v1/health`. Also run Node with `NODE_OPTIONS=--max-http-header-size=8192`.

**Autoscaling** – ≥ 2 instances across zones, scale on CPU 60 % / request latency, connection draining, DB connection budget = instances × `DB_POOL_MAX`.

---

## 7. DDoS – what the application can and cannot do

*In the app (verified, `load_after.txt`):* 2 000-request burst from one IP → 120 served, 1 880 × 429 in ~1 s while a second client stayed at 200 (279 ms worst case); same for a single authenticated user while another user was unaffected; brute force locked out in 5 attempts even with rotating `X-Forwarded-For`; 300 KB/6 MB bodies → 413; 5 000-element arrays and 40-level JSON → 400; 70 KB query → 431; slowloris dropped after 20 s; legitimate use (driver GPS + offer poll every 5 s, dashboard polling, 25-call page load) → 0 throttled; full order lifecycle works.
*Not possible in the app:* volumetric L3/L4 floods and large L7 floods saturate the network before Node sees them. They need infrastructure protection – a CDN/WAF (Cloudflare, AWS Shield/CloudFront, Azure Front Door), a cloud load balancer, autoscaling, and an incident runbook (Under-Attack mode, temporary geo-blocks, scaling up). Treat the in-app limits as the last line, not the first.

---

## 8. Residual risks and deferred work

* In-memory throttling/lockout (single instance) – see scaling note.
* The Stripe on-page payment flow (PaymentIntent + Payment Element, webhooks, Connect payouts) is implemented and proven against a fake Stripe server only; it needs a run with the owner's TEST keys (docs/payments.md). 3-D Secure is handled in the browser by Stripe.js; the server refuses an order whose intent is not `succeeded` (the card has not been charged: 409 `PAYMENT_ACTION_REQUIRED` / 400 `PAYMENT_NOT_CONFIRMED`), and refunds a charge whose order cannot be placed.
* Stripe / Mapbox keys are stored encrypted in the settings table (needs `DATA_ENCRYPTION_KEY`); the production gate refuses `ALLOW_MOCK_PAYMENTS`, `STRIPE_API_BASE` / `MAPBOX_API_BASE`, and missing or non-live Stripe keys.
* Staff city/zone scoping is enforced on analytics, orders and order chat only, not on every module.
* Admin-created staff / restaurant members still receive a one-time temporary password in the API response (the console displays it); an email set-password link with forced change would remove this.
* Uploaded documents are public-by-URL (see Files above).
* Guest-checkout email pre-hijack (F-47). KITCHEN role granularity (F-46).
* `forbidNonWhitelisted` can surface previously-ignored extra fields sent by the console or mobile apps as 400s; run the UI sweep and adjust DTOs (or set `VALIDATION_FORBID_UNKNOWN=false` temporarily).
* Admin console issues (token storage, template Google key) are tracked in `docs/security-frontend.md`.
* No independent penetration test, no DAST/SAST pipeline, no WAF yet.

## 9. Reporting a vulnerability

Email **security@forksy.ca** (owner to confirm/create this mailbox and publish `/.well-known/security.txt`), PGP key on request. Please include steps to reproduce, affected URL/role and impact; do not access other users' data, do not run load tests against production. We acknowledge within 2 business days, triage within 5, and target fixes in 7 days (Critical) / 30 days (High). Good-faith research following these rules will not be pursued.

## 10. Re-running the checks

```bash
cd backend
node test/security-smoke.mjs                       # 57 checks, ~2.5 min (needs the demo seed; login is throttled to 10/min)
node test/security-smoke.mjs https://staging.example/api/v1   # never against production
npx tsc --noEmit -p tsconfig.json
npm audit
```
