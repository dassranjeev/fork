import React, { useEffect, useState } from "react";
import { http } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useFetch, useForm, usePagedList, useSubmit } from "../../lib/hooks";
import { money, pct } from "../../lib/format";
import {
  Badge, Button, Card, DataTable, EmptyState, ErrorState, FilterSelect, FormModal, FormRow, IconButton, KeyValue, ListToolbar, Loading, NumberInput, PageHeader, PercentInput,
  Select, StatCard, Tabs, Switch, MoneyInput,
} from "../../ui";
import { RestaurantPicker, numOrNull, useCityOptions } from "./crud";

// ------------------------------------------------------------------ City summary
function CitySummary() {
  const { options } = useCityOptions();
  const [cityId, setCityId] = useState("");
  useEffect(() => {
    if (!cityId && options.length) setCityId(options[0].value);
  }, [options, cityId]);
  const { data, loading, error, reload } = useFetch(cityId ? `/admin/pricing/cities/${cityId}` : null);
  return (
    <div>
      <div className="d-flex gap-3 mb-20 align-items-center">
        <FilterSelect value={cityId} onChange={setCityId} options={options} placeholder="Select city" />
        <span className="text-secondary-light text-sm">Effective pricing, commission and tax configuration for the city.</span>
      </div>
      {error && <ErrorState error={error} onRetry={reload} />}
      {loading && !data && <Loading />}
      {data && (
        <>
          <div className="row gy-3 mb-24">
            <div className="col-md-3 col-6"><StatCard label="Restaurants in city" value={data.restaurantsInCity} icon="solar:shop-2-outline" /></div>
            <div className="col-md-3 col-6"><StatCard label="Without a tier" value={data.restaurantsWithoutTier} icon="solar:tag-price-outline" tone="warning" hint="Use the default tier" /></div>
            <div className="col-md-3 col-6"><StatCard label="With custom commission" value={data.restaurantsWithOverrides} icon="solar:sale-outline" tone="purple" /></div>
            <div className="col-md-3 col-6"><StatCard label="Zones" value={data.zones?.length ?? 0} icon="solar:map-point-outline" tone="info" /></div>
          </div>
          <div className="row gy-3">
            <div className="col-lg-6">
              <Card title="Customer fees">
                <KeyValue
                  items={[
                    { label: "Base delivery fee", value: money(data.city.customerFees?.baseDeliveryFee) },
                    { label: "Per-km fee", value: money(data.city.customerFees?.perKmFee) },
                    { label: "Service fee", value: `${data.city.customerFees?.serviceFeePct}% (cap ${money(data.city.customerFees?.serviceFeeCap)})` },
                    { label: "Small order", value: `under ${money(data.city.customerFees?.smallOrderThreshold)} → ${money(data.city.customerFees?.smallOrderFee)}` },
                    { label: "Busy multiplier", value: `x${data.city.customerFees?.busyMultiplier}` },
                  ]}
                />
              </Card>
            </div>
            <div className="col-lg-6">
              <Card title="Driver pay">
                <KeyValue
                  items={[
                    { label: "Base fare", value: money(data.city.driverPay?.baseFare) },
                    { label: "Per km", value: money(data.city.driverPay?.perKm) },
                    { label: "Per wait minute", value: `${money(data.city.driverPay?.perWaitMin)} after ${data.city.driverPay?.freeWaitMin} min` },
                    { label: "Minimum per trip", value: money(data.city.driverPay?.minPerTrip) },
                    { label: "Payout release threshold", value: money(data.city.payoutReleaseThreshold) },
                  ]}
                />
              </Card>
            </div>
            <div className="col-lg-7">
              <Card title="Zones" noPadding>
                <DataTable
                  rowKey="id"
                  rows={data.zones}
                  columns={[
                    { key: "name", title: "Zone", render: (z) => <span className="fw-semibold">{z.name}</span> },
                    { key: "effectiveBaseFee", title: "Base fee", render: (z) => money(z.effectiveBaseFee) },
                    { key: "effectivePerKmFee", title: "Per km", render: (z) => money(z.effectivePerKmFee) },
                    { key: "minimumOrder", title: "Min order", render: (z) => money(z.minimumOrder ?? 0) },
                    { key: "overridesCity", title: "", render: (z) => (z.overridesCity ? <Badge tone="info">Overrides city</Badge> : z.busyMode ? <Badge tone="warning">Busy x{z.busyMultiplier}</Badge> : null) },
                  ]}
                />
              </Card>
            </div>
            <div className="col-lg-5">
              <Card title="Commission tiers" noPadding>
                <DataTable
                  rows={data.commissionTiers}
                  columns={[
                    { key: "name", title: "Tier", render: (t) => <span className="fw-semibold">{t.name}</span> },
                    { key: "rates", title: "Del / Pick / Own", render: (t) => `${t.deliveryPct}% / ${t.pickupPct}% / ${t.ownDriverPct}%` },
                    { key: "restaurantsInCity", title: "In city" },
                  ]}
                />
              </Card>
              <Card title="Tax classes" className="mt-3" noPadding>
                <DataTable
                  rows={data.taxClasses}
                  columns={[
                    { key: "code", title: "Code" },
                    { key: "name", title: "Name" },
                    { key: "ratePct", title: "Rate", render: (t) => `${t.ratePct}%` },
                  ]}
                />
              </Card>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ Overrides
function OverrideModal({ initial, onClose, onDone }) {
  const { busy, run } = useSubmit();
  const { data: tiers } = useFetch("/admin/commission-tiers", { limit: 100 });
  const o = initial?.overrides || {};
  const f = useForm({
    restaurantId: initial?.restaurantId || "",
    tierId: initial?.tier?.id || "",
    delivery: o.delivery ?? "",
    pickup: o.pickup ?? "",
    ownDriver: o.ownDriver ?? "",
  });
  const submit = () =>
    run(
      () =>
        http.patch(`/admin/pricing/restaurants/${f.values.restaurantId}/commission`, {
          ...(f.values.tierId ? { commissionTierId: f.values.tierId } : {}),
          deliveryCommissionPct: numOrNull(f.values.delivery),
          pickupCommissionPct: numOrNull(f.values.pickup),
          ownDriverCommissionPct: numOrNull(f.values.ownDriver),
        }),
      {
        success: "Commission saved",
        onDone: () => {
          onDone();
          onClose();
        },
      }
    );
  return (
    <FormModal open onClose={onClose} title={initial ? `Commission: ${initial.name}` : "Set restaurant commission"} busy={busy} onSubmit={submit} disabled={!f.values.restaurantId}>
      {!initial && <RestaurantPicker required value={f.values.restaurantId} onChange={(id) => f.set("restaurantId", id)} />}
      <Select label="Commission tier" value={f.values.tierId} onChange={(v) => f.set("tierId", v)} options={(tiers?.data ?? []).map((t) => ({ value: t.id, label: `${t.name} (${t.deliveryPct}/${t.pickupPct}/${t.ownDriverPct})` }))} />
      <p className="text-secondary-light text-sm">Overrides replace the tier rate. Leave blank to use the tier rate.</p>
      <FormRow>
        <PercentInput col={4} label="Delivery" max={100} {...f.bind("delivery")} />
        <PercentInput col={4} label="Pickup" max={100} {...f.bind("pickup")} />
        <PercentInput col={4} label="Own driver" max={100} {...f.bind("ownDriver")} />
      </FormRow>
    </FormModal>
  );
}

function Overrides() {
  const { can } = useAuth();
  const { options: cityOpts } = useCityOptions();
  const { data: tiers } = useFetch("/admin/commission-tiers", { limit: 100 });
  const list = usePagedList("/admin/pricing/commission-overrides", { filters: { cityId: "", tierId: "" } });
  const [edit, setEdit] = useState(null); // null | 'new' | row
  const rate = (v) => (v === null || v === undefined ? <span className="text-secondary-light">—</span> : <span className="fw-semibold text-warning-main">{v}%</span>);
  return (
    <Card>
      <ListToolbar
        list={list}
        placeholder="Search restaurants…"
        filters={
          <>
            <FilterSelect value={list.filters.cityId} onChange={(v) => list.setFilter("cityId", v)} options={cityOpts} placeholder="All cities" />
            <FilterSelect value={list.filters.tierId} onChange={(v) => list.setFilter("tierId", v)} options={(tiers?.data ?? []).map((t) => ({ value: t.id, label: t.name }))} placeholder="All tiers" />
          </>
        }
        actions={can("pricing", "edit") && <Button icon="solar:add-circle-outline" onClick={() => setEdit("new")}>Add override</Button>}
      />
      <DataTable
        rowKey="restaurantId"
        {...list.tableProps}
        error={list.error}
        onRetry={list.reload}
        emptyTitle="No per-restaurant overrides"
        emptyText="Every restaurant currently pays its tier's rate."
        columns={[
          { key: "name", title: "Restaurant", render: (r) => <div><div className="fw-semibold">{r.name}</div><div className="text-secondary-light text-xs">{r.status}</div></div> },
          { key: "tier", title: "Tier", render: (r) => r.tier?.name || "—" },
          { key: "tierRates", title: "Tier rates", render: (r) => `${r.tierRates.delivery ?? "—"}% / ${r.tierRates.pickup ?? "—"}% / ${r.tierRates.ownDriver ?? "—"}%` },
          { key: "ov_d", title: "Delivery override", render: (r) => rate(r.overrides.delivery) },
          { key: "ov_p", title: "Pickup override", render: (r) => rate(r.overrides.pickup) },
          { key: "ov_o", title: "Own-driver override", render: (r) => rate(r.overrides.ownDriver) },
          { key: "a", title: "", align: "right", render: (r) => can("pricing", "edit") && <IconButton icon="solar:pen-outline" tone="primary" title="Edit" onClick={() => setEdit(r)} /> },
        ]}
      />
      {edit && <OverrideModal initial={edit === "new" ? null : edit} onClose={() => setEdit(null)} onDone={list.reload} />}
    </Card>
  );
}

// ------------------------------------------------------------------ Simulator
function Row({ label, value, bold, tone }) {
  return (
    <div className={`d-flex justify-content-between py-6 ${bold ? "fw-bold border-top mt-2 pt-2" : ""}`}>
      <span className="text-secondary-light">{label}</span>
      <span className={tone ? `text-${tone}-main` : ""}>{value}</span>
    </div>
  );
}

function Simulator() {
  const { options: cityOpts } = useCityOptions();
  const { data: tiers } = useFetch("/admin/commission-tiers", { limit: 100 });
  const { data: taxes } = useFetch("/admin/tax-classes", { limit: 100 });
  const f = useForm({ cityId: "", zoneId: "", subtotal: 35, distanceKm: 3, pickupKm: 2, waitMin: 0, tip: 0, discount: 0, discountFundedBy: "PLATFORM", busy: false, taxClassCode: "", commissionTierId: "", commissionPct: "", type: "DELIVERY" });
  const { data: zones } = useFetch(f.values.cityId ? "/admin/zones" : null, { cityId: f.values.cityId, limit: 100 });
  const { busy, run } = useSubmit();
  const [res, setRes] = useState(null);

  const go = () => {
    const v = f.values;
    const body = { subtotal: Number(v.subtotal), type: v.type, busy: !!v.busy, discountFundedBy: v.discountFundedBy };
    ["distanceKm", "pickupKm", "waitMin", "tip", "discount", "commissionPct"].forEach((k) => v[k] !== "" && (body[k] = Number(v[k])));
    ["cityId", "zoneId", "taxClassCode", "commissionTierId"].forEach((k) => v[k] && (body[k] = v[k]));
    run(() => http.post("/admin/pricing/simulate", body), { onDone: setRes });
  };
  return (
    <div className="row gy-3">
      <div className="col-lg-5">
        <Card title="What-if inputs">
          <FormRow>
            <Select col={6} label="City" value={f.values.cityId} onChange={(v) => { f.set("cityId", v); f.set("zoneId", ""); }} options={cityOpts} placeholder="Default city" />
            <Select col={6} label="Zone" value={f.values.zoneId} disabled={!f.values.cityId} onChange={(v) => f.set("zoneId", v)} options={(zones?.data ?? []).map((z) => ({ value: z.id, label: z.name }))} />
            <Select col={6} label="Order type" allowEmpty={false} options={["DELIVERY", "PICKUP"]} {...f.bind("type")} />
            <MoneyInput col={6} label="Food subtotal" {...f.bind("subtotal")} />
            <NumberInput col={6} label="Delivery distance" suffix="km" min={0} {...f.bind("distanceKm")} />
            <NumberInput col={6} label="Driver pickup distance" suffix="km" min={0} {...f.bind("pickupKm")} />
            <NumberInput col={6} label="Driver wait" suffix="min" min={0} {...f.bind("waitMin")} />
            <MoneyInput col={6} label="Tip" {...f.bind("tip")} />
            <MoneyInput col={6} label="Discount" {...f.bind("discount")} />
            <Select col={6} label="Discount funded by" allowEmpty={false} options={["PLATFORM", "RESTAURANT"]} {...f.bind("discountFundedBy")} />
            <Select col={6} label="Tax class" value={f.values.taxClassCode} onChange={(v) => f.set("taxClassCode", v)} options={(taxes?.data ?? []).map((t) => ({ value: t.code, label: `${t.code} (${t.ratePct}%)` }))} placeholder="Default" />
            <Select col={6} label="Commission tier" value={f.values.commissionTierId} onChange={(v) => f.set("commissionTierId", v)} options={(tiers?.data ?? []).map((t) => ({ value: t.id, label: t.name }))} placeholder="Default" />
            <PercentInput col={6} label="Commission % override" max={100} {...f.bind("commissionPct")} />
          </FormRow>
          <Switch label="Simulate busy mode" {...f.bindCheck("busy")} />
          <Button loading={busy} icon="solar:calculator-minimalistic-outline" onClick={go} disabled={f.values.subtotal === ""}>
            Run simulation
          </Button>
        </Card>
      </div>
      <div className="col-lg-7">
        {!res ? (
          <Card><EmptyState icon="solar:calculator-minimalistic-outline" title="Run a simulation" text="See what the customer pays, what the restaurant and driver earn, and the platform margin." /></Card>
        ) : (
          <div className="row gy-3">
            <div className="col-md-6">
              <Card title="Customer pays" subtitle={res.source === "CITY_CONFIG" ? `${res.inputs?.city || ""}${res.inputs?.zone ? " · " + res.inputs.zone : ""}` : res.source}>
                <Row label="Subtotal" value={money(res.customer?.subtotal)} />
                <Row label="Delivery fee" value={money(res.customer?.deliveryFee)} />
                <Row label="Service fee" value={money(res.customer?.serviceFee)} />
                <Row label="Small-order fee" value={money(res.customer?.smallOrderFee)} />
                <Row label={`Tax (${res.tax?.classCode} ${res.tax?.ratePct}%)`} value={money(res.customer?.taxAmount)} />
                <Row label="Tip" value={money(res.customer?.tip)} />
                <Row label="Discount" value={`-${money(res.customer?.discount)}`} tone="success" />
                <Row label="Total" value={money(res.customer?.total)} bold />
              </Card>
            </div>
            <div className="col-md-6">
              <Card title="Restaurant & driver">
                <Row label={`Commission (${res.restaurant?.commissionPct}% · ${res.restaurant?.commissionSource})`} value={money(res.restaurant?.commissionAmount)} />
                <Row label="Promo cost" value={money(res.restaurant?.promoCost)} />
                <Row label="Restaurant payout" value={money(res.restaurant?.payout)} bold />
                <Row label="Driver pay" value={money(res.driver?.pay)} />
                <Row label="Tip pass-through" value={money(res.driver?.tipPassThrough)} />
              </Card>
            </div>
            <div className="col-12">
              <Card title="Platform economics">
                <div className="row gy-3">
                  <div className="col-6"><StatCard label="Revenue" value={money(res.platform?.revenue)} icon="solar:wallet-money-outline" tone="success" /></div>
                  <div className="col-6"><StatCard label="Driver cost" value={money(res.platform?.driverCost)} icon="solar:scooter-outline" tone="info" /></div>
                  <div className="col-6"><StatCard label="Promo cost" value={money(res.platform?.promoCost)} icon="solar:ticket-sale-outline" tone="warning" /></div>
                  <div className="col-6"><StatCard label="Contribution" value={money(res.platform?.contributionMargin)} hint={`take rate ${pct(res.platform?.takeRatePct)}`} icon="solar:graph-up-outline" tone={res.platform?.contributionMargin >= 0 ? "success" : "danger"} /></div>
                </div>
              </Card>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function Pricing() {
  return (
    <>
      <PageHeader title="Pricing & Commission" subtitle="Effective pricing per city, restaurant commission overrides and a what-if simulator." crumbs={[{ label: "Pricing" }]} />
      <Tabs
        tabs={[
          { key: "city", label: "City summary", content: <CitySummary /> },
          { key: "overrides", label: "Commission overrides", content: <Overrides /> },
          { key: "sim", label: "Simulator", content: <Simulator /> },
        ]}
      />
    </>
  );
}
