import React from "react";
import { Button, Card, DataTable, FilterSelect, ListToolbar, PageHeader, StatusBadge, useConfirm } from "../../ui";
import { act, http } from "../../lib/api";
import { usePagedList } from "../../lib/hooks";
import { useAuth } from "../../lib/auth";
import { fmtDateTime, money, titleCase } from "../../lib/format";

export default function Refunds() {
  const { can, refundLimit } = useAuth();
  const confirm = useConfirm();
  const list = usePagedList("/admin/finance/refunds", { filters: { status: "PENDING_APPROVAL" } });
  const decide = async (r, kind) => {
    const res = await confirm({
      title: `${kind === "approve" ? "Approve" : "Reject"} refund of ${money(r.amount)}?`,
      danger: kind === "reject",
      confirmText: kind === "approve" ? "Approve refund" : "Reject refund",
      prompt: { label: "Notes (optional)", type: "textarea" },
    });
    if (res.confirmed && (await act(() => http.post(`/admin/finance/refunds/${r.id}/${kind}`, { notes: res.value || undefined }), { success: kind === "approve" ? "Refund approved" : "Refund rejected" })) !== undefined) list.reload();
  };
  const canApprove = can("finance", "approve");
  const cols = [
    { key: "createdAt", title: "Requested", render: (r) => fmtDateTime(r.createdAt) },
    { key: "order", title: "Order", render: (r) => <span className="fw-semibold">{r.order?.code || "—"}</span> },
    { key: "amount", title: "Amount", align: "right", render: (r) => <strong>{money(r.amount)}</strong> },
    { key: "type", title: "Type", render: (r) => titleCase(r.type) },
    { key: "chargedTo", title: "Charged to", render: (r) => titleCase(r.chargedTo) },
    { key: "reasonCode", title: "Reason", render: (r) => (<div><div>{titleCase(r.reasonCode)}</div>{r.notes && <div className="text-secondary-light text-xs">{r.notes}</div>}</div>) },
    { key: "status", title: "Status", render: (r) => <StatusBadge status={r.status} /> },
    {
      key: "a",
      title: "",
      align: "right",
      render: (r) =>
        canApprove && r.status === "PENDING_APPROVAL" ? (
          <div className="d-flex gap-2 justify-content-end">
            <Button variant="success" onClick={() => decide(r, "approve")}>Approve</Button>
            <Button variant="outline-danger" onClick={() => decide(r, "reject")}>Reject</Button>
          </div>
        ) : null,
    },
  ];
  return (
    <>
      <PageHeader
        title="Refund approvals"
        subtitle={refundLimit === null ? "Refunds above the agent limit wait here. You have no approval limit." : `Refunds above the agent limit wait here. Your approval limit is ${money(refundLimit)}.`}
        crumbs={[{ label: "Finance", to: "/finance" }, { label: "Refund approvals" }]}
      />
      <Card>
        <ListToolbar list={list} placeholder="Search reason…" filters={<FilterSelect value={list.filters.status} onChange={(v) => list.setFilter("status", v)} options={["PENDING_APPROVAL", "APPROVED", "REJECTED", "PROCESSED"]} placeholder="All statuses" />} />
        <DataTable columns={cols} {...list.tableProps} error={list.error} onRetry={list.reload} emptyTitle={list.filters.status === "PENDING_APPROVAL" ? "No refunds awaiting approval" : "No refunds found"} emptyText="Over-limit refunds requested by support agents will appear here." />
      </Card>
    </>
  );
}
