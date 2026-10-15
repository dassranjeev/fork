import React, { useEffect } from "react";
import { Link } from "react-router-dom";
import { BarChart, Card, DataTable, ListToolbar, PageHeader, StatCard, StatusBadge } from "../../../ui";
import { useFetch, usePagedList } from "../../../lib/hooks";
import { money, num, pct } from "../../../lib/format";
import { RangeBar, useRangeState } from "../shared";

export default function RestaurantPerfPage() {
  const [f, set] = useRangeState();
  const list = usePagedList("/admin/analytics/restaurant-performance", { limit: 25, sortBy: "gmv", sortDir: "DESC", filters: f });
  useEffect(() => list.setFilters(f), [f]); // eslint-disable-line react-hooks/exhaustive-deps
  const kp = useFetch("/admin/analytics/restaurant-performance", { ...f, limit: 1 });
  const k = kp.data?.kpis;
  const top = list.rows.slice(0, 10);
  return (
    <>
      <PageHeader title="Business Performance" subtitle="Sales, reliability and prep times per business" crumbs={[{ label: "Analytics" }, { label: "Businesses" }]} />
      <RangeBar state={f} onChange={set} groupBy={false} exportKey="restaurant_performance" />
      <div className="row gy-4 mb-24">
        <div className="col-md-3 col-6"><StatCard label="Restaurants" value={num(list.meta.total)} icon="solar:shop-2-outline" tone="primary" /></div>
        <div className="col-md-3 col-6"><StatCard label="Orders" value={num(k?.orders)} icon="solar:box-outline" tone="info" loading={kp.loading && !k} /></div>
        <div className="col-md-3 col-6"><StatCard label="GMV" value={money(k?.gmv)} icon="solar:wallet-money-outline" tone="success" loading={kp.loading && !k} /></div>
        <div className="col-md-3 col-6"><StatCard label="Cancellation rate" value={pct(k?.cancellationRatePct)} icon="solar:close-circle-outline" tone="danger" loading={kp.loading && !k} /></div>
      </div>
      {top.length > 0 && (
        <Card title="GMV - top restaurants" subtitle="Current page, sorted as in the table" className="mb-24">
          <BarChart horizontal distributed currency height={Math.max(220, top.length * 34)} categories={top.map((r) => r.name)} series={[{ name: "GMV", data: top.map((r) => r.gmv) }]} />
        </Card>
      )}
      <Card noPadding>
        <div className="px-24 pt-20">
          <ListToolbar list={list} placeholder="Search restaurants" />
        </div>
        <DataTable
          {...list.tableProps}
          onRetry={list.reload}
          error={list.error}
          columns={[
            { key: "name", title: "Restaurant", render: (r) => <Link to={`/restaurants/${r.id}`} className="text-primary-600 fw-medium">{r.name}</Link> },
            { key: "status", title: "Status", render: (r) => <StatusBadge status={r.status} /> },
            { key: "orders", title: "Orders", sortable: true, align: "right", render: (r) => num(r.orders) },
            { key: "gmv", title: "GMV", sortable: true, align: "right", render: (r) => money(r.gmv) },
            { key: "aov", title: "AOV", align: "right", render: (r) => money(r.aov) },
            { key: "commission", title: "Commission", align: "right", render: (r) => money(r.commission) },
            { key: "rating", title: "Rating", sortable: true, align: "right", render: (r) => Number(r.rating).toFixed(2) },
            { key: "cancellationRatePct", title: "Cancel %", sortable: true, align: "right", render: (r) => pct(r.cancellationRatePct) },
            { key: "lateRatePct", title: "Late %", align: "right", render: (r) => pct(r.lateRatePct) },
            { key: "avgPrepMin", title: "Prep (min)", sortable: true, align: "right", render: (r) => num(r.avgPrepMin, 1) },
            { key: "reliabilityScore", title: "Reliability", sortable: true, align: "right", render: (r) => num(r.reliabilityScore, 0) },
          ]}
        />
      </Card>
    </>
  );
}
