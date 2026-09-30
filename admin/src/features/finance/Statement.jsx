import React from "react";
import { useParams } from "react-router-dom";
import { Button, Card, DataTable, ErrorState, KeyValue, Loading, PageHeader, StatusBadge } from "../../ui";
import { act, http } from "../../lib/api";
import { useFetch } from "../../lib/hooks";
import { useAuth } from "../../lib/auth";
import { money, titleCase } from "../../lib/format";
import { fmtDay as fmtDate } from "./common";
import { PartyBadge, Signed, downloadText } from "./common";

export default function Statement() {
  const { payoutId } = useParams();
  const { can } = useAuth();
  const { data: s, loading, error, reload } = useFetch(`/admin/finance/statements/${payoutId}`);
  if (loading && !s) return <Loading />;
  if (error && !s) return (<><PageHeader title="Statement" back="/finance/statements" /><ErrorState error={error} onRetry={reload} /></>);
  if (!s) return null;
  const csv = async () => {
    const r = await act(() => http.get(`/admin/finance/statements/${payoutId}/csv`));
    if (r?.csv) downloadText(r.filename || "statement.csv", r.csv);
  };
  const cols = [
    { key: "orderCode", title: "Order", render: (l) => <span className="fw-semibold">{l.orderCode}</span> },
    { key: "date", title: "Date", render: (l) => fmtDate(l.date) },
    ...(s.columns || []).map((c) => ({ key: c.key, title: c.label, align: "right", render: (l) => <Signed value={l.amounts?.[c.key] || 0} fmt={money} /> })),
    { key: "net", title: "Net", align: "right", render: (l) => <strong>{money(l.net)}</strong> },
  ];
  const sum = s.summary || {};
  return (
    <>
      <PageHeader
        title={`Statement - ${s.party?.name}`}
        subtitle={s.period?.label}
        back="/finance/statements"
        crumbs={[{ label: "Finance", to: "/finance" }, { label: "Statements", to: "/finance/statements" }, { label: "Detail" }]}
        actions={can("finance", "export") && <Button variant="light" icon="solar:download-minimalistic-outline" onClick={csv}>Download CSV</Button>}
      />
      <Card className="mb-24">
        <KeyValue
          cols={4}
          items={[
            { label: "Party", value: <PartyBadge type={s.party?.type} /> },
            { label: "Status", value: <StatusBadge status={s.payout?.status} /> },
            { label: "Orders", value: sum.orderCount },
            { label: "Gross", value: money(sum.gross) },
            { label: "Deductions", value: money(sum.deductions) },
            { label: "Instant fee", value: money(sum.instantFee) },
            { label: "Net payout", value: <strong>{money(sum.net)}</strong> },
            { label: "Invoice", value: s.invoice?.number },
          ]}
        />
        {sum.byType && (
          <div className="d-flex flex-wrap gap-2 mt-16">
            {Object.entries(sum.byType).map(([k, v]) => <span key={k} className="badge bg-neutral-200 text-secondary-light px-12 py-6">{titleCase(k)}: {money(v)}</span>)}
          </div>
        )}
      </Card>
      <Card title="Order lines" noPadding bodyClassName="p-0">
        <DataTable columns={cols} rows={s.lines || []} rowKey="orderId" emptyTitle="No lines" emptyText="This statement has no order activity." />
      </Card>
    </>
  );
}
