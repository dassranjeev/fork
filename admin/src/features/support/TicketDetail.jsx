import React, { useEffect, useRef, useState } from "react";
import { safeUrl } from "../../lib/safe";
import { Link, useParams } from "react-router-dom";
import { toast } from "react-toastify";
import { Badge, Button, Card, EmptyState, ErrorState, FormModal, KeyValue, Loading, MoneyInput, PageHeader, Select, StatusBadge, Switch, TextArea } from "../../ui";
import { useFetch, useForm, useSubmit } from "../../lib/hooks";
import { useAuth } from "../../lib/auth";
import { http } from "../../lib/api";
import { fmtDateTime, money, timeAgo, titleCase } from "../../lib/format";
import { useSocketEvent } from "../../lib/socket";
import { CHARGED_TO, SlaBadge, TIERS, tierLabel } from "./shared";
import { CompactProof } from "../orders/DeliveryProof";

function ReasonSelect({ value, onChange, label = "Reason code", required = true }) {
  const codes = useFetch("/admin/support/reason-codes");
  return <Select label={label} required={required} options={(codes.data || []).map((r) => ({ value: r.code, label: r.label }))} value={value} onChange={onChange} placeholder={codes.loading ? "Loading…" : "Select a reason"} />;
}

function AssignModal({ ticket, onClose, onDone }) {
  const agents = useFetch("/admin/support/tickets/agents");
  const f = useForm({ assigneeId: ticket.assignedToId || "" });
  const { busy, run } = useSubmit();
  const submit = () => run(() => http.post(`/admin/support/tickets/${ticket.id}/assign`, { assigneeId: f.values.assigneeId || null }), { success: "Assignment updated", onDone: () => { onClose(); onDone(); } });
  const opts = (agents.data || []).map((a) => ({ value: a.id, label: `${a.name} · ${a.role} (${a.openTickets} open)` }));
  return (
    <FormModal open onClose={onClose} title="Assign ticket" onSubmit={submit} busy={busy} submitText="Save">
      {agents.error && <ErrorState error={agents.error} />}
      <Select label="Assignee" options={opts} placeholder="Unassigned" hint={`Ticket is ${tierLabel(ticket.tier)}. Agents must be able to handle this tier.`} {...f.bind("assigneeId")} />
    </FormModal>
  );
}

function EscalateModal({ ticket, onClose, onDone }) {
  const f = useForm({ reason: "", tier: "" });
  const { busy, run } = useSubmit();
  const submit = () => run(() => http.post(`/admin/support/tickets/${ticket.id}/escalate`, { reason: f.values.reason, tier: f.values.tier || undefined }), { success: "Ticket escalated", onDone: () => { onClose(); onDone(); } });
  return (
    <FormModal open onClose={onClose} title="Escalate ticket" onSubmit={submit} busy={busy} submitText="Escalate" submitVariant="danger" disabled={!f.values.reason.trim()}>
      <Select label="Target tier" options={TIERS.filter((t) => t !== "SELF_SERVE").map((t) => ({ value: t, label: tierLabel(t) }))} placeholder="Next tier (default)" {...f.bind("tier")} />
      <TextArea label="Reason" required rows={3} {...f.bind("reason")} />
    </FormModal>
  );
}

function ResolveModal({ ticket, onClose, onDone }) {
  const f = useForm({ reasonCode: "", chargedTo: ticket.chargedTo || "PLATFORM", resolution: "", message: "" });
  const { busy, run } = useSubmit();
  const v = f.values;
  const submit = () => run(() => http.post(`/admin/support/tickets/${ticket.id}/resolve`, { reasonCode: v.reasonCode, chargedTo: v.chargedTo, resolution: v.resolution || undefined, message: v.message || undefined }), { success: "Ticket resolved", onDone: () => { onClose(); onDone(); } });
  return (
    <FormModal open onClose={onClose} title="Resolve ticket" onSubmit={submit} busy={busy} submitText="Resolve" submitVariant="success" disabled={!v.reasonCode}>
      <ReasonSelect {...f.bind("reasonCode")} />
      <Select label="Charged to" required allowEmpty={false} options={CHARGED_TO} {...f.bind("chargedTo")} />
      <TextArea label="Internal resolution summary" rows={2} {...f.bind("resolution")} />
      <TextArea label="Message to requester (optional)" rows={3} {...f.bind("message")} />
    </FormModal>
  );
}

function RefundModal({ ticket, suggestion, onClose, onDone }) {
  const f = useForm({ amount: suggestion?.totalAmount || "", type: "REFUND", chargedTo: "PLATFORM", reasonCode: "", notes: "" });
  const { busy, run } = useSubmit();
  const v = f.values;
  const submit = () => run(() => http.post(`/admin/support/tickets/${ticket.id}/refund`, { amount: Number(v.amount), type: v.type, chargedTo: v.chargedTo, reasonCode: v.reasonCode, notes: v.notes || undefined }), {
    onDone: (r) => { onClose(); onDone(); toast.success(r?.status === "PENDING_APPROVAL" ? "Refund is over your limit and awaits supervisor approval" : "Refund issued"); },
  });
  return (
    <FormModal open onClose={onClose} title={`Refund from ${ticket.number}`} onSubmit={submit} busy={busy} submitText="Submit" disabled={!(Number(v.amount) > 0) || !v.reasonCode}>
      {suggestion?.summary && <div className="alert alert-info radius-8 text-sm">Suggested: {suggestion.summary}{suggestion.totalAmount ? ` (${money(suggestion.totalAmount)})` : ""}</div>}
      <MoneyInput label="Amount" required hint={suggestion?.refundableRemaining != null ? `Refundable remaining: ${money(suggestion.refundableRemaining)}` : undefined} {...f.bind("amount")} />
      <Select label="Type" allowEmpty={false} options={[{ value: "REFUND", label: "Refund to original payment" }, { value: "CREDIT", label: "Wallet credit" }]} {...f.bind("type")} />
      <Select label="Charged to" required allowEmpty={false} options={CHARGED_TO} {...f.bind("chargedTo")} />
      <ReasonSelect {...f.bind("reasonCode")} />
      <TextArea label="Notes" rows={2} {...f.bind("notes")} />
    </FormModal>
  );
}

function SimpleReasonModal({ title, label, submitText, onSubmit, onClose, required }) {
  const f = useForm({ text: "" });
  const { busy, run } = useSubmit();
  return (
    <FormModal open onClose={onClose} title={title} onSubmit={() => run(() => onSubmit(f.values.text), { onDone: onClose })} busy={busy} submitText={submitText} disabled={required && !f.values.text.trim()}>
      <TextArea label={label} rows={3} required={required} {...f.bind("text")} />
    </FormModal>
  );
}

function Composer({ ticket, onSent }) {
  const [body, setBody] = useState("");
  const [internal, setInternal] = useState(false);
  const { busy, run } = useSubmit();
  const replies = useFetch("/admin/support/canned-replies", { limit: 100, audience: ticket.requesterType === "STAFF" ? undefined : ticket.requesterType });
  const pickReply = async (id) => {
    if (!id) return;
    const r = await run(() => http.post(`/admin/support/canned-replies/${id}/render`, { vars: { customerName: ticket.requesterName || "", orderCode: ticket.orderCode || "", ticketNumber: ticket.number, agentName: "" } }));
    if (r?.body) setBody((b) => (b ? `${b}\n${r.body}` : r.body));
  };
  const send = () => run(() => http.post(`/admin/support/tickets/${ticket.id}/messages`, { body, internal }), { onDone: () => { setBody(""); onSent(); } });
  return (
    <div className={`p-16 radius-8 border ${internal ? "border-warning-main" : ""}`} style={internal ? { background: "rgba(234,179,8,.08)" } : undefined}>
      <textarea className="form-control radius-8 mb-12" rows={3} placeholder={internal ? "Internal note - not visible to the requester" : "Write a reply to the requester…"} value={body} onChange={(e) => setBody(e.target.value)} />
      <div className="d-flex flex-wrap align-items-center justify-content-between gap-3">
        <div className="d-flex align-items-center gap-3 flex-wrap">
          <Switch className="mb-0" label="Internal note" checked={internal} onChange={setInternal} />
          <select className="form-select form-select-sm w-auto radius-8" value="" onChange={(e) => pickReply(e.target.value)}>
            <option value="">Insert canned reply…</option>
            {(replies.data?.data || []).filter((r) => r.active).map((r) => <option key={r.id} value={r.id}>{r.title}{r.shortcut ? ` (${r.shortcut})` : ""}</option>)}
          </select>
        </div>
        <Button icon={internal ? "solar:notes-outline" : "solar:plain-2-outline"} variant={internal ? "warning" : "primary"} loading={busy} disabled={!body.trim()} onClick={send}>{internal ? "Add note" : "Send reply"}</Button>
      </div>
    </div>
  );
}

function Conversation({ messages, ticket }) {
  const end = useRef();
  useEffect(() => { end.current?.scrollIntoView({ block: "nearest" }); }, [messages.length]);
  if (!messages.length) return <EmptyState icon="solar:chat-round-dots-outline" title="No messages yet" />;
  return (
    <div className="d-flex flex-column gap-12" style={{ maxHeight: 520, overflowY: "auto" }}>
      {messages.map((m) => {
        const staff = m.senderType === "STAFF";
        const system = m.senderType === "SYSTEM";
        return (
          <div key={m.id} className={`d-flex ${staff && !m.internal ? "justify-content-end" : ""}`}>
            <div className="p-12 radius-8" style={{ maxWidth: "80%", background: m.internal ? "rgba(234,179,8,.14)" : system ? "transparent" : staff ? "rgba(249,90,22,.12)" : "var(--neutral-100, rgba(128,128,128,.12))", border: system ? "1px dashed rgba(128,128,128,.4)" : undefined }}>
              <div className="d-flex gap-2 align-items-center text-xs text-secondary-light mb-4">
                <span className="fw-semibold">{system ? "System" : staff ? "Staff" : ticket.requesterName || titleCase(m.senderType)}</span>
                {m.internal && <Badge tone="warning">Internal note</Badge>}
                <span title={fmtDateTime(m.createdAt)}>{timeAgo(m.createdAt)}</span>
              </div>
              <div style={{ whiteSpace: "pre-wrap" }}>{m.body}</div>
              {m.attachments?.length > 0 && <div className="mt-8">{m.attachments.map((u, i) => <a key={i} href={safeUrl(u)} target="_blank" rel="noopener noreferrer" className="me-2 text-sm">Attachment {i + 1}</a>)}</div>}
            </div>
          </div>
        );
      })}
      <div ref={end} />
    </div>
  );
}

export default function TicketDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const d = useFetch(`/admin/support/tickets/${id}`);
  const [modal, setModal] = useState(null);
  const { busy, run } = useSubmit();
  useSocketEvent("ticket.updated", (p) => { if (p?.ticketId === id) d.reload(); });

  if (d.loading && !d.data) return <Loading minHeight={400} />;
  if (d.error && !d.data) return (<><PageHeader title="Ticket" back="/support/tickets" /><ErrorState error={d.error} onRetry={d.reload} /></>);
  if (!d.data) return null;

  const { ticket: t, messages = [], orderContext: oc, suggestion } = d.data;
  const close = () => setModal(null);
  const edit = can("support", "edit");
  const done = ["RESOLVED", "CLOSED"].includes(t.status);
  const post = (path, body, success) => run(() => http.post(`/admin/support/tickets/${t.id}/${path}`, body), { success, onDone: d.reload });

  const actions = edit && (
    <>
      <Button variant="light" icon="solar:user-plus-outline" onClick={() => setModal("assign")}>Assign</Button>
      {!done && t.status !== "ESCALATED" && <Button variant="light" icon="solar:arrow-up-outline" onClick={() => setModal("escalate")}>Escalate</Button>}
      {!done && <Button variant="light" loading={busy} onClick={() => post("status", { status: t.status === "PENDING" ? "OPEN" : "PENDING" }, "Status updated")}>{t.status === "PENDING" ? "Mark open" : "Mark pending"}</Button>}
      {t.orderId && !done && can("support", "approve") && <Button variant="warning" icon="solar:wallet-money-outline" onClick={() => setModal("refund")}>Refund</Button>}
      {!done && <Button variant="success" icon="solar:check-circle-outline" onClick={() => setModal("resolve")}>Resolve</Button>}
      {t.status === "RESOLVED" && <Button variant="light" icon="solar:lock-outline" onClick={() => setModal("close")}>Close</Button>}
      {done && <Button variant="outline" icon="solar:restart-outline" onClick={() => setModal("reopen")}>Reopen</Button>}
    </>
  );

  return (
    <>
      <PageHeader
        back="/support/tickets"
        title={<span className="d-flex align-items-center gap-2 flex-wrap">{t.number} · {t.subject} <StatusBadge status={t.status} /></span>}
        subtitle={`Opened ${fmtDateTime(t.createdAt)} by ${t.requesterName || titleCase(t.requesterType)}`}
        actions={actions}
      />
      <div className="row gy-4">
        <div className="col-lg-8">
          <Card title="Conversation" subtitle={`${messages.length} messages`} className="mb-24">
            <Conversation messages={messages} ticket={t} />
            {edit && t.status !== "CLOSED" && <div className="mt-16"><Composer ticket={t} onSent={d.reload} /></div>}
          </Card>
          {oc && (
            <Card title="Order context" actions={<Link to={`/orders/${oc.order.id}`} className="btn btn-sm btn-outline-primary-600 radius-8">Open order {oc.order.code}</Link>}>
              <KeyValue cols={3} items={[
                { label: "Order status", value: <StatusBadge status={oc.order.status} /> },
                { label: "Total", value: money(oc.order.total) },
                { label: "Payment", value: <StatusBadge status={oc.order.paymentStatus} /> },
                { label: "Restaurant", value: oc.restaurant?.name },
                { label: "Driver", value: oc.driver?.name },
                { label: "Customer", value: oc.customer?.name },
                { label: "Minutes late", value: oc.order.minutesLate },
                { label: "Delivery proof", value: oc.deliveryProof ? `${titleCase(oc.deliveryProof.proofType)} (${oc.deliveryProof.valid ? "valid" : "weak / flagged"})` : "No proof on file" },
                { label: "GPS evidence", value: oc.gps?.note || (oc.gps?.confirmsDelivery ? "Confirms delivery" : "Does not confirm") },
              ]} />
              {oc.items?.length > 0 && <div className="mt-16 text-sm">Items: {oc.items.map((i) => `${i.quantity}x ${i.name}`).join(", ")}</div>}
              {oc.refunds?.length > 0 && <div className="mt-16 text-sm">Prior refunds: {oc.refunds.map((r) => `${money(r.amount)} (${titleCase(r.status)})`).join(", ")}</div>}
            </Card>
          )}
          {oc && <CompactProof ticket={t} orderContext={oc} onChanged={d.reload} />}
        </div>
        <div className="col-lg-4">
          <Card title="Details" className="mb-24">
            <KeyValue cols={1} items={[
              { label: "Priority", value: <StatusBadge status={t.priority} /> },
              { label: "Tier", value: tierLabel(t.tier) },
              { label: "Category", value: titleCase(t.category) },
              { label: "Assignee", value: t.assigneeName || "Unassigned" },
              { label: "Requester", value: t.requesterName ? `${t.requesterName}${t.requesterEmail ? ` · ${t.requesterEmail}` : ""}` : titleCase(t.requesterType) },
              { label: "SLA", value: <SlaBadge ticket={t} /> },
              { label: "First reply due", value: fmtDateTime(t.slaFirstResponseDueAt) },
              { label: "Resolution due", value: fmtDateTime(t.slaResolutionDueAt) },
              { label: "Refunded so far", value: money(t.refundedTotal) },
              t.reasonCode && { label: "Resolution", value: `${titleCase(t.reasonCode)} · charged to ${titleCase(t.chargedTo)}` },
              t.escalationReason && { label: "Escalation reason", value: t.escalationReason },
              t.csat != null && { label: "CSAT", value: `${t.csat} / 5${t.csatComment ? ` - ${t.csatComment}` : ""}` },
              { label: "Source", value: titleCase(t.source) },
            ]} />
            {t.tags?.length > 0 && <div className="mt-16 d-flex gap-2 flex-wrap">{t.tags.map((x) => <Badge key={x}>{x}</Badge>)}</div>}
          </Card>
          {suggestion && (
            <Card title="Rule-engine suggestion">
              <div className="mb-8"><Badge tone={suggestion.autoEligible ? "success" : "info"}>{titleCase(suggestion.action)}</Badge></div>
              <p className="text-sm mb-8">{suggestion.summary}</p>
              {suggestion.totalAmount > 0 && <div className="fw-semibold mb-8">Suggested amount: {money(suggestion.totalAmount)}</div>}
              {suggestion.evidenceNeeded?.length > 0 && <div className="text-sm text-secondary-light mb-8">Evidence: {suggestion.evidenceNeeded.join(", ")}</div>}
              {suggestion.warnings?.map((w, i) => <div key={i} className="alert alert-warning radius-8 text-sm py-8 mb-8">{w}</div>)}
            </Card>
          )}
        </div>
      </div>
      {modal === "assign" && <AssignModal ticket={t} onClose={close} onDone={d.reload} />}
      {modal === "escalate" && <EscalateModal ticket={t} onClose={close} onDone={d.reload} />}
      {modal === "resolve" && <ResolveModal ticket={t} onClose={close} onDone={d.reload} />}
      {modal === "refund" && <RefundModal ticket={t} suggestion={suggestion} onClose={close} onDone={d.reload} />}
      {modal === "close" && <SimpleReasonModal title="Close ticket" label="Closing note (optional)" submitText="Close ticket" onClose={close} onSubmit={(note) => http.post(`/admin/support/tickets/${t.id}/close`, { note: note || undefined }).then(d.reload)} />}
      {modal === "reopen" && <SimpleReasonModal title="Reopen ticket" label="Reason (optional)" submitText="Reopen" onClose={close} onSubmit={(reason) => http.post(`/admin/support/tickets/${t.id}/reopen`, { reason: reason || undefined }).then(d.reload)} />}
    </>
  );
}
