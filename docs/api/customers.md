# CustomersModule API

Base: `/api/v1`. Customer routes need a CUSTOMER JWT (guest tokens from `/public/guest/session` work too). Admin routes need STAFF with `customers:<action>`. List responses: `{ data, meta:{page,limit,total,totalPages} }`. Errors: `{statusCode,message,details?}`.

## Admin (`/admin/customers`)
| Method | Path | Permission | Request | Response |
|---|---|---|---|---|
| GET | `/admin/customers` | customers:view | page,limit,search (name/email/phone),sortBy(createdAt,totalOrders,lifetimeSpend,lastOrderAt),sortDir,blocked=true/false,fraudFlag=true/false | list of `{id,name,email,phone,status,totalOrders,lifetimeSpend,walletBalance,isBlocked,fraudFlag,flags[],lastOrderAt,createdAt}` |
| GET | `/admin/customers/:id` | view | - | user fields + `profile{dietaryPreferences,allergens,walletBalance,referralCode,consents,isBlocked,blockReason,fraudFlag,flags,totalOrders,lifetimeSpend,lastOrderAt,internalNotes,deletionRequestedAt}`, `addressCount`, `recentOrders[]`, `refundStats` |
| GET | `/admin/ratings/customers/:customerId` | customers:view | - | private feedback from drivers/restaurants: `{ratingAvg (smoothed), ratingCount, lowRatingCount30d, status new/good/caution, flags[], distribution, tags[{tag,label,count,serious}], items[{orderId,orderCode,raterType,raterName,rating,tags,note,createdAt}]}`. Never exposed to customers, drivers or restaurants |
| GET | `/admin/customers/:id/orders` | view | page,limit,status | paginated Order rows |
| GET | `/admin/customers/:id/wallet` | view | page,limit | `{balance, transactions:{data,meta}}` |
| POST | `/admin/customers/:id/wallet/adjust` | edit (+approve if abs(amount) > setting `customers.walletAdjustApprovalThreshold`, default 100) | `{amount (+credit/-debit), reason}` | `{balance}` (audited) |
| GET | `/admin/customers/:id/refund-stats` | view | - | `{refundCount30d,refundTotal30d,refundCountLifetime,refundTotalLifetime,refundFrequencyLimit,overLimit}` |
| POST | `/admin/customers/:id/block` | edit | `{reason}` | `{ok}` (audited; blocks ordering) |
| POST | `/admin/customers/:id/unblock` | edit | - | `{ok}` |
| PATCH | `/admin/customers/:id/flags` | edit | `{fraudFlag?, addFlag?, removeFlag?}` | CustomerProfile |
| PATCH | `/admin/customers/:id/notes` | edit | `{note}` (appended, timestamped) | `{internalNotes}` |
| GET | `/admin/customers/data-requests` | view | page,limit,status(PENDING/IN_PROGRESS/COMPLETED/REJECTED),type(ACCESS/DELETION/CORRECTION/CONSENT_WITHDRAWAL) | DataRequest rows + `customer{id,name,email}` |
| POST | `/admin/customers/data-requests/:id/approve` | approve | `{notes?}` | DataRequest (DELETION => anonymises user, deletes addresses/refresh tokens, keeps orders) |
| POST | `/admin/customers/data-requests/:id/reject` | approve | `{reason}` | DataRequest |
| GET | `/admin/customers/data-requests/:id/export` | view | - | JSON export (ACCESS requests) |

## Customer app (`/customer/*`)
| Method | Path | Body / query | Response |
|---|---|---|---|
| GET/PATCH | `/customer/profile` | PATCH `{firstName,lastName,language(en/fr),avatarUrl}` | profile `{id,email,phone,...,dietaryPreferences,allergens,walletBalance,referralCode,consents,notificationPrefs,isGuest,totalOrders,addressCount}` |
| PATCH | `/customer/profile/dietary` | `{dietaryPreferences[],allergens[]}` | profile |
| PATCH | `/customer/profile/consents` | `{marketingEmail,marketingSms,push}` (CASL, logged) | profile |
| PATCH | `/customer/profile/notifications` | `{orderUpdates,promotions,newsletters,driverMessages}` | `{notificationPrefs}` |
| POST | `/customer/profile/guest-upgrade` | `{password,firstName?,lastName?,phone?}` | profile |
| POST | `/customer/profile/logout-everywhere` | - | `{ok}` |
| GET/POST | `/customer/addresses` | POST `{label,line1,line2,city,province,postalCode,lat,lng,dropoffNotes (max 300),dropoffMethod,usePin,accessCode (max 40),isDefault}` | Address[] / Address. `accessCode` is encrypted at rest and returned masked (`••••`, plus `accessCodeSet`) |
| GET | `/customer/addresses/:id` | - | the address with the access code in clear (owner only) |
| PATCH/DELETE | `/customer/addresses/:id` | partial address | Address / `{ok}` |
| POST | `/customer/addresses/:id/default` | - | Address[] |
| GET | `/customer/favorites` | lat,lng | `{data: RestaurantCard[]}` |
| POST/DELETE | `/customer/favorites/:restaurantId` | - | `{ok,isFavorite}` |
| GET | `/customer/cards` | - | `{data:[{id,brand,last4,expMonth,expYear,isDefault}]}` |
| POST | `/customer/cards/setup-intent` | - | `{clientSecret, customerId, publishableKey}`: confirm it with the Stripe Payment Element (`confirmSetup`) |
| POST | `/customer/cards/:id/default` | - | `{ok, defaultCardId}` (400 if the card is not the customer's) |
| DELETE | `/customer/cards/:id` | - | `{ok}` (400 if the card is not the customer's) |
| POST | `/customer/payments/intent` | quote fields + `{saveCard?, paymentMethodId?, intentId?}` (an `amount` field is rejected) | `{required, clientSecret, intentId, amount, currency, publishableKey, status, updated, quote}`; `{required:false}` when wallet credit covers the order. Manual-capture PaymentIntent for the card part, priced by the server. See docs/payments.md |
| POST | `/customer/wallet/top-up-intent` | `{amount}` (`payments.topUpMin`..`topUpMax`) | `{intentId, clientSecret, amount, publishableKey}` |
| POST | `/customer/wallet/top-up/confirm` | `{paymentIntentId}` | `{status: credited / already / not_paid, amount, balance}` (idempotent; the webhook credits the same intent once) |
| POST | `/customer/gift-cards/purchase-intent` | `{amount (10..500), recipientEmail?, message?}` | `{intentId, clientSecret, amount, publishableKey}` |
| POST | `/customer/gift-cards/purchase/confirm` | `{paymentIntentId}` | `{status: issued / already / not_paid, giftCard{id,code,amount}}` |
| GET | `/customer/wallet` | page,limit | `{balance, transactions:{data,meta}}` |
| POST | `/customer/wallet/redeem-gift-card` | `{code}` | `{amount,balance}` |
| GET | `/customer/referrals` | - | `{code,shareText,rewards,stats,referrals[]}` |
| GET/POST | `/customer/privacy/requests` | POST `{type: ACCESS/CORRECTION/CONSENT_WITHDRAWAL, notes}` | DataRequest(s) (ACCESS completes immediately) |
| GET | `/customer/privacy/requests/:id/export` | - | JSON export |
| POST | `/customer/privacy/deletion` / `/deletion/cancel` | `{reason?}` | DataRequest / `{ok,cancelled}` |
| GET | `/customer/cart` | - | `{restaurant,lines[],itemCount,subtotal,promoCode,issues[],valid,meetsMinimum}` |
| POST | `/customer/cart/replace` | `{restaurantId,items[{menuItemId,quantity,modifierOptionIds,notes}],promoCode}` | cart |
| POST | `/customer/cart/items` | `{menuItemId,quantity,modifierOptionIds,notes,replaceCart?}` (409 `CART_RESTAURANT_CONFLICT` if other restaurant) | cart |
| PATCH/DELETE | `/customer/cart/items/:lineId` | `{quantity,modifierOptionIds,notes}` | cart |
| POST | `/customer/cart/promo` | `{code|null}` | cart |
| DELETE | `/customer/cart` | - | empty cart |
| POST | `/customer/checkout/quote` | `{type DELIVERY/PICKUP, fulfilment?, addressId|lat+lng, tip, useWallet, promoCode, scheduledFor}` (uses current cart) | `Quote` (PricingService) |
| POST | `/customer/orders` | quote fields + `{paymentMethod (CARD / APPLE_PAY / GOOGLE_PAY / WALLET / GIFT_CARD; CASH is refused), paymentIntentId (required for any card amount: the confirmed PaymentIntent; replaces paymentToken, which only works with the development mock), giftCardCode? (redeemed to wallet first), dropoffMethod? (HAND_TO_ME/LEAVE_AT_DOOR/MEET_OUTSIDE), usePin? (default true; false = no PIN, the driver must upload a photo of the delivered order),  dropoffNotes? (driver instructions, max 300), accessCode? (max 40, sensitive), contactless? (legacy: true = LEAVE_AT_DOOR), customerNotes (KITCHEN note)}` | Order (cart cleared). Payment errors carry a `code` (`PAYMENT_INTENT_REQUIRED`, `PAYMENT_INTENT_INVALID`, `PAYMENT_NOT_CONFIRMED`, 409 `PAYMENT_QUOTE_CHANGED` / `PAYMENT_ACTION_REQUIRED` / `PAYMENT_INTENT_USED` / `PAYMENT_INTENT_CANCELED`), see docs/payments.md. Omitted method/notes/code are prefilled from the chosen saved address. Hand-to-me / meet-outside orders get a 4-digit `deliveryPin` (shown to the customer) unless `usePin` is false. Drivers must be within 100 m of the delivery location to complete |
| GET | `/customer/orders` | page,limit,status | paginated own orders |
| GET | `/customer/orders/:id` | - | Order with items, `deliveryPin` (when a PIN is required), `accessCodeSet`, `kitchenNotes`, and once delivered `deliveryProof{proofType,deliveredAt,photoUrl,location,dropoff}` (photo via the authenticated `GET /orders/:id/proof/photo`) |
| PATCH | `/customer/orders/:id/delivery-instructions` | `{dropoffMethod?, usePin?, dropoffNotes?, accessCode?}` (10/min) | Order. Allowed until the driver picks the food up (400 after). Switching method updates the proof rule / PIN; the assigned driver gets a realtime `order.instructions_changed` event + notification; an OrderEvent is written (never containing the code) |
| POST | `/customer/orders/:id/cancel` | `{reason}` | Order |
| POST | `/customer/orders/:id/reorder` | - | `{cart, skipped[{name,reason}]}` |
| PATCH | `/customer/orders/:id/tip` | `{tip}` | Order |
| POST | `/customer/orders/:id/item-removal-response` | `{approve}` | Order |
| GET | `/customer/orders/:id/review` | - | `{orderId, order{code,type,status,deliveredAt,restaurant,driver{firstName}}, rateRestaurant, rateDriver, review (own, no moderation fields) or null, canReview, canEdit, editableUntil, reviewableUntil, reason}` (404 for other customers' orders) |
| POST | `/customer/orders/:id/review` | `CreateReviewDto{restaurantRating?, driverRating? (1-5 ints), restaurantTags[], driverTags[] (codes from /public/rating-options), comment?, driverComment? (<= ratings.commentMaxLength)}` | own review. 400: not completed / outside `ratings.windowDays` / refunded as not delivered / driver rating on pickup or own-driver order / unknown tag / low rating without a negative reason tag / over-long comment. 409: already reviewed. Rate limited 10/min. Emits `review.created` |
| PATCH | `/customer/orders/:id/review` | same fields, all optional | edits the review **once** within `ratings.editWindowHours`; previous version kept in `history`. 400 on a second edit or after the window. Emits `review.updated` |
| GET | `/customer/ratings/pending` | - | `{windowDays, data:[{orderId,code,type,restaurant{id,name,logoUrl},rateDriver,deliveredAt,closesAt}]}` delivered orders still in the window and unrated |
| GET | `/public/rating-options` | - | (no auth) `{restaurant{positive[],negative[]}, driver{...}, stars, rules{windowDays,editWindowHours,commentMaxLength,requireReasonTagAtOrBelow,minCountToShow}, customerFeedback{positive[],negative[]}}`; tag items are `{code,label}` |

Public: `GET /public/delivery-options` returns the methods (label, description, what proof each implies) and suggested instruction chips.

"Kitchen notes" (`customerNotes`, for the restaurant) and "delivery instructions" (`dropoffNotes`, for the driver) are separate fields. Restaurant payloads never include the PIN, access code or delivery instructions, only the method (shown as a "Contactless" badge).

Live tracking and chat: shared `GET /orders/:id/tracking`, `/orders/:id/messages` (Orders module).

### Discovery (same under `/customer/*` personalised, and `/public/*` anonymous)
| Method | Path | Query | Response |
|---|---|---|---|
| GET | `/customer|public/home` | lat,lng | `{location,banners,cuisines,nearby,pickupOnly,popular,new,deals,fastest,favorites,promotions,counts}`. `pickupOnly` = stores currently in PICKUP_ONLY mode (not in the delivery lists). CLOSED stores that normally deliver to the location stay in the lists but are shown closed and sorted after open ones |
| GET | `/customer|public/search` | q,lat,lng,type(restaurants/dishes/cuisines),priceLevel(csv),minRating,maxFee,maxEta,dietary(csv),excludeAllergens(csv),cuisine(slugs csv),pickupOnly,`fulfilment`(pickup/delivery),openNow,sort(relevance/distance/rating/eta/fee/price_low/price_high/popular),page,limit | `{query,restaurants,dishes,cuisines,meta}` |
| GET | `/customer|public/restaurants/:slugOrId` | lat,lng | `{restaurant{...card,hours,schedule,fulfilment},promos,menu{categories,popular},reviews,ratings{rating or null,ratingLabel ('New' or null),ratingCount,distribution,topTags}}`. Cards and the page return `rating: null, ratingLabel: 'New'` until `ratings.minCountToShow` (5) visible reviews; held-back (flagged/hidden) reviews never appear |
| GET | `/customer|public/restaurants/:slug/reviews` | page,limit | `{summary{rating or null,ratingLabel,ratingCount,distribution,topTags},data,meta}` visible reviews only |
| GET | `/customer|public/restaurants/:slug/slots` | date=YYYY-MM-DD | `{date,enabled,slotMinutes,timezone,slots[{startsAt,label,capacity,booked,available}]}` |
| POST | `/public/guest/session` | `{email,phone?,firstName?,lastName?}` | login tokens + `guest:true` (409 `ACCOUNT_EXISTS` / `GUEST_EMAIL_IN_USE`) |

Events: emits `review.created`. Settings used: `customers.guestCheckoutEnabled`, `customers.walletAdjustApprovalThreshold`, `payments.giftCardsEnabled`, `compliance.dataRequestDays`, `security.refundFrequencyLimit30d`.

### Service mode on restaurant cards / pages / cart / quote
Every `RestaurantCard` (home, search, favorites, restaurant page) now has `serviceMode` (`CLOSED|PICKUP_ONLY|PICKUP_AND_DELIVERY`), `serviceModeLabel` ("Closed" / "Pickup only" / "Pickup & delivery"), `pickupAvailable`, `deliveryAvailable` (mode-aware; delivery also requires the customer to be inside the delivery radius), and `inDeliveryRange` (radius + delivery capability ignoring the mode). A CLOSED store has `isOpen:false`, `status.reason:"CLOSED"`, `canSchedule:false`, no slots.
* Search filter `fulfilment=pickup` returns only stores where pickup is orderable now (excludes CLOSED); `fulfilment=delivery` returns only stores where delivery is orderable now at the given lat/lng (excludes PICKUP_ONLY and CLOSED, respects delivery radius). `pickupOnly=true` is kept as an alias of `fulfilment=pickup`. Without the filter CLOSED stores are always sorted last.
* `GET /customer/cart` → `restaurant` also has `serviceMode, serviceModeLabel, deliveryAvailable, pickupAvailable`.
* `POST /customer/checkout/quote` response includes `availableFulfilment: {serviceMode, serviceModeLabel, pickup, delivery, platformDelivery, ownDelivery}`. Errors (400): CLOSED -> "This store is closed right now and is not taking orders"; DELIVERY at a PICKUP_ONLY store -> "This store is pickup only right now. Delivery is unavailable, but you can still order for pickup." The same rules apply to `POST /customer/orders`.

## Ratings given to customers (staff only)
`GET /admin/customers/:id` `profile` also carries `ratingAvg`, `ratingCount`, `lowRatingCount30d`; safety flags `SAFETY_CONCERN` / `LOW_RATING_PATTERN` appear in `profile.flags`. Support can read the feedback on a disputed order with `GET /admin/ratings/orders/:orderId/customer-feedback` (support:view). Policy: [../ratings.md](../ratings.md).
