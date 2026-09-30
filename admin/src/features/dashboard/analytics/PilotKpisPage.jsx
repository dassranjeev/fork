import React from "react";
import { Badge, Card, PageHeader, Progress } from "../../../ui";
import { useFetch } from "../../../lib/hooks";
import { num } from "../../../lib/format";
import { Async, RangeBar, SectionNote, presetRange } from "../shared";
import { useState } from "react";

const fmtVal = (v, unit) => (v === null || v === undefined ? "—" : unit === "$" ? `$${num(v, 2)}` : unit === "%" ? `${num(v, 1)}%` : `${num(v, 1)} ${unit}`);

export default function PilotKpisPage() {
  const [f, setF] = useState({ ...presetRange(28), cityId: "" });
  const set = (p) => setF((s) => ({ ...s, ...p }));
  const res = useFetch("/admin/analytics/pilot-exit-kpis", f);
  return (
    <>
      <PageHeader title="Pilot Exit KPIs" subtitle="Gate 3 - every KPI must hold for four straight weeks" crumbs={[{ label: "Analytics" }, { label: "Pilot exit KPIs" }]} />
      <RangeBar state={f} onChange={set} groupBy={false} exportKey="pilot_exit_kpis" />
      <Async state={res}>
        {(d) => (
          <>
            <div className={`alert ${d.allPass ? "alert-success" : "alert-warning"} radius-8 d-flex align-items-center gap-2`}>
              <strong>{d.allPass ? "All KPIs passing in this window." : `${d.kpis.filter((k) => !k.pass).length} of ${d.kpis.length} KPIs not yet passing.`}</strong>
              <span className="text-sm">Based on {num(d.sampleSizes?.orders)} orders ({num(d.sampleSizes?.completedOrders)} completed).</span>
            </div>
            <div className="row gy-4">
              {d.kpis.map((k) => {
                const pctBar = k.unit === "%" ? k.value : undefined;
                return (
                  <div className="col-xl-4 col-md-6" key={k.key}>
                    <div className={`card radius-12 shadow-sm h-100 border ${k.pass ? "border-success-main" : "border-danger-main"}`}>
                      <div className="card-body p-20">
                        <div className="d-flex justify-content-between gap-2 mb-8">
                          <span className="fw-medium text-primary-light">{k.label}</span>
                          <Badge tone={k.pass ? "success" : "danger"}>{k.pass ? "Pass" : "Fail"}</Badge>
                        </div>
                        <h4 className="mb-4">{fmtVal(k.value, k.unit)}</h4>
                        <div className="text-secondary-light text-sm mb-12">
                          Target {k.targetOp} {fmtVal(k.target, k.unit)}
                        </div>
                        {pctBar !== undefined && <Progress value={pctBar} tone={k.pass ? "success" : "danger"} height={6} />}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            <Card className="mt-24">
              <SectionNote>{d.note}</SectionNote>
            </Card>
          </>
        )}
      </Async>
    </>
  );
}
