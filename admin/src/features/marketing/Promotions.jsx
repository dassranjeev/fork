import React, { useState } from "react";
import { http } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useFetch, useForm, usePagedList, useSubmit } from "../../lib/hooks";
import { fmtDate, fmtDateTime, money, num, pct, titleCase } from "../../lib/format";
import {
  Badge, Button, Card, DataTable, DateInput, DonutChart, FormModal, FormRow, IconButton, KeyValue, Loading, Modal, MoneyInput, MultiCheck, NumberInput, Select, StatCard, StatusBadge,
  Switch, TextArea, TextInput, useConfirm, ErrorState,
} from "../../ui";
import { CrudPage, RestaurantPicker, numOrNull, useCityOptions } from "../platform/crud";

const TYPES = [
  { value: "PERCENT", label: "Percent off" },
  { value: "FIXED", label: "Fixed amount off" },
  { value: "FREE_DELIVERY", label: "Free delivery" },
  { value: "BOGO", label: "Buy one get one" },
  { value: "FREE_ITEM", label: "Free item" },
];
const STATUSES = ["ACTIVE", "INACTIVE", "SCHEDULED", "EXPIRED", "PENDING_APPROVAL", "EXHAUSTED"];

const describe = (p) => {
  if (p.type === "PERCENT") return `${p.value}% off${p.maxDiscount ? ` (max ${money(p.maxDiscount)})` : ""}`;
  if (p.type === "FIXED") return `${money(p.value)} off`;
  return titleCase(p.type);
};

function Stats({ promo, onClose }) {
  const { data: s, loading, error } = useFetch(`/admin/promotions/${promo.id}/stats`);
  return (
    <Modal open onClose={onClose} title={`${promo.name}${promo.code ? " · " + promo.code : ""}`} size="lg">
      {loading && <Loading />}
      {error && <ErrorState error={error} />}
      {s && (
        <>
          <div className="row gy-3 mb-24">
            <div className="col-md-3 col-6"><StatCard label="Redemptions" value={num(s.redemptions)} icon="solar:ticket-sale-outline" hint={`${s.uniqueCustomers} customers`} /></div>
            <div className="col-md-3 col-6"><StatCard label="Discount spent" value={money(s.discountSpent)} icon="solar:wallet-outline" tone="warning" /></div>
            <div className="col-md-3 col-6"><StatCard label="Revenue" value={money(s.revenue)} icon="solar:graph-up-outline" tone="success" hint={`${s.orders} orders`} /></div>
            <div className="col-md-3 col-6"><StatCard label="ROI" value={s.roi === null || s.roi === undefined ? "—" : pct(s.roi * 100, 0)} icon="solar:chart-square-outline" tone={s.roi >= 0 ? "success" : "danger"} hint="incremental" /></div>
          </div>
          <div className="row gy-3">
            <div className="col-md-7">
              <KeyValue
                items={[
                  { label: "Used / limit", value: `${s.usedCount} / ${s.usageLimit ?? "∞"}` },
                  { label: "Budget", value: s.budget ? `${money(s.discountSpent)} of ${money(s.budget)}` : "Unlimited" },
                  { label: "Budget remaining", value: s.budget ? money(s.budgetRemaining) : "—" },
                  { label: "Avg. discount / order", value: money(s.avgDiscountPerOrder) },
                  { label: "Incremental orders", value: num(s.incrementalOrders, 1) },
                  { label: "Incremental revenue", value: money(s.incrementalRevenue) },
                ]}
              />
            </div>
            <div className="col-md-5">
              {s.discountSpent > 0 ? (
                <DonutChart height={200} labels={["Platform funded", "Restaurant funded"]} values={[s.discountByFunder?.platform || 0, s.discountByFunder?.restaurant || 0]} formatter={(v) => money(v)} />
              ) : (
                <p className="text-secondary-light text-center mt-24">No discount funded yet.</p>
              )}
            </div>
          </div>
        </>
      )}
    </Modal>
  );
}

function Redemptions({ onClose }) {
  const list = usePagedList("/admin/promotions/redemptions");
  return (
    <Modal open onClose={onClose} title="Promotion redemptions" size="xl">
      <DataTable
        {...list.tableProps}
        error={list.error}
        onRetry={list.reload}
        emptyTitle="No redemptions yet"
        columns={[
          { key: "createdAt", title: "When", render: (r) => fmtDateTime(r.createdAt) },
          { key: "promotionName", title: "Promotion", render: (r) => <div>{r.promotionName} {r.promotionCode && <Badge tone="primary">{r.promotionCode}</Badge>}</div> },
          { key: "customerName", title: "Customer" },
          { key: "orderCode", title: "Order" },
          { key: "discount", title: "Discount", render: (r) => money(r.discount) },
        ]}
      />
    </Modal>
  );
}

function Approvals({ onChanged, refreshKey }) {
  const { can } = useAuth();
  const confirm = useConfirm();
  const { busy, run } = useSubmit();
  const { data, loading, error, reload } = useFetch("/admin/promotions/approvals", { limit: 50, k: refreshKey });
  const rows = data?.data ?? [];
  const done = () => {
    reload();
    onChanged();
  };
  const reject = async (p) => {
    const r = await confirm({ title: `Reject "${p.name}"?`, danger: true, confirmText: "Reject", prompt: { label: "Reason (sent to the restaurant)", type: "textarea", required: true } });
    if (r.confirmed) run(() => http.post(`/admin/promotions/${p.id}/reject`, { reason: r.value }), { success: "Promotion rejected", onDone: done });
  };
  return (
    <Card title="Restaurant promo approvals" subtitle="Self-serve promotions waiting for FORKSY review." className="mb-24" actions={rows.length ? <Badge tone="warning">{rows.length} pending</Badge> : null}>
      {error && <ErrorState error={error} onRetry={reload} />}
      {loading && !data ? (
        <Loading minHeight={60} />
      ) : rows.length === 0 ? (
        <p className="text-secondary-light mb-0">Nothing waiting for approval.</p>
      ) : (
        <DataTable
          rows={rows}
          columns={[
            { key: "restaurantName", title: "Restaurant", render: (p) => <span className="fw-semibold">{p.restaurantName || "—"}</span> },
            { key: "name", title: "Promotion", render: (p) => <div><div>{p.name}</div><div className="text-secondary-light text-xs">{p.description}</div></div> },
            { key: "type", title: "Offer", render: describe },
            { key: "minSubtotal", title: "Min. order", render: (p) => money(p.minSubtotal) },
            { key: "dates", title: "Runs", render: (p) => `${fmtDate(p.startsAt)} → ${fmtDate(p.endsAt)}` },
            { key: "budget", title: "Budget", render: (p) => (p.budget ? money(p.budget) : "—") },
            {
              key: "a",
              title: "",
              align: "right",
              render: (p) =>
                can("promotions", "approve") && (
                  <div className="d-flex gap-2 justify-content-end">
                    <Button variant="success" loading={busy} onClick={() => run(() => http.post(`/admin/promotions/${p.id}/approve`), { success: "Promotion approved", onDone: done })}>Approve</Button>
                    <Button variant="outline-danger" onClick={() => reject(p)}>Reject</Button>
                  </div>
                ),
            },
          ]}
        />
      )}
    </Card>
  );
}

function BatchModal({ onClose, onDone }) {
  const { busy, run } = useSubmit();
  const f = useForm({ name: "", prefix: "", count: 50, type: "PERCENT", value: 10, minSubtotal: 0, perUserLimit: 1, endsAt: null });
  const [codes, setCodes] = useState(null);
  const submit = () =>
    run(
      () =>
        http.post("/admin/promotions/batch", {
          name: f.values.name,
          prefix: f.values.prefix.toUpperCase(),
          count: Number(f.values.count),
          type: f.values.type,
          value: f.values.value === "" ? undefined : Number(f.values.value),
          minSubtotal: Number(f.values.minSubtotal) || 0,
          perUserLimit: Number(f.values.perUserLimit) || 0,
          endsAt: f.values.endsAt || undefined,
          fundedBy: "PLATFORM",
          active: true,
        }),
      { success: "Codes generated", onDone: (r) => { setCodes(r); onDone(); } }
    );
  if (codes)
    return (
      <Modal open onClose={onClose} title={`${codes.count} codes generated`} footer={<Button onClick={onClose}>Done</Button>}>
        <textarea className="form-control font-monospace" rows={10} readOnly value={codes.codes.join("\n")} />
        <div className="text-secondary-light text-xs mt-2">Batch ID: {codes.batchId}</div>
      </Modal>
    );
  return (
    <FormModal open onClose={onClose} title="Generate code batch" busy={busy} onSubmit={submit} submitText="Generate" disabled={!f.values.name || !f.values.prefix}>
      <FormRow>
        <TextInput col={8} label="Campaign name" required {...f.bind("name")} />
        <TextInput col={4} label="Code prefix" required hint="e.g. SPRING → SPRING-7K2QX9" {...f.bind("prefix")} />
        <Select col={6} label="Type" allowEmpty={false} options={TYPES} {...f.bind("type")} />
        <NumberInput col={6} label={f.values.type === "PERCENT" ? "Percent" : "Amount"} min={0} {...f.bind("value")} />
        <NumberInput col={4} label="Number of codes" step="1" min={1} max={1000} {...f.bind("count")} />
        <MoneyInput col={4} label="Min. subtotal" {...f.bind("minSubtotal")} />
        <NumberInput col={4} label="Per-customer limit" step="1" min={0} hint="0 = unlimited" {...f.bind("perUserLimit")} />
        <DateInput col={6} label="Expires" withTime value={f.values.endsAt} onChange={(v) => f.set("endsAt", v)} />
      </FormRow>
    </FormModal>
  );
}

export default function Promotions() {
  const { can } = useAuth();
  const { busy, run } = useSubmit();
  const { options: cityOpts } = useCityOptions();
  const { data: ov, reload: reloadOv } = useFetch("/admin/promotions/overview");
  const [stats, setStats] = useState(null);
  const [showRedemptions, setShowRedemptions] = useState(false);
  const [showBatch, setShowBatch] = useState(false);
  const [tick, setTick] = useState(0);

  return (
    <CrudPage
      title="Promotions"
      subtitle="Promo codes and auto-applied deals, platform or restaurant funded."
      path="/admin/promotions"
      module="promotions"
      itemName="promotion"
      modalSize="lg"
      sortBy="createdAt"
      searchPlaceholder="Search name or code…"
      initial={{
        name: "", code: "", description: "", type: "PERCENT", value: 10, maxDiscount: "", minSubtotal: 0, fundedBy: "PLATFORM", restaurantId: "", cityId: "", menuItemId: "",
        orderTypes: [], startsAt: null, endsAt: null, usageLimit: "", perUserLimit: 0, firstOrderOnly: false, autoApply: false, active: true, budget: 0,
      }}
      toForm={(p) => ({
        name: p.name, code: p.code || "", description: p.description || "", type: p.type, value: p.value ?? "", maxDiscount: p.maxDiscount ?? "", minSubtotal: p.minSubtotal ?? 0,
        fundedBy: p.fundedBy, restaurantId: p.restaurantId || "", cityId: p.cityId || "", menuItemId: p.menuItemId || "", orderTypes: p.orderTypes || [], startsAt: p.startsAt, endsAt: p.endsAt,
        usageLimit: p.usageLimit ?? "", perUserLimit: p.perUserLimit ?? 0, firstOrderOnly: !!p.firstOrderOnly, autoApply: !!p.autoApply, active: !!p.active, budget: p.budget ?? 0,
      })}
      toPayload={(v) => ({
        name: v.name,
        code: v.code ? v.code.toUpperCase() : null,
        description: v.description || null,
        type: v.type,
        value: v.type === "PERCENT" || v.type === "FIXED" ? Number(v.value || 0) : undefined,
        maxDiscount: v.type === "PERCENT" ? numOrNull(v.maxDiscount) : null,
        minSubtotal: Number(v.minSubtotal) || 0,
        fundedBy: v.fundedBy,
        restaurantId: v.restaurantId || null,
        cityId: v.cityId || null,
        menuItemId: v.type === "FREE_ITEM" || v.type === "BOGO" ? v.menuItemId || null : null,
        orderTypes: v.orderTypes,
        startsAt: v.startsAt || null,
        endsAt: v.endsAt || null,
        usageLimit: numOrNull(v.usageLimit),
        perUserLimit: Number(v.perUserLimit) || 0,
        firstOrderOnly: !!v.firstOrderOnly,
        autoApply: !!v.autoApply,
        active: !!v.active,
        budget: Number(v.budget) || 0,
      })}
      filterDefs={[
        { name: "status", placeholder: "All statuses", options: STATUSES },
        { name: "type", placeholder: "All types", options: TYPES },
        { name: "fundedBy", placeholder: "Any funder", options: ["PLATFORM", "RESTAURANT"] },
      ]}
      deleteMessage={(p) => `"${p.name}" will be deleted, or deactivated if it already has redemptions.`}
      columns={[
        { key: "name", title: "Promotion", render: (p) => <div><div className="fw-semibold">{p.name}</div><div className="text-secondary-light text-xs">{p.restaurantName ? `${p.restaurantName} · ` : ""}{p.description}</div></div> },
        { key: "code", title: "Code", render: (p) => (p.code ? <Badge tone="primary">{p.code}</Badge> : <span className="text-secondary-light">Auto-apply</span>) },
        { key: "type", title: "Offer", render: describe },
        { key: "minSubtotal", title: "Min. order", render: (p) => (p.minSubtotal ? money(p.minSubtotal) : "—") },
        { key: "fundedBy", title: "Funded by", render: (p) => titleCase(p.fundedBy) },
        { key: "used", title: "Used", render: (p) => `${p.usedCount}${p.usageLimit ? ` / ${p.usageLimit}` : ""}` },
        { key: "dates", title: "Runs", render: (p) => (p.startsAt || p.endsAt ? `${fmtDate(p.startsAt)} → ${fmtDate(p.endsAt)}` : "Always") },
        { key: "status", title: "Status", render: (p) => <StatusBadge status={p.status} /> },
      ]}
      headerExtra={
        <>
          <div className="row gy-3 mb-24">
            <div className="col-md-3 col-6"><StatCard label="Active promotions" value={ov?.activePromotions ?? "…"} icon="solar:ticket-sale-outline" tone="success" /></div>
            <div className="col-md-3 col-6"><StatCard label="Pending approval" value={ov?.pendingApproval ?? "…"} icon="solar:clock-circle-outline" tone="warning" /></div>
            <div className="col-md-3 col-6"><StatCard label="Redemptions" value={ov ? num(ov.redemptions) : "…"} icon="solar:cart-check-outline" tone="info" /></div>
            <div className="col-md-3 col-6"><StatCard label="Discounts given" value={ov ? money(ov.totalDiscount) : "…"} icon="solar:wallet-money-outline" tone="purple" hint={ov ? `budget spent ${money(ov.totalBudgetSpent)}` : undefined} /></div>
          </div>
          <Approvals refreshKey={tick} onChanged={() => { reloadOv(); setTick((t) => t + 1); }} />
        </>
      }
      toolbarExtra={
        <>
          <Button variant="light" icon="solar:history-outline" onClick={() => setShowRedemptions(true)}>Redemptions</Button>
          {can("promotions", "create") && <Button variant="outline" icon="solar:copy-outline" onClick={() => setShowBatch(true)}>Generate codes</Button>}
        </>
      }
      rowActions={(p, reload) => (
        <>
          <IconButton icon="solar:chart-2-outline" title="Stats & ROI" tone="primary" onClick={() => setStats(p)} />
          {can("promotions", "edit") && p.status !== "PENDING_APPROVAL" && (
            <IconButton
              icon={p.active ? "solar:pause-circle-outline" : "solar:play-circle-outline"}
              title={p.active ? "Deactivate" : "Activate"}
              tone={p.active ? "warning" : "success"}
              disabled={busy}
              onClick={() => run(() => http.post(`/admin/promotions/${p.id}/${p.active ? "deactivate" : "activate"}`), { success: p.active ? "Deactivated" : "Activated", onDone: () => { reload(); reloadOv(); } })}
            />
          )}
          {can("promotions", "create") && <IconButton icon="solar:copy-outline" title="Duplicate" onClick={() => run(() => http.post(`/admin/promotions/${p.id}/duplicate`), { success: "Duplicated as inactive draft", onDone: reload })} />}
        </>
      )}
      renderForm={({ f }) => {
        const v = f.values;
        return (
          <>
            <FormRow>
              <TextInput col={8} label="Name" required {...f.bind("name")} />
              <TextInput col={4} label="Promo code" hint="Blank = auto-applied deal" {...f.bind("code")} />
            </FormRow>
            <TextArea label="Description" rows={2} {...f.bind("description")} />
            <FormRow>
              <Select col={4} label="Offer type" allowEmpty={false} options={TYPES} {...f.bind("type")} />
              {v.type === "PERCENT" && <NumberInput col={4} label="Percent off" suffix="%" min={0} max={100} {...f.bind("value")} />}
              {v.type === "FIXED" && <MoneyInput col={4} label="Amount off" {...f.bind("value")} />}
              {v.type === "PERCENT" && <MoneyInput col={4} label="Max discount" hint="Optional cap" {...f.bind("maxDiscount")} />}
              {(v.type === "FREE_ITEM" || v.type === "BOGO") && <TextInput col={8} label="Menu item ID" hint="UUID of the free / discounted item" {...f.bind("menuItemId")} />}
              <MoneyInput col={4} label="Min. subtotal" {...f.bind("minSubtotal")} />
              <Select col={4} label="Funded by" allowEmpty={false} options={["PLATFORM", "RESTAURANT"]} {...f.bind("fundedBy")} />
              <Select col={4} label="City" options={cityOpts} placeholder="All cities" {...f.bind("cityId")} />
              <DateInput col={6} label="Starts" withTime value={v.startsAt} onChange={(x) => f.set("startsAt", x)} />
              <DateInput col={6} label="Ends" withTime value={v.endsAt} onChange={(x) => f.set("endsAt", x)} />
              <NumberInput col={4} label="Total usage limit" step="1" min={1} hint="Blank = unlimited" {...f.bind("usageLimit")} />
              <NumberInput col={4} label="Per-customer limit" step="1" min={0} hint="0 = unlimited" {...f.bind("perUserLimit")} />
              <MoneyInput col={4} label="Budget" hint="0 = unlimited" {...f.bind("budget")} />
            </FormRow>
            {v.fundedBy === "RESTAURANT" && <RestaurantPicker label="Restaurant (funder)" value={v.restaurantId} onChange={(id) => f.set("restaurantId", id)} />}
            <MultiCheck label="Order types (none = all)" cols={4} options={["DELIVERY", "PICKUP"]} value={v.orderTypes} onChange={(x) => f.set("orderTypes", x)} />
            <div className="row">
              <div className="col-md-4"><Switch label="Active" {...f.bindCheck("active")} /></div>
              <div className="col-md-4"><Switch label="Auto-apply" hint="Applied without a code" {...f.bindCheck("autoApply")} /></div>
              <div className="col-md-4"><Switch label="First order only" {...f.bindCheck("firstOrderOnly")} /></div>
            </div>
          </>
        );
      }}
    >
      {({ list }) => (
        <>
          {stats && <Stats promo={stats} onClose={() => setStats(null)} />}
          {showRedemptions && <Redemptions onClose={() => setShowRedemptions(false)} />}
          {showBatch && <BatchModal onClose={() => setShowBatch(false)} onDone={() => { list.reload(); reloadOv(); }} />}
        </>
      )}
    </CrudPage>
  );
}
