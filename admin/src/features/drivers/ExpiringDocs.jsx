import React from "react";
import { Link } from "react-router-dom";
import { Card, DataTable, FilterSelect, ListToolbar, PageHeader, StatusBadge } from "../../ui";
import { usePagedList } from "../../lib/hooks";
import { timeAgo, titleCase } from "../../lib/format";
import { fmtDay as fmtDate } from "./shared";
import { DOC_TYPES, fileHref } from "./shared";

const WINDOWS = [
  { value: "7", label: "Next 7 days" },
  { value: "30", label: "Next 30 days" },
  { value: "60", label: "Next 60 days" },
  { value: "90", label: "Next 90 days" },
];

export default function ExpiringDocs() {
  const list = usePagedList("/admin/drivers/expiring-documents", { filters: { days: "30", type: "" } });
  const cols = [
    { key: "driverName", title: "Driver", render: (d) => <Link className="text-primary-600 fw-medium" to={`/drivers/${d.driverId}`}>{d.driverName}</Link> },
    { key: "type", title: "Document", render: (d) => titleCase(d.type) },
    { key: "status", title: "Status", render: (d) => <StatusBadge status={d.status} /> },
    { key: "expiresAt", title: "Expires", render: (d) => fmtDate(d.expiresAt) },
    { key: "in", title: "Remaining", render: (d) => { const past = new Date(d.expiresAt).getTime() < Date.now(); return <span className={past ? "text-danger-main fw-medium" : ""}>{past ? "Expired " : ""}{timeAgo(d.expiresAt)}</span>; } },
    { key: "file", title: "", align: "right", render: (d) => d.fileUrl && <a href={fileHref(d.fileUrl)} target="_blank" rel="noreferrer" className="btn btn-sm btn-outline-neutral-300 text-primary-light radius-8">View file</a> },
  ];
  return (
    <>
      <PageHeader title="Expiring documents" subtitle="Licences, insurance and registrations nearing or past expiry" crumbs={[{ label: "Drivers", to: "/drivers" }, { label: "Expiring documents" }]} />
      <Card>
        <ListToolbar
          filters={
            <>
              <FilterSelect value={list.filters.days} onChange={(v) => list.setFilter("days", v)} options={WINDOWS} placeholder="Any time" />
              <FilterSelect value={list.filters.type} onChange={(v) => list.setFilter("type", v)} options={DOC_TYPES} placeholder="All types" />
            </>
          }
        />
        <DataTable columns={cols} {...list.tableProps} error={list.error} onRetry={list.reload} emptyTitle="No documents expiring in this window" emptyText="Drivers get automatic reminders before their documents expire." />
      </Card>
    </>
  );
}
