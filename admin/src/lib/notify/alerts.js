import { lsGet, lsSet } from "./env";

/**
 * Loud, persistent alerts (restaurant portal: new order, cancellation request; drivers: new offer).
 *
 *   const alerts = createAlerts({ sound });
 *   alerts.add({ id: orderId, kind: "order" | "cancel" | "offer", title, body, url })  -> rings (repeating), flashes the tab title, raises the banner
 *   alerts.resolve(id, kind?) -> the thing was handled elsewhere (order accepted / status changed): stops that alert (only that kind when given)
 *   alerts.acknowledge(id?, fromPeer?, kind?) -> the user acknowledged one alert (or all): stops ringing for it, other tabs follow.
 *                                An acknowledged alert is remembered (localStorage, until resolved / no longer pending) so the periodic
 *                                re-sync of the pending list does not make it ring again.
 *   alerts.subscribe(fn) / alerts.getSnapshot() -> { items, soundState, ringing, leader }
 *
 * Only ONE open tab rings (a lease in localStorage, the most recently focused tab wins); every tab shows the banner and flashes
 * the title. Sound follows the highest-priority open alert (cancel > order > offer).
 */
const LEASE_KEY = "fk.alert.leader";
const LEASE_MS = 6000;
const ACKED_KEY = "fk.alert.acked";
const ACKED_TTL = 12 * 3600 * 1000;
const keyOf = (id, kind) => `${kind || "order"}:${id}`;
const PRIORITY = { cancel: 3, order: 2, offer: 1 };
const FLASH_LABEL = { order: "New order", cancel: "Cancel request", offer: "New offer" };

export function createAlerts({ sound, doc = typeof document !== "undefined" ? document : null }) {
  const me = Math.random().toString(36).slice(2);
  let items = [];
  const subs = new Set();
  let snap = { items, soundState: sound.state(), ringing: null, leader: false };
  let flashTimer = null;
  let baseTitle = doc ? doc.title : "";
  let flashOn = false;
  let leaseTimer = null;
  let chan = null;
  // acknowledged alerts that are still pending on the server: { "kind:id": timestamp }
  let acked = {};
  try {
    acked = JSON.parse(lsGet(ACKED_KEY) || "{}") || {};
    Object.keys(acked).forEach((k) => Date.now() - acked[k] > ACKED_TTL && delete acked[k]);
  } catch {
    acked = {};
  }
  const saveAcked = () => lsSet(ACKED_KEY, JSON.stringify(acked));
  try {
    chan = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("fk-alerts") : null;
  } catch {
    chan = null;
  }

  const lease = () => {
    try {
      return JSON.parse(lsGet(LEASE_KEY) || "null");
    } catch {
      return null;
    }
  };
  const isLeader = () => {
    const l = lease();
    return !!l && l.id === me && Date.now() - l.at < LEASE_MS;
  };
  function claim(force) {
    const l = lease();
    if (force || !l || l.id === me || Date.now() - l.at > LEASE_MS) lsSet(LEASE_KEY, JSON.stringify({ id: me, at: Date.now() }));
  }

  function publish() {
    snap = { items: [...items], soundState: sound.state(), ringing: sound.looping(), leader: isLeader() };
    subs.forEach((f) => f());
  }

  function syncSound() {
    const top = items.slice().sort((a, b) => (PRIORITY[b.kind] || 0) - (PRIORITY[a.kind] || 0))[0];
    if (!top) {
      sound.stopLoop();
    } else if (isLeader()) {
      if (sound.state() === "running") sound.startLoop(top.kind === "cancel" ? "cancel" : top.kind === "offer" ? "offer" : "order");
    } else {
      sound.stopLoop();
    }
  }

  function syncTitle() {
    if (!doc) return;
    if (!items.length) {
      if (flashTimer) clearInterval(flashTimer);
      flashTimer = null;
      if (flashOn || doc.title !== baseTitle) doc.title = baseTitle;
      flashOn = false;
      return;
    }
    if (!flashTimer) {
      baseTitle = doc.title.replace(/^\(\d+\)\s[^|]*\|\s/, "") || baseTitle;
      flashTimer = setInterval(() => {
        flashOn = !flashOn;
        const top = items.slice().sort((a, b) => (PRIORITY[b.kind] || 0) - (PRIORITY[a.kind] || 0))[0];
        doc.title = flashOn && top ? `(${items.length}) ${FLASH_LABEL[top.kind] || "Alert"} | ${baseTitle}` : baseTitle;
      }, 1000);
    }
  }

  function update() {
    syncSound();
    syncTitle();
    publish();
  }

  function startLease() {
    if (leaseTimer) return;
    claim(false);
    leaseTimer = setInterval(() => {
      if (!items.length) {
        clearInterval(leaseTimer);
        leaseTimer = null;
        return;
      }
      claim(false);
      update();
    }, 2000);
  }

  if (typeof window !== "undefined") {
    window.addEventListener("focus", () => {
      if (items.length) {
        claim(true);
        update();
      }
    });
    window.addEventListener("storage", (e) => {
      if (e.key === LEASE_KEY && items.length) update();
    });
  }
  sound.subscribe(() => {
    syncSound();
    publish();
  });
  if (chan) {
    chan.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === "ack") api.acknowledge(m.id, true, m.kind);
    };
  }

  const api = {
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    getSnapshot: () => snap,
    /** add (or refresh) an alert; the same id never rings twice */
    add(a) {
      if (!a || !a.id) return;
      const idx = items.findIndex((i) => i.id === a.id && i.kind === a.kind);
      if (idx >= 0) {
        // already ringing: only fill in details it did not have yet (e.g. restaurantId from the pending-orders sync); never rings twice
        const cur = items[idx];
        const fill = Object.keys(a).filter((k) => (cur[k] === undefined || cur[k] === null || cur[k] === "") && a[k] !== undefined && a[k] !== null && a[k] !== "");
        if (fill.length) {
          items = items.map((i, n) => (n === idx ? { ...i, ...Object.fromEntries(fill.map((k) => [k, a[k]])) } : i));
          publish();
        }
        return;
      }
      if (acked[keyOf(a.id, a.kind)]) return;
      items = [...items, { kind: "order", at: Date.now(), ...a }];
      startLease();
      claim(false);
      update();
    },
    /** the order / offer was handled (status changed): stop its alert without user action */
    resolve(id, kind) {
      const hit = (i) => i.id === id && (!kind || i.kind === kind);
      Object.keys(acked).forEach((k) => (kind ? k === keyOf(id, kind) : k.endsWith(`:${id}`)) && delete acked[k]);
      saveAcked();
      if (!items.some(hit)) return;
      items = items.filter((i) => !hit(i));
      update();
    },
    /** forget acknowledgements of things that are no longer pending (called after every re-sync with the pending keys "kind:id") */
    pruneAcked(pendingKeys) {
      let changed = false;
      Object.keys(acked).forEach((k) => {
        if (!pendingKeys.has(k) && Date.now() - acked[k] > 60000) {
          delete acked[k];
          changed = true;
        }
      });
      if (changed) saveAcked();
    },
    resolveWhere(fn) {
      const n = items.length;
      items = items.filter((i) => !fn(i));
      if (items.length !== n) update();
    },
    /** user acknowledged (one alert or all of them) */
    acknowledge(id, fromPeer = false, kind) {
      const gone = id ? items.filter((i) => i.id === id && (!kind || i.kind === kind)) : items;
      gone.forEach((i) => (acked[keyOf(i.id, i.kind)] = Date.now()));
      if (gone.length) saveAcked();
      items = id ? items.filter((i) => !(i.id === id && (!kind || i.kind === kind))) : [];
      if (!fromPeer && chan) {
        try {
          chan.postMessage({ type: "ack", id: id || null, kind: kind || null });
        } catch {
          /* ignore */
        }
      }
      update();
    },
    has: (id) => items.some((i) => i.id === id),
    destroy() {
      items = [];
      update();
      if (leaseTimer) clearInterval(leaseTimer);
      if (chan) chan.close();
    },
  };
  return api;
}
