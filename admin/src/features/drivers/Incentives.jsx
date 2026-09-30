import React, { useState } from "react";
import { Badge, Button, Card, DataTable, DateInput, FilterSelect, FormModal, FormRow, ListToolbar, NumberInput, PageHeader, Select, StatusBadge, Switch, TextArea, TextInput, useConfirm, IconButton } from "../../ui";
import { act, http } from "../../lib/api";
import { useForm, usePagedList, useSubmit } from "../../lib/hooks";
import { useAuth } from "../../lib/auth";
import { fmtDateTime, money, titleCase } from "../../lib/format";
import { INCENTIVE_TYPES, useZones } from "./shared";

const blank = { name: "", description: "", type: "PEAK_BOOST", zoneId: "", amountPerTrip: "", percentBoost: "", questTrips: "", bonusAmount: "", startsAt: null, endsAt: null, active: true };

function IncentiveModal({ item, onClose, onDone }) {
  const { options } = useZones();
  const f = useForm(item ? { ...blank, ...item, zoneId: item.zoneId || "", questTrips: item.questTrips ?? "" } : blank);
  const { busy, run } = useSubmit();
  const v = f.values;
  const editing = !!item;
  const submit = () => {
    const body = {
      name: v.name,
      description: v.description || undefined,
      zoneId: v.zoneId || null,
      amountPerTrip: v.amountPerTrip === "" ? undefined : Number(v.amountPerTrip),
      percentBoost: v.percentBoost === "" ? undefined : Number(v.percentBoost),
      questTrips: v.questTrips === "" ? undefined : Number(v.questTrips),
      bonusAmount: v.bonusAmount === "" ? undefined : Number(v.bonusAmount),
      startsAt: v.startsAt,
      endsAt: v.endsAt,
      active: v.active,
    };
    if (!editing) body.type = v.type;
    return run(() => (editing ? http.patch(`/admin/drivers/incentives/${item.id}`, body) : http.post("/admin/drivers/incentives", body)), { success: editing ? "Incentive updated" : "Incentive created", onDone });
  };
  return (
    <FormModal open onClose={onClose} title={editing ? "Edit incentive" : "New incentive"} size="lg" onSubmit={submit} busy={busy} disabled={!v.name || !v.startsAt || !v.endsAt}>
      <FormRow>
        <TextInput col={8} label="Name" required {...f.bind("name")} />
        <Select col={4} label="Type" allowEmpty={false} options={INCENTIVE_TYPES} disabled={editing} {...f.bind("type")} />
        <Select col={6} label="Zone" placeholder="All zones" options={options} {...f.bind("zoneId")} />
        <div className="col-md-6 d-flex align-items-end"><Switch label="Active" checked={v.active} onChange={(x) => f.set("active", x)} /></div>
        <DateInput col={6} label="Starts" withTime required {...f.bind("startsAt")} />
        <DateInput col={6} label="Ends" withTime required {...f.bind("endsAt")} />
        <NumberInput col={3} label="Boost per trip" prefix="$" min={0} {...f.bind("amountPerTrip")} />
        <NumberInput col={3} label="Percent boost" suffix="%" min={0} {...f.bind("percentBoost")} />
        <NumberInput col={3} label="Quest trips" min={1} {...f.bind("questTrips")} />
        <NumberInput col={3} label="Quest bonus" prefix="$" min={0} {...f.bind("bonusAmount")} />
        <TextArea col={12} label="Description" rows={2} {...f.bind("description")} />
      </FormRow>
    </FormModal>
  );
}

function SupplyAlertModal({ onClose, onDone }) {
  const { options } = useZones();
  const f = useForm({ zoneId: "", boostAmount: 3, durationMinutes: 60, message: "", includeOnline: true });
  const { busy, run } = useSubmit();
  const v = f.values;
  return (
    <FormModal open onClose={onClose} title="Broadcast supply alert" submitText="Send alert" onSubmit={() => run(() => http.post("/admin/drivers/supply-alert", { ...v, message: v.message || undefined }), { success: "Supply alert sent", onDone })} busy={busy} disabled={!v.zoneId || v.boostAmount === ""}>
      <p className="text-secondary-light text-sm">Pushes a live boost to drivers of the zone (and online drivers) when demand outstrips supply.</p>
      <FormRow>
        <Select col={12} label="Zone" required options={options} {...f.bind("zoneId")} />
        <NumberInput col={6} label="Boost per trip" prefix="$" min={0} required {...f.bind("boostAmount")} />
        <NumberInput col={6} label="Duration (minutes)" min={5} max={720} {...f.bind("durationMinutes")} />
        <TextInput col={12} label="Message" placeholder="Busy in your area, boost active!" {...f.bind("message")} />
        <Switch col={12} label="Also notify drivers who are online in any zone" checked={v.includeOnline} onChange={(x) => f.set("includeOnline", x)} />
      </FormRow>
    </FormModal>
  );
}

export default function Incentives() {
  const { can } = useAuth();
  const confirm = useConfirm();
  const { nameOf } = useZones();
  const list = usePagedList("/admin/drivers/incentives", { filters: { type: "", active: "" } });
  const [modal, setModal] = useState(null);
  const done = () => { setModal(null); list.reload(); };

  const remove = async (i) => {
    const r = await confirm({ title: `Delete "${i.name}"?`, danger: true, confirmText: "Delete" });
    if (r.confirmed && (await act(() => http.del(`/admin/drivers/incentives/${i.id}`), { success: "Incentive deleted" }) !== undefined)) list.reload();
  };
  const toggle = async (i) => {
    if ((await act(() => http.patch(`/admin/drivers/incentives/${i.id}`, { active: !i.active }), { success: i.active ? "Paused" : "Activated" })) !== undefined) list.reload();
  };
  const now = Date.now();
  const cols = [
    { key: "name", title: "Incentive", render: (i) => (<div><div className="fw-semibold">{i.name}</div>{i.description && <div className="text-secondary-light text-xs">{i.description}</div>}</div>) },
    { key: "type", title: "Type", render: (i) => <Badge tone={i.type === "SUPPLY_ALERT" ? "danger" : "primary"}>{titleCase(i.type)}</Badge> },
    { key: "zone", title: "Zone", render: (i) => (i.zoneId ? nameOf(i.zoneId) : i.driverId ? "Single driver" : "All zones") },
    {
      key: "reward",
      title: "Reward",
      render: (i) => [i.amountPerTrip > 0 && `${money(i.amountPerTrip)}/trip`, i.percentBoost > 0 && `+${i.percentBoost}%`, i.questTrips && `${i.questTrips} trips → ${money(i.bonusAmount)}`].filter(Boolean).join(" · ") || "—",
    },
    { key: "window", title: "Window", render: (i) => (<span className="text-sm">{fmtDateTime(i.startsAt)}<br />→ {fmtDateTime(i.endsAt)}</span>) },
    {
      key: "state",
      title: "State",
      render: (i) => (!i.active ? <StatusBadge status="Paused" tone="neutral" /> : new Date(i.endsAt).getTime() < now ? <StatusBadge status="Ended" tone="neutral" /> : new Date(i.startsAt).getTime() > now ? <StatusBadge status="Scheduled" /> : <StatusBadge status="Live" />),
    },
    {
      key: "a",
      title: "",
      align: "right",
      render: (i) => (
        <div className="d-flex gap-2 justify-content-end">
          {can("drivers", "edit") && <IconButton icon={i.active ? "solar:pause-outline" : "solar:play-outline"} title={i.active ? "Pause" : "Activate"} tone="warning" onClick={() => toggle(i)} />}
          {can("drivers", "edit") && i.type !== "SUPPLY_ALERT" && <IconButton icon="solar:pen-outline" title="Edit" tone="primary" onClick={() => setModal({ item: i })} />}
          {can("drivers", "delete") && <IconButton icon="solar:trash-bin-minimalistic-outline" title="Delete" tone="danger" onClick={() => remove(i)} />}
        </div>
      ),
    },
  ];
  return (
    <>
      <PageHeader
        title="Incentives and boosts"
        subtitle="Peak boosts, quests, weather and supply alerts"
        crumbs={[{ label: "Drivers", to: "/drivers" }, { label: "Incentives" }]}
        actions={can("drivers", "create") && (
          <>
            <Button variant="outline" icon="solar:bell-bing-outline" onClick={() => setModal({ alert: true })}>Supply alert</Button>
            <Button icon="solar:add-circle-outline" onClick={() => setModal({ item: null })}>New incentive</Button>
          </>
        )}
      />
      <Card>
        <ListToolbar
          list={list}
          placeholder="Search incentives…"
          filters={
            <>
              <FilterSelect value={list.filters.type} onChange={(v) => list.setFilter("type", v)} options={INCENTIVE_TYPES} placeholder="Any type" />
              <FilterSelect value={list.filters.active} onChange={(v) => list.setFilter("active", v)} options={[{ value: "true", label: "Active" }, { value: "false", label: "Paused" }]} placeholder="Any state" />
            </>
          }
        />
        <DataTable columns={cols} {...list.tableProps} error={list.error} onRetry={list.reload} emptyTitle="No incentives yet" emptyText="Create a boost or quest to attract couriers to busy zones." />
      </Card>
      {modal && modal.item !== undefined && <IncentiveModal item={modal.item} onClose={() => setModal(null)} onDone={done} />}
      {modal?.alert && <SupplyAlertModal onClose={() => setModal(null)} onDone={done} />}
    </>
  );
}
