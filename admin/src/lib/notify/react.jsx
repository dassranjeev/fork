import React, { createContext, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { createAlerts } from "./alerts";
import { createPush } from "./push";
import { createSound } from "./sound";
import { createNotificationStore } from "./store";
import { registerServiceWorker } from "./sw-register";

const Ctx = createContext(null);

/** the push controller of the mounted provider, so logout code outside React (AuthProvider) can unsubscribe this browser first */
let activePush = null;
export async function teardownActivePush() {
  try {
    if (activePush) await activePush.teardown();
  } catch {
    /* best effort */
  }
}

// a restaurant alert for a new order ends when the order leaves PLACED; a cancellation request ends when the order is finished / cancelled
const DEFAULT_RESTAURANT_RULES = [
  { event: "order.status", kind: "order", id: (p) => p?.orderId, when: (p) => p?.status && p.status !== "PLACED" },
  { event: "order.status", kind: "cancel", id: (p) => p?.orderId, when: (p) => ["CANCELLED", "REJECTED", "PICKED_UP", "ON_THE_WAY", "DELIVERED", "COLLECTED"].includes(p?.status) },
  // another staff member of the restaurant (or FORKY) answered the cancellation request
  { event: "order.cancel_request_answered", kind: "cancel", id: (p) => p?.orderId },
];

// the snapshot MUST be the same object every time (useSyncExternalStore loops forever on a fresh object per call)
const NO_STATE = {};
const NOOP = { subscribe: () => () => undefined, getSnapshot: () => NO_STATE };

/** subscribe a React component to any store with subscribe / getSnapshot */
export function useStore(store) {
  const s = store || NOOP;
  return useSyncExternalStore(s.subscribe, s.getSnapshot, s.getSnapshot);
}

/**
 * Mounts the notification machinery of ONE surface (Admin Console, Restaurant Portal, customer website). Inside it:
 *   useNotify()         -> { store, push, sound, alerts, app, prefs }
 *   useNotifications()  -> live center state (items, unread, ...) + actions
 *   useAlerts()         -> { items, soundState, ringing, ... } + actions (portal: new-order alarm banner)
 *   usePushState()      -> async push state with reload()
 *
 * Props
 *   app          "admin" | "restaurant" | "customer" | "driver"
 *   http         { get, post, put, del } returning the body
 *   getSocket    () => socket.io client or null (admin: lib/socket getSocket; storefront: createRealtime(...).get)
 *   getUserId    () => current user id (opt-in is remembered per user)
 *   navigate     (url) => void, SPA navigation for deep links
 *   onToast      ({ notification }) => void: show an in-app toast (only called when the page is visible and focused)
 *   alertEvents  restaurant portal: { "order.placed": "order", "order.cancel_requested": "cancel" } event -> alert kind (default for app "restaurant")
 *   pendingSource  async () => [{ id, kind, title, body, url }]: the orders that currently need an alarm (re-checked every 30 s and on reconnect)
 *   resolveOn    socket events that END an alert: [{ event: "order.status", id: (p) => p.orderId, when: (p) => p.status !== "PLACED", kind: "order" }]
 *                (kind is optional: without it every alert with that id ends)
 *   pendingKinds alert kinds owned by pendingSource: one that is no longer pending ends (default for the restaurant app: order + cancel)
 *   canPush      () => bool (false while an admin views a restaurant as the owner)
 *   silent       true while impersonating: no sound
 *   prefs        { soundEnabled, soundVolume } (restaurant prefs from GET /notifications/preferences)
 *   enabled      false = keep the children mounted but run nothing (no requests, no socket binding, no service worker work) and give
 *                the hooks `null`. The customer website uses it so that signing in / out never remounts the page tree. Default true.
 *   identity     string that identifies the signed-in user; a different value rebuilds the store / push controller (no stale items
 *                of the previous account). Optional; the other surfaces never switch users without a reload.
 */
export function NotifyProvider({ app, http, getSocket, getUserId, navigate, onToast, alertEvents, pendingSource, resolveOn, pendingKinds, canPush, silent, prefs, enabled = true, identity, children }) {
  const ref = useRef({});
  const cfg = useRef({});
  cfg.current = { onToast, navigate, alertEvents, pendingSource, resolveOn, pendingKinds, silent, getSocket };

  const parts = useMemo(() => {
    const sound = createSound();
    const alerts = createAlerts({ sound });
    const defaults = app === "restaurant" ? { "order.placed": "order", "order.cancel_requested": "cancel" } : app === "driver" ? { "driver.offer": "offer" } : {};
    const store = createNotificationStore({
      http,
      getSocket: () => (cfg.current.getSocket ? cfg.current.getSocket() : null),
      navigate: (u) => cfg.current.navigate && cfg.current.navigate(u),
      onIncoming: ({ notification, active }) => {
        const map = cfg.current.alertEvents || defaults;
        const kind = map[notification.event];
        if (kind) {
          const id = notification.data?.orderId || notification.data?.offerId || notification.id;
          alerts.add({ id, kind, title: notification.title, body: notification.body, url: notification.url, notificationId: notification.id });
        }
        if (active && !kind && cfg.current.onToast) cfg.current.onToast({ notification });
      },
    });
    const push = createPush({ app, http, getUserId: () => (getUserId ? getUserId() : "anon"), canSubscribe: () => (canPush ? canPush() : true) });
    ref.current = { sound, alerts, store, push };
    return ref.current;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app, identity]);

  const { sound, alerts, store, push } = parts;

  useEffect(() => {
    if (enabled === false) return undefined;
    sound.armGestureUnlock();
    registerServiceWorker().then(() => push.sync());
    store.start();
    activePush = push;
    return () => {
      if (activePush === push) activePush = null;
      store.stop();
      alerts.destroy();
      sound.stopLoop();
    };
  }, [sound, alerts, store, push, enabled]);

  // sound preferences of the user
  useEffect(() => {
    if (prefs) {
      sound.setVolume(prefs.soundVolume ?? 80);
      sound.setEnabled(prefs.soundEnabled !== false && !silent);
    } else if (silent) sound.setEnabled(false);
  }, [prefs, silent, sound]);

  // alerts end when the thing they are about is handled (socket events) and are re-synced from the server
  useEffect(() => {
    if (enabled === false) return undefined;
    const rules = resolveOn || (app === "restaurant" ? DEFAULT_RESTAURANT_RULES : []);
    let sock = null;
    const handlers = [];
    const bind = () => {
      const s = getSocket ? getSocket() : null;
      if (!s || s === sock) return;
      handlers.forEach(([e, f]) => sock && sock.off(e, f));
      handlers.length = 0;
      sock = s;
      rules.forEach((r) => {
        const f = (p) => {
          if (!r.when || r.when(p)) alerts.resolve(r.id(p), r.kind);
        };
        s.on(r.event, f);
        handlers.push([r.event, f]);
      });
      const onConn = () => syncPending();
      s.on("connect", onConn);
      handlers.push(["connect", onConn]);
    };
    const syncPending = async () => {
      const src = cfg.current.pendingSource;
      if (!src) return;
      try {
        const list = await src();
        const keys = new Set(list.map((i) => `${i.kind}:${i.id}`));
        list.forEach((i) => alerts.add(i));
        // alerts of the kinds this source owns that are no longer pending are done
        const kinds = new Set([...(cfg.current.pendingKinds || (app === "restaurant" ? ["order", "cancel"] : [])), ...list.map((i) => i.kind)]);
        alerts.pruneAcked(keys);
        alerts.resolveWhere((i) => kinds.has(i.kind) && !keys.has(`${i.kind}:${i.id}`) && Date.now() - i.at > 5000);
      } catch {
        /* keep the current alerts */
      }
    };
    bind();
    syncPending();
    const t = setInterval(bind, 3000);
    const t2 = setInterval(syncPending, 30000);
    return () => {
      clearInterval(t);
      clearInterval(t2);
      handlers.forEach(([e, f]) => sock && sock.off(e, f));
    };
  }, [app, alerts, getSocket, resolveOn, enabled]);

  const value = useMemo(() => (enabled === false ? null : { ...parts, app, prefs }), [parts, app, prefs, enabled]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useNotify() {
  return useContext(Ctx);
}

/** live notification center state + actions */
export function useNotifications() {
  const n = useNotify();
  const s = useStore(n?.store);
  return { ...s, store: n?.store, refresh: () => n?.store.refresh(), loadMore: () => n?.store.loadMore(), markRead: (id) => n?.store.markRead(id), markAllRead: () => n?.store.markAllRead(), remove: (id) => n?.store.remove(id), setFilter: (f) => n?.store.setFilter(f), open: (item) => n?.store.open(item) };
}

/** persistent alarm alerts (new order / cancel request / offer) */
export function useAlerts() {
  const n = useNotify();
  const s = useStore(n?.alerts);
  return { ...(s.items ? s : { items: [], soundState: "unsupported", ringing: null, leader: false }), acknowledge: (id, kind) => n?.alerts.acknowledge(id, false, kind), unlockSound: () => n?.sound.unlock(), playTest: () => n?.sound.play("test", { force: true }), sound: n?.sound };
}

/** React state of the browser push of this surface */
export function usePushState() {
  const n = useNotify();
  const [state, setState] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  const reload = React.useCallback(async () => {
    if (n?.push) setState(await n.push.state());
  }, [n]);
  useEffect(() => {
    reload();
    return n?.push.subscribe(reload);
  }, [n, reload]);
  const enable = async () => {
    setBusy(true);
    setError(null);
    try {
      await n.push.enable();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
      reload();
    }
  };
  const disable = async () => {
    setBusy(true);
    try {
      await n.push.disable();
    } finally {
      setBusy(false);
      reload();
    }
  };
  return { state, busy, error, reload, enable, disable, push: n?.push };
}
