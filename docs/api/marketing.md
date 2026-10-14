# Marketing module API (`src/marketing/`)

All admin routes are under `/api/v1/admin/...`, require a JWT for `STAFF` or `SUPER_ADMIN`, and the listed
`@Permission(Module.X, Action.Y)` (SUPER_ADMIN bypasses the permission check). Restaurant portal routes are
under `/api/v1/restaurant/...` (OWNER / LOCATION_MANAGER only for promotions). Public routes are under
`/api/v1/public/...` and need no auth. Every mutating admin call is written to `AuditService` (`AuditLog`).

Enums: `Action = view|create|edit|delete|approve|export`. `Module` values used here: `promotions`, `content`,
`notifications`. `PromoType = PERCENT|FIXED|FREE_DELIVERY|BOGO|FREE_ITEM`. `FundedBy = PLATFORM|RESTAURANT`.
`NotificationChannel = PUSH|SMS|EMAIL|IN_APP`.

**Contract note**: `PromotionsService` (`src/marketing/promotions.service.ts`) implements `IPromotionsService`
and `GiftCardsService` (`src/marketing/gift-cards.service.ts`) implements `IGiftCardsService`
(`src/common/contracts.ts`). Other modules resolve them by exact class name via `lazyProvider` /
`ModuleRef.get(token, { strict: false })` — do not rename or move these files.

## Promotions (admin) — `admin/promotions` (`Module.PROMOTIONS`)

| Method & path | Permission | Body / query | Response |
|---|---|---|---|
| `GET /admin/promotions` | view | `PageQueryDto` + `status?, type?, fundedBy?, restaurantId?, batchId?, hasCode?` | `{data:Promotion[+status,restaurantName], meta}` |
| `GET /admin/promotions/overview` | view | - | `{activePromotions, pendingApproval, totalBudgetSpent, redemptions, totalDiscount}` |
| `GET /admin/promotions/approvals` | view | `PageQueryDto` | `{data:Promotion[+restaurantName] (pendingApproval=true), meta}` |
| `GET /admin/promotions/redemptions` | view | `PageQueryDto` + `promotionId?` | `{data:[{id,promotionId,promotionName,promotionCode,customerId,customerName,orderId,orderCode,discount,createdAt}], meta}` |
| `POST /admin/promotions/batch` | create | `PromotionDto` + `{prefix, count}` | `{batchId, count, codes:string[]}` |
| `POST /admin/promotions` | create | `PromotionDto` (code?, name, description?, type, value?, maxDiscount?, minSubtotal?, fundedBy?, restaurantId?, cityId?, zoneIds?, menuItemId?, orderTypes?, startsAt?, endsAt?, usageLimit?, perUserLimit?, firstOrderOnly?, autoApply?, active?, budget?) | created `Promotion` |
| `GET /admin/promotions/:id` | view | - | `Promotion & {status, restaurantName}` |
| `PATCH /admin/promotions/:id` | edit | `UpdatePromotionDto` (all optional) | updated `Promotion` |
| `DELETE /admin/promotions/:id` | delete | - | `{deleted, deactivated}` (soft-deactivates if it has redemptions) |
| `POST /admin/promotions/:id/duplicate` | create | - | new draft `Promotion` (copy, inactive) |
| `POST /admin/promotions/:id/activate` \| `/deactivate` | edit | - | updated `Promotion` |
| `GET /admin/promotions/:id/stats` | view | - | `{promotionId, redemptions, uniqueCustomers, usedCount, usageLimit, discountSpent, discountByFunder:{platform,restaurant}, budget, budgetRemaining, orders, revenue, incrementalOrders, incrementalRevenue, avgDiscountPerOrder, roi}` |
| `GET /admin/promotions/:id/redemptions` | view | `PageQueryDto` | same shape as top-level redemptions, scoped to the promo |
| `POST /admin/promotions/:id/approve` | approve | - | activates a restaurant self-serve promo |
| `POST /admin/promotions/:id/reject` | approve | `{reason}` | rejects it (deactivated, `rejectionReason` set) |

`status` (derived, not stored): `ACTIVE | INACTIVE | SCHEDULED | EXPIRED | PENDING_APPROVAL | EXHAUSTED`.

## Restaurant self-serve promotions — `restaurant/promotions` (roles: OWNER, LOCATION_MANAGER)

| Method & path | Body / query | Response |
|---|---|---|
| `GET /restaurant/promotions` | `PageQueryDto` + `restaurantId?, status?` | `{data:Promotion[+status], meta}` |
| `POST /restaurant/promotions` | `RestaurantPromotionDto`: `restaurantId?` (required if multi-location), `name`, `description?`, `type: PERCENT\|BOGO\|FREE_ITEM\|FREE_DELIVERY`, `value?` (PERCENT), `maxDiscount?, minSubtotal?, menuItemId?` (FREE_ITEM/BOGO), `orderTypes?, startsAt?, endsAt?, usageLimit?, perUserLimit?, budget?, code?` | created promo (restaurant-funded); `active=false, pendingApproval=true` when setting `restaurant.selfServePromosNeedApproval` is on |
| `GET /restaurant/promotions/:id/stats` | - | same shape as admin stats |
| `POST /restaurant/promotions/:id/pause` \| `/resume` | - | updated promo (blocked while pending approval, or if FORKY rejected it) |
| `DELETE /restaurant/promotions/:id` | - | `{deleted, deactivated}` |

## Public deals — `public/deals`

| Method & path | Query | Response |
|---|---|---|
| `GET /public/deals` | `cityId?, zoneId?, limit?` | `DealView[]` — customer home "Deals" carousel (auto-apply + public code deals) |
| `GET /public/deals/restaurant/:restaurantId` | `cityId?, zoneId?` | `DealView[]` for one restaurant page |

`DealView`: `{id, code, name, description, type, value, maxDiscount, minSubtotal, fundedBy, restaurantId, menuItemId, autoApply, endsAt, badge}` (`badge` e.g. `"10% off"`, `"Free delivery"`).

## Gift cards (admin) — `admin/gift-cards` (`Module.PROMOTIONS`)

Customer-side redemption is `GiftCardsService.redeem(customerId, code)` (consumed by CustomersModule's
`/customer/wallet/gift-card` — not owned by this module).

| Method & path | Permission | Body / query | Response |
|---|---|---|---|
| `GET /admin/gift-cards` | view | `PageQueryDto` + `status?: ACTIVE\|REDEEMED\|VOID\|EXPIRED` | `{data:GiftCard[], meta}` |
| `GET /admin/gift-cards/stats` | view | - | `{issued, issuedAmount, activeCount, outstandingBalance, redeemedCount, redeemedAmount, voidCount, expiredBalance}` |
| `POST /admin/gift-cards` | create | `{amount, count? (1-500, default 1), expiresAt?, recipientEmail?` (only with count=1)`, message?}` | `{count, cards:GiftCard[]}`; emails the recipient when `recipientEmail` given |
| `POST /admin/gift-cards/:id/void` | edit | - | voided `GiftCard` |

## Banners — `admin/banners` (`Module.CONTENT`) / `public/banners`

| Method & path | Permission | Body / query | Response |
|---|---|---|---|
| `GET /admin/banners` | view | `PageQueryDto` + `placement?, cityId?, active?` | `{data:Banner[], meta}` |
| `GET /admin/banners/:id` | view | - | `Banner` |
| `POST /admin/banners` | create | `{title, subtitle?, imageUrl, link?, placement?, cityId?, sortOrder?, startsAt?, endsAt?, active?}` | created `Banner` |
| `PATCH /admin/banners/:id` | edit | any subset | updated `Banner` |
| `DELETE /admin/banners/:id` | delete | - | `{ok:true}` |
| `GET /public/banners` | - | `placement?, cityId?` | active `Banner[]` (city-scoped or global), ordered by `sortOrder` |

`placement`: `HOME|RESTAURANT_LIST|CHECKOUT|DRIVER_APP|RESTAURANT_PORTAL`. `link` format: `restaurant:<id>` \| `promo:<code>` \| `url:https://...`.

## CMS pages — `admin/cms-pages` (`Module.CONTENT`) / `public/cms`

| Method & path | Permission | Body / query | Response |
|---|---|---|---|
| `GET /admin/cms-pages` | view | `PageQueryDto` + `language?, category?, published?, slug?` | `{data:CmsPage[without body], meta}` |
| `GET /admin/cms-pages/:id` | view | - | `CmsPage & {translations:[{id,language,published}]}` |
| `POST /admin/cms-pages` | create | `{slug (kebab-case), language?, title, body, published?, category?}` | created `CmsPage` (409 if slug+language exists) |
| `PATCH /admin/cms-pages/:id` | edit | any subset | updated `CmsPage` |
| `POST /admin/cms-pages/:id/publish` \| `/unpublish` | edit | - | updated `CmsPage` |
| `DELETE /admin/cms-pages/:id` | delete | - | `{ok:true}` |
| `GET /public/cms` | - | `lang? (default en), category?` | `[{slug,language,title,category}]` published pages (footer links) |
| `GET /public/cms/:slug` | - | `lang? (default en)` | `{slug,language,title,body,category,updatedAt,availableLanguages}` (falls back to `en`) |

`category`: `LEGAL|HELP|MARKETING`. Seeded slugs: `terms, privacy, refund-policy, driver-agreement, merchant-agreement` (EN + FR for terms/privacy).

## FAQs — `admin/faqs` (`Module.CONTENT`) / `public/faqs`

| Method & path | Permission | Body / query | Response |
|---|---|---|---|
| `GET /admin/faqs` | view | `PageQueryDto` + `audience?, language?, category?, active?` | `{data:Faq[], meta}` |
| `GET /admin/faqs/:id` | view | - | `Faq` |
| `POST /admin/faqs` | create | `{question, answer, audience?, category?, language?, sortOrder?, active?}` | created `Faq` |
| `PATCH /admin/faqs/:id` | edit | any subset | updated `Faq` |
| `DELETE /admin/faqs/:id` | delete | - | `{ok:true}` |
| `GET /public/faqs` | - | `audience? (CUSTOMER\|DRIVER\|RESTAURANT), lang? (default en)` | `Faq[]` ordered by category, sortOrder (falls back to `en` if no rows in `lang`) |

## Notification templates — `admin/notification-templates` (`Module.CONTENT`)

| Method & path | Permission | Body / query | Response |
|---|---|---|---|
| `GET /admin/notification-templates` | view | `PageQueryDto` + `key?, channel?, language?, audience?, active?` | `{data:NotificationTemplate[], meta}` |
| `GET /admin/notification-templates/events` | view | - | `{events:[{event,audiences,variables}], sampleVars, channels, audiences, languages:['en','fr']}` — drives the template editor's variable chips |
| `POST /admin/notification-templates/preview` | view | `{subject?, body?, vars?}` | `{subject, body, vars}` rendered with sample (or supplied) vars |
| `GET /admin/notification-templates/:id` | view | - | `NotificationTemplate & {variables:string[]}` |
| `POST /admin/notification-templates` | create | `{key, channel, language?, audience?, subject?, body, active?}` | created (409 if key+channel+language+audience exists) |
| `PATCH /admin/notification-templates/:id` | edit | `{subject?, body?, active?}` | updated |
| `DELETE /admin/notification-templates/:id` | delete | - | `{ok:true}` |
| `POST /admin/notification-templates/:id/preview` | view | `{subject?, body?, vars?}` | rendered with sample vars, overridable |
| `POST /admin/notification-templates/:id/test-send` | edit | `{to, channel? (defaults to template channel: EMAIL\|SMS\|PUSH), vars?}` | `{ok, channel, to, subject, body}` |

`GET/PUT/PATCH admin/notification-matrix` (`Module.NOTIFICATIONS`) — unchanged (setting `notifications.matrix`, pre-existing).

## Campaigns — `admin/campaigns` (`Module.NOTIFICATIONS`)

Push / email / SMS blasts to an audience segment. CASL: for `CUSTOMER` audience on `EMAIL`/`SMS`, `notify()`
filters recipients by `CustomerProfile.marketingEmailConsent` / `marketingSmsConsent`, and the sent body has an
unsubscribe link appended. Sends reuse `NotificationsService.notify()` per recipient with `event: 'campaign.message'`.

| Method & path | Permission | Body / query | Response |
|---|---|---|---|
| `GET /admin/campaigns` | view | `PageQueryDto` + `status?, channel?, audience?` | `{data:Campaign[], meta}` |
| `POST /admin/campaigns/preview` | view | `{audience?, filters?}` (same shape as create) | `{estimatedRecipients}` |
| `GET /admin/campaigns/:id` | view | - | `Campaign` |
| `POST /admin/campaigns` | create | `{name, channel, subject?, body, audience? (CUSTOMERS\|DRIVERS\|RESTAURANTS, default CUSTOMERS), filters? ({cityId?,zoneId?,minOrders?,inactiveDays?}), scheduledAt?}` | created `Campaign`; `status=SCHEDULED` if `scheduledAt` given, else `DRAFT` |
| `PATCH /admin/campaigns/:id` | edit | any subset (blocked once `SENT`/`SENDING`) | updated `Campaign` |
| `DELETE /admin/campaigns/:id` | delete | - | `{ok:true}` (blocked once `SENT`/`SENDING`) |
| `POST /admin/campaigns/:id/send` | edit | - | sends immediately to every matching recipient; sets `status=SENT, sentAt, recipientCount, deliveredCount` |
| `POST /admin/campaigns/:id/cancel` | edit | - | only while `SCHEDULED` -> `status=CANCELLED` |

A minute-by-minute scheduler (`CampaignsService.runScheduled`, `@Cron(EVERY_MINUTE)`) fires any `SCHEDULED`
campaign whose `scheduledAt` has passed. `filters.cityId`/`zoneId` are applied for `DRIVERS` (via
`DriverProfile.cityId`/`zoneIds`) and `RESTAURANTS` (via the restaurant's `cityId`); for `CUSTOMERS` only
`minOrders`/`inactiveDays` are applied (no direct city/zone column on `CustomerProfile` — deferred, see report).

### Unsubscribe — `public/unsubscribe`

| Method & path | Query | Response |
|---|---|---|
| `GET /public/unsubscribe` | `u` (customer/user id), `t` (HMAC token from the link sent with the message), `c?` (`EMAIL\|SMS\|ALL`, default `ALL`) | `{ok:true, message}`; clears `marketingEmailConsent`/`marketingSmsConsent` on the customer's profile. 400 if the token doesn't match. |

## Referrals — `admin/referrals` (`Module.PROMOTIONS`)

Reward is granted automatically: `ReferralRewardListener` listens for `Events.ORDER_DELIVERED`
(`@nestjs/event-emitter`) and, the first time a referred customer's order reaches `DELIVERED`/`COLLECTED`,
credits both parties' FORKY wallets (`WalletService.credit(..., 'REFERRAL', ...)`) and marks the `Referral`
row `REWARDED`. `Referral` rows themselves are created at signup by `AuthService` (`referralCode` /
`referredById` on `CustomerProfile`) — not by this module.

| Method & path | Permission | Body / query | Response |
|---|---|---|---|
| `GET /admin/referrals` | view | `PageQueryDto` + `status? (PENDING\|REWARDED\|VOID)` | `{data:Referral[+referrerName,refereeName], meta}` |
| `GET /admin/referrals/stats` | view | - | `{total, pending, rewarded, void, totalPaidOut}` |
| `GET /admin/referrals/settings` | view | - | `{enabled, referrerReward, refereeReward, minSubtotal}` (settings `marketing.referral*`) |
| `PATCH /admin/referrals/settings` | edit | `{enabled?, referrerReward?, refereeReward?, minSubtotal?}` | updated settings |
| `POST /admin/referrals/:id/void` | edit | - | `status=VOID` (blocked once already `REWARDED`) |

Customer-facing referral code, share text and personal history live on `CustomersModule`
(`GET /customer/referrals`, not owned by this module).

## Realtime / events

No new realtime rooms. Domain events consumed: `Events.ORDER_DELIVERED` (referral reward). Domain event
produced: none new (campaign sends and gift-card issuance go through `NotificationsService`/`AuditService`
directly). Notification event key added: `campaign.message` (already present in
`NotificationsService.DEFAULT_MESSAGES`, vars `{title, body}`).
