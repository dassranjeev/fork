import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Icon } from "@iconify/react/offline";
import { toast } from "react-toastify";
import { Avatar, Badge, Button, Card, DataTable, FilterSelect, FormModal, FormRow, ListToolbar, PageHeader, Select, StatusBadge, TextInput } from "../../ui";
import { act, http } from "../../lib/api";
import { useFetch, useForm, usePagedList, useSubmit } from "../../lib/hooks";
import { useAuth } from "../../lib/auth";
import { num, titleCase } from "../../lib/format";
import { RatingValue } from "../ratings/shared";
import { fmtDay as fmtDate } from "./shared";
import { DRIVER_STATUSES, VEHICLES, acceptanceTone, downloadText, useCities } from "./shared";

function AddDriverModal({ open, onClose, onDone }) {
  const f = useForm({ firstName: "", lastName: "", email: "", phone: "", cityId: "", vehicleType: "CAR" });
  const { cities, options } = useCities();
  const { busy, run } = useSubmit();
  const v = f.values;
  const submit = () =>
    run(() => http.post("/admin/drivers", { ...v, cityId: v.cityId || cities[0]?.id }), {
      success: "Driver created",
      onDone: (r) => {
        if (r?.temporaryPassword) toast.info(`Temporary password: ${r.temporaryPassword}`, { autoClose: false });
        f.reset();
        onDone(r);
      },
    });
  return (
    <FormModal open={open} onClose={onClose} title="Add driver" onSubmit={submit} busy={busy} submitText="Create driver" disabled={!v.firstName || !v.lastName || !v.email || !v.phone}>
      <FormRow>
        <TextInput col={6} label="First name" required {...f.bind("firstName")} />
        <TextInput col={6} label="Last name" required {...f.bind("lastName")} />
        <TextInput col={6} label="Email" type="email" required {...f.bind("email")} />
        <TextInput col={6} label="Phone" required placeholder="+14165550100" {...f.bind("phone")} />
        <Select col={6} label="City" allowEmpty={false} options={options} {...f.bind("cityId")} value={v.cityId || cities[0]?.id || ""} />
        <Select col={6} label="Vehicle" allowEmpty={false} options={VEHICLES} {...f.bind("vehicleType")} />
      </FormRow>
    </FormModal>
  );
}

export default function DriversList() {
  const nav = useNavigate();
  const { can } = useAuth();
  const list = usePagedList("/admin/drivers", { filters: { status: "", vehicleType: "", online: "" } });
  const summary = useFetch("/admin/drivers/summary", null, { refreshMs: 30000 });
  const [add, setAdd] = useState(false);
  const by = summary.data?.byStatus || {};
  const total = Object.values(by).reduce((a, b) => a + b, 0);

  const exportCsv = async () => {
    const r = await act(() => http.get("/admin/drivers/export", list.params));
    if (r?.csv) downloadText("drivers.csv", r.csv);
  };

  const cols = [
    {
      key: "name",
      title: "Driver",
      render: (d) => (
        <div className="d-flex align-items-center gap-12">
          <Avatar name={d.name} size={36} />
          <div>
            <div className="fw-semibold">{d.name}</div>
            <div className="text-secondary-light text-xs">{d.email}</div>
          </div>
        </div>
      ),
    },
    { key: "status", title: "Status", render: (d) => <StatusBadge status={d.status} /> },
    { key: "vehicleType", title: "Vehicle", render: (d) => titleCase(d.vehicleType) },
    {
      key: "isOnline",
      title: "Live",
      render: (d) => (d.onTrip ? <StatusBadge status="On trip" tone="purple" /> : d.isOnline ? <StatusBadge status="Online" tone="success" /> : <StatusBadge status="Offline" tone="neutral" />),
    },
    { key: "rating", title: "Rating", sortable: true, render: (d) => <RatingValue value={d.ratingCount >= 5 ? d.rating : null} count={d.ratingCount || undefined} /> },
    {
      key: "acceptanceRate",
      title: "Acceptance (14d)",
      render: (d) => {
        const a = d.acceptance;
        return (
          <div className="d-flex align-items-center gap-8">
            <Badge tone={acceptanceTone(d.acceptanceRate)}>{num(d.acceptanceRate)}%</Badge>
            <span className="text-secondary-light text-xs">{a ? `${a.accepted} acc / ${a.declined} dec${a.expired ? ` / ${a.expired} exp` : ""}` : ""}</span>
          </div>
        );
      },
    },
    { key: "totalTrips", title: "Trips", render: (d) => num(d.totalTrips) },
    { key: "backgroundCheckStatus", title: "Background", render: (d) => <StatusBadge status={d.backgroundCheckStatus} /> },
    { key: "nextDocExpiry", title: "Next doc expiry", render: (d) => fmtDate(d.nextDocExpiry) },
  ];

  const pill = (active) => `btn btn-sm radius-8 ${active ? "btn-primary-600" : "btn-outline-neutral-300 text-primary-light"}`;

  return (
    <>
      <PageHeader
        title="Drivers"
        subtitle="All couriers across every stage of onboarding"
        crumbs={[{ label: "Drivers" }]}
        actions={can("drivers", "create") && <Button icon="solar:user-plus-outline" onClick={() => setAdd(true)}>Add driver</Button>}
      />
      <div className="d-flex flex-wrap gap-2 mb-20">
        <button type="button" className={pill(!list.filters.status)} onClick={() => list.setFilter("status", "")}>
          All <span className="ms-1 opacity-75">{total}</span>
        </button>
        {DRIVER_STATUSES.map((s) => (
          <button key={s} type="button" className={pill(list.filters.status === s)} onClick={() => list.setFilter("status", s)}>
            {titleCase(s)} <span className="ms-1 opacity-75">{by[s] || 0}</span>
          </button>
        ))}
      </div>
      <div className="row gy-3 mb-20">
        {[
          ["Online now", summary.data?.online, "solar:wi-fi-router-outline", "success"],
          ["On a trip", summary.data?.onTrip, "solar:scooter-outline", "purple"],
          ["Docs expiring (30d)", summary.data?.docsExpiring30d, "solar:document-add-outline", "warning"],
          ["Open SOS", summary.data?.openSos, "solar:danger-triangle-outline", "danger"],
        ].map(([l, v, i, t]) => (
          <div key={l} className="col-6 col-xl-3">
            <div className="card radius-12 border-0 shadow-sm">
              <div className="card-body p-16 d-flex align-items-center gap-12">
                <span className={`w-40-px h-40-px rounded-circle d-flex align-items-center justify-content-center ${t === "purple" ? "bg-lilac-100 text-lilac-600" : `bg-${t}-100 text-${t}-600`}`}>
                  <Icon icon={i} className="text-xl" />
                </span>
                <div>
                  <div className="text-secondary-light text-sm">{l}</div>
                  <div className="fw-semibold text-lg">{v ?? "—"}</div>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
      <Card>
        <ListToolbar
          list={list}
          placeholder="Search name, email, phone…"
          onExport={can("drivers", "export") ? exportCsv : undefined}
          filters={
            <>
              <FilterSelect value={list.filters.vehicleType} onChange={(v) => list.setFilter("vehicleType", v)} options={VEHICLES} placeholder="Any vehicle" />
              <FilterSelect
                value={list.filters.online}
                onChange={(v) => list.setFilter("online", v)}
                options={[
                  { value: "true", label: "Online" },
                  { value: "false", label: "Offline" },
                ]}
                placeholder="Online status"
              />
            </>
          }
        />
        <DataTable columns={cols} {...list.tableProps} error={list.error} onRetry={list.reload} onRowClick={(d) => nav(`/drivers/${d.id}`)} emptyTitle="No drivers match these filters" />
      </Card>
      <AddDriverModal
        open={add}
        onClose={() => setAdd(false)}
        onDone={(r) => {
          setAdd(false);
          list.reload();
          summary.reload();
          if (r?.id) nav(`/drivers/${r.id}`);
        }}
      />
    </>
  );
}
