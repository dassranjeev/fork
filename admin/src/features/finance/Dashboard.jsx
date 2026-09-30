import React, { useState } from "react";
import { Link } from "react-router-dom";
import { Button, Card, DataTable, ErrorState, Loading, PageHeader, StatCard, StatusBadge } from "../../ui";
import { useFetch } from "../../lib/hooks";
import { useAuth } from "../../lib/auth";
import { money } from "../../lib/format";
import { fmtDay as fmtDate } from "./common";
import { AdjustmentModal } from "./common";

export default function FinanceDashboard() {
  const { can } = useAuth();
  const { data: d, loading, error, reload } = useFetch("/admin/finance/dashboard", null, { refreshMs: 60000 });
  const batches = useFetch("/admin/finance/batches", { limit: 5 });
  const [adj, setAdj] = useState(false);
  if (loading && !d) return <Loading />;

  const alerts = d
    ? [
        ["Batches in draft", d.draftBatches, "/finance/batches", "solar:document-add-outline", "info"],
        ["Awaiting release", d.awaitingRelease, "/finance/batches", "solar:hourglass-outline", "warning"],
        ["Payouts on hold", d.onHoldPayouts, "/finance/payouts?status=ON_HOLD", "solar:lock-outline", "warning"],
        ["Failed payouts", d.failedPayouts, "/finance/payouts?status=FAILED", "solar:danger-triangle-outline", "danger"],
        ["Refunds to approve", d.pendingRefundApprovals, "/finance/refunds", "solar:undo-left-round-outline", "warning"],
        ["Reconciliation gaps", d.unresolvedReconciliationGaps, "/finance/batches", "solar:scale-outline", "danger"],
      ]
    : [];
  return (
    <>
      <PageHeader
        title="Finance"
        subtitle="Balances, payout cycle health and items needing attention"
        crumbs={[{ label: "Finance" }]}
        actions={
          <>
            {can("finance", "edit") && <Button variant="outline" icon="solar:pen-new-square-outline" onClick={() => setAdj(true)}>Manual adjustment</Button>}
            <Link to="/finance/batches" className="btn btn-primary-600 btn-sm radius-8 px-16 py-8">Payout batches</Link>
          </>
        }
      />
      {error && <ErrorState error={error} onRetry={reload} />}
      {d && (
        <>
          <div className="row gy-3 mb-24">
            <div className="col-sm-6 col-xl-3"><StatCard label="Platform balance" value={money(d.platformBalance)} icon="solar:wallet-money-outline" tone="primary" /></div>
            <div className="col-sm-6 col-xl-3"><StatCard label="Owed to restaurants" value={money(d.unpaidRestaurantBalance)} icon="solar:shop-2-outline" tone="info" hint="unpaid" /></div>
            <div className="col-sm-6 col-xl-3"><StatCard label="Owed to drivers" value={money(d.unpaidDriverBalance)} icon="solar:scooter-outline" tone="purple" hint="unpaid" /></div>
            <div className="col-sm-6 col-xl-3"><StatCard label="HST collected (this month)" value={money(d.hstCollectedThisMonth)} icon="solar:bill-list-outline" tone="success" to="/finance/hst" /></div>
          </div>
          <h6 className="mb-12">Needs attention</h6>
          <div className="row gy-3 mb-24">
            {alerts.map(([label, n, to, icon, tone]) => (
              <div className="col-6 col-md-4 col-xl-2" key={label}>
                <StatCard label={label} value={n} icon={icon} tone={n > 0 ? tone : "neutral"} to={to} />
              </div>
            ))}
          </div>
        </>
      )}
      <Card title="Recent payout batches" actions={<Link to="/finance/batches" className="text-primary-600 text-sm">View all</Link>} noPadding bodyClassName="p-0">
        <DataTable
          rows={batches.data?.data || []}
          loading={batches.loading}
          error={batches.error}
          onRetry={batches.reload}
          emptyTitle="No payout batches yet"
          emptyText="Generate the first weekly batch from the Payout batches page."
          columns={[
            { key: "period", title: "Period", render: (b) => <Link className="text-primary-600 fw-medium" to={`/finance/batches/${b.id}`}>{fmtDate(b.periodStart)} – {fmtDate(b.periodEnd)}</Link> },
            { key: "status", title: "Status", render: (b) => <StatusBadge status={b.status} /> },
            { key: "restaurantCount", title: "Restaurants" },
            { key: "driverCount", title: "Drivers" },
            { key: "total", title: "Total", align: "right", render: (b) => <strong>{money(b.total)}</strong> },
          ]}
        />
      </Card>
      {adj && <AdjustmentModal onClose={() => setAdj(false)} onDone={() => { setAdj(false); reload(); }} />}
    </>
  );
}
