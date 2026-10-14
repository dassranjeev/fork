import React, { useState } from "react";
import { BarChart, Card, DataTable, DateInput, ErrorState, Loading, PageHeader, StatCard } from "../../ui";
import { useFetch } from "../../lib/hooks";
import { money } from "../../lib/format";

export default function Hst() {
  const [range, setRange] = useState({ from: "", to: "" });
  const { data, loading, error, reload } = useFetch("/admin/finance/reports/hst", { from: range.from || undefined, to: range.to || undefined });
  const cust = data?.customerHstByMonth || [];
  const forky = data?.forksyHstByMonth || [];
  const byClass = data?.customerHstByTaxClass || [];
  const sum = (a, k) => a.reduce((t, r) => t + Number(r[k] || 0), 0);
  return (
    <>
      <PageHeader title="HST reports" subtitle="Tax collected from customers and HST on Forky's own fees" crumbs={[{ label: "Finance", to: "/finance" }, { label: "HST reports" }]} />
      <Card className="mb-24">
        <div className="row g-3 align-items-end">
          <div className="col-md-3"><DateInput label="From" className="mb-0" value={range.from} onChange={(v) => setRange((r) => ({ ...r, from: v || "" }))} /></div>
          <div className="col-md-3"><DateInput label="To" className="mb-0" value={range.to} onChange={(v) => setRange((r) => ({ ...r, to: v || "" }))} /></div>
          <div className="col-md-6 text-secondary-light text-sm">Leave empty for the full history.</div>
        </div>
      </Card>
      {error && <ErrorState error={error} onRetry={reload} />}
      {loading && !data ? (
        <Loading />
      ) : (
        <>
          <div className="row gy-3 mb-24">
            <div className="col-md-4"><StatCard label="Customer tax collected" value={money(sum(cust, "tax"))} icon="solar:bill-list-outline" tone="primary" /></div>
            <div className="col-md-4"><StatCard label="Taxable subtotal" value={money(sum(cust, "subtotal"))} icon="solar:cart-large-2-outline" tone="info" /></div>
            <div className="col-md-4"><StatCard label="HST on Forky fees" value={money(sum(forky, "hst"))} icon="solar:buildings-2-outline" tone="success" /></div>
          </div>
          <div className="row gy-4">
            <div className="col-lg-7">
              <Card title="Customer HST by month">
                {cust.length ? <BarChart height={280} currency categories={cust.map((r) => r.month)} series={[{ name: "Tax collected", data: cust.map((r) => Number(r.tax)) }]} /> : <div className="text-secondary-light text-center py-40">No tax collected in this period.</div>}
              </Card>
            </div>
            <div className="col-lg-5">
              <Card title="By tax class" noPadding bodyClassName="p-0">
                <DataTable dense rowKey="taxClass" rows={byClass} emptyTitle="No data" columns={[{ key: "taxClass", title: "Tax class" }, { key: "base", title: "Base", align: "right", render: (r) => money(r.base) }, { key: "tax", title: "Tax", align: "right", render: (r) => <strong>{money(r.tax)}</strong> }]} />
              </Card>
            </div>
            <div className="col-lg-7">
              <Card title="Customer HST detail" noPadding bodyClassName="p-0">
                <DataTable dense rowKey="month" rows={cust} emptyTitle="No data" columns={[{ key: "month", title: "Month" }, { key: "subtotal", title: "Subtotal", align: "right", render: (r) => money(r.subtotal) }, { key: "tax", title: "Tax", align: "right", render: (r) => <strong>{money(r.tax)}</strong> }]} />
              </Card>
            </div>
            <div className="col-lg-5">
              <Card title="Forky HST payable" noPadding bodyClassName="p-0">
                <DataTable dense rowKey="month" rows={forky} emptyTitle="No data" columns={[{ key: "month", title: "Month" }, { key: "base", title: "Fee base", align: "right", render: (r) => money(r.base) }, { key: "hst", title: "HST", align: "right", render: (r) => <strong>{money(r.hst)}</strong> }]} />
              </Card>
            </div>
          </div>
        </>
      )}
    </>
  );
}
