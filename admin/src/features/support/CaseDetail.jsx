import React, { useState } from "react";
import { safeUrl } from "../../lib/safe";
import { useParams } from "react-router-dom";
import { Badge, Button, Card, EmptyState, ErrorState, FormModal, KeyValue, Loading, MoneyInput, NumberInput, PageHeader, Select, StatusBadge, Timeline, TextArea, TextInput } from "../../ui";
import { useFetch, useForm, useSubmit } from "../../lib/hooks";
import { useAuth } from "../../lib/auth";
import { http } from "../../lib/api";
import { fmtDateTime, money, titleCase } from "../../lib/format";
import { CASE_DECISIONS } from "./shared";

const EVIDENCE_TYPES = ["NOTE", "PHOTO", "RATING", "DOCUMENT", "ORDER", "TICKET"];

function NoticeModal({ c, onClose, onDone }) {
  const f = useForm({ noticeBody: c.noticeBody || `We are reviewing your account (${titleCase(c.trigger)}). ${c.details}. Please respond with your side of the story before the deadline.`, responseDays: 7 });
  const { busy, run } = useSubmit();
  const submit = () => run(() => http.post(`/admin/support/review-cases/${c.id}/notice`, { noticeBody: f.values.noticeBody, responseDays: Number(f.values.responseDays) || undefined }), { success: "Notice sent", onDone: () => { onClose(); onDone(); } });
  return (
    <FormModal open onClose={onClose} title="Send written notice" onSubmit={submit} busy={busy} submitText="Send notice" disabled={!f.values.noticeBody.trim()}>
      <TextArea label="Notice" required rows={5} {...f.bind("noticeBody")} />
      <NumberInput label="Days to respond" min={1} hint="Defaults to the platform setting (7)." {...f.bind("responseDays")} />
    </FormModal>
  );
}

function EvidenceModal({ c, onClose, onDone }) {
  const f = useForm({ type: "NOTE", note: "", ref: "", url: "" });
  const { busy, run } = useSubmit();
  const v = f.values;
  const submit = () => run(() => http.post(`/admin/support/review-cases/${c.id}/evidence`, { type: v.type, note: v.note, ref: v.ref || undefined, url: v.url || undefined }), { success: "Evidence added", onDone: () => { onClose(); onDone(); } });
  return (
    <FormModal open onClose={onClose} title="Add evidence" onSubmit={submit} busy={busy} submitText="Add" disabled={!v.note.trim()}>
      <Select label="Type" allowEmpty={false} options={EVIDENCE_TYPES} {...f.bind("type")} />
      <TextArea label="Note" required rows={3} {...f.bind("note")} />
      <TextInput label="Reference (order code, ticket number…)" {...f.bind("ref")} />
      <TextInput label="URL" {...f.bind("url")} />
    </FormModal>
  );
}

function DecideModal({ c, onClose, onDone }) {
  const f = useForm({ decision: "", notes: "" });
  const { busy, run } = useSubmit();
  const submit = () => run(() => http.post(`/admin/support/review-cases/${c.id}/decide`, { decision: f.values.decision, notes: f.values.notes || undefined }), { success: "Decision recorded", onDone: () => { onClose(); onDone(); } });
  const d = f.values.decision;
  return (
    <FormModal open onClose={onClose} title="Record decision" onSubmit={submit} busy={busy} submitText="Decide" submitVariant={d === "DEACTIVATED" || d === "SUSPENDED" ? "danger" : "primary"} disabled={!d}>
      <Select label="Decision" required options={CASE_DECISIONS.map((x) => ({ value: x, label: titleCase(x) }))} {...f.bind("decision")} />
      {(d === "SUSPENDED" || d === "DEACTIVATED") && <div className="alert alert-warning radius-8 text-sm">This will immediately {d === "SUSPENDED" ? "suspend" : "deactivate"} the {titleCase(c.subjectType)}{c.subjectType === "RESTAURANT" && d === "DEACTIVATED" ? " (restaurants are suspended)" : ""}.</div>}
      <TextArea label="Notes" rows={3} {...f.bind("notes")} />
    </FormModal>
  );
}

function AppealModal({ c, onClose, onDone }) {
  const f = useForm({ result: "", notes: "" });
  const { busy, run } = useSubmit();
  const submit = () => run(() => http.post(`/admin/support/review-cases/${c.id}/appeal-decision`, { result: f.values.result, notes: f.values.notes || undefined }), { success: "Appeal decided", onDone: () => { onClose(); onDone(); } });
  return (
    <FormModal open onClose={onClose} title="Decide appeal" onSubmit={submit} busy={busy} submitText="Submit" disabled={!f.values.result}>
      {c.appealNotes && <div className="alert alert-info radius-8 text-sm">Appeal: {c.appealNotes}</div>}
      <Select label="Result" required options={[{ value: "UPHELD", label: "Upheld (decision stands)" }, { value: "OVERTURNED", label: "Overturned (reinstate)" }]} {...f.bind("result")} />
      <TextArea label="Notes" rows={3} {...f.bind("notes")} />
    </FormModal>
  );
}

function PayoutModal({ c, onClose, onDone }) {
  const f = useForm({ amount: "" });
  const { busy, run } = useSubmit();
  const submit = () => run(() => http.post(`/admin/support/review-cases/${c.id}/final-payout`, { amount: Number(f.values.amount) }), { success: "Final payout posted", onDone: () => { onClose(); onDone(); } });
  return (
    <FormModal open onClose={onClose} title="Final payout" onSubmit={submit} busy={busy} submitText="Post payout" disabled={!(Number(f.values.amount) >= 0) || f.values.amount === ""}>
      <MoneyInput label="Amount" required hint="Posted as an ADJUSTMENT ledger entry for the subject." {...f.bind("amount")} />
    </FormModal>
  );
}

export default function CaseDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const d = useFetch(`/admin/support/review-cases/${id}`);
  const [modal, setModal] = useState(null);
  const { busy, run } = useSubmit();
  if (d.loading && !d.data) return <Loading minHeight={400} />;
  if (d.error && !d.data) return (<><PageHeader title="Review case" back="/support/cases" /><ErrorState error={d.error} onRetry={d.reload} /></>);
  const c = d.data;
  if (!c) return null;
  const close = () => setModal(null);
  const edit = can("support", "edit");
  const approve = can("support", "approve");
  const finished = ["DECIDED", "CLOSED", "DISMISSED"].includes(c.status);
  const decided = c.decision !== "PENDING";
  const evidence = Array.isArray(c.evidence) ? c.evidence : [];

  const dismiss = () => run(() => http.post(`/admin/support/review-cases/${c.id}/dismiss`, {}), { success: "Case dismissed", onDone: d.reload });

  const actions = (
    <>
      {edit && !finished && <Button variant="light" icon="solar:paperclip-outline" onClick={() => setModal("evidence")}>Add evidence</Button>}
      {edit && !finished && <Button variant="light" icon="solar:letter-outline" onClick={() => setModal("notice")}>{c.noticeSentAt ? "Resend notice" : "Send notice"}</Button>}
      {edit && !finished && <Button variant="light" loading={busy} onClick={dismiss}>Dismiss</Button>}
      {approve && !finished && <Button icon="solar:scale-outline" onClick={() => setModal("decide")}>Decide</Button>}
      {approve && c.appealStatus === "REQUESTED" && <Button variant="warning" onClick={() => setModal("appeal")}>Decide appeal</Button>}
      {approve && decided && !c.finalPayoutDone && ["SUSPENDED", "DEACTIVATED"].includes(c.decision) && <Button variant="outline" onClick={() => setModal("payout")}>Final payout</Button>}
    </>
  );

  const steps = [
    { title: "Case opened", text: `${titleCase(c.trigger)}: ${c.details}`, at: fmtDateTime(c.createdAt) },
    c.noticeSentAt && { title: "Written notice sent", text: c.noticeBody, at: fmtDateTime(c.noticeSentAt), tone: "warning" },
    c.subjectResponse && { title: "Subject responded", text: c.subjectResponse, at: "" },
    c.decidedAt && { title: `Decision: ${titleCase(c.decision)}`, text: c.decisionNotes, at: fmtDateTime(c.decidedAt), tone: c.decision === "REINSTATED" ? "success" : "danger" },
    c.appealRequestedAt && { title: "Appeal requested", text: c.appealNotes, at: fmtDateTime(c.appealRequestedAt), tone: "warning" },
    c.appealDecidedAt && { title: `Appeal ${titleCase(c.appealStatus)}`, at: fmtDateTime(c.appealDecidedAt) },
    c.finalPayoutDone && { title: "Final payout posted", text: money(c.finalPayoutAmount), at: fmtDateTime(c.finalPayoutAt), tone: "success" },
  ].filter(Boolean);

  return (
    <>
      <PageHeader
        back="/support/cases"
        title={<span className="d-flex align-items-center gap-2 flex-wrap">{c.subjectName || c.subjectId.slice(0, 8)} <Badge>{titleCase(c.subjectType)}</Badge> <StatusBadge status={c.status} tone={{ PROPOSED: "warning", OPEN: "info", AWAITING_RESPONSE: "primary", DECIDED: "success" }[c.status]} /></span>}
        subtitle={`SOP-08 review · ${titleCase(c.trigger)}`}
        actions={actions}
      />
      <div className="row gy-4">
        <div className="col-lg-7">
          <Card title="Case timeline" className="mb-24"><Timeline items={steps} /></Card>
          <Card title="Evidence" subtitle={`${evidence.length} items`}>
            {evidence.length === 0 ? <EmptyState icon="solar:paperclip-outline" title="No evidence attached" /> : (
              <div className="d-flex flex-column gap-12">
                {evidence.map((e, i) => (
                  <div key={i} className="p-12 radius-8 bg-neutral-100">
                    <div className="d-flex gap-2 align-items-center text-xs text-secondary-light mb-4"><Badge>{titleCase(e.type)}</Badge>{e.ref && <span>{e.ref}</span>}{e.at && <span>{fmtDateTime(e.at)}</span>}</div>
                    <div>{e.note}</div>
                    {e.url && <a href={safeUrl(e.url)} target="_blank" rel="noopener noreferrer" className="text-sm">{e.url}</a>}
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
        <div className="col-lg-5">
          <Card title="Summary">
            <KeyValue cols={1} items={[
              { label: "Status", value: titleCase(c.status) },
              { label: "Decision", value: decided ? titleCase(c.decision) : "Pending" },
              { label: "Previous status", value: titleCase(c.previousStatus) },
              { label: "Respond by", value: fmtDateTime(c.respondBy) },
              { label: "Appeal", value: c.appealStatus === "NONE" ? "None" : titleCase(c.appealStatus) },
              { label: "Final payout", value: c.finalPayoutDone ? money(c.finalPayoutAmount) : "Not posted" },
              { label: "Decided at", value: fmtDateTime(c.decidedAt) },
            ]} />
          </Card>
        </div>
      </div>
      {modal === "notice" && <NoticeModal c={c} onClose={close} onDone={d.reload} />}
      {modal === "evidence" && <EvidenceModal c={c} onClose={close} onDone={d.reload} />}
      {modal === "decide" && <DecideModal c={c} onClose={close} onDone={d.reload} />}
      {modal === "appeal" && <AppealModal c={c} onClose={close} onDone={d.reload} />}
      {modal === "payout" && <PayoutModal c={c} onClose={close} onDone={d.reload} />}
    </>
  );
}
