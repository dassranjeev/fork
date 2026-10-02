import { fmtDate } from "../../lib/format";
import { safeUrl } from "../../lib/safe";
import React from "react";
import { WS_URL } from "../../lib/api";
import { useFetch } from "../../lib/hooks";

/** Date-only strings (YYYY-MM-DD) must not shift with the timezone. */
export function fmtDay(v) {
  if (typeof v === "string" && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(v)) {
    const [y, m, d] = v.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString("en-CA", { year: "numeric", month: "short", day: "numeric" });
  }
  return fmtDate(v);
}

export const DRIVER_STATUSES = ["APPLIED", "DOCS_REVIEW", "BACKGROUND_CHECK", "TRAINING", "APPROVED", "ACTIVE", "SUSPENDED", "DEACTIVATED", "REJECTED"];
export const VEHICLES = ["CAR", "BIKE", "E_BIKE", "SCOOTER", "ON_FOOT"];
export const DOC_TYPES = ["LICENCE", "VEHICLE_REGISTRATION", "INSURANCE", "PHOTO", "WORK_ELIGIBILITY", "BACKGROUND_CHECK", "OTHER"];
export const INCENTIVE_TYPES = ["PEAK_BOOST", "QUEST", "FIRST_WEEK", "WEATHER", "SUPPLY_ALERT"];
export const EXPIRY_REQUIRED = ["LICENCE", "INSURANCE", "VEHICLE_REGISTRATION"];

export const fileHref = (u) => { if (!u) return null; const s = safeUrl(u, ""); if (!s) return null; return /^https?:/i.test(s) ? s : s.startsWith("/") ? `${WS_URL}${s}` : null; };

/** Zones come from the heat-map endpoint (same permission as the rest of this area). */
export function useZones() {
  const { data, loading } = useFetch("/admin/drivers/heat-map");
  const zones = Array.isArray(data) ? data : [];
  const options = zones.map((z) => ({ value: z.zoneId, label: z.zoneName }));
  const nameOf = (id) => zones.find((z) => z.zoneId === id)?.zoneName || "—";
  return { zones, options, nameOf, loading };
}

export function useCities() {
  const { data } = useFetch("/admin/cities");
  const list = data?.data || (Array.isArray(data) ? data : []);
  return { cities: list, options: list.map((c) => ({ value: c.id, label: c.name })) };
}

export function downloadText(filename, text, type = "text/csv") {
  const href = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(href);
}

export const Muted = ({ children }) => <span className="text-secondary-light">{children}</span>;

/** Acceptance colour coding: >=90 good, 70-89 watch, <70 low. */
export const acceptanceTone = (rate) => (Number(rate) >= 90 ? "success" : Number(rate) >= 70 ? "warning" : "danger");
