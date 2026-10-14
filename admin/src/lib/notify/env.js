/**
 * Environment detection for browser push. Nothing here asks for a permission.
 * support(): { ok, reason, message } where reason is one of
 *   ok | insecure | no-service-worker | no-push | no-notification | ios-install
 */
const ua = () => (typeof navigator !== "undefined" ? navigator.userAgent || "" : "");

export const isIOS = () => /iPad|iPhone|iPod/.test(ua()) || (typeof navigator !== "undefined" && navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
export const isStandalone = () => {
  try {
    return !!(window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || window.navigator.standalone === true;
  } catch {
    return false;
  }
};

export function support() {
  if (typeof window === "undefined") return { ok: false, reason: "no-service-worker", message: "Notifications are not available here." };
  if (!window.isSecureContext) return { ok: false, reason: "insecure", message: "Notifications need a secure (https) connection." };
  // iPhone / iPad Safari only supports web push for sites added to the Home Screen
  if (isIOS() && !isStandalone() && !("PushManager" in window)) {
    return { ok: false, reason: "ios-install", message: "On iPhone and iPad, add FORKY to your Home Screen (Share > Add to Home Screen) and open it from there to turn on notifications." };
  }
  if (!("serviceWorker" in navigator)) return { ok: false, reason: "no-service-worker", message: "This browser does not support background notifications." };
  if (!("PushManager" in window)) return { ok: false, reason: isIOS() ? "ios-install" : "no-push", message: isIOS() ? "On iPhone and iPad, add FORKY to your Home Screen (Share > Add to Home Screen) and open it from there to turn on notifications." : "This browser does not support push notifications." };
  if (!("Notification" in window)) return { ok: false, reason: "no-notification", message: "This browser does not support notifications." };
  return { ok: true, reason: "ok", message: "" };
}

export const permission = () => {
  try {
    return "Notification" in window ? Notification.permission : "unsupported";
  } catch {
    return "unsupported";
  }
};

/** Safe localStorage helpers (private windows, blocked storage). */
export const lsGet = (k) => {
  try {
    return window.localStorage.getItem(k);
  } catch {
    return null;
  }
};
export const lsSet = (k, v) => {
  try {
    window.localStorage.setItem(k, v);
    return true;
  } catch {
    return false;
  }
};
export const lsDel = (k) => {
  try {
    window.localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
};

export const pageActive = () => typeof document !== "undefined" && document.visibilityState === "visible" && (typeof document.hasFocus !== "function" || document.hasFocus());
export const pageVisible = () => typeof document !== "undefined" && document.visibilityState === "visible";

/** Only same-site relative links are ever followed from a notification. */
export function safeUrl(u, fallback = "/") {
  if (typeof u !== "string" || !u.startsWith("/") || u.startsWith("//") || /[\r\n\\]/.test(u)) return fallback;
  return u;
}
