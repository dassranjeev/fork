import React from "react";
import { Link } from "react-router-dom";
import { Button, Card, DataTable, PageHeader, StatusBadge, useConfirm } from "../../ui";
import { usePagedList, useSubmit } from "../../lib/hooks";
import { http } from "../../lib/api";
import { fmtDateTime, money, timeAgo, titleCase } from "../../lib/format";

export default function RefundApprovals() {
  const list = usePagedList("/admin/support/refunds/pending", { refreshMs: 30000 });
  const confirm = useConfirm();
  const { busy, run } = useSubmit();

  const approve = async (r) => {
    const res = await confirm({ title: `Approve ${money(r.amount)} ${r.type === "CREDIT" ? "credit" : "refund"}?`, message: "The amount is checked against your own refund limit.", confirmText: "Approve", prompt: { label: "Notes (optional)", type: "textarea" } });
    if (res.confirmed) run(() => http.post(`/admin/support/refunds/${r.id}/approve`, { notes: res.value || undefined }), { success: "Refund approved", onDone: list.reload });
  };
  const reject = async (r) => {
    const res = await confirm({ title: "Reject this refund?", danger: true, confirmText: "Reject", prompt: { label: "Reason", type: "textarea", required: true } });
    if (res.confirmed) run(() => http.post(`/admin/support/refunds/${r.id}/reject`, { reason: res.value }), { success: "Refund rejected", onDone: list.reload });
  };

  const cols = [
    { key: "createdAt", title: "Requested", render: (r) => <span title={fmtDateTime(r.createdAt)} className="text-nowrap">{timeAgo(r.createdAt)}</span> },
    { key: "amount", title: "Amount", render: (r) => <span className="fw-semibold">{money(r.amount)}</span> },
    { key: "type", title: "Type", render: (r) => titleCase(r.type) },
    { key: "chargedTo", title: "Charged to", render: (r) => titleCase(r.chargedTo) },
    { key: "reasonCode", title: "Reason", render: (r) => titleCase(r.reasonCode) },
    { key: "notes", title: "Notes", render: (r) => <div style={{ maxWidth: 260 }} className="text-truncate">{r.notes || "-"}</div> },
    { key: "status", title: "Status", render: (r) => <StatusBadge status={r.status} /> },
    {
      key: "links", title: "Links", render: (r) => (
        <div className="d-flex gap-3 text-sm">
          {r.ticketId && <Link to={`/support/tickets/${r.ticketId}`}>Ticket</Link>}
          <Link to={`/orders/${r.orderId}`}>Order</Link>
        </div>
      ),
    },
    {
      key: "actions", title: "", align: "right", render: (r) => (
        <div className="d-flex gap-2 justify-content-end">
          <Button variant="success" disabled={busy} onClick={() => approve(r)}>Approve</Button>
          <Button variant="outline-danger" disabled={busy} onClick={() => reject(r)}>Reject</Button>
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader title="Refund approvals" subtitle="Ticket refunds above an agent's limit wait here for a supervisor" crumbs={[{ label: "Support" }, { label: "Refund approvals" }]} />
      <Card noPadding>
        <DataTable columns={cols} {...list.tableProps} error={list.error} onRetry={list.reload} emptyTitle="No refunds awaiting approval" emptyText="Refunds over an agent's limit will appear here." />
      </Card>
    </>
  );
}
