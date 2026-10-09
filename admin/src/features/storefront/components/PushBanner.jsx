import React, { useEffect, useRef, useState } from "react";
import { usePushState } from "../../../lib/notify";
import { Ri, Spinner } from "./ui";

/** Can we offer "Turn on notifications" right now? (supported, switched on by FORKSY, not blocked, not already on) */
export function canOfferPush(state) {
  return !!state && !!state.support?.ok && !!state.config?.enabled && state.platformEnabled !== false && state.permission !== "denied" && !state.on;
}

/**
 * Dismissible "Turn on notifications" card. It NEVER asks the browser for permission by itself: only the button does.
 * "Not now" hides it for 14 days (remembered by the notification library per customer).
 */
export default function PushBanner({ className = "" }) {
  const { state, busy, error, enable, push } = usePushState();
  const clicked = useRef(false);
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (clicked.current && state?.on) {
      clicked.current = false;
      setDone(true);
      const t = setTimeout(() => setDone(false), 6000);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [state?.on]);

  if (done) {
    return (
      <div className={`sf-pushbanner is-done ${className}`} role="status" data-testid="push-banner-done">
        <Ri name="checkbox-circle-line" />
        <div className="sf-pushbanner-text">
          <b>Notifications are on</b>
          <span>We will tell you as your order moves along, even when this page is closed.</span>
        </div>
      </div>
    );
  }
  // nothing to show: unsupported / blocked / already on / dismissed (and no error to explain)
  if (!error && !state?.bannerVisible) return null;
  return (
    <section className={`sf-pushbanner ${className}`} aria-label="Order notifications" data-testid="push-banner">
      <Ri name="notification-3-line" />
      <div className="sf-pushbanner-text">
        <b>Get your order updates on this device</b>
        <span>Know when the restaurant accepts, when your driver arrives and when your food is delivered. You can turn it off any time.</span>
        {error && (
          <span className="sf-error" role="alert">
            {error.message}
          </span>
        )}
      </div>
      <div className="sf-pushbanner-actions">
        <button
          type="button"
          className="sf-btn sf-btn-primary sf-btn-sm"
          disabled={busy}
          onClick={() => {
            clicked.current = true;
            enable();
          }}
          data-testid="push-enable"
        >
          {busy ? <Spinner size={14} /> : null} Turn on notifications
        </button>
        <button type="button" className="sf-btn sf-btn-link" onClick={() => push?.dismissBanner()} data-testid="push-dismiss">
          Not now
        </button>
      </div>
    </section>
  );
}
