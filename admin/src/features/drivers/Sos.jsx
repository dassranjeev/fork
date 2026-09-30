import React from "react";
import { Link } from "react-router-dom";
import { Button, Card, DataTable, FilterSelect, ListToolbar, PageHeader, StatusBadge, useConfirm } from "../../ui";
import { act, http } from "../../lib/api";
import { usePagedList } from "../../lib/hooks";
import { useAuth } from "../../lib/auth";
import { fmtDateTime, timeAgo } from "../../lib/format";

export default function Sos() {
  const { can } = useAuth();
  const confirm = useConfirm();
  const list = usePagedList("/admin/drivers/sos", { filters: { status: "" }, refreshMs: 15000 });

  const handle = async (a, action) => {
    const r = await confirm({ title: action === "resolve" ? "Resolve SOS alert?" : "Acknowledge SOS alert?", confirmText: action === "resolve" ? "Resolve" : "Acknowledge", prompt: { label: "Note (optional)", type: "textarea" } });
    if (r.confirmed && (await act(() => http.post(`/admin/drivers/sos/${a.id}/${action}`, { note: r.value || undefined }), { success: action === "resolve" ? "Alert resolved" : "Alert acknowledged" })) !== undefined) list.reload();
  };

  const cols = [
    { key: "createdAt", title: "Raised", render: (a) => (<div><div className="fw-medium">{timeAgo(a.createdAt)}</div><div className="text-secondary-light text-xs">{fmtDateTime(a.createdAt)}</div></div>) },
    { key: "driver", title: "Driver", render: (a) => <Link to={`/drivers/${a.driverId}`} className="text-primary-600 fw-medium">{a.driverName || a.driver?.name || "View driver"}</Link> },
    { key: "message", title: "Message", render: (a) => a.message || "—" },
    { key: "location", title: "Location", render: (a) => (a.lat != null && a.lng != null ? <a className="text-primary-600" target="_blank" rel="noreferrer" href={`https://www.openstreetmap.org/?mlat=${a.lat}&mlon=${a.lng}#map=16/${a.lat}/${a.lng}`}>{Number(a.lat).toFixed(4)}, {Number(a.lng).toFixed(4)}</a> : "—") },
    { key: "status", title: "Status", render: (a) => <StatusBadge status={a.status} tone={a.status === "OPEN" ? "danger" : a.status === "ACKNOWLEDGED" ? "warning" : "success"} /> },
    { key: "handledAt", title: "Handled", render: (a) => fmtDateTime(a.handledAt) },
    {
      key: "a",
      title: "",
      align: "right",
      render: (a) =>
        can("drivers", "edit") && a.status !== "RESOLVED" ? (
          <div className="d-flex gap-2 justify-content-end">
            {a.status === "OPEN" && <Button variant="warning" onClick={() => handle(a, "acknowledge")}>Acknowledge</Button>}
            <Button variant="success" onClick={() => handle(a, "resolve")}>Resolve</Button>
          </div>
        ) : null,
    },
  ];
  return (
    <>
      <PageHeader title="SOS alerts" subtitle="Driver safety button activations (refreshes every 15 s)" crumbs={[{ label: "Drivers", to: "/drivers" }, { label: "SOS alerts" }]} />
      <Card>
        <ListToolbar list={list} filters={<FilterSelect value={list.filters.status} onChange={(v) => list.setFilter("status", v)} options={["OPEN", "ACKNOWLEDGED", "RESOLVED"]} placeholder="All statuses" />} />
        <DataTable columns={cols} {...list.tableProps} error={list.error} onRetry={list.reload} emptyTitle="No SOS alerts" emptyText="Nothing to worry about. Alerts raised from the driver app will show up here instantly." />
      </Card>
    </>
  );
}
