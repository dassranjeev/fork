import React, { useState } from "react";
import { Link } from "react-router-dom";
import { Badge, BarChart, Card, DataTable, DonutChart, EmptyState, LineChart, PageHeader, StatCard, StatusBadge } from "../../ui";
import { useFetch } from "../../lib/hooks";
import { money, num, pct, titleCase } from "../../lib/format";
import { useSocketEvent } from "../../lib/socket";
import { Async, CityFilter, kpiProps } from "./shared";

const STATUS_HEX = { PLACED: "#06b6d4", ACCEPTED: "#487fff", DRIVER_ASSIGNED: "#8b5cf6", PREPARING: "#eab308", READY: "#22c55e", PICKED_UP: "#a78bfa", ON_THE_WAY: "#ff6917" };

export default function DashboardPage() {
  const [cityId, setCityId] = useState("");
  const dash = useFetch("/admin/dashboard", { cityId }, { refreshMs: 30000 });
  const attention = useFetch("/admin/analytics/live-ops", { cityId }, { refreshMs: 30000 });
  useSocketEvent(["order.new", "order.status", "dispatch.escalated"], () => {
    dash.reload();
    attention.reload();
  });

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle="Live marketplace pulse for today"
        actions={
          <>
            <CityFilter value={cityId} onChange={setCityId} />
            <button
              type="button"
              className="btn btn-outline-neutral-300 text-primary-light btn-sm radius-8 h-40-px"
              onClick={() => {
                dash.reload();
                attention.reload();
              }}
            >
              Refresh
            </button>
          </>
        }
      />
      <Async state={dash}>
        {(d) => {
          const hours = d.hourlyOrders?.today || [];
          const yest = d.hourlyOrders?.yesterday || [];
          const cats = hours.map((h) => `${String(h.hour).padStart(2, "0")}:00`);
          const statusRows = (d.live?.byStatus || []).filter((s) => s.count > 0);
          return (
            <>
              <div className="row gy-4">
                <div className="col-xxl-2 col-md-4 col-sm-6">
                  <StatCard label="Live orders" value={num(d.live?.activeOrders)} icon="solar:box-outline" tone="primary" hint={`${num(d.live?.unassigned)} unassigned`} to="/live-map" />
                </div>
                <div className="col-xxl-2 col-md-4 col-sm-6">
                  <StatCard label="GMV today" icon="solar:wallet-money-outline" tone="success" {...kpiProps(d.today?.gmv, money)} hint="vs yest." />
                </div>
                <div className="col-xxl-2 col-md-4 col-sm-6">
                  <StatCard label="Active drivers" value={num(d.drivers?.online)} icon="solar:scooter-outline" tone="info" hint={`${num(d.drivers?.onTrip)} on trip, ${num(d.drivers?.idle)} idle`} />
                </div>
                <div className="col-xxl-2 col-md-4 col-sm-6">
                  <StatCard label="Late orders" value={num(d.live?.late)} icon="solar:clock-circle-outline" tone="danger" hint={`${num(d.live?.escalated)} escalated`} to="/live-map" />
                </div>
                <div className="col-xxl-2 col-md-4 col-sm-6">
                  <StatCard label="Cancellations" value={num(d.today?.cancellations?.value)} icon="solar:close-circle-outline" tone="warning" hint={`${pct(d.today?.cancellationRatePct)} of ${num(d.today?.orders?.value)} orders`} />
                </div>
                <div className="col-xxl-2 col-md-4 col-sm-6">
                  <StatCard label="Open tickets" value={num(d.openTickets?.total)} icon="solar:chat-round-dots-outline" tone="purple" hint={`${num(d.openTickets?.slaBreached)} SLA breached`} />
                </div>
              </div>

              <div className="row gy-4 mt-1">
                <div className="col-xl-8">
                  <Card title="Orders by hour" subtitle="Today vs yesterday">
                    <LineChart
                      height={300}
                      categories={cats}
                      series={[
                        { name: "Today", data: hours.map((h) => h.orders) },
                        { name: "Yesterday", data: yest.map((h) => h.orders) },
                      ]}
                    />
                  </Card>
                </div>
                <div className="col-xl-4">
                  <Card title="Live orders by status">
                    {statusRows.length ? (
                      <DonutChart labels={statusRows.map((s) => titleCase(s.status))} values={statusRows.map((s) => s.count)} colors={statusRows.map((s) => STATUS_HEX[s.status])} height={300} />
                    ) : (
                      <EmptyState title="No live orders" />
                    )}
                  </Card>
                </div>
              </div>

              <div className="row gy-4 mt-1">
                <div className="col-xl-4">
                  <Card title="GMV comparison">
                    <BarChart
                      height={260}
                      currency
                      distributed
                      categories={["Today", "Yest. so far", "Last wk so far", "Yest. full"]}
                      series={[{ name: "GMV", data: [d.gmvComparison?.today || 0, d.gmvComparison?.yesterdaySoFar || 0, d.gmvComparison?.lastWeekSameDaySoFar || 0, d.gmvComparison?.yesterdayFull || 0] }]}
                    />
                  </Card>
                </div>
                <div className="col-xl-4">
                  <Card title="Top restaurants today" noPadding>
                    <DataTable
                      dense
                      rowKey="restaurantId"
                      rows={d.topRestaurants || []}
                      columns={[
                        { key: "name", title: "Restaurant", render: (r) => <div className="text-truncate" style={{ maxWidth: 150 }}>{r.name}</div> },
                        { key: "orders", title: "Orders", align: "right" },
                        { key: "gmv", title: "GMV", align: "right", render: (r) => money(r.gmv) },
                      ]}
                      emptyTitle="No orders yet today"
                    />
                  </Card>
                </div>
                <div className="col-xl-4">
                  <Card title="Pending approvals">
                    {d.pendingApprovals?.total ? (
                      <ul className="list-unstyled mb-0 d-flex flex-column gap-12">
                        {[
                          ["restaurants", "Restaurants", "/restaurants"],
                          ["drivers", "Drivers", "/drivers"],
                          ["restaurantDocuments", "Restaurant documents", "/restaurants"],
                          ["driverDocuments", "Driver documents", "/drivers"],
                          ["promotions", "Promotions", "/promotions"],
                          ["refunds", "Refunds", "/refunds"],
                        ]
                          .filter(([k]) => d.pendingApprovals[k] > 0)
                          .map(([k, label, to]) => (
                            <li key={k} className="d-flex justify-content-between align-items-center">
                              <Link to={to} className="text-primary-light hover-text-primary">
                                {label}
                              </Link>
                              <Badge tone="warning">{d.pendingApprovals[k]}</Badge>
                            </li>
                          ))}
                      </ul>
                    ) : (
                      <EmptyState icon="solar:check-circle-outline" title="Nothing pending" />
                    )}
                  </Card>
                </div>
              </div>

              <div className="row gy-4 mt-1">
                <div className="col-xl-7">
                  <Card
                    title="Needs attention"
                    subtitle="Late and unassigned orders"
                    noPadding
                    actions={
                      <Link to="/live-map" className="text-primary-600 text-sm">
                        Open live map
                      </Link>
                    }
                  >
                    <DataTable
                      dense
                      loading={attention.loading && !attention.data}
                      error={attention.error}
                      rows={attention.data?.needsAttention || []}
                      columns={[
                        { key: "code", title: "Order", render: (r) => <Link to={`/orders/${r.id}`} className="text-primary-600 fw-medium">{r.code}</Link> },
                        { key: "restaurantName", title: "Restaurant", render: (r) => <div className="text-truncate" style={{ maxWidth: 170 }}>{r.restaurantName}</div> },
                        { key: "status", title: "Status", render: (r) => <StatusBadge status={r.status} /> },
                        {
                          key: "flags",
                          title: "Flags",
                          render: (r) => (
                            <>
                              {r.unassigned && <Badge tone="danger" className="me-1">No driver</Badge>}
                              {r.isLate && <Badge tone="warning">Late {Math.round(r.minutesOverEta)}m</Badge>}
                            </>
                          ),
                        },
                      ]}
                      emptyTitle="All clear"
                    />
                  </Card>
                </div>
                <div className="col-xl-5">
                  <Card title="By city" noPadding>
                    <DataTable
                      dense
                      rows={d.byCity || []}
                      columns={[
                        { key: "name", title: "City" },
                        { key: "orders", title: "Orders", align: "right" },
                        { key: "gmv", title: "GMV", align: "right", render: (r) => money(r.gmv) },
                        { key: "lateOrders", title: "Late", align: "right" },
                        { key: "driversOnline", title: "Drivers", align: "right" },
                      ]}
                    />
                  </Card>
                </div>
              </div>
            </>
          );
        }}
      </Async>
    </>
  );
}
