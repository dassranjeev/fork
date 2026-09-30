import React, { useEffect } from "react";
import { Link } from "react-router-dom";
import { BarChart, Card, DataTable, ListToolbar, PageHeader, StatCard, StatusBadge } from "../../../ui";
import { useFetch, usePagedList } from "../../../lib/hooks";
import { money, num, pct, titleCase } from "../../../lib/format";
import { RangeBar, useRangeState } from "../shared";

export default function DriverPerfPage() {
  const [f, set] = useRangeState();
  const list = usePagedList("/admin/analytics/driver-performance", { limit: 25, sortBy: "trips", sortDir: "DESC", filters: f });
  useEffect(() => list.setFilters(f), [f]); // eslint-disable-line react-hooks/exhaustive-deps
  const fl = useFetch("/admin/analytics/driver-performance", { ...f, limit: 1 });
  const fleet = fl.data?.fleet;
  const top = list.rows.slice(0, 10);
  const load = fl.loading && !fleet;
  return (
    <>
      <PageHeader title="Driver Performance" subtitle="Trips, earnings and reliability across the fleet" crumbs={[{ label: "Analytics" }, { label: "Drivers" }]} />
      <RangeBar state={f} onChange={set} groupBy={false} exportKey="driver_performance" />
      <div className="row gy-4 mb-24">
        <div className="col-xl col-md-4 col-6"><StatCard label="Active drivers" value={num(fleet?.active)} icon="solar:scooter-outline" tone="primary" loading={load} /></div>
        <div className="col-xl col-md-4 col-6"><StatCard label="Online now" value={num(fleet?.online)} icon="solar:wifi-router-outline" tone="success" loading={load} /></div>
        <div className="col-xl col-md-4 col-6"><StatCard label="Avg. rating" value={num(fleet?.avgRating, 2)} icon="solar:star-outline" tone="warning" loading={load} /></div>
        <div className="col-xl col-md-6 col-6"><StatCard label="Avg. acceptance" value={pct(fleet?.avgAcceptanceRate)} icon="solar:check-circle-outline" tone="info" loading={load} /></div>
        <div className="col-xl col-md-6 col-6"><StatCard label="Avg. on-time" value={pct(fleet?.avgOnTimeRate)} icon="solar:clock-circle-outline" tone="purple" loading={load} /></div>
      </div>
      {top.length > 0 && (
        <Card title="Trips and earnings - current page" className="mb-24">
          <BarChart height={280} categories={top.map((r) => r.name)} series={[{ name: "Trips", data: top.map((r) => r.trips) }, { name: "Earnings ($)", data: top.map((r) => r.earnings) }]} />
        </Card>
      )}
      <Card noPadding>
        <div className="px-24 pt-20">
          <ListToolbar list={list} placeholder="Search drivers" />
        </div>
        <DataTable
          {...list.tableProps}
          onRetry={list.reload}
          error={list.error}
          columns={[
            { key: "name", title: "Driver", render: (r) => <Link to={`/drivers/${r.id}`} className="text-primary-600 fw-medium">{r.name}</Link> },
            { key: "status", title: "Status", render: (r) => <StatusBadge status={r.status} /> },
            { key: "vehicleType", title: "Vehicle", render: (r) => titleCase(r.vehicleType) },
            { key: "trips", title: "Trips", sortable: true, align: "right", render: (r) => num(r.trips) },
            { key: "onTimeRate", title: "On-time", sortable: true, align: "right", render: (r) => pct(r.onTimeRatePeriodPct) },
            { key: "acceptanceRate", title: "Acceptance", sortable: true, align: "right", render: (r) => pct(r.acceptanceRate) },
            { key: "rating", title: "Rating", sortable: true, align: "right", render: (r) => Number(r.rating).toFixed(2) },
            { key: "avgTripMin", title: "Avg trip (min)", align: "right", render: (r) => num(r.avgTripMin, 1) },
            { key: "earnings", title: "Earnings", sortable: true, align: "right", render: (r) => money(r.earnings) },
            { key: "earningsPerTrip", title: "Per trip", align: "right", render: (r) => money(r.earningsPerTrip) },
          ]}
        />
      </Card>
    </>
  );
}
