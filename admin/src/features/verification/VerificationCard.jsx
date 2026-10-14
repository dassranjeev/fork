import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Icon } from "@iconify/react/offline";
import { toast } from "react-toastify";
import { Badge, Button, Card, ErrorState, FormModal, KeyValue, Loading, Modal, StatusBadge, TextArea } from "../../ui";
import { errorMessage, http } from "../../lib/api";
import { useFetch } from "../../lib/hooks";
import { useAuth } from "../../lib/auth";
import { fmtDateTime } from "../../lib/format";
import { safeUrl } from "../../lib/safe";
import { AUDIENCE, BULLETS, CHECK_LABEL, CheckBadge, Deadline, VerificationBadge, checkMessage, humanize, methodLabel } from "./shared";

const VERIFY_TEXT = {
  DRIVER: "The driver is marked as verified. A driver who is not working yet is activated, and one who was taken off the road for missing verification goes back on the road.",
  BUSINESS: "The business is marked as verified. Restaurants waiting to go live are taken live, and locations that were taken off line for missing verification come back.",
};
const OVERRIDE_TEXT = {
  DRIVER: "The driver is marked as verified and, if not working yet, is activated and can go online. The documents they have not provided are waived, so they are not required to go online either.",
  BUSINESS: "The business is marked as verified without its checklist. Restaurants waiting to go live are taken live at once, and locations taken off line for missing verification come back.",
};
const REJECT_TEXT = {
  DRIVER: "The driver's application is rejected and they are told, with your reason. Use this only for drivers who are not working yet.",
  BUSINESS: "Every location of the business is rejected and the owner is told, with your reason. Use this only for businesses that are not live yet.",
};
const PROVIDER = { certn: "Certn", "certn-mock": "Certn (development mock)" };

/** "Check started · Oct 14, 2026, 05:52 PM" for one entry of a driver's background check history. */
function historyText(h) {
  const what =
    h.event === "STARTED" ? "Check started" : h.event === "RESULT" ? `Result: ${CHECK_LABEL[h.status] || humanize(h.status)}` : h.event === "OVERRIDE" ? `Set by staff: ${CHECK_LABEL[h.status] || humanize(h.status)}` : humanize(h.event);
  return [what, h.note, h.at && fmtDateTime(h.at)].filter(Boolean).join(" · ");
}

function Checklist({ gates }) {
  if (!gates.length) return <span className="text-secondary-light text-sm">Nothing to check.</span>;
  return (
    <ul className="list-unstyled mb-0 d-flex flex-column gap-2">
      {gates.map((g) => (
        <li key={g.key} className="d-flex align-items-start gap-2">
          <Icon icon={g.done ? "solar:check-circle-bold" : "solar:clock-circle-outline"} className={`text-xl mt-1 flex-shrink-0 ${g.done ? "text-success-main" : "text-warning-main"}`} />
          <div className="flex-grow-1">
            <span className="visually-hidden">{g.done ? "Done: " : "Open: "}</span>
            <div className={`text-sm ${g.done ? "" : "fw-semibold"}`}>{g.label}</div>
            {g.detail && <div className="text-xs text-secondary-light">{humanize(g.detail)}</div>}
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * The verification card of one account: where it stands, what the checklist still needs and the staff actions.
 *   <VerificationCard audience="DRIVER" id={driverProfileId} onChanged={reload} />     (businesses: audience="BUSINESS", id = merchant id)
 * Loads GET /admin/verification/{drivers|businesses}/:id. The buttons need the "approve" permission of drivers / restaurants (the API enforces
 * it too); "Verify anyway" is for the Super Admin only. `bare` drops the surrounding Card (used inside a dialog).
 */
export default function VerificationCard({ audience, id, onChanged, bare = false, className = "" }) {
  const a = AUDIENCE[audience];
  const base = `/admin/verification/${a.path}/${id}`;
  const { data: c, loading, error, reload } = useFetch(id ? base : null);
  const { can, isSuper } = useAuth();
  const [modal, setModal] = useState(null); // "verify" | "override" | "reject" | "check"
  const [text, setText] = useState(""); // the note (verify) or the reason (reject)
  const [problems, setProblems] = useState(null); // open checklist items the API reported when a verify was refused
  const [busy, setBusy] = useState("");

  const openModal = (which) => {
    setText("");
    setProblems(null);
    setModal(which);
  };
  const close = () => setModal(null);

  // Escape closes only the card's own dialog: the card can sit inside the "Review" dialog, which must stay open
  useEffect(() => {
    if (!modal) return undefined;
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      setModal(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [modal]);

  const refresh = () => {
    reload();
    onChanged?.();
  };

  const submitVerify = async (override) => {
    setBusy("verify");
    setProblems(null);
    try {
      await http.post(`${base}/verify`, { ...(text.trim() ? { note: text.trim() } : {}), ...(override ? { override: true } : {}) });
      toast.success(override ? `${c.name} verified without the full checklist` : `${c.name} verified`);
      close();
      refresh();
    } catch (e) {
      const d = e?.response?.data;
      if (d?.code === "VERIFICATION_REQUIREMENTS_NOT_MET" && Array.isArray(d.details)) {
        setProblems(d.details.map(humanize));
        reload(); // the checklist on screen was out of date
      } else toast.error(errorMessage(e));
    } finally {
      setBusy("");
    }
  };

  const submitReject = async () => {
    setBusy("reject");
    try {
      await http.post(`${base}/reject`, { reason: text.trim() });
      toast.success(`${c.name} rejected`);
      close();
      refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy("");
    }
  };

  const submitCheck = async () => {
    setBusy("check");
    try {
      await http.post(`${base}/start-check`);
      toast.success(`Certn check started for ${c.name}`);
      close();
      refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy("");
    }
  };

  const wrap = (content) =>
    bare ? (
      <div className={className}>{content}</div>
    ) : (
      <Card className={className} title="Verification" subtitle={audience === "BUSINESS" ? "Applies to the whole business and all of its locations" : undefined} actions={c ? <VerificationBadge status={c.verification?.status} /> : undefined}>
        {content}
      </Card>
    );

  if (loading && (!c || c.id !== id)) return wrap(<Loading minHeight={120} />);
  if (error && !c) return wrap(<ErrorState error={error} onRetry={reload} />);
  if (!c) return null;

  const v = c.verification || {};
  const bc = c.backgroundCheck || {};
  const gates = c.gates || [];
  const openGates = gates.filter((g) => !g.done);
  const allDone = openGates.length === 0;
  const canAct = can(a.perm, "approve");
  const anyAction = c.canVerify || c.canStartCheck || c.canReject;
  const holder = audience === "DRIVER" ? "driver" : "business owner";
  const live = audience === "DRIVER" ? (c.onTrip ? ["On a trip", "purple"] : c.isOnline ? ["Online", "success"] : ["Offline", "neutral"]) : c.operating ? ["Working now", "success"] : ["Not working", "neutral"];

  const facts = [
    { label: "Account", value: <span className="d-inline-flex flex-wrap align-items-center gap-2"><StatusBadge status={c.accountStatus} /><StatusBadge status={live[0]} label={live[0]} tone={live[1]} /></span> },
    { label: "Deadline", value: v.dueAt ? <Deadline value={v.dueAt} /> : "None" },
    v.forcedAt ? { label: "Verification forced on", value: fmtDateTime(v.forcedAt) } : null,
    v.verifiedAt ? { label: "Verified on", value: fmtDateTime(v.verifiedAt) } : null,
    {
      label: audience === "BUSINESS" ? "Certn check (owner)" : "Certn check",
      value: (
        <span className="d-inline-flex flex-wrap align-items-center gap-2">
          <CheckBadge status={bc.status || "NOT_STARTED"} />
          {bc.provider && <span className="text-secondary-light text-xs">{PROVIDER[bc.provider] || bc.provider}</span>}
        </span>
      ),
    },
    bc.ref ? { label: "Check reference", value: <span className="font-monospace text-sm text-break">{bc.ref}</span> } : null,
  ];

  const content = (
    <>
      <div className="d-flex flex-wrap align-items-center gap-2 mb-12">
        <VerificationBadge status={v.status} />
        {v.method && <Badge tone="neutral">{methodLabel(v.method)}</Badge>}
        {v.status === "VERIFIED" && v.method === "AUTOMATIC" && !v.verifiedBy && <span className="text-secondary-light text-sm">verified automatically by the Certn check</span>}
        {v.status === "VERIFIED" && v.verifiedBy && <span className="text-secondary-light text-sm">verified by a team member</span>}
      </div>

      {v.nextStep && (
        <div className="radius-8 bg-neutral-50 p-12 mb-16">
          <div className="text-secondary-light text-xs mb-1">What the {holder} is told</div>
          <div className="text-sm">{v.nextStep}</div>
        </div>
      )}
      {v.fallback === "CERTN_NOT_READY" && (
        <div className="alert alert-info radius-8 text-sm mb-16" role="status">
          Automatic verification was chosen when this account signed up, but Certn could not be used at that moment, so staff review it instead.
        </div>
      )}
      {v.certnError && (
        <div className="alert alert-warning radius-8 text-sm mb-16" role="alert">
          Starting the Certn check failed{v.certnAttempts ? ` ${v.certnAttempts} time${v.certnAttempts === 1 ? "" : "s"}` : ""} ({v.certnError}).
          {v.status === "NEEDS_REVIEW" ? " It now needs a person to review it or to start the check again." : " It will be tried again."}
        </div>
      )}

      <KeyValue items={facts} />

      {audience === "BUSINESS" && (
        <div className="mt-16">
          <div className="text-secondary-light text-sm mb-1">Owner</div>
          <div className="fw-medium text-primary-light mb-12">{c.owner ? `${c.owner.name} · ${c.owner.email}` : "No owner account yet"}</div>
          <div className="text-secondary-light text-sm mb-1">Locations ({(c.restaurants || []).length})</div>
          {(c.restaurants || []).length === 0 ? (
            <div className="text-secondary-light text-sm">No locations yet.</div>
          ) : (
            <ul className="list-unstyled mb-0">
              {c.restaurants.map((r) => (
                <li key={r.id} className="d-flex flex-wrap justify-content-between align-items-center gap-2 py-8 border-bottom">
                  <Link to={`/restaurants/${r.id}`} className="fw-medium">
                    {r.name}
                  </Link>
                  <span className="d-inline-flex align-items-center gap-2">
                    <StatusBadge status={r.status} />
                    {r.status === "LIVE" && <span className="text-secondary-light text-xs">{r.acceptingOrders ? "taking orders" : "not taking orders"}</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="mt-20">
        <h6 className="text-md fw-semibold mb-8">Checklist: {methodLabel(v.effectiveMethod)}</h6>
        <Checklist gates={gates} />
      </div>

      {(bc.history || []).length > 0 && (
        <div className="mt-20">
          <h6 className="text-md fw-semibold mb-8">Background check history</h6>
          <ul className="list-unstyled mb-0 text-sm text-secondary-light d-flex flex-column gap-1">
            {bc.history
              .slice()
              .reverse()
              .map((h, i) => (
                <li key={i}>
                  {historyText(h)}
                  {h.reportUrl && (
                    <>
                      {" · "}
                      <a href={safeUrl(h.reportUrl)} target="_blank" rel="noopener noreferrer" className="text-primary-600">
                        Report
                      </a>
                    </>
                  )}
                </li>
              ))}
          </ul>
        </div>
      )}

      {canAct && anyAction && (
        <div className="mt-20">
          <div className="d-flex flex-wrap gap-2">
            {c.canVerify && (
              <Button variant="success" icon="solar:shield-check-outline" disabled={!allDone || !!busy} onClick={() => openModal("verify")} title={allDone ? undefined : "Finish the checklist first"}>
                Verify
              </Button>
            )}
            {c.canVerify && !allDone && isSuper && (
              <Button variant="warning" icon="solar:danger-triangle-outline" disabled={!!busy} onClick={() => openModal("override")}>
                Verify anyway
              </Button>
            )}
            {c.canStartCheck && (
              <Button variant="light" icon="solar:play-circle-outline" disabled={!!busy} onClick={() => openModal("check")}>
                Start Certn check
              </Button>
            )}
            {c.canReject && (
              <Button variant="outline-danger" icon="solar:close-circle-outline" disabled={!!busy} onClick={() => openModal("reject")}>
                Reject
              </Button>
            )}
          </div>
          {c.canVerify && !allDone && (
            <p className="text-secondary-light text-sm mt-8 mb-0">
              {openGates.length} checklist item{openGates.length === 1 ? " is" : "s are"} still open. {isSuper ? "You can verify anyway with a note that explains why." : "Verify becomes available when they are done."}
            </p>
          )}
        </div>
      )}
      {!canAct && anyAction && <p className="text-secondary-light text-sm mt-16 mb-0">You can look at this verification. Changing it needs the "approve" permission for {a.perm}.</p>}
      {bare && audience === "DRIVER" && (
        <div className="mt-16">
          <Link to={`/drivers/${c.id}`} className="text-primary-600 text-sm">
            Open the driver page
          </Link>
        </div>
      )}

      <FormModal open={modal === "verify"} onClose={close} title={`Verify ${c.name}`} onSubmit={() => submitVerify(false)} busy={busy === "verify"} submitText="Verify" submitVariant="success">
        <p className="text-secondary-light">{VERIFY_TEXT[audience]}</p>
        {problems && (
          <div className="alert alert-danger radius-8 text-sm" role="alert">
            <div className="fw-semibold mb-1">The checklist is not complete yet</div>
            <ul className="mb-0 ps-3" style={BULLETS}>
              {problems.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ul>
          </div>
        )}
        <TextArea label="Note (optional)" aria-label="Note" hint="Saved in the audit log." value={text} onChange={setText} maxLength={500} />
      </FormModal>

      <FormModal open={modal === "override"} onClose={close} title={`Verify ${c.name} anyway`} onSubmit={() => submitVerify(true)} busy={busy === "verify"} disabled={text.trim().length < 3} submitText="Verify anyway" submitVariant="danger">
        <div className="alert alert-warning radius-8 text-sm" role="alert">
          <div className="fw-semibold mb-1">The checklist is not complete. Still open:</div>
          <ul className="mb-0 ps-3" style={BULLETS}>
            {openGates.map((g) => (
              <li key={g.key}>
                {g.label}
                {g.detail ? `: ${humanize(g.detail)}` : ""}
              </li>
            ))}
          </ul>
        </div>
        <p className="text-secondary-light">{OVERRIDE_TEXT[audience]} Your name and this note are saved in the audit log.</p>
        {problems && (
          <div className="alert alert-danger radius-8 text-sm" role="alert">
            {problems.join(" · ")}
          </div>
        )}
        <TextArea label="Why are you verifying this account anyway?" aria-label="Why are you verifying this account anyway?" required value={text} onChange={setText} maxLength={500} />
      </FormModal>

      <FormModal open={modal === "check"} onClose={close} title={`Start a Certn check for ${c.name}?`} onSubmit={submitCheck} busy={busy === "check"} submitText="Start check">
        <p className="mb-0 text-secondary-light">{checkMessage(audience)}</p>
      </FormModal>

      <FormModal open={modal === "reject"} onClose={close} title={`Reject ${c.name}`} onSubmit={submitReject} busy={busy === "reject"} disabled={text.trim().length < 3} submitText="Reject" submitVariant="danger">
        <p className="text-secondary-light">{REJECT_TEXT[audience]}</p>
        <TextArea label="Reason" aria-label="Reason" required hint="At least 3 characters. The reason is shown to the person." value={text} onChange={setText} maxLength={500} />
      </FormModal>
    </>
  );

  return wrap(content);
}

/** The card inside a dialog (the "Review" button of the accounts table). */
export function VerificationDialog({ account, onClose, onChanged }) {
  return (
    <Modal open={!!account} onClose={onClose} title={account ? `Verification: ${account.name}` : "Verification"} size="lg" footer={<Button variant="light" onClick={onClose}>Close</Button>}>
      {account && <VerificationCard audience={account.audience} id={account.id} bare onChanged={onChanged} />}
    </Modal>
  );
}
