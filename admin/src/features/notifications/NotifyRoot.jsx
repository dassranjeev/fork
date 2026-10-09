import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "react-toastify";
import { http } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { money } from "../../lib/format";
import { NotifyProvider, safeUrl } from "../../lib/notify";
import { getSocket } from "../../lib/socket";
import { PushHost } from "./shared";

/** toast content: plain React text only (titles / bodies come from the server) */
function ToastBody({ n }) {
  return (
    <div>
      <div className="fw-semibold">{String(n.title || "").slice(0, 120)}</div>
      {n.body ? <div className="text-sm">{String(n.body).slice(0, 200)}</div> : null}
    </div>
  );
}

const detailCache = new Map(); // orderId -> item count (a PLACED order's items do not change)

/**
 * Mounts the notification machinery (lib/notify) for the Admin Console (portal="admin") and the Restaurant Portal
 * (portal="restaurant"): realtime center, toasts, browser push, and - for restaurants - the new-order / cancellation alarm.
 * Must sit inside the Router and AuthProvider.
 */
export default function NotifyRoot({ portal, children }) {
  const { user, impersonating } = useAuth();
  const navigate = useNavigate();
  const app = portal === "restaurant" ? "restaurant" : "admin";
  const ref = useRef({});
  ref.current = { user, impersonating, navigate };

  const getUserId = useCallback(() => ref.current.user?.id || "anon", []);
  const canPush = useCallback(() => !ref.current.impersonating, []);
  const nav = useCallback((u) => ref.current.navigate(u), []);

  const onToast = useCallback(({ notification: n }) => {
    const url = safeUrl(n.url, null);
    toast(<ToastBody n={n} />, {
      toastId: n.id,
      autoClose: 6000,
      onClick: () => {
        http.post(`/notifications/${n.id}/read`, {}).catch(() => undefined);
        if (url) ref.current.navigate(url);
      },
    });
  }, []);

  // restaurant sound preferences (GET /notifications/preferences), re-read when the settings page saves
  const [prefs, setPrefs] = useState(null);
  const uid = user?.id;
  useEffect(() => {
    if (app !== "restaurant" || !uid) return undefined;
    let off = false;
    const load = () =>
      http
        .get("/notifications/preferences")
        .then((p) => {
          if (off) return;
          const next = { soundEnabled: p.soundEnabled !== false, soundVolume: Number.isFinite(p.soundVolume) ? p.soundVolume : 80 };
          setPrefs((cur) => (cur && cur.soundEnabled === next.soundEnabled && cur.soundVolume === next.soundVolume ? cur : next));
        })
        .catch(() => undefined);
    load();
    window.addEventListener("fk:prefs-changed", load);
    return () => {
      off = true;
      window.removeEventListener("fk:prefs-changed", load);
    };
  }, [app, uid]);

  /** orders that need an alarm right now: new orders (PLACED, already released to the restaurant) and open cancellation requests */
  const pendingSource = useCallback(async () => {
    const ids = ref.current.user?.restaurantIds || [];
    const out = [];
    for (const rid of ids) {
      const r = await http.get("/restaurant/orders", { restaurantId: rid, limit: 100 });
      for (const o of r.data || []) {
        const url = `/portal/orders?order=${o.id}`;
        if (o.status === "PLACED") {
          let count = detailCache.get(o.id);
          if (count === undefined) {
            try {
              const d = await http.get(`/restaurant/orders/${o.id}`, { restaurantId: rid });
              count = (d.order?.items || []).filter((x) => !x.removed).reduce((s, x) => s + (Number(x.quantity) || 1), 0);
              detailCache.set(o.id, count);
            } catch {
              count = null;
            }
          }
          const parts = [];
          if (count) parts.push(`${count} item${count === 1 ? "" : "s"}`);
          if (o.total !== undefined && o.total !== null) parts.push(money(o.total));
          out.push({ id: o.id, kind: "order", title: `New order ${o.code}`, body: parts.join(", "), url, restaurantId: rid });
        }
        const cr = o.meta?.cancelRequest;
        if (cr && cr.status === "PENDING") out.push({ id: o.id, kind: "cancel", title: `Cancellation request ${o.code}`, body: cr.reason || "FORKSY support asks to cancel this order", url, restaurantId: rid });
      }
    }
    return out;
  }, []);

  const source = useMemo(() => (app === "restaurant" ? pendingSource : undefined), [app, pendingSource]);

  return (
    <NotifyProvider
      app={app}
      http={http}
      getSocket={getSocket}
      getUserId={getUserId}
      navigate={nav}
      onToast={onToast}
      pendingSource={source}
      canPush={canPush}
      silent={!!impersonating}
      prefs={prefs}
      identity={uid}
    >
      <PushHost>{children}</PushHost>
    </NotifyProvider>
  );
}
