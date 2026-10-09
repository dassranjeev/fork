/* FORKSY service worker: one worker for every web surface of this origin (Admin Console, Restaurant Portal, customer website at
 * /order, driver demo). It only handles push; it does not cache anything and has no fetch handler.
 *   push                     show the notification (collapsed by tag), unless a page of the same surface is visible AND focused
 *                            (that page shows its own toast / alarm: never a double alert)
 *   notificationclick        focus an open tab of the same surface (and tell it to open the deep link + mark the notification read),
 *                            else open the deep link in a new window
 *   pushsubscriptionchange   re-subscribe and tell the pages to re-register the new endpoint
 * Payloads are produced by the API (backend/src/notifications): { title, body, tag, url, icon, badge, requireInteraction, critical,
 * event, id, data, ts }. Nothing sensitive ever travels in them. */
const VERSION = "fk-sw-4";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

/** which surface (app) a URL belongs to */
function surfaceOf(pathname) {
  if (pathname === "/portal" || pathname.indexOf("/portal/") === 0) return "portal";
  if (pathname === "/order" || pathname.indexOf("/order/") === 0) return "order";
  if (pathname.indexOf("/driver-demo") === 0) return "driver";
  return "admin";
}

function safeTarget(url) {
  try {
    const u = new URL(typeof url === "string" ? url : "/", self.location.origin);
    if (u.origin !== self.location.origin) return new URL("/", self.location.origin);
    return u;
  } catch (e) {
    return new URL("/", self.location.origin);
  }
}

function parse(event) {
  if (!event.data) return {};
  try {
    return event.data.json();
  } catch (e) {
    try {
      return { title: "FORKSY", body: event.data.text() };
    } catch (e2) {
      return {};
    }
  }
}

async function handlePush(p) {
  const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const target = safeTarget(p.url);
  const surface = surfaceOf(target.pathname);
  wins.forEach((c) => {
    try {
      c.postMessage({ fk: 1, type: "push", id: p.id || null, event: p.event || null, tag: p.tag || null });
    } catch (e) {
      /* ignore */
    }
  });
  // a page of this surface is open, visible and focused: it already shows the toast / alarm itself
  const live = wins.some((c) => c.visibilityState === "visible" && c.focused && surfaceOf(new URL(c.url).pathname) === surface);
  if (live) return "page-focused";
  const title = String(p.title || "FORKSY").slice(0, 120);
  await self.registration.showNotification(title, {
    body: String(p.body || "").slice(0, 300),
    tag: p.tag || undefined,
    // a newer push with the same tag replaces the older one and alerts again
    renotify: !!p.tag,
    icon: p.icon || "/brand/icon-192.png",
    badge: p.badge || "/brand/icon-96.png",
    requireInteraction: !!p.requireInteraction,
    timestamp: p.ts || Date.now(),
    silent: false,
    data: { url: target.pathname + target.search + target.hash, id: p.id || null, event: p.event || null, surface: surface, extra: p.data || null },
  });
  return "shown";
}

async function handleClick(d) {
  const target = safeTarget(d.url);
  const surface = surfaceOf(target.pathname);
  const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const same = wins.filter((c) => {
    try {
      return surfaceOf(new URL(c.url).pathname) === surface;
    } catch (e) {
      return false;
    }
  });
  const best = same.find((c) => c.focused) || same.find((c) => c.visibilityState === "visible") || same[0];
  if (best) {
    try {
      best.postMessage({ fk: 1, type: "notification-click", id: d.id || null, url: target.pathname + target.search, event: d.event || null });
      await best.focus();
      return "focused";
    } catch (e) {
      /* fall through and open a window */
    }
  }
  // no open tab: open the deep link; the page marks the notification read from the #fk-n=<id> hint
  const open = new URL(target.href);
  if (d.id) open.hash = "fk-n=" + encodeURIComponent(d.id);
  await self.clients.openWindow(open.href);
  return "opened";
}

self.addEventListener("push", (event) => event.waitUntil(handlePush(parse(event))));

self.addEventListener("notificationclick", (event) => {
  const n = event.notification;
  const d = n.data || {};
  n.close();
  event.waitUntil(handleClick(d));
});

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      let sub = null;
      try {
        const old = event.oldSubscription;
        const opts = (old && old.options) || (event.newSubscription && event.newSubscription.options);
        sub = event.newSubscription || (opts ? await self.registration.pushManager.subscribe(opts) : null);
      } catch (e) {
        sub = null;
      }
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      wins.forEach((c) => c.postMessage({ fk: 1, type: "subscription-change", resubscribed: !!sub }));
    })()
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "version" && event.source) event.source.postMessage({ fk: 1, type: "version", version: VERSION });
});

// exposed so the logic can be exercised from DevTools / tests (the events themselves are wired above)
self.fkHandlers = { handlePush: handlePush, handleClick: handleClick };
