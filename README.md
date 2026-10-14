# FORKY

A three-sided food delivery marketplace for Ontario, Canada (customers, restaurants and convenience stores, delivery drivers), in the style of SkipTheDishes, Uber Eats and DoorDash. This repository contains the **platform API**, the **Admin Console**, and the **Restaurant Portal**. The customer and driver mobile apps are not built yet; the API is ready for them.

> Status: working end to end on a local machine with seeded demo data (Mississauga and Brampton). Payments, SMS, email and push use built-in mock adapters until you add provider keys. See [Known limitations](#known-limitations).

## What is in the box

| Area | What it does |
|---|---|
| **Customers (API)** | Discovery and search, restaurant pages, cart, checkout quote, order placement, tracking, tips, reviews, wallet, gift cards, referrals, privacy requests, live chat support |
| **Restaurants and stores (Restaurant Portal)** | Live order board, kitchen display (KDS), menu and modifiers, 86 / restock, hours and closures, **service mode switch**, staff, reviews, finance, reports, promotions |
| **Drivers (API)** | Application and onboarding, documents, go online/offline, GPS, **offers with accept/decline**, trip steps, earnings, instant cash-out, SOS, shifts, live chat support |
| **Admin Console** | Dashboard, live map, orders, restaurants, drivers, customers, cities and zones, pricing and commission, finance and payouts, support tickets and **live chat console**, marketing, system (staff, roles, audit log, settings) |

Cities seeded: Mississauga and Brampton (active). Toronto and Vaughan exist but are inactive.

## Tech stack

- **Backend:** NestJS 11, TypeORM, PostgreSQL, Socket.IO (real-time), JWT auth with refresh tokens and optional 2FA, Swagger/OpenAPI
- **Admin Console and Restaurant Portal:** React (Create React App), React Router 6, Bootstrap 5 with the WowDash template, ApexCharts, Leaflet
- **Dev database:** embedded PostgreSQL launcher (no Docker needed), or any PostgreSQL you already have

## Repository layout

```
backend/     NestJS API (src/<module>/ per domain: orders, dispatch, restaurants, drivers,
             customers, finance, support, marketing, platform, analytics, ...)
admin/       Admin Console (/) and Restaurant Portal (/portal); screens live in src/features/*
docs/        ARCHITECTURE.md (build contract) and api/*.md (route references per module)
tools/pg/    Embedded Postgres launcher for local development
```

## Quick start

Requirements: Node.js 20 or newer (developed on Node 24), npm.

```bash
# 1. Database (port 5432, user/password postgres/postgres, database "forky")
cd tools/pg && npm install && node start.mjs        # leave running

# 2. Backend API
cd backend
cp .env.example .env                                  # then edit JWT_SECRET etc. if needed
npm install
npm run seed                                          # demo data, safe to re-run
npm run start:dev                                     # http://localhost:4000/api/v1

# 3. Admin Console + Restaurant Portal
cd admin
cp .env.example .env
npm install
npm start                                             # http://localhost:3000
```

Using your own PostgreSQL instead: skip step 1, create a database, and set `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` in `backend/.env`.

Useful URLs once running:

| URL | What |
|---|---|
| http://localhost:3000 | Admin Console (sign in as admin) |
| http://localhost:3000/portal | Restaurant Portal (sign in as a restaurant user, or open it from the admin) |
| http://localhost:3000/chat-demo.html | Test page for the customer/driver side of live chat |
| http://localhost:3000/driver-demo.html | Test page for the driver delivery confirmation (PIN boxes, hand-over / photo) |
| http://localhost:4000/docs | Swagger API docs (also linked in the admin sidebar under SYSTEM) |

## Configuration

`backend/.env` (see `backend/.env.example`):

- `PORT`, `PUBLIC_URL`, `CORS_ORIGINS`
- `DB_*` connection settings; `DB_SYNC=true` creates tables from entities automatically (development only). Production uses migrations (`node dist/database/migrate`, `DB_SYNC` is refused): see `docs/deployment.md`
- `JWT_SECRET` (**change it**), `JWT_ACCESS_TTL`, `JWT_REFRESH_TTL_DAYS`, `ENFORCE_2FA`
- `EXPOSE_OTP=true` returns one-time codes in API responses for development; **turn off in production**
- `SEED_SUPERADMIN_EMAIL` / `SEED_SUPERADMIN_PASSWORD`, `SEED_DEMO`
- Stripe and Mapbox keys are pasted by a Super Admin under **System > Integrations** (encrypted, never shown again; env `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`, `MAPBOX_ACCESS_TOKEN` are the fallback). Every payment goes through Stripe on-page payments and payouts through Stripe Connect: see `docs/payments.md` and `docs/integrations.md`. `ALLOW_MOCK_PAYMENTS=true` (dev only, no Stripe key) keeps the development mock payments working until the keys are added.
- Other provider keys (optional, mock adapters are used when blank): `GOOGLE_MAPS_API_KEY`, `TWILIO_*`, `SENDGRID_API_KEY`, `FCM_SERVER_KEY`, `CERTN_API_KEY`

`admin/.env`: `REACT_APP_API_URL`, `REACT_APP_WS_URL`, and `DISABLE_ESLINT_PLUGIN=true` (avoids a false error overlay when the project path casing differs).

**Security:** see `docs/SECURITY.md` (findings, controls, production checklist). With `NODE_ENV=production` the API refuses to start on insecure configuration (default/short `JWT_SECRET`, `DB_SYNC`, `EXPOSE_OTP`, localhost CORS, missing Stripe/2FA/`DATA_ENCRYPTION_KEY`, demo accounts, default admin password). Re-run the attack checks any time with `node backend/test/security-smoke.mjs`. New env vars: `TRUST_PROXY`, `DATA_ENCRYPTION_KEY`, `CERTN_WEBHOOK_SECRET`, `GOOGLE_CLIENT_IDS`, `APPLE_CLIENT_IDS`, `SWAGGER_ENABLED`, `DB_STATEMENT_TIMEOUT_MS`.

Most business rules (fees, dispatch timers and weights, chat hours, acceptance window, etc.) are editable at runtime in the Admin Console under **System > Platform Settings**.

## Demo accounts (after `npm run seed`)

| Role | Login | Password |
|---|---|---|
| Super admin | `admin@forky.ca` | `Admin@12345` (from `SEED_SUPERADMIN_PASSWORD`) |
| Customers | `customer1@demo.forky.ca` ... `customer50@demo.forky.ca` | `Demo@12345` |
| Drivers | `driver1@demo.forky.ca` ... `driver28@demo.forky.ca` | `Demo@12345` |
| Restaurant owners | `owner1@demo-restaurant.ca` ... `owner26@demo-restaurant.ca` | `Demo@12345` |
| Other store roles | `manager1@...`, `cashier1@...`, `kitchen1@...` (same domain and numbering) | `Demo@12345` |

Customers 31 to 50 and restaurants 13 to 26 include Brampton data. These are development defaults; never use them in production.

## How the key flows work

**Automation (minimal manual work).** After an order is placed nobody has to touch it: it is accepted automatically (the prep time includes the kitchen load), preparation starts automatically, it is marked ready when the prep time has elapsed, and the automatic driver search starts 5 minutes before the food is due (ready at 3:20 pm means the search starts at 3:15 pm; setting `dispatch.preReadyMinutes`, 0 = only when the kitchen marks it ready), so the driver arrives as the food is finished. Driver arrival at the restaurant and at the customer is detected from GPS (within 80 m). People step in only for physical actions (the driver's accept, pickup code and delivery proof) and for exceptions. Each restaurant can follow the platform default or force accept / start prep / ready on or off (portal Store Settings, or the admin restaurant page); platform defaults are under System, Platform Settings, group "automation". Every automatic step appears on the order timeline as "Auto: ...".

**Cancellation window.** For 120 seconds after payment (setting `orders.customerCancelGraceSeconds`) the customer can cancel for free. During that time the order is held by FORKY and is not given to the restaurant (no alert, not visible in the portal or kitchen display, no automation). When the window closes the order is sent to the restaurant and automatically accepted. After that customers cannot cancel; FORKY staff can only cancel with the restaurant's approval: they send a cancellation request that the restaurant approves or declines in its portal, or they record who at the restaurant approved it by phone or chat. Orders already past pickup keep the existing support-approval rule.

**Order lifecycle.** `PLACED` (instant) > `ACCEPTED` > `PREPARING` > `READY` > `PICKED_UP` > `ON_THE_WAY` > `DELIVERED` (pickup orders end in `COLLECTED`). Cancelled and rejected orders release or refund the payment. Payment is authorised at placement and captured on delivery; the ledger settles restaurant, driver and platform shares at that point.

**Store service mode.** Every restaurant or convenience store can switch between `CLOSED`, `PICKUP_ONLY` and `PICKUP_AND_DELIVERY` from the portal dashboard or Store Settings. Closed stores refuse all orders; pickup-only stores refuse delivery orders and never create driver offers; orders already placed carry on unchanged. Customer discovery returns the mode and which options are available, and search supports a pickup/delivery filter.

**Automatic driver dispatch.** Five minutes before the food is due (the order's estimated ready time, setting `dispatch.preReadyMinutes`), the system automatically offers the order to the best nearby eligible driver, one at a time (30 second window). The driver can accept or decline. Accepting assigns the order to that driver; declining or letting the offer expire moves to the next nearby driver, widening the search radius and boost, and alerting ops if nobody takes it. Offline, busy, out-of-zone, stale-GPS and unsuitable-vehicle drivers are skipped automatically. Set `dispatch.preReadyMinutes` to 0 to search only once the kitchen marks the order ready. If the kitchen extends the prep time, the search start moves later with it, and a driver found while the food is still cooking waits for it (pickup works once the order is ready).

**En-route stacking (two orders per driver).** When free drivers are busy or scarce, a driver who already has the first order in the car and is heading to its drop-off B can be offered a second order whose restaurant is close to B (default within 3 km) and that they can reach no more than 10 minutes after the food is ready. They collect it right after the first delivery, so the first customer is never delayed. A driver never carries more than **2 orders at a time**, whether the second order comes from an automatic offer or a manual assignment, and the offer shows "pick this up after you finish your current delivery". The driver's active trip returns the current order plus a queue, the second customer's ETA includes the first delivery, and the driver stays "on trip" until the last order ends. Settings `dispatch.stacking.*`. Free drivers are always preferred; stacking only gets offers when they are unavailable or decline.

**Driver wait-time pay.** If a driver has to wait at the restaurant for more than 5 minutes after the promised ready time (the prep time when the order was accepted; if the driver arrives later, from the arrival), every further started minute is paid to the driver and deducted from the restaurant's payout (settings `orders.waitFee.*`: grace 5 min, $0.50 per minute, max $10 per order). The restaurant gets a warning while the driver waits, the charge shows on the order, the order timeline and the restaurant and driver statements, and staff can waive it (FORKY then absorbs it and the driver keeps the pay).

**Driver acceptance score.** Each driver has an acceptance rate over a rolling 14 days: accepted offers divided by accepted plus declined plus expired, lightly smoothed for drivers with fewer than 5 offers. It updates on every response and hourly, is shown on the driver profile and in the admin (with offer history), and is a 20 percent weight in the ranking, so higher acceptance means earlier offers.

**Live chat support.** Customers and drivers can chat with support agents in real time (queue, auto-assign, typing and read receipts, images, transfer, rating). If no agent is online, outside support hours, or the queue times out, the same message automatically becomes a ticket in the Support queue so nothing is lost. Agents work from **Support > Live chat** in the Admin Console. Protocol reference: `docs/api/live-chat.md`.

**Proof of delivery.** Every delivery leaves an evidence record that settles "the driver never delivered" claims. Hand-to-me and meet-outside orders need the customer's PIN; leave-at-door orders need a fresh photo taken at the address (about 150 m geofence, GPS cross-checked, metadata stripped, reuse of a photo is rejected). Photos are private and visible only to the order's parties and staff. Weak or exception proof is flagged for review, and disputes use the evidence automatically. Details: `docs/proof-of-delivery.md`.

**Delivery instructions.** Customers choose hand to me, leave at door (contactless) or meet outside, and whether to use a private delivery PIN (if they turn it off, the driver chooses "handed to the customer" or "delivered / left", and leaving the order requires a photo uploaded in the app; the driver must always be within 100 m of the delivery location), add notes and an optional access code (stored encrypted, shown to the driver only after pickup). Defaults can be saved per address, and instructions can be changed until pickup.

**Ratings.** Customers rate the restaurant and the driver after delivery (tags, one edit, review-bomb and duplicate detection, staff moderation). Drivers and restaurants privately rate customers (staff-only visibility). Scores are smoothed so one bad review does not swing a new profile, and low scores raise alerts and feed the driver review process. Details: `docs/ratings.md`.

**System Health (Super Admin only).** **System > System Health** shows, live (every 2 s over a websocket): server CPU, RAM, swap, disk and load, request rate, response time and errors, database health, dependency checks (Stripe, TLS certificate, migrations, proxy headers) and a load-balancing review across every API instance: traffic share per instance with a verdict, a live balance test, and Drain / Resume for an instance. Staff cannot see it, even with every permission. Instances report through one small shared table, so it keeps working behind a load balancer. The app is supported as one API instance today; the page lists what must be solved before a second one (see `docs/system-health.md`).

**Menu editing is admin-controlled.** A restaurant can add, update and remove its own menu items only while an administrator has allowed it (per restaurant, switchable at any time on the restaurant's Menu tab). Without permission the menu is read-only, but the restaurant can still mark items out of stock (86), and can request access from the portal; staff see the waiting requests on the Restaurants list. New restaurants start locked.

**Admin walkthrough of restaurant panels.** From **Restaurants > Open a restaurant panel** (or the restaurant list and detail pages), an admin with edit permission can open any restaurant's portal as its owner for up to 2 hours without a password. A banner shows while viewing, every start is audit-logged, and the session cannot change the owner's password or 2FA.

## API documentation

- Interactive: http://localhost:4000/docs (Swagger UI)
- **OpenAPI file for frontend developers** (every route, request fields, error format, observed response shapes; generated from the code): [`docs/openapi/`](docs/openapi) - [`openapi.json`](docs/openapi/openapi.json), [`openapi.yaml`](docs/openapi/openapi.yaml)
- Written references per module in [`docs/api/`](docs/api): analytics, customers, dispatch, drivers, finance, live-chat, marketing, platform, restaurants, support
- Complete workflow (diagrams, who does what, what is automatic): [`docs/workflow.html`](docs/workflow.html) (open in a browser)
- Branding (logo, icons, colour, wordmark font, app-store icon sets): [`docs/branding.md`](docs/branding.md)
- Feature guides: [`docs/proof-of-delivery.md`](docs/proof-of-delivery.md), [`docs/ratings.md`](docs/ratings.md), [`docs/system-health.md`](docs/system-health.md)
- Deployment guide (Docker, migrations, first Super Admin, backups, updates): [`docs/deployment.md`](docs/deployment.md)
- Design contract and module ownership: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)

Route prefixes: `/auth` (all apps), `/admin`, `/restaurant`, `/driver`, `/customer`, `/public`, plus `/orders/:id/tracking` and `/orders/:id/messages` shared by all parties. Real-time events use Socket.IO on the same port as the API.

## Development notes

- Type-check the backend: `cd backend && npm run typecheck`
- Production builds: `npm run build` in `backend/` and `admin/`. Deploying (Docker stack, migrations, first admin, backups, updates): [`docs/deployment.md`](docs/deployment.md)
- Changed an entity? Add a migration: `npm run migration:generate -- src/database/migrations/<Name>` (CI fails when entities and migrations disagree; see the deployment guide)
- The seed is idempotent: re-running adds only what is missing. Demo data (people, restaurants, orders) is created only when `SEED_DEMO=true`.
- The login endpoint is rate limited to 10 requests per minute per IP; scripted tests should log in once and reuse the token.
- Dispatch needs a recent driver location (default within 120 seconds). Seeded drivers have no live GPS, so send `POST /driver/location` as a driver (the driver app will do this every few seconds) to receive offers.
- Trips longer than about 3 km are not offered to bike drivers.
- If sidebar styling looks stale after an update, hard refresh the browser (Ctrl+F5).

## Known limitations

- **No native customer or driver mobile apps yet.** The API, real-time events, the customer website (`/order`) and the `chat-demo.html` / `driver-demo.html` test pages are ready for them.
- **The Docker deployment has not been run end to end** (no Docker where it was prepared). The migrate, seed and production-boot procedure was run against a clean PostgreSQL with plain Node; the Dockerfiles, `docker-compose.yml` and the CI migration check were syntax-checked only. See `docs/deployment.md`.
- **Payments are mocked in development until the Stripe TEST keys are added** (the full Stripe flow - on-page payments, webhooks, Connect payouts - is implemented and tested against a fake Stripe server, not yet against the real Stripe API; see `docs/payments.md`; in production the API refuses to start without live keys). SMS, email and push use mock or log-only adapters until provider keys are added; real delivery has not been verified.
- Not yet built in the portal and admin: menu CSV import, document upload screens, tablet activation, editing a promotion after creation.
- Several admin actions were exercised by hand only on the main paths (for example refund approvals, bank verification and payout release were rendered but not run end to end).
- Proof-photo and access-code purge jobs, rating prompts over real push, and mobile clients are untested. Scheduled-order handling and automatic switch-back timers for service mode exist but were not exercised.

