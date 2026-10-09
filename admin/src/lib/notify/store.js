import { onWorkerMessage } from "./sw-register";
import { pageActive, safeUrl } from "./env";

/**
 * The notification center state of one surface (framework independent; use it through React with `useStore(store)`).
 *
 *   const store = createNotificationStore({ http, getSocket, onIncoming, navigate });
 *   store.start() / store.stop()
 *   store.getSnapshot() -> { items, unread, loaded, loading, hasMore, error, connected, filter }
 *   store.refresh() / store.loadMore() / store.setFilter({ unread, category })
 *   store.markRead(id) / store.markAllRead() / store.remove(id)
 *
 * Live updates arrive over Socket.IO (`notification`, `notification.read`); while the socket is down the store polls
 * /notifications/unread-count (30 s) and re-reads the list when the count changed, so every surface keeps working without realtime.
 * `onIncoming({ notification, active })` fires once per new notification; `active` is true when the page is visible AND focused
 * (then the app shows a toast; when it is hidden the service worker shows the OS notification instead - never both).
 */
export function createNotificationStore({ http, getSocket, onIncoming, navigate, pageSize = 20, pollMs = 30000 }) {
  let state = { items: [], unread: 0, loaded: false, loading: false, hasMore: false, nextCursor: null, error: null, connected: false, filter: { unread: false, category: "" } };
  const subs = new Set();
  const seen = new Set();
  let sock = null;
  let bindTimer = null;
  let pollTimer = null;
  let started = false;
  let offWorker = null;
  let reqSeq = 0;
  const set = (patch) => {
    state = { ...state, ...patch };
    subs.forEach((f) => f());
  };

  const query = (cursor) => {
    const q = { limit: pageSize };
    if (cursor) q.cursor = cursor;
    if (state.filter.unread) q.unread = "true";
    if (state.filter.category) q.category = state.filter.category;
    return q;
  };
  const matches = (n) => (!state.filter.unread || !n.readAt) && (!state.filter.category || n.category === state.filter.category);

  const api = {
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    getSnapshot: () => state,

    async refresh() {
      const mine = ++reqSeq;
      set({ loading: true });
      try {
        const r = await http.get("/notifications", query());
        if (mine !== reqSeq) return;
        (r.data || []).forEach((n) => seen.add(n.id));
        set({ items: r.data || [], unread: r.unread ?? state.unread, nextCursor: r.nextCursor || null, hasMore: !!r.nextCursor, loaded: true, loading: false, error: null });
      } catch (e) {
        if (mine === reqSeq) set({ loading: false, loaded: true, error: e });
      }
    },

    async loadMore() {
      if (!state.nextCursor || state.loading) return;
      set({ loading: true });
      try {
        const r = await http.get("/notifications", query(state.nextCursor));
        const known = new Set(state.items.map((i) => i.id));
        const more = (r.data || []).filter((n) => !known.has(n.id));
        more.forEach((n) => seen.add(n.id));
        set({ items: [...state.items, ...more], nextCursor: r.nextCursor || null, hasMore: !!r.nextCursor, unread: r.unread ?? state.unread, loading: false });
      } catch (e) {
        set({ loading: false, error: e });
      }
    },

    setFilter(f) {
      state = { ...state, filter: { ...state.filter, ...f }, items: [], nextCursor: null, hasMore: false, loaded: false };
      return api.refresh();
    },

    async markRead(id) {
      const it = state.items.find((n) => n.id === id);
      if (it && it.readAt) return;
      set({
        items: state.items.map((n) => (n.id === id ? { ...n, readAt: new Date().toISOString() } : n)),
        unread: it && !it.readAt ? Math.max(0, state.unread - 1) : state.unread,
      });
      try {
        const r = await http.post(`/notifications/${id}/read`, {});
        if (typeof r?.unread === "number") set({ unread: r.unread });
      } catch {
        /* the next refresh corrects it */
      }
    },

    async markAllRead() {
      const now = new Date().toISOString();
      set({ items: state.items.map((n) => (n.readAt ? n : { ...n, readAt: now })), unread: 0 });
      try {
        await http.post("/notifications/read-all", {});
      } catch {
        api.refresh();
      }
    },

    async remove(id) {
      const it = state.items.find((n) => n.id === id);
      set({ items: state.items.filter((n) => n.id !== id), unread: it && !it.readAt ? Math.max(0, state.unread - 1) : state.unread });
      try {
        const r = await http.del(`/notifications/${id}`);
        if (typeof r?.unread === "number") set({ unread: r.unread });
      } catch {
        api.refresh();
      }
    },

    /** open the deep link of a notification (and mark it read) */
    open(n) {
      if (!n) return;
      api.markRead(n.id);
      const url = safeUrl(n.url, null);
      if (url && navigate) navigate(url);
    },

    // ------------------------------------------------------------- lifecycle
    start() {
      if (started) return;
      started = true;
      api.refresh();
      // opened from a notification click while no tab was open: the service worker left #fk-n=<id>
      try {
        const m = /[#&]fk-n=([^&]+)/.exec(window.location.hash || "");
        if (m) {
          api.markRead(decodeURIComponent(m[1]));
          window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
        }
      } catch {
        /* ignore */
      }
      bind();
      bindTimer = setInterval(bind, 3000); // the socket may appear after login / reconnect
      pollTimer = setInterval(poll, pollMs);
      document.addEventListener("visibilitychange", onVisible);
      offWorker = onWorkerMessage(onWorker);
    },
    stop() {
      started = false;
      clearInterval(bindTimer);
      clearInterval(pollTimer);
      document.removeEventListener("visibilitychange", onVisible);
      if (offWorker) offWorker();
      unbind();
    },
  };

  // ------------------------------------------------------------- realtime
  function incoming(n) {
    if (!n || !n.id || seen.has(n.id)) return;
    seen.add(n.id);
    const item = {
      id: n.id,
      title: n.title,
      body: n.body,
      event: n.event,
      category: n.category || "system",
      data: n.data || null,
      url: n.url || null,
      readAt: null,
      createdAt: n.at || new Date().toISOString(),
    };
    set({ unread: state.unread + 1, items: matches(item) ? [item, ...state.items].slice(0, Math.max(pageSize, state.items.length + 1)) : state.items });
    if (onIncoming) {
      try {
        onIncoming({ notification: { ...item, critical: !!n.critical, requireInteraction: !!n.requireInteraction, tag: n.tag, urgency: n.urgency, audience: n.audience }, active: pageActive() });
      } catch {
        /* a bad handler must not break the store */
      }
    }
  }
  function onRead(p) {
    if (!p) return;
    if (p.deleted) set({ items: state.items.filter((n) => n.id !== p.id), unread: typeof p.unread === "number" ? p.unread : state.unread });
    else if (p.all) set({ items: state.items.map((n) => (n.readAt ? n : { ...n, readAt: new Date().toISOString() })), unread: 0 });
    else if (p.id) set({ items: state.items.map((n) => (n.id === p.id && !n.readAt ? { ...n, readAt: new Date().toISOString() } : n)), unread: typeof p.unread === "number" ? p.unread : state.unread });
  }
  const onConnect = () => {
    set({ connected: true });
    api.refresh();
  };
  const onDisconnect = () => set({ connected: false });

  function bind() {
    const s = getSocket ? getSocket() : null;
    if (!s || s === sock) return;
    unbind();
    sock = s;
    s.on("notification", incoming);
    s.on("notification.read", onRead);
    s.on("connect", onConnect);
    s.on("disconnect", onDisconnect);
    set({ connected: !!s.connected });
  }
  function unbind() {
    if (!sock) return;
    sock.off("notification", incoming);
    sock.off("notification.read", onRead);
    sock.off("connect", onConnect);
    sock.off("disconnect", onDisconnect);
    sock = null;
    if (state.connected) set({ connected: false });
  }

  // ------------------------------------------------------------- fallback polling + visibility
  async function poll() {
    if (!started) return;
    if (state.connected && document.visibilityState !== "visible") return;
    try {
      const r = await http.get("/notifications/unread-count");
      if (typeof r?.count === "number" && (r.count !== state.unread || !state.connected)) {
        if (r.count !== state.unread) await api.refresh();
      }
    } catch {
      /* offline */
    }
  }
  function onVisible() {
    if (document.visibilityState === "visible") api.refresh();
  }

  // ------------------------------------------------------------- service worker messages
  function onWorker(m) {
    if (m.type === "push") {
      // a push arrived while a page was open: make sure the list shows it (the socket usually did already)
      api.refresh();
    } else if (m.type === "notification-click") {
      if (m.id) api.markRead(m.id);
      const url = safeUrl(m.url, null);
      if (url && navigate) navigate(url);
    }
  }

  return api;
}
