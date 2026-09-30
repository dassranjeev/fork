import React, { useMemo, useRef, useState } from "react";
import { Badge, Card, DataTable, DateInput, FilterSelect, ListToolbar, Modal, PageHeader, KeyValue } from "../../ui";
import { useFetch, usePagedList } from "../../lib/hooks";
import { fmtDateTime } from "../../lib/format";

const isObj = (x) => x && typeof x === "object";

/** flatten nested objects into dotted paths */
function flatten(obj, prefix = "", out = {}) {
  if (!isObj(obj) || Array.isArray(obj)) {
    out[prefix || "(value)"] = obj;
    return out;
  }
  const keys = Object.keys(obj);
  if (!keys.length && prefix) out[prefix] = obj;
  keys.forEach((k) => flatten(obj[k], prefix ? `${prefix}.${k}` : k, out));
  return out;
}
const show = (v) => (v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v));

function DiffView({ before, after }) {
  const rows = useMemo(() => {
    const b = before == null ? {} : flatten(before);
    const a = after == null ? {} : flatten(after);
    const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].sort();
    const both = before != null && after != null;
    return keys.filter((k) => !both || (k in b && k in a)).map((k) => {
      const inB = k in b;
      const inA = k in a;
      const changed = JSON.stringify(b[k]) !== JSON.stringify(a[k]);
      return { k, before: b[k], after: a[k], inB, inA, changed };
    });
  }, [before, after]);

  if (before == null && after == null) return <p className="text-secondary-light mb-0">No before/after data was captured for this event.</p>;
  const changedOnly = rows.filter((r) => r.changed);
  const list = changedOnly.length ? changedOnly : rows;
  return (
    <div className="table-responsive border radius-8">
      <table className="table sm-table mb-0 align-middle">
        <thead>
          <tr>
            <th style={{ width: "28%" }}>Field</th>
            <th>Before</th>
            <th>After</th>
          </tr>
        </thead>
        <tbody>
          {list.map((r) => (
            <tr key={r.k}>
              <td className="font-monospace text-sm">{r.k}</td>
              <td className="font-monospace text-sm text-break" style={r.changed && r.inB ? { background: "rgba(220,53,69,.10)" } : undefined}>{r.inB ? show(r.before) : <span className="text-secondary-light">—</span>}</td>
              <td className="font-monospace text-sm text-break" style={r.changed && r.inA ? { background: "rgba(25,135,84,.12)" } : undefined}>{r.inA ? show(r.after) : <span className="text-secondary-light">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function AuditLog() {
  const list = usePagedList("/admin/audit-logs", { filters: { actorId: "", entity: "", action: "", from: "", to: "" }, limit: 25 });
  const staff = useFetch("/admin/staff", { limit: 100 });
  const [sel, setSel] = useState(null);
  const [actionText, setActionText] = useState("");
  const [entityText, setEntityText] = useState("");
  const timers = useRef({});
  const applyText = (name, val) => {
    clearTimeout(timers.current[name]);
    timers.current[name] = setTimeout(() => list.setFilter(name, val.trim()), 400);
  };

  const actors = (staff.data?.data || []).map((s) => ({ value: s.id, label: s.email }));

  const columns = [
    { key: "createdAt", title: "When", sortable: true, render: (a) => <span className="text-nowrap">{fmtDateTime(a.createdAt)}</span> },
    { key: "actorEmail", title: "Actor", sortable: true, render: (a) => (<div><div>{a.actorEmail || "system"}</div><div className="text-xs text-secondary-light">{a.actorType}</div></div>) },
    { key: "action", title: "Action", sortable: true, render: (a) => <span className="fw-medium text-break">{a.action}</span> },
    { key: "entity", title: "Entity", render: (a) => (a.entity ? <span>{a.entity}{a.entityId && <span className="text-xs text-secondary-light ms-1">{String(a.entityId).slice(0, 8)}</span>}</span> : "—") },
    { key: "diff", title: "Changes", render: (a) => (a.before || a.after ? <Badge tone="info">{a.before && a.after ? "Before / after" : "Payload"}</Badge> : <span className="text-secondary-light">—</span>) },
    { key: "ip", title: "IP", render: (a) => a.ip || "—" },
  ];

  return (
    <>
      <PageHeader title="Audit Log" subtitle="Append-only record of every admin action (7-year retention)" crumbs={[{ label: "Admin" }, { label: "Audit Log" }]} />
      <Card noPadding>
        <div className="p-24 pb-0">
          <ListToolbar list={list} placeholder="Search actor, action, entity id, IP…" />
          <div className="d-flex flex-wrap align-items-center gap-3 mb-20">
            <FilterSelect value={list.filters.actorId} onChange={(x) => list.setFilter("actorId", x)} options={actors} placeholder="Any staff actor" />
            <input className="form-control h-40-px radius-8" style={{ width: 170 }} placeholder="Entity (e.g. user)" value={entityText} onChange={(e) => { setEntityText(e.target.value); applyText("entity", e.target.value); }} />
            <input className="form-control h-40-px radius-8" style={{ width: 190 }} placeholder="Action contains…" value={actionText} onChange={(e) => { setActionText(e.target.value); applyText("action", e.target.value); }} />
            <div className="d-flex align-items-center gap-2">
              <span className="text-sm text-secondary-light">From</span>
              <DateInput className="mb-0" value={list.filters.from} onChange={(x) => list.setFilter("from", x)} />
              <span className="text-sm text-secondary-light">To</span>
              <DateInput className="mb-0" value={(list.filters.to || "").slice(0, 10)} onChange={(x) => list.setFilter("to", x ? `${x}T23:59:59` : "")} />
            </div>
          </div>
        </div>
        <DataTable columns={columns} {...list.tableProps} error={list.error} onRetry={list.reload} onRowClick={setSel} emptyTitle="No audit entries match these filters" />
      </Card>

      <Modal open={!!sel} onClose={() => setSel(null)} title="Audit entry" size="lg">
        {sel && (
          <>
            <KeyValue
              items={[
                { label: "When", value: fmtDateTime(sel.createdAt) },
                { label: "Actor", value: `${sel.actorEmail || "system"} (${sel.actorType || "—"})` },
                { label: "Action", value: sel.action },
                { label: "Entity", value: sel.entity ? `${sel.entity} ${sel.entityId || ""}` : "—" },
                { label: "Request", value: sel.method ? `${sel.method} ${sel.path}` : "—" },
                { label: "IP", value: sel.ip || "—" },
              ]}
            />
            <h6 className="fw-semibold text-md mt-24 mb-12">Changes</h6>
            <DiffView before={sel.before} after={sel.after} />
          </>
        )}
      </Modal>
    </>
  );
}
