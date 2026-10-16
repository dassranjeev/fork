/**
 * Unit tests for the store type rules (no server, no database): the profile of each kind of store, the store type filter parser, the grocery maths
 * (products sold by weight, what a weighed line costs once weighed, the basket summary, status words) and the retail service's stock bookkeeping with a fake
 * repository. Docs: docs/store-types.md.
 *
 *   cd backend && npx ts-node --transpile-only test/store-types.test.ts
 *
 * Prints PASS / FAIL per check and exits 1 on any FAIL.
 */
import 'reflect-metadata';
import { OrderStatus, StoreType } from '../src/common/enums';
import {
  STORE_PROFILES,
  STORE_TYPES,
  basketOf,
  estimatedWeight,
  isRetail,
  parseStoreTypeFilter,
  profileOf,
  retailView,
  statusLabel,
  stepOf,
  stockUse,
  unitPriceOf,
  weighedLineTotal,
  weightLabel,
} from '../src/common/store-types';
import { RetailService } from '../src/orders/retail.service';
import { MAX_GALLERY_IMAGES, cleanGallery, cleanImageUrl } from '../src/common/image-url';
import { DEMO_STORE_ACCOUNT_DOMAIN } from '../src/restaurants/restaurants.seed';

let failed = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ------------------------------------------------------------------ the accounts of the demo stores
// the production API refuses to start while any account matches these patterns (main.ts, productionDbGate): the demo stores of a live site must never match them
check('demo store accounts never match the production start-up check (a live API would refuse to restart)', ['owner27', 'manager27', 'cashier27', 'kitchen27', 'owner29'].every((u) => !/@demo\.forky\.ca$|@demo-restaurant\.ca$/i.test(`${u}@${DEMO_STORE_ACCOUNT_DOMAIN}`)) && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(DEMO_STORE_ACCOUNT_DOMAIN), DEMO_STORE_ACCOUNT_DOMAIN);

// ------------------------------------------------------------------ photo addresses of menu items
const refused = (fn: () => unknown) => {
  try {
    fn();
    return false;
  } catch (e: any) {
    return e?.response?.code === 'INVALID_IMAGE_URL' || e?.response?.code === 'TOO_MANY_IMAGES';
  }
};
check('photo address: an upload of ours (relative or with the host) and an https picture are accepted', cleanImageUrl('/uploads/0b9f.jpg') === '/uploads/0b9f.jpg' && cleanImageUrl('http://localhost:4000/uploads/0b9f.PNG') === 'http://localhost:4000/uploads/0b9f.PNG' && cleanImageUrl('https://cdn.example.com/p?w=400') === 'https://cdn.example.com/p?w=400');
check('photo address: javascript:, data:, ftp:, protocol-relative, logins, spaces, path climbing and plain text are refused', ['javascript:alert(1)', 'data:image/png;base64,AAAA', 'ftp://x.com/a.png', '//evil.com/a.png', 'https://u:p@x.com/a.png', 'https://x.com/a b.png', '/uploads/../a.png', 'hello', '', '   '].every((u) => refused(() => cleanImageUrl(u))));
check('photo address: our uploads must be JPG, PNG, WebP or GIF (HEIC and PDF cannot be shown)', refused(() => cleanImageUrl('/uploads/a.heic')) && refused(() => cleanImageUrl('/uploads/a.pdf')) && refused(() => cleanImageUrl('/uploads/a.csv')) && !refused(() => cleanImageUrl('/uploads/a.webp')) && !refused(() => cleanImageUrl('/uploads/a.gif')));
check('photo address: not text, or longer than 500 characters, is refused', refused(() => cleanImageUrl(42)) && refused(() => cleanImageUrl(null)) && refused(() => cleanImageUrl('https://x.com/' + 'a'.repeat(500))));
check('gallery: cleaned, without repeats and without the featured photo, in order', eq(cleanGallery(['/uploads/a.jpg', '/uploads/b.jpg', '/uploads/a.jpg', '/uploads/f.jpg'], '/uploads/f.jpg'), ['/uploads/a.jpg', '/uploads/b.jpg']));
check('gallery: nothing or null is an empty gallery; a non-list is refused', eq(cleanGallery(undefined), []) && eq(cleanGallery(null), []) && refused(() => cleanGallery('/uploads/a.jpg')));
check(`gallery: at most ${MAX_GALLERY_IMAGES} photos`, cleanGallery(Array.from({ length: MAX_GALLERY_IMAGES }, (_, i) => `/uploads/${i}.jpg`)).length === MAX_GALLERY_IMAGES && refused(() => cleanGallery(Array.from({ length: MAX_GALLERY_IMAGES + 1 }, (_, i) => `/uploads/${i}.jpg`))));
check('gallery: a bad address says which entry it is', (() => { try { cleanGallery(['/uploads/a.jpg', 'javascript:1']); return false; } catch (e: any) { return /galleryUrls\[1\]/.test(e?.response?.message || ''); } })());

// ------------------------------------------------------------------ profiles
check('six kinds of store', STORE_TYPES.length === 6 && STORE_TYPES.every((t) => STORE_PROFILES[t].type === t));
check('restaurant, cafe and bakery are food service; grocery, convenience and specialty are retail', [StoreType.RESTAURANT, StoreType.CAFE, StoreType.BAKERY].every((t) => !isRetail(t) && profileOf(t).vertical === 'FOOD') && [StoreType.GROCERY, StoreType.CONVENIENCE, StoreType.SPECIALTY].every((t) => isRetail(t) && profileOf(t).vertical === 'RETAIL'));
check('retail stores sell products by department, restaurants dishes by menu section', profileOf(StoreType.GROCERY).itemLabel === 'product' && profileOf(StoreType.GROCERY).categoryLabel === 'Department' && profileOf(StoreType.RESTAURANT).itemLabel === 'dish' && profileOf(StoreType.RESTAURANT).categoryLabel === 'Menu section');
check('only made-to-order stores start with the kitchen display', profileOf(StoreType.RESTAURANT).kdsDefault && profileOf(StoreType.BAKERY).kdsDefault && !profileOf(StoreType.GROCERY).kdsDefault && !profileOf(StoreType.CONVENIENCE).kdsDefault);
check('bigger baskets for groceries (99 per line, 150 lines) than restaurants (50, 40)', profileOf(StoreType.GROCERY).limits.maxQtyPerLine === 99 && profileOf(StoreType.GROCERY).limits.maxLines === 150 && profileOf(StoreType.RESTAURANT).limits.maxQtyPerLine === 50 && profileOf(StoreType.RESTAURANT).limits.maxLines === 40);
check('a missing or unknown type behaves like a restaurant (rows from before store types)', profileOf(null).type === StoreType.RESTAURANT && profileOf(undefined).type === StoreType.RESTAURANT && profileOf('WAREHOUSE').type === StoreType.RESTAURANT && !isRetail('WAREHOUSE'));
check('retail stores are asked for a food premises permit instead of a health certificate', profileOf(StoreType.GROCERY).requiredDocuments.includes('FOOD_PREMISES_PERMIT') && !profileOf(StoreType.GROCERY).requiredDocuments.includes('HEALTH_CERTIFICATE') && profileOf(StoreType.RESTAURANT).requiredDocuments.includes('HEALTH_CERTIFICATE'));

// ------------------------------------------------------------------ filter parser
check('no filter given means no filter (null)', parseStoreTypeFilter(undefined, undefined) === null && parseStoreTypeFilter('', '') === null);
check('a list of types', eq(parseStoreTypeFilter('grocery, bakery')?.sort(), [StoreType.BAKERY, StoreType.GROCERY].sort()));
check('plural and friendly names are understood (groceries, supermarket, convenience-store)', eq(parseStoreTypeFilter('groceries')?.sort(), ['GROCERY']) && eq(parseStoreTypeFilter('supermarket'), ['GROCERY']) && eq(parseStoreTypeFilter('convenience-store'), ['CONVENIENCE']));
check('vertical RETAIL = grocery, convenience, specialty', eq(parseStoreTypeFilter(null, 'retail')?.sort(), ['CONVENIENCE', 'GROCERY', 'SPECIALTY']));
check('vertical FOOD = restaurant, cafe, bakery', eq(parseStoreTypeFilter(null, 'food')?.sort(), ['BAKERY', 'CAFE', 'RESTAURANT']));
check('something unknown matches NOTHING (empty list), never everything', eq(parseStoreTypeFilter('nonsense'), []) && eq(parseStoreTypeFilter(null, 'nonsense'), []));
check('types and a vertical add up', eq(parseStoreTypeFilter('cafe', 'retail')?.sort(), ['CAFE', 'CONVENIENCE', 'GROCERY', 'SPECIALTY']));

// ------------------------------------------------------------------ weighed products
const bananas = { sellBy: 'WEIGHT', weightUnit: 'KG', stepSize: 0.5, price: 2.18 };
const apples = { sellBy: 'WEIGHT', weightUnit: 'LB', stepSize: 0.25, price: 3.99 };
const milk = { sellBy: 'UNIT', weightUnit: 'KG', stepSize: 1, price: 5.49 };
check('a piece product: one unit costs the price, step 1', unitPriceOf(milk) === 5.49 && stepOf(milk) === 1 && estimatedWeight(milk, 3) === 3 && weightLabel(milk, 3) === null);
check('a weighed product: the price is per kg, one step is half a kilo (2.18 -> 1.09)', unitPriceOf(bananas) === 1.09 && stepOf(bananas) === 0.5);
check('rounding of a step price is to the cent (3.99 per lb x 0.25 = 1.00)', unitPriceOf(apples) === 1);
check('estimated weight of 3 steps of 0.5 kg = 1.5 kg', estimatedWeight(bananas, 3) === 1.5 && weightLabel(bananas, 3) === '~1.5 kg');
check('a weighed line shows the real weight once weighed (no tilde)', weightLabel(bananas, 2, 0.9) === '0.9 kg' && weightLabel(apples, 4) === '~1 lb');
check('what a line takes from the shelf: pieces, or weight for weighed products', stockUse(milk, 4) === 4 && stockUse(bananas, 4) === 2 && stockUse(apples, 4) === 1);
check('a missing step on a weighed product cannot divide by zero (minimum 0.001)', stepOf({ sellBy: 'WEIGHT', stepSize: 0, price: 1 }) >= 0.001);
check('base price can be overridden (pickup price)', unitPriceOf(bananas, 2) === 1);
check('weighed lighter: the customer pays for the weight, the rest is refunded', weighedLineTotal(2.18, 1, 0.9) === 1.96 && weighedLineTotal(2.18, 1, 0.5) === 1.09);
check('weighed heavier: never more than the estimate', weighedLineTotal(2.18, 1, 1.3) === 2.18 && weighedLineTotal(2.18, 1, 1) === 2.18);
check('weighed at nothing or less: nothing is charged', weighedLineTotal(2.18, 1, 0) === 0 && weighedLineTotal(2.18, 1, -3) === 0);

// ------------------------------------------------------------------ basket + words
const basket = basketOf([
  { quantity: 2, sellBy: 'WEIGHT', weightUnit: 'KG', stepSize: 0.5, temperature: 'AMBIENT' },
  { quantity: 4, sellBy: 'WEIGHT', weightUnit: 'LB', stepSize: 0.5, temperature: 'CHILLED' },
  { quantity: 3, sellBy: 'UNIT', temperature: 'FROZEN' },
  { quantity: 5, sellBy: 'UNIT', temperature: 'CHILLED' },
  { quantity: 9, sellBy: 'UNIT', removed: true },
]);
check('basket: items (pieces + one per weighed product), lines, weighed lines, cold chain lines', basket.units === 10 && basket.lines === 4 && basket.weighed === 2 && basket.chilled === 2 && basket.frozen === 1, basket);
check('basket: rough weight in kg (1 kg + 2 lb = 1.91 kg)', basket.estimatedKg === 1.91, basket.estimatedKg);
check('basket of nothing', basketOf([]).units === 0 && basketOf([]).estimatedKg === 0);
check('a grocery order is "picked" and "packed", a restaurant order is "prepared"', statusLabel(StoreType.GROCERY, OrderStatus.PREPARING) === 'Picking your items' && statusLabel(StoreType.GROCERY, OrderStatus.READY) === 'Packed and ready' && statusLabel(StoreType.RESTAURANT, OrderStatus.PREPARING) === 'Being prepared' && statusLabel(StoreType.CAFE, OrderStatus.READY) === 'Ready for pickup');
check('the words common to every store do not change', statusLabel(StoreType.GROCERY, OrderStatus.DELIVERED) === 'Delivered' && statusLabel(StoreType.GROCERY, OrderStatus.CANCELLED) === 'Cancelled');
check('an unknown status is shown as it is', statusLabel(StoreType.GROCERY, 'WEIRD') === 'WEIRD');
const view = retailView(
  { status: 'PREPARING', items: [{ pickStatus: 'PICKED' }, { pickStatus: 'REPLACED' }, { pickStatus: 'OUT_OF_STOCK', removed: true }, { pickStatus: 'PENDING' }], requiresIdCheck: true, minAge: 19, meta: { idCheck: { result: 'CHECKED' } } },
  StoreType.GROCERY,
);
check('order view of a grocery order: picking progress and ID check', view.retail === true && eq(view.picking, { lines: 4, picked: 1, replaced: 1, outOfStock: 1, pending: 1 }) && eq(view.idCheck, { required: true, minAge: 19, result: 'CHECKED' }) && view.statusLabel === 'Picking your items', view);
const plain = retailView({ status: 'PLACED', items: [] }, StoreType.RESTAURANT);
check('order view of a restaurant order: no picking, no ID check', plain.picking === null && plain.idCheck === null && plain.retail === false);

// ------------------------------------------------------------------ stock bookkeeping with a fake database
type Row = { id: string; name: string; restaurantId: string; trackStock: boolean; stockQty: number | null; lowStockThreshold: number | null; sellBy: string; weightUnit: string };
const shelf = new Map<string, Row>();
const put = (r: Partial<Row> & { id: string }) => shelf.set(r.id, { name: r.id, restaurantId: 'R1', trackStock: true, stockQty: 10, lowStockThreshold: null, sellBy: 'UNIT', weightUnit: 'KG', ...r });
const alerts: any[] = [];
const fakeMenu = {
  // mimics the two UPDATE statements RetailService runs; $1 = id, $2 = quantity
  query: async (sqlText: string, p: any[]) => {
    const row = shelf.get(p[0]);
    if (/SET "stockQty" = "stockQty" - \$2/.test(sqlText)) {
      if (!row || !row.trackStock || (row.stockQty ?? 0) < p[1]) return [[], 0];
      row.stockQty = Math.round(((row.stockQty ?? 0) - p[1]) * 1000) / 1000;
      return [[{ id: row.id, name: row.name, restaurantId: row.restaurantId, stockQty: String(row.stockQty), lowStockThreshold: row.lowStockThreshold == null ? null : String(row.lowStockThreshold) }], 1];
    }
    if (/COALESCE\("stockQty", 0\) \+ \$2/.test(sqlText)) {
      if (row?.trackStock) row.stockQty = Math.round(((row.stockQty ?? 0) + p[1]) * 1000) / 1000;
      return [[], row ? 1 : 0];
    }
    throw new Error('unexpected sql ' + sqlText);
  },
  findOne: async ({ where }: any) => shelf.get(where.id) ?? null,
};
const svc = new RetailService({} as any, {} as any, {} as any, fakeMenu as any, {} as any, { notifyRestaurant: async (...a: any[]) => alerts.push(a) } as any, {} as any);

(async () => {
  put({ id: 'milk', stockQty: 10 });
  put({ id: 'bananas', stockQty: 5, sellBy: 'WEIGHT' });
  put({ id: 'untracked', trackStock: false, stockQty: null });
  put({ id: 'eggs', stockQty: 3, lowStockThreshold: 5, name: 'Eggs' });

  let res = await svc.reserve([
    { menuItemId: 'milk', quantity: 2 },
    { menuItemId: 'milk', quantity: 1 },
    { menuItemId: 'bananas', quantity: 4, sellBy: 'WEIGHT', weightUnit: 'KG', stepSize: 0.5 },
    { menuItemId: 'untracked', quantity: 50 },
  ]);
  check('reserve takes the total of the lines of one product (2 + 1 milk) and weight for weighed products (4 steps of 0.5 kg = 2 kg)', shelf.get('milk')!.stockQty === 7 && shelf.get('bananas')!.stockQty === 3 && res.length === 2, { milk: shelf.get('milk')!.stockQty, bananas: shelf.get('bananas')!.stockQty });
  check('products without stock tracking are not touched and never refuse', shelf.get('untracked')!.stockQty === null);
  await svc.release(res);
  check('release gives everything back', shelf.get('milk')!.stockQty === 10 && shelf.get('bananas')!.stockQty === 5);

  let refused: any = null;
  try {
    await svc.reserve([{ menuItemId: 'milk', quantity: 4 }, { menuItemId: 'eggs', quantity: 4 }]);
  } catch (e) {
    refused = e;
  }
  check('too little left on one product refuses the whole order (INSUFFICIENT_STOCK) and gives back what was already taken', refused?.response?.code === 'INSUFFICIENT_STOCK' && shelf.get('milk')!.stockQty === 10 && shelf.get('eggs')!.stockQty === 3, { code: refused?.response?.code, milk: shelf.get('milk')!.stockQty });
  check('the refusal names the product and how many are left', /Only 3 of "Eggs" left/.test(refused?.response?.message ?? ''), refused?.response);

  put({ id: 'cereal', stockQty: 7, lowStockThreshold: 5, name: 'Cereal' });
  alerts.length = 0;
  await svc.reserve([{ menuItemId: 'cereal', quantity: 3 }]);
  check('the store is told once when a product runs low (this order takes it across its threshold of 5: 7 -> 4)', alerts.length === 1 && alerts[0][1] === 'stock.low' && alerts[0][2].item === 'Cereal' && alerts[0][2].left === '4', alerts);
  alerts.length = 0;
  await svc.reserve([{ menuItemId: 'cereal', quantity: 1 }]);
  check('...and not again for every order after that', alerts.length === 0, alerts);
  await svc.reserve([{ menuItemId: 'cereal', quantity: 3 }]);
  check('the last one can be taken (stock 0, never negative)', shelf.get('cereal')!.stockQty === 0);

  // two orders at the same time for the last 3 of a product: only one gets them
  put({ id: 'last', stockQty: 3 });
  const outcomes = await Promise.allSettled([svc.reserve([{ menuItemId: 'last', quantity: 2 }]), svc.reserve([{ menuItemId: 'last', quantity: 2 }])]);
  check('two orders for 2 of the last 3: exactly one wins', outcomes.filter((o) => o.status === 'fulfilled').length === 1 && shelf.get('last')!.stockQty === 1, { stock: shelf.get('last')!.stockQty });

  // restoring a cancelled order
  put({ id: 'rep', stockQty: 4 });
  put({ id: 'gone', stockQty: 0 });
  const order = {
    id: 'o1',
    items: [
      { menuItemId: 'milk', quantity: 2, sellBy: 'UNIT', weightUnit: 'KG', stepSize: 1, removed: false, pickStatus: 'PENDING' },
      { menuItemId: 'bananas', quantity: 2, sellBy: 'WEIGHT', weightUnit: 'KG', stepSize: 0.5, removed: false, pickStatus: 'PICKED' },
      { menuItemId: 'gone', quantity: 1, sellBy: 'UNIT', weightUnit: 'KG', stepSize: 1, removed: true, pickStatus: 'OUT_OF_STOCK' },
      { menuItemId: 'untracked', quantity: 1, sellBy: 'UNIT', weightUnit: 'KG', stepSize: 1, removed: false, pickStatus: 'REPLACED', replacement: { menuItemId: 'rep', quantity: 3 } },
    ],
  } as any;
  const milk0 = shelf.get('milk')!.stockQty!;
  const ban0 = shelf.get('bananas')!.stockQty!;
  await svc.restoreFor(order);
  check('a cancelled order puts pieces and weight back (milk +2, bananas +1 kg)', shelf.get('milk')!.stockQty === milk0 + 2 && shelf.get('bananas')!.stockQty === ban0 + 1);
  check('...a product found out of stock stays at zero', shelf.get('gone')!.stockQty === 0);
  check('...a replaced line gives back the replacement it took, not the original', shelf.get('rep')!.stockQty === 7, shelf.get('rep')!.stockQty);

  console.log(failed ? `\n${failed} check(s) FAILED` : '\nall store type checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('CRASH', e);
  process.exit(2);
});
