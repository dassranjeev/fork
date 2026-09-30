import React, { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Button, Card, ErrorState, KeyValue, Loading, PageHeader, StatusBadge, TextArea, FormModal, useConfirm } from "../../ui";
import { http } from "../../lib/api";
import { useFetch, useForm, useSubmit } from "../../lib/hooks";
import { useAuth } from "../../lib/auth";
import { fmtDateTime, money } from "../../lib/format";
import { fmtDay as fmtDate } from "./common";
import { PartyBadge, PartyPanel } from "./common";
import PayoutAdjustModal from "./PayoutAdjust";

function HoldModal({ payout, onClose, onDone }) {
  const f = useForm({ reason: "" });
  const { busy, run } = useSubmit();
  return (
    <FormModal open onClose={onClose} title="Hold payout" submitText="Place hold" submitVariant="danger" busy={busy} onSubmit={() => run(() => http.post(`/admin/finance/payouts/${payout.id}/hold`, { reason: f.values.reason || undefined }), { success: "Payout on hold", onDone })}>
      <TextArea label="Reason" {...f.bind("reason")} />
    </FormModal>
  );
}

export default function PayoutDetail() {
  const { id } = useParams();
  const { data: p, loading, error, reload } = useFetch(`/admin/finance/payouts/${id}`);
  const { can } = useAuth();
  const { busy, run } = useSubmit();
  const confirm = useConfirm();
  const [modal, setModal] = useState(null);
  if (loading && !p) return <Loading />;
  if (error && !p) return (<><PageHeader title="Payout" back="/finance/payouts" /><ErrorState error={error} onRetry={reload} /></>);
  if (!p) return null;
  const edit = can("finance", "edit");
  const adjustable = ["DRAFT", "LOCKED"].includes(p.batch?.status);
  const close = () => setModal(null);
  const done = () => { close(); reload(); };
  const retry = async () => {
    const r = await confirm({ title: "Retry payment?", message: `Attempt to pay ${money(p.net)} to ${p.partyName}.`, confirmText: "Retry" });
    if (r.confirmed) run(() => http.post(`/admin/finance/payouts/${p.id}/retry`), { success: "Payment attempted", onDone: reload });
  };
  return (
    <>
      <PageHeader
        title={`Payout - ${p.partyName}`}
        subtitle={`${fmtDate(p.periodStart)} – ${fmtDate(p.periodEnd)}`}
        back="/finance/payouts"
        crumbs={[{ label: "Finance", to: "/finance" }, { label: "Payouts", to: "/finance/payouts" }, { label: "Detail" }]}
        actions={
          <>
            <Link to={`/finance/statements/${p.id}`} className="btn btn-outline-primary-600 btn-sm radius-8 px-16 py-8">Statement</Link>
            {edit && adjustable && <Button variant="light" onClick={() => setModal("adjust")}>Adjust</Button>}
            {edit && p.status === "ON_HOLD" && <Button variant="success" loading={busy} onClick={() => run(() => http.post(`/admin/finance/payouts/${p.id}/release-hold`), { success: "Hold released", onDone: reload })}>Release hold</Button>}
            {edit && !["PAID", "ON_HOLD"].includes(p.status) && <Button variant="outline-danger" onClick={() => setModal("hold")}>Hold</Button>}
            {edit && ["FAILED", "RELEASED", "APPROVED"].includes(p.status) && <Button icon="solar:restart-outline" loading={busy} onClick={retry}>Retry payment</Button>}
          </>
        }
      />
      {p.status === "FAILED" && p.failureReason && <div className="alert alert-danger radius-8">Payment failed: {p.failureReason}</div>}
      <div className="row gy-4">
        <div className="col-lg-7">
          <Card title="Payout">
            <KeyValue
              cols={3}
              items={[
                { label: "Status", value: <StatusBadge status={p.status} /> },
                { label: "Party", value: <span><PartyBadge type={p.partyType} /> </span> },
                { label: "Batch", value: p.batch ? <Link className="text-primary-600" to={`/finance/batches/${p.batchId}`}>{fmtDate(p.batch.periodStart)} ({p.batch.status})</Link> : "—" },
                { label: "Orders", value: p.orderCount },
                { label: "Gross", value: money(p.gross) },
                { label: "Deductions", value: money(p.deductions) },
                { label: "Instant fee", value: money(p.fee) },
                { label: "Net payout", value: <strong className="fs-5">{money(p.net)}</strong> },
                { label: "Method", value: p.method },
                { label: "External ref", value: p.externalRef },
                { label: "Paid at", value: fmtDateTime(p.paidAt) },
                { label: "Statement sent", value: fmtDateTime(p.statementSentAt) },
              ]}
            />
          </Card>
          {p.invoice && (
            <Card className="mt-24" title="Commission invoice">
              <KeyValue cols={3} items={[{ label: "Number", value: <Link className="text-primary-600" to={`/finance/invoices?open=${p.invoice.id}`}>{p.invoice.number}</Link> }, { label: "Status", value: <StatusBadge status={p.invoice.status} /> }, { label: "Total", value: money(p.invoice.total) }, { label: "Commission", value: money(p.invoice.commissionAmount) }, { label: "HST", value: money(p.invoice.hstAmount) }]} />
            </Card>
          )}
        </div>
        <div className="col-lg-5">
          <Card title="Bank and payout hold">
            <PartyPanel partyType={p.partyType} partyId={p.partyId} onChanged={reload} />
          </Card>
        </div>
      </div>
      {modal === "adjust" && <PayoutAdjustModal payout={p} onClose={close} onDone={done} />}
      {modal === "hold" && <HoldModal payout={p} onClose={close} onDone={done} />}
    </>
  );
}
