import React, { useCallback, useEffect, useRef, useState } from "react";

/**
 * Inactivity auto-logout. Configure per build with REACT_APP_IDLE_MINUTES_ADMIN / REACT_APP_IDLE_MINUTES_PORTAL
 * (0 disables). Admin default 30 min. The restaurant portal defaults to 8 h because a kitchen display is
 * legitimately watched without touching it; the KDS route is also exempt.
 */
const num = (v, d) => (v === undefined || v === "" || Number.isNaN(Number(v)) ? d : Number(v));
export const IDLE_MINUTES = {
  admin: num(process.env.REACT_APP_IDLE_MINUTES_ADMIN, 30),
  restaurant: num(process.env.REACT_APP_IDLE_MINUTES_PORTAL, 480),
};
export const IDLE_WARNING_SECONDS = 60;
const ACTIVITY_KEY = "forksy.lastActive"; // shared across tabs so activity in one tab keeps the others alive
const EVENTS = ["mousedown", "keydown", "touchstart", "scroll", "wheel", "pointermove"];

const readLast = () => {
  try {
    return Number(localStorage.getItem(ACTIVITY_KEY)) || 0;
  } catch {
    return 0;
  }
};

export function IdleGuard({ type, onTimeout, suspended }) {
  const idleMs = (type === "restaurant" ? IDLE_MINUTES.restaurant : IDLE_MINUTES.admin) * 60 * 1000;
  const last = useRef(Date.now());
  const [left, setLeft] = useState(null); // seconds remaining while the warning is shown
  const timeoutRef = useRef(onTimeout);
  timeoutRef.current = onTimeout;

  const touch = useCallback(() => {
    const now = Date.now();
    if (now - last.current < 1000) return; // throttle
    last.current = now;
    try {
      localStorage.setItem(ACTIVITY_KEY, String(now));
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (!idleMs) return undefined;
    touch();
    EVENTS.forEach((e) => window.addEventListener(e, touch, { passive: true, capture: true }));
    const tick = setInterval(() => {
      if (suspended) {
        last.current = Date.now();
        setLeft(null);
        return;
      }
      const lastSeen = Math.max(last.current, readLast());
      const idle = Date.now() - lastSeen;
      if (idle >= idleMs) {
        clearInterval(tick);
        timeoutRef.current?.();
      } else if (idle >= idleMs - IDLE_WARNING_SECONDS * 1000) {
        setLeft(Math.ceil((idleMs - idle) / 1000));
      } else {
        setLeft(null);
      }
    }, 1000);
    return () => {
      clearInterval(tick);
      EVENTS.forEach((e) => window.removeEventListener(e, touch, { capture: true }));
    };
  }, [idleMs, suspended, touch]);

  if (!idleMs || left === null) return null;
  return (
    <div role="alertdialog" aria-live="assertive" style={{ position: "fixed", inset: 0, zIndex: 20000, background: "rgba(0,0,0,.55)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div className="card radius-12 p-24" style={{ maxWidth: 420 }}>
        <h6 className="mb-8">Still there?</h6>
        <p className="text-secondary-light mb-16">
          For your security you will be signed out in <b>{left}</b> second{left === 1 ? "" : "s"} because of inactivity.
        </p>
        <div className="d-flex gap-2 justify-content-end">
          <button type="button" className="btn btn-outline-danger btn-sm" onClick={() => timeoutRef.current?.()}>
            Sign out now
          </button>
          <button
            type="button"
            className="btn btn-primary-600 btn-sm"
            autoFocus
            onClick={() => {
              last.current = 0;
              touch();
              setLeft(null);
            }}
          >
            Stay signed in
          </button>
        </div>
      </div>
    </div>
  );
}
