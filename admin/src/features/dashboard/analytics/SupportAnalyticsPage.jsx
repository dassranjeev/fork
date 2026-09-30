import React from "react";
import { BarChart, Card, DonutChart, EmptyState, LineChart, PageHeader, StatCard } from "../../../ui";
import { useFetch } from "../../../lib/hooks";
import { num, pct, titleCase } from "../../../lib/format";
import { Async, RangeBar, bucketLabel, kpiProps, useRangeState } from "../shared";

const labelOf = (r) => titleCase(r.category || r.tier || r.priority || r.name || r.key || "Other");
const countOf = (r) => Number(r.count ?? r.n ?? r.total ?? 0);

export default function SupportAnalyticsPage() {
  const [f, set] = useRangeState();
  const res = useFetch("/admin/analytics/support", f);
  return (
    <>
      <PageHeader title="Support Analytics" subtitle="Ticket volume, SLA and satisfaction" crumbs={[{ label: "Analytics" }, { label: "Support" }]} />
      <RangeBar state={f} onChange={set} exportKey="support" />
      <Async state={res}>
        {(d) => {
          const k = d.kpis;
          const cards = [
            ["Tickets created", k.created, num, "solar:chat-round-dots-outline", "primary"],
            ["Open", k.open, num, "solar:inbox-outline", "warning"],
            ["Resolved", k.resolved, num, "solar:check-circle-outline", "success"],
            ["SLA breach", k.slaBreachPct, pct, "solar:danger-triangle-outline", "danger", true],
            ["Auto-resolved", k.autoResolvedPct, pct, "solar:magic-stick-3-outline", "purple"],
            ["First response (min)", k.avgFirstResponseMin, (v) => num(v, 1), "solar:clock-circle-outline", "info", true],
            ["Resolution (hours)", k.avgResolutionHours, (v) => num(v, 1), "solar:hourglass-outline", "info", true],
            ["Avg. CSAT", k.avgCsat, (v) => num(v, 2), "solar:star-outline", "warning"],
          ];
          const sections = [
            ["By category", d.byCategory],
            ["By tier", d.byTier],
            ["Open by priority", d.openByPriority],
          ];
          return (
            <>
              <div className="row gy-4">
                {cards.map(([l, kp, fmt, i, t, inv]) => (
                  <div className="col-xl-3 col-md-4 col-6" key={l}>
                    <StatCard label={l} icon={i} tone={t} invertDelta={inv} {...kpiProps(kp, fmt)} />
                  </div>
                ))}
              </div>
              <Card title="Tickets created vs resolved" className="mt-24">
                <LineChart categories={d.series.map((s) => bucketLabel(s.bucket))} series={[{ name: "Created", data: d.series.map((s) => s.created) }, { name: "Resolved", data: d.series.map((s) => s.resolved) }]} />
              </Card>
              <div className="row gy-4 mt-1">
                {sections.map(([title, rows], idx) => (
                  <div className="col-lg-4" key={title}>
                    <Card title={title}>
                      {rows && rows.length ? (
                        idx === 0 ? (
                          <DonutChart labels={rows.map(labelOf)} values={rows.map(countOf)} height={260} />
                        ) : (
                          <BarChart height={260} categories={rows.map(labelOf)} series={[{ name: "Tickets", data: rows.map(countOf) }]} />
                        )
                      ) : (
                        <EmptyState icon="solar:chat-round-dots-outline" title="No tickets in this range" />
                      )}
                    </Card>
                  </div>
                ))}
              </div>
            </>
          );
        }}
      </Async>
    </>
  );
}
