import React, { useState } from "react";
import { BarChart, Card, DataTable, DonutChart, Heatmap, LineChart, Segmented, StatCard, StatusBadge, Tabs } from "../../ui";
import { fmtDate, money, num, pct } from "../../lib/format";
import { usePagedList } from "../../lib/hooks";
import { Async, DAYS_SHORT, PortalPage, daysAgo, isoDay, usePortalFetch } from "./shared";
import { Stars } from "./Reviews";

const RANGES = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
];

function useRange(days) {
  return { from: daysAgo(Number(days)), to: isoDay(new Date()) };
}

function Sales({ range }) {
  const state = usePortalFetch("/restaurant/reports/sales", { ...range, groupBy: "day" });
  return (
    <Async state={state}>
      {(d) => {
        const k = d.kpis;
        const delta = (x) => x?.changePct;
        return (
          <>
            <div className="row gy-3 mb-24">
              <div className="col-xl-3 col-sm-6"><StatCard label="Gross sales" value={money(k.gmv.value)} delta={delta(k.gmv)} icon="solar:wallet-money-outline" tone="success" /></div>
              <div className="col-xl-3 col-sm-6"><StatCard label="Your payout" value={money(k.payout.value)} delta={delta(k.payout)} icon="solar:hand-money-outline" tone="primary" /></div>
              <div className="col-xl-3 col-sm-6"><StatCard label="Orders" value={num(k.orders.value)} delta={delta(k.orders)} icon="solar:bag-check-outline" tone="info" hint={`${k.completedOrders.value} completed`} /></div>
              <div className="col-xl-3 col-sm-6"><StatCard label="Average order" value={money(k.aov.value)} delta={delta(k.aov)} icon="solar:chart-2-outline" tone="warning" /></div>
            </div>
            <Card title="Sales by day" subtitle={`Commission ${money(k.commission.value)} · cancellation rate ${pct(k.cancellationRatePct.value)}`}>
              <LineChart
                currency
                categories={d.series.map((s) => fmtDate(s.bucket, { year: undefined }))}
                series={[
                  { name: "Gross sales", data: d.series.map((s) => Number(s.gmv) || 0) },
                  { name: "Payout", data: d.series.map((s) => Number(s.payout) || 0) },
                ]}
              />
            </Card>
          </>
        );
      }}
    </Async>
  );
}

function TopItems({ range }) {
  const state = usePortalFetch("/restaurant/reports/top-items", { ...range, limit: 10 });
  return (
    <Async state={state} empty={(d) => d.length === 0} emptyProps={{ title: "No sales in this period" }}>
      {(rows) => (
        <div className="row g-3">
          <div className="col-lg-6">
            <Card title="Revenue by item">
              <BarChart horizontal currency distributed categories={rows.map((r) => r.name)} series={[{ name: "Revenue", data: rows.map((r) => Number(r.revenue)) }]} height={Math.max(260, rows.length * 38)} />
            </Card>
          </div>
          <div className="col-lg-6">
            <Card title="Ranking" noPadding>
              <div className="table-responsive">
                <table className="table bordered-table sm-table mb-0">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Item</th>
                      <th className="text-end">Qty</th>
                      <th className="text-end">Orders</th>
                      <th className="text-end">Revenue</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={r.menuItemId}>
                        <td>{i + 1}</td>
                        <td className="fw-semibold">{r.name}</td>
                        <td className="text-end">{r.qty}</td>
                        <td className="text-end">{r.orders}</td>
                        <td className="text-end">{money(r.revenue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </div>
        </div>
      )}
    </Async>
  );
}

function PeakHours({ range }) {
  const state = usePortalFetch("/restaurant/reports/peak-hours", range);
  return (
    <Async state={state}>
      {(d) => {
        const series = DAYS_SHORT.map((name, dow) => ({
          name,
          data: Array.from({ length: 24 }, (_, h) => ({ x: String(h).padStart(2, "0"), y: d.grid.find((g) => g.dow === dow && g.hour === h)?.orders || 0 })),
        })).reverse();
        return (
          <div className="row g-3">
            <div className="col-xl-9">
              <Card title="Orders by weekday and hour">
                <Heatmap series={series} height={340} />
              </Card>
            </div>
            <div className="col-xl-3">
              <Card title="Busiest times">
                {d.busiest.length === 0 && <div className="text-secondary-light">Not enough orders yet</div>}
                <ul className="list-unstyled mb-0">
                  {d.busiest.map((b, i) => (
                    <li key={i} className="d-flex justify-content-between py-8 border-bottom">
                      <span className="fw-medium">
                        {DAYS_SHORT[b.dow]} {String(b.hour).padStart(2, "0")}:00
                      </span>
                      <span className="text-secondary-light">{b.orders} orders</span>
                    </li>
                  ))}
                </ul>
              </Card>
            </div>
          </div>
        );
      }}
    </Async>
  );
}

function Ratings({ range }) {
  const state = usePortalFetch("/restaurant/reports/ratings", range);
  return (
    <Async state={state}>
      {(d) => (
        <div className="row g-3">
          <div className="col-lg-4">
            <Card title="Rating summary">
              <div className="d-flex align-items-baseline gap-3 mb-12">
                <h2 className="mb-0">{d.average ? Number(d.average).toFixed(1) : "—"}</h2>
                <span className="text-secondary-light">{d.total} reviews · {pct(d.repliedPct, 0)} replied</span>
              </div>
              <DonutChart labels={d.distribution.map((x) => `${x.stars} star`)} values={d.distribution.map((x) => x.count)} height={240} total={false} colors={["#22c55e", "#84cc16", "#eab308", "#f97316", "#ef4444"].slice(0)} />
            </Card>
          </div>
          <div className="col-lg-8">
            <Card title="Recent reviews" noPadding>
              <ul className="list-unstyled mb-0" style={{ maxHeight: 420, overflow: "auto" }}>
                {d.recent.length === 0 && <li className="p-20 text-secondary-light">No reviews in this period</li>}
                {d.recent.map((r) => (
                  <li key={r.id} className="px-20 py-12 border-bottom">
                    <div className="d-flex justify-content-between">
                      <Stars value={r.rating} />
                      <span className="text-secondary-light text-xs">{r.orderCode} · {fmtDate(r.createdAt)}</span>
                    </div>
                    <div className="text-sm mt-4">{r.comment || <em className="text-secondary-light">No comment</em>}</div>
                  </li>
                ))}
              </ul>
            </Card>
          </div>
        </div>
      )}
    </Async>
  );
}

function PayoutsReport() {
  const list = usePagedList("/restaurant/reports/payouts", { limit: 15 });
  const cols = [
    { key: "period", title: "Period", render: (p) => `${fmtDate(p.periodStart)} – ${fmtDate(p.periodEnd)}` },
    { key: "orderCount", title: "Orders", align: "right" },
    { key: "gross", title: "Gross", align: "right", render: (p) => money(p.gross) },
    { key: "deductions", title: "Deductions", align: "right", render: (p) => money(p.deductions) },
    { key: "net", title: "Net", align: "right", render: (p) => <span className="fw-semibold">{money(p.net)}</span> },
    { key: "status", title: "Status", render: (p) => <StatusBadge status={p.status} /> },
    { key: "paidAt", title: "Paid", render: (p) => fmtDate(p.paidAt) },
  ];
  return (
    <div className="card radius-12 border-0 shadow-sm">
      <DataTable columns={cols} {...list.tableProps} error={list.error} onRetry={list.reload} emptyTitle="No payouts yet" />
    </div>
  );
}

function PromotionsReport({ range }) {
  const state = usePortalFetch("/restaurant/reports/promotions", range);
  return (
    <Async state={state}>
      {(d) => (
        <>
          <div className="row gy-3 mb-24">
            <div className="col-md-4"><StatCard label="Platform promo redemptions" value={num(d.platformImpact.redemptions)} icon="solar:ticket-outline" tone="primary" /></div>
            <div className="col-md-4"><StatCard label="Sales with platform promos" value={money(d.platformImpact.gmv)} icon="solar:wallet-money-outline" tone="success" /></div>
            <div className="col-md-4"><StatCard label="Discount cost (FORKY funded)" value={money(d.platformImpact.discountCost)} icon="solar:tag-price-outline" tone="info" /></div>
          </div>
          <Card title="Your promotions" noPadding>
            <div className="table-responsive">
              <table className="table bordered-table sm-table mb-0">
                <thead>
                  <tr>
                    <th>Promotion</th>
                    <th className="text-end">Redemptions</th>
                    <th className="text-end">Discount</th>
                    <th className="text-end">Sales</th>
                  </tr>
                </thead>
                <tbody>
                  {d.owned.length === 0 && (
                    <tr>
                      <td colSpan={4} className="text-center text-secondary-light py-24">You have no promotions with activity in this period</td>
                    </tr>
                  )}
                  {d.owned.map((p, i) => (
                    <tr key={p.id || i}>
                      <td className="fw-semibold">{p.name || p.code}</td>
                      <td className="text-end">{num(p.redemptions)}</td>
                      <td className="text-end">{money(p.discountCost ?? p.discount)}</td>
                      <td className="text-end">{money(p.gmv)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </Async>
  );
}

export default function Reports() {
  const [days, setDays] = useState("30");
  const [tab, setTab] = useState("sales");
  const range = useRange(days);
  return (
    <PortalPage title="Reports" actions={<Segmented options={RANGES} value={days} onChange={setDays} />}>
      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { key: "sales", label: "Sales", content: <Sales range={range} /> },
          { key: "items", label: "Top items", content: <TopItems range={range} /> },
          { key: "peak", label: "Peak hours", content: <PeakHours range={range} /> },
          { key: "ratings", label: "Ratings", content: <Ratings range={range} /> },
          { key: "payouts", label: "Payouts", content: <PayoutsReport /> },
          { key: "promos", label: "Promotions", content: <PromotionsReport range={range} /> },
        ]}
      />
    </PortalPage>
  );
}
