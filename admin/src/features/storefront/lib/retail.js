import { money } from "./sfApi";

/**
 * Helpers for grocery / convenience / specialty stores (products, weights, stock, substitutions, age checks).
 * See docs/store-types.md. Everything here is display logic: the API decides what is allowed.
 */

export const isWeighed = (x) => x?.sellBy === "WEIGHT";

const num = (n) => +Number(n).toFixed(3); // 0.5, 1, 1.5 (no trailing zeros)
const step = (x) => Number(x?.stepSize) || 1;

/** "kg" / "lb" */
export const unitOf = (x) => String(x?.weightUnit || "KG").toLowerCase();
/** the weight of `qty` steps: "0.5 kg", "1.5 kg" */
export const weightText = (x, qty) => `${num(qty * step(x))} ${unitOf(x)}`;
/** the weight of one step: "0.5 kg" */
export const stepText = (x) => `${num(step(x))} ${unitOf(x)}`;
/** "$2.18 / kg" (the product price of a weighed product is per weight unit) */
export const perUnitPrice = (x) => `${money(x.price)} / ${unitOf(x)}`;
/** price of one step of a weighed product (the API sends it as stepPrice; this is the fallback) */
export const stepPriceOf = (x) => (x.stepPrice != null ? Number(x.stepPrice) : Math.round(Number(x.price) * step(x) * 100) / 100);
/** price of one unit in the cart: one piece, or one step for weighed products */
export const unitPriceOf = (x) => (isWeighed(x) ? stepPriceOf(x) : Number(x.price));

const REASONS = { OUT_OF_STOCK: "Sold out", NOT_SERVED_NOW: "Not served now" };

/** The stock badge of a product: sold out, unavailable, or low stock ("Only 3 left"). null when there is nothing to say. */
export function stockBadge(item) {
  if (item.inStock === false) return { tone: "danger", text: "Sold out" };
  if (item.available === false) return { tone: "danger", text: REASONS[item.unavailableReason] || "Unavailable" };
  if (item.lowStock) {
    // maxQuantity is the smaller of the stock and the per-order limit: it only says how many are left when the stock is the smaller one.
    // For weighed products it counts steps, not pieces, so it is not shown as a number.
    const stockIsTheLimit = item.maxPerOrder == null || item.maxQuantity < item.maxPerOrder;
    if (!isWeighed(item) && stockIsTheLimit && item.maxQuantity > 0) return { tone: "warn", text: `Only ${item.maxQuantity} left` };
    return { tone: "warn", text: "Low stock" };
  }
  return null;
}

/** Cold chain badge for chilled / frozen products. */
export const coldChain = (item) => (item.temperature === "CHILLED" ? { icon: "temp-cold-line", text: "Chilled" } : item.temperature === "FROZEN" ? { icon: "snowflake-line", text: "Frozen" } : null);

export const SUBSTITUTION_CHOICES = [
  { value: "ALLOW", label: "Replace it with the best match", short: "Replace with best match" },
  { value: "REFUND", label: "Refund it", short: "Refund it" },
];

export const ageNotice = (minAge) => `You must be ${minAge || 19} to order this. ID is checked at your door.`;

/** Short name for a store's kind on cards: only retail stores get a badge (restaurants stay as they were). */
export const storeBadge = (r) => (r?.retail ? r.storeTypeLabel || r.store?.label || "Store" : "");

/** "2 products, about 1.5 kg" from the basket summary the API sends with the cart / quote / order. */
export function basketText(b) {
  if (!b || !b.lines) return "";
  const parts = [`${b.lines} ${b.lines === 1 ? "product" : "products"}`];
  if (b.estimatedKg > 0) parts.push(`about ${num(b.estimatedKg)} kg weighed`);
  return parts.join(", ");
}

/** What the customer reads for an order status: the API's statusLabel ("Picking your items") when it sends one, else the status word. */
export const statusWords = (o) => o.statusLabel || String(o.status || "").replace(/_/g, " ");
