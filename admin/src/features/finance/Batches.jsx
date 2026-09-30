import React, { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button, Card, DataTable, DateInput, FilterSelect, FormModal, FormRow, ListToolbar, PageHeader, StatusBadge } from "../../ui";
import { http } from "../../lib/api";
import { useForm, usePagedList, useSubmit } from "../../lib/hooks";
import { useAuth } from "../../lib/auth";
import { money } from "../../lib/format";
import { fmtDay as fmtDate } from "./common";
import { BATCH_STATUSES } from "./common";

function GenerateModal({ onClose, onDone }) {
  const f = useForm({ periodStart: null, periodEnd: null });
  const { busy, run } = useSubmit();
  const v = f.values;
  return (
    <FormModal
      open
      onClose={onClose}
      title="Generate payout batch"
      submitText="Generate"
      busy={busy}
      onSubmit={() => run(() => http.post("/admin/finance/batches/generate", { periodStart: v.periodStart || undefined, periodEnd: v.periodEnd || undefined }), { success: "Batch generated", onDone })}
    >
      <p className="text-secondary-light text-sm">Leave the dates empty to use the previous Monday to Sunday. Generating is idempotent per period; the batch is locked and reconciled automatically.</p>
      <FormRow>
        <DateInput col={6} label="Period start" {...f.bind("periodStart")} />
        <DateInput col={6} label="Period end" {...f.bind("periodEnd")} />
      </FormRow>
    </FormModal>
  );
}

export default function Batches() {
  const nav = useNavigate();
  const { can } = useAuth();
  const list = usePagedList("/admin/finance/batches", { filters: { status: "" } });
  const [gen, setGen] = useState(false);
  const cols = [
    { key: "period", title: "Period", render: (b) => <Link className="text-primary-600 fw-semibold" to={`/finance/batches/${b.id}`} onClick={(e) => e.stopPropagation()}>{fmtDate(b.periodStart)} – {fmtDate(b.periodEnd)}</Link> },
    { key: "status", title: "Status", render: (b) => <StatusBadge status={b.status} /> },
    { key: "restaurantCount", title: "Restaurants", render: (b) => `${b.restaurantCount} · ${money(b.totalRestaurants)}` },
    { key: "driverCount", title: "Drivers", render: (b) => `${b.driverCount} · ${money(b.totalDrivers)}` },
    { key: "total", title: "Total", align: "right", render: (b) => <strong>{money(b.total)}</strong> },
    { key: "recon", title: "Reconciliation", render: (b) => (b.reconciliation ? <StatusBadge status={b.reconciliation.resolved ? "Balanced" : `Gap ${money(b.reconciliation.gap)}`} tone={b.reconciliation.resolved ? "success" : "danger"} /> : "—") },
    { key: "super", title: "Approval", render: (b) => (b.requiresSuperAdmin ? <StatusBadge status="Super admin" tone="warning" /> : "Finance") },
    { key: "releasedAt", title: "Released", render: (b) => fmtDate(b.releasedAt) },
  ];
  return (
    <>
      <PageHeader
        title="Payout batches"
        subtitle="Weekly cycle: generate, reconcile, adjust, approve, release"
        crumbs={[{ label: "Finance", to: "/finance" }, { label: "Payout batches" }]}
        actions={can("finance", "create") && <Button icon="solar:add-circle-outline" onClick={() => setGen(true)}>Generate batch</Button>}
      />
      <Card>
        <ListToolbar filters={<FilterSelect value={list.filters.status} onChange={(v) => list.setFilter("status", v)} options={BATCH_STATUSES} placeholder="All statuses" />} />
        <DataTable columns={cols} {...list.tableProps} error={list.error} onRetry={list.reload} onRowClick={(b) => nav(`/finance/batches/${b.id}`)} emptyTitle="No payout batches" emptyText="Generate the first batch to start the weekly payout cycle." />
      </Card>
      {gen && <GenerateModal onClose={() => setGen(false)} onDone={(b) => { setGen(false); list.reload(); if (b?.id) nav(`/finance/batches/${b.id}`); }} />}
    </>
  );
}
