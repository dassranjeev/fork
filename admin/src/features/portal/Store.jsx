import React, { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Button, Card, DateInput, IconButton, NumberInput, MoneyInput, Switch, Tabs, TextArea, TextInput, useConfirm } from "../../ui";
import { fmtDate } from "../../lib/format";
import { Async, DAYS, PortalPage, useAction, useApi, usePortalFetch, useRealtimeReload } from "./shared";
import { usePortal } from "./context";
import ServiceModeControl from "./ServiceMode";
import OrderAutomationCard from "./Automation";
import VerificationBanner from "../verification/VerificationBanner";
import DocumentsTab from "./Documents";

const TAB_KEYS = ["profile", "documents", "fulfilment", "hours", "closures", "stations", "alerts"];

function SaveBar({ busy, onSave, dirtyHint }) {
  return (
    <div className="d-flex justify-content-end align-items-center gap-3 mt-8">
      {dirtyHint && <span className="text-secondary-light text-sm">{dirtyHint}</span>}
      <Button size="md" loading={busy} onClick={onSave}>
        Save changes
      </Button>
    </div>
  );
}

const num = (v) => (v === "" || v === null || v === undefined ? undefined : Number(v));

// ------------------------------------------------------------------ profile
function ProfileTab({ store, reload }) {
  const api = useApi();
  const { reloadLocations } = usePortal();
  const { busy, run } = useAction();
  const [f, setF] = useState({});
  useEffect(() => {
    setF({
      name: store.name || "",
      description: store.description || "",
      phone: store.phone || "",
      email: store.email || "",
      website: store.website || "",
      addressLine1: store.addressLine1 || "",
      city: store.city || "",
      postalCode: store.postalCode || "",
    });
  }, [store]);
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }));
  const save = async () => {
    const r = await run("save", () => api.patch("/restaurant/store", { ...f, website: f.website || null, phone: f.phone || null, email: f.email || null }), "Profile saved");
    if (r.ok) {
      reload();
      reloadLocations();
    }
  };
  return (
    <Card title="Restaurant profile">
      <div className="row">
        <TextInput col={6} label="Name" value={f.name} onChange={set("name")} />
        <TextInput col={6} label="Phone" value={f.phone} onChange={set("phone")} />
        <TextArea label="Description" rows={2} value={f.description} onChange={set("description")} />
        <TextInput col={6} label="Order email" value={f.email} onChange={set("email")} />
        <TextInput col={6} label="Website" value={f.website} onChange={set("website")} />
        <TextInput col={6} label="Address" value={f.addressLine1} onChange={set("addressLine1")} />
        <TextInput col={3} label="City" value={f.city} onChange={set("city")} />
        <TextInput col={3} label="Postal code" value={f.postalCode} onChange={set("postalCode")} />
      </div>
      <SaveBar busy={!!busy} onSave={save} />
    </Card>
  );
}

// ------------------------------------------------------------------ fulfilment
function FulfilmentTab({ store, reload }) {
  const api = useApi();
  const { busy, run } = useAction();
  const [f, setF] = useState({});
  useEffect(() => {
    const keys = ["deliveryEnabled", "ownDeliveryEnabled", "ownDeliveryFee", "pickupEnabled", "scheduledEnabled", "dineInEnabled", "prepTimeMin", "pickupPrepTimeMin", "deliveryRadiusKm", "minimumOrder", "pickupInstructions", "parkingNotes", "slotMinutes", "maxOrdersPerSlot", "scheduleLeadMin", "autoRejectSeconds"];
    setF(Object.fromEntries(keys.map((k) => [k, store[k] ?? ""])));
  }, [store]);
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }));
  const save = async () => {
    const body = {
      deliveryEnabled: !!f.deliveryEnabled,
      ownDeliveryEnabled: !!f.ownDeliveryEnabled,
      pickupEnabled: !!f.pickupEnabled,
      scheduledEnabled: !!f.scheduledEnabled,
      dineInEnabled: !!f.dineInEnabled,
      ownDeliveryFee: num(f.ownDeliveryFee),
      prepTimeMin: num(f.prepTimeMin),
      pickupPrepTimeMin: num(f.pickupPrepTimeMin),
      deliveryRadiusKm: num(f.deliveryRadiusKm),
      minimumOrder: num(f.minimumOrder),
      slotMinutes: num(f.slotMinutes),
      maxOrdersPerSlot: num(f.maxOrdersPerSlot),
      scheduleLeadMin: num(f.scheduleLeadMin),
      autoRejectSeconds: num(f.autoRejectSeconds),
      pickupInstructions: f.pickupInstructions || null,
      parkingNotes: f.parkingNotes || null,
    };
    const r = await run("save", () => api.patch("/restaurant/store/fulfilment", body), "Fulfilment settings saved");
    if (r.ok) reload();
  };
  const { role } = usePortal();
  return (
    <div className="row g-3">
      <div className="col-12">
        <Card title="Service mode" subtitle="What customers can order from this location right now. The order types below are an upper limit.">
          <ServiceModeControl mode={store.serviceMode} resumeAt={store.serviceModeResumeAt} disabled={role === "KITCHEN"} onChanged={reload} />
        </Card>
      </div>
      <div className="col-12">
        <OrderAutomationCard api={api} path="/restaurant/automation" canEdit={role === "OWNER" || role === "LOCATION_MANAGER"} />
      </div>
      <div className="col-lg-6">
        <Card title="Order types" className="h-100">
          <Switch label="Delivery" checked={f.deliveryEnabled} onChange={set("deliveryEnabled")} />
          <Switch label="Own drivers (restaurant delivers)" checked={f.ownDeliveryEnabled} onChange={set("ownDeliveryEnabled")} />
          {f.ownDeliveryEnabled && <MoneyInput label="Own delivery fee" value={f.ownDeliveryFee} onChange={set("ownDeliveryFee")} />}
          <Switch label="Pickup" checked={f.pickupEnabled} onChange={set("pickupEnabled")} />
          <Switch label="Scheduled orders" checked={f.scheduledEnabled} onChange={set("scheduledEnabled")} />
          <Switch label="Dine-in" checked={f.dineInEnabled} onChange={set("dineInEnabled")} className="mb-0" />
        </Card>
      </div>
      <div className="col-lg-6">
        <Card title="Prep times & limits" className="h-100">
          <div className="row">
            <NumberInput col={6} label="Delivery prep (min)" value={f.prepTimeMin} onChange={set("prepTimeMin")} min={0} />
            <NumberInput col={6} label="Pickup prep (min)" value={f.pickupPrepTimeMin} onChange={set("pickupPrepTimeMin")} min={0} />
            <NumberInput col={6} label="Delivery radius (km)" value={f.deliveryRadiusKm} onChange={set("deliveryRadiusKm")} min={0} />
            <MoneyInput col={6} label="Minimum order" value={f.minimumOrder} onChange={set("minimumOrder")} />
            <NumberInput col={6} label="Auto-reject after (s)" hint="Unaccepted orders are rejected after this" value={f.autoRejectSeconds} onChange={set("autoRejectSeconds")} min={30} />
            <NumberInput col={6} label="Scheduled lead time (min)" value={f.scheduleLeadMin} onChange={set("scheduleLeadMin")} min={0} />
            <NumberInput col={6} label="Slot length (min)" value={f.slotMinutes} onChange={set("slotMinutes")} min={5} />
            <NumberInput col={6} label="Max orders per slot" value={f.maxOrdersPerSlot} onChange={set("maxOrdersPerSlot")} min={1} />
          </div>
        </Card>
      </div>
      <div className="col-12">
        <Card title="Pickup">
          <div className="row">
            <TextArea col={6} label="Pickup instructions" rows={2} value={f.pickupInstructions} onChange={set("pickupInstructions")} />
            <TextArea col={6} label="Parking notes" rows={2} value={f.parkingNotes} onChange={set("parkingNotes")} />
          </div>
          <SaveBar busy={!!busy} onSave={save} />
        </Card>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ hours
function HoursTab({ store, reload }) {
  const api = useApi();
  const { busy, run } = useAction();
  const [days, setDays] = useState(null);
  useEffect(() => {
    const d = DAYS.map((_, i) => {
      const rows = (store.hours || []).filter((h) => h.dayOfWeek === i);
      const open = rows.filter((h) => !h.closed);
      return { closed: rows.length > 0 && open.length === 0, slots: open.length ? open.map((h) => ({ openTime: h.openTime, closeTime: h.closeTime })) : [{ openTime: "11:00", closeTime: "21:00" }] };
    });
    setDays(d);
  }, [store]);
  if (!days) return null;
  const upd = (i, patch) => setDays((ds) => ds.map((d, k) => (k === i ? { ...d, ...patch } : d)));
  const updSlot = (i, s, patch) => upd(i, { slots: days[i].slots.map((x, k) => (k === s ? { ...x, ...patch } : x)) });
  const save = async () => {
    const hours = days.flatMap((d, i) => (d.closed ? [{ dayOfWeek: i, closed: true }] : d.slots.filter((s) => s.openTime && s.closeTime).map((s) => ({ dayOfWeek: i, openTime: s.openTime, closeTime: s.closeTime, closed: false }))));
    const r = await run("save", () => api.patch("/restaurant/store/hours", { hours }), "Opening hours saved");
    if (r.ok) reload();
  };
  return (
    <Card title="Weekly opening hours" subtitle="Add a second interval for split shifts. A close time earlier than the open time means after midnight.">
      {days.map((d, i) => (
        <div key={i} className="row align-items-center py-8 border-bottom gx-2">
          <div className="col-md-2 fw-semibold">{DAYS[i]}</div>
          <div className="col-md-2">
            <Switch label={d.closed ? "Closed" : "Open"} checked={!d.closed} onChange={(v) => upd(i, { closed: !v })} className="mb-0" />
          </div>
          <div className="col-md-8">
            {!d.closed &&
              d.slots.map((s, k) => (
                <div key={k} className="d-flex align-items-center gap-2 mb-4">
                  <input type="time" className="form-control radius-8 w-auto" value={s.openTime} onChange={(e) => updSlot(i, k, { openTime: e.target.value })} />
                  <span>to</span>
                  <input type="time" className="form-control radius-8 w-auto" value={s.closeTime} onChange={(e) => updSlot(i, k, { closeTime: e.target.value })} />
                  {d.slots.length > 1 && <IconButton icon="solar:close-circle-outline" tone="danger" title="Remove interval" onClick={() => upd(i, { slots: d.slots.filter((_, z) => z !== k) })} />}
                  {k === d.slots.length - 1 && <IconButton icon="solar:add-circle-outline" tone="primary" title="Add interval" onClick={() => upd(i, { slots: [...d.slots, { openTime: "17:00", closeTime: "22:00" }] })} />}
                </div>
              ))}
          </div>
        </div>
      ))}
      <SaveBar busy={!!busy} onSave={save} />
    </Card>
  );
}

// ------------------------------------------------------------------ closures
function ClosuresTab() {
  const state = usePortalFetch("/restaurant/store/closures");
  const api = useApi();
  const confirm = useConfirm();
  const { busy, run } = useAction();
  const [f, setF] = useState({ startDate: "", endDate: "", reason: "" });
  const add = async () => {
    const r = await run("add", () => api.post("/restaurant/store/closures", { startDate: f.startDate, endDate: f.endDate || f.startDate, closed: true, reason: f.reason || undefined }), "Closure added");
    if (r.ok) {
      setF({ startDate: "", endDate: "", reason: "" });
      state.reload();
    }
  };
  const del = async (c) => {
    const ok = await confirm({ title: "Remove this closure?", confirmText: "Remove", danger: true });
    if (!ok.confirmed) return;
    const r = await run(c.id, () => api.del(`/restaurant/store/closures/${c.id}`), "Closure removed");
    if (r.ok) state.reload();
  };
  return (
    <div className="row g-3">
      <div className="col-lg-5">
        <Card title="Add holiday / closure" subtitle="The store shows as closed on these dates">
          <DateInput label="From" value={f.startDate} onChange={(v) => setF({ ...f, startDate: v })} />
          <DateInput label="To (optional)" value={f.endDate} onChange={(v) => setF({ ...f, endDate: v })} />
          <TextInput label="Reason" value={f.reason} onChange={(v) => setF({ ...f, reason: v })} placeholder="e.g. Christmas Day" />
          <Button loading={busy === "add"} disabled={!f.startDate} onClick={add}>
            Add closure
          </Button>
        </Card>
      </div>
      <div className="col-lg-7">
        <Card title="Upcoming & past closures" noPadding>
          <Async state={state} empty={(d) => d.length === 0} emptyProps={{ title: "No closures", text: "Holiday closures you add will appear here." }}>
            {(rows) => (
              <ul className="list-unstyled mb-0">
                {rows.map((c) => (
                  <li key={c.id} className="d-flex justify-content-between align-items-center px-20 py-12 border-bottom">
                    <div>
                      <div className="fw-semibold">
                        {fmtDate(c.startDate)}
                        {c.endDate && c.endDate !== c.startDate ? ` – ${fmtDate(c.endDate)}` : ""}
                      </div>
                      <div className="text-secondary-light text-sm">{c.reason || (c.closed ? "Closed" : `Special hours ${c.openTime}-${c.closeTime}`)}</div>
                    </div>
                    <IconButton icon="solar:trash-bin-trash-outline" tone="danger" title="Remove" onClick={() => del(c)} />
                  </li>
                ))}
              </ul>
            )}
          </Async>
        </Card>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ stations
function StationsTab() {
  const state = usePortalFetch("/restaurant/store/stations");
  const api = useApi();
  const confirm = useConfirm();
  const { busy, run } = useAction();
  const [name, setName] = useState("");
  const add = async () => {
    const r = await run("add", () => api.post("/restaurant/store/stations", { name: name.trim() }), "Station added");
    if (r.ok) {
      setName("");
      state.reload();
    }
  };
  const rename = async (s) => {
    const r = await confirm({ title: "Rename station", prompt: { label: "Name", defaultValue: s.name, required: true }, confirmText: "Save" });
    if (!r.confirmed) return;
    const res = await run(s.id, () => api.patch(`/restaurant/store/stations/${s.id}`, { name: r.value.trim() }), "Station renamed");
    if (res.ok) state.reload();
  };
  const del = async (s) => {
    const r = await confirm({ title: `Delete ${s.name}?`, danger: true, confirmText: "Delete" });
    if (!r.confirmed) return;
    const res = await run(s.id, () => api.del(`/restaurant/store/stations/${s.id}`), "Station deleted");
    if (res.ok) state.reload();
  };
  return (
    <Card title="Kitchen stations" subtitle="Items are routed to a station on the kitchen display">
      <div className="d-flex gap-2 mb-16" style={{ maxWidth: 420 }}>
        <input className="form-control radius-8" placeholder="New station (e.g. Grill)" value={name} onChange={(e) => setName(e.target.value)} />
        <Button loading={busy === "add"} disabled={!name.trim()} onClick={add}>
          Add
        </Button>
      </div>
      <Async state={state} empty={(d) => d.length === 0} emptyProps={{ title: "No stations" }}>
        {(rows) => (
          <ul className="list-unstyled mb-0">
            {rows.map((s) => (
              <li key={s.id} className="d-flex justify-content-between align-items-center py-10 border-bottom">
                <span className="fw-medium">{s.name}</span>
                <div className="d-flex gap-2">
                  <IconButton icon="solar:pen-outline" tone="primary" title="Rename" onClick={() => rename(s)} />
                  <IconButton icon="solar:trash-bin-trash-outline" tone="danger" title="Delete" onClick={() => del(s)} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Async>
    </Card>
  );
}

// ------------------------------------------------------------------ kitchen & alerts
function AlertsTab({ store, reload }) {
  const api = useApi();
  const { busy, run } = useAction();
  const [k, setK] = useState({});
  const [n, setN] = useState({});
  useEffect(() => {
    setK({ largeFont: false, soundOn: true, recentPickedUpMinutes: 15, autoLoadPrep: false, capacityTickets: 12, ...(store.kdsSettings || {}) });
    setN({ newOrderSound: true, volume: 80, repeatSeconds: 30, emailOnNewOrder: false, smsOnNewOrder: false, lowStockAlerts: true, ...(store.notificationSettings || {}) });
  }, [store]);
  const saveK = async () => {
    const r = await run("k", () => api.patch("/restaurant/store/kds", { ...k, recentPickedUpMinutes: num(k.recentPickedUpMinutes), capacityTickets: num(k.capacityTickets) }), "Kitchen display settings saved");
    if (r.ok) reload();
  };
  const saveN = async () => {
    const r = await run("n", () => api.patch("/restaurant/store/notifications", { settings: { ...n, volume: num(n.volume), repeatSeconds: num(n.repeatSeconds) } }), "Notification settings saved");
    if (r.ok) reload();
  };
  return (
    <div className="row g-3">
      <div className="col-lg-6">
        <Card title="Kitchen display" className="h-100">
          <Switch label="Large font" checked={k.largeFont} onChange={(v) => setK({ ...k, largeFont: v })} />
          <Switch label="Sound on new tickets" checked={k.soundOn} onChange={(v) => setK({ ...k, soundOn: v })} />
          <Switch label="Auto-start preparing when accepted" checked={k.autoLoadPrep} onChange={(v) => setK({ ...k, autoLoadPrep: v })} />
          <NumberInput label="Show picked-up tickets for (min)" value={k.recentPickedUpMinutes} onChange={(v) => setK({ ...k, recentPickedUpMinutes: v })} min={0} />
          <NumberInput label="Kitchen capacity (tickets at once)" value={k.capacityTickets} onChange={(v) => setK({ ...k, capacityTickets: v })} min={1} />
          <SaveBar busy={busy === "k"} onSave={saveK} />
        </Card>
      </div>
      <div className="col-lg-6">
        <Card title="New-order alerts" className="h-100">
          <Switch label="Play sound for new orders" checked={n.newOrderSound} onChange={(v) => setN({ ...n, newOrderSound: v })} />
          <Switch label="Email on new order" checked={n.emailOnNewOrder} onChange={(v) => setN({ ...n, emailOnNewOrder: v })} />
          <Switch label="SMS on new order" checked={n.smsOnNewOrder} onChange={(v) => setN({ ...n, smsOnNewOrder: v })} />
          <Switch label="Low-stock alerts" checked={n.lowStockAlerts} onChange={(v) => setN({ ...n, lowStockAlerts: v })} />
          <div className="row">
            <NumberInput col={6} label="Volume (0-100)" value={n.volume} onChange={(v) => setN({ ...n, volume: v })} min={0} max={100} />
            <NumberInput col={6} label="Repeat alert every (s)" value={n.repeatSeconds} onChange={(v) => setN({ ...n, repeatSeconds: v })} min={0} />
          </div>
          <SaveBar busy={busy === "n"} onSave={saveN} />
        </Card>
      </div>
    </div>
  );
}

export default function Store() {
  const state = usePortalFetch("/restaurant/store");
  useRealtimeReload(() => state.reload(), ["store.updated"]);
  const [params] = useSearchParams();
  const [tab, setTab] = useState(TAB_KEYS.includes(params.get("tab")) ? params.get("tab") : "profile"); // /portal/store?tab=documents opens the documents
  return (
    <PortalPage title="Store settings">
      <Async state={state}>
        {(store) => (
          <>
            <VerificationBanner
              verification={store.verification}
              className="mb-24"
              action={store.verification?.status === "PENDING" && store.verification?.method !== "AUTOMATIC" && tab !== "documents" ? { label: "Upload documents", onClick: () => setTab("documents") } : undefined}
            />
            <Tabs
              active={tab}
              onChange={setTab}
              tabs={[
                { key: "profile", label: "Profile", content: <ProfileTab store={store} reload={state.reload} /> },
                { key: "documents", label: "Documents", content: <DocumentsTab /> },
                { key: "fulfilment", label: "Ordering & prep times", content: <FulfilmentTab store={store} reload={state.reload} /> },
                { key: "hours", label: "Opening hours", content: <HoursTab store={store} reload={state.reload} /> },
                { key: "closures", label: "Holiday closures", content: <ClosuresTab /> },
                { key: "stations", label: "Stations", content: <StationsTab /> },
                { key: "alerts", label: "Kitchen & alerts", content: <AlertsTab store={store} reload={state.reload} /> },
              ]}
            />
          </>
        )}
      </Async>
    </PortalPage>
  );
}
