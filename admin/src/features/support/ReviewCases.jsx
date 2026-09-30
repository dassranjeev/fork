import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Badge, Button, Card, DataTable, FilterSelect, FormModal, ListToolbar, PageHeader, Select, StatusBadge, TextArea } from "../../ui";
import { useFetch, useForm, usePagedList, useSubmit } from "../../lib/hooks";
import { useAuth } from "../../lib/auth";
import { http } from "../../lib/api";
import { fmtDate, timeAgo, titleCase } from "../../lib/format";
import { CASE_STATUSES, CASE_TRIGGERS } from "./shared";

const CASE_COLORS = { PROPOSED: "warning", OPEN: "info", AWAITING_RESPONSE: "primary", DECIDED: "success", CLOSED: "neutral", DISMISSED: "neutral" };

function OpenCaseModal({ preset, onClose, onDone }) {
  const f = useForm({ subjectType: preset?.subjectType || "DRIVER", subjectId: preset?.subjectId || "", trigger: preset?.trigger || "OTHER", details: preset?.details || "" });
  const v = f.values;
  const drivers = useFetch(!preset && v.subjectType === "DRIVER" ? "/admin/drivers" : null, { limit: 100 });
  const restaurants = useFetch(!preset && v.subjectType === "RESTAURANT" ? "/admin/restaurants" : null, { limit: 100 });
  const { busy, run } = useSubmit();
  const opts = v.subjectType === "DRIVER" ? (drivers.data?.data || []).map((d) => ({ value: d.id, label: d.name })) : (restaurants.data?.data || []).map((r) => ({ value: r.id, label: r.name }));
  const submit = () => run(() => http.post("/admin/support/review-cases", v), { success: "Case opened", onDone: (c) => { onClose(); onDone(c); } });
  return (
    <FormModal open onClose={onClose} title="Open review case" onSubmit={submit} busy={busy} submitText="Open case" disabled={!v.subjectId || !v.details.trim()}>
      {!preset && <Select label="Subject type" allowEmpty={false} options={["DRIVER", "RESTAURANT"]} value={v.subjectType} onChange={(x) => f.setValues({ ...v, subjectType: x, subjectId: "" })} />}
      {preset ? <p className="text-sm text-secondary-light">{titleCase(preset.subjectType)} {preset.subjectName || preset.subjectId}</p> : <Select label="Subject" required options={opts} {...f.bind("subjectId")} />}
      <Select label="Trigger" allowEmpty={false} options={CASE_TRIGGERS} {...f.bind("trigger")} />
      <TextArea label="Details" required rows={3} {...f.bind("details")} />
    </FormModal>
  );
}

export default function ReviewCases() {
  const nav = useNavigate();
  const { can } = useAuth();
  const list = usePagedList("/admin/support/review-cases", { filters: { subjectType: "", status: "" } });
  const candidates = useFetch("/admin/support/review-cases/candidates");
  const [opening, setOpening] = useState(null);
  const cands = Array.isArray(candidates.data) ? candidates.data : [];

  const cols = [
    { key: "subjectName", title: "Subject", render: (c) => (<div><div className="fw-semibold">{c.subjectName || c.subjectId.slice(0, 8)}</div><div className="text-xs text-secondary-light">{titleCase(c.subjectType)}</div></div>) },
    { key: "trigger", title: "Trigger", render: (c) => titleCase(c.trigger) },
    { key: "details", title: "Details", render: (c) => <div style={{ maxWidth: 320 }} className="text-truncate text-secondary-light">{c.details}</div> },
    { key: "status", title: "Status", render: (c) => <StatusBadge status={c.status} tone={CASE_COLORS[c.status]} /> },
    { key: "decision", title: "Decision", render: (c) => (c.decision === "PENDING" ? <span className="text-secondary-light">Pending</span> : <StatusBadge status={c.decision} tone={c.decision === "REINSTATED" ? "success" : c.decision === "WARNED" ? "warning" : "danger"} />) },
    { key: "appealStatus", title: "Appeal", render: (c) => (c.appealStatus === "NONE" ? "-" : <Badge tone="purple">{titleCase(c.appealStatus)}</Badge>) },
    { key: "respondBy", title: "Respond by", sortable: true, render: (c) => fmtDate(c.respondBy) },
    { key: "createdAt", title: "Created", sortable: true, render: (c) => timeAgo(c.createdAt) },
  ];

  return (
    <>
      <PageHeader
        title="Review cases (SOP-08)"
        subtitle="Account reviews for drivers and restaurants: notice, response, decision, appeal"
        crumbs={[{ label: "Support" }, { label: "Review cases" }]}
        actions={can("support", "create") && <Button icon="solar:add-circle-outline" onClick={() => setOpening({})}>Open case</Button>}
      />
      {cands.length > 0 && (
        <Card title="Detector candidates" subtitle="Flagged by the automatic detector but not yet opened" className="mb-24">
          <div className="d-flex flex-column gap-2">
            {cands.map((c, i) => (
              <div key={i} className="d-flex justify-content-between align-items-center gap-3 flex-wrap">
                <span className="text-sm"><Badge tone="warning">{titleCase(c.subjectType)}</Badge> {titleCase(c.trigger)} - {c.details}</span>
                {can("support", "create") && <Button variant="outline" onClick={() => setOpening(c)}>Open case</Button>}
              </div>
            ))}
          </div>
        </Card>
      )}
      <Card noPadding>
        <div className="p-24 pb-0">
          <ListToolbar
            list={list}
            placeholder="Search subject or details…"
            filters={
              <>
                <FilterSelect value={list.filters.subjectType} onChange={(v) => list.setFilter("subjectType", v)} options={["DRIVER", "RESTAURANT"]} placeholder="All subjects" />
                <FilterSelect value={list.filters.status} onChange={(v) => list.setFilter("status", v)} options={CASE_STATUSES} placeholder="Any status" />
              </>
            }
          />
        </div>
        <DataTable columns={cols} {...list.tableProps} error={list.error} onRetry={list.reload} onRowClick={(c) => nav(`/support/cases/${c.id}`)} emptyTitle="No review cases" />
      </Card>
      {opening && <OpenCaseModal preset={opening.subjectId ? opening : null} onClose={() => setOpening(null)} onDone={(c) => { list.reload(); candidates.reload(); if (c?.id) nav(`/support/cases/${c.id}`); }} />}
    </>
  );
}
