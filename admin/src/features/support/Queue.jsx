import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Card, DataTable, FilterSelect, FormModal, ListToolbar, PageHeader, Select, StatCard, StatusBadge, TextArea, TextInput } from "../../ui";
import { useFetch, useForm, usePagedList, useSubmit } from "../../lib/hooks";
import { useAuth } from "../../lib/auth";
import { http } from "../../lib/api";
import { fmtDateTime, timeAgo, titleCase } from "../../lib/format";
import { CATEGORIES, PRIORITIES, SlaBadge, TICKET_STATUSES, TIERS, tierLabel } from "./shared";

function NewTicketModal({ onClose, onDone }) {
  const f = useForm({ subject: "", body: "", category: "OTHER" });
  const { busy, run } = useSubmit();
  const submit = () => run(() => http.post("/admin/support/tickets", f.values), { success: "Ticket created", onDone: (t) => { onClose(); onDone(t); } });
  return (
    <FormModal open onClose={onClose} title="New ticket" onSubmit={submit} busy={busy} submitText="Create" disabled={!f.values.subject.trim()}>
      <TextInput label="Subject" required {...f.bind("subject")} />
      <Select label="Category" allowEmpty={false} options={CATEGORIES} {...f.bind("category")} />
      <TextArea label="Description" rows={4} {...f.bind("body")} />
    </FormModal>
  );
}

export default function Queue() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [creating, setCreating] = useState(false);
  const counts = useFetch("/admin/support/tickets/counts", undefined, { refreshMs: 30000 });
  const list = usePagedList("/admin/support/tickets", { filters: { status: "", tier: "", priority: "", category: "", assignee: "", slaBreached: "", open: "true" }, refreshMs: 30000 });
  const c = counts.data || {};
  const by = c.byStatus || {};
  const tiers = c.openByTier || {};

  const cols = [
    { key: "number", title: "Ticket", render: (t) => <span className="fw-semibold text-primary-600">{t.number}</span> },
    { key: "subject", title: "Subject", render: (t) => <div style={{ maxWidth: 320 }} className="text-truncate">{t.subject}</div> },
    { key: "requesterName", title: "Requester", render: (t) => (<div><div>{t.requesterName || "-"}</div><div className="text-xs text-secondary-light">{titleCase(t.requesterType)}</div></div>) },
    { key: "category", title: "Category", render: (t) => titleCase(t.category) },
    { key: "orderCode", title: "Order", render: (t) => t.orderCode || "-" },
    { key: "priority", title: "Priority", render: (t) => <StatusBadge status={t.priority} /> },
    { key: "status", title: "Status", render: (t) => <StatusBadge status={t.status} /> },
    { key: "tier", title: "Tier", render: (t) => tierLabel(t.tier) },
    { key: "assigneeName", title: "Assignee", render: (t) => t.assigneeName || <span className="text-secondary-light">Unassigned</span> },
    { key: "sla", title: "SLA", render: (t) => <SlaBadge ticket={t} /> },
    { key: "lastMessageAt", title: "Last activity", render: (t) => <span title={fmtDateTime(t.lastMessageAt)} className="text-nowrap">{timeAgo(t.lastMessageAt)}</span> },
  ];

  return (
    <>
      <PageHeader
        title="Support tickets"
        subtitle="Work the queue, reply to customers, restaurants and drivers"
        crumbs={[{ label: "Support" }, { label: "Ticket queue" }]}
        actions={can("support", "create") && <Button icon="solar:add-circle-outline" onClick={() => setCreating(true)}>New ticket</Button>}
      />
      <div className="row gy-3 mb-24">
        <div className="col-6 col-xl-2"><StatCard label="Open" value={by.OPEN ?? 0} icon="solar:inbox-outline" tone="info" loading={counts.loading} /></div>
        <div className="col-6 col-xl-2"><StatCard label="Pending" value={by.PENDING ?? 0} icon="solar:clock-circle-outline" tone="warning" loading={counts.loading} /></div>
        <div className="col-6 col-xl-2"><StatCard label="Escalated" value={by.ESCALATED ?? 0} icon="solar:danger-triangle-outline" tone="danger" loading={counts.loading} /></div>
        <div className="col-6 col-xl-2"><StatCard label="Unassigned" value={c.unassigned ?? 0} icon="solar:user-cross-outline" tone="purple" loading={counts.loading} /></div>
        <div className="col-6 col-xl-2"><StatCard label="SLA breached" value={c.slaBreached ?? 0} icon="solar:alarm-outline" tone="danger" loading={counts.loading} /></div>
        <div className="col-6 col-xl-2"><StatCard label="Assigned to me" value={c.mine ?? 0} icon="solar:user-check-outline" tone="success" loading={counts.loading} hint={Object.keys(tiers).length ? Object.entries(tiers).map(([k, v]) => `${tierLabel(k)} ${v}`).join(" · ") : undefined} /></div>
      </div>
      <Card noPadding>
        <div className="p-24 pb-0">
          <ListToolbar
            list={list}
            placeholder="Search subject, number, requester…"
            filters={
              <>
                <FilterSelect value={list.filters.open} onChange={(v) => list.setFilters({ open: v, status: "" })} options={[{ value: "true", label: "Open tickets" }]} placeholder="All tickets" />
                <FilterSelect value={list.filters.status} onChange={(v) => list.setFilters({ status: v, open: "" })} options={TICKET_STATUSES} placeholder="Any status" />
                <FilterSelect value={list.filters.tier} onChange={(v) => list.setFilter("tier", v)} options={TIERS.map((t) => ({ value: t, label: tierLabel(t) }))} placeholder="Any tier" />
                <FilterSelect value={list.filters.priority} onChange={(v) => list.setFilter("priority", v)} options={PRIORITIES} placeholder="Any priority" />
                <FilterSelect value={list.filters.category} onChange={(v) => list.setFilter("category", v)} options={CATEGORIES} placeholder="Any category" />
                <FilterSelect value={list.filters.assignee} onChange={(v) => list.setFilter("assignee", v)} options={[{ value: "me", label: "Assigned to me" }, { value: "unassigned", label: "Unassigned" }]} placeholder="Any assignee" />
                <FilterSelect value={list.filters.slaBreached} onChange={(v) => list.setFilter("slaBreached", v)} options={[{ value: "true", label: "SLA breached" }]} placeholder="SLA: any" />
              </>
            }
          />
        </div>
        <DataTable columns={cols} {...list.tableProps} error={list.error} onRetry={list.reload} onRowClick={(t) => nav(`/support/tickets/${t.id}`)} emptyTitle="The queue is clear" emptyText="No tickets match these filters." />
      </Card>
      {creating && <NewTicketModal onClose={() => setCreating(false)} onDone={(t) => { list.reload(); counts.reload(); if (t?.id) nav(`/support/tickets/${t.id}`); }} />}
    </>
  );
}
