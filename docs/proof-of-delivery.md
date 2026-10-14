# Proof of delivery and delivery instructions

Plain-language policy for how FORKY proves an order was delivered and how a "my order never arrived" claim is settled. Code: `backend/src/orders/proof.service.ts`, `delivery-instructions.ts`, `support/delivery-disputes.service.ts`.

## 1. What the customer chooses (handoff method)

| Method | What it means | Proof the driver must give |
|---|---|---|
| `HAND_TO_ME` (default) | Driver hands the order over | The customer's **4-digit PIN** (always generated at order placement, shown in the order / tracking screen) |
| `MEET_OUTSIDE` | Customer meets the driver outside | Same: the customer's PIN |
| `LEAVE_AT_DOOR` (contactless) | Driver leaves it at the door | A **photo** of the dropped-off order, taken at the drop-off location. No PIN |
| pickup orders | - | No delivery proof (restaurant pickup code only) |

The customer can also give **delivery instructions** for the driver (max 300 characters, plain text, e.g. "Unit 5, use side door, dog in yard") and an **access code** (buzzer / gate, max 40). These are separate from the **kitchen notes** (`customerNotes`), which go to the restaurant. Defaults can be saved per address and are prefilled when the order request omits them. The customer can change method, instructions and code until the driver has picked the food up (`PATCH /customer/orders/:id/delivery-instructions`); the assigned driver is told in real time and by notification. Switching method changes the proof rule and PIN accordingly.

Who sees what: the access code is encrypted at rest, never returned in lists, analytics, restaurant payloads or logs; the assigned driver sees it only from pickup until delivery; staff with `orders:view` see it only through an explicit, audit-logged "Reveal" after pickup; it is blanked from the order `delivery.accessCodeRetentionDays` (7) days after the order ends. Restaurants see only the method (a "Contactless" badge), never the PIN, instructions or code.

## 1b. The customer chooses: private PIN on or off

Delivery orders carry `usePin` (default **true**; only the customer can change it - never order value or an admin setting, and the 4-digit PIN itself is generated once and never changes, even if the customer toggles the choice or the method; omitted = the chosen address's saved default; also settable per address and changeable with `PATCH /customer/orders/:id/delivery-instructions` until pickup).

| Customer choice | Proof the driver must give |
|---|---|
| PIN on (hand to me / meet outside) | the customer's 4-digit PIN |
| **PIN off** (hand to me / meet outside) | the driver chooses **Handed to the customer** (in person; no photo needed, one can be added) or **Delivered / left at the location** (**photo compulsory**, taken at the drop-off and uploaded in the app) |
| Leave at door (contactless) | a **photo, always** (no setting can turn this off): taken in the FORKY app at the drop-off, after the driver taps "arrived at customer", within 100 m of the address, fresh and not reused; no PIN is used |

**Driver app contract** (`GET /driver/trip/active` -> `dropoff`): `pinInput: {required, length: 4}` = show 4 PIN boxes and send `pin`; `photoRequired` = camera + upload (`proofPhotoUrl`, `lat`, `lng`, `accuracy`, `capturedAt`); `deliveryActions` (PIN off only) = the two choices, sent as `deliveryAction` = `HANDED_TO_CUSTOMER` | `LEFT_AT_LOCATION` (omitted = left, so a photo is needed). A hand-over without photo is stored as proof type `HANDED_OVER` (inside the geofence, time and GPS recorded, not flagged as suspicious, but with no PIN or photo to verify): a "never delivered" claim on it goes to a Tier-2 human review, with no automatic refund and no driver strike. A runnable test page is at `/driver-demo.html` on the admin dev server.

The 4-digit PIN is generated once when the order is placed and never changes unless the customer chooses to; turning the PIN off and on again, or switching the handoff method, keeps the same PIN.

Every delivery additionally needs the driver within **100 m** of the delivery location. Set `delivery.proof.photoAlways` (default off) to require a photo on every delivery, PIN or not. `GET /public/delivery-options` returns the `pinChoice` text and `geofenceMeters` for the app UI.

## 2. What the server checks when the driver taps "delivered"

1. The driver tapped **arrived at customer** first.
2. **PIN** (when required): constant-time comparison; 5 wrong attempts lock the PIN path for that order.
3. **Photo** (when required, or on the exception path): must be a JPEG/PNG uploaded **by that driver** through `POST /uploads` (our own URL), uploaded after pickup, **captured within `delivery.proof.photoMaxAgeMinutes`** (10), with lat, lng, accuracy and capturedAt. The photo is hashed (after metadata stripping): the same image cannot serve as proof on two orders (409, audited).
4. **Geofence**: the delivery / photo location must be within `delivery.proof.geofenceMeters` (**100 m**) of the drop-off address coordinates. Outside it the delivery is **rejected**, for every method and also on the exception path (the driver must move closer and retry).
5. **Server GPS cross-check**: the claimed location is compared with the driver's last server-side GPS fix. If it is farther than `delivery.proof.gpsMismatchMeters` (300 m) the evidence is flagged `GPS_MISMATCH`; no fresh fix = `GPS_UNVERIFIED`.

Exception path: if the customer is unreachable, the PIN is not available or there is a safety concern, the driver may complete with a **photo + reason** (`CUSTOMER_UNREACHABLE`, `PIN_NOT_AVAILABLE`, `SAFETY_CONCERN`). It still has to be inside the 100 m geofence, is marked **WEAK_PROOF**, appears on the order timeline, is audit-logged, notifies operations and goes to review.

## 3. Evidence stored (one immutable record per delivery, `delivery_proofs`)

Method, proof type (`PIN`, `PHOTO`, `PIN_AND_PHOTO`, `EXCEPTION`, `NONE` only for staff-forced deliveries or relaxed settings), PIN verified, photo hash / size / coordinates / accuracy / capture time, drop-off coordinates, claimed location, distance in metres, distance to the driver's server GPS, server timestamps (arrived at customer, delivered), the driver's GPS breadcrumb for the last 10 minutes (summarised), device IP and user agent, what the customer asked for (instruction snapshot), flags (`WEAK_PROOF`, `GEOFENCE_OVERRIDE`, `GPS_MISMATCH`, `GPS_UNVERIFIED`, `LOW_ACCURACY`, `STAFF_FORCED`), and the review / dispute block (who reviewed, outcome). Only the review / dispute block can change after delivery.

**Strong** proof = a verified PIN, or a clean in-geofence photo with no flag. **Weak** = exception path, any integrity flag on a photo-only delivery, or no proof.

The photo is stored **outside** the public uploads folder, with EXIF / XMP / text metadata removed (built-in JPEG/PNG stripper; no GPS or device data in the stored file), and is served only through `GET /orders/:id/proof/photo` to the order's customer, its assigned driver, the restaurant staff of that order and staff with `orders:view` (bearer token required, `Cache-Control: private, no-store`, `nosniff`). The customer sees the delivery photo, time and map point in the tracking payload.

## 4. Retention

Photo **files** are deleted `delivery.proof.retentionDays` (90) days after delivery by a daily job, unless the order has an open or recent (30 days) dispute ticket or the proof still needs review. The evidence record (hash, coordinates, times, flags) is kept. The API then answers 410 for the photo.

## 5. How "never arrived" disputes are decided

| Situation | What happens |
|---|---|
| Valid proof on file (PIN verified, or clean in-geofence photo) | **No auto-refund.** Ticket goes to Tier 2: "Proof on file - review required", with the evidence attached. |
| Proof missing, weak or flagged (also old orders and legacy photo URLs without an evidence record) | The refund path stays (charged to the platform, or to the driver on repeat claims) and the driver gets a **delivery-dispute strike** (`deliveryDisputes30d`, shown on the driver page; at `support.deliveryDisputeStrikeThreshold` the SOP-08 detector proposes a review case). |
| Staff verdict `UPHELD_DELIVERED` | Claim rejected; driver strike reversed; customer's false-claim counter +1. At `support.falseClaimFlagThreshold` (2) the customer is flagged for review (never auto-banned). |
| Staff verdict `NOT_DELIVERED` | Claim confirmed; driver strike kept / added. |
| Staff verdict `INCONCLUSIVE` | Recorded only. |

## 6. Settings (Admin Console > Settings, group `delivery`)

`delivery.proof.geofenceMeters` (100), `delivery.proof.photoAlways` (false), `delivery.proof.requireGeofence` (true), `delivery.proof.photoMaxAgeMinutes` (10), `delivery.proof.retentionDays` (90), `delivery.proof.gpsMismatchMeters` (300), `delivery.proof.serverGpsMaxAgeSec` (300), `delivery.accessCodeRetentionDays` (7), `support.falseClaimFlagThreshold` (2), `support.deliveryDisputeStrikeThreshold` (3). The old `driver.deliveryGeofenceKm` was replaced (an existing non-zero value is converted to metres on boot, then removed).

## 7. Known limits

Photo reuse detection is by exact content hash (metadata-insensitive), not perceptual similarity. EXIF stripping covers JPEG and PNG only (other formats are refused as proof). The evidence row is immutable by application design, not by a database trigger. Photos live on the API server's disk (`private-uploads/`); production should use a private object-store bucket.
