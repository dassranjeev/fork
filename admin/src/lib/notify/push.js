import { lsDel, lsGet, lsSet, permission, support } from "./env";
import { getRegistration, registerServiceWorker } from "./sw-register";

const DAY = 86400000;
const DISMISS_DAYS = 14;

function urlBase64ToUint8Array(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
const sameKey = (sub, keyBytes) => {
  try {
    const cur = sub?.options?.applicationServerKey;
    if (!cur) return true; // unknown: trust it
    const a = new Uint8Array(cur);
    return a.length === keyBytes.length && a.every((v, i) => v === keyBytes[i]);
  } catch {
    return true;
  }
};

/**
 * Browser push for ONE app surface.
 *
 *   const push = createPush({ app: "restaurant", http, getUserId: () => user.id });
 *   await push.state()      -> { support, permission, config, browserSubscribed, serverSubscribed, optedIn, bannerVisible, ... }
 *   await push.enable()     -> MUST be called from a click handler: it is the only place that asks the browser for permission
 *   await push.disable()    -> unsubscribes this browser (server + browser) and remembers the choice
 *   await push.teardown()   -> on logout: server + browser unsubscribe, the user's opt-in is remembered for their next login
 *   await push.sync()       -> on app start: silently repairs the subscription when the user opted in (never prompts)
 *   push.dismissBanner()    -> hides the "Turn on notifications" banner for 14 days
 *
 * `http` needs get / post / del returning the response body (the admin client and the storefront client both do).
 */
export function createPush({ app, http, getUserId = () => "anon", canSubscribe = () => true }) {
  const key = (name) => `fk.push.${app}.${name}.${getUserId() || "anon"}`;
  const listeners = new Set();
  const emit = () => listeners.forEach((f) => f());

  const optedIn = () => lsGet(key("optin")) === "1";
  const dismissedUntil = () => Number(lsGet(key("dismissed"))) || 0;

  async function browserSub() {
    const reg = await getRegistration();
    return reg ? reg.pushManager.getSubscription() : null;
  }

  async function register(sub) {
    const json = sub.toJSON();
    await http.post("/notifications/push/subscribe", {
      subscription: { endpoint: json.endpoint, expirationTime: json.expirationTime ?? null, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } },
      app,
    });
  }

  const api = {
    app,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    support,
    permission,
    optedIn,
    getConfig: () => http.get("/notifications/push/config", undefined, { noAuth: true }).catch(() => ({ enabled: false, publicKey: null })),

    async state() {
      const sup = support();
      const perm = permission();
      const config = await api.getConfig();
      let sub = null;
      let status = null;
      if (sup.ok) {
        sub = await browserSub().catch(() => null);
        status = await http.get("/notifications/push/status", sub ? { endpoint: sub.endpoint } : {}).catch(() => null);
      }
      const browserSubscribed = !!sub;
      const serverSubscribed = !!(sub && status?.subscribed);
      return {
        support: sup,
        permission: perm,
        config,
        browserSubscribed,
        serverSubscribed,
        // this browser still has a subscription that now belongs to another account (shared computer)
        otherAccount: browserSubscribed && !!status && !status.subscribed,
        pushEnabledPref: status ? status.pushEnabled !== false : true,
        platformEnabled: status ? status.platformEnabled !== false : !!config.enabled,
        optedIn: optedIn(),
        on: serverSubscribed && perm === "granted",
        bannerVisible: sup.ok && !!config.enabled && canSubscribe() && perm === "default" && dismissedUntil() < Date.now(),
      };
    },

    /** Ask for permission (only from a click) and subscribe this browser. Throws an Error with .code = denied | unsupported | disabled | failed. */
    async enable() {
      const sup = support();
      if (!sup.ok) throw Object.assign(new Error(sup.message), { code: "unsupported", reason: sup.reason });
      if (!canSubscribe()) throw Object.assign(new Error("Notifications cannot be turned on while viewing another account."), { code: "disabled" });
      const config = await api.getConfig();
      if (!config.enabled || !config.publicKey) throw Object.assign(new Error("Push notifications are switched off by FORKY right now."), { code: "disabled" });
      await registerServiceWorker();
      let perm = permission();
      if (perm === "default") perm = await Notification.requestPermission();
      if (perm !== "granted") {
        lsSet(key("dismissed"), String(Date.now() + DISMISS_DAYS * DAY));
        emit();
        throw Object.assign(
          new Error(perm === "denied" ? "Notifications are blocked for this site. Allow them in the browser's site settings, then try again." : "Notifications were not allowed."),
          { code: "denied" }
        );
      }
      const reg = await getRegistration();
      if (!reg) throw Object.assign(new Error("The notification service could not start."), { code: "failed" });
      const keyBytes = urlBase64ToUint8Array(config.publicKey);
      let sub = await reg.pushManager.getSubscription();
      if (sub && !sameKey(sub, keyBytes)) {
        await sub.unsubscribe().catch(() => undefined);
        sub = null;
      }
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes });
      await register(sub);
      lsSet(key("optin"), "1");
      lsDel(key("dismissed"));
      emit();
      return sub;
    },

    /** Turn off for this browser (and remember it). */
    async disable() {
      const sub = await browserSub().catch(() => null);
      if (sub) {
        await http.post("/notifications/push/unsubscribe", { endpoint: sub.endpoint }).catch(() => undefined);
        await sub.unsubscribe().catch(() => undefined);
      }
      lsDel(key("optin"));
      emit();
    },

    /**
     * Logout: this browser must stop receiving this user's notifications. The opt-in is kept so the same user is re-subscribed
     * (silently, the permission is already granted) after their next login.
     */
    async teardown() {
      try {
        const sub = await browserSub();
        if (sub) {
          await http.post("/notifications/push/unsubscribe", { endpoint: sub.endpoint }).catch(() => undefined);
          await sub.unsubscribe().catch(() => undefined);
        }
      } catch {
        /* ignore */
      }
    },

    /** App start: repair / refresh the subscription of a user who opted in. Never prompts. */
    async sync() {
      try {
        const sup = support();
        if (!sup.ok || !canSubscribe()) return;
        await registerServiceWorker();
        if (permission() !== "granted" || !optedIn()) return;
        const config = await api.getConfig();
        if (!config.enabled || !config.publicKey) return;
        const reg = await getRegistration();
        if (!reg) return;
        const keyBytes = urlBase64ToUint8Array(config.publicKey);
        let sub = await reg.pushManager.getSubscription();
        if (sub && !sameKey(sub, keyBytes)) {
          await sub.unsubscribe().catch(() => undefined);
          sub = null;
        }
        if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes });
        const st = await http.get("/notifications/push/status", { endpoint: sub.endpoint }).catch(() => null);
        if (!st?.subscribed) await register(sub);
        emit();
      } catch {
        /* sync is best effort */
      }
    },

    dismissBanner() {
      lsSet(key("dismissed"), String(Date.now() + DISMISS_DAYS * DAY));
      emit();
    },

    sendTest: () => http.post("/notifications/push/test", {}),
    devices: async () => {
      const sub = await browserSub().catch(() => null);
      return (await http.get("/notifications/push/devices", sub ? { endpoint: sub.endpoint } : {})).data || [];
    },
    removeDevice: (id) => http.del(`/notifications/push/devices/${id}`),
  };
  return api;
}
