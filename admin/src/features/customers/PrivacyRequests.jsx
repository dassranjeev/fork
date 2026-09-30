import React from "react";
import { Link } from "react-router-dom";
import { http } from "../../lib/api";
import { usePagedList, useSubmit } from "../../lib/hooks";
import { useAuth } from "../../lib/auth";
import { fmtDate, timeAgo, titleCase } from "../../lib/format";
import { Badge, Button, Card, DataTable, FilterSelect, ListToolbar, PageHeader, StatusBadge, useConfirm } from "../../ui";

const STATUS_TONE = { PENDING: "warning", IN_PROGRESS: "info", COMPLETED: "success", REJECTED: "danger" };

function downloadJson(name, data) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function PrivacyRequests() {
  const { can } = useAuth();
  const confirm = useConfirm();
  const { run } = useSubmit();
  const list = usePagedList("/admin/customers/data-requests", { filters: { status: "PENDING", type: "" } });

  const approve = async (r) => {
    const deletion = r.type === "DELETION";
    const x = await confirm({
      title: `Approve ${titleCase(r.type)} request?`,
      danger: deletion,
      confirmText: deletion ? "Approve and anonymise" : "Approve",
      message: deletion
        ? `${r.customer?.name || "This customer"}'s account will be anonymised and their addresses and sessions deleted. Orders are kept for accounting. This cannot be undone.`
        : undefined,
      prompt: { label: "Notes (optional)", type: "textarea" },
    });
    if (x.confirmed) run(() => http.post(`/admin/customers/data-requests/${r.id}/approve`, { notes: x.value || undefined }), { success: "Request approved", onDone: list.reload });
  };
  const reject = async (r) => {
    const x = await confirm({ title: `Reject ${titleCase(r.type)} request?`, danger: true, confirmText: "Reject", prompt: { label: "Reason (shared with the customer)", type: "textarea", required: true } });
    if (x.confirmed) run(() => http.post(`/admin/customers/data-requests/${r.id}/reject`, { reason: x.value }), { success: "Request rejected", onDone: list.reload });
  };
  const exportData = (r) =>
    run(async () => {
      const data = await http.get(`/admin/customers/data-requests/${r.id}/export`);
      downloadJson(`data-request-${r.id.slice(0, 8)}.json`, data);
    }, { success: "Export downloaded" });

  const canApprove = can("customers", "approve");
  const columns = [
    {
      key: "customer",
      title: "Customer",
      render: (r) => (
        <div>
          {r.customer?.id ? <Link to={`/customers/${r.customer.id}`} className="fw-semibold">{r.customer.name || "—"}</Link> : <span className="fw-semibold">—</span>}
          <div className="text-secondary-light text-xs">{r.customer?.email}</div>
        </div>
      ),
    },
    { key: "type", title: "Type", render: (r) => <Badge tone={r.type === "DELETION" ? "danger" : "primary"}>{titleCase(r.type)}</Badge> },
    { key: "status", title: "Status", render: (r) => <StatusBadge status={r.status} tone={STATUS_TONE[r.status]} /> },
    { key: "notes", title: "Customer notes", render: (r) => <span className="text-secondary-light">{r.notes || "—"}</span> },
    { key: "createdAt", title: "Received", render: (r) => fmtDate(r.createdAt) },
    {
      key: "dueAt",
      title: "Due",
      render: (r) => {
        if (!r.dueAt) return "—";
        const overdue = new Date(r.dueAt) < new Date() && ["PENDING", "IN_PROGRESS"].includes(r.status);
        return <span className={overdue ? "text-danger-600 fw-medium" : ""}>{fmtDate(r.dueAt)} {["PENDING", "IN_PROGRESS"].includes(r.status) && <span className="text-xs">({timeAgo(r.dueAt)})</span>}</span>;
      },
    },
    {
      key: "actions",
      title: "",
      render: (r) => (
        <div className="d-flex gap-2 justify-content-end">
          {(r.type === "ACCESS" || r.type === "CORRECTION") && <Button variant="light" icon="solar:download-minimalistic-outline" onClick={() => exportData(r)}>Export</Button>}
          {canApprove && ["PENDING", "IN_PROGRESS"].includes(r.status) && (
            <>
              <Button variant="success" onClick={() => approve(r)}>Approve</Button>
              <Button variant="outline-danger" onClick={() => reject(r)}>Reject</Button>
            </>
          )}
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader title="Privacy requests" subtitle="PIPEDA access, correction, consent withdrawal and deletion requests" crumbs={[{ label: "Customers", to: "/customers" }, { label: "Privacy requests" }]} />
      <Card>
        <ListToolbar
          list={null}
          filters={
            <>
              <FilterSelect value={list.filters.status} onChange={(v) => list.setFilter("status", v)} options={["PENDING", "IN_PROGRESS", "COMPLETED", "REJECTED"]} placeholder="All statuses" />
              <FilterSelect value={list.filters.type} onChange={(v) => list.setFilter("type", v)} options={["ACCESS", "DELETION", "CORRECTION", "CONSENT_WITHDRAWAL"]} placeholder="All types" />
            </>
          }
          actions={<Button variant="light" icon="solar:refresh-outline" onClick={list.reload}>Refresh</Button>}
        />
        <DataTable columns={columns} {...list.tableProps} error={list.error} onRetry={list.reload} emptyTitle={list.filters.status === "PENDING" ? "No pending privacy requests" : "No requests found"} emptyText="Requests submitted by customers from the app appear here." />
      </Card>
    </>
  );
}
