import React, { useEffect, useState } from "react";
import { Badge, Button, DataTable, DateInput, FilterSelect, FormModal, IconButton, ListToolbar, Loading, ErrorState, Modal, MoneyInput, MultiCheck, NumberInput, Select, StatCard, StatusBadge, TextArea, TextInput, useConfirm } from "../../ui";
import { fmtDate, money, num, pct, titleCase } from "../../lib/format";
import { usePagedList, useFetch } from "../../lib/hooks";
import { PortalPage, useAction, useApi, usePortalFetch } from "./shared";
import { usePortal } from "./context";

const TYPES = [
  { value: "PERCENT", label: "Percent off" },
  { value: "BOGO", label: "Buy one get one" },
  { value: "FREE_ITEM", label: "Free item" },
  { value: "FREE_DELIVERY", label: "Free delivery" },
];

const describe = (p) => {
  if (p.type === "PERCENT") return `${p.value}% off${p.maxDiscount ? ` (max ${money(p.maxDiscount)})` : ""}`;
  if (p.type === "FREE_DELIVERY") return "Free delivery";
  return titleCase(p.type);
};

function PromoModal({ open, onClose, onSaved }) {
  const api = useApi();
  const { restaurantId } = usePortal();
  const menu = usePortalFetch(open ? "/restaurant/menu" : null);
  const { busy, run } = useAction();
  const empty = { name: "", description: "", type: "PERCENT", value: 10, maxDiscount: "", minSubtotal: "", menuItemId: "", orderTypes: ["DELIVERY", "PICKUP"], startsAt: null, endsAt: null, usageLimit: "", perUserLimit: "", budget: "", code: "" };
  const [f, setF] = useState(empty);
  useEffect(() => {
    if (open) setF(empty);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  if (!open) return null;
  const items = (menu.data?.categories || []).flatMap((c) => c.items || []);
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }));
  const n = (v) => (v === "" || v === null ? undefined : Number(v));
  const submit = async () => {
    const body = {
      restaurantId,
      name: f.name.trim(),
      description: f.description || undefined,
      type: f.type,
      value: f.type === "PERCENT" ? n(f.value) : undefined,
      maxDiscount: f.type === "PERCENT" ? n(f.maxDiscount) : undefined,
      minSubtotal: n(f.minSubtotal),
      menuItemId: ["FREE_ITEM", "BOGO"].includes(f.type) && f.menuItemId ? f.menuItemId : undefined,
      orderTypes: f.orderTypes,
      startsAt: f.startsAt || undefined,
      endsAt: f.endsAt || undefined,
      usageLimit: n(f.usageLimit),
      perUserLimit: n(f.perUserLimit),
      budget: n(f.budget),
      code: f.code.trim() || undefined,
    };
    const r = await run("save", () => api.post("/restaurant/promotions", body), "Promotion created");
    if (r.ok) onSaved(r.data);
  };
  const valid = f.name.trim() && (f.type !== "PERCENT" || (f.value > 0 && f.value <= 100)) && (f.type !== "FREE_ITEM" || f.menuItemId);
  return (
    <FormModal open onClose={onClose} title="New promotion" size="lg" onSubmit={submit} busy={!!busy} disabled={!valid}>
      <p className="text-secondary-light text-sm">Promotions you create are funded by your restaurant and may need FORKSY approval before they go live.</p>
      <div className="row">
        <TextInput col={8} label="Name" required value={f.name} onChange={set("name")} placeholder="e.g. Lunch special 15% off" />
        <Select col={4} label="Offer" allowEmpty={false} value={f.type} onChange={set("type")} options={TYPES} />
        <TextArea label="Description" rows={2} value={f.description} onChange={set("description")} />
        {f.type === "PERCENT" && <NumberInput col={4} label="Percent off" suffix="%" value={f.value} onChange={set("value")} min={1} max={100} />}
        {f.type === "PERCENT" && <MoneyInput col={4} label="Max discount" value={f.maxDiscount} onChange={set("maxDiscount")} />}
        {["FREE_ITEM", "BOGO"].includes(f.type) && (
          <Select col={8} label={f.type === "FREE_ITEM" ? "Free item" : "Item (optional)"} required={f.type === "FREE_ITEM"} value={f.menuItemId} onChange={set("menuItemId")} options={items.map((i) => ({ value: i.id, label: i.name }))} placeholder={menu.loading ? "Loading…" : "Select item"} />
        )}
        <MoneyInput col={4} label="Minimum order" value={f.minSubtotal} onChange={set("minSubtotal")} />
        <DateInput col={6} label="Starts" withTime value={f.startsAt} onChange={set("startsAt")} />
        <DateInput col={6} label="Ends" withTime value={f.endsAt} onChange={set("endsAt")} />
        <NumberInput col={4} label="Total uses limit" value={f.usageLimit} onChange={set("usageLimit")} min={1} />
        <NumberInput col={4} label="Per customer limit" value={f.perUserLimit} onChange={set("perUserLimit")} min={0} />
        <MoneyInput col={4} label="Budget cap" value={f.budget} onChange={set("budget")} />
        <TextInput col={6} label="Promo code" hint="Leave empty to apply the deal automatically" value={f.code} onChange={set("code")} />
        <div className="col-md-6">
          <MultiCheck label="Applies to" cols={2} options={[{ value: "DELIVERY", label: "Delivery" }, { value: "PICKUP", label: "Pickup" }]} value={f.orderTypes} onChange={set("orderTypes")} />
        </div>
      </div>
    </FormModal>
  );
}

function StatsModal({ promo, onClose }) {
  const { restaurantId } = usePortal();
  const { data: s, loading, error } = useFetch(`/restaurant/promotions/${promo.id}/stats`, { restaurantId });
  return (
    <Modal open onClose={onClose} title={`${promo.name}${promo.code ? " · " + promo.code : ""}`} size="lg">
      {loading && <Loading />}
      {error && <ErrorState error={error} />}
      {s && (
        <div className="row gy-3">
          <div className="col-md-3 col-6"><StatCard label="Redemptions" value={num(s.redemptions)} icon="solar:ticket-sale-outline" hint={`${s.uniqueCustomers ?? 0} customers`} /></div>
          <div className="col-md-3 col-6"><StatCard label="Discount spent" value={money(s.discountSpent)} icon="solar:wallet-outline" tone="warning" /></div>
          <div className="col-md-3 col-6"><StatCard label="Revenue" value={money(s.revenue)} icon="solar:graph-up-outline" tone="success" hint={`${s.orders ?? 0} orders`} /></div>
          <div className="col-md-3 col-6"><StatCard label="ROI" value={s.roi === null || s.roi === undefined ? "—" : pct(s.roi * 100, 0)} icon="solar:chart-square-outline" tone={s.roi >= 0 ? "success" : "danger"} /></div>
        </div>
      )}
    </Modal>
  );
}

export default function Promotions() {
  const { restaurantId } = usePortal();
  const list = usePagedList("/restaurant/promotions", { limit: 15, filters: { restaurantId, status: "" } });
  const api = useApi();
  const confirm = useConfirm();
  const { run } = useAction();
  const [create, setCreate] = useState(false);
  const [stats, setStats] = useState(null);
  const { setFilter } = list;
  useEffect(() => {
    setFilter("restaurantId", restaurantId);
  }, [restaurantId, setFilter]);

  const toggle = async (p) => {
    const act = p.status === "ACTIVE" ? "pause" : "resume";
    const r = await run(p.id, () => api.post(`/restaurant/promotions/${p.id}/${act}`), act === "pause" ? "Promotion paused" : "Promotion resumed");
    if (r.ok) list.reload();
  };
  const del = async (p) => {
    const c = await confirm({ title: `Delete ${p.name}?`, message: "Promotions that were already used are deactivated instead.", danger: true, confirmText: "Delete" });
    if (!c.confirmed) return;
    const r = await run(p.id, () => api.del(`/restaurant/promotions/${p.id}`), "Promotion removed");
    if (r.ok) list.reload();
  };

  const cols = [
    { key: "name", title: "Promotion", render: (p) => <div><div className="fw-semibold">{p.name}</div><div className="text-secondary-light text-xs">{p.description}</div></div> },
    { key: "type", title: "Offer", render: describe },
    { key: "code", title: "Code", render: (p) => (p.code ? <Badge tone="primary">{p.code}</Badge> : <span className="text-secondary-light">Auto-apply</span>) },
    { key: "minSubtotal", title: "Min. order", render: (p) => (p.minSubtotal ? money(p.minSubtotal) : "—") },
    { key: "used", title: "Used", render: (p) => `${p.usedCount ?? 0}${p.usageLimit ? ` / ${p.usageLimit}` : ""}` },
    { key: "dates", title: "Runs", render: (p) => (p.startsAt || p.endsAt ? `${fmtDate(p.startsAt)} → ${fmtDate(p.endsAt)}` : "Always") },
    { key: "status", title: "Status", render: (p) => <StatusBadge status={p.status} /> },
    {
      key: "a",
      title: "",
      align: "right",
      render: (p) => (
        <div className="d-inline-flex gap-2" onClick={(e) => e.stopPropagation()}>
          <IconButton icon="solar:chart-2-outline" title="Results" tone="primary" onClick={() => setStats(p)} />
          {["ACTIVE", "INACTIVE"].includes(p.status) && <IconButton icon={p.status === "ACTIVE" ? "solar:pause-circle-outline" : "solar:play-circle-outline"} title={p.status === "ACTIVE" ? "Pause" : "Resume"} tone="warning" onClick={() => toggle(p)} />}
          <IconButton icon="solar:trash-bin-trash-outline" title="Delete" tone="danger" onClick={() => del(p)} />
        </div>
      ),
    },
  ];

  return (
    <PortalPage title="Promotions" subtitle="Run your own deals to bring in more orders">
      <ListToolbar
        filters={<FilterSelect value={list.filters.status} onChange={(v) => list.setFilter("status", v)} options={["ACTIVE", "SCHEDULED", "INACTIVE", "PENDING_APPROVAL", "EXPIRED", "EXHAUSTED"]} placeholder="All statuses" />}
        actions={
          <>
            <Button variant="outline" icon="solar:refresh-outline" onClick={list.reload}>Refresh</Button>
            <Button icon="solar:add-circle-outline" onClick={() => setCreate(true)}>New promotion</Button>
          </>
        }
      />
      <div className="card radius-12 border-0 shadow-sm">
        <DataTable columns={cols} {...list.tableProps} error={list.error} onRetry={list.reload} emptyTitle="No promotions yet" emptyText="Create a deal such as 15% off or free delivery." />
      </div>
      <PromoModal
        open={create}
        onClose={() => setCreate(false)}
        onSaved={() => {
          setCreate(false);
          list.reload();
        }}
      />
      {stats && <StatsModal promo={stats} onClose={() => setStats(null)} />}
    </PortalPage>
  );
}
