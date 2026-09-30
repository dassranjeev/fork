import React, { useState } from "react";
import { Button, Card, DataTable, DateInput, FilterSelect, ListToolbar, PageHeader } from "../../ui";
import { act, http } from "../../lib/api";
import { usePagedList } from "../../lib/hooks";
import { useAuth } from "../../lib/auth";
import { fmtDateTime, money, titleCase } from "../../lib/format";
import { AdjustmentModal, LEDGER_TYPES, PARTY_TYPES, PartyBadge, Signed, downloadText } from "./common";

/** Ledger explorer. With `adjustments` it is pinned to manual adjustments and offers a "New adjustment" action. */
export default function Ledger({ adjustments = false }) {
  const { can } = useAuth();
  const list = usePagedList("/admin/finance/ledger", { filters: { partyType: "", type: adjustments ? "ADJUSTMENT" : "", payout: "", from: "", to: "" } });
  const [adj, setAdj] = useState(false);
  const exportCsv = async () => {
    const r = await act(() => http.get("/admin/finance/ledger/export/csv", list.params));
    if (r?.csv) downloadText(r.filename || "ledger.csv", r.csv);
  };
  const cols = [
    { key: "createdAt", title: "Date", render: (e) => fmtDateTime(e.createdAt) },
    { key: "party", title: "Party", render: (e) => (<div><div className="fw-medium">{e.partyName || "—"}</div><PartyBadge type={e.partyType} /></div>) },
    { key: "type", title: "Type", render: (e) => titleCase(e.type) },
    { key: "description", title: "Description", render: (e) => e.description || "—" },
    { key: "payout", title: "Payout", render: (e) => (e.payoutId ? "Paid out" : <span className="text-secondary-light">Unpaid</span>) },
    { key: "amount", title: "Amount", align: "right", render: (e) => <strong><Signed value={e.amount} fmt={money} /></strong> },
  ];
  return (
    <>
      <PageHeader
        title={adjustments ? "Manual adjustments" : "Ledger"}
        subtitle={adjustments ? "Credits and debits posted by staff, with audit reasons" : "Every financial entry across restaurants, drivers and the platform"}
        crumbs={[{ label: "Finance", to: "/finance" }, { label: adjustments ? "Adjustments" : "Ledger" }]}
        actions={adjustments && can("finance", "edit") && <Button icon="solar:add-circle-outline" onClick={() => setAdj(true)}>New adjustment</Button>}
      />
      <Card>
        <ListToolbar
          list={list}
          placeholder="Search description…"
          onExport={can("finance", "export") ? exportCsv : undefined}
          filters={
            <>
              <FilterSelect value={list.filters.partyType} onChange={(v) => list.setFilter("partyType", v)} options={PARTY_TYPES} placeholder="All parties" />
              {!adjustments && <FilterSelect value={list.filters.type} onChange={(v) => list.setFilter("type", v)} options={LEDGER_TYPES} placeholder="All types" />}
              <FilterSelect value={list.filters.payout} onChange={(v) => list.setFilter("payout", v)} options={[{ value: "paid", label: "Paid out" }, { value: "unpaid", label: "Unpaid" }]} placeholder="Payout state" />
              <div style={{ width: 150 }}><DateInput className="mb-0" value={list.filters.from} onChange={(v) => list.setFilter("from", v || "")} /></div>
              <div style={{ width: 150 }}><DateInput className="mb-0" value={list.filters.to} onChange={(v) => list.setFilter("to", v || "")} /></div>
            </>
          }
        />
        <DataTable columns={cols} {...list.tableProps} error={list.error} onRetry={list.reload} emptyTitle={adjustments ? "No manual adjustments" : "No ledger entries"} emptyText={adjustments ? "Post an adjustment to correct a balance." : "Entries appear as orders are completed."} />
      </Card>
      {adj && <AdjustmentModal onClose={() => setAdj(false)} onDone={() => { setAdj(false); list.reload(); }} />}
    </>
  );
}
