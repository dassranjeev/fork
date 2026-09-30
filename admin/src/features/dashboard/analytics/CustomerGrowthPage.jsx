import React from "react";
import { BarChart, Card, DataTable, LineChart, PageHeader, Progress, StatCard } from "../../../ui";
import { useFetch } from "../../../lib/hooks";
import { money, num, pct } from "../../../lib/format";
import { Async, RangeBar, bucketLabel, useRangeState } from "../shared";

export default function CustomerGrowthPage() {
  const [f, set] = useRangeState();
  const res = useFetch("/admin/analytics/customer-growth", f);
  return (
    <>
      <PageHeader title="Customer Growth" subtitle="Acquisition, retention and funnel" crumbs={[{ label: "Analytics" }, { label: "Customer growth" }]} />
      <RangeBar state={f} onChange={set} exportKey="customer_growth" />
      <Async state={res}>
        {(d) => {
          const k = d.kpis;
          const cats = d.series.map((s) => bucketLabel(s.bucket));
          const cards = [
            ["Active customers", num(k.activeCustomers), "solar:users-group-rounded-outline", "primary"],
            ["New customers", num(k.newCustomers), "solar:user-plus-outline", "success"],
            ["Returning", num(k.returningCustomers), "solar:user-check-outline", "info"],
            ["New share", pct(k.newSharePct), "solar:pie-chart-outline", "purple"],
            ["30d repeat rate", pct(k.repeatRate30dMaturedCohortPct ?? k.repeatRate30dTrailingPct), "solar:repeat-outline", "warning"],
            ["Orders / customer", num(k.ordersPerActiveCustomer, 2), "solar:box-outline", "primary"],
          ];
          const maxWeeks = Math.max(0, ...d.retentionCohorts.map((c) => c.retention.length));
          return (
            <>
              <div className="row gy-4">
                {cards.map(([l, v, i, t]) => (
                  <div className="col-xl-2 col-md-4 col-6" key={l}>
                    <StatCard label={l} value={v} icon={i} tone={t} />
                  </div>
                ))}
              </div>
              <div className="row gy-4 mt-1">
                <div className="col-xl-8">
                  <Card title="Customers over time">
                    <LineChart
                      categories={cats}
                      series={[
                        { name: "Active", data: d.series.map((s) => s.activeCustomers) },
                        { name: "New", data: d.series.map((s) => s.newCustomers) },
                        { name: "Returning", data: d.series.map((s) => s.returningCustomers) },
                      ]}
                    />
                  </Card>
                </div>
                <div className="col-xl-4">
                  <Card title="Funnels">
                    <h6 className="text-sm text-secondary-light">Sign-up</h6>
                    {d.funnel.signupFunnel.map((s) => (
                      <div className="mb-12" key={s.step}>
                        <Progress value={s.pctOfPrevious} label={`${s.step} (${num(s.count)})`} />
                      </div>
                    ))}
                    <h6 className="text-sm text-secondary-light mt-16">Checkout</h6>
                    {d.funnel.checkoutFunnel.map((s) => (
                      <div className="mb-12" key={s.step}>
                        <Progress value={s.pctOfPrevious} tone="success" label={`${s.step} (${num(s.count)})`} />
                      </div>
                    ))}
                  </Card>
                </div>
              </div>
              <div className="row gy-4 mt-1">
                <div className="col-xl-6">
                  <Card title="Order frequency" subtitle={`${num(d.orderFrequency.avgOrders, 2)} orders per active customer`}>
                    <BarChart height={260} categories={d.orderFrequency.distribution.map((x) => x.orders)} series={[{ name: "Customers", data: d.orderFrequency.distribution.map((x) => x.customers) }]} />
                  </Card>
                </div>
                <div className="col-xl-6">
                  <Card title="Top cuisines" noPadding>
                    <DataTable
                      dense
                      rowKey="cuisineId"
                      rows={d.topCuisines.slice(0, 8)}
                      columns={[
                        { key: "name", title: "Cuisine" },
                        { key: "orders", title: "Orders", align: "right" },
                        { key: "customers", title: "Customers", align: "right" },
                        { key: "gmv", title: "GMV", align: "right", render: (r) => money(r.gmv) },
                      ]}
                    />
                  </Card>
                </div>
              </div>
              <Card title="Weekly retention cohorts" subtitle="Share of each signup-week cohort ordering again" className="mt-24">
                {d.retentionCohorts.length === 0 ? (
                  <p className="text-secondary-light mb-0">No cohorts in this range.</p>
                ) : (
                  <div className="table-responsive">
                    <table className="table bordered-table sm-table mb-0 text-center">
                      <thead>
                        <tr>
                          <th className="text-start">Cohort week</th>
                          <th>Size</th>
                          {Array.from({ length: maxWeeks }, (_, i) => (
                            <th key={i}>W{i}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {d.retentionCohorts.map((c) => (
                          <tr key={c.cohortWeek}>
                            <td className="text-start">{c.cohortWeek}</td>
                            <td>{c.size}</td>
                            {Array.from({ length: maxWeeks }, (_, i) => {
                              const r = c.retention[i];
                              return (
                                <td key={i} style={r ? { background: `rgba(249,90,22,${Math.min(0.85, r.pct / 100)})`, color: r.pct > 55 ? "#fff" : undefined } : undefined}>
                                  {r ? `${Math.round(r.pct)}%` : ""}
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
              <div className="row gy-4 mt-1">
                <div className="col-md-6">
                  <Card title="Referrals">
                    <div className="row text-center gy-3">
                      {[["Total", d.referrals.total], ["Rewarded", d.referrals.rewarded], ["Pending", d.referrals.pending], ["Rewards paid", money(d.referrals.rewardsPaid)]].map(([l, v]) => (
                        <div className="col-6 col-md-3" key={l}><div className="text-secondary-light text-sm">{l}</div><div className="fw-semibold">{v}</div></div>
                      ))}
                    </div>
                  </Card>
                </div>
                <div className="col-md-6">
                  <Card title="Promo ROI">
                    <div className="row text-center gy-3">
                      {[["Redemptions", d.promoRoi.totals.redemptions], ["Discount cost", money(d.promoRoi.totals.discountCost)], ["Promo GMV", money(d.promoRoi.totals.gmv)], ["ROI", pct(d.promoRoi.totals.roiPct)]].map(([l, v]) => (
                        <div className="col-6 col-md-3" key={l}><div className="text-secondary-light text-sm">{l}</div><div className="fw-semibold">{v}</div></div>
                      ))}
                    </div>
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
