/** Formatting helpers + status colour maps shared by every screen. */

const cad = new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" });
export const money = (v) => (v === null || v === undefined || v === "" ? "—" : cad.format(Number(v)));
export const num = (v, d = 0) =>
  v === null || v === undefined || v === "" ? "—" : Number(v).toLocaleString("en-CA", { maximumFractionDigits: d });
export const pct = (v, d = 1) => (v === null || v === undefined ? "—" : `${Number(v).toFixed(d)}%`);
export const compact = (v) =>
  v === null || v === undefined ? "—" : new Intl.NumberFormat("en-CA", { notation: "compact", maximumFractionDigits: 1 }).format(Number(v));

export function fmtDate(v, opts) {
  if (!v) return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleDateString("en-CA", { year: "numeric", month: "short", day: "numeric", ...opts });
}
export function fmtDateTime(v) {
  if (!v) return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleString("en-CA", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
export function fmtTime(v) {
  if (!v) return "—";
  return new Date(v).toLocaleTimeString("en-CA", { hour: "2-digit", minute: "2-digit" });
}
/** "5 min ago", "in 3 h" */
export function timeAgo(v) {
  if (!v) return "—";
  const diff = (new Date(v).getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  const unit = abs < 60 ? [Math.round(abs), "s"] : abs < 3600 ? [Math.round(abs / 60), "min"] : abs < 86400 ? [Math.round(abs / 3600), "h"] : [Math.round(abs / 86400), "d"];
  return diff < 0 ? `${unit[0]} ${unit[1]} ago` : `in ${unit[0]} ${unit[1]}`;
}
export function minutesBetween(a, b = new Date()) {
  if (!a) return null;
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000);
}
export const titleCase = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
export const initials = (name = "") =>
  name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("");
export const fullName = (u) => (u ? [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email || u.phone || "—" : "—");

/** bootstrap-ish colour tokens used by <StatusBadge>: success | warning | danger | info | primary | neutral | purple */
export const STATUS_COLORS = {
  // orders
  PLACED: "info",
  ACCEPTED: "primary",
  DRIVER_ASSIGNED: "purple",
  PREPARING: "warning",
  READY: "success",
  PICKED_UP: "purple",
  ON_THE_WAY: "primary",
  DELIVERED: "success",
  COLLECTED: "success",
  CANCELLED: "danger",
  REJECTED: "danger",
  // generic
  ACTIVE: "success",
  LIVE: "success",
  APPROVED: "success",
  PAID: "success",
  RESOLVED: "success",
  CLOSED: "neutral",
  COMPLETED: "success",
  SENT: "success",
  CLEAR: "success",
  PENDING: "warning",
  PENDING_APPROVAL: "warning",
  APPLIED: "info",
  DOCS_REVIEW: "warning",
  MENU_SETUP: "warning",
  TEST_ORDER: "warning",
  BACKGROUND_CHECK: "warning",
  TRAINING: "warning",
  OPEN: "info",
  DRAFT: "neutral",
  SCHEDULED: "info",
  PAUSED: "warning",
  SUSPENDED: "danger",
  BLOCKED: "danger",
  DEACTIVATED: "danger",
  DELETED: "neutral",
  EXPIRED: "danger",
  FAILED: "danger",
  ESCALATED: "danger",
  ON_HOLD: "warning",
  LOCKED: "warning",
  RELEASED: "primary",
  AUTHORIZED: "info",
  CAPTURED: "success",
  REFUNDED: "danger",
  PARTIALLY_REFUNDED: "warning",
  HIGH: "danger",
  URGENT: "danger",
  NORMAL: "info",
  LOW: "neutral",
  P1: "danger",
  P2: "warning",
  P3: "info",
};
export const statusColor = (s) => STATUS_COLORS[String(s).toUpperCase()] || "neutral";

export const ORDER_STATUSES = ["PLACED", "ACCEPTED", "DRIVER_ASSIGNED", "PREPARING", "READY", "PICKED_UP", "ON_THE_WAY", "DELIVERED", "COLLECTED", "CANCELLED", "REJECTED"];

export const toQuery = (obj) =>
  Object.entries(obj || {})
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
