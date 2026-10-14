import React, { useState } from "react";
import { toast } from "react-toastify";
import { Badge, Button, Card, Field, FormModal, Modal } from "../../ui";
import { errorMessage, http } from "../../lib/api";
import { fmtDate } from "../../lib/format";
import { AUDIENCE, BULLETS, FORCE_OUTCOMES, GRACE_OPTIONS, countOf, dueDateFor, forceConsequences, humanize, methodLabel, plural } from "./shared";

const DEFAULT_GRACE_DAYS = 7;
const OUTCOME_ORDER = ["GRACE", "BLOCKED", "DEFERRED", "VERIFIED", "SKIPPED", "FAILED"];

/**
 * State of the "method / deadline / reason" form of Force verification. The method follows the policy until the admin picks one; Certn is
 * never offered while it is not ready.
 */
export function useForceForm(policy, certn) {
  const [choice, setChoice] = useState(null);
  const [graceDays, setGraceDays] = useState(DEFAULT_GRACE_DAYS);
  const [reason, setReason] = useState("");
  const wanted = choice ?? policy.method;
  const method = wanted === "AUTOMATIC" && !certn.ready ? "MANUAL" : wanted;
  return {
    value: { method, graceDays, reason },
    apply: (patch) => {
      if ("method" in patch) setChoice(patch.method);
      if ("graceDays" in patch) setGraceDays(patch.graceDays);
      if ("reason" in patch) setReason(patch.reason);
    },
    reset: () => {
      setChoice(null);
      setGraceDays(DEFAULT_GRACE_DAYS);
      setReason("");
    },
  };
}

/** The three fields of Force verification: method, deadline and an optional reason. `onChange` gets the changed field only. */
export function ForceFields({ audience, certn, value, onChange }) {
  const a = AUDIENCE[audience];
  const control = "form-select form-control radius-8";
  return (
    <div className="row">
      <Field col={6} label="Method" hint={value.method === "AUTOMATIC" ? "Certn emails a verification link to each account; clear results verify automatically." : "Staff review each account and verify it."}>
        <select className={control} aria-label="Method" value={value.method} onChange={(e) => onChange({ method: e.target.value })}>
          <option value="MANUAL">Manual review</option>
          <option value="AUTOMATIC" disabled={!certn.ready}>
            Certn (automatic){certn.ready ? "" : " - not available"}
          </option>
        </select>
        {!certn.ready && <div className="text-danger-600 text-xs mt-4">Certn is not available: {certn.reason || "it is not ready."}</div>}
      </Field>
      <Field col={6} label="Deadline" hint={value.graceDays === 0 ? `Working ${a.many} are taken ${a.offWork} straight away.` : `They keep working until ${fmtDate(dueDateFor(value.graceDays))}.`}>
        <select className={control} aria-label="Deadline" value={value.graceDays} onChange={(e) => onChange({ graceDays: Number(e.target.value) })}>
          {GRACE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </Field>
      <Field col={12} label="Reason (optional)" hint="Saved in the audit log." className="mb-0">
        <textarea className="form-control radius-8" rows={2} maxLength={500} aria-label="Reason" value={value.reason} onChange={(e) => onChange({ reason: e.target.value })} />
      </Field>
    </div>
  );
}

const body = (audience, value, extra) => ({ audience, graceDays: value.graceDays, method: value.method, ...(value.reason.trim() ? { reason: value.reason.trim() } : {}), ...extra });

/** Two steps: what will happen, then a typed confirmation (the audience word), because it targets every unverified account. */
function ForceDialog({ audience, count, value, onClose, onDone }) {
  const a = AUDIENCE[audience];
  const [step, setStep] = useState(1);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const matches = typed.trim().toUpperCase() === a.word;

  const submit = async () => {
    if (!matches || busy) return;
    setBusy(true);
    try {
      const res = await http.post("/admin/verification/force", body(audience, value, { all: true }));
      setBusy(false);
      onDone(res);
    } catch (e) {
      setBusy(false);
      toast.error(errorMessage(e));
    }
  };

  return (
    <Modal
      open
      onClose={() => !busy && onClose()}
      title={step === 1 ? `Force verification for ${count} unverified ${count === 1 ? a.one : a.many}` : "Confirm: this affects everyone at once"}
      closeOnBackdrop={false}
      footer={
        step === 1 ? (
          <>
            <Button variant="light" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="warning" onClick={() => setStep(2)}>
              Continue
            </Button>
          </>
        ) : (
          <>
            <Button variant="light" disabled={busy} onClick={() => setStep(1)}>
              Back
            </Button>
            <Button variant="danger" icon="solar:shield-warning-outline" loading={busy} disabled={!matches} onClick={submit}>
              Force verification for all {count}
            </Button>
          </>
        )
      }
    >
      {step === 1 ? (
        <>
          <div className="d-flex flex-wrap gap-2 mb-16">
            <Badge tone="primary">Method: {methodLabel(value.method)}</Badge>
            <Badge tone={value.graceDays === 0 ? "danger" : "neutral"}>{value.graceDays === 0 ? "Deadline: immediately" : `Deadline: ${plural(value.graceDays, "day")} (${fmtDate(dueDateFor(value.graceDays))})`}</Badge>
          </div>
          <div className="fw-semibold mb-8">What will happen</div>
          <ul className="mb-0 ps-4 d-flex flex-column gap-2" style={BULLETS}>
            {forceConsequences({ audience, method: value.method, graceDays: value.graceDays }).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="alert alert-danger radius-8" role="alert">
            Every unverified {a.one} ({count}) is put through {methodLabel(value.method)} now. There is no bulk undo: an account comes back to normal by being verified.
          </div>
          <label className="form-label fw-semibold text-sm" htmlFor={`force-confirm-${audience}`}>
            Type <span className="font-monospace">{a.word}</span> to confirm
          </label>
          <input id={`force-confirm-${audience}`} className="form-control radius-8" autoFocus autoComplete="off" placeholder={a.word} value={typed} onChange={(e) => setTyped(e.target.value)} />
        </form>
      )}
    </Modal>
  );
}

/** What Force verification did: the counts in plain words and the first 200 accounts. */
function ForceResult({ audience, result, onClose }) {
  const a = AUDIENCE[audience];
  const counts = result.outcomes || {};
  const shown = OUTCOME_ORDER.filter((k) => counts[k] > 0);
  return (
    <Modal open onClose={onClose} title="Verification forced" size="lg" footer={<Button onClick={onClose}>Done</Button>}>
      {result.matched === 0 && shown.length === 0 ? (
        <p className="mb-0">Nothing to do: no {a.many} were unverified.</p>
      ) : (
        <>
          <p className="mb-16" data-testid="force-result-summary">
            {countOf(result.matched, audience)} put through <strong>{methodLabel(result.method)}</strong>
            {result.graceDays === 0 ? " with no grace period." : ` with a deadline of ${fmtDate(result.dueAt)} (${plural(result.graceDays, "day")}).`}
          </p>
          <ul className="list-unstyled mb-16 d-flex flex-column gap-2" data-testid="force-result-outcomes">
            {shown.map((k) => (
              <li key={k} className="d-flex align-items-start gap-3">
                <span style={{ minWidth: 44 }} className="text-end">
                  <Badge tone={FORCE_OUTCOMES[k].tone}>{counts[k]}</Badge>
                </span>
                <span>{FORCE_OUTCOMES[k].label(audience)}</span>
              </li>
            ))}
          </ul>
          {(result.items || []).length > 0 && (
            <>
              <div className="fw-semibold mb-8">{result.itemsTruncated ? `The first ${result.items.length} accounts (the counts above cover all of them)` : "Accounts"}</div>
              <div className="table-responsive">
                <table className="table bordered-table sm-table mb-0 align-middle">
                  <thead>
                    <tr>
                      <th scope="col">Account</th>
                      <th scope="col">Result</th>
                      <th scope="col">Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.items.map((i) => (
                      <tr key={i.id}>
                        <td className="fw-medium">{i.name || <span className="text-secondary-light font-monospace text-xs">{i.id}</span>}</td>
                        <td>
                          <Badge tone={FORCE_OUTCOMES[i.outcome]?.tone || "neutral"}>{FORCE_OUTCOMES[i.outcome]?.short || humanize(i.outcome)}</Badge>
                        </td>
                        <td className="text-secondary-light text-sm">{i.note ? humanize(i.note) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </Modal>
  );
}

/**
 * Force verification for one audience: puts every account that was admitted without verification through the chosen method, with a deadline.
 * POST /admin/verification/force { audience, all: true, method, graceDays, reason }.
 */
export default function ForcePanel({ audience, policy, counts, certn, onDone }) {
  const a = AUDIENCE[audience];
  const form = useForceForm(policy, certn);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState(null);
  const n = counts.UNVERIFIED;
  const working = counts.operatingUnverified;

  return (
    <Card className="h-100" title={`Force verification: ${a.title}`} subtitle={`Put ${a.many} that were admitted without verification through the verification method.`}>
      <div className="mb-16" data-testid={`force-summary-${audience}`}>
        {n === 0 ? (
          <span className="text-secondary-light">
            No {a.many} are unverified right now. An account is recorded as unverified when it signs up while instant registration is on.
          </span>
        ) : (
          <>
            <strong>{n}</strong> {n === 1 ? a.one : a.many} {n === 1 ? "was" : "were"} admitted without verification.
          </>
        )}
        {working > 0 && (
          <div className="text-secondary-light text-sm mt-4">
            {working} {working === 1 ? a.one : a.many} {working === 1 ? "is" : "are"} working right now without being verified (this includes those that already have a deadline).
          </div>
        )}
      </div>
      <ForceFields audience={audience} certn={certn} value={form.value} onChange={form.apply} />
      <div className="mt-20">
        <Button variant="warning" icon="solar:shield-warning-outline" disabled={n === 0} onClick={() => setConfirming(true)} title={n === 0 ? `No ${a.many} are unverified` : undefined}>
          Force verification…
        </Button>
      </div>
      {confirming && (
        <ForceDialog
          audience={audience}
          count={n}
          value={form.value}
          onClose={() => setConfirming(false)}
          onDone={(res) => {
            setConfirming(false);
            setResult(res);
            form.reset();
            onDone();
          }}
        />
      )}
      {result && <ForceResult audience={audience} result={result} onClose={() => setResult(null)} />}
    </Card>
  );
}

/** Force verification for ONE unverified account (the "Force" button of the accounts table): no typed confirmation, the same fields. */
export function ForceOneModal({ account, policy, certn, onClose, onDone }) {
  const audience = account.audience;
  const form = useForceForm(policy, certn);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      const res = await http.post("/admin/verification/force", body(audience, form.value, { ids: [account.id] }));
      const item = (res.items || [])[0];
      const outcome = item?.outcome;
      const text = `${account.name}: ${outcome ? FORCE_OUTCOMES[outcome]?.label(audience) ?? humanize(outcome) : "done"}${item?.note ? ` (${humanize(item.note)})` : ""}`;
      if (outcome === "FAILED" || outcome === "SKIPPED") toast.warning(text);
      else toast.success(text);
      setBusy(false);
      onDone();
    } catch (e) {
      setBusy(false);
      toast.error(errorMessage(e));
    }
  };

  return (
    <FormModal open onClose={onClose} title={`Force verification: ${account.name}`} onSubmit={submit} busy={busy} submitText="Force verification" submitVariant="warning">
      <ForceFields audience={audience} certn={certn} value={form.value} onChange={form.apply} />
      <div className="fw-semibold mt-16 mb-8">What will happen</div>
      <ul className="mb-0 ps-4 text-secondary-light text-sm d-flex flex-column gap-1" style={BULLETS}>
        {forceConsequences({ audience, method: form.value.method, graceDays: form.value.graceDays, single: true }).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </FormModal>
  );
}
