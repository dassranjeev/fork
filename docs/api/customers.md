# CustomersModule API

Base: `/api/v1`. Customer routes need a CUSTOMER JWT (guest tokens from `/public/guest/session` work too). Admin routes need STAFF with `customers:<action>`. List responses: `{ data, meta:{page,limit,total,totalPages} }`. Errors: `{statusCode,message,details?}`.

## Admin (`/admin/customers`)
| Method | Path | Permission | Request | Response |
|---|---|---|---|---|
| GET | `/admin/customers` | customers:view | page,limit,search (name/email/phone),sortBy(createdAt,totalOrders,lifetimeSpend,lastOrderAt),sortDir,blocked=true/false,fraudFlag=true/false | list of `{id,name,email,phone,status,totalOrders,lifetimeSpend,walletBalance,isBlocked,fraudFlag,flags[],lastOrderAt,createdAt}` |
| GET | `/admin/customers/:id` | view | - | user fields + `profile{dietaryPreferences,allergens,walletBalance,referralCode,consents,isBlocked,blockReason,fraudFlag,flags,totalOrders,lifetimeSpend,lastOrderAt,internalNotes,deletionRequestedAt}`, `addressCount`, `recentOrders[]`, `refundStats` |
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
| GET/POST | `/customer/addresses` | POST `{label,line1,line2,city,province,postalCode,lat,lng,dropoffNotes,isDefault}` | Address[] / Address |
| PATCH/DELETE | `/customer/addresses/:id` | partial address | Address / `{ok}` |
| POST | `/customer/addresses/:id/default` | - | Address[] |
| GET | `/customer/favorites` | lat,lng | `{data: RestaurantCard[]}` |
| POST/DELETE | `/customer/favorites/:restaurantId` | - | `{ok,isFavorite}` |
| GET | `/customer/cards` | - | `{data:[{id,brand,last4,expMonth,expYear,isDefault}]}` |
| POST | `/customer/cards/setup-intent` | - | `{clientSecret}` |
| DELETE | `/customer/cards/:id` | - | `{ok}` |
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
| POST | `/customer/orders` | quote fields + `{paymentMethod, paymentToken?, giftCardCode? (redeemed to wallet first), contactless, customerNotes}` | Order (cart cleared) |
| GET | `/customer/orders` | page,limit,status | paginated own orders |
| GET | `/customer/orders/:id` | - | Order with items |
| POST | `/customer/orders/:id/cancel` | `{reason}` | Order |
| POST | `/customer/orders/:id/reorder` | - | `{cart, skipped[{name,reason}]}` |
| PATCH | `/customer/orders/:id/tip` | `{tip}` | Order |
| POST | `/customer/orders/:id/item-removal-response` | `{approve}` | Order |
| POST | `/customer/orders/:id/review` | `{restaurantRating 1-5, driverRating, restaurantTags[], driverTags[], comment, driverComment}` (delivered orders; emits `review.created`) | Review |

Live tracking and chat: shared `GET /orders/:id/tracking`, `/orders/:id/messages` (Orders module).

### Discovery (same under `/customer/*` personalised, and `/public/*` anonymous)
| Method | Path | Query | Response |
|---|---|---|---|
| GET | `/customer|public/home` | lat,lng | `{location,banners,cuisines,nearby,pickupOnly,popular,new,deals,fastest,favorites,promotions,counts}`. `pickupOnly` = stores currently in PICKUP_ONLY mode (not in the delivery lists). CLOSED stores that normally deliver to the location stay in the lists but are shown closed and sorted after open ones |
| GET | `/customer|public/search` | q,lat,lng,type(restaurants/dishes/cuisines),priceLevel(csv),minRating,maxFee,maxEta,dietary(csv),excludeAllergens(csv),cuisine(slugs csv),pickupOnly,`fulfilment`(pickup/delivery),openNow,sort(relevance/distance/rating/eta/fee/price_low/price_high/popular),page,limit | `{query,restaurants,dishes,cuisines,meta}` |
| GET | `/customer|public/restaurants/:slugOrId` | lat,lng | `{restaurant{...card,hours,schedule,fulfilment},promos,menu{categories,popular},reviews}` |
| GET | `/customer|public/restaurants/:slug/reviews` | page,limit | `{summary,data,meta}` |
| GET | `/customer|public/restaurants/:slug/slots` | date=YYYY-MM-DD | `{date,enabled,slotMinutes,timezone,slots[{startsAt,label,capacity,booked,available}]}` |
| POST | `/public/guest/session` | `{email,phone?,firstName?,lastName?}` | login tokens + `guest:true` (409 `ACCOUNT_EXISTS` / `GUEST_EMAIL_IN_USE`) |

Events: emits `review.created`. Settings used: `customers.guestCheckoutEnabled`, `customers.walletAdjustApprovalThreshold`, `payments.giftCardsEnabled`, `compliance.dataRequestDays`, `security.refundFrequencyLimit30d`.

### Service mode on restaurant cards / pages / cart / quote
Every `RestaurantCard` (home, search, favorites, restaurant page) now has `serviceMode` (`CLOSED|PICKUP_ONLY|PICKUP_AND_DELIVERY`), `serviceModeLabel` ("Closed" / "Pickup only" / "Pickup & delivery"), `pickupAvailable`, `deliveryAvailable` (mode-aware; delivery also requires the customer to be inside the delivery radius), and `inDeliveryRange` (radius + delivery capability ignoring the mode). A CLOSED store has `isOpen:false`, `status.reason:"CLOSED"`, `canSchedule:false`, no slots.
* Search filter `fulfilment=pickup` returns only stores where pickup is orderable now (excludes CLOSED); `fulfilment=delivery` returns only stores where delivery is orderable now at the given lat/lng (excludes PICKUP_ONLY and CLOSED, respects delivery radius). `pickupOnly=true` is kept as an alias of `fulfilment=pickup`. Without the filter CLOSED stores are always sorted last.
* `GET /customer/cart` → `restaurant` also has `serviceMode, serviceModeLabel, deliveryAvailable, pickupAvailable`.
* `POST /customer/checkout/quote` response includes `availableFulfilment: {serviceMode, serviceModeLabel, pickup, delivery, platformDelivery, ownDelivery}`. Errors (400): CLOSED -> "This store is closed right now and is not taking orders"; DELIVERY at a PICKUP_ONLY store -> "This store is pickup only right now. Delivery is unavailable, but you can still order for pickup." The same rules apply to `POST /customer/orders`.
