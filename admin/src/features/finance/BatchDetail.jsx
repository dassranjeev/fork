import React, { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Icon } from "@iconify/react/offline";
import { Button, Card, DataTable, ErrorState, IconButton, KeyValue, Loading, PageHeader, StatusBadge, TextArea, FormModal, useConfirm } from "../../ui";
import { http } from "../../lib/api";
import { useFetch, useForm, useSubmit } from "../../lib/hooks";
import { useAuth } from "../../lib/auth";
import { fmtDateTime, money } from "../../lib/format";
import { fmtDay as fmtDate } from "./common";
import { PartyBadge } from "./common";
import PayoutAdjustModal from "./PayoutAdjust";

const STEPS = ["DRAFT", "LOCKED", "APPROVED", "RELEASED", "COMPLETED"];

function Stepper({ status }) {
  const idx = STEPS.indexOf(status);
  return (
    <div className="d-flex flex-wrap align-items-center gap-2">
      {STEPS.map((s, i) => (
        <React.Fragment key={s}>
          <span className={`d-inline-flex align-items-center gap-1 px-12 py-6 radius-8 text-sm fw-medium ${i < idx ? "bg-success-100 text-success-600" : i === idx ? "bg-primary-600 text-white" : "bg-neutral-200 text-secondary-light"}`}>
            {i < idx && <Icon icon="solar:check-circle-bold" />} {s.charAt(0) + s.slice(1).toLowerCase()}
          </span>
          {i < STEPS.length - 1 && <Icon icon="solar:alt-arrow-right-linear" className="text-secondary-light" />}
        </React.Fragment>
      ))}
    </div>
  );
}

function ResolveGapModal({ batch, onClose, onDone }) {
  const f = useForm({ notes: "" });
  const { busy, run } = useSubmit();
  return (
    <FormModal open onClose={onClose} title="Resolve reconciliation gap" submitText="Mark resolved" busy={busy} disabled={f.values.notes.trim().length < 3} onSubmit={() => run(() => http.post(`/admin/finance/batches/${batch.id}/resolve-gap`, { notes: f.values.notes }), { success: "Gap resolved", onDone })}>
      <p className="text-secondary-light text-sm">Captured {money(batch.reconciliation?.captured)} vs Stripe balance {money(batch.reconciliation?.stripeBalance)} (gap {money(batch.reconciliation?.gap)}). Explain why the batch can proceed.</p>
      <TextArea label="Notes" required {...f.bind("notes")} />
    </FormModal>
  );
}

export default function BatchDetail() {
  const { id } = useParams();
  const { data: b, loading, error, reload } = useFetch(`/admin/finance/batches/${id}`);
  const { can, isSuper } = useAuth();
  const { busy, run } = useSubmit();
  const confirm = useConfirm();
  const [modal, setModal] = useState(null);
  const [adjust, setAdjust] = useState(null);

  if (loading && !b) return <Loading />;
  if (error && !b) return (<><PageHeader title="Payout batch" back="/finance/batches" /><ErrorState error={error} onRetry={reload} /></>);
  if (!b) return null;

  const rec = b.reconciliation;
  const gap = rec && !rec.resolved;
  const editable = ["DRAFT", "LOCKED"].includes(b.status);
  const call = (action, success) => run(() => http.post(`/admin/finance/batches/${b.id}/${action}`), { success, onDone: reload });
  const approve = async () => {
    const r = await confirm({ title: "Approve this batch?", message: `Approve ${money(b.total)} for ${b.restaurantCount + b.driverCount} payouts. Amounts can no longer be adjusted.`, confirmText: "Approve" });
    if (r.confirmed) call("approve", "Batch approved");
  };
  const release = async () => {
    const r = await confirm({ title: "Release payouts?", message: `This sends ${money(b.total)} to restaurants and drivers. This cannot be undone.`, confirmText: "Release payments", danger: true });
    if (r.confirmed) call("release", "Batch released");
  };
  const blockedRelease = b.requiresSuperAdmin && !isSuper;

  return (
    <>
      <PageHeader
        title={`Batch ${fmtDate(b.periodStart)} – ${fmtDate(b.periodEnd)}`}
        subtitle={`${b.restaurantCount} restaurants, ${b.driverCount} drivers`}
        back="/finance/batches"
        crumbs={[{ label: "Finance", to: "/finance" }, { label: "Payout batches", to: "/finance/batches" }, { label: "Detail" }]}
        actions={
          <>
            {can("finance", "edit") && editable && <Button variant="light" icon="solar:scale-outline" loading={busy} onClick={() => call("reconcile", "Reconciliation refreshed")}>Reconcile</Button>}
            {can("finance", "approve") && editable && gap && <Button variant="warning" onClick={() => setModal("gap")}>Resolve gap</Button>}
            {can("finance", "approve") && editable && <Button variant="success" icon="solar:check-circle-outline" disabled={gap} title={gap ? "Resolve the reconciliation gap first" : undefined} onClick={approve}>Approve</Button>}
            {can("finance", "approve") && b.status === "APPROVED" && (
              <Button variant="danger" icon="solar:plain-2-outline" disabled={blockedRelease} title={blockedRelease ? "Requires a super admin" : undefined} onClick={release}>Release payouts</Button>
            )}
          </>
        }
      />
      <Card className="mb-24"><Stepper status={b.status} /></Card>
      <div className="row gy-4 mb-24">
        <div className="col-lg-7">
          <Card title="Summary">
            <KeyValue
              cols={3}
              items={[
                { label: "Status", value: <StatusBadge status={b.status} /> },
                { label: "Total", value: <strong>{money(b.total)}</strong> },
                { label: "Approval level", value: b.requiresSuperAdmin ? "Super admin required" : "Finance manager" },
                { label: "Restaurants", value: `${b.restaurantCount} · ${money(b.totalRestaurants)}` },
                { label: "Drivers", value: `${b.driverCount} · ${money(b.totalDrivers)}` },
                { label: "Approved", value: fmtDateTime(b.approvedAt) },
                { label: "Released", value: fmtDateTime(b.releasedAt) },
                { label: "Notes", value: b.notes },
              ]}
            />
            {blockedRelease && b.status === "APPROVED" && <div className="alert alert-warning radius-8 mt-16 mb-0">This batch exceeds the release threshold. A super admin must release it.</div>}
          </Card>
        </div>
        <div className="col-lg-5">
          <Card title="Reconciliation" subtitle={rec ? `Source: ${rec.source}${rec.checkedAt ? ` · ${fmtDateTime(rec.checkedAt)}` : ""}` : undefined}>
            {rec ? (
              <KeyValue cols={2} items={[{ label: "Captured payments", value: money(rec.captured) }, { label: "Stripe balance", value: money(rec.stripeBalance) }, { label: "Gap", value: <span className={rec.gap ? "text-danger-main fw-semibold" : ""}>{money(rec.gap)}</span> }, { label: "Result", value: <StatusBadge status={rec.resolved ? "Balanced" : "Needs review"} tone={rec.resolved ? "success" : "danger"} /> }]} />
            ) : (
              <span className="text-secondary-light">Not reconciled yet.</span>
            )}
          </Card>
        </div>
      </div>
      <Card title="Payouts in this batch" noPadding bodyClassName="p-0">
        <DataTable
          rows={b.payouts || []}
          emptyTitle="No payouts in this batch"
          columns={[
            { key: "partyName", title: "Party", render: (p) => <div><Link className="text-primary-600 fw-medium" to={`/finance/payouts/${p.id}`}>{p.partyName}</Link><div><PartyBadge type={p.partyType} /></div></div> },
            { key: "orderCount", title: "Orders" },
            { key: "gross", title: "Gross", align: "right", render: (p) => money(p.gross) },
            { key: "deductions", title: "Deductions", align: "right", render: (p) => money(p.deductions) },
            { key: "net", title: "Net", align: "right", render: (p) => <strong>{money(p.net)}</strong> },
            { key: "status", title: "Status", render: (p) => <StatusBadge status={p.status} /> },
            { key: "a", title: "", align: "right", render: (p) => can("finance", "edit") && editable && <IconButton icon="solar:pen-outline" tone="primary" title="Adjust payout" onClick={() => setAdjust(p)} /> },
          ]}
        />
      </Card>
      {modal === "gap" && <ResolveGapModal batch={b} onClose={() => setModal(null)} onDone={() => { setModal(null); reload(); }} />}
      {adjust && <PayoutAdjustModal payout={adjust} onClose={() => setAdjust(null)} onDone={() => { setAdjust(null); reload(); }} />}
    </>
  );
}
