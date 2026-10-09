import React, { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react/offline";
import { Link } from "react-router-dom";
import { useAuth } from "../../lib/auth";
import { useNotifications } from "../../lib/notify";
import { CategoryIcon, pushAdvice, relTime, useMinuteTick, useSharedPush } from "./shared";

const CSS = `
.fk-bell-panel{position:absolute;right:0;top:48px;width:380px;max-width:calc(100vw - 24px);z-index:1040;overflow:hidden;background:var(--bs-body-bg,#fff);color:var(--bs-body-color,inherit);border:1px solid var(--bs-border-color-translucent,rgba(0,0,0,.12))}
@media (max-width:575.98px){.fk-bell-panel{position:fixed;left:12px;right:12px;top:76px;width:auto;max-width:none}}
.fk-bell-item:hover,.fk-bell-item:focus-within{background:var(--bs-tertiary-bg,#f3f4f6)}
.fk-bell-main{background:transparent;border:0;text-align:start;min-width:0}
.fk-bell-main:focus-visible,.fk-bell-act:focus-visible,.fk-bell-btn:focus-visible{outline:2px solid var(--primary-600,#f97316);outline-offset:-2px}
.fk-bell-act{width:28px;height:28px;border:0;background:transparent;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;color:var(--bs-secondary-color,#6b7280)}
.fk-bell-act:hover{background:var(--bs-secondary-bg,#e5e7eb)}
`;

/**
 * The header bell: unread badge, live updates (useNotifications), keyboard accessible dropdown (Escape closes and gives the focus back
 * to the bell, items are real buttons), mark read / delete per item, "Mark all read", link to the full list, and an inline offer to
 * turn on notifications on this device (never prompts by itself).
 */
export default function NotificationBell({ portal }) {
  const { items, unread, loaded, loading, error, markRead, markAllRead, remove, open, refresh } = useNotifications();
  const sp = useSharedPush();
  const { impersonating } = useAuth();
  const [isOpen, setOpen] = useState(false);
  const wrap = useRef(null);
  const btn = useRef(null);
  const [announce, setAnnounce] = useState("");
  const seen = useRef(null);
  useMinuteTick();

  const listPath = portal === "restaurant" ? "/portal/notifications" : "/inbox";
  const settingsPath = portal === "restaurant" ? "/portal/notification-settings" : "/notification-settings";

  // polite announcement of NEW notifications for screen readers
  useEffect(() => {
    if (!loaded) return;
    if (seen.current === null) {
      seen.current = new Set(items.map((i) => i.id));
      return;
    }
    const fresh = items.filter((i) => !seen.current.has(i.id));
    items.forEach((i) => seen.current.add(i.id));
    if (fresh.length) setAnnounce(`New notification: ${fresh[0].title}`);
  }, [items, loaded]);

  const close = useCallback((focusBell) => {
    setOpen(false);
    if (focusBell && btn.current) btn.current.focus();
  }, []);

  useEffect(() => {
    if (!isOpen) return undefined;
    const onDown = (e) => wrap.current && !wrap.current.contains(e.target) && setOpen(false);
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [isOpen]);

  const onKeyDown = (e) => {
    if (e.key === "Escape" && isOpen) {
      e.stopPropagation();
      close(true);
    }
  };
  const onBlur = (e) => {
    // keyboard focus left the whole widget: close (focus stays where the user moved it)
    if (isOpen && e.relatedTarget && wrap.current && !wrap.current.contains(e.relatedTarget)) setOpen(false);
  };

  const advice = !impersonating ? pushAdvice(sp.state, portal === "restaurant" ? "restaurant" : "admin") : null;
  const offer = advice && advice.cta === "enable" ? advice : null;
  const latest = items.slice(0, 8);
  const label = `Notifications, ${unread} unread`;

  return (
    <div className="position-relative" ref={wrap} onKeyDown={onKeyDown} onBlur={onBlur}>
      <style>{CSS}</style>
      <button
        ref={btn}
        type="button"
        className="fk-bell-btn has-indicator w-40-px h-40-px bg-neutral-200 rounded-circle d-flex justify-content-center align-items-center position-relative border-0"
        aria-label={label}
        aria-haspopup="true"
        aria-expanded={isOpen}
        aria-controls="fk-bell-panel"
        onClick={() => setOpen((o) => !o)}
      >
        <Icon icon="iconoir:bell" className="text-primary-light text-xl" aria-hidden="true" />
        {unread > 0 && (
          <span className="position-absolute top-0 end-0 badge rounded-pill bg-danger-600 text-white" style={{ fontSize: 10 }} aria-hidden="true" data-testid="bell-badge">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>
      <span className="visually-hidden" role="status" aria-live="polite" data-testid="bell-live">
        {announce}
      </span>
      {isOpen && (
        <div id="fk-bell-panel" className="fk-bell-panel p-0 radius-12 shadow header-dropdown" role="region" aria-label="Notifications">
          <div className="py-12 px-16 radius-8 bg-primary-50 d-flex align-items-center justify-content-between gap-2 m-2">
            <h6 className="text-lg text-primary-light fw-semibold mb-0">
              Notifications {unread > 0 && <span className="badge bg-danger-600 text-white ms-1">{unread}</span>}
            </h6>
            <button type="button" className="btn btn-link p-0 text-primary-600 text-sm" disabled={unread === 0} onClick={markAllRead}>
              Mark all read
            </button>
          </div>

          {offer && (
            <div className="mx-2 mb-2 p-12 radius-8 border" data-testid="bell-push-offer">
              <div className="d-flex align-items-start gap-2">
                <Icon icon="solar:bell-bing-outline" className="text-xl text-primary-600 flex-shrink-0 mt-1" aria-hidden="true" />
                <div className="flex-grow-1">
                  <div className="fw-semibold text-sm">Turn on notifications on this device</div>
                  <div className="text-secondary-light text-xs mb-8">{offer.title}</div>
                  <button type="button" className="btn btn-primary-600 btn-sm radius-8 px-12 py-6" disabled={sp.busy} onClick={() => sp.enable()}>
                    {sp.busy ? "Waiting..." : offer.ctaLabel}
                  </button>
                  {sp.error && <div className="text-danger-600 text-xs mt-4">{sp.error.message}</div>}
                </div>
              </div>
            </div>
          )}

          <div className="overflow-y-auto" style={{ maxHeight: 380 }}>
            {!loaded && loading && <p className="text-center text-secondary-light py-24 mb-0">Loading...</p>}
            {loaded && error && latest.length === 0 && (
              <div className="text-center py-24 px-16">
                <p className="text-secondary-light mb-8">Could not load your notifications.</p>
                <button type="button" className="btn btn-outline-primary-600 btn-sm radius-8" onClick={refresh}>
                  Try again
                </button>
              </div>
            )}
            {loaded && !error && latest.length === 0 && (
              <div className="text-center text-secondary-light py-24 px-16">
                <Icon icon="solar:inbox-outline" className="text-4xl mb-8" style={{ opacity: 0.5 }} aria-hidden="true" />
                <p className="mb-0">You are all caught up</p>
              </div>
            )}
            {latest.length > 0 && (
              <ul className="list-unstyled mb-0" aria-label="Latest notifications">
                {latest.map((n) => (
                  <li key={n.id} className={`fk-bell-item d-flex align-items-start border-top ${n.readAt ? "" : "bg-primary-50"}`}>
                    <button
                      type="button"
                      className="fk-bell-main flex-grow-1 d-flex align-items-start gap-2 px-16 py-12"
                      onClick={() => {
                        open(n);
                        close(false);
                      }}
                    >
                      <CategoryIcon category={n.category} size={32} />
                      <span className="d-block flex-grow-1" style={{ minWidth: 0 }}>
                        <span className={`d-block text-sm text-break ${n.readAt ? "" : "fw-semibold"}`}>
                          {!n.readAt && <span className="visually-hidden">Unread: </span>}
                          {n.title}
                        </span>
                        {n.body && (
                          <span className="text-secondary-light text-xs text-break" style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                            {n.body}
                          </span>
                        )}
                        <span className="d-block text-secondary-light text-xs mt-1">{relTime(n.createdAt)}</span>
                      </span>
                      {!n.readAt && <span className="d-inline-block rounded-circle bg-primary-600 flex-shrink-0 mt-2" style={{ width: 8, height: 8 }} aria-hidden="true" />}
                    </button>
                    <span className="d-flex flex-column gap-1 py-8 pe-8 flex-shrink-0">
                      {!n.readAt && (
                        <button type="button" className="fk-bell-act" title="Mark as read" aria-label={`Mark as read: ${n.title}`} onClick={() => markRead(n.id)}>
                          <Icon icon="solar:check-read-outline" aria-hidden="true" />
                        </button>
                      )}
                      <button type="button" className="fk-bell-act" title="Delete" aria-label={`Delete: ${n.title}`} onClick={() => remove(n.id)}>
                        <Icon icon="solar:trash-bin-minimalistic-outline" aria-hidden="true" />
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="d-flex align-items-center justify-content-between gap-2 px-16 py-12 border-top">
            <Link to={listPath} className="text-primary-600 fw-semibold text-sm" onClick={() => close(false)}>
              See all notifications
            </Link>
            <Link to={settingsPath} className="text-secondary-light text-sm d-inline-flex align-items-center gap-1" onClick={() => close(false)}>
              <Icon icon="solar:settings-outline" aria-hidden="true" /> Settings
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
