# DispatchModule API

`DispatchService` (`src/dispatch/dispatch.service.ts`, exported globally) implements `IDispatchService` (`src/common/contracts.ts`). It is not called directly over HTTP by customers/restaurants; it is consumed by:

- **OrdersModule** indirectly: `DispatchService` listens for `Events.ORDER_STATUS_CHANGED` (order -> `ACCEPTED` with `fulfilment = PLATFORM_DRIVER`) and starts the offer loop, and for `Events.ORDER_CANCELLED` to stop it.
- **Admin live map controller** below (dispatcher tools).
- **Driver offer controller** below (temporary home for the driver-facing offer primitives until DriversModule wires its own `/driver/*` portal - it can keep calling the same `DispatchService` methods).

## Offer loop behaviour (spec 5.4)

- One driver offered at a time; window = `City.offerTimeoutSec` (default 30s).
- Ready-time matching: `startDispatch` computes the order's expected ready time (`Order.estimatedReadyAt`) and, using the nearest currently-visible candidate's ETA (or setting `dispatch.assumedPickupEtaMin` if none are online yet), delays the loop (`WAITING` state) so the driver is not sent more than `dispatch.readyMatchWindowMin` minutes before food is ready.
- After `City.offersBeforeWiden` offers (default 3) with no acceptance, the search radius widens by `City.radiusWidenStepKm` and a pay boost of `City.widenBoostAmount` is added (`DriverOffer.boostAmount`, folded into `Order.driverBoost` via `OrdersService.assignDriver`).
- After `City.maxRadiusWidenings` widenings (default 2), the order is escalated: `Order.unassignedFlag = true` (drives the live-map RED flag), an ops notification (`order.no_driver`) + `dispatch.escalated` realtime event fire once, and the search **keeps retrying** slowly (`dispatch.escalatedRetrySec`, default 45s) rather than stopping.
- State machine persisted at `Order.meta.dispatch` (`DispatchMeta`): `WAITING -> ACTIVE -> (ESCALATED) -> ASSIGNED`, or `MANUAL` when `dispatch.autoAssign` is off, or `STOPPED`/`MANUAL_HOLD` when a dispatcher takes over.
- Realtime events: `driver.offer` / `driver.offer.cancelled` (to `driver:{id}`), `dispatch.offer_sent` / `dispatch.escalated` / `driver.stationary` (to `admin:ops`). Notification event `driver.offer` (DRIVER audience).

## Admin - Live Operations Map (`AdminLiveMapController`, `src/dispatch/admin-live-map.controller.ts`)

Base path `/api/v1/admin/live-map`. Staff/Super-Admin only.

| Method & path | Permission | Request | Response |
|---|---|---|---|
| `GET /admin/live-map?cityId=` | `LIVE_MAP:VIEW` | query `cityId?` | `{ generatedAt, orders: [{ id, code, status, fulfilment, restaurantId, restaurantName, restaurantLat, restaurantLng, driverId, dropLat, dropLng, estimatedReadyAt, estimatedDeliveryAt, flag: 'NONE'\|'AMBER'\|'RED', flagReasons: string[], minutesLate, dispatch: { state, widenings, radiusKm, sequence } \| null }], drivers: [{ id, name, status, vehicleType, lat, lng, heading, onTrip, rating, lastLocationAt }], restaurants: [{ id, name, lat, lng, status, cityId, zoneId }], counts: { orders, onlineDrivers, driversOnTrip, unassigned, redFlags } }` |
| `GET /admin/live-map/orders/:id/candidates?limit=` | `LIVE_MAP:VIEW` | - | `RankedCandidate[]` - `{ driverId, name, phone, vehicleType, lat, lng, distanceKm, etaMin, dropKm, estimatedPay, score, breakdown, factors, eligible, reasons, activeOrders, onTrip, lastOfferAt, lastLocationAt }[]` (ineligible drivers included, with `reasons` explaining why) |
| `POST /admin/live-map/orders/:id/assign` | `OPERATIONS:EDIT` | `{ driverId, boost? }` | Updated `Order` (stops any running offer loop first; audit-logged `dispatch.manual_assign`) |
| `POST /admin/live-map/orders/:id/reassign` | `OPERATIONS:EDIT` | `{ driverId, reason? }` | Updated `Order` (unassigns current driver, then manual-assigns the new one; audit-logged `dispatch.reassign`) |
| `POST /admin/live-map/orders/:id/start-dispatch` | `OPERATIONS:EDIT` | - | `{ ok: true }` - manually (re)kicks the offer loop for a `MANUAL`/stalled/escalated order (audit-logged `dispatch.restart`) |
| `POST /admin/live-map/orders/:id/offer-alternative` | `OPERATIONS:EDIT` | `{ type: 'CREDIT'\|'PICKUP_OFFER', amount?, reason? }` | `CREDIT`: issues a wallet credit via `RefundsService.issue` (platform-charged, reason code `NO_DRIVER_AVAILABLE`) and returns the `Refund`. `PICKUP_OFFER`: sends the customer the existing `order.no_driver` notification as a nudge and returns `{ ok: true }`. Only allowed while the order still has no driver. Audit-logged `dispatch.offer_credit` / `dispatch.offer_pickup`. |

`flag`/`flagReasons` come from `computeOrderFlag` (`src/dispatch/order-flags.ts`) - reasons include `RESTAURANT_NOT_ACCEPTING`, `KITCHEN_LATE`, `KITCHEN_NEAR_DUE`, `NO_DRIVER_AFTER_READY`, `WIDENED_SEARCH`, `PICKUP_OVERDUE`, `DELIVERY_LATE`, `VERY_LATE`, `NO_DRIVER`, `LATE`.

## Driver offer endpoints (`DriverOfferController`, `src/dispatch/driver-offer.controller.ts`)

Base path `/api/v1/driver/offer`. Driver app only (`DriverController`). Placeholder home for these until DriversModule builds its full `/driver/*` portal - safe to keep calling these same paths/methods.

| Method & path | Request | Response |
|---|---|---|
| `GET /driver/offer/current` | - | Current pending offer for the calling driver, or `null`. Shape: `{ id, orderId, code, restaurant: { id, name, address, lat, lng } \| null, deliveryAddress, itemCount, subtotal, pickupKm, dropKm, estimatedPay, boostAmount, sentAt, expiresAt, secondsLeft }` |
| `POST /driver/offer/:id/accept` | - | Updated `Order` (assigns the driver via `OrdersService.assignDriver`, transitions to `DRIVER_ASSIGNED`). 400 if expired/already resolved/order already has a driver. |
| `POST /driver/offer/:id/decline` | `{ reason? }` | `204`-ish `void` - offer marked `DECLINED`, loop immediately advances to the next candidate. |

## Settings added (`SETTING_DEFINITIONS`, additive)

| Key | Default | Purpose |
|---|---|---|
| `dispatch.assumedPickupEtaMin` | 8 | Fallback "time to find + drive a driver here" used for ready-time matching when no candidate is visible yet at `startDispatch` time. |
| `dispatch.escalatedRetrySec` | 45 | How often the loop retries once an order has been escalated to the dispatcher. |

(Existing dispatch settings reused as-is: `dispatch.autoAssign`, `dispatch.maxInitialRadiusKm`, `dispatch.readyMatchWindowMin`, `dispatch.weights`, `dispatch.batching.enabled`, `dispatch.bikeMaxDistanceKm`, `dispatch.bikeMaxSubtotal`, `dispatch.driverMissingAlertMin`; per-city tuning on `City`: `offerTimeoutSec`, `offersBeforeWiden`, `maxRadiusWidenings`, `radiusWidenStepKm`, `widenBoostAmount`, batching fields.)

## Entities

No new entities were needed - `DriverOffer` (`src/database/entities/driver.entities.ts`) already existed with every column the offer loop needs (`sequence`, `round`, `sentAt`, `expiresAt`, `respondedAt`, `pickupDistanceKm`, `dropoffDistanceKm`, `estimatedPay`, `boostAmount`, `score`, `scoreBreakdown`, `declineReason`).
