# Payments (Stripe) and payouts (Stripe Connect)

Every payment on FORKY goes through **Stripe on-page payments**, and drivers and restaurants are paid out through **Stripe Connect**.
Card details are typed into Stripe's own iframes (Payment Element): they never touch the FORKY page code or API (PCI SAQ-A).

> **Status.** The code is complete and was proven end to end against a **fake Stripe server** (`backend/test/fakes/fake-stripe.mjs`) and the
> real Stripe.js in a browser (which rejects the fake publishable key, so the card form itself was not exercised). It has NOT been run against the real Stripe
> API: the first run with the owner's TEST keys will surface small differences. See [Going live](#going-live-checklist).

## Where the money goes

| Money | How it is taken | Notes |
|---|---|---|
| Order (card / Apple Pay / Google Pay) | PaymentIntent, **manual capture**: authorised at checkout, **captured on delivery**, cancelled (hold released) on reject / cancel | The order exists only after the hold succeeded |
| Wallet or gift-card balance spent on an order | Store credit, not a gateway payment | An order fully covered by wallet needs no card and no intent |
| Wallet top-up | PaymentIntent (automatic capture), credited **exactly once** | `POST /customer/wallet/top-up-intent`, `/top-up/confirm`, webhook |
| Gift-card purchase | PaymentIntent (automatic capture), card issued exactly once | `POST /customer/gift-cards/purchase-intent`, `/purchase/confirm`, webhook |
| Tip added / changed later | Raised on the hold (incremental authorisation) or charged as its own off-session payment on a saved card; lowered = smaller capture or a refund | Clear 409 `TIP_CARD_NOT_SAVED` when the card cannot be charged again |
| Late-cancellation fee | A **partial capture** of the hold (Stripe releases the rest) | |
| Refunds | `refunds.create` against the PaymentIntent, idempotency key `refund-<refund id>` | What the card cannot take (paid with wallet credit, not yet captured) goes to the wallet |
| Cash | **Removed** (the enum value stays for old rows) | |

Platform charges, then transfers ("separate charges and transfers"): the customer's money lands on the FORKY Stripe balance, payouts are Stripe **transfers**
to the connected accounts (`transfer_group` = `batch_<id>` / `payout_<id>`, idempotency key `payout_<payout id>`).

## Checkout flow

1. `POST /customer/payments/intent` (customer login). Body = the checkout quote fields (`type`, `addressId`, `tip`, `useWallet`, ...) plus optional
   `saveCard`, `paymentMethodId` (a saved card), `intentId` (update the still-unconfirmed intent when the cart / tip changes so the card form stays mounted).
   The server prices the cart again, creates the PaymentIntent (`capture_method=manual`, `currency=cad`, `automatic_payment_methods` without redirects,
   `customer`, `metadata {customerId, quoteHash}`, `setup_future_usage` when the customer ticked "save this card") and returns
   `{ clientSecret, intentId, amount, publishableKey }`. **The amount is never taken from the client** (an `amount` field is rejected with 400).
   `{ required:false }` is returned when wallet credit covers everything.
2. The page confirms the intent with the Payment Element (`redirect: 'if_required'`; 3-D Secure and wallets are handled by Stripe.js).
3. `POST /customer/orders` with `paymentIntentId`. The server **retrieves the intent from Stripe** and checks: it belongs to this customer, status is
   `requires_capture`, amount and currency equal the freshly recomputed card amount, the quote fingerprint is unchanged, and no other order uses it
   (unique index on `orders.paymentIntentId`). Errors (all with a machine `code`): 400 `PAYMENT_INTENT_REQUIRED`, `PAYMENT_INTENT_INVALID`, `PAYMENT_NOT_CONFIRMED`;
   409 `PAYMENT_QUOTE_CHANGED` (the stale hold is released at once; the page creates a new intent), `PAYMENT_ACTION_REQUIRED`, `PAYMENT_PROCESSING`,
   `PAYMENT_INTENT_USED`, `PAYMENT_INTENT_CANCELED`.
4. The cancellation window (`orders.customerCancelGraceSeconds`) is unchanged: cancelling inside it, or any reject / cancel, cancels the PaymentIntent.
5. A cron (every 10 min) cancels intents older than `payments.abandonedIntentMinutes` (60) that never became an order and fulfils paid top-ups the
   browser never confirmed. Admins can run it now: `POST /admin/integrations/stripe/sweep-intents`.

Saved cards: `POST /customer/cards/setup-intent` (SetupIntent + Payment Element), `GET /customer/cards`, `POST /customer/cards/:id/default`, `DELETE /customer/cards/:id`.
A saved card may only be used by the customer it belongs to (checked against the Stripe customer). Paying with a saved card creates the intent with the card attached;
the browser only handles the 3-D Secure step.

Provider ids are stored: `orders.paymentIntentId`, `payments.externalId` (intent / charge / refund ids), `stripe_intents`. The admin order page (Payments tab)
shows them, a link to the Stripe dashboard and any dispute (`GET /admin/orders/:id/payments`).

## Webhooks

`POST /api/v1/webhooks/stripe` (public, **raw body**, signature checked with `stripe.webhooks.constructEvent`, tolerance 5 minutes, not throttled).
Bad / missing / stale signature = **400**. Each event id is stored once in `stripe_events` (idempotent: a repeated event answers `duplicate:true`); an unknown event type is
stored as IGNORED and answered **200**. A known event whose processing fails is answered 500 so Stripe retries (after 6 attempts it is answered 200 and stays FAILED for a manual replay).

| Event | What FORKY does |
|---|---|
| `payment_intent.succeeded` | credits a wallet top-up / issues a gift card (exactly once); heals an order whose capture record was lost |
| `payment_intent.amount_capturable_updated` | stores the status |
| `payment_intent.payment_failed` | stores the failure on the intent |
| `payment_intent.canceled` | stores it; alerts ops when the hold of a LIVE order disappears (expiry / dashboard) |
| `charge.refunded` | records refunds made directly in the Stripe dashboard (payment row + ledger + order status) |
| `charge.dispute.created / updated / closed` | order flagged, platform ledger adjustment, URGENT PAYMENT support ticket, ops notification; a won dispute reverses the adjustment |
| `setup_intent.succeeded` | makes the saved card the default when there is none |
| `transfer.created / updated / reversed` | a reversal marks the payout FAILED, returns the amount to the party's ledger and notifies finance |
| `payout.paid / payout.failed` (connected account) | stored on the party; a failure notifies finance and the party |
| `account.updated` | stores status, capabilities and requirements; becoming ENABLED sends the payouts that were waiting |

Register the endpoint in the Stripe dashboard with **"Listen to events on Connected accounts"** also ticked (for `account.updated` and `payout.*`).
Admin: System > Integrations lists recent events with status and has a **Replay** button (`POST /admin/integrations/stripe/events/:id/replay`, Super Admin).

## Stripe Connect payouts (drivers and restaurants)

* `POST /driver/payouts/onboarding` and `POST /restaurant/payouts/onboarding` (owner role) create an **Express** account if missing (country `CA`,
  capability `transfers`, `individual` for drivers / `company` for restaurants, metadata `partyId`) and return a **Stripe-hosted Account Link**
  (`{url, kind:'onboarding'}`; once the account is ENABLED the same call returns the Express dashboard link).
  Return / refresh URLs: drivers `WEB_URL/order/payouts/return?status=complete|refresh&for=driver` (a simple public page; the driver app will deep-link later),
  restaurants `WEB_URL/portal/finance?stripe=return|refresh` (opens the "Payout account" tab).
* `GET /driver/payouts/account`, `GET /restaurant/payouts/account` (`?refresh=true` syncs live from Stripe) return
  `{ status: NOT_STARTED | PENDING | RESTRICTED | ENABLED, payoutsEnabled, detailsSubmitted, requirementsDue[], bankLast4, message }`.
* `POST .../dashboard-link` gives the Stripe Express dashboard login link.
* **Payout engine:** only parties whose account is ENABLED are paid. Otherwise the payout stays **PENDING** with the reason "Payout account not ready", the party is
  notified **once**, and the payout is sent automatically when `account.updated` says ENABLED (an hourly sweep covers a missed webhook). Instant cash-out
  and direct payouts are refused with a clear message until the account is ready.
* **Instant cash-out:** transfer to the connected account, then a Stripe **instant payout** to the driver's eligible debit card. Fee = `payments.instantPayoutFeePct` /
  `payments.instantPayoutFeeMin`. No eligible card (or the instant payout is refused): a standard transfer with a clear reason and **no fee** (the fee stays in the driver's balance).
* Ledger rows of every type (including `WAIT_FEE`, tips, adjustments) are summed into the party balance like any other row.
* Admin: Finance > Payout accounts (status filter, "Sync from Stripe"), the badge on driver / restaurant detail and in Bank and holds.
  `GET /admin/finance/payout-accounts`, `POST /admin/finance/payout-accounts/:type/:id/sync`, `POST /admin/finance/payout-accounts/sync`.
* Reconciliation (`finance/payouts.service.ts`) compares captures, refunds, post-delivery tips, disputes, wallet top-ups and gift-card purchases with Stripe's balance transactions.

## Configuration

Keys are normally pasted by a **Super Admin** under **System > Integrations** (see [integrations.md](integrations.md)): stored encrypted, never shown again, audit-logged without values.
Environment variables are the fallback (the saved setting wins): `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`, `DATA_ENCRYPTION_KEY` (encrypts the settings).

Settings: `integrations.stripe.connectEnabled`, `integrations.stripe.currency` (cad), `integrations.stripe.platformCountry` (CA), `payments.topUpMin` / `topUpMax`,
`payments.abandonedIntentMinutes`, `payments.instantPayoutFeePct`, `payments.instantPayoutFeeMin`, `payments.reconciliationToleranceCad`.

### The development mock (tests and a developer machine only)

The mock provider runs only when **`NODE_ENV != production` AND no Stripe secret key is configured AND `ALLOW_MOCK_PAYMENTS=true`**. It logs a warning at boot,
the storefront shows an amber **"TEST payment (no Stripe keys configured)"** notice, and **with a Stripe key present the mock is never used**. `backend/.env.example`
and the developer's `backend/.env` contain `ALLOW_MOCK_PAYMENTS=true` so the existing flows and tests keep working until the keys are added. With neither a key nor the flag,
payments answer 503 and the checkout says card payments are unavailable. Order rows from the old mock (`pi_mock_...`) are still settled without calling Stripe (never in production).

### Production safety gate

With `NODE_ENV=production` the API **refuses to start** when `ALLOW_MOCK_PAYMENTS` is set, when `STRIPE_API_BASE` / `MAPBOX_API_BASE` (fake servers) are set, or when (settings or env)
the Stripe secret key, publishable key or webhook secret is missing or is not a **live** key.

## Going live checklist

1. Stripe dashboard (test mode first): copy the secret key (`sk_test_...`), the publishable key (`pk_test_...`); enable **Connect** (Express accounts, Canada).
2. System > Integrations: paste both keys, press **Test connection** (it reports mode, charges / payouts enabled, Connect, webhook status).
3. Add the webhook endpoint shown on the page (`PUBLIC_URL/api/v1/webhooks/stripe`, all 15 events, "Listen to events on Connected accounts"); paste its `whsec_...`; **Test connection** again.
   Local machine: `stripe listen --forward-to localhost:4000/api/v1/webhooks/stripe` prints a `whsec_...` to use.
4. Place a test order at `/order` with `4242 4242 4242 4242`, deliver it, refund part of it; onboard a test driver and restaurant (Stripe's test data for Connect) and run a payout.
5. For production: switch to the live keys (red LIVE banner), set `DATA_ENCRYPTION_KEY`, remove `ALLOW_MOCK_PAYMENTS`, register the webhook with the live secret, add the Stripe origins to the website CSP
   (see [security-frontend.md](security-frontend.md)), check Finance > Payout accounts.
   Stripe notes: the Canadian platform needs the Stripe Connect settings completed (branding, terms); transfers draw on the *available* platform balance (new Canadian balances are available after the
   usual rolling days), so a very new account can see `balance_insufficient` on the first payouts (the payout is marked FAILED and retried from Finance).

### Stripe test cards

| Card | Result |
|---|---|
| `4242 4242 4242 4242` | succeeds |
| `4000 0025 0000 3155` | 3-D Secure challenge |
| `4000 0000 0000 9995` | declined: insufficient funds |
| `4000 0000 0000 0002` | declined (generic) |
| `4000 0566 5566 5556` | Visa debit (eligible for instant payouts) |

Any future expiry and any CVC. Connect test data: use Stripe's test "skip this form" / test bank `000123456789` in the hosted onboarding.

## Tests

* `node backend/test/fakes/fake-stripe.mjs` (port 4242) and `fake-mapbox.mjs` (4243): the fake servers (state, idempotency keys, signed webhook delivery, control routes `/_fake/*`).
* `node backend/test/payments-e2e.mjs` runs real HTTP against an API wired to the fakes (`STRIPE_API_BASE`, `MAPBOX_API_BASE`): see the header of the file for the exact setup. 225 checks.
* What the fakes cannot prove: acceptance of our parameters by the real API, real 3-D Secure, real balances / availability, Express onboarding rules, Apple / Google Pay, dashboard-created events.
