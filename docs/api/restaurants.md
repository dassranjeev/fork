# Restaurants API

`RestaurantsModule` (`src/restaurants/`). Admin routes under `/api/v1/admin/restaurants`, portal routes under `/api/v1/restaurant/*`. Every portal route accepts an optional `?restaurantId=` query param; it defaults to the caller's only location and is required (and access-checked) when an OWNER has several locations.

Enums the UI needs: `RestaurantStatus` = APPLIED, DOCS_REVIEW, MENU_SETUP, TEST_ORDER, LIVE, PAUSED, SUSPENDED, REJECTED. `RestaurantRole` = OWNER, LOCATION_MANAGER, CASHIER, KITCHEN. `RestaurantDocType` = BUSINESS_LICENCE, HEALTH_CERTIFICATE, VOID_CHEQUE, HST_CERTIFICATE, AGREEMENT, MENU, PHOTOS, OTHER. `DocStatus` = PENDING, APPROVED, REJECTED, EXPIRED. `DayPart` = BREAKFAST, LUNCH, DINNER, LATE_NIGHT. Order/KDS statuses reuse `OrderStatus` from the Orders API doc; `OrderItem.kitchenStatus` = NEW, PREPARING, READY.

Realtime events emitted (see `src/realtime/realtime.module.ts`): `restaurant.status` / `order.new` / `order.status` / `store.updated` (ops + `restaurant:{id}` rooms) whenever status, busy mode or accepting-orders changes. Domain event `Events.RESTAURANT_STATUS_CHANGED` fires on every lifecycle transition (go-live/pause/suspend/reactivate/reject) for other modules (e.g. Analytics) to react to.

## Admin - merchants (`/api/v1/admin/restaurants/merchants`)

| Method & path | Permission | Body / query | Response |
|---|---|---|---|
| GET `/merchants` | restaurants:view | `PageQueryDto` + `hasLocations` | `{data:Merchant[], meta}` |
| GET `/merchants/:id` | restaurants:view | - | `Merchant & {locations:[{id,name,status,city}]}` |
| POST `/merchants` | restaurants:create | `MerchantDto` | `Merchant` |
| PATCH `/merchants/:id` | restaurants:edit | `UpdateMerchantDto` | `Merchant` |

## Admin - restaurants (`/api/v1/admin/restaurants`)

| Method & path | Permission | Body / query | Response |
|---|---|---|---|
| GET `/` | restaurants:view | `RestaurantsQuery` (search, status, city, cityId, zoneId, cuisineId/cuisine, merchantId, minRating, maxRating, commissionTierId, hasExpiringDocs, expiringDays) | `{data:Restaurant[], meta}` |
| POST `/` | restaurants:create | `CreateRestaurantDto` (name + either `merchantId` or `merchant:MerchantDto`, optional `owner:OwnerDto` to create the OWNER login, address/lat/lng/cuisineIds/commissionTierId) | `{restaurant, temporaryPassword?}` |
| GET `/:id` | restaurants:view | - | full restaurant view (profile, hours, closures, stations, integrations, documents, openStatus) |
| PATCH `/:id` | restaurants:edit | `AdminUpdateRestaurantDto` (profile fields + slug/province/hstNumber/isFeatured/isNew/payoutSchedule/reliabilityScore/kdsEnabled/merchantId) | restaurant view |
| GET `/:id/stats` | restaurants:view | `?from&to&days` | orders/completed/rejected/cancelled/acceptanceRate/cancellationRate/prepAccuracy/avgPrepMinutes/errorRate/sales/avgOrderValue/avgRating/reliabilityScore |
| GET `/:id/menu` | restaurants:view | - | menu tree (see Portal - menu) |

### Onboarding pipeline (SOP-01)

| Method & path | Permission | Body | Response / effect |
|---|---|---|---|
| GET `/:id/documents` | restaurants:view | - | `RestaurantDocument[]` |
| GET `/:id/documents/checklist` | restaurants:view | - | `{items:[{type,required,status,docId,expiresAt,rejectReason}], allApproved, approved, total}` |
| POST `/:id/documents/:docId/approve` | restaurants:approve | `ApproveDocDto{expiresAt?}` | doc -> APPROVED |
| POST `/:id/documents/:docId/reject` | restaurants:approve | `RejectDocDto{reason}` | doc -> REJECTED, owner notified |
| POST `/:id/docs-review/approve` | restaurants:approve | - | requires all required docs APPROVED; APPLIED/DOCS_REVIEW -> MENU_SETUP |
| PATCH `/:id/commission` | restaurants:edit | `CommissionDto{commissionTierId?, deliveryCommissionPct?, pickupCommissionPct?, ownDriverCommissionPct?}` | restaurant view |
| PATCH `/:id/location` | restaurants:edit | `LocationDto{lat, lng, zoneId?, addressLine1?, city?, postalCode?}` (zone auto-resolved from lat/lng via `GeoService` when `zoneId` omitted) | restaurant view |
| POST `/:id/agreement` | restaurants:edit | `AgreementDto{signedBy, signedAt?, documentUrl?, notes?}` | `{agreementSignedAt, agreementSignedBy}`; e-signs the merchant, optionally stores an AGREEMENT document |
| POST `/:id/menu-review` | restaurants:approve | `MenuReviewDto{approved?, notes?}` | approved:true (needs >=1 active item) MENU_SETUP -> TEST_ORDER; else stays with notes and owner is notified of requested changes |
| POST `/:id/test-order` | restaurants:edit | `TestOrderDto{action:'request'|'complete', orderId?, notes?}` | records `meta.testOrder`; owner notified on request |
| POST `/:id/go-live` | restaurants:approve | `OptionalReasonDto{reason?, force?}` | checks docs/commission/zone/menu/test-order unless `force:true` (super admin escape hatch); -> LIVE, `acceptingOrders:true` |
| POST `/:id/pause` | restaurants:edit | `ReasonDto{reason, resumeAfterHours?}` | LIVE -> PAUSED (auto-reactivates after `resumeAfterHours` via a minute-cron if given) |
| POST `/:id/suspend` | restaurants:edit | `ReasonDto{reason}` | -> SUSPENDED |
| POST `/:id/reactivate` | restaurants:edit | `OptionalReasonDto{reason?}` | PAUSED/SUSPENDED -> LIVE |
| POST `/:id/reject` | restaurants:approve | `ReasonDto{reason}` | any pre-live status -> REJECTED |
| POST `/bulk` | restaurants:edit | `BulkDto{restaurantIds, action:'pause'|'reactivate'|'suspend'|'apply-tier', reason?, commissionTierId?}` | `{ok, count, results:[{id, ok, error?}]}` |

### Members / hours / stations / tablet / integrations (admin oversight)

| Method & path | Permission | Body | Response |
|---|---|---|---|
| GET `/:id/members` | restaurants:view | - | member list (id, userId, role, active, restaurantId, restaurantName, name/email/phone, lastLoginAt) |
| POST `/:id/members` | restaurants:create | `MemberDto{firstName,lastName,email,phone?,role,restaurantId?,password?}` | `{member, temporaryPassword?}` |
| PATCH `/:id/members/:memberId` | restaurants:edit | `UpdateMemberDto` | member |
| DELETE `/:id/members/:memberId` | restaurants:edit | - | member (deactivated, not hard-deleted) |
| POST `/:id/members/:memberId/reset-password` | restaurants:edit | - | `{temporaryPassword}` |
| GET / PATCH `/:id/hours` | restaurants:view / edit | `HoursDto{hours:[{dayOfWeek,openTime,closeTime,closed}]}` | `RestaurantHours[]` |
| GET / POST `/:id/closures` | restaurants:view / edit | `ClosureDto{startDate,endDate,closed?,openTime?,closeTime?,reason?}` | `RestaurantClosure[]` / created row |
| DELETE `/:id/closures/:closureId` | restaurants:edit | - | `{ok}` |
| GET / POST `/:id/stations` | restaurants:view / edit | `StationDto{name,sortOrder?}` | `KitchenStation[]` / row |
| PATCH / DELETE `/:id/stations/:stationId` | restaurants:edit | `Partial<StationDto>` | row / `{ok}` |
| POST `/:id/tablet/issue-code` | restaurants:edit | - | `{tabletCode, tabletActivated:false}` |
| GET / POST `/:id/integrations` | restaurants:view / edit | `IntegrationDto{provider,status?,config?}` | `RestaurantIntegration[]` / row |
| PATCH / DELETE `/:id/integrations/:integrationId` | restaurants:edit | `UpdateIntegrationDto{status?,config?}` | row / `{ok}` |

### Open restaurant panel (impersonation)

| Method & path | Permission | Response |
|---|---|---|
| POST `/:id/impersonate` | `restaurants:edit` (SUPER_ADMIN always) | `{accessToken, expiresIn (7200s), restaurantId, restaurantName, user, impersonatedBy}` |

Requires `restaurants:approve`. Issues a short-lived (1 h) access token, **no refresh token**, for the restaurant's active OWNER member (fallback: any active member of the merchant / that location). `400` if the restaurant has no active member, `404` if unknown. The JWT carries `imp` = admin user id; `AuthUser.impersonatedBy` is set, `GET /auth/me` returns it, and audit rows written during the session record `actorRole = "<role> [impersonated by <adminId>]"`. Start is audited as `restaurant.impersonate` (entity `Restaurant`, actor = the admin, `after` = target user/role). Routes marked `@NoImpersonation()` answer `403`: `/auth/change-password`, `/auth/2fa/{setup,enable,disable}`, `/auth/logout-all`, `PATCH /auth/me`, `POST /restaurant/staff/:id/reset-password`, restaurant staff create/update/delete and the bank-detail routes. The admin console keeps this token per browser tab (sessionStorage) and shows an "Exit to admin console" banner.

### Reviews moderation

| Method & path | Permission | Body / query | Response |
|---|---|---|---|
| GET `/reviews` | restaurants:view | `ReviewsQuery{restaurantId?,status?,maxRating?,replied?}` + paging | `{data, meta}` (all restaurants unless `restaurantId` given) |
| POST `/reviews/:reviewId/moderate` | restaurants:approve | `ModerateReviewDto{status:'VISIBLE'|'HIDDEN'|'FLAGGED', reason?}` | review row; restaurant rating aggregate recomputed |

## Portal - `/api/v1/restaurant/dashboard` (all roles)

| Method & path | Role | Response |
|---|---|---|
| GET `/` | any | `{restaurant:{id,name,status,acceptingOrders,serviceMode,serviceModeLabel,serviceModeUpdatedAt,serviceModeResumeAt,pickupAvailable,deliveryAvailable,pausedUntil,busyExtraPrepMin,rating,ratingCount,reliabilityScore,kdsEnabled,tabletActivated}, open:{open,reason?,opensAt?,closesAt?}, today:{orders,sales,pendingAccept,inKitchen,ready,late}, documentChecklist}` |

## Portal - `/api/v1/restaurant/store`

| Method & path | Role | Body | Response |
|---|---|---|---|
| GET `/` | any | - | full store view (profile, hours, closures, stations, integrations, documents, printers, notificationSettings, kdsSettings, tablet) |
| PATCH `/` | OWNER, LOCATION_MANAGER | `UpdateStoreDto` | store view |
| PATCH `/fulfilment` | OWNER, LOCATION_MANAGER | `FulfilmentDto` (delivery/ownDelivery/pickup/scheduled/dineIn toggles, prep times, radius, minimum order, slots, autoRejectSeconds) | store view |
| GET `/hours` | any | - | `RestaurantHours[]` |
| PATCH `/hours` | OWNER, LOCATION_MANAGER | `HoursDto` | `RestaurantHours[]` |
| GET `/closures` | any | - | `RestaurantClosure[]` |
| POST `/closures` | OWNER, LOCATION_MANAGER | `ClosureDto` | row |
| DELETE `/closures/:closureId` | OWNER, LOCATION_MANAGER | - | `{ok}` |
| GET `/stations` | any | - | `KitchenStation[]` |
| POST `/stations` | OWNER, LOCATION_MANAGER | `StationDto` | row |
| PATCH / DELETE `/stations/:stationId` | OWNER, LOCATION_MANAGER | `Partial<StationDto>` | row / `{ok}` |
| POST `/busy` | OWNER, LOCATION_MANAGER, CASHIER | `BusyModeDto{extraPrepMin?, pauseMinutes?}` | `{busyExtraPrepMin, pausedUntil, acceptingOrders}` |
| POST `/busy/clear` | OWNER, LOCATION_MANAGER, CASHIER | - | same shape, cleared |
| PATCH `/accepting` | OWNER, LOCATION_MANAGER, CASHIER | `AcceptingDto{accepting}` | `{acceptingOrders, serviceMode,...}` (only while LIVE). Legacy switch, kept coherent: `accepting:false` == service mode `CLOSED`; `accepting:true` from CLOSED == `PICKUP_AND_DELIVERY` |
| PATCH `/service-mode` | OWNER, LOCATION_MANAGER, CASHIER (not KITCHEN) | `ServiceModeDto{mode: CLOSED|PICKUP_ONLY|PICKUP_AND_DELIVERY, resumeAt?: ISO date}` (`?restaurantId=` for multi-location users) | `{id, serviceMode, serviceModeLabel, serviceModeUpdatedAt, serviceModeResumeAt, pickupAvailable, deliveryAvailable, openOrders}`. Audited (`restaurant.service_mode`, actor + before/after), emits `store.updated` (restaurant room + ops) and domain event `Events.RESTAURANT_SERVICE_MODE_CHANGED`. `resumeAt` (max 14 days, only with CLOSED / PICKUP_ONLY) auto-switches back to PICKUP_AND_DELIVERY (cron, every minute). |
| PATCH `/printers` | OWNER, LOCATION_MANAGER | `PrinterSettingsDto` | `{receiptPrinterEnabled,kitchenPrinterEnabled,config}` |
| PATCH `/notifications` | OWNER, LOCATION_MANAGER | `NotificationSettingsDto{settings}` | settings object |
| PATCH `/kds` | OWNER, LOCATION_MANAGER | `KdsSettingsDto{largeFont?,soundOn?,recentPickedUpMinutes?,autoLoadPrep?,capacityTickets?}` | settings object |
| POST `/tablet/issue-code` | OWNER, LOCATION_MANAGER | - | `{tabletCode, tabletActivated:false}` |
| POST `/tablet/activate` | any | `TabletActivateDto{code, deviceId?}` | `{tabletActivated:true}` |
| POST `/tablet/heartbeat` | any | `TabletHeartbeatDto{deviceId?,appVersion?,battery?,network?,queuedActions?}` | `{serverTime, pendingOrders, inKitchen, config:{...}}` |
| GET / POST `/integrations` | OWNER, LOCATION_MANAGER | `IntegrationDto` | `RestaurantIntegration[]` / row |
| PATCH / DELETE `/integrations/:integrationId` | OWNER, LOCATION_MANAGER | `UpdateIntegrationDto` | row / `{ok}` |
| GET `/documents` | OWNER, LOCATION_MANAGER | - | `RestaurantDocument[]` |
| POST `/documents` | OWNER, LOCATION_MANAGER | `DocumentUploadDto{type,fileUrl,fileName?,expiresAt?}` (upload the file first via `POST /uploads`) | doc row; APPLIED -> DOCS_REVIEW on first upload |
| GET `/documents/checklist` | OWNER, LOCATION_MANAGER | - | checklist (see admin) |

## Portal - `/api/v1/restaurant/menu`

| Method & path | Role | Body | Response |
|---|---|---|---|
| GET `/` | any | `?includeInactive=false` | `{categories:[{...,items}], uncategorized, combos, modifierGroups, stations, counts}` |
| POST `/categories` | managers* | `CategoryDto` | row |
| PATCH `/categories/reorder` | managers | `ReorderDto{ids}` | `{ok}` |
| PATCH `/categories/:id` | managers | `UpdateCategoryDto` | row |
| DELETE `/categories/:id` | managers | `?moveItemsTo=categoryId` | `{ok}` |
| POST `/items` | managers | `ItemDto` (price, pickupPrice, taxClassCode, allergens, dietaryTags, dayparts, isCombo/comboItems, stationId, prepTimeMin, groupIds...) | item + modifierGroups |
| PATCH `/items/reorder` | managers | `ReorderDto` | `{ok}` |
| GET `/items/:id` | any | - | item + modifierGroups |
| PATCH `/items/:id` | managers | `UpdateItemDto` | item |
| DELETE `/items/:id` | managers | - | `{ok}` |
| POST `/items/:id/groups` | managers | `SetGroupsDto{groupIds}` | item |
| POST `/items/:id/86` | managers, CASHIER, KITCHEN | `EightySixDto{restockAt?,untilTomorrow?,hours?}` | item (available:false) |
| POST `/items/:id/restock` | managers, CASHIER, KITCHEN | - | item (available:true) |
| POST `/groups` | managers | `ModifierGroupDto{name,required?,minSelect?,maxSelect?,options?,itemIds?}` | group + options |
| GET `/groups/:id` | any | - | group + options + itemIds |
| PATCH `/groups/:id` | managers | `UpdateGroupDto` | group |
| DELETE `/groups/:id` | managers | - | `{ok}` |
| POST / DELETE `/groups/:id/items/:itemId` | managers | - | attach / detach |
| POST `/groups/:id/options` | managers | `ModifierOptionDto{name,priceDelta?,isDefault?,available?}` | option |
| PATCH `/options/:id` | managers | `UpdateOptionDto` | option |
| DELETE `/options/:id` | managers | - | `{ok}` |
| POST `/options/:id/86` \| `/restock` | managers, CASHIER, KITCHEN | `EightySixDto` | option |
| GET `/prep-targets` | any | - | `[{id,name,prepTimeMin,stationId,categoryId}]` |
| POST `/prep-targets` | managers | `PrepTargetsDto{targets:[{itemId,prepTimeMin}]}` | `{ok,updated}` |
| GET `/csv` | any | - | `{csv}` (RFC4180, header in `MENU_CSV_HEADER`) |
| POST `/csv` | managers | `CsvImportDto{csv, mode:'merge'|'replace'}` | `{ok,created,updated,total,mode}` (400 with per-row `details` on validation errors) |

\* managers = OWNER, LOCATION_MANAGER.

## Portal - `/api/v1/restaurant/orders`

| Method & path | Role | Body | Response |
|---|---|---|---|
| GET `/` | any | `OrdersQuery{status?,type?,from?,to?}` + paging | paginated `Order[]` (defaults to open/live orders when no status/date filter given) |
| GET `/:id` | any | - | `{order, timeline}` |
| POST `/:id/accept` | any | `AcceptOrderDto{prepTimeMin?, addMinutes?:0|5|10|15}` | order -> ACCEPTED, `estimatedReadyAt` recomputed |
| POST `/:id/reject` | any | `RejectOrderDto{reason:'BUSY'|'ITEM_UNAVAILABLE'|'CLOSING'|'OTHER', note?}` | order -> REJECTED, payment released |
| POST `/:id/ready` | any | - | order -> READY |
| POST `/:id/handoff` | any | `HandoffDto{code}` | order -> PICKED_UP (delivery) or COLLECTED (pickup); code checked against pickup code |
| POST `/:id/items/:itemId/remove` | any | `RemoveItemDto{reason?}` | order item removed -> customer approval + partial refund flow (`OrdersService.removeItem`) |
| POST `/:id/extend-prep` | any | `ExtendPrepDto{addMinutes}` | order `estimatedReadyAt`/`estimatedDeliveryAt` pushed back |

All order actions go through `OrdersService.transition` / `removeItem` / `setEta` (single source of truth for the state machine); this module never re-implements the transition rules.

## Portal - `/api/v1/restaurant/kds`

| Method & path | Role | Body | Response |
|---|---|---|---|
| GET `/board` | any | `?stationId=` | `{columns:{NEW,PREPARING,READY,PICKED_UP}:[{id,code,status,fulfilment,acceptedAt,estimatedReadyAt,elapsedMin,dueInMin,items}], capacityTickets, load, generatedAt}` |
| POST `/:id/start` | any | - | ACCEPTED/DRIVER_ASSIGNED -> PREPARING; item tickets NEW -> PREPARING |
| POST `/bump` | any | `BumpDto{stationId?}` | station's PREPARING item tickets -> READY; `{ok,bumped}` |
| POST `/:id/ready` | any | - | order -> READY (all item tickets -> READY) |
| POST `/items/:itemId/status` | any | `ItemStatusDto{status:'NEW'|'PREPARING'|'READY'}` | order (with updated item) |
| POST `/sync` | any | `KdsSyncDto{ops:[{opId?,op:'start'|'bump'|'ready'|'item',orderId,stationId?,itemId?,status?}]}` | `{ok, results:[{opId,ok,error?}]}` - offline queue replay, each op idempotent |

`load` = tickets in PREPARING / `capacityTickets` (from `/store` KDS settings) - drives the kitchen load indicator; `elapsedMin`/`dueInMin` drive colour timers.

## Portal - `/api/v1/restaurant/staff` (OWNER, LOCATION_MANAGER only)

| Method & path | Body / query | Response |
|---|---|---|
| GET `/` | `?restaurantId=` | member list (OWNER sees the whole merchant; LOCATION_MANAGER is scoped to their location) |
| POST `/` | `MemberDto{firstName,lastName,email,phone?,role,restaurantId?,password?}` (LOCATION_MANAGER may only create CASHIER/KITCHEN at their own location) | `{member, temporaryPassword?}` |
| PATCH `/:id` | `UpdateMemberDto` | member |
| DELETE `/:id` | - | member (deactivated) |
| POST `/:id/reset-password` | - | `{temporaryPassword}` |

## Portal - `/api/v1/restaurant/reviews` (OWNER, LOCATION_MANAGER only)

| Method & path | Body / query | Response |
|---|---|---|
| GET `/` | `ReviewsQuery{status?,maxRating?,replied?}` + paging | `{data, meta}` (scoped to the caller's locations) |
| POST `/:id/reply` | `ReplyDto{reply}` | review row; customer notified |

## Notes / deferrals

* `seedRestaurants` in `src/restaurants/restaurants.seed.ts` is left as the pre-existing stub - implementing 10+ demo restaurants with rich menus, hours and one 2-location merchant was out of scope for this pass (not part of the three-step task given) and is a substantial standalone effort; flagging so it can be picked up separately before the seed pipeline (`src/database/seed.ts`) is exercised end-to-end.
* Restaurant self-serve sales/ratings/promo reports (`/restaurant/reports/*`) are owned by `AnalyticsModule` per ARCHITECTURE.md and are intentionally not duplicated here; this module's `/restaurant/dashboard` only covers today's order snapshot + open status.
* POS integrations are config-only (connect/disconnect + provider config JSON), matching the "Phase 3" scope noted on `RestaurantIntegration`.

## Service mode (CLOSED / PICKUP_ONLY / PICKUP_AND_DELIVERY)

Every store (restaurant or convenience store) has a `serviceMode` (`Restaurant.serviceMode`, default `PICKUP_AND_DELIVERY`, plus `serviceModeUpdatedAt`, optional `serviceModeResumeAt`). It is the single source of truth for "which fulfilment types can a customer use right now"; the admin-configured capability flags remain an upper bound. Helper: `fulfilmentAvailability()` in `src/common/service-mode.ts`.

| Mode | Pickup orders | Delivery orders | Drivers |
|---|---|---|---|
| `CLOSED` | rejected (400 "This store is closed right now and is not taking orders"), also scheduled orders | rejected | none dispatched |
| `PICKUP_ONLY` | allowed if `pickupEnabled` | rejected (400 "This store is pickup only right now. Delivery is unavailable, but you can still order for pickup.") | none dispatched (no new delivery orders) |
| `PICKUP_AND_DELIVERY` | allowed if `pickupEnabled` | allowed if `deliveryEnabled` (platform drivers) or `ownDeliveryEnabled` (own drivers) | normal dispatch |

* Effective delivery = mode is PICKUP_AND_DELIVERY AND (`deliveryEnabled` OR `ownDeliveryEnabled`); effective pickup = mode is PICKUP_ONLY or PICKUP_AND_DELIVERY AND `pickupEnabled`. Only `status = LIVE` stores are orderable at all.
* `CLOSED` also sets `acceptingOrders=false`; the other modes set `acceptingOrders=true` and clear `pausedUntil`. `AvailabilityService.status()` reports `reason: 'CLOSED'`.
* Enforcement is in `PricingService.quote` (which `OrdersService.placeOrder` always calls), so the checkout quote and placing an order are rejected identically. The mode is checked at the moment of quoting / placing, also for scheduled orders (no per-slot mode history).
* Orders already placed keep their original fulfilment and continue normally when the mode changes (a delivery order placed earlier is still accepted, dispatched and delivered after the store goes PICKUP_ONLY or CLOSED). Dispatch only ever happens for `fulfilment = PLATFORM_DRIVER`, so pickup orders never create driver offers.
* Admin: `PATCH /admin/restaurants/:id/service-mode` (restaurants:edit, audited) with the same body; `GET /admin/restaurants` rows and the detail view include `serviceMode`.
* Realtime: `store.updated` carries `serviceMode, serviceModeLabel, pickupAvailable, deliveryAvailable, serviceModeResumeAt, changedBy`.
