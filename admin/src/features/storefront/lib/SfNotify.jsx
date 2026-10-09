import React, { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { NotifyProvider, useNotify } from "../../../lib/notify";
import { Ri } from "../components/ui";
import { categoryIcon, sfNotifyUrl } from "./notifyFmt";
import { useSfAuth } from "./SfAuth";
import { sfHttp } from "./sfApi";
import { closeSfRealtime, sfRealtime } from "./sfRealtime";

const TOAST_MS = 7000;
const MAX_TOASTS = 3;

/** In-app notification toasts: role=status + aria-live, auto-dismiss (paused while hovered / focused), a click opens the deep link. */
function NotifToasts({ toasts, go, onDismiss, onPause }) {
  const notify = useNotify();
  const onOpen = (t) => {
    onDismiss(t.id);
    notify?.store.markRead(t.id);
    go(t.url);
  };
  return (
    <div className="sf-ntoasts" role="status" aria-live="polite" aria-relevant="additions text" data-testid="notif-toasts">
      {toasts.map((t) => (
        <div key={t.id} className="sf-ntoast" data-testid="notif-toast" onMouseEnter={() => onPause(t.id, true)} onMouseLeave={() => onPause(t.id, false)} onFocus={() => onPause(t.id, true)} onBlur={() => onPause(t.id, false)}>
          <button type="button" className="sf-ntoast-main" onClick={() => onOpen(t)}>
            <span className="sf-ntoast-ic"><Ri name={categoryIcon(t.category)} /></span>
            <span className="sf-ntoast-text">
              <b>{t.title}</b>
              {t.body ? <span>{t.body}</span> : null}
            </span>
          </button>
          <button type="button" className="sf-iconbtn sf-ntoast-x" aria-label="Dismiss notification" onClick={() => onDismiss(t.id)}>
            <Ri name="close-line" />
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * Mounts the shared notification client (lib/notify) for the customer website, ONLY while a customer is signed in.
 * The provider itself stays in the tree (enabled=false when signed out) so signing in or out never remounts the pages.
 * The customer session has its own socket (lib/sfRealtime.js) and its own HTTP client; push is torn down by SfAuth.logout.
 */
export function SfNotifyBoundary({ children }) {
  const { user } = useSfAuth();
  const navigate = useNavigate();
  const [toasts, setToasts] = useState([]);
  const timers = useRef(new Map());
  const userRef = useRef(user);
  userRef.current = user;
  const getUserId = useCallback(() => userRef.current?.id || "anon", []);

  const dismiss = useCallback((id) => {
    const tm = timers.current.get(id);
    if (tm) clearTimeout(tm);
    timers.current.delete(id);
    setToasts((l) => l.filter((t) => t.id !== id));
  }, []);
  const arm = useCallback(
    (id) => {
      clearTimeout(timers.current.get(id));
      timers.current.set(id, setTimeout(() => dismiss(id), TOAST_MS));
    },
    [dismiss]
  );
  const onToast = useCallback(
    ({ notification: n }) => {
      if (!n?.id || !n.title) return;
      setToasts((l) => [...l.filter((t) => t.id !== n.id), { id: n.id, title: String(n.title), body: n.body ? String(n.body) : "", category: n.category, url: n.url }].slice(-MAX_TOASTS));
      arm(n.id);
    },
    [arm]
  );
  const pause = useCallback(
    (id, on) => {
      if (on) {
        clearTimeout(timers.current.get(id));
      } else arm(id);
    },
    [arm]
  );
  const go = useCallback((url) => navigate(sfNotifyUrl(url)), [navigate]);

  // signed out (also by an expired session): no live connection, no leftover toasts
  useEffect(() => {
    if (!user) {
      closeSfRealtime();
      setToasts([]);
    }
  }, [user]);
  useEffect(() => {
    const map = timers.current;
    return () => map.forEach((t) => clearTimeout(t));
  }, []);

  return (
    <NotifyProvider app="customer" enabled={!!user} identity={user?.id || ""} http={sfHttp} getSocket={sfRealtime.get} getUserId={getUserId} navigate={go} onToast={onToast}>
      {children}
      {user ? <NotifToasts toasts={toasts} go={go} onDismiss={dismiss} onPause={pause} /> : null}
    </NotifyProvider>
  );
}
