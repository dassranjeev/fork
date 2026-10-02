import React, { useState } from "react";
import { Badge, Button, Card, DataTable, FormModal, KeyValue, Modal, NumberInput, StatCard, StatusBadge, Tabs, TextInput, DateInput } from "../../ui";
import { fmtDate, money, titleCase } from "../../lib/format";
import { errorMessage } from "../../lib/api";
import { sanitizeDocument } from "../../lib/safe";
import { toast } from "react-toastify";
import { usePagedList } from "../../lib/hooks";
import { Async, PortalPage, daysAgo, isoDay, useAction, useApi, usePortalFetch } from "./shared";

function saveText(filename, text, type = "text/csv") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

const period = (p) => `${fmtDate(p.periodStart)} – ${fmtDate(p.periodEnd)}`;

// ------------------------------------------------------------------ statement modal
function StatementModal({ id, onClose }) {
  const state = usePortalFetch(id ? `/restaurant/finance/statements/${id}` : null);
  const api = useApi();
  const { run, isBusy } = useAction();
  const s = state.data;
  const csv = async () => {
    const r = await run("csv", () => api.get(`/restaurant/finance/statements/${id}/csv`));
    if (r.ok) saveText(r.data.filename || "statement.csv", r.data.csv);
  };
  return (
    <Modal open={!!id} onClose={onClose} size="xl" title={s ? `Statement · ${s.period?.label}` : "Statement"} footer={s && <Button variant="outline" icon="solar:download-minimalistic-outline" loading={isBusy("csv")} onClick={csv}>Download CSV</Button>}>
      <Async state={state}>
        {(st) => (
          <>
            <div className="row gy-3 mb-20">
              <div className="col-md-3"><StatCard label="Gross sales" value={money(st.summary.gross)} icon="solar:wallet-money-outline" /></div>
              <div className="col-md-3"><StatCard label="Deductions" value={money(st.summary.deductions)} icon="solar:minus-circle-outline" tone="warning" /></div>
              <div className="col-md-3"><StatCard label="Net payout" value={money(st.summary.net)} icon="solar:hand-money-outline" tone="success" /></div>
              <div className="col-md-3"><StatCard label="Orders" value={st.summary.orderCount} icon="solar:bag-check-outline" tone="info" /></div>
            </div>
            <div className="d-flex gap-3 align-items-center mb-12">
              <StatusBadge status={st.payout.status} />
              {st.payout.paidAt && <span className="text-secondary-light text-sm">Paid {fmtDate(st.payout.paidAt)}</span>}
              {st.invoice && <Badge tone="info">Invoice {st.invoice.number}</Badge>}
            </div>
            <div className="table-responsive">
              <table className="table bordered-table sm-table mb-0">
                <thead>
                  <tr>
                    <th>Order</th>
                    <th>Date</th>
                    {st.columns.map((c) => (
                      <th key={c.key} className="text-end">{c.label}</th>
                    ))}
                    <th className="text-end">Net</th>
                  </tr>
                </thead>
                <tbody>
                  {st.lines.map((l) => (
                    <tr key={l.orderId}>
                      <td className="fw-semibold">{l.orderCode}</td>
                      <td>{fmtDate(l.date)}</td>
                      {st.columns.map((c) => (
                        <td key={c.key} className="text-end">{money(l.amounts?.[c.key] ?? 0)}</td>
                      ))}
                      <td className="text-end fw-semibold">{money(l.net)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Async>
    </Modal>
  );
}

// ------------------------------------------------------------------ overview
function Overview({ onOpen }) {
  const state = usePortalFetch("/restaurant/finance/dashboard");
  return (
    <Async state={state}>
      {(d) => (
        <>
          <div className="row gy-3 mb-24">
            <div className="col-md-4"><StatCard label="Payout schedule" value={titleCase(d.balance.schedule)} icon="solar:calendar-outline" /></div>
            <div className="col-md-4">
              <StatCard label="Bank account" value={d.balance.bankMasked || "Not set"} icon="solar:card-outline" tone={d.balance.bankVerified ? "success" : "warning"} hint={d.balance.bankVerified ? "Verified" : "Needs verification"} />
            </div>
            <div className="col-md-4">
              <StatCard label="Payouts" value={d.balance.hold ? "On hold" : "Active"} icon="solar:shield-check-outline" tone={d.balance.hold ? "danger" : "success"} hint={d.balance.holdReason || undefined} />
            </div>
          </div>
          <Card title="Recent payouts" noPadding>
            <div className="table-responsive">
              <table className="table bordered-table mb-0 align-middle">
                <thead>
                  <tr>
                    <th>Period</th>
                    <th className="text-end">Gross</th>
                    <th className="text-end">Deductions</th>
                    <th className="text-end">Net</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {d.recentPayouts.length === 0 && (
                    <tr>
                      <td colSpan={5} className="text-center text-secondary-light py-24">No payouts yet</td>
                    </tr>
                  )}
                  {d.recentPayouts.map((p) => (
                    <tr key={p.id} style={{ cursor: "pointer" }} onClick={() => onOpen(p.id)}>
                      <td>{period(p)}</td>
                      <td className="text-end">{money(p.gross)}</td>
                      <td className="text-end">{money(p.deductions)}</td>
                      <td className="text-end fw-semibold">{money(p.net)}</td>
                      <td><StatusBadge status={p.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </Async>
  );
}

// ------------------------------------------------------------------ payouts
function Payouts({ onOpen }) {
  const list = usePagedList("/restaurant/finance/payouts", { limit: 15 });
  const cols = [
    { key: "period", title: "Period", render: period },
    { key: "orderCount", title: "Orders", align: "right" },
    { key: "gross", title: "Gross", align: "right", render: (p) => money(p.gross) },
    { key: "deductions", title: "Deductions", align: "right", render: (p) => money(p.deductions) },
    { key: "net", title: "Net", align: "right", render: (p) => <span className="fw-semibold">{money(p.net)}</span> },
    { key: "status", title: "Status", render: (p) => <StatusBadge status={p.status} /> },
    { key: "paidAt", title: "Paid", render: (p) => fmtDate(p.paidAt) },
  ];
  return (
    <div className="card radius-12 border-0 shadow-sm">
      <DataTable columns={cols} {...list.tableProps} error={list.error} onRetry={list.reload} onRowClick={(p) => onOpen(p.id)} emptyTitle="No payouts yet" />
    </div>
  );
}

// ------------------------------------------------------------------ invoices
function Invoices() {
  const list = usePagedList("/restaurant/finance/invoices", { limit: 15 });
  const api = useApi();
  const { run, isBusy } = useAction();
  const open = async (inv) => {
    const r = await run(inv.id, () => api.get(`/restaurant/finance/invoices/${inv.id}/download`, { format: "html" }));
    if (!r.ok) return;
    // server-generated HTML is sanitised again here (defence in depth) and opened as an inert blob document
    // with noopener: no window.document.write into a same-origin window, so no access to our storage/tokens.
    const clean = sanitizeDocument(r.data.body);
    const url = URL.createObjectURL(new Blob([clean], { type: "text/html" }));
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  };
  const cols = [
    { key: "number", title: "Invoice", render: (i) => <span className="fw-semibold">{i.number}</span> },
    { key: "period", title: "Period", render: period },
    { key: "commissionAmount", title: "Commission", align: "right", render: (i) => money(i.commissionAmount) },
    { key: "hstAmount", title: "HST", align: "right", render: (i) => money(i.hstAmount) },
    { key: "total", title: "Total", align: "right", render: (i) => <span className="fw-semibold">{money(i.total)}</span> },
    { key: "status", title: "Status", render: (i) => <StatusBadge status={i.status} /> },
    {
      key: "act",
      title: "",
      align: "right",
      render: (i) => (
        <Button variant="outline" icon="solar:document-text-outline" loading={isBusy(i.id)} onClick={() => open(i)}>
          View
        </Button>
      ),
    },
  ];
  return (
    <div className="card radius-12 border-0 shadow-sm">
      <DataTable columns={cols} {...list.tableProps} error={list.error} onRetry={list.reload} emptyTitle="No invoices yet" />
    </div>
  );
}

// ------------------------------------------------------------------ ledger
function Ledger() {
  const [from, setFrom] = useState(daysAgo(30));
  const [to, setTo] = useState(isoDay(new Date()));
  const state = usePortalFetch(from && to ? "/restaurant/finance/ledger" : null, { from, to });
  return (
    <>
      <div className="d-flex flex-wrap gap-3 align-items-end mb-16">
        <DateInput label="From" className="mb-0" value={from} onChange={setFrom} />
        <DateInput label="To" className="mb-0" value={to} onChange={setTo} />
      </div>
      <Async state={state} empty={(d) => !d.lines?.length} emptyProps={{ title: "No orders in this period" }}>
        {(d) => (
          <div className="card radius-12 border-0 shadow-sm">
            <div className="table-responsive scroll-sm">
              <table className="table bordered-table sm-table mb-0 align-middle">
                <thead>
                  <tr>
                    <th>Order</th>
                    <th>Date</th>
                    {d.columns.map((c) => (
                      <th key={c.key} className="text-end">{c.label}</th>
                    ))}
                    <th className="text-end">Net</th>
                    <th>Payout</th>
                  </tr>
                </thead>
                <tbody>
                  {d.lines.map((l) => (
                    <tr key={l.orderId}>
                      <td className="fw-semibold">{l.orderCode}</td>
                      <td>{fmtDate(l.date)}</td>
                      {d.columns.map((c) => (
                        <td key={c.key} className="text-end">{money(l.amounts?.[c.key] ?? 0)}</td>
                      ))}
                      <td className="text-end fw-semibold">{money(l.net)}</td>
                      <td><StatusBadge status={l.payoutStatus || "PENDING"} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Async>
    </>
  );
}

// ------------------------------------------------------------------ bank
function BankTab() {
  const state = usePortalFetch("/restaurant/finance/bank");
  const api = useApi();
  const { busy, run } = useAction();
  const [edit, setEdit] = useState(false);
  const [f, setF] = useState({});
  const [verify, setVerify] = useState(false);
  const [amounts, setAmounts] = useState(["", ""]);

  const save = async () => {
    const r = await run("save", () => api.post("/restaurant/finance/bank", { institution: f.institution, transit: f.transit, accountNumber: f.accountNumber, holder: f.holder }), "Bank details saved");
    if (r.ok) {
      setEdit(false);
      state.reload();
    }
  };
  const initiate = async () => {
    const r = await run("init", () => api.post("/restaurant/finance/bank/verify/initiate"), "Two small deposits are on their way. Enter the amounts once they arrive.");
    if (r.ok) state.reload();
  };
  const confirm = async () => {
    try {
      await api.post("/restaurant/finance/bank/verify/confirm", { amounts: amounts.map(Number) });
      toast.success("Bank account verified");
      setVerify(false);
      state.reload();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return (
    <Async state={state}>
      {(b) => (
        <>
          <Card
            title="Bank account"
            subtitle="Payouts are sent here by EFT"
            actions={
              <Button
                variant="outline"
                icon="solar:pen-outline"
                onClick={() => {
                  setF({ institution: b.bank?.institution || "", transit: b.bank?.transit || "", accountNumber: "", holder: b.bank?.holder || "" });
                  setEdit(true);
                }}
              >
                {b.bank ? "Change" : "Add bank account"}
              </Button>
            }
          >
            {b.bank ? (
              <KeyValue
                items={[
                  { label: "Account holder", value: b.bank.holder },
                  { label: "Institution", value: b.bank.institution },
                  { label: "Transit", value: b.bank.transit },
                  { label: "Account", value: b.bank.account },
                  { label: "Verification", value: <StatusBadge status={b.verified ? "APPROVED" : "PENDING"} label={b.verified ? "Verified" : "Not verified"} /> },
                ]}
                cols={3}
              />
            ) : (
              <p className="text-secondary-light mb-0">No bank account on file. Add one so FORKSY can pay you.</p>
            )}
            {b.bank && !b.verified && (
              <div className="d-flex gap-2 mt-20">
                <Button variant="outline" loading={busy === "init"} onClick={initiate}>
                  Send verification deposits
                </Button>
                <Button onClick={() => setVerify(true)}>Enter deposit amounts</Button>
              </div>
            )}
          </Card>
          <FormModal open={edit} onClose={() => setEdit(false)} title="Bank account" onSubmit={save} busy={busy === "save"} disabled={!f.institution || !f.transit || !f.accountNumber || !f.holder}>
            <TextInput label="Account holder" value={f.holder} onChange={(v) => setF({ ...f, holder: v })} />
            <div className="row">
              <TextInput col={4} label="Institution (3 digits)" value={f.institution} onChange={(v) => setF({ ...f, institution: v })} />
              <TextInput col={4} label="Transit (5 digits)" value={f.transit} onChange={(v) => setF({ ...f, transit: v })} />
              <TextInput col={4} label="Account number" value={f.accountNumber} onChange={(v) => setF({ ...f, accountNumber: v })} />
            </div>
            <p className="text-secondary-light text-sm mb-0">Changing bank details requires re-verification and may pause payouts briefly.</p>
          </FormModal>
          <FormModal open={verify} onClose={() => setVerify(false)} title="Verify bank account" onSubmit={confirm} submitText="Verify" size="sm">
            <NumberInput label="First deposit ($)" value={amounts[0]} onChange={(v) => setAmounts([v, amounts[1]])} step="0.01" />
            <NumberInput label="Second deposit ($)" value={amounts[1]} onChange={(v) => setAmounts([amounts[0], v])} step="0.01" />
          </FormModal>
        </>
      )}
    </Async>
  );
}

export default function Finance() {
  const [tab, setTab] = useState("overview");
  const [statement, setStatement] = useState(null);
  return (
    <PortalPage title="Finance" subtitle="Payouts, statements and invoices for your business">
      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { key: "overview", label: "Overview", content: <Overview onOpen={setStatement} /> },
          { key: "payouts", label: "Payouts & statements", content: <Payouts onOpen={setStatement} /> },
          { key: "invoices", label: "Invoices", content: <Invoices /> },
          { key: "ledger", label: "Order ledger", content: <Ledger /> },
          { key: "bank", label: "Bank account", content: <BankTab /> },
        ]}
      />
      <StatementModal id={statement} onClose={() => setStatement(null)} />
    </PortalPage>
  );
}
