import React, { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Button, Card, DataTable, DateInput, ErrorState, FilterSelect, FormModal, KeyValue, ListToolbar, Loading, Modal, PageHeader, StatusBadge, TextArea } from "../../ui";
import { act, http } from "../../lib/api";
import { useFetch, useForm, usePagedList, useSubmit } from "../../lib/hooks";
import { useAuth } from "../../lib/auth";
import { money } from "../../lib/format";
import { fmtDay as fmtDate } from "./common";
import { downloadText } from "./common";

function VoidModal({ invoice, onClose, onDone }) {
  const f = useForm({ reason: "" });
  const { busy, run } = useSubmit();
  return (
    <FormModal open onClose={onClose} title={`Void ${invoice.number}`} submitText="Void invoice" submitVariant="danger" busy={busy} disabled={f.values.reason.trim().length < 3} onSubmit={() => run(() => http.post(`/admin/finance/invoices/${invoice.id}/void`, { reason: f.values.reason }), { success: "Invoice voided", onDone })}>
      <TextArea label="Reason" required {...f.bind("reason")} />
    </FormModal>
  );
}

function InvoiceDetail({ id, onClose, onChanged }) {
  const { can } = useAuth();
  const { data: i, loading, error, reload } = useFetch(`/admin/finance/invoices/${id}`);
  const [voiding, setVoiding] = useState(false);
  const download = async (format) => {
    const r = await act(() => http.get(`/admin/finance/invoices/${id}/download`, { format }));
    if (r?.body) downloadText(r.filename, r.body, r.type || "text/plain");
  };
  return (
    <>
      <Modal
        open
        onClose={onClose}
        size="lg"
        title={i ? `Invoice ${i.number}` : "Invoice"}
        footer={
          i && (
            <>
              {can("finance", "export") && (
                <>
                  <Button variant="light" onClick={() => download("html")}>Download HTML</Button>
                  <Button variant="light" onClick={() => download("csv")}>Download CSV</Button>
                </>
              )}
              {can("finance", "edit") && i.status !== "VOID" && <Button variant="outline-danger" onClick={() => setVoiding(true)}>Void</Button>}
            </>
          )
        }
      >
        {loading && <Loading />}
        {error && <ErrorState error={error} onRetry={reload} />}
        {i && (
          <>
            <KeyValue
              cols={3}
              items={[
                { label: "Status", value: <StatusBadge status={i.status} /> },
                { label: "Merchant", value: i.merchant?.businessName },
                { label: "Merchant HST #", value: i.merchant?.hstNumber },
                { label: "Issuer", value: i.issuer?.name },
                { label: "Issuer HST #", value: i.issuer?.hstNumber },
                { label: "Period", value: i.period },
                { label: "Commission", value: money(i.commissionAmount) },
                { label: `HST (${i.hstRatePct ?? "—"}%)`, value: money(i.hstAmount) },
                { label: "Total", value: <strong>{money(i.total)}</strong> },
              ]}
            />
            {i.voidReason && <div className="alert alert-secondary radius-8 mt-16">Voided: {i.voidReason}</div>}
            <h6 className="mt-24 mb-12">Order lines</h6>
            <DataTable
              dense
              rowKey="orderId"
              rows={i.lines || []}
              emptyTitle="No lines"
              columns={[
                { key: "code", title: "Order" },
                { key: "subtotal", title: "Food subtotal", align: "right", render: (l) => money(l.subtotal) },
                { key: "commission", title: "Commission", align: "right", render: (l) => money(l.commission) },
              ]}
            />
          </>
        )}
      </Modal>
      {voiding && <VoidModal invoice={i} onClose={() => setVoiding(false)} onDone={() => { setVoiding(false); reload(); onChanged(); }} />}
    </>
  );
}

export default function Invoices() {
  const [sp, setSp] = useSearchParams();
  const list = usePagedList("/admin/finance/invoices", { filters: { status: "", from: "", to: "" } });
  const open = sp.get("open");
  const cols = [
    { key: "number", title: "Invoice", render: (i) => <span className="fw-semibold text-primary-600">{i.number}</span> },
    { key: "merchantName", title: "Merchant" },
    { key: "period", title: "Period", render: (i) => `${fmtDate(i.periodStart)} – ${fmtDate(i.periodEnd)}` },
    { key: "commissionAmount", title: "Commission", align: "right", render: (i) => money(i.commissionAmount) },
    { key: "hstAmount", title: "HST", align: "right", render: (i) => money(i.hstAmount) },
    { key: "total", title: "Total", align: "right", render: (i) => <strong>{money(i.total)}</strong> },
    { key: "status", title: "Status", render: (i) => <StatusBadge status={i.status} /> },
  ];
  return (
    <>
      <PageHeader title="Commission invoices" subtitle="Forky invoices issued to restaurants with each weekly payout" crumbs={[{ label: "Finance", to: "/finance" }, { label: "Invoices" }]} />
      <Card>
        <ListToolbar
          list={list}
          placeholder="Search number or merchant…"
          filters={
            <>
              <FilterSelect value={list.filters.status} onChange={(v) => list.setFilter("status", v)} options={["DRAFT", "ISSUED", "PAID", "VOID"]} placeholder="All statuses" />
              <div style={{ width: 150 }}><DateInput className="mb-0" value={list.filters.from} onChange={(v) => list.setFilter("from", v || "")} /></div>
              <div style={{ width: 150 }}><DateInput className="mb-0" value={list.filters.to} onChange={(v) => list.setFilter("to", v || "")} /></div>
            </>
          }
        />
        <DataTable columns={cols} {...list.tableProps} error={list.error} onRetry={list.reload} onRowClick={(i) => setSp({ open: i.id })} emptyTitle="No invoices" emptyText="Invoices are generated with payout batches." />
      </Card>
      {open && <InvoiceDetail id={open} onClose={() => setSp({})} onChanged={list.reload} />}
    </>
  );
}
