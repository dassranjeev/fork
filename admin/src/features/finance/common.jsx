import { fmtDate } from "../../lib/format";
import React, { useState } from "react";
import { Badge, Button, ErrorState, FormModal, FormRow, KeyValue, Loading, MoneyInput, NumberInput, StatusBadge, TextArea, TextInput } from "../../ui";
import { http } from "../../lib/api";
import { useFetch, useDebounced, useForm, useSubmit } from "../../lib/hooks";
import { useAuth } from "../../lib/auth";
import { titleCase } from "../../lib/format";

/** Date-only strings (YYYY-MM-DD) must not shift with the timezone. */
export function fmtDay(v) {
  if (typeof v === "string" && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(v)) {
    const [y, m, d] = v.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString("en-CA", { year: "numeric", month: "short", day: "numeric" });
  }
  return fmtDate(v);
}

export const PARTY_TYPES = ["RESTAURANT", "DRIVER", "PLATFORM", "CUSTOMER"];
export const PAYOUT_STATUSES = ["PENDING", "APPROVED", "RELEASED", "PAID", "FAILED", "ON_HOLD"];
export const BATCH_STATUSES = ["DRAFT", "LOCKED", "APPROVED", "RELEASED", "COMPLETED"];
export const LEDGER_TYPES = ["SALE", "COMMISSION", "RESTAURANT_PROMO", "PLATFORM_PROMO", "DELIVERY_PAY", "TIP", "BOOST", "FEE_REVENUE", "COMMISSION_REVENUE", "REFUND", "ADJUSTMENT", "PAYOUT", "INSTANT_FEE"];

export function downloadText(filename, text, type = "text/csv") {
  const href = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(href);
}

export const PartyBadge = ({ type }) => <Badge tone={type === "DRIVER" ? "purple" : type === "RESTAURANT" ? "primary" : "neutral"}>{titleCase(type)}</Badge>;

/** Signed money with colour (credits green, debits red). */
export function Signed({ value, fmt }) {
  const n = Number(value);
  return <span className={n < 0 ? "text-danger-main" : n > 0 ? "text-success-main" : ""}>{fmt(n)}</span>;
}

/** Choose a party: type + (search for restaurants/drivers | raw id for platform/customer). onChange({partyType, partyId, name}) */
export function PartyPicker({ value, onChange, types = PARTY_TYPES }) {
  const [type, setType] = useState(value?.partyType || "RESTAURANT");
  const [q, setQ] = useState("");
  const dq = useDebounced(q);
  const searchable = type === "RESTAURANT" || type === "DRIVER";
  const path = searchable ? (type === "DRIVER" ? "/admin/drivers" : "/admin/restaurants") : null;
  const { data, loading } = useFetch(path, { search: dq || undefined, limit: 8 });
  const rows = (data?.data || []).map((r) => (type === "DRIVER" ? { id: r.id, name: r.name, sub: r.email } : { id: r.merchantId, name: r.name, sub: r.city })).filter((r) => r.id);
  const uniq = rows.filter((r, i) => rows.findIndex((x) => x.id === r.id) === i);
  return (
    <div>
      <div className="row g-2">
        <div className="col-md-4">
          <select className="form-select radius-8" value={type} onChange={(e) => { setType(e.target.value); setQ(""); onChange(null); }}>
            {types.map((t) => <option key={t} value={t}>{titleCase(t)}</option>)}
          </select>
        </div>
        <div className="col-md-8">
          {searchable ? (
            <input className="form-control radius-8" placeholder={`Search ${titleCase(type).toLowerCase()}s by name…`} value={q} onChange={(e) => setQ(e.target.value)} />
          ) : (
            <input className="form-control radius-8" placeholder="Party id (uuid)" value={value?.partyId || ""} onChange={(e) => onChange(e.target.value ? { partyType: type, partyId: e.target.value, name: e.target.value } : null)} />
          )}
        </div>
      </div>
      {searchable && (
        <div className="list-group mt-2" style={{ maxHeight: 220, overflowY: "auto" }}>
          {loading && <div className="list-group-item text-secondary-light">Searching…</div>}
          {!loading && uniq.length === 0 && <div className="list-group-item text-secondary-light">No matches</div>}
          {uniq.map((r) => (
            <button type="button" key={r.id} className={`list-group-item list-group-item-action d-flex justify-content-between ${value?.partyId === r.id ? "active" : ""}`} onClick={() => onChange({ partyType: type, partyId: r.id, name: r.name })}>
              <span className="fw-medium">{r.name}</span>
              <span className="opacity-75 text-sm">{r.sub}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Manual ledger adjustment. party optional (shows picker when missing). */
export function AdjustmentModal({ party, onClose, onDone }) {
  const [picked, setPicked] = useState(party || null);
  const f = useForm({ amount: "", reason: "" });
  const { busy, run } = useSubmit();
  const v = f.values;
  const invalid = !picked || v.amount === "" || Number(v.amount) === 0 || v.reason.trim().length < 3;
  return (
    <FormModal
      open
      onClose={onClose}
      title="Manual adjustment"
      submitText="Post adjustment"
      busy={busy}
      disabled={invalid}
      onSubmit={() => run(() => http.post("/admin/finance/adjustments", { partyType: picked.partyType, partyId: picked.partyId, amount: Number(v.amount), reason: v.reason }), { success: "Adjustment posted", onDone })}
    >
      {party ? (
        <p className="mb-16"><PartyBadge type={party.partyType} /> <strong className="ms-2">{party.name}</strong></p>
      ) : (
        <div className="mb-16">
          <label className="form-label fw-semibold text-sm">Party</label>
          <PartyPicker value={picked} onChange={setPicked} />
          {picked && <div className="mt-2 text-sm">Selected: <strong>{picked.name}</strong></div>}
        </div>
      )}
      <NumberInput label="Amount (positive credits the party, negative debits)" prefix="$" step="0.01" required {...f.bind("amount")} />
      <TextArea label="Reason" required hint="Recorded in the ledger and audit log" {...f.bind("reason")} />
    </FormModal>
  );
}

function BankModal({ party, bank, onClose, onDone }) {
  const f = useForm({ institution: bank?.institution || "", transit: bank?.transit || "", accountNumber: "", holder: bank?.holder || "", debitCardLast4: "" });
  const { busy, run } = useSubmit();
  const clean = Object.fromEntries(Object.entries(f.values).filter(([, x]) => x !== ""));
  return (
    <FormModal open onClose={onClose} title="Bank details" busy={busy} onSubmit={() => run(() => http.post(`/admin/finance/parties/${party.partyType}/${party.partyId}/bank`, clean), { success: "Bank details saved (verification reset)", onDone })}>
      <p className="text-secondary-light text-sm">Changing bank details resets verification. Only the last 4 digits of the account number are stored.</p>
      <FormRow>
        <TextInput col={6} label="Institution" placeholder="004" {...f.bind("institution")} />
        <TextInput col={6} label="Transit" placeholder="12345" {...f.bind("transit")} />
        <TextInput col={6} label="Account number" placeholder={bank?.account ? `Current ${bank.account}` : ""} {...f.bind("accountNumber")} />
        <TextInput col={6} label="Account holder" {...f.bind("holder")} />
        {party.partyType === "DRIVER" && <TextInput col={6} label="Debit card last 4 (instant payouts)" {...f.bind("debitCardLast4")} />}
      </FormRow>
    </FormModal>
  );
}

function ConfirmDepositsModal({ party, mock, onClose, onDone }) {
  const f = useForm({ a: "", b: "" });
  const { busy, run } = useSubmit();
  return (
    <FormModal open onClose={onClose} title="Confirm micro-deposits" busy={busy} disabled={f.values.a === "" || f.values.b === ""} onSubmit={() => run(() => http.post(`/admin/finance/parties/${party.partyType}/${party.partyId}/bank/verify/confirm`, { amounts: [Number(f.values.a), Number(f.values.b)] }), { success: "Verification submitted", onDone })}>
      {mock && <div className="alert alert-info radius-8">Test mode amounts: {mock.join(" and ")}</div>}
      <FormRow>
        <MoneyInput col={6} label="Deposit 1" {...f.bind("a")} />
        <MoneyInput col={6} label="Deposit 2" {...f.bind("b")} />
      </FormRow>
    </FormModal>
  );
}

/** Bank + hold settings for one party. */
export function PartyPanel({ partyType, partyId, onChanged }) {
  const { can } = useAuth();
  const info = useFetch(`/admin/finance/parties/${partyType}/${partyId}`);
  const hasBank = partyType === "DRIVER" || partyType === "RESTAURANT";
  const bankRes = useFetch(hasBank ? `/admin/finance/parties/${partyType}/${partyId}/bank` : null);
  const { busy, run } = useSubmit();
  const [modal, setModal] = useState(null);
  const [mock, setMock] = useState(null);
  const [holdReason, setHoldReason] = useState("");
  const reload = () => { info.reload(); bankRes.reload(); onChanged?.(); };
  if (info.loading && !info.data) return <Loading minHeight={120} />;
  if (info.error) return <ErrorState error={info.error} onRetry={info.reload} />;
  const p = info.data || {};
  const bank = bankRes.data?.bank;
  const verified = bankRes.data?.verified ?? p.bankVerified;
  const party = { partyType, partyId, name: p.name };
  const edit = can("finance", "edit");
  const base = `/admin/finance/parties/${partyType}/${partyId}`;
  return (
    <div>
      <div className="d-flex flex-wrap align-items-center gap-2 mb-16">
        <h6 className="mb-0">{p.name}</h6>
        <PartyBadge type={partyType} />
        {p.hold ? <StatusBadge status="On hold" tone="danger" /> : <StatusBadge status="Payouts enabled" tone="success" />}
      </div>
      <KeyValue
        items={[
          { label: "Payout schedule", value: titleCase(p.schedule) },
          { label: "Stripe account", value: p.stripeAccountId },
          hasBank && { label: "Bank account", value: bank ? `${bank.institution || "—"}-${bank.transit || "—"} ${bank.account || ""}` : "Not on file" },
          hasBank && { label: "Account holder", value: bank?.holder },
          hasBank && { label: "Bank verified", value: <StatusBadge status={verified ? "Verified" : p.bankOk ? "Unverified" : "Missing"} tone={verified ? "success" : "warning"} /> },
          p.hold && { label: "Hold reason", value: p.holdReason },
        ]}
      />
      {edit && (
        <div className="d-flex flex-wrap gap-2 mt-20">
          {hasBank && <Button variant="light" icon="solar:card-outline" onClick={() => setModal("bank")}>Edit bank</Button>}
          {hasBank && !verified && bank && (
            <>
              <Button variant="light" loading={busy} onClick={() => run(() => http.post(`${base}/bank/verify/initiate`), { success: "Micro-deposits initiated", onDone: (r) => { setMock(r?.mockAmounts || null); reload(); } })}>Send micro-deposits</Button>
              <Button variant="light" onClick={() => setModal("verify")}>Confirm deposits</Button>
            </>
          )}
        </div>
      )}
      {edit && (
        <div className="border-top mt-20 pt-16">
          <div className="fw-semibold mb-8">Payout hold</div>
          {p.hold ? (
            <Button variant="success" loading={busy} onClick={() => run(() => http.patch(`${base}/hold`, { hold: false }), { success: "Hold removed; held payouts released", onDone: reload })}>Remove hold</Button>
          ) : (
            <div className="d-flex gap-2">
              <input className="form-control radius-8" placeholder="Reason for hold" value={holdReason} onChange={(e) => setHoldReason(e.target.value)} />
              <Button variant="danger" loading={busy} disabled={holdReason.trim().length < 3} onClick={() => run(() => http.patch(`${base}/hold`, { hold: true, reason: holdReason }), { success: "Payouts on hold", onDone: () => { setHoldReason(""); reload(); } })}>Place hold</Button>
            </div>
          )}
        </div>
      )}
      {modal === "bank" && <BankModal party={party} bank={bank} onClose={() => setModal(null)} onDone={() => { setModal(null); reload(); }} />}
      {modal === "verify" && <ConfirmDepositsModal party={party} mock={mock} onClose={() => setModal(null)} onDone={() => { setModal(null); reload(); }} />}
    </div>
  );
}
