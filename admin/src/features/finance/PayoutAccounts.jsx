import React, { useState } from "react";
import { Link } from "react-router-dom";
import { Button, Card, DataTable, ErrorState, PageHeader } from "../../ui";
import { http } from "../../lib/api";
import { useFetch, useSubmit } from "../../lib/hooks";
import { useAuth } from "../../lib/auth";
import { fmtDateTime, titleCase } from "../../lib/format";
import { PartyBadge } from "./common";
import { PayoutStatusBadge } from "./PayoutAccountBadge";

const STATUSES = ["NOT_STARTED", "PENDING", "RESTRICTED", "ENABLED"];

/** Finance > Payout accounts: who can be paid right now (Stripe Connect), filter by status / type, manual sync from Stripe. */
export default function PayoutAccounts() {
  const { can } = useAuth();
  const [status, setStatus] = useState("");
  const [partyType, setPartyType] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const { data, loading, error, reload } = useFetch("/admin/finance/payout-accounts", { status: status || undefined, partyType: partyType || undefined, search: search || undefined, page, limit: 25 });
  const { busy, run } = useSubmit();
  const edit = can("finance", "edit");
  const counts = data?.counts || {};
  const columns = [
    { key: "name", title: "Party", render: (r) => <div className="fw-semibold">{r.name}</div> },
    { key: "partyType", title: "Type", render: (r) => <PartyBadge type={r.partyType} /> },
    { key: "status", title: "Payout account", render: (r) => <PayoutStatusBadge status={r.status} /> },
    { key: "needs", title: "Still needed", render: (r) => (r.requirementsDue?.length ? <span className="text-xs">{r.requirementsDue.slice(0, 3).join(", ")}</span> : "") },
    { key: "bank", title: "Bank", render: (r) => (r.bankLast4 ? `****${r.bankLast4}` : "-") },
    { key: "syncedAt", title: "Last sync", render: (r) => (r.syncedAt ? fmtDateTime(r.syncedAt) : "-") },
    { key: "hold", title: "", render: (r) => (r.hold ? <span className="text-danger-600 text-xs">On hold</span> : "") },
    { key: "a", title: "", align: "right", render: (r) => <div className="d-flex gap-2 justify-content-end">{edit && r.hasAccount && <Button variant="light" disabled={busy} onClick={() => run(() => http.post(`/admin/finance/payout-accounts/${r.partyType}/${r.partyId}/sync`), { success: "Synced from Stripe", onDone: reload })}>Sync</Button>}<Link className="btn btn-sm btn-outline-neutral-300 radius-8" to={`/finance/parties`}>Bank and holds</Link></div> },
  ];
  return (
    <>
      <PageHeader
        title="Payout accounts"
        subtitle="Drivers and restaurants are paid through Stripe Connect. Only parties whose account is ready are paid; others wait."
        crumbs={[{ label: "Finance", to: "/finance" }, { label: "Payout accounts" }]}
        actions={edit && <Button loading={busy} onClick={() => run(() => http.post("/admin/finance/payout-accounts/sync"), { success: "All accounts synced from Stripe", onDone: reload })} data-testid="sync-all">Sync all from Stripe</Button>}
      />
      {data && !data.connectRequired && <div className="alert alert-warning radius-8 text-sm">Stripe Connect is not active (no Stripe key, or Connect is switched off in System &gt; Integrations): payouts use the development mock.</div>}
      <Card noPadding>
        <div className="d-flex flex-wrap gap-2 p-16 align-items-center">
          <div className="d-flex gap-1 flex-wrap" role="group" aria-label="Status filter">
            <button type="button" className={`btn btn-sm ${!status ? "btn-primary-600" : "btn-outline-neutral-300"} radius-8`} onClick={() => { setStatus(""); setPage(1); }}>All</button>
            {STATUSES.map((s) => <button key={s} type="button" className={`btn btn-sm ${status === s ? "btn-primary-600" : "btn-outline-neutral-300"} radius-8`} onClick={() => { setStatus(s); setPage(1); }} data-testid={`filter-${s}`}>{titleCase(s)} {counts[s] != null ? `(${counts[s]})` : ""}</button>)}
          </div>
          <select className="form-select form-select-sm radius-8" style={{ maxWidth: 160 }} value={partyType} onChange={(e) => { setPartyType(e.target.value); setPage(1); }} aria-label="Party type"><option value="">Everyone</option><option value="DRIVER">Drivers</option><option value="RESTAURANT">Restaurants</option></select>
          <input className="form-control form-control-sm radius-8" style={{ maxWidth: 220 }} placeholder="Search name" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
        </div>
        {error && <ErrorState error={error} onRetry={reload} />}
        <DataTable columns={columns} rows={data?.data || []} meta={data?.meta} loading={loading} onPage={setPage} dense emptyTitle="No parties match" />
      </Card>
    </>
  );
}
