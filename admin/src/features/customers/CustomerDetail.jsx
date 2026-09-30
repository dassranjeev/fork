import React, { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { http } from "../../lib/api";
import { useFetch, useForm, usePagedList, useSubmit } from "../../lib/hooks";
import { useAuth } from "../../lib/auth";
import { fmtDate, fmtDateTime, money, titleCase } from "../../lib/format";
import {
  Avatar, Badge, BoolBadge, Button, Card, DataTable, EmptyState, ErrorState, FilterSelect, FormModal, FormRow, KeyValue, Loading, NumberInput, PageHeader,
  StatCard, StatusBadge, Tabs, TagsInput, TextArea, TextInput, useConfirm,
} from "../../ui";

const api = (id, p = "") => `/admin/customers/${id}${p}`;

function OrdersTab({ id }) {
  const list = usePagedList(api(id, "/orders"), { limit: 10, filters: { status: "" } });
  const columns = [
    { key: "code", title: "Order", render: (o) => <Link to={`/orders/${o.id}`} className="fw-semibold">{o.code}</Link> },
    { key: "status", title: "Status", render: (o) => <StatusBadge status={o.status} /> },
    { key: "type", title: "Type", render: (o) => titleCase(o.type) },
    { key: "total", title: "Total", align: "right", render: (o) => money(o.total) },
    { key: "createdAt", title: "Placed", render: (o) => fmtDateTime(o.createdAt) },
  ];
  return (
    <>
      <div className="mb-16">
        <FilterSelect value={list.filters.status} onChange={(v) => list.setFilter("status", v)} options={["PLACED", "PREPARING", "DELIVERED", "COLLECTED", "CANCELLED", "REJECTED"]} placeholder="All statuses" />
      </div>
      <DataTable columns={columns} {...list.tableProps} error={list.error} onRetry={list.reload} emptyTitle="No orders yet" />
    </>
  );
}

function WalletTab({ id, reload }) {
  const { can } = useAuth();
  const wallet = useFetch(api(id, "/wallet"), { limit: 20 });
  const [adj, setAdj] = useState(false);
  const form = useForm({ amount: "", reason: "" });
  const { busy, run } = useSubmit();

  const submit = () =>
    run(() => http.post(api(id, "/wallet/adjust"), { amount: Number(form.values.amount), reason: form.values.reason.trim() }), {
      success: "Wallet adjusted",
      onDone: () => {
        setAdj(false);
        form.reset({ amount: "", reason: "" });
        wallet.reload();
        reload();
      },
    });

  if (wallet.loading && !wallet.data) return <Loading />;
  if (wallet.error) return <ErrorState error={wallet.error} onRetry={wallet.reload} />;
  const txs = wallet.data?.transactions?.data || [];
  const amt = Number(form.values.amount);
  return (
    <>
      <div className="d-flex justify-content-between align-items-center mb-16">
        <div>
          <div className="text-secondary-light text-sm">Balance</div>
          <h4 className="mb-0">{money(wallet.data?.balance)}</h4>
        </div>
        {can("customers", "edit") && <Button icon="solar:wallet-outline" onClick={() => setAdj(true)}>Manual adjustment</Button>}
      </div>
      {txs.length === 0 ? (
        <EmptyState icon="solar:wallet-outline" title="No wallet activity" />
      ) : (
        <div className="table-responsive">
          <table className="table bordered-table sm-table mb-0 align-middle">
            <thead><tr><th>Date</th><th>Type</th><th>Note</th><th className="text-end">Amount</th><th className="text-end">Balance</th></tr></thead>
            <tbody>
              {txs.map((t) => (
                <tr key={t.id}>
                  <td>{fmtDateTime(t.createdAt)}</td>
                  <td><Badge tone="primary">{titleCase(t.type)}</Badge></td>
                  <td>{t.note || "—"}</td>
                  <td className={`text-end fw-medium ${t.amount < 0 ? "text-danger-600" : "text-success-600"}`}>{t.amount > 0 ? "+" : ""}{money(t.amount)}</td>
                  <td className="text-end">{money(t.balanceAfter)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <FormModal open={adj} onClose={() => setAdj(false)} title="Adjust wallet balance" onSubmit={submit} busy={busy} submitText="Apply adjustment" disabled={!amt || form.values.reason.trim().length < 3}>
        <NumberInput label="Amount" prefix="$" step="0.01" required hint="Positive credits the wallet, negative debits it. Large adjustments need approval permission." {...form.bind("amount")} />
        <TextArea label="Reason" required hint="Recorded in the audit log." {...form.bind("reason")} />
        {amt ? <div className="text-sm">New balance: <strong>{money((wallet.data?.balance || 0) + amt)}</strong></div> : null}
      </FormModal>
    </>
  );
}

export default function CustomerDetail() {
  const { id } = useParams();
  const [sp, setSp] = useSearchParams();
  const { can } = useAuth();
  const confirm = useConfirm();
  const { busy, run } = useSubmit();
  const { data: c, loading, error, reload } = useFetch(api(id));
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const [flagOpen, setFlagOpen] = useState(false);
  const [flags, setFlags] = useState({ fraudFlag: false, tags: [] });

  if (loading && !c) return <Loading />;
  if (error && !c)
    return (
      <>
        <PageHeader title="Customer" back="/customers" />
        <ErrorState error={error} onRetry={reload} />
      </>
    );
  if (!c) return null;

  const p = c.profile || {};
  const name = [c.firstName, c.lastName].filter(Boolean).join(" ") || c.email || "Customer";
  const canEdit = can("customers", "edit");
  const rs = c.refundStats || {};

  const block = async () => {
    const x = await confirm({ title: `Block ${name}?`, danger: true, confirmText: "Block", message: "They will no longer be able to place orders.", prompt: { label: "Reason", type: "textarea", required: true } });
    if (x.confirmed) run(() => http.post(api(id, "/block"), { reason: x.value }), { success: "Customer blocked", onDone: reload });
  };
  const unblock = async () => {
    const x = await confirm({ title: `Unblock ${name}?`, confirmText: "Unblock" });
    if (x.confirmed) run(() => http.post(api(id, "/unblock")), { success: "Customer unblocked", onDone: reload });
  };
  const openFlags = () => {
    setFlags({ fraudFlag: !!p.fraudFlag, tags: p.flags || [] });
    setFlagOpen(true);
  };
  const saveFlags = () => {
    const before = p.flags || [];
    const addFlag = flags.tags.filter((t) => !before.includes(t));
    const removeFlag = before.filter((t) => !flags.tags.includes(t));
    // the API accepts one flag per call, so apply the fraud toggle with the first change and the rest one by one
    run(
      async () => {
        await http.patch(api(id, "/flags"), { fraudFlag: flags.fraudFlag, addFlag: addFlag[0], removeFlag: removeFlag[0] });
        for (const f of addFlag.slice(1)) await http.patch(api(id, "/flags"), { addFlag: f });
        for (const f of removeFlag.slice(1)) await http.patch(api(id, "/flags"), { removeFlag: f });
      },
      { success: "Flags updated", onDone: () => { setFlagOpen(false); reload(); } }
    );
  };
  const addNote = () =>
    run(() => http.patch(api(id, "/notes"), { note: note.trim() }), {
      success: "Note added",
      onDone: () => {
        setNoteOpen(false);
        setNote("");
        reload();
      },
    });

  const tabs = [
    {
      key: "overview",
      label: "Overview",
      content: (
        <div className="row gy-4">
          <div className="col-lg-7">
            <Card title="Profile">
              <KeyValue
                items={[
                  { label: "Email", value: <>{c.email} {c.email && <Badge tone={c.emailVerified ? "success" : "neutral"} className="ms-2">{c.emailVerified ? "Verified" : "Unverified"}</Badge>}</> },
                  { label: "Phone", value: <>{c.phone} {c.phone && <Badge tone={c.phoneVerified ? "success" : "neutral"} className="ms-2">{c.phoneVerified ? "Verified" : "Unverified"}</Badge>}</> },
                  { label: "Joined", value: fmtDate(c.createdAt) },
                  { label: "Last login", value: c.lastLoginAt ? fmtDateTime(c.lastLoginAt) : "Never" },
                  { label: "Saved addresses", value: c.addressCount },
                  { label: "Referral code", value: p.referralCode },
                  { label: "Dietary preferences", value: (p.dietaryPreferences || []).join(", ") },
                  { label: "Allergens", value: (p.allergens || []).join(", ") },
                  { label: "Marketing email", value: <BoolBadge value={p.marketingEmailConsent} yes="Consented" no="No consent" /> },
                  { label: "Marketing SMS", value: <BoolBadge value={p.marketingSmsConsent} yes="Consented" no="No consent" /> },
                ]}
              />
              {p.deletionRequestedAt && (
                <div className="alert alert-warning radius-8 mt-16 mb-0">
                  Deletion requested on {fmtDate(p.deletionRequestedAt)}. <Link to="/customers/privacy">Open privacy requests</Link>
                </div>
              )}
            </Card>
          </div>
          <div className="col-lg-5">
            <Card title="Refund activity" subtitle={`Limit ${rs.refundFrequencyLimit ?? "—"} per 30 days`}>
              {rs.overLimit && <div className="alert alert-danger radius-8 py-8">Over the refund frequency limit.</div>}
              <KeyValue
                items={[
                  { label: "Refunds (30 days)", value: `${rs.refundCount30d ?? 0} · ${money(rs.refundTotal30d ?? 0)}` },
                  { label: "Refunds (lifetime)", value: `${rs.refundCountLifetime ?? 0} · ${money(rs.refundTotalLifetime ?? 0)}` },
                ]}
              />
            </Card>
          </div>
          <div className="col-12">
            <Card title="Recent orders" actions={<Button variant="link" onClick={() => setSp({ tab: "orders" })}>View all</Button>}>
              {(c.recentOrders || []).length === 0 ? (
                <EmptyState title="No orders yet" />
              ) : (
                <ul className="list-unstyled mb-0">
                  {c.recentOrders.map((o) => (
                    <li key={o.id} className="d-flex justify-content-between align-items-center py-8 border-bottom">
                      <Link to={`/orders/${o.id}`} className="fw-medium">{o.code}</Link>
                      <span className="text-secondary-light text-sm">{fmtDateTime(o.createdAt)}</span>
                      <StatusBadge status={o.status} />
                      <span className="fw-medium">{money(o.total)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </div>
      ),
    },
    { key: "orders", label: "Orders", badge: p.totalOrders, content: <OrdersTab id={id} /> },
    { key: "wallet", label: "Wallet", content: <WalletTab id={id} reload={reload} /> },
    {
      key: "risk",
      label: "Flags & notes",
      content: (
        <div className="row gy-4">
          <div className="col-lg-5">
            <Card title="Risk flags" actions={canEdit && <Button variant="light" onClick={openFlags}>Edit</Button>}>
              <div className="d-flex flex-wrap gap-2 mb-12">
                <BoolBadge value={p.fraudFlag} invert yes="Fraud flagged" no="No fraud flag" />
                {p.isBlocked && <Badge tone="danger">Blocked</Badge>}
                {(p.flags || []).map((f) => <Badge key={f} tone="info">{f}</Badge>)}
              </div>
              {p.isBlocked && <div className="text-sm text-secondary-light">Block reason: {p.blockReason || "—"}</div>}
            </Card>
          </div>
          <div className="col-lg-7">
            <Card title="Internal notes" actions={canEdit && <Button variant="light" onClick={() => setNoteOpen(true)}>Add note</Button>}>
              {p.internalNotes ? <pre className="mb-0" style={{ whiteSpace: "pre-wrap", fontFamily: "inherit" }}>{p.internalNotes}</pre> : <EmptyState title="No notes" text="Notes are only visible to staff." />}
            </Card>
          </div>
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        back="/customers"
        title={
          <span className="d-inline-flex align-items-center gap-3 flex-wrap">
            <Avatar name={name} src={c.avatarUrl} size={40} /> {name} <StatusBadge status={p.isBlocked ? "BLOCKED" : c.status} />
            {p.fraudFlag && <Badge tone="warning">Fraud flag</Badge>}
          </span>
        }
        subtitle={[c.email, c.phone].filter(Boolean).join(" · ")}
        crumbs={[{ label: "Customers", to: "/customers" }, { label: name }]}
        actions={
          canEdit &&
          (p.isBlocked ? (
            <Button variant="success" loading={busy} onClick={unblock}>Unblock</Button>
          ) : (
            <Button variant="outline-danger" loading={busy} onClick={block}>Block customer</Button>
          ))
        }
      />
      <div className="row gy-3 mb-24">
        <div className="col-xl-3 col-sm-6"><StatCard label="Total orders" value={p.totalOrders ?? 0} icon="solar:bag-3-outline" /></div>
        <div className="col-xl-3 col-sm-6"><StatCard label="Lifetime spend" value={money(p.lifetimeSpend)} icon="solar:wallet-money-outline" tone="success" /></div>
        <div className="col-xl-3 col-sm-6"><StatCard label="Wallet balance" value={money(p.walletBalance)} icon="solar:wallet-outline" tone="info" /></div>
        <div className="col-xl-3 col-sm-6"><StatCard label="Last order" value={p.lastOrderAt ? fmtDate(p.lastOrderAt) : "Never"} icon="solar:calendar-outline" tone="purple" /></div>
      </div>
      <div className="card radius-12 border-0 shadow-sm">
        <div className="card-body p-24">
          <Tabs tabs={tabs} active={sp.get("tab") || "overview"} onChange={(k) => setSp({ tab: k }, { replace: true })} />
        </div>
      </div>

      <FormModal open={noteOpen} onClose={() => setNoteOpen(false)} title="Add internal note" onSubmit={addNote} busy={busy} disabled={!note.trim()}>
        <TextArea label="Note" rows={4} value={note} onChange={setNote} />
      </FormModal>
      <FormModal open={flagOpen} onClose={() => setFlagOpen(false)} title="Edit risk flags" onSubmit={saveFlags} busy={busy}>
        <div className="form-check form-switch mb-16">
          <input className="form-check-input" type="checkbox" checked={flags.fraudFlag} onChange={(e) => setFlags({ ...flags, fraudFlag: e.target.checked })} />
          <label className="form-check-label">Fraud flag</label>
        </div>
        <FormRow>
          <TagsInput label="Other flags" value={flags.tags} onChange={(t) => setFlags({ ...flags, tags: t })} suggestions={["refund_abuse", "chargeback", "vip", "abusive"]} />
        </FormRow>
      </FormModal>
    </>
  );
}
