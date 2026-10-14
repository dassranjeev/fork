# Integrations page and Mapbox address search

## Admin > System > Integrations

One page, one card per integration. Everything is also available from the API (`/admin/integrations`).

| | |
|---|---|
| **Stripe** | secret key, publishable key, webhook signing secret, Stripe Connect on/off, currency (CAD), platform country (CA) |
| **Mapbox** | server access token, optional public token, search country (`ca`), bounding box (Greater Toronto Area), default proximity (Mississauga) |
| **Read-only status cards** | Google Maps, Twilio, SendGrid, Firebase Cloud Messaging, Certn: configured / incomplete / not configured (from the existing settings or environment). Certn runs the background checks behind automatic verification: variables and webhook in [verification.md](verification.md#certn-setup) |

* A banner shows the mode: **red "LIVE keys"**, **amber "TEST mode"**, amber "TEST payment (no Stripe keys configured)" when the development mock is on, grey "not configured".
  Mixing a test secret key with a live publishable key (or the reverse) raises a warning.
* **Test connection** (per card) gives a readable pass / fail with the reason and never the key. Stripe: retrieves the balance and the platform account (mode test / live,
  charges and payouts enabled, Connect enabled, whether our webhook endpoint is registered, enabled and subscribed to every event). Mapbox: one address search.
* The **exact webhook URL** (`PUBLIC_URL + /api/v1/webhooks/stripe`) with a copy button, the list of 15 events to subscribe to (copy button) and the recent webhook events with status and a Replay button.

### Rules for the keys

* Stored **encrypted at rest** (AES-256-GCM, `common/secretbox.ts`, key from `DATA_ENCRYPTION_KEY`; JWT secret in development). Every secret setting (Twilio, SendGrid, FCM, Google, Stripe, Mapbox)
  is sealed; secrets that were stored in clear text by older versions are sealed on the first boot.
* **Never returned by any API**: status shows `set / source (settings or env) / ********last4`. The publishable key is public by design and is shown.
* Changing a key needs `settings:edit` **and** a Super Admin (staff get 403). Formats are checked before anything is stored: `sk_test_` / `sk_live_` / `rk_...`, `pk_test_` / `pk_live_`, `whsec_`,
  Mapbox `sk.` / `pk.` tokens, bounding box, proximity.
* Every change is written to the audit log with the field names only, never a value (`integrations.stripe.update`, `integrations.mapbox.update`, `.test`).
* Keys can also come from the environment (`STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`, `MAPBOX_ACCESS_TOKEN`, `MAPBOX_PUBLIC_TOKEN`); a **saved value wins** over the environment.
  Sending an empty string removes the saved value (the environment applies again).
* The generic Settings page no longer lists or edits the `integrations` group (the old `payments.stripe.*` and `maps.mapboxToken` rows were moved here on first boot).

API: `GET /admin/integrations`, `PUT /admin/integrations/stripe`, `PUT /admin/integrations/mapbox`, `POST /admin/integrations/:name/test` (`stripe` | `mapbox`),
`GET /admin/integrations/stripe/events`, `POST /admin/integrations/stripe/events/:id/replay`, `POST /admin/integrations/stripe/sweep-intents`,
public `GET /public/payments/config` (`{provider: stripe|mock|none, publishableKey, mode, addressSearch, ...}`; no secrets).

## Mapbox address search

Geocoding only (Mapbox **Search Box API**: suggest, retrieve, reverse). Routing and ETA are **not** done with Mapbox (they stay as they were). The Mapbox token never reaches a browser:
the website and the admin call FORKY, FORKY calls Mapbox, so **no CSP change is needed for Mapbox**.

| Route | |
|---|---|
| `GET /public/geocode/autocomplete?q=&proximity=lng,lat&sessionToken=` | up to 6 address suggestions in Canada (country, bounding box and proximity from the settings) |
| `GET /public/geocode/retrieve?id=&sessionToken=` | `{ address: { line1, city, province, postalCode, lat, lng, label } }` |
| `GET /public/geocode/reverse?lat=&lng=` | the nearest address (or `null`) |
| `GET /admin/geocode/autocomplete | retrieve | reverse` | the same for the Admin Console (login required) |

Throttle 30 requests / minute / IP (public), strict input validation (3-100 characters, `lng,lat` ranges, session token 8-64 `[A-Za-z0-9-]`, id charset), 1-hour in-memory cache (identical searches hit Mapbox once).
Without a token (or with a rejected one) every route answers `{ "enabled": false }` and the clients fall back: the storefront keeps its demo areas (with the "approximate area" note), the admin shows
"Address search is not configured".

* Storefront: the "Add a delivery address" dialog and the "Deliver to" dialog get a debounced, keyboard-accessible search (arrow keys, Enter, Escape) that fills street, city, postal code and the map position.
* Admin: **Find address** in Restaurants > Add, Restaurants > Location (fills address, city, postal code and moves the pin) and the Zones editor (centres the map). Drivers have no address field.
* `MAPBOX_API_BASE` points the API at a fake server (tests only, ignored in production).
