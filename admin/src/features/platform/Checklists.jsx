import React, { useEffect, useState } from "react";
import { http } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useFetch, usePagedList, useSubmit } from "../../lib/hooks";
import { fmtDate, fmtDateTime } from "../../lib/format";
import {
  Badge, Button, Card, DataTable, ErrorState, FilterSelect, ListToolbar, Loading, PageHeader, Progress, StatCard, StatusBadge, Tabs, TextArea, useConfirm,
} from "../../ui";
import { useCityOptions } from "./crud";

function ChecklistCard({ list, title, icon, onChanged }) {
  const { can } = useAuth();
  const confirm = useConfirm();
  const { busy, run } = useSubmit();
  const [notes, setNotes] = useState(list.notes || "");
  useEffect(() => setNotes(list.notes || ""), [list.id, list.notes]);
  const canEdit = can("operations", "edit");
  const done = !!list.completedAt;
  const toggle = (key, value) => run(() => http.patch(`/admin/operations/checklists/${list.id}/items/${key}`, { done: value }), { onDone: onChanged });
  const complete = async () => {
    const pending = list.items.filter((i) => !i.done).length;
    let force = false;
    if (pending) {
      const r = await confirm({ title: `${pending} item(s) still open`, message: "Complete the checklist anyway?", confirmText: "Complete anyway" });
      if (!r.confirmed) return;
      force = true;
    }
    run(() => http.post(`/admin/operations/checklists/${list.id}/complete`, { force, notes: notes || undefined }), { success: "Checklist completed", onDone: onChanged });
  };
  const s = list.closeSummary;
  return (
    <Card
      title={
        <span className="d-inline-flex align-items-center gap-2">
          {title} {done && <Badge tone="success">Completed</Badge>}
        </span>
      }
      subtitle={done ? `Completed ${fmtDateTime(list.completedAt)}` : `${list.progress.done} of ${list.progress.total} done`}
    >
      <Progress value={list.progress.pct} tone={done || list.progress.pct === 100 ? "success" : "primary"} />
      <ul className="list-unstyled mt-16 mb-16">
        {list.items.map((it) => (
          <li key={it.key} className="d-flex align-items-center gap-3 py-8 border-bottom">
            <input className="form-check-input mt-0" type="checkbox" checked={it.done} disabled={!canEdit || done || busy} onChange={(e) => toggle(it.key, e.target.checked)} />
            <span className={it.done ? "text-decoration-line-through text-secondary-light" : ""}>{it.label}</span>
          </li>
        ))}
      </ul>
      {s && (
        <div className="row gy-2 mb-16 text-center">
          {[
            ["Open orders", s.openOrders, s.openOrders ? "text-danger-main" : ""],
            ["Late", s.lateOrders, ""],
            ["Cancelled", s.cancelledOrders, ""],
            ["Refunded", s.refundedOrders, ""],
            ["Completed", s.completedOrders, "text-success-main"],
            ["Total", s.totalOrders, ""],
          ].map(([l, v, c]) => (
            <div className="col-4 col-md-2" key={l}>
              <div className={`fw-bold text-lg ${c}`}>{v}</div>
              <div className="text-secondary-light text-xs">{l}</div>
            </div>
          ))}
          {s.incidents?.length > 0 && (
            <div className="col-12 text-start text-sm">
              Incidents today: {s.incidents.map((i) => <Badge key={i.id} tone="warning" className="me-1">{i.severity} {i.title}</Badge>)}
            </div>
          )}
        </div>
      )}
      <TextArea
        label="Notes / handover"
        rows={2}
        value={notes}
        disabled={!canEdit || done}
        onChange={setNotes}
      />
      <div className="d-flex gap-2">
        {canEdit && !done && (
          <>
            <Button variant="light" disabled={notes === (list.notes || "")} loading={busy} onClick={() => run(() => http.patch(`/admin/operations/checklists/${list.id}/notes`, { notes }), { success: "Notes saved", onDone: onChanged })}>
              Save notes
            </Button>
            <Button variant="success" loading={busy} onClick={complete}>
              Complete checklist
            </Button>
          </>
        )}
        {done && can("operations", "approve") && (
          <Button variant="light" loading={busy} onClick={() => run(() => http.post(`/admin/operations/checklists/${list.id}/reopen`), { success: "Checklist reopened", onDone: onChanged })}>
            Reopen
          </Button>
        )}
      </div>
    </Card>
  );
}

function Today() {
  const { options } = useCityOptions();
  const [cityId, setCityId] = useState("");
  const { data, loading, error, reload } = useFetch("/admin/operations/checklists/current", { cityId: cityId || undefined });
  return (
    <div>
      <div className="d-flex gap-3 mb-20 align-items-center">
        <FilterSelect value={cityId} onChange={setCityId} options={options} placeholder="All cities (platform)" />
        {data && <span className="text-secondary-light text-sm">{fmtDate(data.date + "T12:00:00")}</span>}
      </div>
      {error && <ErrorState error={error} onRetry={reload} />}
      {loading && !data && <Loading />}
      {data && (
        <div className="row gy-3">
          <div className="col-xl-6"><ChecklistCard list={data.open} title="Opening checklist" onChanged={reload} /></div>
          <div className="col-xl-6"><ChecklistCard list={data.close} title="Closing checklist" onChanged={reload} /></div>
        </div>
      )}
    </div>
  );
}

function History() {
  const { options } = useCityOptions();
  const list = usePagedList("/admin/operations/checklists", { filters: { kind: "", cityId: "", completed: "" } });
  return (
    <Card>
      <ListToolbar
        list={null}
        filters={
          <>
            <FilterSelect value={list.filters.kind} onChange={(v) => list.setFilter("kind", v)} options={["OPEN", "CLOSE"]} placeholder="Open & close" />
            <FilterSelect value={list.filters.cityId} onChange={(v) => list.setFilter("cityId", v)} options={options} placeholder="All cities" />
            <FilterSelect value={list.filters.completed} onChange={(v) => list.setFilter("completed", v)} options={[{ value: "true", label: "Completed" }, { value: "false", label: "Incomplete" }]} placeholder="Any state" />
          </>
        }
      />
      <DataTable
        {...list.tableProps}
        error={list.error}
        onRetry={list.reload}
        emptyTitle="No checklists yet"
        columns={[
          { key: "date", title: "Date", render: (r) => fmtDate(r.date + "T12:00:00") },
          { key: "kind", title: "Type", render: (r) => <StatusBadge status={r.kind} tone={r.kind === "OPEN" ? "info" : "purple"} /> },
          { key: "progress", title: "Progress", render: (r) => <div style={{ minWidth: 140 }}><Progress value={r.progress?.pct ?? 0} height={6} label={`${r.progress?.done}/${r.progress?.total}`} /></div> },
          { key: "completedAt", title: "Completed", render: (r) => (r.completedAt ? fmtDateTime(r.completedAt) : <Badge tone="warning">Incomplete</Badge>) },
          { key: "notes", title: "Notes", render: (r) => <span className="text-secondary-light">{r.notes || "—"}</span> },
        ]}
      />
    </Card>
  );
}

function Templates() {
  const { can } = useAuth();
  const { busy, run } = useSubmit();
  const { data, loading, error, reload } = useFetch("/admin/operations/checklists/templates");
  const [draft, setDraft] = useState(null);
  useEffect(() => data && setDraft(data), [data]);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading || !draft) return <Loading />;
  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || `item_${Date.now()}`;
  const canEdit = can("operations", "edit");
  const edit = (kind, items) => setDraft({ ...draft, [kind]: items });
  const save = (kind) => run(() => http.put(`/admin/operations/checklists/templates/${kind.toLowerCase()}`, { items: draft[kind].map((x) => ({ ...x, key: /^item_[0-9]+$/.test(x.key) ? slug(x.label) : x.key })) }), { success: `${kind === "OPEN" ? "Opening" : "Closing"} template saved`, onDone: reload });
  return (
    <div className="row gy-3">
      {["OPEN", "CLOSE"].map((kind) => (
        <div className="col-xl-6" key={kind}>
          <Card title={kind === "OPEN" ? "Opening checklist template" : "Closing checklist template"} subtitle="Applies to newly created daily checklists.">
            {(draft[kind] || []).map((it, i) => (
              <div key={it.key + i} className="d-flex gap-2 mb-8">
                <input
                  className="form-control radius-8"
                  disabled={!canEdit}
                  value={it.label}
                  onChange={(e) => edit(kind, draft[kind].map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                />
                {canEdit && (
                  <button type="button" className="btn btn-outline-danger-600 btn-sm radius-8" onClick={() => edit(kind, draft[kind].filter((_, j) => j !== i))}>
                    Remove
                  </button>
                )}
              </div>
            ))}
            {canEdit && (
              <div className="d-flex gap-2 mt-16">
                <Button variant="light" onClick={() => edit(kind, [...(draft[kind] || []), { key: slug("item " + Date.now()), label: "" }])}>Add item</Button>
                <Button loading={busy} disabled={(draft[kind] || []).some((x) => !x.label.trim())} onClick={() => save(kind)}>
                  Save template
                </Button>
              </div>
            )}
          </Card>
        </div>
      ))}
    </div>
  );
}

export default function Checklists() {
  return (
    <>
      <PageHeader title="Ops Checklists" subtitle="SOP-03 daily opening and closing checklists." crumbs={[{ label: "Ops checklists" }]} />
      <Tabs
        tabs={[
          { key: "today", label: "Today", content: <Today /> },
          { key: "history", label: "History", content: <History /> },
          { key: "templates", label: "Templates", content: <Templates /> },
        ]}
      />
    </>
  );
}
