import React, { useState } from "react";
import { http } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useFetch, useForm, usePagedList, useSubmit } from "../../lib/hooks";
import { fmtDateTime, timeAgo } from "../../lib/format";
import {
  Badge, Button, Card, DataTable, FilterSelect, FormModal, FormRow, KeyValue, ListToolbar, Loading, Modal, PageHeader, Select, StatusBadge, Switch, TextArea, TextInput, Timeline, useConfirm,
} from "../../ui";

const SEV = [
  { value: "P1", label: "P1 – Critical" },
  { value: "P2", label: "P2 – Major" },
  { value: "P3", label: "P3 – Minor" },
];

function NewIncident({ onClose, onDone }) {
  const { busy, run } = useSubmit();
  const f = useForm({ title: "", severity: "P2", description: "", bannerMessage: "", bannerActive: false, pauseNewOrders: false });
  const submit = () =>
    run(
      () =>
        http.post("/admin/incidents", {
          title: f.values.title,
          severity: f.values.severity,
          description: f.values.description || undefined,
          bannerMessage: f.values.bannerMessage || undefined,
          bannerActive: !!f.values.bannerActive,
          pauseNewOrders: !!f.values.pauseNewOrders,
        }),
      { success: "Incident opened", onDone: (r) => { onDone(r); onClose(); } }
    );
  return (
    <FormModal open onClose={onClose} title="Declare incident" busy={busy} onSubmit={submit} submitText="Open incident" submitVariant="danger" disabled={f.values.title.length < 3}>
      <TextInput label="Title" required placeholder="e.g. Payment gateway timeouts" {...f.bind("title")} />
      <FormRow>
        <Select col={6} label="Severity" allowEmpty={false} options={SEV} {...f.bind("severity")} />
      </FormRow>
      <TextArea label="Description" rows={3} {...f.bind("description")} />
      <TextInput label="Customer-facing banner message" hint="Shown across customer, driver and restaurant apps while the banner is active." {...f.bind("bannerMessage")} />
      <Switch label="Show status banner" {...f.bindCheck("bannerActive")} />
      <Switch label="Pause new orders" hint="Stops customers placing new orders until cleared. P1/P2 incidents page the ops team." {...f.bindCheck("pauseNewOrders")} />
    </FormModal>
  );
}

function Detail({ id, onClose, onChanged }) {
  const { can } = useAuth();
  const confirm = useConfirm();
  const { busy, run } = useSubmit();
  const { data: inc, loading, error, reload } = useFetch(`/admin/incidents/${id}`);
  const [note, setNote] = useState("");
  const [banner, setBanner] = useState(null);
  const [report, setReport] = useState(null);
  const canEdit = can("operations", "edit");
  const canPause = can("operations", "approve");
  const open = inc && inc.status !== "RESOLVED";

  const act = (fn, success) =>
    run(fn, {
      success,
      onDone: () => {
        reload();
        onChanged();
      },
    });

  const resolve = async () => {
    const r = await confirm({ title: "Resolve incident?", message: "Clears the banner and pause, and starts the 48h post-incident report timer.", prompt: { label: "Resolution note", type: "textarea" }, confirmText: "Resolve" });
    if (r.confirmed) act(() => http.post(`/admin/incidents/${id}/resolve`, { note: r.value || undefined }), "Incident resolved");
  };
  const mitigate = async () => {
    const r = await confirm({ title: "Mark as mitigated?", prompt: { label: "Note", type: "textarea" }, confirmText: "Mitigate" });
    if (r.confirmed) act(() => http.post(`/admin/incidents/${id}/mitigate`, { note: r.value || undefined }), "Marked mitigated");
  };

  return (
    <Modal open onClose={onClose} title={inc ? inc.title : "Incident"} size="xl">
      {loading && !inc && <Loading />}
      {error && <div className="alert alert-danger">{error}</div>}
      {inc && (
        <div className="row gy-4">
          <div className="col-lg-7">
            <div className="d-flex flex-wrap gap-2 mb-16">
              <StatusBadge status={inc.severity} />
              <StatusBadge status={inc.status} />
              {inc.pauseNewOrders && <Badge tone="danger">New orders paused</Badge>}
              {inc.bannerActive && <Badge tone="warning">Banner live</Badge>}
              {inc.stakeholderUpdateOverdue && <Badge tone="danger">Stakeholder update overdue</Badge>}
              {inc.reportOverdue && <Badge tone="danger">Report overdue</Badge>}
            </div>
            <KeyValue
              items={[
                { label: "Opened", value: `${fmtDateTime(inc.createdAt)} (${timeAgo(inc.createdAt)})` },
                { label: "Resolved", value: fmtDateTime(inc.resolvedAt) },
                { label: "Description", value: inc.description },
                { label: "Banner message", value: inc.bannerMessage },
                { label: "Next stakeholder update due", value: open && inc.severity !== "P3" ? fmtDateTime(inc.stakeholderUpdateDueAt) : "—" },
                { label: "Post-incident report due", value: fmtDateTime(inc.reportDueAt) },
              ]}
            />
            <h6 className="text-md mt-24 mb-12">Timeline</h6>
            <Timeline
              items={[...(inc.timeline || [])]
                .reverse()
                .map((t) => ({ title: t.note, text: t.by, at: fmtDateTime(t.at) }))}
            />
            {canEdit && open && (
              <div className="d-flex gap-2 mt-16">
                <input className="form-control radius-8" placeholder="Add timeline note / stakeholder update…" value={note} onChange={(e) => setNote(e.target.value)} />
                <Button
                  disabled={!note.trim()}
                  loading={busy}
                  onClick={() => act(() => http.post(`/admin/incidents/${id}/timeline`, { note }), "Note added").then(() => setNote(""))}
                >
                  Add
                </Button>
              </div>
            )}
          </div>
          <div className="col-lg-5">
            {open && (
              <Card title="Controls" className="mb-16">
                {canPause && (
                  <div className="mb-16">
                    <Switch
                      label="Pause new orders"
                      checked={inc.pauseNewOrders}
                      disabled={busy}
                      onChange={(paused) => act(() => http.post(`/admin/incidents/${id}/pause-orders`, { paused }), paused ? "New orders paused" : "New orders resumed")}
                    />
                  </div>
                )}
                {canEdit && (
                  <>
                    <Switch
                      label="Status banner"
                      checked={inc.bannerActive}
                      disabled={busy}
                      onChange={(active) => act(() => http.post(`/admin/incidents/${id}/banner`, { active, message: banner ?? inc.bannerMessage ?? undefined }), active ? "Banner on" : "Banner off")}
                    />
                    <TextInput
                      label="Banner message"
                      value={banner ?? inc.bannerMessage ?? ""}
                      onChange={setBanner}
                      hint="Toggle the banner to publish the message."
                    />
                    <div className="d-flex gap-2 flex-wrap">
                      {inc.status === "OPEN" && (
                        <Button variant="warning" loading={busy} onClick={mitigate}>
                          Mark mitigated
                        </Button>
                      )}
                      <Button variant="success" loading={busy} onClick={resolve}>
                        Resolve
                      </Button>
                    </div>
                  </>
                )}
              </Card>
            )}
            {inc.status === "RESOLVED" && (
              <Card title="Post-incident report" subtitle={inc.reportDueAt ? `Due ${fmtDateTime(inc.reportDueAt)}` : undefined}>
                {inc.postIncidentReport && report === null ? (
                  <>
                    <p style={{ whiteSpace: "pre-wrap" }}>{inc.postIncidentReport}</p>
                    {canEdit && <Button variant="light" onClick={() => setReport(inc.postIncidentReport)}>Edit report</Button>}
                  </>
                ) : canEdit ? (
                  <>
                    <TextArea rows={7} placeholder="Summary, root cause, impact, what we will change (min 20 characters)" value={report ?? ""} onChange={setReport} />
                    <Button disabled={(report || "").length < 20} loading={busy} onClick={() => act(() => http.put(`/admin/incidents/${id}/report`, { report }), "Report saved").then(() => setReport(null))}>
                      Save report
                    </Button>
                  </>
                ) : (
                  <p className="text-secondary-light mb-0">No report filed yet.</p>
                )}
              </Card>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

export default function Incidents() {
  const { can } = useAuth();
  const list = usePagedList("/admin/incidents", { filters: { status: "ACTIVE", severity: "" }, sortBy: "createdAt" });
  const { data: active, reload: reloadActive } = useFetch("/admin/incidents/active", undefined, { refreshMs: 30000 });
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState(null);
  const st = active?.state;
  const refresh = () => {
    list.reload();
    reloadActive();
  };

  return (
    <>
      <PageHeader
        title="Incidents"
        subtitle="SOP-10 incident management: declare, communicate, mitigate and resolve."
        crumbs={[{ label: "Incidents" }]}
        actions={can("operations", "create") && <Button variant="danger" icon="solar:danger-triangle-outline" onClick={() => setCreating(true)}>Declare incident</Button>}
      />
      {st && (st.ordersPaused || st.banner || st.maintenance) && (
        <div className="alert alert-danger d-flex flex-wrap gap-3 align-items-center radius-8">
          <strong>Live platform state:</strong>
          {st.ordersPaused && <Badge tone="danger">New orders paused</Badge>}
          {st.banner && <span>Banner: “{typeof st.banner === "string" ? st.banner : st.banner.message}”</span>}
          {st.maintenance && <Badge tone="warning">Maintenance</Badge>}
        </div>
      )}
      <Card>
        <ListToolbar
          list={list}
          placeholder="Search incidents…"
          filters={
            <>
              <FilterSelect
                value={list.filters.status}
                onChange={(v) => list.setFilter("status", v)}
                options={[{ value: "ACTIVE", label: "Active (open + mitigated)" }, "OPEN", "MITIGATED", "RESOLVED"]}
                placeholder="All statuses"
              />
              <FilterSelect value={list.filters.severity} onChange={(v) => list.setFilter("severity", v)} options={SEV} placeholder="All severities" />
            </>
          }
        />
        <DataTable
          {...list.tableProps}
          error={list.error}
          onRetry={list.reload}
          emptyTitle="No incidents"
          emptyText={list.filters.status === "ACTIVE" ? "All clear. There are no active incidents." : undefined}
          onRowClick={(r) => setOpenId(r.id)}
          columns={[
            { key: "severity", title: "Sev", render: (r) => <StatusBadge status={r.severity} /> },
            { key: "title", title: "Incident", render: (r) => <span className="fw-semibold">{r.title}</span> },
            { key: "status", title: "Status", render: (r) => <StatusBadge status={r.status} /> },
            {
              key: "flags",
              title: "Flags",
              render: (r) => (
                <div className="d-flex gap-1 flex-wrap">
                  {r.pauseNewOrders && <Badge tone="danger">Orders paused</Badge>}
                  {r.bannerActive && <Badge tone="warning">Banner</Badge>}
                  {r.stakeholderUpdateOverdue && <Badge tone="danger">Update overdue</Badge>}
                  {r.reportOverdue && <Badge tone="danger">Report overdue</Badge>}
                </div>
              ),
            },
            { key: "createdAt", title: "Opened", sortable: true, render: (r) => fmtDateTime(r.createdAt) },
            { key: "resolvedAt", title: "Resolved", render: (r) => fmtDateTime(r.resolvedAt) },
          ]}
        />
      </Card>
      {creating && <NewIncident onClose={() => setCreating(false)} onDone={(r) => { refresh(); if (r?.id) setOpenId(r.id); }} />}
      {openId && <Detail id={openId} onClose={() => setOpenId(null)} onChanged={refresh} />}
    </>
  );
}
