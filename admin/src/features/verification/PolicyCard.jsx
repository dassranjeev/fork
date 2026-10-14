import React, { useEffect, useState } from "react";
import { toast } from "react-toastify";
import { Badge, Button, Card, Modal, Switch } from "../../ui";
import { errorMessage, http } from "../../lib/api";
import { AUDIENCE, methodLabel } from "./shared";

const MODE_TONE = { INSTANT: "warning", MANUAL: "primary", AUTOMATIC: "info" };
const METHODS = [
  { value: "MANUAL", label: "Manual review" },
  { value: "AUTOMATIC", label: "Certn (automatic)" },
];
const INSTANT_WARNING = {
  DRIVER:
    "From now on every new driver can go online the moment they sign up. Nobody checks their documents, insurance or background first, so they have no vetting at all. They are recorded as Unverified until you force verification.",
  BUSINESS:
    "From now on every new business is live the moment it applies: its owner can use the portal and customers can order from it. Nobody checks its documents, menu or owner first, so it has no vetting at all. It is recorded as Unverified until you force verification.",
};

/**
 * The policy of one audience (drivers or businesses): instant registration on / off and the verification method. Sends only what changed
 * (PUT /admin/verification/policy). Turning instant registration ON and switching the method are confirmed first.
 */
export default function PolicyCard({ audience, policy, certn, onSaved }) {
  const a = AUDIENCE[audience];
  const [instant, setInstant] = useState(policy.instant);
  const [method, setMethod] = useState(policy.method);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  // the saved policy changed (after a save or a refresh): start again from it
  useEffect(() => {
    setInstant(policy.instant);
    setMethod(policy.method);
  }, [policy.instant, policy.method]);

  const changes = {};
  if (instant !== policy.instant) changes.instant = instant;
  if (method !== policy.method) changes.method = method;
  const dirty = Object.keys(changes).length > 0;
  const needsConfirm = changes.instant === true || changes.method !== undefined;
  const certnWasChosen = policy.method === "AUTOMATIC" && !certn.ready;

  const save = async () => {
    setBusy(true);
    try {
      await http.put("/admin/verification/policy", { [a.key]: changes });
      toast.success(`${a.title} settings saved`);
      setConfirming(false);
      onSaved();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const discard = () => {
    setInstant(policy.instant);
    setMethod(policy.method);
  };

  const title = changes.instant === true ? `Turn on instant registration for ${a.many}?` : `Change how ${a.many} are verified?`;

  return (
    <Card
      className="h-100"
      title={a.title}
      subtitle={a.blurb}
      footer={
        <div className="d-flex flex-wrap justify-content-end gap-2">
          <Button variant="light" disabled={!dirty || busy} onClick={discard}>
            Discard changes
          </Button>
          <Button loading={busy && !confirming} disabled={!dirty} onClick={() => (needsConfirm ? setConfirming(true) : save())}>
            Save changes
          </Button>
        </div>
      }
    >
      <div className="radius-8 bg-neutral-50 p-12 mb-20">
        <div className="d-flex flex-wrap align-items-center gap-2 mb-1">
          <span className="text-secondary-light text-xs text-uppercase fw-semibold">Right now, a new {a.one} gets</span>
          <Badge tone={MODE_TONE[policy.mode] || "neutral"}>{methodLabel(policy.mode)}</Badge>
        </div>
        <div className="text-sm" data-testid={`policy-description-${audience}`}>
          {policy.description}
        </div>
      </div>

      <Switch label="Instant registration" checked={instant} onChange={setInstant} hint={policy.modes.INSTANT} className="mb-20" />

      <div role="radiogroup" aria-labelledby={`method-label-${audience}`} className="mb-4">
        <div id={`method-label-${audience}`} className="form-label fw-semibold text-primary-light text-sm mb-8">
          Verification method
        </div>
        <div className="d-flex flex-column gap-2">
          {METHODS.map((m) => {
            const disabled = m.value === "AUTOMATIC" && !certn.ready;
            const checked = method === m.value;
            return (
              <label key={m.value} className={`d-flex align-items-start gap-3 border radius-8 p-12 mb-0 ${checked ? "border-primary-600 bg-primary-50" : ""} ${disabled ? "opacity-75" : ""}`} style={{ cursor: disabled ? "not-allowed" : "pointer" }}>
                <input type="radio" className="form-check-input mt-1 flex-shrink-0" name={`method-${audience}`} value={m.value} checked={checked} disabled={disabled} onChange={() => setMethod(m.value)} />
                <span>
                  <span className="d-block fw-semibold text-primary-light">{m.label}</span>
                  <span className="d-block text-secondary-light text-sm">{policy.modes[m.value]}</span>
                  {disabled && <span className="d-block text-danger-600 text-sm mt-4">Not available: {certn.reason || "Certn is not ready."}</span>}
                </span>
              </label>
            );
          })}
        </div>
      </div>
      <p className="text-secondary-light text-xs mt-8 mb-0">The method is what new sign-ups go through when instant registration is off, and what Force verification uses.</p>
      {certnWasChosen && (
        <div className="alert alert-warning radius-8 text-sm mt-16 mb-0" role="alert">
          Certn is chosen but not ready, so new {a.many} wait for staff review instead.
        </div>
      )}

      <Modal
        open={confirming}
        onClose={() => !busy && setConfirming(false)}
        title={title}
        footer={
          <>
            <Button variant="light" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button variant={changes.instant === true ? "danger" : "primary"} loading={busy} onClick={save}>
              {changes.instant === true ? "Turn on instant registration" : "Change method"}
            </Button>
          </>
        }
      >
        {changes.instant === true && (
          <div className="alert alert-danger radius-8" role="alert">
            <div className="fw-semibold mb-1">New {a.many} will have no vetting at all</div>
            {INSTANT_WARNING[audience]}
          </div>
        )}
        {changes.method !== undefined && (
          <div>
            <div className="fw-semibold mb-1">New verification method: {methodLabel(changes.method)}</div>
            <p className="text-secondary-light mb-8">{policy.modes[changes.method]}</p>
            <p className="text-secondary-light mb-0">It is used for new sign-ups when instant registration is off, and by Force verification. {a.title} who are already being verified keep the method they started with.</p>
          </div>
        )}
      </Modal>
    </Card>
  );
}
