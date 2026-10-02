import React from "react";
import { Icon } from "@iconify/react/offline";
import { Badge, useConfirm } from "../../ui";
import { fmtTime } from "../../lib/format";
import { useAction, useApi } from "./shared";
import { usePortal } from "./context";

/** The three service modes a store can switch between (colour-coded red / amber / green). */
export const SERVICE_MODES = [
  { key: "CLOSED", label: "Closed", icon: "solar:close-circle-outline", tone: "danger", hint: "Not taking any new orders" },
  { key: "PICKUP_ONLY", label: "Pickup only", icon: "solar:bag-4-outline", tone: "warning", hint: "Customers can order pickup only; no delivery" },
  { key: "PICKUP_AND_DELIVERY", label: "Pickup & delivery", icon: "solar:delivery-outline", tone: "success", hint: "Pickup and delivery orders" },
];

const COLOR = {
  danger: { bg: "#dc3545", soft: "rgba(220,53,69,.10)", text: "#dc3545" },
  warning: { bg: "#f59e0b", soft: "rgba(245,158,11,.14)", text: "#b45309" },
  success: { bg: "#16a34a", soft: "rgba(22,163,74,.12)", text: "#15803d" },
};

export const modeMeta = (key) => SERVICE_MODES.find((m) => m.key === key) || SERVICE_MODES[2];

/** Small coloured badge for headers / lists. */
export function ServiceModeBadge({ mode, className = "" }) {
  if (!mode) return null;
  const m = modeMeta(mode);
  return (
    <Badge tone={m.tone} className={className}>
      <Icon icon={m.icon} className="me-1 align-text-bottom" />
      {m.label}
    </Badge>
  );
}

const RESUME_OPTIONS = [
  { value: "0", label: "Until I switch it back" },
  { value: "1", label: "For 1 hour, then back to Pickup & delivery" },
  { value: "2", label: "For 2 hours, then back to Pickup & delivery" },
  { value: "4", label: "For 4 hours, then back to Pickup & delivery" },
  { value: "24", label: "For 24 hours, then back to Pickup & delivery" },
];

/**
 * Three-way segmented control (Closed | Pickup only | Pickup & delivery).
 * Switching away from "Pickup & delivery" asks for confirmation (with an optional auto-resume time);
 * orders that are already open are told they carry on as normal.
 */
export default function ServiceModeControl({ mode, resumeAt, openOrders, onChanged, disabled, compact }) {
  const api = useApi();
  const confirm = useConfirm();
  const { reloadLocations, setLocationMode } = usePortal();
  const { run, isBusy } = useAction();
  const current = mode || "PICKUP_AND_DELIVERY";

  const choose = async (key) => {
    if (key === current || disabled) return;
    const body = { mode: key };
    if (key !== "PICKUP_AND_DELIVERY") {
      const target = modeMeta(key);
      const orderNote = openOrders > 0 ? ` You have ${openOrders} open order${openOrders === 1 ? "" : "s"}; they keep their original fulfilment and will continue as normal.` : " Orders already placed keep their original fulfilment and continue as normal.";
      const r = await confirm({
        title: key === "CLOSED" ? "Close the store?" : "Switch to pickup only?",
        message:
          (key === "CLOSED" ? "Customers will see the store as closed and cannot place any new orders." : "Customers can only place pickup orders; delivery is switched off and no drivers are dispatched.") + orderNote,
        confirmText: `Switch to ${target.label}`,
        danger: key === "CLOSED",
        prompt: { label: "How long?", type: "select", options: RESUME_OPTIONS, defaultValue: "0" },
      });
      if (!r.confirmed) return;
      if (r.value && r.value !== "0") body.resumeAt = new Date(Date.now() + Number(r.value) * 3600_000).toISOString();
    }
    const res = await run(key, () => api.patch("/restaurant/store/service-mode", body), `Store is now ${modeMeta(key).label.toLowerCase()}`);
    if (res.ok) {
      setLocationMode?.(res.data);
      reloadLocations?.();
      onChanged?.(res.data);
    }
  };

  const active = modeMeta(current);
  return (
    <div>
      <div className="d-flex flex-wrap gap-2" role="radiogroup" aria-label="Service mode">
        {SERVICE_MODES.map((m) => {
          const on = m.key === current;
          const c = COLOR[m.tone];
          return (
            <button
              key={m.key}
              type="button"
              role="radio"
              aria-checked={on}
              data-testid={`mode-${m.key}`}
              disabled={disabled || isBusy()}
              onClick={() => choose(m.key)}
              className="btn d-flex align-items-center justify-content-center gap-2 radius-8 fw-semibold flex-fill"
              style={{
                minWidth: compact ? 130 : 170,
                padding: compact ? "8px 14px" : "14px 18px",
                border: `2px solid ${on ? c.bg : "var(--neutral-300, #d1d5db)"}`,
                background: on ? c.bg : "transparent",
                color: on ? "#fff" : c.text,
                opacity: disabled ? 0.6 : 1,
              }}
              title={m.hint}
            >
              <Icon icon={isBusy(m.key) ? "line-md:loading-twotone-loop" : m.icon} className="text-xl" />
              {m.label}
            </button>
          );
        })}
      </div>
      <div className="text-sm mt-8" style={{ color: COLOR[active.tone].text }}>
        {active.hint}{" "}
        {resumeAt && current !== "PICKUP_AND_DELIVERY" && <span className="text-secondary-light"> · switches back to Pickup &amp; delivery at {fmtTime(resumeAt)}</span>}
      </div>
    </div>
  );
}
