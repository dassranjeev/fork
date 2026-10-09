/** Small helpers shared by the bell, the notifications page and the toasts. */
export const CATEGORY_ICON = {
  orders: "receipt-line",
  delivery: "riding-line",
  payments: "bank-card-line",
  support: "customer-service-2-line",
  promotions: "price-tag-3-line",
  system: "information-line",
};
export const categoryIcon = (c) => CATEGORY_ICON[c] || "notification-3-line";

/** customer-facing names of the categories (the API keys stay the same) */
export const CATEGORY_LABEL = {
  orders: "Orders",
  delivery: "Delivery",
  payments: "Payments",
  support: "Support",
  promotions: "Offers",
  system: "Account",
};
export const CATEGORY_KEYS = ["orders", "delivery", "payments", "support", "promotions", "system"];

/** "just now", "5 min ago", "3 h ago", "Yesterday", "Oct 4" */
export function timeAgo(iso, now = Date.now()) {
  const t = new Date(iso).getTime();
  if (!iso || Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 172800) return "Yesterday";
  try {
    return new Date(t).toLocaleDateString("en-CA", { month: "short", day: "numeric", timeZone: "America/Toronto" });
  } catch {
    return new Date(t).toLocaleDateString();
  }
}

/** Deep links of a notification may only lead inside the customer website. */
export function sfNotifyUrl(u) {
  if (typeof u !== "string" || !/^\/order(\/|\?|#|$)/.test(u) || u.startsWith("//") || /[\r\n\\]/.test(u)) return "/order/notifications";
  return u;
}
