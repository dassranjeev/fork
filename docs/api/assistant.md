# Assistant API (ordering bot)

Full description, architecture and security model: [`docs/assistant.md`](../assistant.md). All paths are under `/api/v1` except the widget.

## Public (`@PublicController('assistant')`, no auth; a customer Bearer token marks the visitor as logged in)

| Method path | Throttle | Body / query | Response |
|---|---|---|---|
| `GET /public/assistant/config` | 60/min/IP | `?botKey=bk_...` (embedded) or `?restaurantSlug=slug` (site, scoped) or nothing (central) | `{ enabled, name, greeting, color\|null, logoUrl\|null, restaurant: {id, slug, name, logoUrl\|null}\|null, mode: "embedded"\|"site", chips? }`. `logoUrl` = assistant logo (set by FORKSY), else the restaurant logo, else null. `chips` (central only) = configured starter chips. 404 unknown key / slug, 403 origin not allowed or bot disabled |
| `POST /public/assistant/chat` | 30/min/IP, 12/min/session | `{ botKey?, restaurantSlug?, sessionId?: uuid, message: 1..500, quick?: string, lat?, lng? }` | `{ sessionId, restaurant\|null, reply: { text, cards?[<=6], restaurants?[<=6], chips?[<=6] }, cart: { items: [{lineId, menuItemId, name, quantity, unitPrice, options:[{id,name,priceDelta}], notes?, lineTotal}], count, subtotalEstimate }, orderNote\|null, canCheckout, loggedIn }` |
| `POST /public/assistant/handoff` | 6/min/IP | `{ sessionId: uuid, botKey? }` | `{ token, url, expiresAt }` (`url = WEB_URL/order/handoff?token=...`) |
| `POST /public/assistant/feedback` | 30/min/IP | `{ sessionId: uuid, messageId?, rating: "up"\|"down", comment? }` | `{ ok: true }` (emits event `assistant.feedback`) |
| `GET /assistant/widget.js` (no `/api/v1`) | 120/min/IP | - | the widget script (`application/javascript`, `public, max-age=300`, `nosniff`, CORS `*`) |

Errors: 400 validation (unknown fields rejected, `quick` payload grammar), 403 origin / disabled, 404 unknown key / slug / session, 429 throttles (`code: SESSION_RATE_LIMIT | SESSION_LIMIT` for session limits).

## Customer (`@CustomerController('assistant')`)

| Method path | Body | Response |
|---|---|---|
| `POST /customer/assistant/import-handoff` (20/min) | `{ token: string }` | `{ restaurant: {id, slug, name}, cartCount, orderNote\|null, skipped: [{name, reason}] }`; 400 for a bad / used / expired token (same message) |

## Permission split (who may change what)

| Field | Admin Console (`restaurants:edit`) | Restaurant portal (OWNER / LOCATION_MANAGER) |
|---|---|---|
| name, greeting, color, logoUrl, enabled, forcedOff | edit | **rejected with 400** (read-only preview) |
| faqs, allowedOrigins | edit | edit |
| rotate key | edit | edit |
| embed snippet | view | view / copy (all roles) |

## Restaurant portal (`@RestaurantController('assistant')`, `?restaurantId=` for multi-location accounts)

| Method path | Roles | Body | Response |
|---|---|---|---|
| `GET /restaurant/assistant` | all | - | `{ config: {enabled, name, greeting, color, logoUrl, faqs, allowedOrigins, botKey}, effectiveLogoUrl, forcedOff, platformEnabled, embedEnabled, embedSnippet, stats: {chats7d, messages7d, carts7d, handoffs7d, imported7d, lastActivityAt} }` |
| `PATCH /restaurant/assistant` | OWNER, LOCATION_MANAGER | **only** `faqs` (<=20 of `{q<=120, a<=500}`) and `allowedOrigins` (<=10 https origins); any other field -> 400, nothing changes | same as GET |
| `POST /restaurant/assistant/rotate-key` | OWNER, LOCATION_MANAGER | - | `{ botKey, embedSnippet }` |

## Admin (`@AdminController`)

| Method path | Permission | Body / query | Response |
|---|---|---|---|
| `GET /admin/restaurants/:id/assistant` | restaurants:view | - | same view as the portal GET |
| `PATCH /admin/restaurants/:id/assistant` | restaurants:edit | any of `enabled` (strict bool), `name` (<=40), `greeting` (<=200), `color` (hex / null), `logoUrl` (own-origin `/uploads/<uuid>.png\|jpg\|jpeg\|webp` from `POST /uploads`, or null), `faqs`, `allowedOrigins`, `forcedOff` (strict bool) | same view. Audit: `assistant.branding-update`, `assistant.force-off`, `assistant.force-off-lifted`, `assistant.admin-update` |
| `POST /admin/assistant/restaurants/:id/rotate-key` | restaurants:edit | - | `{ botKey, embedSnippet }` |
| `GET /admin/assistant/overview` | restaurants:view or settings:view | - | `{ platform: {enabled, embedEnabled, sessionTtlHours, maxMessagesPerSession, handoffTtlMinutes, centralEnabled}, stats: {d7, d30: {chats, embeddedChats, siteChats, messages, carts, handoffs, imported}}, restaurants: {total, active, disabled, forcedOff, withOrigins}, unanswered: {tracked: false, note}, retentionNote }` |
| `GET /admin/assistant/restaurants` | restaurants:view | `?search=&status=active\|disabled\|forced_off&sortBy=name\|chats7d\|handoffs7d\|lastActivityAt&sortDir=&page=&limit=` | `{ data: [{id, name, slug, status, botName, enabled, forcedOff, botStatus, origins, faqs, chats7d, handoffs7d, lastActivityAt}], meta }` |
| `GET /admin/assistant/central` | settings:view | - | `{ config: {enabled, name, greeting, color, logoUrl, faqs, chips}, defaults, effectiveChips, effectiveLogoUrl, platformEnabled, stats: {chats7d, messages7d, handoffs7d} }` |
| `PATCH /admin/assistant/central` | settings:edit | any of `enabled`, `name`, `greeting`, `color`, `logoUrl`, `faqs` (<=20), `chips` (<=6 of `{label<=30, query<=60 [A-Za-z0-9 ,.'-]}`) | same as GET. Audit `assistant.central-update` |

## Settings (group `assistant`)

`assistant.enabled` (true), `assistant.embed.enabled` (true), `assistant.maxMessagesPerSession` (200), `assistant.sessionTtlHours` (24), `assistant.handoffTtlMinutes` (30); central bot: `assistant.central.enabled | name | greeting | color | logoUrl | faqs | chips`.

## Bot training

Full contract in [../assistant-training.md](../assistant-training.md) section 7: `/restaurant/assistant/training/*` (read: any role of the restaurant; write: OWNER, LOCATION_MANAGER), `/admin/assistant/training/restaurants/:rid/*` (`restaurants:view|edit`), `/admin/assistant/training/central/*` (`settings:view|edit`), platform routes `/admin/assistant/training/{overview,restaurants,requests,requests/:id,requests/:id/approve|reject,held}`. Settings: `assistant.training.requireApproval`, `assistant.training.holdPhrases`, `assistant.training.blockPhrases`.

Default avatar: `GET /assistant/forksy-icon.png` (outside `/api/v1`, public, `Cache-Control: public, max-age=86400`, CORP cross-origin) is returned as `logoUrl` when a bot has neither an admin logo nor a restaurant logo.

## In-process events

`assistant.unanswered` `{ restaurantId, sessionId, text, at }` - the bot could not answer (stored PII-stripped, without the session id, by the training tool); `assistant.feedback` `{ restaurantId, sessionId, messageId?, rating, comment?, at }`.
