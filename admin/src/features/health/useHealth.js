import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage, http } from "../../lib/api";
import { getSocket } from "../../lib/socket";

/**
 * Live System Health data.
 *  - first load over REST (also carries request-specific checks such as the proxy-header check),
 *  - then a websocket stream (`system.subscribe` -> `system.health` about every 2 s); only a Super Admin socket is accepted by the API,
 *  - if no stream event arrives for ~6 s (socket blocked, API restarting) it falls back to polling every 5 s and says so.
 * `paused` freezes the screen (the stream keeps running in the background so resuming is instant).
 */
export function useHealth() {
  const [snap, setSnap] = useState(null);
  const [error, setError] = useState(null);
  const [live, setLive] = useState(false);
  const [paused, setPaused] = useState(false);
  const [loading, setLoading] = useState(true);
  const pausedRef = useRef(false);
  const proxyCheck = useRef(null);
  const lastEvent = useRef(0);
  pausedRef.current = paused;

  /** The stream is shared by all watchers, so it cannot carry the request-specific "proxy" check: keep the one from the last REST load. */
  const apply = useCallback((s, fromRest) => {
    if (fromRest) proxyCheck.current = (s.checks || []).find((c) => c.key === "proxy") || null;
    const checks = (s.checks || []).filter((c) => c.key !== "proxy");
    if (proxyCheck.current) checks.push(proxyCheck.current);
    setSnap({ ...s, checks });
  }, []);

  /** opts.manual: apply the result even while paused (a button was pressed); opts.recheck: also re-run the cached dependency checks now */
  const load = useCallback(
    async (opts = {}) => {
      try {
        const s = await http.get("/admin/system/health", opts.recheck ? { refresh: 1 } : undefined);
        setError(null);
        if (!pausedRef.current || opts.manual) apply(s, true);
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setLoading(false);
      }
    },
    [apply],
  );

  useEffect(() => {
    load();
    const s = getSocket();
    if (!s) return undefined;
    const onHealth = (p) => {
      lastEvent.current = Date.now();
      setLive(true);
      if (!pausedRef.current) apply(p, false);
    };
    const subscribe = () => s.emit("system.subscribe", {}, () => undefined);
    s.on("system.health", onHealth);
    s.on("connect", subscribe);
    if (s.connected) subscribe();
    const watchdog = setInterval(() => {
      if (Date.now() - lastEvent.current > 6000) {
        setLive(false);
        load(); // polling fallback
      } else if (!s.connected) setLive(false);
    }, 5000);
    // every 30 s refresh the slow data (proxy check) over REST even while streaming
    const slow = setInterval(() => load(), 30000);
    return () => {
      s.off("system.health", onHealth);
      s.off("connect", subscribe);
      s.emit("system.unsubscribe", {}, () => undefined);
      clearInterval(watchdog);
      clearInterval(slow);
    };
  }, [load, apply]);

  return { snap, error, live, loading, paused, setPaused, reload: load };
}
