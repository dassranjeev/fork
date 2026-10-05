# Support API (SupportModule)

Base `/api/v1`. Lists return `{ data, meta:{page,limit,total,totalPages} }`. Enums: `TicketStatus` OPEN|PENDING|ESCALATED|RESOLVED|CLOSED; `TicketTier` SELF_SERVE|TIER1|TIER2|FINANCE; priority LOW|NORMAL|HIGH|URGENT; `TicketCategory` MISSING_ITEM|WRONG_ITEM|NEVER_ARRIVED|VERY_LATE|FOOD_QUALITY|RESTAURANT_CANCELLED|PAYMENT|PAYOUT|ACCOUNT|SAFETY|OTHER; chargedTo RESTAURANT|PLATFORM|DRIVER; case trigger LOW_RATING|FRAUD_FLAG|SAFETY_COMPLAINT|EXPIRED_DOCUMENTS|REPEATED_CANCELLATIONS|OTHER; decision REINSTATED|WARNED|SUSPENDED|DEACTIVATED; case status PROPOSED|OPEN|AWAITING_RESPONSE|DECIDED|CLOSED|DISMISSED; appealStatus NONE|REQUESTED|UPHELD|OVERTURNED.

Realtime: `ticket.updated` `{ticketId, number, status, tier, priority, assignedToId, slaBreached, event, at, message?}` to the requester's user room, restaurant room, and `admin:ops`. Event values: created, message, note, assigned, escalated, resolved, closed, reopened, status, updated, csat, sla_breach. Domain event `ticket.created` is emitted on every new ticket.

Photos: upload via `POST /uploads`, pass URLs in `attachments`.

## Admin `/admin/support/*`  (staff, `@Permission(support, X)`)

| Method | Path | Perm | Request | Response |
|---|---|---|---|---|
| GET | /tickets | view | page,limit,search,sortBy,sortDir, status,tier,priority,category (comma lists), assignee (uuid/me/unassigned), slaBreached, requesterType, requesterId, orderId, orderCode, restaurantId, tag, source, from, to, open=true | paged tickets + requesterName/Email, assigneeName, orderCode/Status |
| GET | /tickets/counts | view | - | `{byStatus, openByTier, unassigned, slaBreached, mine}` |
| GET | /tickets/agents | view | - | `[{id,name,email,role,canHandleTier2,canHandleFinance,refundLimit,openTickets,slaBreached}]` |
| GET | /reason-codes | view | - | `[{code,label,category?}]` for resolve dialog |
| GET | /tickets/:id | view | - | `{ticket, messages (incl. internal), orderContext, suggestion}` |
| POST | /tickets | create | subject, body?, category?, orderId?, restaurantId?, attachments?, tags? | ticket |
| GET / POST | /tickets/:id/messages | view / edit | POST: body, internal? (internal note), attachments? | messages / message |
| POST | /tickets/:id/assign | edit | assigneeId (null = unassign) | ticket (403/400 if assignee cannot handle tier) |
| POST | /tickets/:id/escalate | edit | reason, tier? | ticket |
| PATCH | /tickets/:id | edit | subject?, category?, tags?, priority?, addAttachments? | ticket (retag may auto-escalate) |
| POST | /tickets/:id/resolve | edit | reasonCode, chargedTo (both mandatory), resolution?, message? | ticket |
| POST | /tickets/:id/close | edit | note? | ticket (must be RESOLVED) |
| POST | /tickets/:id/reopen | edit | reason? | ticket |
| POST | /tickets/:id/status | edit | status OPEN\|PENDING | ticket |
| POST | /tickets/:id/refund | approve | amount, chargedTo, reasonCode, type? REFUND\|CREDIT, notes? | Refund; status PENDING_APPROVAL when amount > caller's refundLimit |
| GET | /refunds/pending | approve | page,limit | paged ticket-linked refunds awaiting approval |
| POST | /refunds/:id/approve | approve | notes? | Refund (approver's own limit enforced) |
| POST | /refunds/:id/reject | approve | reason? | Refund |
| GET | /order-context/:orderId | view | - | order summary, items, timeline, GPS evidence, customer history, refunds |
| GET | /order-context/:orderId/suggest | view | category, itemIds (csv) | rule-engine suggestion `{rule,action,lines[],totalAmount,warnings,autoEligible,summary}` |
| GET | /canned-replies | view | search,category,audience | paged replies |
| POST / PATCH / DELETE | /canned-replies[/:id] | create/edit/delete | title, body, category?, audience ANY\|CUSTOMER\|RESTAURANT\|DRIVER, shortcut?, active? | reply |
| POST | /canned-replies/:id/render | view | vars {customerName,orderCode,agentName,ticketNumber} | `{body}` |
| GET | /review-cases | view | page,search,subjectType,status,decision | paged cases |
| GET | /review-cases/candidates | view | - | detector candidates (low rating / cancellations) |
| POST | /review-cases | create | subjectType, subjectId, trigger, details | case |
| GET | /review-cases/:id | view | - | case (evidence, notice, response, decision, appeal, payout) |
| POST | /review-cases/:id/notice | edit | noticeBody, responseDays? (default setting `driver.deactivationResponseDays`=7) | case, status AWAITING_RESPONSE, `respondBy` set, subject notified |
| POST | /review-cases/:id/evidence | edit | type, ref?, url?, note | case |
| POST | /review-cases/:id/dismiss | edit | notes? | case |
| POST | /review-cases/:id/decide | approve | decision, notes? | case; applies driver/restaurant status (SUSPENDED/DEACTIVATED; restaurant DEACTIVATED -> SUSPENDED; REINSTATED -> ACTIVE/LIVE) |
| POST | /review-cases/:id/appeal-decision | approve | result UPHELD\|OVERTURNED, notes? | case (overturn reinstates) |
| POST | /review-cases/:id/final-payout | approve | amount | case; posts ADJUSTMENT ledger entry |
| GET | /kpis | view | from?, to? (default 30d) | `{tickets:{total,byStatus,byTier,byCategory,bySource,slaBreached,slaBreachRate}, csat, avgFirstResponseMinutes, avgResolutionMinutes, refunds[], reviewCases}` |

## Customer `/customer/support/*`

| Method | Path | Request | Response |
|---|---|---|---|
| GET | /issue-types | - | `[{category,label,labelFr,needsItems,needsPhoto,when}]` |
| POST | /issues | orderId, category, description?, itemIds?, attachments?, deviceFingerprint? | `{ticket, auto, suggestion}`. Auto rules: good history + under ceiling (missing/wrong item <= $15, food quality <= $8) -> instant credit/refund and auto-resolved; very late > 30 min -> delivery-fee refund + credit; flagged account / refund frequency / suspicious device -> Tier 2; otherwise Tier 1 agent |
| GET | /tickets | page,status,open,search | requester-safe tickets |
| POST | /tickets | subject, body?, category?, orderId?, attachments? | ticket detail |
| GET | /tickets/:id | - | ticket + public messages |
| GET / POST | /tickets/:id/messages | POST: body, attachments? | messages |
| POST | /tickets/:id/confirm | csat?, comment? | closes resolved ticket |
| POST | /tickets/:id/reopen | reason? | ticket (auto-decisions go to a person) |
| POST | /tickets/:id/rate | csat 1-5, comment? | ticket |

Order-level chat with restaurant/driver stays on the existing `/orders/:id/messages` (OrderChatService).

## Restaurant `/restaurant/support/*` and Driver `/driver/support/*`

| Method | Path | Request | Response |
|---|---|---|---|
| GET | /tickets | page,status,open,search | tickets (restaurant: own or location tickets; driver: own or driver-linked) |
| POST | /tickets | subject, body?, category?, orderId?, attachments?, restaurantId? (restaurant only, must be own location) | ticket detail |
| GET | /tickets/:id | - | ticket + public messages |
| GET / POST | /tickets/:id/messages | POST: body, attachments? | messages |
| GET | /review-cases | page | own SOP-08 cases (proposed ones hidden) |
| GET | /review-cases/:id | - | case |
| POST | /review-cases/:id/respond | response | case (only while AWAITING_RESPONSE) |
| POST | /review-cases/:id/appeal | notes? | case (only after decision) |

### "Order never arrived" and delivery proof
`OrderContextService.suggest()` / `SelfServeService.reportIssue()` check the delivery evidence record (docs/proof-of-delivery.md):
- **Valid proof** (customer PIN verified, or a clean photo inside the geofence with no integrity flag): no auto-refund. The ticket is escalated to Tier 2 with "Proof on file - review required", suggestion action `PROOF_ON_FILE`, evidence in the ticket detail (`orderContext.deliveryProof`).
- **Missing / weak / flagged proof** (including old orders and a legacy photo URL with no evidence record): the existing refund path applies (charged to platform, or to the driver on repeat claims) and the driver gets a **delivery-dispute strike** (`DriverProfile.deliveryDisputes30d` / `deliveryDisputesTotal`). The SOP-08 detector proposes a DELIVERY_DISPUTES review case at `support.deliveryDisputeStrikeThreshold` strikes in 30 days.
- Staff record the verdict: `POST /admin/support/tickets/:id/delivery-outcome` `{outcome: UPHELD_DELIVERED|NOT_DELIVERED|INCONCLUSIVE, note?}` (support:edit). UPHELD_DELIVERED reverses the driver strike and adds to the customer's `falseDeliveryClaims`; at `support.falseClaimFlagThreshold` (2) the customer is flagged for review (fraud flag + `FALSE_DELIVERY_CLAIMS`), never auto-banned. NOT_DELIVERED keeps/creates the strike. Changing a verdict undoes the previous side effects.

Background jobs: every minute flags SLA breaches (`slaBreached`, `slaBreachType` FIRST_RESPONSE|RESOLUTION); hourly SOP-08 detector proposes cases (status PROPOSED).

## Live chat

Real-time customer / driver chat with support agents (a chat is a ticket with `source = "CHAT"` plus a `ChatSession`; offline or unanswered chats automatically stay as normal tickets). REST routes `/customer|driver/support/chat/*`, agent console API `/admin/support/chat/*`, Socket.IO events `chat.*` and the `support:agents` room, state machine, settings (`support.chat.*`) and demo client (`/chat-demo.html`) are documented in [live-chat.md](./live-chat.md).
