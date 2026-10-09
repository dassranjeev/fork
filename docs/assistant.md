# FORKSY ordering assistant ("the bot")

A private ordering assistant for every restaurant, plus one central bot for the FORKSY website.

* **Restaurant bot** - answers questions about THAT restaurant only (menu, prices, dietary tags and allergens as recorded, hours, delivery / pickup, minimum order, prep time, the restaurant's own FAQs), makes suggestions, builds a cart ("add 2 margherita and a pop", "remove the pop", "no onions", "allergy: peanuts") and hands the guest over to the FORKSY website to pay.
* **Central bot** - on the main FORKSY website: finds restaurants ("pizza near me", "vegetarian, open now", "halal delivery", by name or dish); "order from X" scopes the session to that restaurant and continues as above.
* **Embed** - every restaurant gets a one-line embed code for its own website. The visitor chats as a guest; on **Checkout** they are redirected to FORKSY with the same items (one-time hand-off token), log in or register there, and the items are placed in their cart.
* **Logged-in customers** (the main website sends the customer Bearer token) - every cart change is mirrored into the customer's real server cart, so checkout continues with no hand-off.

**Training**: restaurants (and FORKSY, for the website bot) teach their bot custom answers, nicknames and documents with the in-house [bot training tool](assistant-training.md) (retrieval, still no LLM).

There is **no LLM and no external service**: the brain is a deterministic engine (fuzzy matching, quantity / price / diet parsing, strict cart tools). An optional `LlmBrain` adapter stub exists (see "LlmBrain (untested)").

Contents: [How it works](#how-it-works) - [Architecture](#architecture) - [API contract](#api-contract) - [Embedding on a merchant site](#embedding-on-a-merchant-site) - [Security model](#security-model) - [Configuration](#configuration) - [Extension points](#extension-points) - [What the deterministic brain cannot do](#limitations) - [LlmBrain (untested)](#llmbrain-untested) - [Testing](#testing) - [Contract changes](#contract-changes) - [Decisions for the owner](#decisions-for-the-owner)

---

## How it works

```
 merchant website                     FORKSY API                              FORKSY website
 <script widget.js data-key=bk_...>
        |  GET  /public/assistant/config?botKey=
        |  POST /public/assistant/chat {botKey, sessionId, message|quick}  --> brain + tools --> reply (+ cart)
        |  POST /public/assistant/handoff {sessionId, botKey}               --> one-time token (SHA-256 stored)
        '--- top-level redirect ------------------------------------------------------>  /order/handoff?token=...
                                                                                  guest logs in / registers
                                                         POST /customer/assistant/import-handoff {token}
                                                         --> re-validates every line, replaces the customer's cart,
                                                             returns {restaurant, cartCount, orderNote, skipped[]}
                                                         --> POST /customer/orders (customerNotes = orderNote)
```

1. The widget calls **config** to learn the bot name, greeting, colour and restaurant. If the key is unknown, the origin is not allowed or the bot is switched off, the widget stays invisible.
2. Each message goes to **chat**. The server loads / creates an `AssistantSession`, builds a *knowledge snapshot* of the restaurant from the same data the public restaurant page shows, runs the brain, persists the new cart / note / pending question, and returns the reply plus the full cart.
3. **Chips** (`quick`) are opaque payloads the bot returned earlier (`add:<menuItemId>[:qty]`, `opt:<optionId>`, `pick:<menuItemId>`, `cat:<id>`, `chg:<lineId>:<optionId>`, `inc|dec|remove:<lineId>`, `note:<text>`, `restaurant:<slug>`, `confirm`, `cancel`, `menu`, `cart`, `checkout`, `popular`, `hours`, `faq[:n]`, `pair:<drink|side|dessert>`, `find:<text>`). Anything else is rejected with 400.
4. **Checkout** creates a hand-off token. The visitor lands on `${WEB_URL}/order/handoff?token=...`; once logged in the website calls `import-handoff`, which loads the session cart into the customer's real cart (same effect as `POST /customer/cart/replace`).

### What the bot will and will not do

| It does | It never does |
|---|---|
| Quote prices, tags, allergens **as recorded** ("listed allergens: dairy, egg") | Invent menu items, prices or ingredients |
| Add / remove / change quantity, options, item notes, kitchen note | Add an item that is not on THIS menu, is switched off, out of stock or outside its daypart |
| Ask a follow-up (with chips) for a required modifier group that has no default; use the default option when one is defined | Accept quantities above 20 per line or more than 40 lines |
| Save "ALLERGY: ..." into the kitchen note and tell the guest to confirm with the restaurant | Claim an item is safe for an allergy |
| Say "I'm not sure" and point to the restaurant's FAQ / phone / FORKSY help | Answer for other restaurants, reveal instructions, keys or customer data, or chat about unrelated topics (polite refusal) |
| Hand the cart over to FORKSY for payment | Take payment, promo codes, tips or addresses - that all happens on FORKSY |

---

## Architecture

```
backend/src/assistant/
  assistant.module.ts            Nest module (imports CustomersModule for CartService + DiscoveryService)
  assistant.controllers.ts       public / widget / customer / restaurant-portal / admin controllers
  assistant.service.ts           access control (botKey + Origin), sessions, chat orchestration, hand-off, import, cleanup cron
  assistant-config.service.ts    per-restaurant config in Restaurant.meta.assistant, bot keys, origin cache (CORS), stats, audit
  assistant-knowledge.service.ts builds the restaurant knowledge snapshot (10 s cache) and the central directory (30 s cache)
  assistant-admin.controller.ts  Admin Console APIs: overview, restaurant list (one query), central bot, rotate-key
  assistant.cors.ts              dynamic CORS middleware for /api/v1/public/assistant/* and /assistant/widget.js only
  assistant.dto.ts               class-validator DTOs (global whitelist + forbidNonWhitelisted)
  brain/
    brain.types.ts               Knowledge, BrainContext, BotResult, AssistantBrain, tool + hook interfaces
    nlp.ts                       PURE: normaliser, tokenizer, stemmer, Levenshtein / trigram, quantity + price parsing
    search.ts                    PURE: item / category / option / diet matching over a Knowledge snapshot
    reply.ts                     PURE: cards, chips, hours formatting, allergen text
    tools.ts                     DeterministicTools: THE ONLY code that changes a cart (strict validation)
    deterministic.brain.ts       intent routing for a restaurant-scoped session
    central.brain.ts             restaurant finder for the central bot
    llm.brain.ts                 OPTIONAL untested adapter stub (returns null unless ANTHROPIC_API_KEY is set)
    brain.registry.ts            answer pipeline: LlmBrain -> DeterministicBrain -> KnowledgeProvider -> 'assistant.unanswered'
    hooks.ts                     extension points (KnowledgeProvider, AliasResolver) + event names
    index.ts                     barrel for the pure text engine
backend/src/database/entities/assistant.entities.ts   AssistantSession (table assistant_sessions)
backend/assets/assistant-widget.js                    the embeddable widget (served by the API)
admin/src/features/portal/Assistant.jsx               restaurant portal page (FAQs, websites, embed code; look read-only)
admin/src/features/assistant/                         Admin Console sidebar group: Overview, Restaurant bots, Bot editor, Central bot (+ shared parts.jsx)
admin/src/features/restaurants/AssistantCard.jsx      admin card on the restaurant detail (Overview tab)
admin/public/assistant-demo.html (+ .js)              fake merchant page for testing the widget
backend/test/assistant-brain.test.ts                  unit tests of the brain (no server needed)
backend/test/assistant-integration.mjs                HTTP integration test (needs the running API + demo seed)
```

### Brain and tools

`AssistantBrain.respond(ctx): Promise<BotResult | null>`. The **brain decides what to do; tools do it.** A brain never edits the cart directly - it calls `ctx.tools` (`addItem`, `answerOption`, `removeLine`, `setLineQuantity`, `changeOption`, `setLineNote`, `addOrderNote`, `clearCart`, ...). The tools validate against the restaurant's own menu snapshot: item must exist in THIS menu and be active and available (in stock and inside its daypart), quantity 1-20 per line, at most 40 lines, options must belong to the item, be available and respect each group's maximum. Required modifier groups use the default option when one is defined; otherwise the tool records a pending question in the session (`pending`) and the brain asks it with one chip per option. If the original message had more items ("2 wings and a pop"), the remaining clauses are kept in the pending question and processed after the answer. Because the draft state is snapshotted around every brain, a brain that throws or returns null leaves nothing half-applied.

The deterministic brain understands: menu / category listing, dietary filters (`vegetarian`, `vegan`, `halal`, `gluten-free`, any tag the restaurant uses), budget ("under $10", "cheapest"), recommendations ("popular", "surprise me"), pairings ("what goes with the margherita"), item questions (price, description, allergens), add / remove / change quantity / "make it large", quantity words (`2`, `two`, `x2`, `2x`, `a couple of`, `a dozen`), several items per message split on `,` `and` `plus`, typos (Damerau-Levenshtein + trigram scorer, plurals / stems, synonyms like pop = soda = cola), item notes ("no onions on the pizza"), kitchen note, allergy statements, hours (incl. a given weekday), delivery / pickup, minimum order, prep time, address, phone, payment / promo questions (answered with "handled at checkout"), restaurant FAQs (fuzzy), and refusals for prompt injection and off-topic requests.

### Data

`assistant_sessions` (entity `AssistantSession`, created by `DB_SYNC`): `id`, `restaurantId` (null = central bot not scoped yet), `customerId` (null for guests), `mode` (`embedded` | `site`), `origin` (embedded mode only - **no IP is stored**), `cart` jsonb, `orderNote`, `pending` jsonb, `transcript` jsonb (last 30 messages, each cut to 500 chars), `messageCount`, `cartTouched`, `handoffTokenHash` (indexed, SHA-256 of the token), `handoffExpiresAt`, `handoffUsedAt`, `handoffCount`, `importedAt`, `lastActiveAt`, `expiresAt`, `createdAt`, `updatedAt`.

A session expires `assistant.sessionTtlHours` (24) after the last message. A daily cron (04:17) wipes the content of expired sessions (transcript, cart, note, token hash) immediately and deletes the empty rows 35 days after expiry (they are kept that long only so the 7- and 30-day statistics stay correct).

Per-restaurant configuration lives in `Restaurant.meta.assistant` (no schema change):

```json
{ "enabled": true, "name": "Barn Buddy", "greeting": "...", "color": "#2E7D32",
  "faqs": [{ "q": "Do you have parking?", "a": "Yes, ..." }],
  "allowedOrigins": ["https://www.mybistro.ca"],
  "botKey": "bk_<24 url-safe chars>", "forcedOff": false }
```

Defaults when absent: enabled, name `"<Restaurant name> Assistant"`, a generic greeting, no FAQs, no allowed origins. The key is generated atomically on the first read. Writes use `jsonb_set` on `meta.assistant` only, so concurrent writers of other `meta` keys are not clobbered.

---

## API contract

Public paths are under the global prefix `/api/v1`. Bodies are validated by the global pipe: unknown fields are rejected (400).

### Public (guests; a valid *customer* Bearer token marks the visitor as logged in)

| Method + path | Notes |
|---|---|
| `GET /public/assistant/config?botKey=bk_...` | -> `{ enabled, name, greeting, color\|null, logoUrl\|null, restaurant: {id, slug, name, logoUrl\|null}, mode: "embedded" }` (`logoUrl` = the logo FORKSY set for the assistant, else the restaurant's own logo). 404 unknown / malformed key; 403 when the Origin is not in THAT restaurant's allowed origins, or the bot is disabled (platform, embed switch, merchant or admin). An embedded request without an Origin header is accepted only outside production. |
| `GET /public/assistant/config?restaurantSlug=slug` | main-website bot scoped to a restaurant -> same shape, `mode: "site"`. |
| `GET /public/assistant/config` | central bot -> `restaurant: null`, `mode: "site"`, plus `chips: [{label, payload}]` (the central bot's starter chips) and the central name / greeting / colour / logo configured in Admin. Site modes accept only origins listed in env `CORS_ORIGINS`, or no Origin header. |
| `POST /public/assistant/chat` | body `{ botKey?, restaurantSlug?, sessionId? (uuid), message (1..500, trimmed, HTML stripped), quick?, lat?, lng? }`. -> `{ sessionId, restaurant: {id,slug,name,logoUrl}\|null, reply: { text, cards?[<=6], restaurants?[<=6], chips?[<=6] }, cart: { items: [{lineId, menuItemId, name, quantity, unitPrice, options:[{id,name,priceDelta}], notes?, lineTotal}], count, subtotalEstimate }, orderNote, canCheckout, loggedIn }`. Throttle 30/min per IP, 12/min per session (429 `SESSION_RATE_LIMIT`). 429 `SESSION_LIMIT` after `assistant.maxMessagesPerSession` messages. `canCheckout` = non-empty cart, restaurant takes orders, subtotal >= minimum order. `lat`/`lng` (optional, never stored) only sort the central bot's "near me". |
| `POST /public/assistant/handoff` | body `{ sessionId, botKey? }` -> `{ token, url, expiresAt }`; `url = ${WEB_URL}/order/handoff?token=${token}`. Token = 32 random bytes base64url, only its SHA-256 is stored, single use, TTL `assistant.handoffTtlMinutes` (30). 400 if the cart is empty / no restaurant. Throttle 6/min per IP. A new hand-off replaces the previous token. |
| `POST /public/assistant/feedback` | body `{ sessionId, messageId?, rating: "up"\|"down", comment? (<=500) }` -> `{ ok: true }`. Nothing is stored; emits the in-process event `assistant.feedback` (see Extension points). 30/min per IP. |
| `GET /assistant/widget.js` | **not** under `/api/v1`. `Content-Type: application/javascript`, `Cache-Control: public, max-age=300`, `X-Content-Type-Options: nosniff`, `Access-Control-Allow-Origin: *`. GET only. |

`reply.cards[]`: `{ menuItemId, name, description?, price, imageUrl?, tags?[], available }`. `reply.restaurants[]`: `{ id, slug, name, cuisine?, openNow, deliveryAvailable, pickupAvailable, rating?, logoUrl? }`. `reply.chips[]`: `{ label, payload }` - send `payload` back as `quick`.

### Customer (Bearer customer token)

`POST /customer/assistant/import-handoff` body `{ token }` -> `{ restaurant: {id, slug, name}, cartCount, orderNote\|null, skipped: [{name, reason}] }`.
The token is claimed with one atomic `UPDATE ... WHERE hash = ? AND usedAt IS NULL AND expiresAt > now() RETURNING` (two simultaneous imports: exactly one wins). Every line is re-validated against the live menu (item exists in that restaurant, active, available, options valid, required groups satisfied); invalid lines are skipped and reported, the rest replace the customer's cart for that restaurant (like `POST /customer/cart/replace`). If the cart could not be written (e.g. restaurant not live) the token is released so the visitor can retry. Bad / used / expired / unknown tokens all give the same 400 message. The website should prefill `customerNotes` of `POST /customer/orders` with the returned `orderNote`.

### Who may change what (permission split)

| What | FORKSY staff (Admin Console) | Restaurant (portal) |
|---|---|---|
| Assistant name, greeting, accent colour, **logo**, enabled / forced-off | **edit** (`restaurants:edit`) | read-only preview ("Set by FORKSY. Contact support to change the look of your assistant.") |
| FAQs (question and answer) | edit | **edit** (OWNER, LOCATION_MANAGER) |
| Allowed websites (origins) | edit | **edit** (OWNER, LOCATION_MANAGER) |
| Embed code: view / copy | view | view / copy (all roles) |
| Rotate the bot key | edit | **rotate** (OWNER, LOCATION_MANAGER) |
| Central (FORKSY website) bot, platform switches | `settings:edit` | - |

The split is enforced by the API, not only by the screens: `PATCH /restaurant/assistant` accepts ONLY `{ faqs, allowedOrigins }`; any other field (name, greeting, color, logoUrl, enabled, forcedOff, botKey ...) is rejected with 400 by the global whitelist and **nothing** is changed (the whole request is refused, including valid fields sent together with a forbidden one).

### Restaurant portal (Bearer restaurant token; `?restaurantId=` for multi-location accounts)

| | |
|---|---|
| `GET /restaurant/assistant` (all roles) | `{ config: {enabled, name, greeting, color, logoUrl, faqs, allowedOrigins, botKey}, effectiveLogoUrl, forcedOff, platformEnabled, embedEnabled, embedSnippet, stats: {chats7d, messages7d, carts7d, handoffs7d, imported7d, lastActivityAt} }` - the full view, so the portal can show the look read-only |
| `PATCH /restaurant/assistant` (OWNER, LOCATION_MANAGER) | **only** `faqs` (<=20 x `{q<=120, a<=500}`) and `allowedOrigins` (<=10 strict origins) |
| `POST /restaurant/assistant/rotate-key` (OWNER, LOCATION_MANAGER) | `{ botKey, embedSnippet }`; the old key stops working immediately. |

`allowedOrigins` rules (`normalizeOrigin`): `new URL()` parse, **https only**, origin only (no path, query, hash or credentials), no wildcard, a full domain (or `localhost`). Outside production `http://localhost[:port]`, `http://127.0.0.1[:port]` and the literal `http://localhost:*` (any local port) are accepted. Values are canonicalised (lower-case host, trailing slash removed) and de-duplicated.

### Admin (staff; super admin)

| | Permission | |
|---|---|---|
| `GET /admin/restaurants/:id/assistant` | `restaurants:view` | same view as the portal GET |
| `PATCH /admin/restaurants/:id/assistant` | `restaurants:edit` | any of `enabled` (strict bool), `name` (<=40), `greeting` (<=200), `color` (hex or null), **`logoUrl`**, `faqs`, `allowedOrigins`, `forcedOff` (strict bool) |
| `POST /admin/assistant/restaurants/:id/rotate-key` | `restaurants:edit` | `{ botKey, embedSnippet }` |
| `GET /admin/assistant/overview` | `restaurants:view` or `settings:view` | platform switches, 7 / 30 day statistics, restaurant counts |
| `GET /admin/assistant/restaurants?search=&status=&sortBy=&sortDir=&page=&limit=` | `restaurants:view` | paginated list of ALL restaurants with their bot, one query |
| `GET /admin/assistant/central` | `settings:view` | the central bot configuration, defaults, effective chips, stats |
| `PATCH /admin/assistant/central` | `settings:edit` | any of `enabled`, `name`, `greeting`, `color`, `logoUrl`, `faqs` (<=20), `chips` (<=6 x `{label<=30, query<=60}`) |

**Logo** (`logoUrl`): upload the image with the existing `POST /uploads` and store the returned URL. The server accepts only an own-origin upload: `<PUBLIC_URL>/uploads/<uuid>.(png|jpg|jpeg|webp)` (svg is refused; foreign hosts, `javascript:` and anything else are 400). `null` removes it. The public config returns `logoUrl` = the assistant logo, else the restaurant's own logo, else `null`.

**Audit**: every admin change is written to the audit log with before / after: `assistant.branding-update` (name, greeting, colour, logo, enabled; lists the changed keys), `assistant.force-off` / `assistant.force-off-lifted`, `assistant.admin-update` (FAQs / websites only), `assistant.rotate-key`, `assistant.central-update`. Restaurant edits are `assistant.update`. Bot keys are masked.

### Restaurant list row (`/admin/assistant/restaurants`)

`{ id, name, slug, status, botName, enabled, forcedOff, botStatus: "active"|"disabled"|"forced_off", origins, faqs, chats7d, handoffs7d, lastActivityAt }`. `status=` filters on `active | disabled | forced_off`; sorting on `name | chats7d | handoffs7d | lastActivityAt`.

### Platform settings (group `assistant`, Admin > Settings)

| Key | Default | Meaning |
|---|---|---|
| `assistant.enabled` | `true` | master switch (FORKSY website bot and every restaurant bot) |
| `assistant.embed.enabled` | `true` | allow bots on merchants' own websites |
| `assistant.maxMessagesPerSession` | `200` | messages per chat session |
| `assistant.sessionTtlHours` | `24` | inactivity after which a session (and its cart) expires |
| `assistant.handoffTtlMinutes` | `30` | validity of the checkout hand-off link |

Environment: `WEB_URL` (default `http://localhost:3000`, the FORKSY website; used in the hand-off URL), `PUBLIC_URL` (the API's public URL; used in the embed snippet), `CORS_ORIGINS` (FORKSY web origins allowed for the site modes), optional `ANTHROPIC_API_KEY` (LlmBrain stub).

---

## Admin Console: the "Assistant" sidebar group

Visible to staff with `restaurants:view` or `settings:view` (super admin always). Source: `admin/src/features/assistant/` (routes + menu in `index.js`).

| Page | Path | Permission | What |
|---|---|---|---|
| Overview | `/assistant` | restaurants:view or settings:view | platform switches (`assistant.enabled`, `assistant.embed.enabled`, central bot on/off, session TTL, max messages per session, hand-off TTL) saved through the normal settings API (so the super-admin-only rule of that API still applies); platform-wide statistics for the last 7 and 30 days (chats, on merchant sites vs FORKSY site, messages, carts, hand-offs, imports); restaurant counts; an explainer |
| Restaurant bots | `/assistant/restaurants` | restaurants:view (switch: restaurants:edit) | searchable, filterable, sortable, paginated table of ALL restaurants: bot name, active / off (restaurant) / off (FORKSY), number of allowed websites, FAQ count, chats 7d, checkouts 7d, last activity, inline force-off switch, Edit |
| Bot editor | `/assistant/restaurants/:id` | restaurants:view (edit: restaurants:edit) | everything for one bot: enabled, name, greeting, accent colour, **logo upload with preview**, FAQs, allowed websites, force-off, embed code (copy), rotate key, statistics, a **live preview** (opens `/assistant-demo.html?key=...`; the demo origin has to be in the allowed websites, the page offers to add it) |
| Central bot | `/assistant/central` | settings:view (edit: settings:edit) | the main-website bot: name, greeting, accent colour, logo, enabled, FAQs about FORKSY itself (delivery areas, fees, how it works, support contact), starter chips |
| Training | `/assistant/training` | restaurants:view (approve / reject / release: restaurants:edit; approval switch: settings:edit) | platform stats, **approval queue** (approve / reject with note, see what changes), **held queue** (guardrail-held allergen / medical answers: release or remove) |
| Training coverage | `/assistant/training/restaurants` | restaurants:view | every restaurant: live answers, version, unpublished changes, unanswered, answer rate (30 days), pending requests; row opens the restaurant's training area |
| Restaurant training | `/assistant/training/restaurants/:id` | restaurants:view (edit: restaurants:edit) | the full training area (Overview, Knowledge, Nicknames & synonyms, Documents, Unanswered inbox, Test bench, Versions & publish) on behalf of the restaurant; publishes directly |
| Central bot training | `/assistant/training/central` | settings:view (edit: settings:edit) | the same training area for the FORKSY website bot (synonyms, no menu nicknames) |

The restaurant detail page keeps a small status card with a **Manage assistant** link to the editor.

**Adding a page**: create the component in `features/assistant/`, add one route and one `children` entry in `index.js` . Entries accept `perm: [module, action]` or `anyPerm: [[module, action], ...]`.

**Central bot storage**: platform settings `assistant.central.enabled | name | greeting | color | logoUrl | faqs | chips` (group `assistant`, also visible in Settings). Every value is re-validated each time it is read (an invalid colour, logo or chip written through the generic settings page is ignored), and `PATCH /admin/assistant/central` validates strictly and audit-logs (`assistant.central-update`). The central bot answers a FAQ (fuzzy match, threshold 0.7) before searching restaurants, shows the configured chips, and the storefront chat (`AssistantChat`) reads name, greeting, colour, logo and chips from `GET /public/assistant/config`.

**Statistics**: counters come from `assistant_sessions` (chats, messages, carts, hand-offs, imports). Unanswered questions are collected by the training tool (see [assistant-training.md](assistant-training.md)): grouped by similarity, personal data stripped, no session ids; the statistics of answered / unanswered questions live in the training analytics.

---

## Embedding on a merchant site

1. Restaurant portal -> **Assistant**. (The look - name, greeting, colour, logo - is set by FORKSY and shown read-only.) Add the website(s) where the bot will appear under **Websites that may show the assistant** (for example `https://www.mybistro.ca` and `https://mybistro.ca`), save.
2. Copy the **embed code** and paste it before `</body>` on every page where the bot should appear:

```html
<script src="https://api.forksy.ca/assistant/widget.js" data-key="bk_XXXXXXXXXXXXXXXXXXXXXXXX" async></script>
```

3. Optional attributes: `data-position="left"` (default right). For the FORKSY website itself: `data-mode="site"` (central bot) or `data-mode="site" data-restaurant="<slug>"` (scoped).
4. `window.ForksyAssistant.open()` / `.close()` / `.version` open the chat from your own buttons.
5. Content-Security-Policy on your site: allow the API origin in `script-src` and `connect-src`. The widget styles itself through a constructable stylesheet (works without `style-src 'unsafe-inline'`; falls back to a `<style>` element in older browsers) and loads item photos from `https:` (`img-src`).
6. **Rotate key** (portal) if a copy of the code is abused; paste the new snippet. The old key stops working at once.

What guests see: a round button bottom-right; a panel with the greeting, quick-reply chips, item cards with an **Add** button, a cart drawer (+/- / remove / kitchen note / estimated subtotal - "final price is shown at checkout") and a **Checkout on FORKSY** button that navigates the whole window to FORKSY. It is keyboard accessible (focus trap, Esc closes, labelled controls, live log), full-screen on phones (< 480 px), follows `prefers-color-scheme` and uses the restaurant's accent colour. All server text is inserted with `textContent` (never `innerHTML`); images only from `http(s)` URLs. The session id is kept in `localStorage` (guarded; the widget works without it).

Local test: open `http://localhost:3000/assistant-demo.html?key=bk_...` (the page loads the widget from `http://localhost:4000`). Add `http://localhost:3000` to the restaurant's allowed websites first.

---

## Security model

* **The bot key is public** (it is in the page source). Protection is layered: (1) the request **Origin** must be in THAT restaurant's `allowedOrigins` - checked in every handler (config, chat, hand-off) *in addition to* CORS; an embedded request with no Origin header is refused in production; (2) every endpoint is rate limited (30/min/IP chat, 12/min/session, 6/min/IP hand-off); (3) the key only reaches data the public restaurant page already exposes.
* **Dynamic CORS only for the assistant's public endpoints** (`/api/v1/public/assistant/*`, `/assistant/widget.js`): `Access-Control-Allow-Origin` is the request's own origin when it is in the cached union of every enabled restaurant's `allowedOrigins` (refreshed every 60 s and on every save / force-off) or in `CORS_ORIGINS`; never `*` for chat. Preflights of those paths are answered by the middleware (403 for unknown origins). The CORS layer only decides whether the browser may *read* an answer; the per-restaurant check above decides whether the request is *served*. All other routes keep the static `CORS_ORIGINS` policy.
* **Private by construction**: a restaurant bot reads only its own restaurant's rows. The central bot sees only a directory of public data (names, cuisines, open / delivery flags, dish names for search).
* **Strict tools**: free text can never write anything but through `DeterministicTools` (menu-validated). Quantity 1-20, 40 lines, option rules, availability, daypart. The same validation runs again at import (against the live database) and by `CartService.replace` when the real cart is written.
* **Hand-off token**: 32 random bytes, only the SHA-256 is stored, TTL 30 min, single use, atomic claim, replaced by a newer hand-off, identical error for bad / used / expired. Importing needs a logged-in **customer**.
* **Sessions**: opaque UUIDs. A session is bound to its mode and restaurant (an embedded session id is useless elsewhere) and, once a customer used it logged in, to that customer. Guests: no IP, no user agent, only the page origin; chat content is wiped when the session expires.
* **Prompt injection / data exfiltration**: the deterministic brain has no instruction channel to hijack; known injection phrasings, requests for keys / prompts / other restaurants' data and off-topic requests get a polite refusal. Message text is HTML-stripped by the global input interceptor.
* **Audit**: every configuration change (`assistant.*` actions) is audited; bot keys are masked in the log. Admin can force-disable a bot (`forcedOff`), which also removes its origins from the CORS union within the same request.
* **Allergies**: the bot reports "listed allergens" exactly as recorded, never says an item is safe, writes `ALLERGY: ...` into the kitchen note and tells the guest to confirm with the restaurant.

---

## Extension points

Built so a training tool can plug in without touching the brain:

1. **`KnowledgeProvider`** (`brain/hooks.ts`, DI token `KNOWLEDGE_PROVIDER`): `lookup(restaurantId, normalisedQuery, ctx) -> { text, confidence, cards?, chips? } | null`. Consulted by `AssistantBrains` *after* the deterministic brain decided it does not understand the message (`intent: 'unknown'`) and *before* the "I'm not sure" reply is used. Answers with `confidence >= 0.6` replace it (`intent: 'knowledge'`). The default `NullKnowledgeProvider` returns null. Override with `{ provide: KNOWLEDGE_PROVIDER, useClass: ... }` in `AssistantModule`.
2. **`AliasResolver`** (DI token `ALIAS_RESOLVER`): `resolve(restaurantId, phrase) -> menuItemId | null` (synchronous - keep an in-memory cache). The item matcher asks it first for every item phrase (lower-cased, filler words removed: "the usual" arrives as `usual`). Default `NullAliasResolver` returns null.
3. **Pure text engine** (`brain/nlp.ts`, `brain/search.ts`, `brain/reply.ts`, re-exported by `brain/index.ts`): `normalize`, `tokenize`, `stem`, `levenshtein`, `trigramSim`, `wordSim`, `parseQuantity`, `parsePriceCap`, `rankItems`, `resolveItem`, `matchOptions`, ... No database, no Nest imports.
4. **Event `assistant.unanswered`** (`EventEmitter2`): `{ restaurantId, sessionId, text, at }`, emitted whenever the bot could not answer. Consumed by the training tool's `TrainedKnowledge` (`training/training.runtime.ts`), which stores it PII-stripped and without the session id in the unanswered inbox.
5. **Event `assistant.feedback`**: `{ restaurantId, entryId?, question?, sessionId, messageId?, rating, comment?, at }` from `POST /public/assistant/feedback`; the training tool counts it per taught answer ("needs review").

**Implemented by the training tool** ([assistant-training.md](assistant-training.md)): `TrainedKnowledge` is both the `KnowledgeProvider` (taught answers, "Did you mean", quoted documents) and the `AliasResolver` (menu nicknames); the pipeline order is documented in `brain/brain.registry.ts`.

Constants and payload types: `AssistantUnansweredEvent`, `AssistantFeedbackEvent`, `ASSISTANT_UNANSWERED`, `ASSISTANT_FEEDBACK` in `brain/hooks.ts`.

---

## Limitations

What the deterministic brain **cannot** do (by design, no language model):

* It does not understand free-form language. Unusual phrasing, long compound requests, sarcasm, slang or languages other than English fall back to "I'm not sure" with helpful chips. French is not supported yet.
* It only answers from the data the restaurant entered: no ingredient-level knowledge, no nutrition beyond what is recorded, no recommendations based on taste. "Popular" means the restaurant's own *popular* flag; if none are flagged it shows one dish per section without claiming popularity.
* Allergen / diet information is exactly as complete as the restaurant made it. The bot says so and never certifies safety.
* Pairings are rule-based (drinks -> sides -> desserts by category / item name keywords).
* It does not modify existing orders, track deliveries, issue refunds, apply promo codes, take tips or addresses (all on FORKSY), nor schedule orders - it explains that and points to FORKSY help.
* Fuzzy matching can pick the wrong item for very short or very generic words; when several items match it asks instead of guessing, and a single weak match is confirmed ("Did you mean ...?").
* Sessions are in the database but the per-session 12/min limiter and the knowledge caches are in memory: with several API instances each instance keeps its own counters / caches (the same limitation as the platform's other in-memory throttles - use a shared store in production).
* The "near me" ranking needs the client to send `lat`/`lng`; the bot has no other way to know the location.
* The allowed-origins CORS union is cached per instance for up to 60 s (an immediate refresh happens on the instance that saved the change).

### LlmBrain (untested)

`brain/llm.brain.ts` is an **adapter stub, not a feature**. It returns `null` (so the deterministic brain answers) unless the env var `ANTHROPIC_API_KEY` is set. With a key it makes one thin, non-streaming call to the Anthropic Messages API (8 s timeout) giving the model the scoped restaurant's public menu and asking for JSON `{ reply, add: [{menuItemId, quantity}] }`; proposed adds are still executed through the strict tools, so a manipulated model cannot add a foreign or invalid item. Any error / non-JSON answer falls back to the deterministic brain. **This network code has never been run against the real API** (there is no key in this project), the model id is a placeholder (`ASSISTANT_LLM_MODEL`, default `claude-sonnet-4-5`) and the reply text is not guarded as tightly as the deterministic one (HTML characters are stripped, 300 chars max). Treat it as a starting point and test before enabling.

---

## Testing

```bash
cd backend
npx tsc --noEmit -p tsconfig.json                       # must be clean
npx ts-node --transpile-only test/assistant-brain.test.ts   # brain + tools + central bot + hooks (125 checks, no server needed)
npx ts-node --transpile-only test/assistant-training.test.ts      # training engine (73 checks)
node test/assistant-training-integration.mjs            # training HTTP (153 checks, ~1.5 min)
node test/assistant-integration.mjs                     # HTTP: portal/admin config, CORS, origins, chat engine, hand-off, import,
                                                        # real order + cancel, logged-in cart, throttles, widget.js  (~7 minutes, paced)
node test/security-smoke.mjs                            # existing platform security checks
```

`assistant-integration.mjs` needs the dev API on :4000 with the demo seed and Postgres for state restoration; it restores the bot configuration, deletes its sessions, empties the test customer's cart and cancels the order it places. The browser test of the widget (Playwright) loads `admin/public/assistant-demo.html`.

---

## Contract changes

Additive, backward compatible changes relative to the original contract:

* `POST /public/assistant/chat` accepts optional `lat` / `lng` (central bot "near me"; never stored).
* Chip payload grammar is extended: `add:<id>[:qty]`, `pick:<id>`, `chg:<lineId>:<optionId>`, `cat:<id>`, `inc|dec|remove:<lineId>`, `note:<text>`, `pair:<class>`, `find:<text>`, `faq[:n]`, `confirm`, `cancel`, `hours`, `delivery`, `help`, `cheapest`. Clients must treat payloads as opaque and send back exactly what they received.
* Error shapes: `429` from chat carries `code: "SESSION_RATE_LIMIT"` or `"SESSION_LIMIT"` (the latter means: forget the session id and start a new chat).
* `GET /restaurant/assistant` / admin view also return `embedEnabled`, `config.logoUrl`, `effectiveLogoUrl`.
* **Bot training** ([assistant-training.md](assistant-training.md)): new endpoint families `/restaurant/assistant/training/*`, `/admin/assistant/training/*`; FAQs now live in the training store (the FAQ endpoints are unchanged and edit the same entries; they publish immediately, or create an approval request when `assistant.training.requireApproval` is on); public chat replies from taught answers add `feedback: true` and `entryId`; `GET /public/assistant/config` falls back to the **FORKSY icon** (`GET /assistant/forksy-icon.png`, public, cacheable) when there is neither an admin logo nor a restaurant logo.
* **Permission split**: `PATCH /restaurant/assistant` now accepts only `{ faqs, allowedOrigins }` (name, greeting, color, logoUrl, enabled -> 400); the admin PATCH gained `logoUrl`.
* `GET /public/assistant/config` returns `logoUrl` (assistant logo, else restaurant logo, else null); central mode also returns `chips`.
* New admin endpoints under `/admin/assistant/*` (overview, restaurants, central, rotate-key).
* New endpoint `POST /public/assistant/feedback` (see above).

---

## Decisions for the owner

1. **Default on.** A restaurant's bot is enabled by default (only the central bot and the FORKSY site-scoped bot work until the merchant lists a website). Change by pre-seeding `meta.assistant.enabled = false` or flipping `assistant.enabled`.
2. **Central bot may scope to a restaurant whose bot is merely disabled (enabled=false, set by FORKSY)** (it is then FORKSY's bot ordering from that restaurant); only the admin force-off removes a restaurant from the central directory.
3. **Session retention**: content is wiped at expiry (24 h), the empty row is kept 35 more days (30-day statistics).
4. **Logged-in customers**: the real server cart wins for the scoped restaurant; adding from another restaurant replaces the customer's cart (the bot tells them). The kitchen note is returned in every chat response (`orderNote`) because the real cart has no note field - the website must pass it as `customerNotes`.
5. **Production CORS / Origin**: embedded requests without an Origin header are refused in production; `http://localhost*` origins are refused in production.
