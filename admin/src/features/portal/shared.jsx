import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@iconify/react/offline";
import { toast } from "react-toastify";
import { errorMessage, http } from "../../lib/api";
import { useFetch } from "../../lib/hooks";
import { useSocketEvent } from "../../lib/socket";
import { EmptyState, ErrorState, Loading, PageHeader } from "../../ui";
import { usePortal } from "./context";
import { ServiceModeBadge } from "./ServiceMode";

/** GET a /restaurant/* path for the selected location (path null = disabled). */
export function usePortalFetch(path, extra, opts) {
  const { restaurantId } = usePortal();
  return useFetch(restaurantId ? path : null, { restaurantId, ...(extra || {}) }, opts);
}

/** http verbs bound to the selected location. */
export function useApi() {
  const { restaurantId } = usePortal();
  return useMemo(() => {
    const config = { params: { restaurantId } };
    return {
      get: (url, params) => http.get(url, { restaurantId, ...(params || {}) }),
      post: (url, body) => http.post(url, body, config),
      patch: (url, body) => http.patch(url, body, config),
      put: (url, body) => http.put(url, body, config),
      del: (url) => http.del(url, config),
      download: (url, params, name) => http.download(url, { restaurantId, ...(params || {}) }, name),
    };
  }, [restaurantId]);
}

/** Run an API action with busy flag + toasts. */
export function useAction() {
  const [busy, setBusy] = useState(null);
  const run = useCallback(async (key, fn, success) => {
    setBusy(key ?? true);
    try {
      const r = await fn();
      if (success) toast.success(success);
      return { ok: true, data: r };
    } catch (e) {
      toast.error(errorMessage(e));
      return { ok: false };
    } finally {
      setBusy(null);
    }
  }, []);
  return { busy, run, isBusy: (k) => busy !== null && (k === undefined || busy === k) };
}

/** Re-run `fn` (debounced) when realtime events for this restaurant arrive. */
export function useRealtimeReload(fn, events = ["order.new", "order.status", "store.updated"]) {
  const t = useRef();
  useSocketEvent(events, () => {
    clearTimeout(t.current);
    t.current = setTimeout(() => fn(), 400);
  });
  useEffect(() => () => clearTimeout(t.current), []);
}

/** Forces a re-render every `ms` (for countdown timers). */
export function useTick(ms = 15000) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

export function LocationSwitcher() {
  const { locations, restaurantId, setRestaurantId } = usePortal();
  if (locations.length < 2) return null;
  return (
    <div className="d-flex align-items-center gap-2">
      <Icon icon="solar:shop-2-outline" className="text-xl text-primary-600" />
      <select className="form-select form-select-sm radius-8 h-40-px w-auto fw-semibold" value={restaurantId || ""} onChange={(e) => setRestaurantId(e.target.value)} aria-label="Location">
        {locations.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Page title row with the location switcher on the right. */
export function PortalPage({ title, subtitle, actions, children }) {
  const { location, locations } = usePortal();
  return (
    <div>
      <PageHeader
        title={title}
        subtitle={subtitle || (locations.length < 2 ? location?.name : undefined)}
        actions={
          <>
            {location?.status === "LIVE" && <ServiceModeBadge mode={location?.serviceMode} />}
            <LocationSwitcher />
            {actions}
          </>
        }
      />
      {children}
    </div>
  );
}

/** Loading / error / empty wrapper around a useFetch state. */
export function Async({ state, children, empty, emptyProps, minHeight = 160 }) {
  const { data, loading, error, reload } = state;
  if (error && !data) return <ErrorState error={error} onRetry={reload} />;
  if (loading && data === null) return <Loading minHeight={minHeight} />;
  if (data === null || data === undefined) return null;
  if (empty && empty(data)) return <EmptyState {...(emptyProps || {})} />;
  return children(data);
}

export const ORDER_TYPE_LABEL = { DELIVERY: "Delivery", PICKUP: "Pickup", DINE_IN: "Dine-in" };
export const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const DAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export const ROLE_LABEL = { OWNER: "Owner", LOCATION_MANAGER: "Location manager", CASHIER: "Cashier", KITCHEN: "Kitchen" };

/** Modifiers as "Large, Extra Cheese". */
export const modifierText = (mods) => (mods || []).map((m) => m.name).join(", ");

/** Default date range helper: last n days as YYYY-MM-DD */
export function isoDay(d) {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
}
export const daysAgo = (n) => isoDay(Date.now() - n * 86400000);
