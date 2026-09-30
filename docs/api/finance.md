# Finance API

Base: `/api/v1`. Lists return `{ data, meta: { page, limit, total, totalPages } }` (`?page&limit&search&sortBy&sortDir`). CSV endpoints return JSON (`{ csv }` or `{ filename, csv }`) for client-side download.

Enums: PartyType `RESTAURANT|DRIVER|PLATFORM|CUSTOMER`; BatchStatus `DRAFT|LOCKED|APPROVED|RELEASED|COMPLETED`; PayoutStatus `PENDING|APPROVED|RELEASED|PAID|FAILED|ON_HOLD`; LedgerType `SALE|COMMISSION|RESTAURANT_PROMO|PLATFORM_PROMO|DELIVERY_PAY|TIP|BOOST|FEE_REVENUE|COMMISSION_REVENUE|REFUND|ADJUSTMENT|PAYOUT|INSTANT_FEE`; RefundStatus `PENDING_APPROVAL|APPROVED|REJECTED|PROCESSED`; Invoice status `DRAFT|ISSUED|PAID|VOID`.

Cycle (SOP-07): generate (LOCKED, reconciliation auto-run) -> adjust payouts -> resolve gap if `reconciliation.resolved=false` -> approve (APPROVED) -> release (RELEASED, payments attempted, then COMPLETED). Release needs a SUPER_ADMIN when `requiresSuperAdmin` (batch total > lowest `City.payoutReleaseThreshold`). Events: `payout.paid` (EventEmitter). Crons: daily 04:00 weekly batch (acts only on `payments.payoutWeekday`), daily 02:00 pays DAILY-schedule restaurants (`payments.dailyPayoutsEnabled`).

## Admin `/admin/finance` (Module.FINANCE)

| Method | Path | Perm | Request | Response |
|---|---|---|---|---|
| GET | /dashboard | view | - | `{draftBatches, awaitingRelease, onHoldPayouts, failedPayouts, pendingRefundApprovals, unresolvedReconciliationGaps, platformBalance, unpaidRestaurantBalance, unpaidDriverBalance, hstCollectedThisMonth}` |
| GET | /ledger | view | `partyType, partyId, type, orderId, restaurantId, payout=paid\|unpaid, from, to, search` | paged LedgerEntry + `partyName` |
| GET | /ledger/export/csv | export | same filters | `{filename, csv}` |
| POST | /adjustments | edit | `{partyType, partyId, amount(+/-), reason, restaurantId?}` | `{balance}` |
| GET | /reports/hst | view | `from, to` | `{customerHstByMonth[{month,tax,subtotal}], customerHstByTaxClass[{taxClass,tax,base}], forksyHstByMonth[{month,hst,base}]}` |
| GET | /parties/:partyType/:partyId | view | - | PartyInfo `{name, bankOk, bankVerified, bankMasked, hold, holdReason, stripeAccountId, schedule}` |
| GET | /parties/:partyType/:partyId/bank | view | - | masked bank + verification |
| POST | /parties/:partyType/:partyId/bank | edit | `{institution?, transit?, accountNumber?, holder?, debitCardLast4?}` | bank view (verification reset) |
| POST | /parties/:partyType/:partyId/bank/verify/initiate | edit | - | bank view (+`mockAmounts` outside prod) |
| POST | /parties/:partyType/:partyId/bank/verify/confirm | edit | `{amounts:[n,n]}` | bank view |
| PATCH | /parties/:partyType/:partyId/hold | edit | `{hold:boolean, reason?}` | PartyInfo (unhold releases held payouts) |
| GET | /batches | view | `status` | paged PayoutBatch |
| GET | /batches/:id | view | - | batch + `payouts[]` |
| POST | /batches/generate | create | `{periodStart?, periodEnd?}` (YYYY-MM-DD; default previous Mon-Sun) | PayoutBatch (idempotent per period) |
| POST | /batches/:id/reconcile | edit | - | batch with `reconciliation{captured,stripeBalance,gap,resolved,source}` |
| POST | /batches/:id/resolve-gap | approve | `{notes}` | batch |
| POST | /batches/:id/approve | approve | - | batch (Finance Manager) |
| POST | /batches/:id/release | approve | - | batch; 403 if `requiresSuperAdmin` and caller not SUPER_ADMIN |
| GET | /payouts | view | `status, partyType, partyId, batchId, instant, from, to, search` | paged Payout |
| GET | /payouts/export/csv | export | same | `{csv}` |
| GET | /payouts/:id | view | - | payout + batch, party, invoice |
| POST | /payouts/:id/adjust | edit | `{amount(+/-), reason}` (batch DRAFT/LOCKED only) | Payout |
| POST | /payouts/:id/hold | edit | `{reason?}` | `{before, payout}` |
| POST | /payouts/:id/release-hold | edit | - | `{before, payout}` |
| POST | /payouts/:id/retry | edit | - | Payout (pay/retry after release or FAILED) |
| GET | /statements/:payoutId | view | - | `{payout, party, period, summary, columns, lines, invoice}` |
| GET | /statements/:payoutId/csv | export | - | `{filename, csv}` |
| GET | /invoices | view | `merchantId, status, from, to, search` | paged Invoice + `merchantName` |
| GET | /invoices/:id | view | - | invoice + merchant, issuer, period, hstRatePct |
| GET | /invoices/:id/download | export | `format=json\|csv\|html` | `{type, filename, body}` |
| POST | /invoices/:id/void | edit | `{reason}` | Invoice |
| GET | /refunds | view | `status` (default PENDING_APPROVAL), `search` | paged Refund + `order.code` |
| POST | /refunds/:id/approve | approve | `{notes?}` | Refund (via RefundsService; approver's refundLimit enforced) |
| POST | /refunds/:id/reject | approve | `{notes?}` | Refund |

## Restaurant `/restaurant/finance` (scoped to `user.merchantId`; bank routes OWNER only)

| Method | Path | Request | Response |
|---|---|---|---|
| GET | /dashboard | - | `{balance: PartyInfo, recentPayouts[]}` |
| GET | /payouts, /payouts/:id | `status, from, to` | paged Payout / payout detail |
| GET | /statements/:payoutId, /statements/:payoutId/csv | - | statement / `{filename, csv}` |
| GET | /ledger | `from, to` (required, YYYY-MM-DD) | `{columns, lines[]}` per-order breakdown with `payoutStatus` |
| GET | /invoices, /invoices/:id | `status, from, to, search` | paged / detail |
| GET | /invoices/:id/download | `format` | `{type, filename, body}` |
| GET / POST | /bank | POST: bank fields as above | bank view |
| POST | /bank/verify/initiate, /bank/verify/confirm | confirm: `{amounts:[n,n]}` | bank view |

## Driver

| Method | Path | Response |
|---|---|---|
| POST | /driver/earnings/instant-cashout | Payout (`instant=true`, `fee`, `net`, status PAID/ON_HOLD). 403 if `instant_payouts` flag off or hold; 400 if no bank/low balance. Fee: `payments.instantPayoutFeePct` (min `payments.instantPayoutFeeMin`). |
