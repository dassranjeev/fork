import React, { useState } from "react";
import { http } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useFetch, useForm, usePagedList, useSubmit } from "../../lib/hooks";
import { fmtDate, fmtDateTime, money } from "../../lib/format";
import { Button, Card, DataTable, DateInput, FilterSelect, FormModal, FormRow, IconButton, ListToolbar, Modal, MoneyInput, NumberInput, PageHeader, StatCard, StatusBadge, TextArea, TextInput, useConfirm } from "../../ui";

function cardStatus(c) {
  if (!c.active) return "VOID";
  if (c.expiresAt && new Date(c.expiresAt) < new Date()) return "EXPIRED";
  if (Number(c.balance) <= 0) return "REDEEMED";
  return "ACTIVE";
}

function Issue({ onClose, onDone }) {
  const { busy, run } = useSubmit();
  const f = useForm({ amount: 25, count: 1, expiresAt: null, recipientEmail: "", message: "" });
  const [issued, setIssued] = useState(null);
  const single = Number(f.values.count) === 1;
  const submit = () =>
    run(
      () =>
        http.post("/admin/gift-cards", {
          amount: Number(f.values.amount),
          count: Number(f.values.count) || 1,
          expiresAt: f.values.expiresAt || undefined,
          ...(single && f.values.recipientEmail ? { recipientEmail: f.values.recipientEmail } : {}),
          message: f.values.message || undefined,
        }),
      { success: "Gift cards issued", onDone: (r) => { setIssued(r); onDone(); } }
    );
  if (issued)
    return (
      <Modal open onClose={onClose} title={`${issued.count} gift card${issued.count === 1 ? "" : "s"} issued`} footer={<Button onClick={onClose}>Done</Button>}>
        <p className="text-secondary-light text-sm">Copy the codes now. Each is worth {money(f.values.amount)}.</p>
        <textarea className="form-control font-monospace" rows={Math.min(12, issued.cards.length + 1)} readOnly value={issued.cards.map((c) => c.code).join("\n")} />
      </Modal>
    );
  return (
    <FormModal open onClose={onClose} title="Issue gift cards" busy={busy} onSubmit={submit} submitText="Issue" disabled={!(Number(f.values.amount) > 0)}>
      <FormRow>
        <MoneyInput col={6} label="Amount per card" required {...f.bind("amount")} />
        <NumberInput col={6} label="Quantity" step="1" min={1} max={500} hint="1 – 500" {...f.bind("count")} />
        <DateInput col={12} label="Expires" hint="Optional" value={f.values.expiresAt} onChange={(v) => f.set("expiresAt", v)} />
      </FormRow>
      {single && <TextInput label="Recipient email" type="email" hint="The code is emailed to this address." {...f.bind("recipientEmail")} />}
      <TextArea label="Message" rows={2} {...f.bind("message")} />
    </FormModal>
  );
}

export default function GiftCards() {
  const { can } = useAuth();
  const confirm = useConfirm();
  const { run } = useSubmit();
  const list = usePagedList("/admin/gift-cards", { filters: { status: "" } });
  const { data: st, reload: reloadStats } = useFetch("/admin/gift-cards/stats");
  const [issuing, setIssuing] = useState(false);
  const refresh = () => {
    list.reload();
    reloadStats();
  };
  const voidCard = async (c) => {
    const r = await confirm({ title: `Void ${c.code}?`, message: `The remaining balance of ${money(c.balance)} will be forfeited.`, danger: true, confirmText: "Void card" });
    if (r.confirmed) run(() => http.post(`/admin/gift-cards/${c.id}/void`), { success: "Gift card voided", onDone: refresh });
  };
  return (
    <>
      <PageHeader
        title="Gift Cards"
        subtitle="Issue and manage FORKSY wallet gift cards."
        crumbs={[{ label: "Gift cards" }]}
        actions={can("promotions", "create") && <Button icon="solar:gift-outline" onClick={() => setIssuing(true)}>Issue gift cards</Button>}
      />
      <div className="row gy-3 mb-24">
        <div className="col-md-3 col-6"><StatCard label="Issued" value={st ? st.issued : "…"} icon="solar:gift-outline" hint={st ? money(st.issuedAmount) : undefined} /></div>
        <div className="col-md-3 col-6"><StatCard label="Outstanding balance" value={st ? money(st.outstandingBalance) : "…"} icon="solar:wallet-outline" tone="warning" hint={st ? `${st.activeCount} active` : undefined} /></div>
        <div className="col-md-3 col-6"><StatCard label="Redeemed" value={st ? st.redeemedCount : "…"} icon="solar:check-circle-outline" tone="success" hint={st ? money(st.redeemedAmount) : undefined} /></div>
        <div className="col-md-3 col-6"><StatCard label="Voided / expired" value={st ? st.voidCount : "…"} icon="solar:close-circle-outline" tone="danger" hint={st ? `${money(st.expiredBalance)} expired balance` : undefined} /></div>
      </div>
      <Card>
        <ListToolbar
          list={list}
          placeholder="Search by code…"
          filters={<FilterSelect value={list.filters.status} onChange={(v) => list.setFilter("status", v)} options={["ACTIVE", "REDEEMED", "VOID", "EXPIRED"]} placeholder="All statuses" />}
        />
        <DataTable
          {...list.tableProps}
          error={list.error}
          onRetry={list.reload}
          emptyTitle="No gift cards yet"
          emptyText="Issue a gift card to get started."
          columns={[
            { key: "code", title: "Code", render: (c) => <span className="font-monospace fw-semibold">{c.code}</span> },
            { key: "initialAmount", title: "Value", render: (c) => money(c.initialAmount) },
            { key: "balance", title: "Balance", render: (c) => money(c.balance) },
            { key: "status", title: "Status", render: (c) => <StatusBadge status={cardStatus(c)} tone={cardStatus(c) === "REDEEMED" ? "info" : undefined} /> },
            { key: "recipientEmail", title: "Recipient", render: (c) => c.recipientEmail || "—" },
            { key: "expiresAt", title: "Expires", render: (c) => fmtDate(c.expiresAt) },
            { key: "createdAt", title: "Issued", render: (c) => fmtDateTime(c.createdAt) },
            { key: "a", title: "", align: "right", render: (c) => can("promotions", "edit") && c.active && Number(c.balance) > 0 && <IconButton icon="solar:forbidden-circle-outline" title="Void" tone="danger" onClick={() => voidCard(c)} /> },
          ]}
        />
      </Card>
      {issuing && <Issue onClose={() => setIssuing(false)} onDone={refresh} />}
    </>
  );
}
