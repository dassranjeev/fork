import React, { useState } from "react";
import { Button, Card, DataTable, DateInput, FilterSelect, FormModal, FormRow, IconButton, NumberInput, PageHeader, Select, StatusBadge, Tabs, useConfirm } from "../../ui";
import { act, http } from "../../lib/api";
import { useForm, usePagedList, useSubmit } from "../../lib/hooks";
import { useAuth } from "../../lib/auth";
import { fmtDateTime, num } from "../../lib/format";
import { useZones } from "./shared";

function SlotModal({ slot, onClose, onDone }) {
  const { options } = useZones();
  const f = useForm(slot ? { zoneId: slot.zoneId, startsAt: slot.startsAt, endsAt: slot.endsAt, capacity: slot.capacity ?? slot.slotCapacity ?? 1 } : { zoneId: "", startsAt: null, endsAt: null, capacity: 5 });
  const { busy, run } = useSubmit();
  const v = f.values;
  const submit = () =>
    run(() => (slot ? http.patch(`/admin/drivers/shifts/slots/${slot.id}`, { startsAt: v.startsAt, endsAt: v.endsAt, capacity: Number(v.capacity) }) : http.post("/admin/drivers/shifts/slots", { ...v, capacity: Number(v.capacity) })), {
      success: slot ? "Slot updated" : "Slot created",
      onDone,
    });
  return (
    <FormModal open onClose={onClose} title={slot ? "Edit shift slot" : "New shift slot"} onSubmit={submit} busy={busy} disabled={!v.zoneId || !v.startsAt || !v.endsAt || !v.capacity}>
      <FormRow>
        <Select col={12} label="Zone" required disabled={!!slot} options={options} {...f.bind("zoneId")} />
        <DateInput col={6} label="Starts" withTime required {...f.bind("startsAt")} />
        <DateInput col={6} label="Ends" withTime required {...f.bind("endsAt")} />
        <NumberInput col={6} label="Capacity (drivers)" min={1} max={500} step={1} required {...f.bind("capacity")} />
      </FormRow>
    </FormModal>
  );
}

function Slots() {
  const { can } = useAuth();
  const confirm = useConfirm();
  const { options, nameOf } = useZones();
  const list = usePagedList("/admin/drivers/shifts/slots", { filters: { zoneId: "" } });
  const [modal, setModal] = useState(undefined);
  const cancel = async (s) => {
    const r = await confirm({ title: "Cancel this slot?", message: "Booked drivers will lose the shift.", danger: true, confirmText: "Cancel slot" });
    if (r.confirmed && (await act(() => http.del(`/admin/drivers/shifts/slots/${s.id}`), { success: "Slot cancelled" })) !== undefined) list.reload();
  };
  const cols = [
    { key: "zone", title: "Zone", render: (s) => s.zoneName || nameOf(s.zoneId) },
    { key: "startsAt", title: "Starts", render: (s) => fmtDateTime(s.startsAt) },
    { key: "endsAt", title: "Ends", render: (s) => fmtDateTime(s.endsAt) },
    { key: "booked", title: "Booked", render: (s) => `${num(s.booked ?? 0)} / ${num(s.capacity ?? s.slotCapacity ?? 0)}` },
    { key: "status", title: "Status", render: (s) => <StatusBadge status={s.status || "OPEN"} /> },
    {
      key: "a",
      title: "",
      align: "right",
      render: (s) => (
        <div className="d-flex gap-2 justify-content-end">
          {can("drivers", "edit") && <IconButton icon="solar:pen-outline" tone="primary" title="Edit" onClick={() => setModal(s)} />}
          {can("drivers", "delete") && <IconButton icon="solar:close-circle-outline" tone="danger" title="Cancel slot" onClick={() => cancel(s)} />}
        </div>
      ),
    },
  ];
  return (
    <>
      <div className="d-flex flex-wrap justify-content-between gap-3 mb-20">
        <FilterSelect value={list.filters.zoneId} onChange={(v) => list.setFilter("zoneId", v)} options={options} placeholder="All zones" />
        {can("drivers", "create") && <Button icon="solar:add-circle-outline" onClick={() => setModal(null)}>New slot</Button>}
      </div>
      <DataTable columns={cols} {...list.tableProps} error={list.error} onRetry={list.reload} emptyTitle="No open slots" emptyText="Publish slots so drivers can book guaranteed shifts in busy zones." />
      {modal !== undefined && <SlotModal slot={modal} onClose={() => setModal(undefined)} onDone={() => { setModal(undefined); list.reload(); }} />}
    </>
  );
}

function Booked() {
  const { options, nameOf } = useZones();
  const list = usePagedList("/admin/drivers/shifts", { filters: { zoneId: "", status: "" } });
  const cols = [
    { key: "driver", title: "Driver", render: (s) => s.driverName || s.driver?.name || s.driverId?.slice(0, 8) || "—" },
    { key: "zone", title: "Zone", render: (s) => s.zoneName || nameOf(s.zoneId) },
    { key: "startsAt", title: "Starts", render: (s) => fmtDateTime(s.startsAt) },
    { key: "endsAt", title: "Ends", render: (s) => fmtDateTime(s.endsAt) },
    { key: "status", title: "Status", render: (s) => <StatusBadge status={s.status} /> },
  ];
  return (
    <>
      <div className="d-flex flex-wrap gap-3 mb-20">
        <FilterSelect value={list.filters.zoneId} onChange={(v) => list.setFilter("zoneId", v)} options={options} placeholder="All zones" />
        <FilterSelect value={list.filters.status} onChange={(v) => list.setFilter("status", v)} options={["BOOKED", "STARTED", "COMPLETED", "MISSED", "CANCELLED"]} placeholder="Any status" />
      </div>
      <DataTable columns={cols} {...list.tableProps} error={list.error} onRetry={list.reload} emptyTitle="No booked shifts" emptyText="Shifts appear here once drivers book open slots." />
    </>
  );
}

export default function Shifts() {
  return (
    <>
      <PageHeader title="Shifts" subtitle="Open slots by zone and the shifts drivers booked" crumbs={[{ label: "Drivers", to: "/drivers" }, { label: "Shifts" }]} />
      <Card>
        <Tabs
          tabs={[
            { key: "slots", label: "Open slots", content: <Slots /> },
            { key: "booked", label: "Booked shifts", content: <Booked /> },
          ]}
        />
      </Card>
    </>
  );
}
