import React, { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useNotifications, usePushState } from "../../../lib/notify";
import { categoryIcon, timeAgo } from "../lib/notifyFmt";
import { errorMessage } from "../lib/sfApi";
import { canOfferPush } from "./PushBanner";
import { Ri, Spinner } from "./ui";

/** "Turn on notifications" inside the dropdown (mounted only while it is open: it reads the push state from the API). */
function TurnOn() {
  const { state, busy, error, enable } = usePushState();
  if (!canOfferPush(state) && !error) return null;
  return (
    <div className="sf-npanel-push">
      <button type="button" className="sf-btn sf-btn-light sf-btn-sm sf-btn-block" onClick={enable} disabled={busy} data-testid="bell-push-enable">
        {busy ? <Spinner size={14} /> : <Ri name="notification-badge-line" />} Turn on notifications
      </button>
      {error && (
        <p className="sf-error" role="alert">
          {error.message}
        </p>
      )}
    </div>
  );
}

/** Header bell for signed-in customers: unread badge, live count for screen readers and a dropdown with the latest notifications. */
export default function NotifyBell() {
  const n = useNotifications();
  const loc = useLocation();
  const [open, setOpen] = useState(false);
  const [top, setTop] = useState(64);
  const wrap = useRef(null);
  const btn = useRef(null);
  const unread = n.unread || 0;
  const onPage = loc.pathname.replace(/\/+$/, "") === "/order/notifications";
  const label = unread > 0 ? `Notifications, ${unread} unread` : "Notifications";

  useEffect(() => setOpen(false), [loc.pathname]);
  useEffect(() => {
    if (!open) return undefined;
    const down = (e) => !wrap.current?.contains(e.target) && setOpen(false);
    const key = (e) => {
      if (e.key === "Escape") {
        setOpen(false);
        btn.current?.focus();
      }
    };
    document.addEventListener("pointerdown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  const toggle = () => {
    if (!open) {
      const h = btn.current?.closest(".sf-header");
      if (h) setTop(Math.round(h.getBoundingClientRect().bottom) + 6);
      // without a live socket the list can be stale: read it again when the customer looks
      if (!n.connected) n.refresh();
    }
    setOpen((v) => !v);
  };

  const live = (
    <span className="visually-hidden" role="status" aria-live="polite" data-testid="bell-live">
      {unread > 0 ? `${unread} unread notification${unread === 1 ? "" : "s"}` : "No unread notifications"}
    </span>
  );
  const badge =
    unread > 0 ? (
      <span className="sf-badge" data-testid="bell-badge" aria-hidden="true">
        {unread > 99 ? "99+" : unread}
      </span>
    ) : null;

  if (onPage) {
    return (
      <span className="sf-menu-wrap">
        <Link to="/order/notifications" className="sf-cartbtn sf-bell" aria-label={label} aria-current="page" data-testid="bell">
          <Ri name="notification-3-fill" />
          {badge}
        </Link>
        {live}
      </span>
    );
  }

  const items = (n.items || []).slice(0, 6);
  return (
    <div
      className="sf-menu-wrap"
      ref={wrap}
      onBlur={(e) => {
        if (open && e.relatedTarget && !wrap.current?.contains(e.relatedTarget)) setOpen(false);
      }}
    >
      <button type="button" ref={btn} className="sf-cartbtn sf-bell" aria-label={label} aria-haspopup="dialog" aria-expanded={open} onClick={toggle} data-testid="bell">
        <Ri name={unread > 0 ? "notification-3-fill" : "notification-3-line"} />
        {badge}
      </button>
      {live}
      {open && (
        <div className="sf-npanel" style={{ "--np-top": `${top}px` }} role="dialog" aria-label="Notifications" data-testid="bell-panel">
          <div className="sf-npanel-head">
            <b>Notifications</b>
            <button type="button" className="sf-btn sf-btn-link" onClick={n.markAllRead} disabled={unread === 0} data-testid="bell-mark-all">
              Mark all read
            </button>
          </div>
          <div className="sf-npanel-body">
            {!n.loaded && n.loading && (
              <div className="sf-center sf-muted py-3">
                <Spinner size={20} />
              </div>
            )}
            {n.error && items.length === 0 && (
              <div className="sf-npanel-empty" role="alert">
                <p className="mb-2">{errorMessage(n.error)}</p>
                <button type="button" className="sf-btn sf-btn-light sf-btn-sm" onClick={n.refresh}>
                  Try again
                </button>
              </div>
            )}
            {n.loaded && !n.error && items.length === 0 && (
              <div className="sf-npanel-empty" data-testid="bell-empty">
                <Ri name="notification-off-line" />
                <b>You are all caught up</b>
                <span className="sf-small sf-muted">Order updates will show up here.</span>
              </div>
            )}
            {items.length > 0 && (
              <ul className="sf-nlist">
                {items.map((it) => (
                  <li key={it.id}>
                    <button
                      type="button"
                      className={`sf-nitem ${it.readAt ? "" : "unread"}`}
                      data-testid="bell-item"
                      onClick={() => {
                        setOpen(false);
                        n.open(it);
                      }}
                    >
                      <span className="sf-nic">
                        <Ri name={categoryIcon(it.category)} />
                      </span>
                      <span className="sf-ntext">
                        <span className="sf-ntitle">{it.title}</span>
                        {it.body ? <span className="sf-nbody">{it.body}</span> : null}
                        <span className="sf-ntime">
                          {timeAgo(it.createdAt)}
                          {!it.readAt && <span className="visually-hidden"> (unread)</span>}
                        </span>
                      </span>
                      {!it.readAt && <span className="sf-ndot" aria-hidden="true" />}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <TurnOn />
          <div className="sf-npanel-foot">
            <Link to="/order/notifications" className="sf-btn sf-btn-light sf-btn-sm sf-btn-block" data-testid="bell-see-all">
              See all notifications
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
