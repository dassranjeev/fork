# Notifications (in-app, browser push, native push)

Every person on the platform (customers, restaurants and stores, drivers, FORKSY staff) gets the right alert, live, on every surface, even when the tab is closed:

* **In-app**: every notification is stored (the notification center) and pushed live over Socket.IO (`notification` event) to the user's room.
* **Browser push**: standard W3C Web Push + VAPID. No paid service, no vendor SDK. A service worker (`admin/public/sw.js`) shows the OS notification when no page of the app is in the foreground.
* **Native push (FCM HTTP v1)** for the future mobile apps: device registration and delivery are built; it is dormant until a Firebase service account is configured.
* E-mail and SMS keep their existing adapters (SendGrid / Twilio, mocked in development) and follow the same matrix and preferences.

Code: `backend/src/notifications/*` (API) and `admin/src/lib/notify/*` + `admin/public/sw.js` (clients). Admin page: **System > Notifications**.

## 1. How one notification travels

```
service code ──notify({ userId, audience, event, vars, data })──▶ NotificationsService.dispatch()
                                                                     │
   channels = notifications.matrix[event][audience]   (platform default = event registry, editable in System > Notification Matrix)
   + IN_APP (always kept for orders / delivery / payments / support)
                                                                     │
   user preferences (master push, per-category channel toggles, quiet hours)  +  CASL marketing consent
   + platform kill switches (notifications.push.enabled / .webEnabled / .fcmEnabled)
                                                                     │
   IN_APP  ─▶ row in `notifications` + Socket.IO `notification` event  (+ `notification.read` when read elsewhere)
   PUSH    ─▶ sanitised payload ─▶ web push (every browser of the user) + FCM v1 (every native device) ─▶ one delivery row (SENT / FAILED / SKIPPED + error)
   EMAIL / SMS ─▶ adapters ─▶ delivery row
```

`notify()` never throws and never blocks a business flow (push sends are bounded, retried in the background of the call, and failures only produce a FAILED delivery row).

Domain events that no service notifies itself are turned into notifications by `EventNotifierService` (order placed / released / status changed / late / cancelled / delivered, offer expired, review created, store paused / resumed).

## 2. Event registry and the channel matrix

`backend/src/notifications/events.ts` is the single source of truth: every event, its audiences, default channels, urgency, whether it is **critical** (ignores quiet hours), whether the OS notification is **sticky** (`requireInteraction`), the deep link, the collapse tag, the safe push copy and the allow-lists. On boot the platform default of the `notifications.matrix` setting and the missing rows of `notification_templates` are topped up from it (existing admin edits are never overwritten). The matrix is edited in **System > Notification Matrix**, the copy in **Marketing > Notification Templates**; **System > Notifications** shows the effective coverage read-only.

Channels: in-app / push / e-mail / sms. Urgency: `high` (new orders, offers, arrivals, cancellations, SOS), `normal`, `low`, `very-low` (promotions, rating reminders). Push TTL follows the urgency (1 h / 6 h / 12 h / 24 h) unless the event sets its own (driver offers: the offer window; new orders: 15 min).

### Full matrix (event x audience x channel)

| Event | Category | Audience | In-app | Push | E-mail | SMS | Urgency | Deep link |
|---|---|---|---|---|---|---|---|---|
| `delivery.driver_arrived` | delivery | CUSTOMER | x | x |  |  | high, sticky | `/order/track/{orderId}` |
| `delivery.instructions_changed` | delivery | DRIVER | x | x |  |  | high | `/driver-demo.html` |
| `delivery.left_at_door` | delivery | CUSTOMER | x | x |  |  | high | `/order/track/{orderId}` |
| `driver.arrived_restaurant` | delivery | CUSTOMER | x | x |  |  | low | `/order/track/{orderId}` |
| `driver.arrived_restaurant` | delivery | RESTAURANT | x | x |  |  | high, sticky | `/portal/orders?order={orderId}` |
| `driver.assigned` | delivery | CUSTOMER | x | x |  |  | normal | `/order/track/{orderId}` |
| `driver.assigned` | delivery | RESTAURANT | x | x |  |  | low | `/portal/orders?order={orderId}` |
| `driver.offer` | delivery | DRIVER | x | x |  |  | critical, sticky | `/driver-demo.html?offer={offerId}` |
| `driver.offer_cancelled` | delivery | DRIVER | x | x |  |  | low | `/driver-demo.html` |
| `driver.offer_expired` | delivery | DRIVER | x | x |  |  | low | `/driver-demo.html` |
| `driver.supply_alert` | delivery | DRIVER | x | x |  |  | normal | `/driver-demo.html` |
| `driver.waiting` | delivery | RESTAURANT | x | x |  |  | high, sticky | `/portal/orders?order={orderId}` |
| `offer.accepted` | delivery | DRIVER | x |  |  |  | normal | `/driver-demo.html` |
| `order.no_driver` | delivery | CUSTOMER | x | x |  |  | normal | `/order/track/{orderId}` |
| `order.no_driver` | delivery | RESTAURANT | x |  |  |  | normal | `/portal/orders?order={orderId}` |
| `order.no_driver` | delivery | ADMIN | x | x |  |  | high, sticky | `/orders/{orderId}` |
| `order.reassigned` | delivery | DRIVER | x | x |  |  | high, sticky | `/driver-demo.html` |
| `order.accepted` | orders | CUSTOMER | x | x |  |  | normal | `/order/track/{orderId}` |
| `order.cancel_request_answered` | orders | ADMIN | x | x |  |  | normal | `/orders/{orderId}` |
| `order.cancel_requested` | orders | RESTAURANT | x | x |  |  | critical, sticky | `/portal/orders?order={orderId}` |
| `order.cancelled` | orders | CUSTOMER | x | x |  |  | high | `/order/track/{orderId}` |
| `order.cancelled` | orders | RESTAURANT | x | x |  |  | high, sticky | `/portal/orders?order={orderId}` |
| `order.cancelled` | orders | DRIVER | x | x |  |  | high, sticky | `/driver-demo.html` |
| `order.delivered` | orders | CUSTOMER | x | x | x |  | normal | `/order/track/{orderId}` |
| `order.delivered` | orders | DRIVER | x | x |  |  | low | `/driver-demo.html` |
| `order.delivered` | orders | RESTAURANT | x |  |  |  | normal | `/portal/orders?order={orderId}` |
| `order.item_removed` | orders | CUSTOMER | x | x |  |  | high, sticky | `/order/track/{orderId}` |
| `order.late` | orders | CUSTOMER | x | x |  |  | normal | `/order/track/{orderId}` |
| `order.late` | orders | RESTAURANT | x | x |  |  | high | `/portal/orders?order={orderId}` |
| `order.late` | orders | DRIVER | x | x |  |  | high | `/driver-demo.html` |
| `order.late` | orders | ADMIN | x | x |  |  | normal | `/orders/{orderId}` |
| `order.on_the_way` | orders | CUSTOMER | x | x |  |  | normal | `/order/track/{orderId}` |
| `order.picked_up` | orders | CUSTOMER | x | x |  |  | normal | `/order/track/{orderId}` |
| `order.picked_up` | orders | RESTAURANT | x |  |  |  | low | `/portal/orders?order={orderId}` |
| `order.placed` | orders | CUSTOMER | x | x | x |  | normal | `/order/track/{orderId}` |
| `order.placed` | orders | RESTAURANT | x | x |  |  | critical, sticky | `/portal/orders?order={orderId}` |
| `order.prep_overdue` | orders | RESTAURANT | x | x |  |  | high | `/portal/orders?order={orderId}` |
| `order.preparing` | orders | CUSTOMER | x | x |  |  | low | `/order/track/{orderId}` |
| `order.ready` | orders | CUSTOMER | x | x |  |  | normal | `/order/track/{orderId}` |
| `order.ready` | orders | DRIVER | x | x |  |  | high | `/driver-demo.html` |
| `order.rejected` | orders | CUSTOMER | x | x |  | x | high | `/order/track/{orderId}` |
| `order.sent_to_restaurant` | orders | CUSTOMER | x | x |  |  | low | `/order/track/{orderId}` |
| `order.stuck` | orders | ADMIN | x | x |  |  | high | `/orders/{orderId}` |
| `proof.exception` | orders | ADMIN | x |  |  |  | normal | `/orders` |
| `rating.driver_warn` | orders | DRIVER | x | x |  |  | low | `/driver-demo.html` |
| `rating.driver_warn` | orders | ADMIN | x |  |  |  | normal | `/analytics/ratings` |
| `rating.prompt` | orders | CUSTOMER | x | x |  |  | low | `/order/track/{orderId}` |
| `rating.prompt_partner` | orders | DRIVER | x |  |  |  | normal | `/driver-demo.html` |
| `rating.prompt_partner` | orders | RESTAURANT | x |  |  |  | normal | `/portal/orders?order={orderId}` |
| `rating.reminder` | orders | CUSTOMER | x | x |  |  | very-low | `/order/track/{orderId}` |
| `rating.restaurant_warn` | orders | RESTAURANT | x | x |  |  | normal | `/portal/reviews` |
| `rating.restaurant_warn` | orders | ADMIN | x |  |  |  | normal | `/analytics/ratings` |
| `review.flagged` | orders | ADMIN | x |  |  |  | normal | `/restaurants/reviews` |
| `review.received` | orders | RESTAURANT | x | x |  |  | low | `/portal/reviews` |
| `review.reply` | orders | CUSTOMER | x | x |  |  | low | `/order/track/{orderId}` |
| `review.reported` | orders | ADMIN | x |  |  |  | normal | `/restaurants/reviews` |
| `credit.issued` | payments | CUSTOMER | x | x |  |  | normal | `/order/notifications` |
| `finance.batch_draft` | payments | ADMIN | x |  |  |  | normal | `/finance/batches` |
| `finance.batch_ready` | payments | ADMIN | x |  |  |  | normal | `/finance/batches` |
| `finance.dispute` | payments | ADMIN | x | x |  |  | high, sticky | `/finance/refunds` |
| `finance.payout_failed` | payments | ADMIN | x | x |  |  | high | `/finance/payouts` |
| `finance.payout_waiting_account` | payments | ADMIN | x |  |  |  | normal | `/finance/payouts` |
| `finance.reconciliation_gap` | payments | ADMIN | x | x |  |  | high | `/finance/batches` |
| `finance.refund_pending` | payments | ADMIN | x | x |  |  | normal | `/finance/refunds` |
| `finance.stripe_alert` | payments | ADMIN | x | x |  |  | high | `/finance` |
| `order.partial_refund` | payments | CUSTOMER | x | x |  |  | normal | `/order/track/{orderId}` |
| `order.tip_updated` | payments | DRIVER | x | x |  |  | low | `/driver-demo.html` |
| `order.tip_updated` | payments | CUSTOMER | x |  |  |  | normal | `/order/track/{orderId}` |
| `payment.failed` | payments | ADMIN | x | x |  |  | high | `/orders/{orderId}` |
| `payment.issue` | payments | CUSTOMER | x | x |  |  | high, sticky | `/order/track/{orderId}` |
| `payout.account_not_ready` | payments | RESTAURANT | x | x | x |  | normal | `/portal/finance` |
| `payout.account_not_ready` | payments | DRIVER | x | x | x |  | normal | `/driver-demo.html` |
| `payout.bank_failed` | payments | RESTAURANT | x | x | x |  | high | `/portal/finance` |
| `payout.bank_failed` | payments | DRIVER | x | x | x |  | high | `/driver-demo.html` |
| `payout.sent` | payments | RESTAURANT | x | x | x |  | normal | `/portal/finance` |
| `payout.sent` | payments | DRIVER | x | x | x |  | normal | `/driver-demo.html` |
| `refund.issued` | payments | CUSTOMER | x | x | x |  | normal | `/order/track/{orderId}` |
| `refund.pending_approval` | payments | ADMIN | x | x |  |  | normal | `/finance/refunds` |
| `refund.rejected` | payments | CUSTOMER | x | x |  |  | normal | `/order/track/{orderId}` |
| `wait.fee_charged` | payments | RESTAURANT | x | x |  |  | normal | `/portal/orders?order={orderId}` |
| `wait.fee_charged` | payments | DRIVER | x | x |  |  | normal | `/driver-demo.html` |
| `campaign.message` | promotions | CUSTOMER | x | x |  |  | very-low | `/order` |
| `campaign.message` | promotions | DRIVER | x | x |  |  | very-low | `/driver-demo.html` |
| `campaign.message` | promotions | RESTAURANT | x | x |  |  | very-low | `/portal` |
| `promo.approved` | promotions | RESTAURANT | x | x |  |  | low | `/portal/promotions` |
| `promo.rejected` | promotions | RESTAURANT | x | x |  |  | low | `/portal/promotions` |
| `case.opened` | support | ADMIN | x |  |  |  | normal | `/support/cases` |
| `chat.message` | support | CUSTOMER | x | x |  |  | high | `/order/notifications` |
| `chat.message` | support | RESTAURANT | x | x |  |  | high | `/portal` |
| `chat.message` | support | DRIVER | x | x |  |  | high | `/driver-demo.html` |
| `chat.waiting` | support | ADMIN | x | x |  |  | high, sticky | `/support/chat` |
| `rating.customer_safety` | support | ADMIN | x |  |  |  | normal | `/customers` |
| `sos.acknowledged` | support | DRIVER | x | x |  |  | critical, sticky | `/driver-demo.html` |
| `sos.alert` | support | ADMIN | x | x |  |  | critical, sticky | `/driver-ops/sos` |
| `ticket.update` | support | CUSTOMER | x | x |  |  | normal | `/order/notifications` |
| `ticket.update` | support | RESTAURANT | x | x |  |  | normal | `/portal` |
| `ticket.update` | support | DRIVER | x | x |  |  | normal | `/driver-demo.html` |
| `ticket.update` | support | ADMIN | x | x |  |  | normal | `/support/tickets/{ticketId}` |
| `account.approved` | system | RESTAURANT | x | x | x |  | normal | `/portal` |
| `account.approved` | system | DRIVER | x | x | x |  | normal | `/driver-demo.html` |
| `account.deactivation_notice` | system | RESTAURANT | x | x | x |  | high, sticky | `/portal` |
| `account.deactivation_notice` | system | DRIVER | x | x | x |  | high, sticky | `/driver-demo.html` |
| `account.rejected` | system | RESTAURANT | x | x | x |  | normal | `/portal` |
| `account.rejected` | system | DRIVER | x | x | x |  | normal | `/driver-demo.html` |
| `assistant.training.decided` | system | RESTAURANT | x | x |  |  | normal | `/portal/assistant` |
| `assistant.training.requested` | system | ADMIN | x | x |  |  | low | `/assistant/restaurants` |
| `document.expired` | system | DRIVER | x | x | x |  | high | `/driver-demo.html` |
| `document.expired` | system | ADMIN | x |  |  |  | normal | `/driver-documents/expiring` |
| `document.expiring` | system | RESTAURANT | x | x | x |  | normal | `/portal/store` |
| `document.expiring` | system | DRIVER | x | x | x |  | normal | `/driver-demo.html` |
| `document.expiring` | system | ADMIN | x |  |  |  | normal | `/driver-documents/expiring` |
| `document.rejected` | system | DRIVER | x | x |  |  | high | `/driver-demo.html` |
| `document.uploaded` | system | ADMIN | x |  |  |  | normal | `/driver-pipeline` |
| `driver.applied` | system | ADMIN | x | x |  |  | low | `/driver-pipeline` |
| `driver.background_check` | system | ADMIN | x |  |  |  | normal | `/driver-pipeline` |
| `driver.instant_activated` | system | ADMIN | x |  |  |  | normal | `/drivers` |
| `driver.training_completed` | system | ADMIN | x |  |  |  | normal | `/driver-training` |
| `driver.welcome` | system | DRIVER | x | x |  |  | normal | `/driver-demo.html` |
| `incident.opened` | system | ADMIN | x | x |  |  | high, sticky | `/incidents` |
| `incident.resolved` | system | ADMIN | x |  |  |  | normal | `/incidents` |
| `menu.access_decided` | system | RESTAURANT | x | x |  |  | normal | `/portal/menu` |
| `menu.access_requested` | system | ADMIN | x |  |  |  | normal | `/restaurants/menu-access` |
| `menu.approved` | system | RESTAURANT | x | x |  |  | normal | `/portal/menu` |
| `menu.changes_requested` | system | RESTAURANT | x | x |  |  | normal | `/portal/menu` |
| `menu.item_restocked` | system | RESTAURANT | x | x |  |  | low | `/portal/menu` |
| `notification.test` | system | CUSTOMER | x | x |  |  | normal | `/order/notifications` |
| `notification.test` | system | RESTAURANT | x | x |  |  | normal | `/portal/notifications` |
| `notification.test` | system | DRIVER | x | x |  |  | normal | `/driver-demo.html` |
| `notification.test` | system | ADMIN | x | x |  |  | normal | `/inbox` |
| `otp.code` | system | CUSTOMER | x |  |  |  | normal |  |
| `otp.code` | system | DRIVER | x |  |  |  | normal |  |
| `otp.code` | system | RESTAURANT | x |  |  |  | normal |  |
| `otp.code` | system | ADMIN | x |  |  |  | normal |  |
| `promo.pending` | system | ADMIN | x |  |  |  | normal | `/promotions` |
| `restaurant.applied` | system | ADMIN | x | x |  |  | low | `/restaurants/onboarding` |
| `restaurant.background_check` | system | ADMIN | x |  |  |  | normal | `/restaurants/merchants` |
| `restaurant.document_rejected` | system | RESTAURANT | x | x |  |  | high | `/portal/store` |
| `restaurant.document_uploaded` | system | ADMIN | x |  |  |  | normal | `/restaurants/onboarding` |
| `restaurant.instant_activated` | system | ADMIN | x |  |  |  | normal | `/restaurants` |
| `store.paused` | system | RESTAURANT | x | x |  |  | high | `/portal/store` |
| `store.resumed` | system | RESTAURANT | x | x |  |  | normal | `/portal/store` |
| `verification.required` | system | DRIVER | x | x | x |  | high | `/driver-demo.html` |
| `verification.required` | system | RESTAURANT | x | x | x |  | high | `/portal` |
| `verification.verified` | system | DRIVER | x | x | x |  | normal | `/driver-demo.html` |
| `verification.verified` | system | RESTAURANT | x | x | x |  | normal | `/portal` |

`critical` = bypasses quiet hours; `sticky` = `requireInteraction` (the notification stays until dismissed). Variables of the copy are listed in the template editor (`GET /admin/notification-templates/events`).

### Deep link map

Deep links are relative to the web origin and open the right surface; the service worker only ever opens same-origin relative URLs. `{placeholder}` values come from the notification data; when one is missing the audience's base page is used (customer `/order/notifications`, restaurant `/portal/orders`, driver `/driver-demo.html`, staff `/inbox`).

| Audience | Deep links used |
|---|---|
| CUSTOMER | `/order`, `/order/notifications`, `/order/track/{orderId}` |
| DRIVER | `/driver-demo.html`, `/driver-demo.html?offer={offerId}` |
| RESTAURANT | `/portal`, `/portal/assistant`, `/portal/finance`, `/portal/menu`, `/portal/notifications`, `/portal/orders?order={orderId}`, `/portal/promotions`, `/portal/reviews`, `/portal/store` |
| ADMIN | `/analytics/ratings`, `/assistant/restaurants`, `/customers`, `/driver-documents/expiring`, `/driver-ops/sos`, `/driver-pipeline`, `/driver-training`, `/finance`, `/finance/batches`, `/finance/payouts`, `/finance/refunds`, `/inbox`, `/incidents`, `/orders`, `/orders/{orderId}`, `/promotions`, `/restaurants/menu-access`, `/restaurants/onboarding`, `/restaurants/reviews`, `/support/cases`, `/support/chat`, `/support/tickets/{ticketId}` |

### Event audit: what was missing and is now covered

Before this work, only the restaurant's `order.placed`, the customer's accept / reject / ready / picked up / delivered / cancelled and the driver offer reached anyone live; the rest were in-app only or never sent. Added or fixed:

| Gap | Fix |
|---|---|
| Customer never told the order was placed / held / sent to the restaurant | `order.placed` (cancel-window note + `cancelUntil`), `order.sent_to_restaurant` (at release) |
| No "preparing", "on the way" for the customer | `order.preparing`, `order.on_the_way` |
| Driver arrived at the restaurant | `driver.arrived_restaurant` (customer, and the kitchen with a sticky alert) |
| Restaurant never told: order cancelled, picked up, delivered, prep overdue, review received, auto-restock, store paused / resumed | `order.cancelled`, `order.picked_up`, `order.delivered`, `order.prep_overdue`, `review.received`, `menu.item_restocked`, `store.paused`, `store.resumed` |
| Driver: cancel / reassign / offer expired / offer cancelled / order ready / trip complete / tip | `order.cancelled`, `order.reassigned`, `driver.offer_expired`, `driver.offer_cancelled` (replace the ringing offer push through the same collapse tag), `order.ready`, `order.delivered`, `order.tip_updated` (it was sent to the wrong id before: driver profile id instead of user id) |
| `offer.accepted` had no copy (the title was the raw key) | copy added |
| Payment problems | `payment.failed` (staff) and `payment.issue` (customer) when the payment cannot be settled (only an old manual-capture hold can fail at delivery now: the card is charged at checkout) |
| Staff: late orders, live chat waiting, SOS | `order.late` (to staff with `orders:view`), `chat.waiting` (`support:view`), SOS now also reaches phones (push, critical, sticky) |
| Staff received every event regardless of role | `ADMIN` events carry a `module`; only staff whose role grants `<module>:view` (and super admins) receive them |
| `delivery.driver_arrived` put the PIN in the text | in-app text still has it (the customer needs it); the push says "Have your delivery PIN ready" only |
| `order.cancelled` refund note was blank | filled from the payment state |
| Restaurant `order.placed` had no order id, type, item count | `data.orderId`, `{type, itemCount, total}` |

Events added by other features and registered here: `order.cancel_requested` / `order.cancel_request_answered`, `driver.waiting`, `wait.fee_charged`, `menu.access_requested` / `menu.access_decided`, `assistant.training.requested` / `assistant.training.decided`.

### Push payload allow-list

Only these variables may be interpolated into a push text and only these data keys may travel in `data` (all other event data, PINs, codes, phone numbers, addresses, card and proof data never do). Events not listed carry fixed text and no data. `otp.code` is never pushed.

| Event | Allowed text variables | Allowed data keys |
|---|---|---|
| `delivery.driver_arrived` | `code`, `methodNote` | `orderId` |
| `delivery.instructions_changed` | `code` | `orderId` |
| `delivery.left_at_door` | `code` | `orderId` |
| `driver.arrived_restaurant` | `code`, `driverName`, `restaurant` | `orderId` |
| `driver.assigned` | `code`, `driverName`, `vehicle`, `etaMinutes` | `orderId` |
| `driver.offer` | `restaurant`, `pickupKm`, `dropKm`, `pay`, `seconds` | `offerId`, `orderId`, `seconds`, `expiresAt` |
| `driver.offer_cancelled` | `restaurant` | `offerId`, `orderId` |
| `driver.offer_expired` | `restaurant` | `offerId`, `orderId` |
| `driver.supply_alert` | `zone`, `boost` | `zoneId` |
| `driver.waiting` | `code` | `orderId` |
| `offer.accepted` | `code` | `orderId` |
| `order.no_driver` | `code` | `orderId` |
| `order.reassigned` | `code` | `orderId` |
| `order.accepted` | `code`, `restaurant`, `prepMinutes` | `orderId` |
| `order.cancel_request_answered` | `code`, `decision` | `orderId` |
| `order.cancel_requested` | `code` | `orderId` |
| `order.cancelled` | `code`, `refundNote` | `orderId` |
| `order.delivered` | `code`, `earnings` | `orderId` |
| `order.item_removed` | `code`, `item`, `amount` | `orderId` |
| `order.late` | `code`, `eta` | `orderId` |
| `order.on_the_way` | `code`, `eta` | `orderId` |
| `order.picked_up` | `code`, `driverName` | `orderId` |
| `order.placed` | `code`, `restaurant`, `total`, `type`, `itemCount`, `cancelNote` | `orderId`, `cancelUntil` |
| `order.prep_overdue` | `code`, `minutes` | `orderId` |
| `order.preparing` | `code`, `restaurant` | `orderId` |
| `order.ready` | `code`, `restaurant` | `orderId` |
| `order.rejected` | `code`, `restaurant` | `orderId` |
| `order.sent_to_restaurant` | `code`, `restaurant` | `orderId` |
| `order.stuck` | `code` | `orderId` |
| `rating.prompt` | `code`, `restaurant` | `orderId` |
| `rating.prompt_partner` | `code` | `orderId` |
| `rating.reminder` | `code`, `restaurant` | `orderId` |
| `review.received` | `rating`, `code` | `reviewId`, `orderId` |
| `review.reply` | `restaurant` | `orderId` |
| `credit.issued` | `amount` |  |
| `finance.dispute` | `status`, `code` |  |
| `finance.payout_failed` | `party` |  |
| `finance.refund_pending` | `code`, `amount` |  |
| `order.partial_refund` | `code`, `amount` | `orderId` |
| `order.tip_updated` | `code`, `tip` | `orderId` |
| `payment.failed` | `code` | `orderId` |
| `payment.issue` | `code` | `orderId` |
| `payout.account_not_ready` | `amount` |  |
| `payout.sent` | `amount`, `period` |  |
| `refund.issued` | `code`, `amount` | `orderId` |
| `refund.pending_approval` | `code`, `amount` | `orderId` |
| `refund.rejected` | `code` | `orderId` |
| `wait.fee_charged` | `code`, `minutes`, `amount` | `orderId` |
| `campaign.message` | `title`, `body` |  |
| `promo.approved` | `name` |  |
| `promo.rejected` | `name` |  |
| `chat.message` |  | `chatSessionId`, `ticketId` |
| `chat.waiting` | `who` | `sessionId` |
| `sos.alert` |  | `driverId`, `orderId` |
| `ticket.update` | `number` | `ticketId` |
| `account.approved` | `name` |  |
| `account.deactivation_notice` | `respondBy` |  |
| `account.rejected` | `name` |  |
| `assistant.training.decided` | `decision` |  |
| `document.expired` | `docType` |  |
| `document.expiring` | `docType`, `expiresAt`, `days` |  |
| `document.rejected` | `docType` |  |
| `menu.access_decided` | `decision`, `name` |  |
| `menu.item_restocked` | `count`, `items` |  |
| `notification.test` | `message` |  |
| `otp.code` | (never pushed) |  |
| `store.paused` | `mode`, `resumeAt` |  |
| `store.resumed` | `mode` |  |
| `verification.required` | `deadline` |  |

## 3. Preferences

`GET / PUT /notifications/preferences` (every user of every app):

```jsonc
{
  "pushEnabled": true,                     // master push switch (all devices)
  "criticalBypassQuietHours": true,        // new restaurant orders, driver offers, SOS, cancel requests ring through quiet hours
  "soundEnabled": true, "soundVolume": 80, // restaurant portal alarm
  "categories": {                          // orders | delivery | payments | support | promotions | system
    "orders": { "inApp": true, "push": true, "email": true, "sms": true }
  },
  "quietHours": { "enabled": false, "start": "22:00", "end": "07:00", "timezone": "America/Toronto" }
}
```

* In-app is **locked on** for orders, delivery, payments and support (those are records); promotions and system can be switched off.
* Quiet hours suppress **push and SMS** (not in-app, not e-mail) except critical events (unless the user also switched the bypass off).
* **Customers**: the fields that already existed are the source of truth and are merged, not duplicated: `pushEnabled` and the marketing e-mail / SMS consents (CASL, opt-in, with the consent log) live on `CustomerProfile`; `orderUpdates` / `driverMessages` / `promotions` of `/customer/profile/notifications` map to the orders / delivery / promotions push toggles. The old routes `PATCH /customer/profile/consents` and `PATCH /customer/profile/notifications` keep working and the new API reflects them (and the other way round).
* Marketing events (`campaign.message`) additionally need the CASL consent of the channel.

## 4. API reference

All routes need the Bearer token of the caller (any app) except `push/config`. Everything operates on the caller's own data only; another user's ids are indistinguishable from unknown ids (404).

| Route | Purpose |
|---|---|
| `GET /notifications?cursor=&limit=&unread=true&category=` | Notification center, newest first. `{ data:[{id,title,body,event,category,data,url,readAt,createdAt}], nextCursor, unread, meta:{limit,hasMore} }`. `limit` max 100. `?page=N` still works (adds `meta.total`). |
| `GET /notifications/unread-count` | `{ count }` |
| `POST /notifications/:id/read` / `POST /notifications/read-all` / `POST /notifications/read` (legacy `{id?}`) | mark read; a `notification.read` socket event keeps other tabs in sync |
| `DELETE /notifications/:id` | delete one |
| `GET / PUT /notifications/preferences` | see section 3 |
| `GET /notifications/push/config` (public) | `{ enabled, publicKey }` (VAPID public key; `enabled:false` when the kill switch is off) |
| `POST /notifications/push/subscribe` `{ subscription:{endpoint,expirationTime,keys:{p256dh,auth}}, app }` | bind this browser to the user; `app` must match the account type (`customer` / `driver` / `restaurant` / `admin`); an existing endpoint moves to the new user; at most 10 devices per user |
| `POST /notifications/push/unsubscribe` `{ endpoint }` | only removes the caller's own subscription (called on logout / turn off) |
| `GET /notifications/push/status?endpoint=` | `{ subscribed, count, current, pushEnabled, platformEnabled }` |
| `GET /notifications/push/devices?endpoint=` / `DELETE /notifications/push/devices/:id` | browsers and native devices of the caller (no endpoints / tokens returned) |
| `POST /notifications/push/test` | test in-app + push to the caller |
| `POST /notifications/devices` `{ token, platform:'ios'\|'android', app, appVersion }` / `DELETE /notifications/devices/:token` | native (FCM) device registration |
| `GET /admin/notifications/overview` | push health, VAPID status (public key only), switches, FCM configured |
| `PUT /admin/notifications/switches` `{ enabled?, webEnabled?, fcmEnabled? }` | kill switches (audited) |
| `GET /admin/notifications/log?channel=&status=&event=&q=&userId=&from=&to=&page=&limit=` | delivery log of push / SMS / e-mail |
| `POST /admin/notifications/log/:id/retry` | resend a FAILED / SKIPPED delivery (push re-uses the stored sanitised payload) |
| `POST /admin/notifications/test` `{ userId \| roleId \| app, message? }` | test push to a user, every staff member of a role, or every user of an app that has a browser subscribed |
| `GET /admin/notifications/coverage` | the registry with the effective channels |

Permissions for the admin routes: module `notifications` (`view` for reads, `edit` for switches / retry / tests). Secrets (`notifications.vapid.keys`, `notifications.fcm.serviceAccountJson`) are masked in `/admin/settings` and only a Super Admin can change them.

Rate limits: the global tiers apply; `push/test` and the admin test are additionally limited to 30 / minute.

## 5. Browser push in detail

* **VAPID keys**: `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` from the environment win. Otherwise the pair is generated **once** on first boot and stored as one encrypted value (`secretbox`, AES-256-GCM, `DATA_ENCRYPTION_KEY`) in the `notifications.vapid.keys` setting (compare-and-set, so concurrent instances end up with the same pair); every restart reuses it. Replacing the pair invalidates every existing browser subscription (the push service answers 403); the clients repair themselves on the next page load (`push.sync()`).
* **Endpoint safety (SSRF)**: a subscription endpoint is a URL the server will POST to. Production accepts only `https` on the known push services (FCM, Mozilla, Windows, Apple; extend with `PUSH_ENDPOINT_HOSTS`); never IP addresses, credentials, private / `.local` hosts. Development also accepts loopback `http://127.0.0.1` so a local fake push service can be used. Redirects are never followed.
* **Delivery**: `web-push` is used for RFC 8291 encryption and VAPID signing; the request itself is sent with `fetch` (timeouts, no redirects). Headers: `TTL`, `Urgency`, `Topic` (collapse), `Content-Encoding: aes128gcm`, `Authorization: vapid`. Up to 3 attempts with back-off (429 honours `Retry-After`, 5xx and network errors retry; 400 / 401 / 403 do not); **404 / 410 delete the subscription**; a success resets the failure counter, a final failure increments it; a nightly job drops subscriptions with 20 failures in a row or unseen for 120 days. Concurrency is bounded (16 in flight, 6 per user).
* **Payload** (<= 2.5 KB, clamped): `{ title, body, tag, url, icon:'/brand/icon-192.png', badge:'/brand/icon-96.png', requireInteraction, critical, event, id, data, ts }`.
* **No sensitive data in a push.** The text comes only from the event registry's push copy (or an admin-edited PUSH template) rendered with the event's **allow-listed variables** (`pushVars`); `data` only carries the allow-listed keys (`pushData`: ids, `seconds`, `expiresAt`, `cancelUntil`). Delivery PINs, pickup codes, gate / access codes, phone numbers, addresses, card and proof data are never allow-listed. `scrubPush()` additionally strips anything that looks like a PIN / code, e-mail address, phone number or long number from the final text. `otp.code` is never pushed at all. For `delivery.driver_arrived` the in-app text contains the PIN (the customer needs it) while the push only says "Have your delivery PIN ready".
* **Service worker** (`/sw.js`, scope `/`, shared by every surface of the origin): `push` (show, collapse by `tag`, `renotify`; **skipped when a page of the same surface is visible and focused**: that page shows its own toast / alarm, so there is never a double alert), `notificationclick` (focus an open tab of the same surface and tell it to open the deep link and mark the notification read, else open a new window with `#fk-n=<id>`), `pushsubscriptionchange` (re-subscribe, the page re-registers the new endpoint). Only same-origin relative URLs are ever opened.
* **Permission flow**: never auto-prompted. The only code path that calls `Notification.requestPermission()` is a button click (`push.enable()`); a dismissible banner and the bell menu explain why; denied / unsupported / insecure / iOS-not-installed / another-account-on-this-browser / platform-off states have their own copy; the opt-in is remembered per user and per app (`fk.push.<app>.optin.<userId>`), the same user is re-subscribed silently after their next login (permission is already granted). **Logout unsubscribes the browser first** (server + browser), including idle logout. A browser has one subscription: if a second account subscribes on it, the endpoint moves to that account and the first account sees "this browser belongs to another account".

## 6. FCM HTTP v1 (native apps)

`FcmService`: the service-account JSON (`notifications.fcm.serviceAccountJson`, a masked secret setting, or env `FCM_SERVICE_ACCOUNT_JSON`) is exchanged for an OAuth2 access token with an RS256 JWT signed with `node:crypto`; the token is cached until 60 s before expiry and refreshed once on a 401. Messages go to `POST {FCM_API_BASE|https://fcm.googleapis.com}/v1/projects/<project_id>/messages:send` (one request per device token, bounded concurrency, 3 attempts, `UNREGISTERED` / 404 deletes the token). `FCM_API_BASE` and (outside production) `FCM_TOKEN_URI` exist for tests. The legacy server-key API and the `notifications.fcmServerKey` setting are gone. **Not tested against Google** (see section 9).

## 7. Clients

`admin/src/lib/notify/*` (used by the Admin Console, Restaurant Portal and customer website; the driver demo page has the same logic in `admin/public/notify-lite.js`):

* `createNotificationStore` (list, unread count, realtime via Socket.IO, **polling fallback** every 30 s when the socket is down, mark read / all / delete, cursor paging), `createPush` (permission + subscribe / unsubscribe / sync), `createSound` + `createAlerts` (Web Audio alarm, no audio files), `NotifyProvider` + hooks, `createRealtime` (the customer website's own socket).
* Admin Console / Portal: header bell = notification center (dropdown, See all page `/inbox` and `/portal/notifications`), notification settings pages (`/notification-settings`, `/portal/notification-settings`: this device, preferences, quiet hours, sound, my devices, send test), "Turn on notifications" banner.
* Customer website: header bell, `/order/notifications`, account notification preferences, live order tracking (socket events refresh the tracking page immediately; the 5 s polling stays as the fallback).
* **Restaurant new-order alarm** (critical): when `order.placed` (kitchen audience) or `order.cancel_requested` arrives, or when the portal finds an unaccepted order on load, a persistent red banner appears on every portal page, the tab title flashes (`(2) New order | ...`), a Web Audio alarm repeats (every ~4 s; cancel requests use a harsher pattern) until the order is opened, accepted / rejected (any `order.status` change) or acknowledged. Only one open tab rings (lease in `localStorage`); every tab shows the banner. Browsers refuse sound before a user gesture: the AudioContext is unlocked on the first click / key / touch and, until then, the banner shows **"Sound is blocked - click to enable the alarm"**. With the tab hidden the sticky (`requireInteraction`) push is the alert. Orders are held for the customer's 120 s cancellation window and reach the restaurant only at release; that is exactly when `order.new` and the `order.placed` notification fire.

### How a restaurant owner turns the loud alert on

1. Sign in to the portal, click **Turn on notifications** in the banner (or Notification settings > This device > Enable) and allow notifications in the browser prompt.
2. Open **Notification settings > Sound** and check the alarm is on, set the volume, press **Play test sound** (this also unlocks the browser's audio).
3. Keep one portal tab open on the kitchen tablet (any page); click anywhere once after each browser restart so the sound is unlocked.
4. Make sure the category **Orders** has **Push** on and quiet hours are off (or "critical alerts ignore quiet hours" is on, the default).

## 8. Settings and environment

| Key / variable | Meaning |
|---|---|
| `notifications.push.enabled` / `.webEnabled` / `.fcmEnabled` | platform kill switches (System > Notifications) |
| `notifications.vapid.keys` (secret), `.publicKey` (info), `.subject` | VAPID pair (generated once), contact `mailto:` / `https:` |
| `notifications.fcm.serviceAccountJson` (secret) | FCM v1 service account |
| `notifications.matrix` | event -> audience -> channels (defaults from the registry) |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | pin the VAPID pair |
| `FCM_SERVICE_ACCOUNT_JSON`, `FCM_API_BASE`, `FCM_TOKEN_URI` | FCM (the last two for tests) |
| `PUSH_ENDPOINT_HOSTS` | extra push-service hosts accepted in production |
| `PUSH_MAX_IN_FLIGHT`, `PUSH_RETRY_BASE_MS` | tuning |

Database: `notifications` gets `category`, `url`, `attempts`, `meta` and indexes on `(userId, readAt, createdAt)`, a partial index on unread in-app rows and `(channel, createdAt)`; new tables `push_subscriptions` and `notification_preferences`; `device_tokens` gets `lastSeenAt`, `failures`.

## 9. Testing and what could not be tested

Scripts (outside the repo, in the scratchpad): `t1-push` (subscribe / unsubscribe / ownership / SSRF / delivery to a local fake push service with real ECDH keys: headers, VAPID signature, RFC 8291 decryption, 404 / 410 deletion, 429 / 5xx retries), `t2-center` (cursor pagination, read state, ownership, preferences, merge with the customer consents), `t3-lifecycle` (a real order through every audience, no PIN / code / phone / address in any push, restaurant and driver push flags, quiet hours + critical bypass, cancel request), `t4-admin` (permissions, audit, retry, scoping), `t5-vapid` (persistence across an API restart), repo test `backend/test/notifications-fcm.test.ts` (FCM v1 against a fake OAuth + FCM server).

**Not tested**: delivery through the real push services of Google (FCM web push), Mozilla and Apple needs a real browser with internet access and a real subscription; headless Chromium has no push service, so subscriptions are stubbed or delivered with the Chrome DevTools protocol (`ServiceWorker.deliverPushMessage`), which exercises the service worker (`showNotification`, `notificationclick`) but not the network path. **FCM HTTP v1 was not tested against Google** (only against a local fake: request shapes, JWT signature, token cache and refresh, error handling). Real e-mail / SMS providers are mocked in development as before.
