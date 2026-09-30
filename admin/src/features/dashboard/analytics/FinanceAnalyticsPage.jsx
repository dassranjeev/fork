import React from "react";
import { BarChart, Card, DataTable, LineChart, PageHeader, StatCard, StatusBadge } from "../../../ui";
import { useFetch } from "../../../lib/hooks";
import { fmtDate, money, num, titleCase } from "../../../lib/format";
import { Async, RangeBar, SectionNote, bucketLabel, kpiProps, useRangeState } from "../shared";

export default function FinanceAnalyticsPage() {
  const [f, set] = useRangeState();
  const res = useFetch("/admin/analytics/finance", f);
  return (
    <>
      <PageHeader title="Finance Analytics" subtitle="Revenue, costs, refunds and payouts" crumbs={[{ label: "Analytics" }, { label: "Finance" }]} />
      <RangeBar state={f} onChange={set} exportKey="finance" />
      <Async state={res}>
        {(d) => {
          const k = d.kpis;
          const cards = [
            ["Net revenue", k.netRevenue, "solar:dollar-minimalistic-outline", "primary"],
            ["Driver cost", k.driverCost, "solar:scooter-outline", "warning", true],
            ["Processing cost", k.processingCost, "solar:card-outline", "purple", true],
            ["Platform refunds", k.platformRefunds, "solar:undo-left-round-outline", "danger", true],
            ["Margin", k.margin, "solar:graph-up-outline", "success"],
            ["HST collected", k.hstCollected, "solar:bill-list-outline", "info"],
          ];
          const cats = d.series.map((s) => bucketLabel(s.bucket));
          return (
            <>
              <div className="row gy-4">
                {cards.map(([l, kp, i, t, inv]) => (
                  <div className="col-xl-2 col-md-4 col-6" key={l}>
                    <StatCard label={l} icon={i} tone={t} invertDelta={inv} {...kpiProps(kp, money)} />
                  </div>
                ))}
              </div>
              <div className="row gy-4 mt-1">
                <div className="col-xl-8">
                  <Card title="Revenue, promos and refunds">
                    <LineChart
                      currency
                      categories={cats}
                      series={[
                        { name: "Revenue", data: d.series.map((s) => s.revenue) },
                        { name: "Net", data: d.series.map((s) => s.net) },
                        { name: "Refunds", data: d.series.map((s) => s.refund) },
                        { name: "Promo", data: d.series.map((s) => s.promo) },
                      ]}
                    />
                  </Card>
                </div>
                <div className="col-xl-4">
                  <Card title="Ledger by type">
                    <BarChart horizontal distributed currency height={300} categories={d.ledgerByType.map((l) => titleCase(l.type))} series={[{ name: "Amount", data: d.ledgerByType.map((l) => l.amount) }]} />
                  </Card>
                </div>
              </div>
              <div className="row gy-4 mt-1">
                <div className="col-xl-6">
                  <Card title="Refunds" subtitle="Platform-wide" noPadding>
                    <DataTable
                      dense
                      rowKey={(r) => `${r.chargedTo}-${r.status}`}
                      rows={d.refunds.byChargeAndStatus}
                      columns={[
                        { key: "chargedTo", title: "Charged to", render: (r) => titleCase(r.chargedTo) },
                        { key: "status", title: "Status", render: (r) => <StatusBadge status={r.status} /> },
                        { key: "n", title: "Count", align: "right" },
                        { key: "amount", title: "Amount", align: "right", render: (r) => money(r.amount) },
                      ]}
                      footer={<div className="px-16 py-8 text-sm text-secondary-light">Pending approval: {num(d.refunds.pendingApproval.n)} ({money(d.refunds.pendingApproval.amount)})</div>}
                    />
                  </Card>
                </div>
                <div className="col-xl-6">
                  <Card title="Recent payout batches" noPadding>
                    <DataTable
                      dense
                      rows={d.payoutBatches.recent}
                      columns={[
                        { key: "periodStart", title: "Period", render: (r) => `${fmtDate(r.periodStart)} - ${fmtDate(r.periodEnd)}` },
                        { key: "status", title: "Status", render: (r) => <StatusBadge status={r.status} /> },
                        { key: "restaurantCount", title: "Restaurants", align: "right" },
                        { key: "driverCount", title: "Drivers", align: "right" },
                        { key: "total", title: "Total", align: "right", render: (r) => money(r.total) },
                      ]}
                    />
                  </Card>
                </div>
              </div>
              <div className="row gy-4 mt-1">
                <div className="col-xl-6">
                  <Card title="Payouts by status" noPadding>
                    <DataTable
                      dense
                      rowKey={(r) => `${r.status}-${r.partyType}`}
                      rows={d.payouts.byStatus}
                      columns={[
                        { key: "status", title: "Status", render: (r) => <StatusBadge status={r.status} /> },
                        { key: "partyType", title: "Party", render: (r) => titleCase(r.partyType) },
                        { key: "n", title: "Count", align: "right" },
                        { key: "net", title: "Net", align: "right", render: (r) => money(r.net) },
                      ]}
                    />
                  </Card>
                </div>
                <div className="col-xl-6">
                  <Card title="Invoices">
                    <div className="row text-center">
                      <div className="col-4"><div className="text-secondary-light text-sm">Count</div><h5>{num(d.invoices.count)}</h5></div>
                      <div className="col-4"><div className="text-secondary-light text-sm">Total</div><h5>{money(d.invoices.total)}</h5></div>
                      <div className="col-4"><div className="text-secondary-light text-sm">HST</div><h5>{money(d.invoices.hst)}</h5></div>
                    </div>
                  </Card>
                </div>
              </div>
              <div className="mt-16">
                <SectionNote>Ledger, refund, payout and invoice sections are platform-wide; only the KPI cards honour the city filter.</SectionNote>
              </div>
            </>
          );
        }}
      </Async>
    </>
  );
}
