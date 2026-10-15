# Payments (Stripe) and payouts (Stripe Connect)

Every payment on FORKY goes through **Stripe on-page payments**, and drivers and restaurants are paid out through **Stripe Connect**.
Card details are typed into Stripe's own iframes (Payment Element): they never touch the FORKY page code or API (PCI SAQ-A).

> **Status.** The code is complete and was proven end to end against a **fake Stripe server** (`backend/test/fakes/fake-stripe.mjs`) and the
> real Stripe.js in a browser (which rejects the fake publishable key, so the card form itself was not exercised). It has NOT been run against the real Stripe
> API: the first run with the owner's TEST keys will surface small differences. See [Going live](#going-live-checklist).

## Where the money goes

| Money | How it is taken | Notes |
|---|---|---|
| Order (card / Apple Pay / Google Pay) | PaymentIntent, **automatic capture**: the card is **charged at checkout**, the moment the customer pays. Nothing is captured later. **Refunded in full** on reject / cancel, and automatically when the order cannot be placed | The order exists only after the payment succeeded. Paying is mandatory |
| Wallet or gift-card balance spent on an order | Store credit, not a gateway payment | An order fully covered by wallet needs no card and no intent |
| Wallet top-up | PaymentIntent (automatic capture), credited **exactly once** | `POST /customer/wallet/top-up-intent`, `/top-up/confirm`, webhook |
| Gift-card purchase | PaymentIntent (automatic capture), card issued exactly once | `POST /customer/gift-cards/purchase-intent`, `/purchase/confirm`, webhook |
| Tip added / changed later | Raised: charged as its own off-session payment on a saved card; lowered: a partial refund to the card | Clear 409 `TIP_CARD_NOT_SAVED` when the card cannot be charged again (a card that was not saved) |
| Late-cancellation fee | The fee is **kept** and the rest of the charge is **refunded** (an order placed as an old hold: a partial capture, Stripe releases the rest) | |
| Refunds | `refunds.create` against the PaymentIntent, idempotency key `refund-<refund id>` (a cancel / reject uses `refund-cancel-<order id>`) | What the card cannot take (paid with wallet credit, more than was charged) goes to the wallet. Stripe does **not** give back its own processing fee on a refund |
| Payment that never became an order | Refunded in full, automatically, at once when the order is refused, or by the clean-up cron once the payment is `payments.paidWithoutOrderMinutes` (10) old | Stored on `stripe_intents` (`canceledAt` + `meta.returned`) |
| Cash | **Removed** (the enum value stays for old rows) | |

**Charged at checkout, not held (changed 2026-10-14).** Before, the card was only *authorised* at checkout (a hold) and *captured* when the order was delivered. Now the card is charged when the
customer pays, and the money is refunded if the order is rejected, cancelled or cannot be placed. What this means in practice: the customer sees a completed charge (not a pending hold) at once, a refund
takes the bank about 5-10 business days to show, and every refunded order costs FORKY Stripe's processing fee (Stripe keeps it on a refund). Orders placed **before** the change are still manual-capture
holds: they are captured at delivery and released on cancel exactly as before (`PaymentsService.capture / release`), so nothing in flight breaks.

Platform charges, then transfers ("separate charges and transfers"): the customer's money lands on the FORKY Stripe balance, payouts are Stripe **transfers**
to the connected accounts (`transfer_group` = `batch_<id>` / `payout_<id>`, idempotency key `payout_<payout id>`).

## Checkout flow

1. `POST /customer/payments/intent` (customer login). Body = the checkout quote fields (`type`, `addressId`, `tip`, `useWallet`, ...) plus optional
   `saveCard`, `paymentMethodId` (a saved card), `intentId` (update the still-unconfirmed intent when the cart / tip changes so the card form stays mounted).
   The server prices the cart again, creates the PaymentIntent (`capture_method=automatic`, `currency=cad`, `automatic_payment_methods` without redirects,
   `customer`, `metadata {customerId, quoteHash}`, `setup_future_usage` when the customer ticked "save this card") and returns
   `{ clientSecret, intentId, amount, publishableKey }`. **The amount is never taken from the client** (an `amount` field is rejected with 400).
   `{ required:false }` is returned when wallet credit covers everything.
2. The page confirms the intent with the Payment Element (`redirect: 'if_required'`; 3-D Secure and wallets are handled by Stripe.js). **This is the moment the card is
   charged**: the intent goes straight to `succeeded` (no hold, nothing to capture later).
3. `POST /customer/orders` with `paymentIntentId`. The server **retrieves the intent from Stripe** and checks: it belongs to this customer, status is
   `succeeded` (the money was received in full and has not been refunded), amount and currency equal the freshly recomputed card amount, the quote fingerprint is unchanged,
   and no other order uses it (unique index on `orders.paymentIntentId`). The order is created with `paymentStatus=CAPTURED` and a `CAPTURE` payment row (Stripe charge id).
   Errors (all with a machine `code`): 400 `PAYMENT_INTENT_REQUIRED`, `PAYMENT_INTENT_INVALID`, `PAYMENT_NOT_CONFIRMED`;
   409 `PAYMENT_QUOTE_CHANGED` (the price moved after the card was charged: **the charge is refunded at once**, the message says so, the page creates a new intent),
   `PAYMENT_REFUNDED` (this payment was already given back), `PAYMENT_ACTION_REQUIRED`, `PAYMENT_PROCESSING`, `PAYMENT_INTENT_USED`, `PAYMENT_INTENT_CANCELED`.
   An intent from a page that was opened before this rule (manual capture, `requires_capture`) is still accepted and captured when the order is placed.
4. **If the order is refused after the card was charged** (empty cart, restaurant closed, item sold out, address gone, promo used up ...): a clear refusal (4xx) refunds the
   charge at once and the error carries `code: ORDER_NOT_PLACED_REFUNDED` with a message that says the payment is being refunded (it can take 5-10 business days to show on the statement).
   An unexpected server error (5xx) keeps the payment so the customer's retry does not charge twice: `POST /customer/payments/intent` for the same cart returns that payment
   (`alreadyPaid:true`, status `succeeded`) and the page just places the order.
5. The cancellation window (`orders.customerCancelGraceSeconds`) is unchanged: cancelling inside it, or any reject / cancel, **refunds the payment to the card in full** (one Stripe refund,
   idempotency key `refund-cancel-<order id>`; an extra tip that was charged separately is refunded from its own charge). `paymentStatus` becomes `REFUNDED`. No ledger row exists yet for an order that
   was never delivered, so nothing is reversed there. A late-cancellation fee (`orders.cancellationFeeMaxPctOfFood`) is simply not refunded.
6. A cron (every 5 min) cleans up payments that never became an order: a **charged** payment older than `payments.paidWithoutOrderMinutes` (10; Stripe's own charge time is checked too, so a page that
   is still placing the order is never refunded under its feet) is **refunded in full**; an attempt that was never paid is cancelled after `payments.abandonedIntentMinutes` (60);
   paid top-ups the browser never confirmed are fulfilled. The refund claims the payment first (an order can no longer bind it) and is idempotent. Admins can run it now:
   `POST /admin/integrations/stripe/sweep-intents` (`{ olderThanMinutes? }`, answers `{ cancelled, refunded, fulfilled, skipped }`).

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
| `payment_intent.succeeded` | credits a wallet top-up / issues a gift card (exactly once). For an order payment it arrives when the customer pays, before the order exists, so there is normally nothing to do; heals an old manual-capture order whose capture record was lost |
| `payment_intent.amount_capturable_updated` | stores the status (old manual-capture holds only) |
| `payment_intent.payment_failed` | stores the failure on the intent |
| `payment_intent.canceled` | stores it; alerts ops when the hold of a LIVE old manual-capture order disappears (expiry / dashboard) |
| `charge.refunded` | records refunds made directly in the Stripe dashboard (payment row + ledger + order status); refunds FORKY made itself are already recorded and are not booked twice |
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
`payments.abandonedIntentMinutes`, `payments.paidWithoutOrderMinutes`, `payments.instantPayoutFeePct`, `payments.instantPayoutFeeMin`, `payments.reconciliationToleranceCad`.

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
4. Place a test order at `/order` with `4242 4242 4242 4242` (the card is charged right then: check the payment in the Stripe dashboard), cancel one inside the 2-minute window and see the refund, deliver another, refund part of it; onboard a test driver and restaurant (Stripe's test data for Connect) and run a payout.
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
* `node backend/test/payments-e2e.mjs` runs real HTTP against an API wired to the fakes (`STRIPE_API_BASE`, `MAPBOX_API_BASE`): see the header of the file for the exact setup. 255 checks (charged at checkout, refund on cancel / reject / refused order, extra tip charges, unused payments, drift and tampering, wallets, webhooks, Connect payouts, reconciliation).
* `npx ts-node --transpile-only test/payments-refund.test.ts` (31 unit checks, in CI): the money-back logic with fakes, including what the app cannot reach (late-cancellation fee, old manual-capture holds, a separately charged tip, the unused-payment clean-up guards).
* Gotchas when running the end-to-end suite: restart `fake-stripe.mjs` after changing it (the running copy keeps the old routes); the API needs `MAPBOX_ACCESS_TOKEN=pk.fakefakefake1234.fakefakefake5678` for the masked-key check; the API limits `POST /customer/orders` to 20 a minute, so the suite waits and retries on HTTP 429.
* What the fakes cannot prove: acceptance of our parameters by the real API, real 3-D Secure, real balances / availability, Express onboarding rules, Apple / Google Pay, dashboard-created events.
