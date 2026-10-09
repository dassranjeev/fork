import React, { createContext, useContext, useEffect, useState } from "react";
import { Icon } from "@iconify/react/offline";
import { timeAgo } from "../../lib/format";
import { usePushState } from "../../lib/notify";

/** Category -> label, icon and badge tone (keys match backend notifications/events.ts CATEGORIES). */
export const CATEGORY_META = {
  orders: { label: "Orders", icon: "solar:bag-check-outline", tone: "primary" },
  delivery: { label: "Delivery", icon: "solar:delivery-outline", tone: "info" },
  payments: { label: "Payments", icon: "solar:wallet-money-outline", tone: "success" },
  support: { label: "Support", icon: "solar:chat-round-dots-outline", tone: "warning" },
  promotions: { label: "Promotions", icon: "solar:tag-price-outline", tone: "purple" },
  system: { label: "System", icon: "solar:bell-bing-outline", tone: "neutral" },
};
export const CATEGORY_KEYS = Object.keys(CATEGORY_META);
const TONE_BG = {
  primary: "bg-primary-100 text-primary-600",
  info: "bg-info-100 text-info-600",
  success: "bg-success-100 text-success-600",
  warning: "bg-warning-100 text-warning-600",
  purple: "bg-lilac-100 text-lilac-600",
  neutral: "bg-neutral-200 text-secondary-light",
};

/** round category icon (decorative: the category is also written as text next to it) */
export function CategoryIcon({ category, size = 36 }) {
  const m = CATEGORY_META[category] || CATEGORY_META.system;
  return (
    <span className={`rounded-circle d-inline-flex align-items-center justify-content-center flex-shrink-0 ${TONE_BG[m.tone]}`} style={{ width: size, height: size }} aria-hidden="true">
      <Icon icon={m.icon} style={{ fontSize: size * 0.55 }} />
    </span>
  );
}

/** "just now", "5 min ago" ... */
export function relTime(v) {
  if (!v) return "";
  const diff = Date.now() - new Date(v).getTime();
  if (Number.isNaN(diff)) return "";
  return diff < 45000 ? "just now" : timeAgo(v);
}

/** re-render every minute so relative times stay fresh */
export function useMinuteTick() {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((n) => n + 1), 60000);
    return () => clearInterval(t);
  }, []);
}

/** shared, safe localStorage helpers (private windows / blocked storage must never break the UI) */
export const ls = {
  get(k) {
    try {
      return window.localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      window.localStorage.setItem(k, v);
    } catch {
      /* ignore */
    }
  },
};

// ------------------------------------------------------------------------------------------------ shared push state
const PushCtx = createContext(null);

/** ONE push state for the whole shell (bell, banner, settings page) instead of one set of requests per component. */
export function PushHost({ children }) {
  const p = usePushState();
  const { reload } = p;
  useEffect(() => {
    const onVis = () => document.visibilityState === "visible" && reload();
    document.addEventListener("visibilitychange", onVis);
    // the user may change the site permission in the browser UI while the page is open
    let status = null;
    try {
      if (navigator.permissions?.query) {
        navigator.permissions
          .query({ name: "notifications" })
          .then((s) => {
            status = s;
            s.onchange = () => reload();
          })
          .catch(() => undefined);
      }
    } catch {
      /* not supported */
    }
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      if (status) status.onchange = null;
    };
  }, [reload]);
  return <PushCtx.Provider value={p}>{children}</PushCtx.Provider>;
}

export function useSharedPush() {
  return useContext(PushCtx) || { state: null, busy: false, error: null, reload() {}, enable: async () => undefined, disable: async () => undefined, push: null };
}

/**
 * What to tell the user about browser notifications on THIS device. Returns null when everything is fine (or unknown).
 *   { kind, tone, title, text, cta?: "enable" | "link", dismissible }
 * kind: ask | other | denied | unsupported | insecure | ios | off
 */
export function pushAdvice(state, app) {
  if (!state) return null;
  const restaurant = app === "restaurant";
  const sup = state.support || { ok: false };
  if (!sup.ok) {
    if (sup.reason === "insecure") return { kind: "insecure", tone: "warning", title: "Notifications need a secure connection", text: "Open FORKSY over https to turn on notifications. You still see every alert inside the app.", dismissible: true };
    if (sup.reason === "ios-install") return { kind: "ios", tone: "info", title: "Add FORKSY to your Home Screen first", text: sup.message, dismissible: true };
    return { kind: "unsupported", tone: "neutral", title: "This browser cannot show background notifications", text: `${sup.message || "Your browser does not support push notifications."} You still see every alert inside the app.`, dismissible: true };
  }
  if (state.config && !state.config.enabled && !state.browserSubscribed) {
    return { kind: "off", tone: "neutral", title: "Browser notifications are switched off by FORKSY", text: "You will still see every alert inside the app. They will work here again as soon as FORKSY switches them back on.", dismissible: true };
  }
  if (state.permission === "denied") {
    return {
      kind: "denied",
      tone: "warning",
      title: "Notifications are blocked in this browser",
      text: "To turn them on, click the lock (or settings) icon next to the address bar, set Notifications to Allow, then reload this page.",
      dismissible: true,
    };
  }
  if (state.otherAccount) {
    return { kind: "other", tone: "warning", title: "Notifications on this browser belong to another account", text: "Someone else used notifications on this browser. Turn them on for your account to receive your alerts here.", cta: "enable", ctaLabel: "Use for my account", dismissible: true };
  }
  if (state.on) return null;
  return {
    kind: "ask",
    tone: "primary",
    title: restaurant ? "Get new-order alerts even when this tab is closed" : "Get alerts for orders, support and incidents, even when this tab is closed",
    text: "Turn on notifications on this device. Your browser will ask for permission when you click the button.",
    cta: "enable",
    ctaLabel: "Turn on notifications",
    dismissible: true,
  };
}
