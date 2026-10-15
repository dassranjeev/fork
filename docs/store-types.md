# Store types: restaurants, cafes, bakeries and grocery stores

One platform, one store entity (the `restaurants` table and the `/restaurants` routes keep their names), six kinds of store. The **store type** decides how a
location behaves: how its catalog works, how an order is prepared, what the customer reads, which documents the business uploads and which commission it pays.

| Type | Vertical | Examples | Works like |
|---|---|---|---|
| `RESTAURANT` | FOOD | sit-down, fast food, ghost kitchen, food truck | made to order: menu, kitchen display, prep time per dish |
| `CAFE` | FOOD | coffee, tea, juice, dessert | same as a restaurant, shorter default prep time |
| `BAKERY` | FOOD | bakery, patisserie | same as a restaurant; stock counts ("12 croissants today") work too |
| `GROCERY` | RETAIL | supermarket, ethnic / halal / Asian grocery | picked from shelves: catalog of products, weights, stock, substitutions, picking list |
| `CONVENIENCE` | RETAIL | corner store, variety store | same as grocery, smaller baskets (50 per line, 60 lines) |
| `SPECIALTY` | RETAIL | butcher, fish market, produce, deli, health food | same as grocery |

Everything that is type-specific lives in one file, [`backend/src/common/store-types.ts`](../backend/src/common/store-types.ts) (labels, defaults, limits, the weight and
basket maths, the status words). Existing rows are `RESTAURANT` (the migration turns locations that were already tagged with the "Convenience" cuisine into
`CONVENIENCE`).

**Any catalog field works in any store.** A restaurant can sell wine (age-restricted), a cafe can count its pastries (stock), a butcher sells by weight. The type
decides the defaults and the screens, not what is allowed.

## What changes with the type

| | Restaurant, cafe, bakery | Grocery, convenience, specialty |
|---|---|---|
| Items are called | dishes, in **menu sections** | products, in **departments** (`itemLabelPlural`, `categoryLabel` in the API) |
| Kitchen display | on | off (the portal shows the **picking list**) |
| Prep time (new store) | 20 / 12 / 15 min | 30 / 10 / 20 min (grocery / convenience / specialty); the quote adds picking time per unit, see below |
| Status words the customer reads | "Being prepared", "Ready for pickup" | "Picking your items", "Packed and ready" (`statusLabel`) |
| Cart limits | 50 per line, 40 lines | 99 per line, 150 lines (convenience 50 / 60, specialty 50 / 80) |
| Store page | the whole menu | a summary: a few products per department; the rest is paged (`/catalog`) |
| Documents a business uploads | business licence, health certificate, void cheque | business licence, **food premises permit**, void cheque |
| Commission when the store has no tier of its own | the default tier | the tier whose `defaultForStoreTypes` lists the type (seeded: **Grocery & retail**, 12 % delivery / 4 % pickup / 6 % own driver) |

Both the documents (`restaurant.requiredDocumentsByType`) and the commission tier (Commission tiers, `defaultForStoreTypes`) are editable by the Super Admin.

## Discovery (what the customer website calls)

All routes exist under `/public/...` (no sign-in) and `/customer/...` (signed in: favourites, allergen warnings). `/stores` and `/restaurants` are the same routes.

| Route | What |
|---|---|
| `GET /public/store-types?lat&lng` | the six kinds with how many stores are around: tiles for "Restaurants", "Grocery", "Convenience"...; `verticals` groups them as food / retail |
| `GET /public/home?lat&lng&storeType=GROCERY` | the home feed for one kind (`storeType` takes a list, `vertical=FOOD\|RETAIL` takes a group). Without a filter everything is there, split into `sections.food` and `sections.retail`. `storeTypes` always counts every kind, so the page can switch |
| `GET /public/stores?lat&lng&storeType=...` | browse stores (same filters and sorts as search: `cuisine`, `openNow`, `fulfilment`, `sort`...) |
| `GET /public/search?q=rice&storeType=GROCERY` | restaurants and **products**; a product carries `sku`, `brand`, `packSize`, `sellBy`, `inStock`, `minAge`, `temperature` and the store that sells it. A barcode in `q` (6 to 14 digits) or `barcode=` finds the same product in every store that sells it |
| `GET /public/stores/:slug` | the store page. Cards and the page say `storeType`, `retail`, and `restaurant.store` (labels and limits). For a grocery store `menu.mode` is `CATALOG` and `menu.truncated` is true: `perCategory` products per department (default 8; `?perCategory=N`), `menu.itemCount` is the whole store. `?menu=full` returns everything, `?menu=summary` asks a restaurant for a summary |
| `GET /public/stores/:slug/catalog` | the paged catalog: `categoryId` (or `none`), `q` (name, brand, SKU, barcode), `dietary`, `inStock=true`, `restricted=true` (age-restricted only), `sort` (`popular`, `name`, `price_low`, `price_high`), `page`, `limit` (24, at most 100). Also returns the departments with their product counts |
| `GET /public/stores/:slug/products/:itemId` | one product with its options |

A product (also a dish: the defaults are harmless) has: `price`, `sellBy` (`UNIT` or `WEIGHT`), for weighed products `weightUnit`, `stepSize`, `stepPrice`,
`stepLabel`; `inStock`, `lowStock`, `maxQuantity` (the most the customer can put in the cart: stock and per-order limit), `maxPerOrder`; `minAge` / `ageRestricted`;
`temperature` (`AMBIENT`, `CHILLED`, `FROZEN`); `sku`, `barcode`, `brand`, `packSize`; `available` and `unavailableReason` (`OUT_OF_STOCK`, `NOT_SERVED_NOW`, ...).

## Products sold by weight

`sellBy: "WEIGHT"`: the **price is per `weightUnit`** (kg or lb) and the customer orders **steps** of `stepSize` (0.5 = half a kilo per step). So `quantity` stays a whole
number; the cart shows `estimatedWeight` and `weightLabel` ("~1 kg"), and `unitPrice` is the price of one step (2.18 per kg, step 0.5 = 1.09).

When the store weighs the product (picking) the customer pays for the **weight up to the estimate, never more**: lighter is refunded, heavier is the store's. The refund is
proportional to the line (including its tax). A weight cannot be raised again after the customer was refunded (409).

## Stock

`trackStock` + `stockQty` (pieces, or weight in `weightUnit` for weighed products) + `lowStockThreshold`. A product at 0 is sold out and cannot be ordered; nothing flips
automatically, the shop window is computed from the number.

* **Placing an order takes the basket off the shelf**, atomically per product: two customers cannot both take the last eggs (the loser gets `INSUFFICIENT_STOCK` and the card
  payment is returned like for any refused order).
* **Cancelling or rejecting gives it back**, once per order. A product the picker found missing stays at zero; a replaced line gives back the replacement it took.
* The store gets a quiet `stock.low` notification when an order takes a product across its threshold.
* Counting: `POST /restaurant/menu/stock { updates: [{ sku | barcode | itemId, stockQty | delta, available? }] }` (up to 5000 rows; for POS or inventory feeds; owner, manager, cashier;
  prices are not touched). The answer lists `updated`, `unchanged`, `notFound` and `errors`.

## Catalog management (portal)

* `GET /restaurant/menu/items`: paged product list for big catalogs (`q`, `categoryId`, `stock=out|low|in|tracked|untracked`, `available`, `active`, `sortBy`, `page`, `limit`) with `stockState` per
  product and `counts` (total, tracked, low, out).
* `POST/PATCH /restaurant/menu/items`: the catalog fields `sku` (unique per store, 409 otherwise), `barcode` (6 to 14 digits), `brand`, `packSize`, `sellBy`, `weightUnit`, `stepSize` (required for
  weight), `trackStock`, `stockQty` (whole number for pieces), `lowStockThreshold`, `maxPerOrder`, `minAge` (0, 18, 19, 21), `temperature`. A PATCH changes only what it names.
* CSV (`GET/POST /restaurant/menu/csv`): the columns `sku, barcode, brand, pack_size, sell_by, weight_unit, step_size, track_stock, stock_qty, low_stock, max_per_order, min_age, temperature`
  follow the old ones. In an import the **SKU identifies a product** (otherwise category + name); only columns that are in the file **and filled** change anything; a repeated SKU or a bad
  barcode refuses the whole file.
* Menu editing is still a permission FORKY staff grants per store; counting stock (above) is not.

## Checkout

* The cart line takes `substitution`: `ALLOW` (default: the store may replace it) or `REFUND` (refund it, no replacement).
* `ageConfirmed: true` is required in the payment intent and the order when the basket has an age-restricted product (`400 AGE_CONFIRMATION_REQUIRED`, `details.minAge`). The string
  `"false"` is not a confirmation. The **quote** is more forgiving so a page can show the totals before the box is ticked: it prices the basket and answers `ageConfirmationRequired: true`
  (`false` once `ageConfirmed: true` was sent), together with `requiresIdCheck` and `minAge`.
* An age-restricted basket is handed over in person (the driver checks ID). A `dropoffMethod: LEAVE_AT_DOOR` (or `contactless: true`) **sent in the request** is refused with
  `400 ID_CHECK_NO_LEAVE_AT_DOOR`; a "leave at the door" that only comes from the **saved default of the address** is replaced by `HAND_TO_ME`: the quote's `dropoffMethod` says what the order will use.
  Pickup orders carry the same ID check (the store checks at the counter) and have no hand-over method.
* Errors a cart or checkout client must handle: `INSUFFICIENT_STOCK` (`details.available`), `MAX_PER_ORDER`, `AGE_CONFIRMATION_REQUIRED`, `ID_CHECK_NO_LEAVE_AT_DOOR`, `AGE_RESTRICTED_DISABLED`.
* The quote (`POST /customer/checkout/quote`, now described in the OpenAPI file) adds `storeType`, `requiresIdCheck`, `minAge`, `ageConfirmationRequired`, `dropoffMethod`, `basket` (`units`, `lines`, `weighed`,
  `chilled`, `frozen`, `estimatedKg`; `units` counts the items to pick: every piece, and a weighed product once however many weight steps were ordered) and per line `sku`, `barcode`, `packSize`, `sellBy`, `weightUnit`, `stepSize`, `estimatedWeight`, `minAge`, `temperature`, `substitution`.
* **Picking time:** a retail quote's `prepTimeMin` is the larger of the store's own prep time and `orders.retail.prepBaseMinutes` (10) + `orders.retail.prepSecondsPerUnit` (20 s) per item, capped at
  `orders.retail.prepMaxMinutes` (90). Restaurants are unchanged.
* Orders: `requiresIdCheck`, `minAge`, `ageConfirmed`, `basket`; every order item keeps the facts of the product when it was ordered (and `pickStatus`, `actualWeight`, `replacement`, `adjustmentRefund`).
  The customer's order and the tracking view add `statusLabel`, `picking` (`lines`, `picked`, `replaced`, `outOfStock`, `pending`) and `idCheck`; tracking lists `removedItems` with the refund of each.
  The rows of `GET /customer/orders` carry `statusLabel`, `retail`, `storeType`, `restaurantName` and `restaurantSlug` too, so a list can word the status the way the store does ("Picking your items")
  and say where the order came from without opening each one.

## Picking and substitutions

The store goes through the basket line by line (`POST /restaurant/orders/:id/items/:itemId/pick`, while the order is accepted, preparing or ready):

| `status` | Effect |
|---|---|
| `PICKED` | found. A weighed product needs `actualWeight`: lighter = refund of the difference, heavier = nothing more is charged |
| `OUT_OF_STOCK` | the line is removed and refunded at once, the product shows as sold out for everyone |
| `REPLACED` + `replacementItemId` (+ `replacementQuantity`) | another product of the store (no required options). **The customer pays the lower of the two prices**, the difference is refunded. Refused when the customer chose `REFUND` for that line |

The customer is told each time (`order.weight_adjusted`, `order.item_out_of_stock`, `order.item_replaced`) and the timeline records it. If every line is out of stock the empty order is
cancelled and fully refunded. Refunds go through the normal refund flow (`MISSING_ITEM`, `WEIGHT_ADJUSTMENT`, `SUBSTITUTION_PRICE_DIFFERENCE`, charged to the store).
Marking the order **ready** is unchanged (`POST /restaurant/orders/:id/ready`, or the automatic timer): the picking list is optional, a small shop that does not use it still works.

## Age-restricted products and the ID check

* A product with `minAge` > 0 (alcohol, tobacco; Ontario is 19) can only be listed by a store with an **approved liquor or tobacco licence document** (`restaurant.ageRestricted.requireLicence`, default on;
  `restaurant.ageRestricted.enabled` switches the whole feature off). Without it: `400 LICENCE_REQUIRED`. A store that lists such products also sees the licence in its document checklist.
* At the door the driver app sends `idChecked: true` (ID seen, old enough) or `idRefused: true` with the delivery (`POST /driver/trip/:id/delivered`). Without either: `400 ID_CHECK_REQUIRED`.
  With `idRefused` the order is still delivered, but the age-restricted lines are **not handed over**: removed, refunded (with tax) and put back on the shelf; the customer is told (`order.id_check_failed`).
* The driver offer and the tracking view carry `requiresIdCheck`, `minAge` and the `basket` (bags, cold chain), so the driver knows before accepting.
* Pickup orders carry the same flags: the store checks ID at the counter. (Licence expiry is not swept automatically yet: an expired licence blocks new listings, not products already listed.)

## Onboarding and administration

* `POST /auth/restaurant/apply` and `POST /admin/restaurants` take `storeType`; a new store starts with the defaults of its type (prep time, radius, minimum order, scheduling lead, kitchen display).
* `PATCH /admin/restaurants/:id { storeType }` changes it (admin only; an owner cannot: it changes documents, commission and behaviour). `GET /admin/restaurants?storeType=GROCERY,SPECIALTY` and
  `?vertical=RETAIL` filter the list.
* The document checklist follows the type; the Super Admin can set a list per type in `restaurant.requiredDocumentsByType`.

## Screens

* **Admin Console.** Restaurants and stores: a **Type** column and badge, a store-type filter, "Kind of store" on the add form and the edit form (the Super Admin / staff with edit rights change it; an owner cannot).
  Commission tiers: "Used by these kinds of store" (the seeded **Grocery & retail** tier is the default for grocery, convenience and specialty stores).
* **Restaurant Portal of a grocery-type store.** The sidebar says **Catalog** (instead of Menu) and **Orders & picking** and has no kitchen display; the dashboard says "Being picked".
  * **Catalog** (`/portal/menu`): the Products tab is a paged table (25 at a time) with search (name, brand, SKU, barcode), department and stock filters, the stock of every product **edited in the table** (type a number, Enter),
    low / sold-out counters you can click, **Count stock** (one product per line: `SKU or barcode, quantity`; `+24` = received), **Import CSV**, **Export CSV**, **Add product** and a product editor with SKU, barcode, brand,
    pack size, sold by piece or weight (unit and step), stock counting with a low-stock alert, most per order, age limit, cold chain and tax (zero-rated or standard). Departments replace categories.
    The page loads the light menu structure (`GET /restaurant/menu?items=false`) and the products page by page.
  * **Orders & picking** (`/portal/orders`): the order card of an accepted order is the **picking list**: progress, the ID-check and cold-chain badges, and per line **Found**, **Weighed** (type what the scale says),
    **Out of stock** (asks first) and **Replace...** (search the store's products; the dialog says what the customer pays). Lines show what happened (weighed 0.9 kg, replaced with X, refunded $...).
    "All N found" ticks the products that need no weighing. **Packed: ready for the driver** marks the order ready.
* **Restaurants and cafes** keep the menu screens and the kitchen display exactly as before. The product editor is shared: a restaurant dish gets the same stock / age-limit fields one click away ("Stock, weight, age limit and product codes").
* **Customer website** (`/order`): see `docs/storefront.md` (store type tiles, grocery store pages with departments, search and paging, weighed products, substitution choice, age confirmation, picking progress on the tracking page).

## Settings

`restaurant.requiredDocumentsByType` (JSON), `restaurant.ageRestricted.enabled`, `restaurant.ageRestricted.requireLicence`, `orders.retail.prepBaseMinutes`, `orders.retail.prepSecondsPerUnit`,
`orders.retail.prepMaxMinutes`: all under System, Platform Settings. Commission: System, Commission tiers, `defaultForStoreTypes`.

## Demo data

`npm run seed` adds **Fresh Basket Supermarket** (GROCERY, 10 departments, about 40 products: weighed produce and meat, chilled and frozen goods, one product low and one sold out, beer and wine),
**Seoul Asian Market** (GROCERY, shares a barcode with the supermarket) and **Prime Cut Halal Butcher** (SPECIALTY, no alcohol licence), tags the existing cafes, the bakery and the convenience stores with
their types, and adds the retail cuisines and the Grocery & retail commission tier. Owners: `owner27@`, `owner28@`, `owner29@demo-restaurant.ca` (demo password).

## Tests

* `npx ts-node --transpile-only test/store-types.test.ts`: profiles, filter parsing, weight and basket maths, the status words, stock bookkeeping against a fake database (also runs in CI).
* `node backend/test/store-types-e2e.mjs`: about 170 checks over HTTP: discovery, catalog, portal catalog management, cart and quote, stock, the last-eggs race, picking, ID check at the door, onboarding.
* `node backend/test/openapi-docs-e2e.mjs`: the Swagger page serves the OpenAPI file and says what the exported file says.

## Not in this version

Delivery vehicle matching by basket size (the dispatch scorer already considers item count), automatic expiry of age-restricted listings when a licence lapses, store-type breakdowns in the finance and analytics
screens, per-department tax defaults (set the tax class per product or in the CSV), deposits and eco fees, and a barcode **scanner** screen for the picker (the API takes barcodes; the portal uses the checklist).
