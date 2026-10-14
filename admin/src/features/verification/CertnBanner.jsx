import React from "react";
import { Icon } from "@iconify/react/offline";
import { toast } from "react-toastify";
import { Badge, Button } from "../../ui";
import { copyText } from "./shared";

const LOOK = {
  ready: { border: "border-success-main", bg: "bg-success-100 text-success-600", icon: "solar:shield-check-outline" },
  mock: { border: "border-warning-main", bg: "bg-warning-100 text-warning-600", icon: "solar:danger-triangle-outline" },
  down: { border: "border-danger-main", bg: "bg-danger-100 text-danger-600", icon: "solar:close-circle-outline" },
};

/** Tells the Super Admin whether the automatic (Certn) method can work right now, and where Certn has to send its results. */
export default function CertnBanner({ certn }) {
  const state = !certn.ready ? "down" : certn.mock ? "mock" : "ready";
  const look = LOOK[state];
  const title = { ready: "Certn is connected", mock: "Certn is not connected: the development mock is running", down: "Automatic verification is not available" }[state];
  const text = {
    ready: "Automatic verification can be used. Certn identity and criminal-record checks are started from here and their results are received on the address below.",
    mock: "No Certn API key is set, so the built-in mock clears every check a few seconds after it starts. It is for trying the flow only: it checks nobody.",
    down: `${certn.reason || "Certn is not ready."} Until this is fixed the Certn option is disabled below, and a sign-up that was meant for Certn waits for staff review instead.`,
  }[state];

  const copy = async () => {
    if (await copyText(certn.webhookUrl)) toast.success("Webhook address copied");
    else toast.error("Could not copy. Select the address and copy it by hand.");
  };

  return (
    <div className={`card radius-12 border shadow-sm mb-24 ${look.border}`} role="status" aria-live="polite" data-testid="certn-banner">
      <div className="card-body p-20">
        <div className="d-flex flex-wrap align-items-start gap-3">
          <div className={`w-48-px h-48-px rounded-circle d-flex justify-content-center align-items-center flex-shrink-0 ${look.bg}`}>
            <Icon icon={look.icon} className="text-2xl mb-0" />
          </div>
          <div style={{ flex: "1 1 260px", minWidth: 0 }}>
            <h6 className="mb-4" data-testid="certn-title">
              {title}
            </h6>
            <p className="mb-0 text-secondary-light">{text}</p>
          </div>
        </div>
        <div className="row gy-3 mt-8">
          <div className="col-lg-4 col-md-6">
            <div className="text-secondary-light text-sm mb-1">API key (CERTN_API_KEY)</div>
            <Badge tone={certn.configured ? "success" : "neutral"}>{certn.configured ? "Set" : "Not set"}</Badge>
          </div>
          <div className="col-lg-4 col-md-6">
            <div className="text-secondary-light text-sm mb-1">Webhook secret (CERTN_WEBHOOK_SECRET)</div>
            <Badge tone={certn.webhookSecret ? "success" : "neutral"}>{certn.webhookSecret ? "Set" : "Not set"}</Badge>
          </div>
          <div className="col-12">
            <label className="text-secondary-light text-sm mb-1 d-block" htmlFor="certn-webhook-url">
              Webhook address: enter it in the Certn dashboard so results reach FORKSY
            </label>
            {certn.webhookUrl ? (
              <div className="d-flex gap-2">
                <input id="certn-webhook-url" readOnly className="form-control form-control-sm radius-8 font-monospace" value={certn.webhookUrl} onFocus={(e) => e.target.select()} />
                <Button variant="light" icon="solar:copy-outline" onClick={copy}>
                  Copy
                </Button>
              </div>
            ) : (
              <span className="text-warning-600 text-sm">Not known yet: set PUBLIC_URL (or CERTN_WEBHOOK_URL) on the API server.</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
