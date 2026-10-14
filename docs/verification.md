# Registration and verification of drivers and businesses

A Super Admin decides how new drivers and new businesses (restaurants and stores) are admitted, separately for each:

| Mode | What happens to a new sign-up |
|---|---|
| **Instant registration** | Active (driver) or live (business) the moment they sign up. No verification step. They are recorded as *Unverified*. |
| **Manual verification** | They wait for staff: documents, background check, approval (SOP-02 for drivers, SOP-01 for businesses). |
| **Automatic verification** | They go through a **Certn** identity and criminal-record check and are activated automatically when it comes back clear. |

**Force verification** is the Super Admin's way to bring accounts that were admitted without verification (instant registration) through the
verification method that is enabled, with a deadline.

Everything that changes the policy is **Super Admin only**: not even a staff role that has every permission can call it. Out of the box nothing
changes: instant registration is off and the method is manual, which is exactly how FORKSY worked before this feature.

Screen: **System > Verification** (Super Admin only). Code: `backend/src/verification/`. Tests: `backend/test/verification.test.ts` (unit) and
`backend/test/verification-e2e.mjs` (end to end against a real API and database).

## The two settings per audience

| Setting | Values | Meaning |
|---|---|---|
| Instant registration | on / off | On: new accounts work at once and are *Unverified*. Off: new accounts must be verified before they work. |
| Verification method | Manual review / Automatic (Certn) | What a new sign-up goes through when instant registration is off, and what **Force verification** uses. |

The method is kept while instant registration is on: that is how "Force verification" knows which method to use. Choosing Automatic is only
possible when Certn is ready (see [Certn setup](#certn-setup)).

Changing the policy only affects **new** sign-ups. Accounts that are already verified, pending or rejected are never rewritten.

## Drivers

**Instant.** The driver is `ACTIVE` right after sign-up with every active zone of the chosen city, the welcome message and the first-week boost.
No documents, background check, training or insulated-bag step is needed to go online. The one thing that is still asked is the Ontario
platform worker notice (a legal notice the driver acknowledges once in the app): it is not a verification step and is never ticked for them.
Payout details (bank, tax) are only needed to be paid, not to work. Stored: `verificationStatus = UNVERIFIED`, `verificationMethod = INSTANT`.

**Manual.** Unchanged SOP-02: `APPLIED`, documents review, background check, training, approval, activation. Approving a driver *is* the manual
verification, so it is recorded as `VERIFIED` / `MANUAL` (and the driver then needs approved documents to go online, as before).
Staff can also use the one-click **Verify** on the Verification card (see [Staff actions](#staff-actions)).

**Automatic.** The Certn check starts at sign-up and the driver waits in `BACKGROUND_CHECK`. When Certn answers:

| Certn result | What happens |
|---|---|
| clear | Verified (`VERIFIED` / `AUTOMATIC`) and activated at once: zones of the city, welcome message. No staff step, no documents needed. |
| flagged (`consider`) or failed | `NEEDS_REVIEW`. The driver stays where they are, staff are told, and a person decides (verify anyway as Super Admin, start the check again, or reject). **Nobody is rejected automatically.** |

Staff are told about flagged and failed results only: a clear result activates the driver by itself and does not bother anyone.

If Certn cannot be reached at sign-up the sign-up still succeeds. The check is retried every minute (5 attempts); after that the driver goes to
`NEEDS_REVIEW` and staff are told. If Certn is not usable at all at that moment (the key was removed after Automatic was chosen) the sign-up goes to the manual queue
and the Verification card says why.

## Businesses

A business is a *merchant* (the legal business and its owner) with one or more restaurants. The verification state lives on the merchant; each
restaurant keeps its own lifecycle status (`APPLIED`, `DOCS_REVIEW`, `MENU_SETUP`, `TEST_ORDER`, `LIVE`, ...). The Certn check is run on the **owner**.

**Instant.** The restaurant is `LIVE` and accepting orders right after the application, with the default commission tier, and its owner may
edit the menu straight away (menu editing is granted). The application form does not send map coordinates, so FORKSY tries to place a pin from
the street address (Mapbox, when configured) and finds the delivery zone from it. **Without a pin a live restaurant cannot be found by customers**
until a staff member sets its location on the restaurant page. Stored: merchant `UNVERIFIED` / `INSTANT`.

**Manual.** Unchanged SOP-01 (documents, commission tier, menu review, test order, go-live). A staff go-live is the manual verification and is
recorded as `VERIFIED` / `MANUAL`.

**Automatic.** The Certn check of the owner starts at the application; the restaurant waits in `APPLIED`. A clear result verifies the business
and takes its waiting restaurants live. A flagged or failed result puts the business in `NEEDS_REVIEW` for a person to decide.

## Force verification

`POST /admin/verification/force` (Super Admin). It targets accounts whose `verificationStatus` is `UNVERIFIED`: either a list of ids or `all: true`.
Verified, pending and rejected accounts are never touched.

| Option | Meaning |
|---|---|
| `graceDays` | Days the account keeps working while it verifies (0 to 90). `0` (default) means: taken off at once. |
| `method` | Manual or Automatic. Default: the method of the policy. Automatic needs Certn to be ready. |
| `reason` | Free text kept in the audit log. |

What it does to each account:

1. Marks it `PENDING` with the method, the time and the **deadline**.
2. Tells it what to do (push, in-app, e-mail): "Verification required" with the deadline and the steps for the method. A reminder follows when the deadline is a day away.
3. Automatic only: starts the Certn check (the first 20 of a batch inside the request, the rest 40 a minute by the sweeper).
4. **At the deadline**, an account that is still not verified is taken off the road until it is:
   - a driver goes to `DOCS_REVIEW` (manual) or `BACKGROUND_CHECK` (automatic) and is sent offline;
   - a business's live restaurants go to `DOCS_REVIEW` (manual) or `APPLIED` (automatic) and stop taking orders.
   The status they had is remembered. **When the account is verified it comes back by itself** (driver `ACTIVE`; restaurants `LIVE` / `PAUSED` as they were).
5. A driver on a trip, or a business with orders in progress, is **never cut off mid-work**: it is taken off when that work ends (the next sweep).

The answer lists, per account, the outcome: `GRACE` (keeps working until the deadline), `BLOCKED`, `DEFERRED` (trip / orders in progress), `VERIFIED`
(a clear Certn result was already on file), `SKIPPED` (not unverified / not found), `FAILED`. Batches of up to 50 accounts are taken off inside
the request; bigger ones are finished by the sweeper within a minute.

The **sweeper** is a job inside the API that runs every minute (and on demand: `POST /admin/verification/sweep`, "Run checks now" on the page).
It enforces deadlines, starts Certn checks that could not be started, and sends the one-day reminders. Like every other job it assumes **one
API instance** (see [system-health.md](system-health.md)).

## Verification states

| `verificationStatus` | Meaning |
|---|---|
| `UNVERIFIED` | Admitted without verification (instant registration). May work. |
| `PENDING` | Verification required and in progress: waiting for staff, for the Certn check, or running toward a force deadline. |
| `NEEDS_REVIEW` | The Certn result was flagged or failed, or the check could not be started: a person decides. |
| `VERIFIED` | Verified, by `MANUAL` staff action or the `AUTOMATIC` Certn check (`verificationMethod`; instant accounts show `INSTANT` while unverified). |
| `REJECTED` | Rejected during verification. |

Fields on drivers (`driver_profiles`) and businesses (`merchants`): `verificationStatus`, `verificationMethod`, `verifiedAt`, `verifiedBy` (the staff
member; empty for Certn), `verificationForcedAt`, `verificationDueAt`; merchants also hold the Certn check of the owner (`backgroundCheckProvider`,
`backgroundCheckStatus`, `backgroundCheckRef`). The state is shown in the driver and restaurant lists (filter `?verification=`), on the driver and
restaurant pages, in the driver app profile (`GET /driver/profile`, `verification.nextStep`), in the restaurant portal and in the answers of
`POST /auth/driver/register` and `POST /auth/restaurant/apply`.

## Staff actions

On the **Verification card** (driver page, restaurant page, or the table on System > Verification). Permissions: drivers / restaurants *approve*
(viewing the card needs *view*).

| Action | Rules |
|---|---|
| **Verify** | Checks the checklist of the account's method. Manual driver: required documents approved, insurance confirmed, background check clear. Manual business: required documents approved for each location. Automatic: the Certn check is clear. When everything is done the account is verified **and activated** (a driver who was not working yet is activated with the city's zones; a business's waiting restaurants go live; accounts that Force verification took off the road come back). |
| **Verify anyway** | Only a **Super Admin**, with a note, when the checklist is open. Recorded in the audit log with what was missing. For a driver it also waives the documents requirement to go online. |
| **Start Certn check** | Starts (or restarts) a Certn check on one account. On an unverified working account it does not interrupt it: a clear result verifies it in place. |
| **Reject** | A reason is required. Only for accounts that are not working yet; a working account is dealt with by suspend / deactivate (SOP-08). |

The old SOP-02 buttons "start background check" and "override" refuse a driver whose verification is automatic and point to the card.

## Certn setup

Automatic verification needs Certn on the server (`backend/.env.production`; see also [integrations.md](integrations.md)):

| Variable | |
|---|---|
| `CERTN_API_KEY` | Your Certn API key. Without it production refuses to start a check. |
| `CERTN_WEBHOOK_SECRET` | The shared secret Certn sends with every result (`X-Webhook-Secret`, or an HMAC-SHA256 of the body in `X-Certn-Signature`). Without it the webhook refuses everything in production, so a check would never finish. |
| `CERTN_WEBHOOK_URL` | Optional. Where Certn calls back. Default: `PUBLIC_URL` + `/api/v1/public/webhooks/certn`. |

Enter the webhook URL and the same secret in the Certn dashboard. The Verification page shows the state: *Certn connected*, *development mock*
(no key, development only: every check comes back clear after about 4 seconds; an email containing `+consider` comes back flagged and one with `+fail`
failed, for testing) or *not ready* with what is missing. **Automatic cannot be chosen while Certn is not ready.**

What Certn checks is the **person**: identity and criminal record (for a business, its owner). It does not check documents, licences or
insurance: for those use the manual method. Because automatic activation skips staff, drivers verified automatically are not asked for approved
documents to go online.

## API

All under `/api/v1`. Full request and response shapes: [openapi](openapi).

| Method | Path | Who |
|---|---|---|
| GET | `/admin/verification` | **Super Admin.** Certn status, policy and counts per audience |
| PUT | `/admin/verification/policy` | **Super Admin.** `{ drivers?: { instant?, method? }, businesses?: {...} }`; `CERTN_NOT_READY` when choosing Automatic without Certn. `instant` must be a real boolean |
| GET | `/admin/verification/subjects` | **Super Admin.** `?audience=DRIVER\|BUSINESS&status=&search=&page=&limit=` |
| POST | `/admin/verification/force` | **Super Admin.** `{ audience, ids \| all, graceDays?, method?, reason? }` |
| POST | `/admin/verification/sweep` | **Super Admin.** Run the minute-by-minute checks now |
| GET | `/admin/verification/drivers/:id` · `/businesses/:id` | drivers / restaurants *view*. The card: state, Certn check, checklist. `:id` of a business is the **merchant** id |
| POST | `.../verify` `{ note?, override? }` | drivers / restaurants *approve*. Open checklist: 400 `VERIFICATION_REQUIREMENTS_NOT_MET` with one `details` line per open item |
| POST | `.../reject` `{ reason }` | drivers / restaurants *approve* |
| POST | `.../start-check` | drivers / restaurants *approve* |
| POST | `/public/webhooks/certn` | Certn (authenticated by the shared secret) |

Also: `GET /admin/drivers` and `GET /admin/restaurants` (rows carry the state; filter `?verification=`), `GET /admin/restaurants/merchants?verification=`.

## Security and audit

- The policy lives in the settings group `verification`. It is **not** listed on the generic Settings page and the generic Settings endpoint refuses to write it
  (also for a Super Admin): the only way is `PUT /admin/verification/policy`, which validates and audits.
- The verification routes with policy, force and the account table are `@UserTypes(SUPER_ADMIN)` and refuse impersonation tokens.
- The switches (`instant`, `all`, `override`) are strict booleans: the API's general conversion would otherwise turn the text `"false"` into `true`.
- Audit log actions: `verification.policy_update`, `verification.force`, `verification.sweep`, `verification.verify`, `verification.reject`,
  `verification.check_start`, `verification.check_result`, `verification.needs_review`, `verification.verified`, `verification.block`,
  `verification.instant_activate`.
- Notification events (see [notifications.md](notifications.md)): `verification.required`, `verification.verified`, and for staff `driver.instant_activated`,
  `restaurant.instant_activated`, `restaurant.background_check`.

## Data, migration, development databases

Migration `AddVerification` adds the columns and **records every account that already went through the manual process as verified** (drivers
approved or active, merchants with a live restaurant), so Force verification only ever touches accounts admitted later. Databases created by
`DB_SYNC=true` (local development) never run migrations; for them the API does the same once, at its first start (idempotent, only rows that still
have the untouched defaults). Seeded demo accounts are recorded as verified.

## What to know before turning instant registration on

- Nobody has looked at these people. A driver can go online and receive orders with no background check, licence or insurance review. Force verification exists to catch up later.
- Customers' orders can go to a driver or restaurant you have not vetted. Decide this with your insurer and your lawyer before you rely on it.
- An instant restaurant is live with no test order and no document review; it still has to build a menu before anyone can order.
- Automatic verification relies on Certn being right and reachable; flagged results always wait for a person.

## Testing

```bash
cd backend
npx ts-node --transpile-only test/verification.test.ts        # unit: policy, override rule, force and sweeper logic with fakes (55 checks)
# end to end (changes the policy and creates accounts: scratch database only; see the header of the file for the full recipe)
VERIFICATION_E2E_SCRATCH=1 API=http://localhost:4100/api/v1 DB_NAME=forksy_ver ADMIN_PASSWORD=... DEMO_PASSWORD=... CERTN_WEBHOOK_SECRET=... node test/verification-e2e.mjs
```

The end-to-end script drives the real API and the real database: access control, instant / manual / automatic sign-up for drivers and businesses,
Force verification with and without a deadline, the sweeper, trips and orders in progress, override and restore, the Certn webhook, reminders and
retries, the driver app checklist (171 checks). Real Certn has never been called: the adapter talks to the built-in mock until `CERTN_API_KEY` is set, so the first real check
should be made with a test driver (and a Certn sandbox key) before relying on automatic verification.
