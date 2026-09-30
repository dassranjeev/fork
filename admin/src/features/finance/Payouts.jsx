import React from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Card, DataTable, DateInput, FilterSelect, ListToolbar, PageHeader, StatusBadge } from "../../ui";
import { act, http } from "../../lib/api";
import { usePagedList } from "../../lib/hooks";
import { useAuth } from "../../lib/auth";
import { fmtDateTime, money } from "../../lib/format";
import { fmtDay as fmtDate } from "./common";
import { PARTY_TYPES, PAYOUT_STATUSES, PartyBadge, downloadText } from "./common";

/** mode "statements" lists settled payouts and links straight to their statements. */
export default function Payouts({ mode = "payouts" }) {
  const nav = useNavigate();
  const { can } = useAuth();
  const [sp] = useSearchParams();
  const statements = mode === "statements";
  const list = usePagedList("/admin/finance/payouts", { filters: { status: statements ? "PAID" : sp.get("status") || "", partyType: "", instant: "", from: "", to: "" } });

  const exportCsv = async () => {
    const r = await act(() => http.get("/admin/finance/payouts/export/csv", list.params));
    if (r?.csv) downloadText(r.filename || "payouts.csv", r.csv);
  };
  const cols = [
    { key: "partyName", title: "Party", render: (p) => (<div><div className="fw-semibold">{p.partyName}</div><PartyBadge type={p.partyType} /> {p.instant && <StatusBadge status="Instant" tone="info" />}</div>) },
    { key: "period", title: "Period", render: (p) => `${fmtDate(p.periodStart)} – ${fmtDate(p.periodEnd)}` },
    { key: "orderCount", title: "Orders" },
    { key: "gross", title: "Gross", align: "right", render: (p) => money(p.gross) },
    { key: "deductions", title: "Deductions", align: "right", render: (p) => money(p.deductions) },
    { key: "net", title: "Net", align: "right", render: (p) => <strong>{money(p.net)}</strong> },
    { key: "status", title: "Status", render: (p) => <StatusBadge status={p.status} /> },
    { key: "paidAt", title: "Paid", render: (p) => fmtDateTime(p.paidAt) },
    ...(statements ? [{ key: "st", title: "", align: "right", render: (p) => <Link to={`/finance/statements/${p.id}`} className="btn btn-sm btn-outline-primary-600 radius-8" onClick={(e) => e.stopPropagation()}>Statement</Link> }] : []),
  ];
  return (
    <>
      <PageHeader
        title={statements ? "Statements" : "Payouts"}
        subtitle={statements ? "Per-order settlement statements for paid payouts" : "Every restaurant and driver payout across batches"}
        crumbs={[{ label: "Finance", to: "/finance" }, { label: statements ? "Statements" : "Payouts" }]}
      />
      <Card>
        <ListToolbar
          list={list}
          placeholder="Search party…"
          onExport={!statements && can("finance", "export") ? exportCsv : undefined}
          filters={
            <>
              {!statements && <FilterSelect value={list.filters.status} onChange={(v) => list.setFilter("status", v)} options={PAYOUT_STATUSES} placeholder="Any status" />}
              <FilterSelect value={list.filters.partyType} onChange={(v) => list.setFilter("partyType", v)} options={PARTY_TYPES.slice(0, 2)} placeholder="Restaurants and drivers" />
              <FilterSelect value={list.filters.instant} onChange={(v) => list.setFilter("instant", v)} options={[{ value: "true", label: "Instant only" }, { value: "false", label: "Scheduled only" }]} placeholder="All types" />
              <div style={{ width: 150 }}><DateInput className="mb-0" value={list.filters.from} onChange={(v) => list.setFilter("from", v || "")} /></div>
              <div style={{ width: 150 }}><DateInput className="mb-0" value={list.filters.to} onChange={(v) => list.setFilter("to", v || "")} /></div>
            </>
          }
        />
        <DataTable columns={cols} {...list.tableProps} error={list.error} onRetry={list.reload} onRowClick={(p) => nav(statements ? `/finance/statements/${p.id}` : `/finance/payouts/${p.id}`)} emptyTitle={statements ? "No statements yet" : "No payouts found"} emptyText="Payouts are created when a weekly batch is generated." />
      </Card>
    </>
  );
}
