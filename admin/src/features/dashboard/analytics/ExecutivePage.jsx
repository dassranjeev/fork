import React from "react";
import { BarChart, Card, DataTable, LineChart, PageHeader, StatCard } from "../../../ui";
import { useFetch } from "../../../lib/hooks";
import { money, num, pct, titleCase } from "../../../lib/format";
import { Async, RangeBar, SectionNote, bucketLabel, kpiProps, useRangeState } from "../shared";

export default function ExecutivePage() {
  const [f, set] = useRangeState();
  const res = useFetch("/admin/analytics/executive", f);
  return (
    <>
      <PageHeader title="Executive Overview" subtitle="Marketplace growth, revenue and unit economics" crumbs={[{ label: "Analytics" }, { label: "Executive" }]} />
      <RangeBar state={f} onChange={set} exportKey="executive" />
      <Async state={res}>
        {(d) => {
          const k = d.kpis;
          const cats = d.series.map((s) => bucketLabel(s.bucket));
          const cur = d.economics.current;
          const spend = Object.entries(d.marketingSpend.current).filter(([x]) => x !== "total");
          const cards = [
            ["GMV", k.gmv, money, "solar:wallet-money-outline", "success"],
            ["Net revenue", k.netRevenue, money, "solar:dollar-minimalistic-outline", "primary"],
            ["Orders", k.orders, num, "solar:box-outline", "info"],
            ["Avg. order value", k.aov, money, "solar:cart-large-2-outline", "purple"],
            ["Take rate", k.takeRatePct, pct, "solar:tag-price-outline", "warning"],
            ["Margin / order", k.marginPerOrder, money, "solar:graph-up-outline", "success"],
            ["Contribution margin", k.contributionMargin, money, "solar:chart-outline", "primary"],
            ["Active customers", k.activeCustomers, num, "solar:users-group-rounded-outline", "info"],
            ["New customers", k.newCustomers, num, "solar:user-plus-outline", "purple"],
            ["CAC", k.cac, money, "solar:target-outline", "warning"],
            ["LTV", k.ltv, money, "solar:star-outline", "success"],
            ["Cancellation rate", k.cancellationRatePct, pct, "solar:close-circle-outline", "danger", true],
          ];
          return (
            <>
              <div className="row gy-4">
                {cards.map(([label, kp, fmt, icon, tone, inv]) => (
                  <div className="col-xxl-2 col-xl-3 col-md-4 col-sm-6" key={label}>
                    <StatCard label={label} icon={icon} tone={tone} invertDelta={inv} {...kpiProps(kp, fmt)} />
                  </div>
                ))}
              </div>
              <div className="row gy-4 mt-1">
                <div className="col-xl-8">
                  <Card title="GMV, net revenue and margin">
                    <LineChart
                      currency
                      categories={cats}
                      series={[
                        { name: "GMV", data: d.series.map((s) => s.gmv) },
                        { name: "Net revenue", data: d.series.map((s) => s.netRevenue) },
                        { name: "Margin", data: d.series.map((s) => s.margin) },
                      ]}
                    />
                  </Card>
                </div>
                <div className="col-xl-4">
                  <Card title="Unit economics (period)">
                    <table className="table mb-0 text-sm">
                      <tbody>
                        {[
                          ["GMV", cur.gmv],
                          ["Gross revenue", cur.revenueGross],
                          ["Promo cost", -cur.promoCost],
                          ["Net revenue", cur.netRevenue],
                          ["Driver cost", -cur.driverCost],
                          ["Processing", -cur.processingCost],
                          ["Platform refunds", -cur.platformRefunds],
                          ["Margin", cur.margin],
                          ["Tax collected", cur.tax],
                          ["Tips", cur.tip],
                        ].map(([l, v]) => (
                          <tr key={l}>
                            <td className="text-secondary-light">{l}</td>
                            <td className="text-end fw-medium">{money(v)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </Card>
                </div>
              </div>
              <div className="row gy-4 mt-1">
                <div className="col-xl-6">
                  <Card title="Orders per period">
                    <BarChart categories={cats} series={[{ name: "Orders", data: d.series.map((s) => s.orders) }, { name: "Completed", data: d.series.map((s) => s.completed) }]} />
                  </Card>
                </div>
                <div className="col-xl-6">
                  <Card title="Marketing spend" subtitle="Current period">
                    <BarChart horizontal distributed currency height={220} categories={spend.map(([x]) => titleCase(x.replace(/([A-Z])/g, " $1")))} series={[{ name: "Spend", data: spend.map(([, v]) => v) }]} />
                    <div className="text-end fw-semibold">
                      Total {money(d.marketingSpend.current.total)} <span className="text-secondary-light fw-normal text-sm">(prev. {money(d.marketingSpend.previous.total)})</span>
                    </div>
                  </Card>
                </div>
              </div>
              <Card title="By city" className="mt-24" noPadding>
                <DataTable
                  dense
                  rowKey="cityId"
                  rows={d.byCity}
                  columns={[
                    { key: "name", title: "City" },
                    { key: "orders", title: "Orders", align: "right" },
                    { key: "completed", title: "Completed", align: "right" },
                    { key: "gmv", title: "GMV", align: "right", render: (r) => money(r.gmv) },
                    { key: "netRevenue", title: "Net revenue", align: "right", render: (r) => money(r.netRevenue) },
                  ]}
                />
              </Card>
              <div className="mt-16">
                <SectionNote>{d.economics.definition}</SectionNote>
              </div>
            </>
          );
        }}
      </Async>
    </>
  );
}
