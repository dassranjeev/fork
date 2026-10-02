import React, { useState } from "react";
import { BarChart, Card, DonutChart, EmptyState, ErrorState, Loading, PageHeader, Segmented, StatCard } from "../../ui";
import { useFetch } from "../../lib/hooks";
import { money, num, pct, titleCase } from "../../lib/format";
import { tierLabel } from "./shared";

const RANGES = [{ value: 7, label: "7 days" }, { value: 30, label: "30 days" }, { value: 90, label: "90 days" }];
const mins = (v) => (v == null ? "-" : v >= 120 ? `${(v / 60).toFixed(1)} h` : `${v} min`);

export default function Kpis() {
  const [days, setDays] = useState(30);
  const from = new Date(Date.now() - days * 86400000).toISOString();
  const { data, loading, error, reload } = useFetch("/admin/support/kpis", { from });

  const header = <PageHeader title="Support KPIs" subtitle="Ticket volume, responsiveness and refund spend" crumbs={[{ label: "Support" }, { label: "KPIs" }]} actions={<Segmented options={RANGES} value={days} onChange={setDays} />} />;
  if (loading && !data) return (<>{header}<Loading minHeight={300} /></>);
  if (error && !data) return (<>{header}<ErrorState error={error} onRetry={reload} /></>);
  if (!data) return null;

  const t = data.tickets;
  const entries = (o, label = titleCase) => Object.entries(o || {}).map(([k, v]) => ({ k: label(k), v }));
  const cat = entries(t.byCategory);
  const status = entries(t.byStatus);
  const tier = entries(t.byTier, tierLabel);
  const source = entries(t.bySource);
  const refundTotal = (data.refunds || []).reduce((s, r) => s + r.total, 0);

  return (
    <>
      {header}
      <div className="row gy-3 mb-24">
        <div className="col-6 col-xl-3"><StatCard label="Tickets" value={num(t.total)} icon="solar:ticket-outline" tone="primary" /></div>
        <div className="col-6 col-xl-3"><StatCard label="SLA breach rate" value={pct(t.slaBreachRate)} hint={`${t.slaBreached} breached`} icon="solar:alarm-outline" tone={t.slaBreachRate > 10 ? "danger" : "success"} /></div>
        <div className="col-6 col-xl-3"><StatCard label="Avg first response" value={mins(data.avgFirstResponseMinutes)} icon="solar:chat-round-dots-outline" tone="info" /></div>
        <div className="col-6 col-xl-3"><StatCard label="Avg resolution" value={mins(data.avgResolutionMinutes)} icon="solar:check-circle-outline" tone="purple" /></div>
        <div className="col-6 col-xl-3"><StatCard label="CSAT" value={data.csat.average != null ? `${data.csat.average} / 5` : "-"} hint={`${data.csat.count} ratings`} icon="solar:star-outline" tone="warning" /></div>
        <div className="col-6 col-xl-3"><StatCard label="Refunds issued" value={money(refundTotal)} hint={`${(data.refunds || []).reduce((s, r) => s + r.count, 0)} refunds`} icon="solar:wallet-money-outline" tone="danger" /></div>
        <div className="col-6 col-xl-3"><StatCard label="Open review cases" value={num(data.reviewCases.open)} icon="solar:shield-warning-outline" tone="warning" to="/support/cases" /></div>
        <div className="col-6 col-xl-3"><StatCard label="Decided cases" value={num(Object.values(data.reviewCases.decided || {}).reduce((a, b) => a + b, 0))} icon="solar:scale-outline" tone="neutral" /></div>
      </div>
      {t.total === 0 ? (
        <Card><EmptyState icon="solar:chart-2-outline" title="No tickets in this period" text="Charts appear once tickets are created in the selected range." /></Card>
      ) : (
        <div className="row gy-4">
          <div className="col-lg-6"><Card title="By category"><BarChart horizontal distributed series={[{ name: "Tickets", data: cat.map((x) => x.v) }]} categories={cat.map((x) => x.k)} height={320} /></Card></div>
          <div className="col-lg-6"><Card title="By status"><DonutChart labels={status.map((x) => x.k)} values={status.map((x) => x.v)} /></Card></div>
          <div className="col-lg-6"><Card title="By tier"><DonutChart labels={tier.map((x) => x.k)} values={tier.map((x) => x.v)} /></Card></div>
          <div className="col-lg-6"><Card title="By source"><DonutChart labels={source.map((x) => x.k)} values={source.map((x) => x.v)} /></Card></div>
        </div>
      )}
      {(data.refunds || []).length > 0 && (
        <Card title="Refunds by payer" className="mt-24">
          <div className="row gy-3">
            {data.refunds.map((r) => <div key={r.chargedTo} className="col-md-4"><StatCard label={`Charged to ${titleCase(r.chargedTo)}`} value={money(r.total)} hint={`${r.count} refunds`} icon="solar:wallet-outline" tone="primary" /></div>)}
          </div>
        </Card>
      )}
    </>
  );
}
