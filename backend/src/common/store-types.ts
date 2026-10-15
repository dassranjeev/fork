import { OrderStatus, StoreType } from './enums';

/**
 * Store types: ONE store entity (the `restaurants` table) serves every kind of food business. The type decides how a location behaves:
 *
 *   FOOD   RESTAURANT, CAFE, BAKERY      made to order: menu, kitchen display, dishes, prep time per dish
 *   RETAIL GROCERY, CONVENIENCE, SPECIALTY   picked from shelves: catalog of products (SKU / barcode / unit / weight / stock), picking list,
 *                                        substitutions, age-restricted goods, large baskets
 *
 * Everything type-specific lives here (labels, defaults, switches) so that the rest of the code asks `profileOf(type)` instead of comparing types.
 * docs/store-types.md describes the behaviour end to end.
 */
export type StoreVertical = 'FOOD' | 'RETAIL';

export interface StoreProfile {
  type: StoreType;
  vertical: StoreVertical;
  /** "Restaurant", "Grocery store" */
  label: string;
  /** "Restaurants", "Grocery stores" (section titles) */
  pluralLabel: string;
  /** products are picked from shelves (picking list, substitutions, stock) instead of cooked */
  retail: boolean;
  /** what an item is called on the menu / in the catalog */
  itemLabel: string;
  itemLabelPlural: string;
  /** what a top-level group is called: "Menu section" / "Department" */
  categoryLabel: string;
  /** the kitchen display is on by default (made-to-order); retail stores use the picking list instead */
  kdsDefault: boolean;
  /** values a NEW location of this type starts with (an owner or admin can change them afterwards) */
  defaults: { prepTimeMin: number; pickupPrepTimeMin: number; deliveryRadiusKm: number; minimumOrder: number; scheduleLeadMin: number; maxOrdersPerSlot: number };
  /** documents a business of this type must upload (used when the platform setting restaurant.requiredDocumentsByType has no entry for the type) */
  requiredDocuments: string[];
  /** longest customer cart this type accepts (lines / units per line) */
  limits: { maxLines: number; maxQtyPerLine: number };
}

const FOOD_DOCS = ['BUSINESS_LICENCE', 'HEALTH_CERTIFICATE', 'VOID_CHEQUE'];
const RETAIL_DOCS = ['BUSINESS_LICENCE', 'FOOD_PREMISES_PERMIT', 'VOID_CHEQUE'];

const food = (type: StoreType, label: string, pluralLabel: string, over: Partial<StoreProfile> = {}): StoreProfile => ({
  type,
  vertical: 'FOOD',
  label,
  pluralLabel,
  retail: false,
  itemLabel: 'dish',
  itemLabelPlural: 'dishes',
  categoryLabel: 'Menu section',
  kdsDefault: true,
  defaults: { prepTimeMin: 20, pickupPrepTimeMin: 15, deliveryRadiusKm: 5, minimumOrder: 0, scheduleLeadMin: 45, maxOrdersPerSlot: 5 },
  requiredDocuments: FOOD_DOCS,
  limits: { maxLines: 40, maxQtyPerLine: 50 },
  ...over,
});

const retail = (type: StoreType, label: string, pluralLabel: string, over: Partial<StoreProfile> = {}): StoreProfile => ({
  type,
  vertical: 'RETAIL',
  label,
  pluralLabel,
  retail: true,
  itemLabel: 'product',
  itemLabelPlural: 'products',
  categoryLabel: 'Department',
  kdsDefault: false,
  defaults: { prepTimeMin: 25, pickupPrepTimeMin: 20, deliveryRadiusKm: 8, minimumOrder: 15, scheduleLeadMin: 90, maxOrdersPerSlot: 10 },
  requiredDocuments: RETAIL_DOCS,
  limits: { maxLines: 150, maxQtyPerLine: 99 },
  ...over,
});

export const STORE_PROFILES: Record<StoreType, StoreProfile> = {
  [StoreType.RESTAURANT]: food(StoreType.RESTAURANT, 'Restaurant', 'Restaurants'),
  [StoreType.CAFE]: food(StoreType.CAFE, 'Cafe', 'Cafes', { defaults: { prepTimeMin: 12, pickupPrepTimeMin: 8, deliveryRadiusKm: 4, minimumOrder: 0, scheduleLeadMin: 30, maxOrdersPerSlot: 8 } }),
  [StoreType.BAKERY]: food(StoreType.BAKERY, 'Bakery', 'Bakeries', { defaults: { prepTimeMin: 15, pickupPrepTimeMin: 10, deliveryRadiusKm: 5, minimumOrder: 0, scheduleLeadMin: 60, maxOrdersPerSlot: 8 } }),
  [StoreType.GROCERY]: retail(StoreType.GROCERY, 'Grocery store', 'Grocery stores', { defaults: { prepTimeMin: 30, pickupPrepTimeMin: 25, deliveryRadiusKm: 8, minimumOrder: 20, scheduleLeadMin: 120, maxOrdersPerSlot: 10 } }),
  [StoreType.CONVENIENCE]: retail(StoreType.CONVENIENCE, 'Convenience store', 'Convenience stores', { defaults: { prepTimeMin: 10, pickupPrepTimeMin: 8, deliveryRadiusKm: 5, minimumOrder: 10, scheduleLeadMin: 30, maxOrdersPerSlot: 10 }, limits: { maxLines: 60, maxQtyPerLine: 50 } }),
  [StoreType.SPECIALTY]: retail(StoreType.SPECIALTY, 'Specialty food store', 'Specialty food stores', { defaults: { prepTimeMin: 20, pickupPrepTimeMin: 15, deliveryRadiusKm: 8, minimumOrder: 15, scheduleLeadMin: 60, maxOrdersPerSlot: 8 }, limits: { maxLines: 80, maxQtyPerLine: 50 } }),
};

export const STORE_TYPES = Object.values(StoreType) as StoreType[];

export const isStoreType = (v: unknown): v is StoreType => typeof v === 'string' && (STORE_TYPES as string[]).includes(v);

/** Profile of a type; unknown / missing types behave like a restaurant (every row created before store types existed). */
export const profileOf = (type?: StoreType | string | null): StoreProfile => (isStoreType(type) ? STORE_PROFILES[type] : STORE_PROFILES[StoreType.RESTAURANT]);

export const isRetail = (type?: StoreType | string | null) => profileOf(type).retail;

/** Parses a list of types from "GROCERY,BAKERY" or a vertical ("food", "retail", "groceries") from a query string; null = no filter, [] = nothing valid asked for. */
export function parseStoreTypeFilter(raw?: string | null, vertical?: string | null): StoreType[] | null {
  const wanted = new Set<StoreType>();
  let asked = false;
  for (const part of String(raw ?? '').split(',').map((s) => s.trim().toUpperCase().replace(/[\s-]+/g, '_')).filter(Boolean)) {
    asked = true;
    const alias: Record<string, StoreType> = { RESTAURANTS: StoreType.RESTAURANT, CAFES: StoreType.CAFE, BAKERIES: StoreType.BAKERY, GROCERIES: StoreType.GROCERY, SUPERMARKET: StoreType.GROCERY, CONVENIENCE_STORE: StoreType.CONVENIENCE, CONVENIENCE_STORES: StoreType.CONVENIENCE, SPECIALTY_FOOD: StoreType.SPECIALTY };
    const t = isStoreType(part) ? part : alias[part];
    if (t) wanted.add(t);
  }
  const v = String(vertical ?? '').trim().toUpperCase();
  if (v) {
    asked = true;
    const group = v === 'FOOD' || v === 'RESTAURANTS' || v === 'FOOD_SERVICE' ? 'FOOD' : v === 'RETAIL' || v === 'GROCERY' || v === 'GROCERIES' || v === 'SHOP' ? 'RETAIL' : null;
    if (group) for (const t of STORE_TYPES) if (STORE_PROFILES[t].vertical === group) wanted.add(t);
  }
  return asked ? [...wanted] : null;
}

/**
 * What the customer reads for an order status. The state machine is the same for every store type; only the words change:
 * a grocery order is "picked" and "packed", a restaurant order is "prepared".
 */
const FOOD_STATUS: Record<OrderStatus, string> = {
  [OrderStatus.PLACED]: 'Order placed',
  [OrderStatus.ACCEPTED]: 'Order accepted',
  [OrderStatus.DRIVER_ASSIGNED]: 'Driver assigned',
  [OrderStatus.PREPARING]: 'Being prepared',
  [OrderStatus.READY]: 'Ready for pickup',
  [OrderStatus.PICKED_UP]: 'Picked up by the driver',
  [OrderStatus.ON_THE_WAY]: 'On the way',
  [OrderStatus.DELIVERED]: 'Delivered',
  [OrderStatus.COLLECTED]: 'Collected',
  [OrderStatus.CANCELLED]: 'Cancelled',
  [OrderStatus.REJECTED]: 'Rejected by the store',
};
const RETAIL_STATUS: Record<OrderStatus, string> = {
  ...FOOD_STATUS,
  [OrderStatus.ACCEPTED]: 'Order confirmed',
  [OrderStatus.PREPARING]: 'Picking your items',
  [OrderStatus.READY]: 'Packed and ready',
};

export const statusLabel = (type: StoreType | string | null | undefined, status: OrderStatus | string): string =>
  (isRetail(type) ? RETAIL_STATUS : FOOD_STATUS)[status as OrderStatus] ?? String(status);

// ------------------------------------------------------------------ catalog units

/** How an item is sold: by the piece (default) or by weight (price per kg / lb, ordered in steps, weighed when picked). */
export type SellBy = 'UNIT' | 'WEIGHT';
export type WeightUnit = 'KG' | 'LB';
export type Temperature = 'AMBIENT' | 'CHILLED' | 'FROZEN';
export type PickStatus = 'PENDING' | 'PICKED' | 'REPLACED' | 'OUT_OF_STOCK';
export type SubstitutionPref = 'ALLOW' | 'REFUND';

export const SELL_BY: SellBy[] = ['UNIT', 'WEIGHT'];
export const WEIGHT_UNITS: WeightUnit[] = ['KG', 'LB'];
export const TEMPERATURES: Temperature[] = ['AMBIENT', 'CHILLED', 'FROZEN'];
export const SUBSTITUTION_PREFS: SubstitutionPref[] = ['ALLOW', 'REFUND'];
/** ages a product may be restricted to (0 = none): Ontario alcohol / tobacco is 19 */
export const MIN_AGES = [0, 18, 19, 21];

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

type Sellable = { sellBy?: SellBy | string | null; weightUnit?: WeightUnit | string | null; stepSize?: number | string | null; price: number | string };

export const isWeighed = (i: Pick<Sellable, 'sellBy'>) => i.sellBy === 'WEIGHT';

/** Weight (in the item's weight unit) of ONE step of a weighed item; 1 for items sold by the piece. */
export const stepOf = (i: Sellable): number => (isWeighed(i) ? Math.max(0.001, round3(Number(i.stepSize ?? 1) || 1)) : 1);

/** Price of one step / one piece (before modifiers): the per-kg price times the step for weighed items. */
export const unitPriceOf = (i: Sellable, base: number = Number(i.price)): number => (isWeighed(i) ? round2(base * stepOf(i)) : round2(base));

/** Estimated weight of `qty` steps, in the item's weight unit. */
export const estimatedWeight = (i: Sellable, qty: number): number => round3(stepOf(i) * qty);

/** "2 x 0.5 kg" / "1.5 lb" for the receipt and the picking list; null for items sold by the piece. */
export function weightLabel(i: Sellable, qty: number, actual?: number | null): string | null {
  if (!isWeighed(i)) return null;
  const unit = String(i.weightUnit ?? 'KG').toLowerCase();
  const w = actual ?? estimatedWeight(i, qty);
  return `${actual != null ? '' : '~'}${+w.toFixed(3)} ${unit}`;
}

/** Stock a line uses up: pieces for UNIT items, weight for weighed items (stock of a weighed item is kept in its weight unit). */
export const stockUse = (i: Sellable, qty: number): number => (isWeighed(i) ? estimatedWeight(i, qty) : qty);

/**
 * Money of a weighed line once it has been weighed: the customer is charged for the estimated weight at most, never more (what the store weighs
 * above the estimate is the store's). Returns the line total (before tax) that stays charged; the difference is refunded.
 */
export function weighedLineTotal(pricePerWeightUnit: number, estimatedWeightQty: number, actualWeightQty: number): number {
  const w = Math.min(Math.max(0, actualWeightQty), estimatedWeightQty);
  return round2(pricePerWeightUnit * w);
}

export interface BasketLine {
  quantity: number;
  sellBy?: string | null;
  weightUnit?: string | null;
  stepSize?: number | string | null;
  temperature?: string | null;
  removed?: boolean;
}

/** What the picker and the driver need to know about a basket: items (pieces, plus one per weighed product), weighed lines, cold chain, rough weight. */
export function basketOf(lines: BasketLine[]) {
  const live = lines.filter((l) => !l.removed);
  let units = 0;
  let weighed = 0;
  let kg = 0;
  for (const l of live) {
    const q = Number(l.quantity) || 0;
    // a weighed product is ONE item to pick (its quantity is a number of weight steps, not pieces)
    units += l.sellBy === 'WEIGHT' ? 1 : q;
    if (l.sellBy === 'WEIGHT') {
      weighed++;
      const w = round3(q * (Number(l.stepSize ?? 1) || 1));
      kg += l.weightUnit === 'LB' ? w * 0.45359237 : w;
    }
  }
  return {
    units,
    lines: live.length,
    weighed,
    chilled: live.filter((l) => l.temperature === 'CHILLED').length,
    frozen: live.filter((l) => l.temperature === 'FROZEN').length,
    estimatedKg: round2(kg),
  };
}

interface RetailViewOrder {
  status: string;
  items?: { pickStatus?: string | null; removed?: boolean }[];
  requiresIdCheck?: boolean;
  minAge?: number;
  meta?: Record<string, any> | null;
  basket?: unknown;
}

/**
 * What every order view (customer detail, tracking, driver, portal) adds for the kind of store the order came from: the status in the store's own words
 * ("Picking your items"), how far picking is, and the ID check (age-restricted products).
 */
export function retailView(order: RetailViewOrder, storeType?: StoreType | string | null) {
  const p = profileOf(storeType);
  const items = order.items ?? [];
  const count = (s: string) => items.filter((i) => i.pickStatus === s).length;
  return {
    storeType: p.type,
    storeTypeLabel: p.label,
    retail: p.retail,
    statusLabel: statusLabel(p.type, order.status),
    /** retail: where the picker is in the basket (null for restaurants) */
    picking: p.retail ? { lines: items.length, picked: count('PICKED'), replaced: count('REPLACED'), outOfStock: count('OUT_OF_STOCK'), pending: items.filter((i) => !i.removed && (i.pickStatus ?? 'PENDING') === 'PENDING').length } : null,
    /** age-restricted products in the order: ID is checked at hand-over (delivery) or at the counter (pickup) */
    idCheck: order.requiresIdCheck ? { required: true, minAge: order.minAge ?? 0, result: (order.meta?.idCheck?.result as string | undefined) ?? null } : null,
    basket: order.basket ?? null,
  };
}
