import React from "react";
import { Icon } from "@iconify/react/offline";
import { useNavigate } from "react-router-dom";
import { safeUrl, useAlerts } from "../../lib/notify";
import { usePortal } from "../portal/context";

const CSS = `
.fk-alarm{position:sticky;top:4.5rem;z-index:1;background:#b91c1c;color:#fff;border-bottom:3px solid #7f1d1d;box-shadow:0 6px 16px rgba(127,29,29,.35);animation:fk-alarm-pulse 1.4s ease-in-out infinite}
.fk-alarm .fk-alarm-row{background:rgba(255,255,255,.12);border-radius:8px}
.fk-alarm .btn-light{color:#7f1d1d;font-weight:600}
.fk-alarm .btn-outline-light{font-weight:600}
@keyframes fk-alarm-pulse{0%,100%{background:#b91c1c}50%{background:#dc2626}}
@media (prefers-reduced-motion:reduce){.fk-alarm{animation:none}}
`;

const LABEL = { order: "New order", cancel: "Cancellation request", offer: "New offer" };

/**
 * Restaurant Portal ALARM: a sticky, pulsing red stack at the top of every portal page while a new order / cancellation request is
 * waiting. One row per alert with [Open order] (opens the deep link AND acknowledges) and [Acknowledge]. The sound itself is played by
 * lib/notify (repeating until the order is accepted / rejected / changes status, or the alert is acknowledged; only one open tab rings).
 */
export default function AlarmBanner() {
  const { items, soundState, ringing, leader, acknowledge, unlockSound, sound } = useAlerts();
  const navigate = useNavigate();
  const { restaurantId, setRestaurantId } = usePortal();
  if (!items.length) return null;

  const muted = sound && !sound.enabled();
  const openOrder = (a) => {
    acknowledge(a.id, a.kind);
    if (a.restaurantId && a.restaurantId !== restaurantId) setRestaurantId(a.restaurantId);
    const url = safeUrl(a.url, null);
    navigate(url || "/portal/orders");
  };
  const n = items.length;

  return (
    <div className="fk-alarm px-16 py-12" role="alert" aria-live="assertive" data-testid="alarm-banner" data-count={n} data-sound={soundState}>
      <style>{CSS}</style>
      <div className="d-flex flex-wrap align-items-center justify-content-between gap-2 mb-8">
        <div className="d-flex align-items-center gap-2 fw-bold text-lg">
          <Icon icon="solar:bell-bing-bold" className="text-2xl" aria-hidden="true" />
          <span data-testid="alarm-count">
            {n} {n === 1 ? "alert needs" : "alerts need"} your attention
          </span>
        </div>
        <div className="d-flex align-items-center gap-2 flex-wrap">
          {soundState === "blocked" && !muted && (
            <button type="button" className="btn btn-light btn-sm radius-8 px-16 py-8 fw-bold d-inline-flex align-items-center gap-2" onClick={unlockSound} data-testid="alarm-unlock">
              <Icon icon="solar:volume-cross-outline" className="text-xl" aria-hidden="true" />
              Sound is blocked by your browser - click to enable the alarm
            </button>
          )}
          {soundState === "running" && !muted && (
            <span className="d-inline-flex align-items-center gap-2 text-sm" data-testid="alarm-sound-on">
              <Icon icon="solar:volume-loud-outline" className="text-xl" aria-hidden="true" />
              {leader || ringing ? "Alarm sound on" : "Alarm is ringing in another window"}
              <button type="button" className="btn btn-outline-light btn-sm radius-8 px-12 py-4" onClick={() => acknowledge()} title="Silence the alarm by acknowledging every alert">
                Silence all
              </button>
            </span>
          )}
          {soundState !== "unsupported" && muted && (
            <span className="text-sm d-inline-flex align-items-center gap-2" data-testid="alarm-sound-off">
              <Icon icon="solar:volume-cross-outline" className="text-xl" aria-hidden="true" />
              Alarm sound is off in your notification settings
            </span>
          )}
          {soundState === "unsupported" && <span className="text-sm">This browser cannot play the alarm sound - keep this tab visible.</span>}
        </div>
      </div>
      <ul className="list-unstyled mb-0 d-flex flex-column gap-2">
        {items.map((a) => (
          <li key={`${a.kind}:${a.id}`} className="fk-alarm-row d-flex flex-wrap align-items-center justify-content-between gap-2 px-12 py-8" data-kind={a.kind} data-order={a.id}>
            <div style={{ minWidth: 0 }}>
              <div className="fw-semibold text-break">{a.title || LABEL[a.kind] || "Alert"}</div>
              {a.body && <div className="text-sm text-break" style={{ opacity: 0.92 }}>{a.body}</div>}
            </div>
            <div className="d-flex gap-2 flex-shrink-0">
              <button type="button" className="btn btn-light btn-sm radius-8 px-16 py-8" onClick={() => openOrder(a)} data-testid="alarm-open">
                Open order
              </button>
              <button type="button" className="btn btn-outline-light btn-sm radius-8 px-16 py-8" onClick={() => acknowledge(a.id, a.kind)} data-testid="alarm-ack">
                Acknowledge
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
