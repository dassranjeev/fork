import React, { useState } from "react";
import { Icon } from "@iconify/react/offline";
import { Link } from "react-router-dom";
import { useAuth } from "../../lib/auth";
import { ls, pushAdvice, useSharedPush } from "./shared";

const DAY = 86400000;
const ICON = { ask: "solar:bell-bing-outline", other: "solar:users-group-rounded-outline", denied: "solar:bell-off-outline", unsupported: "solar:bell-off-outline", insecure: "solar:shield-warning-outline", ios: "solar:smartphone-outline", off: "solar:bell-off-outline" };

/**
 * "Turn on notifications" banner under the header. It NEVER asks the browser for permission by itself: only the button calls
 * push.enable(). It explains every state (unsupported / insecure / iOS not installed / blocked / another account / switched off) and
 * remembers a dismissal for 14 days.
 */
export default function PushBanner({ portal }) {
  const sp = useSharedPush();
  const { user, impersonating } = useAuth();
  const [, bump] = useState(0);
  const app = portal === "restaurant" ? "restaurant" : "admin";
  const advice = pushAdvice(sp.state, app);
  if (impersonating || !advice || !user) return null;

  const st = sp.state;
  // the user already opted in on this browser and the permission is granted: the app repairs the subscription silently
  if (advice.kind === "ask" && st.optedIn && st.permission === "granted") return null;
  const key = `fk.pushbanner.${app}.${user.id}.${advice.kind}`;
  const dismissed = Number(ls.get(key)) > Date.now() || (advice.kind === "ask" && st.permission === "default" && !st.bannerVisible);
  if (dismissed) return null;

  const dismiss = () => {
    ls.set(key, String(Date.now() + 14 * DAY));
    if (advice.kind === "ask" && sp.push) sp.push.dismissBanner();
    bump((n) => n + 1);
  };
  const settings = portal === "restaurant" ? "/portal/notification-settings" : "/notification-settings";
  const primary = advice.tone === "primary";

  return (
    <div
      role="region"
      aria-label="Browser notifications"
      data-testid="push-banner"
      data-kind={advice.kind}
      className={`d-flex flex-wrap align-items-center gap-3 px-16 py-12 radius-12 mb-16 border ${primary ? "bg-primary-50" : ""}`}
    >
      <Icon icon={ICON[advice.kind] || ICON.ask} className={`text-2xl flex-shrink-0 ${primary ? "text-primary-600" : "text-secondary-light"}`} aria-hidden="true" />
      <div className="flex-grow-1" style={{ minWidth: 220 }}>
        <div className="fw-semibold">{advice.title}</div>
        <div className="text-secondary-light text-sm">{advice.text}</div>
        {sp.error && advice.cta === "enable" && (
          <div className="text-danger-600 text-sm mt-1" role="alert">
            {sp.error.message}
          </div>
        )}
      </div>
      <div className="d-flex align-items-center gap-2 flex-wrap">
        {advice.cta === "enable" && (
          <button type="button" className="btn btn-primary-600 btn-sm radius-8 px-16 py-8" disabled={sp.busy} onClick={() => sp.enable()}>
            {sp.busy ? "Waiting for your browser..." : advice.ctaLabel}
          </button>
        )}
        {advice.kind !== "ask" && advice.kind !== "other" && (
          <Link to={settings} className="text-primary-600 fw-semibold text-sm">
            Notification settings
          </Link>
        )}
        <button type="button" className="btn btn-link text-secondary-light p-1" aria-label="Dismiss this message" title="Dismiss" onClick={dismiss}>
          <Icon icon="radix-icons:cross-2" className="text-xl" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
