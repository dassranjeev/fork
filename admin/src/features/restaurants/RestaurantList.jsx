import React from "react";
import { Link, useNavigate } from "react-router-dom";
import { usePagedList } from "../../lib/hooks";
import { useAuth } from "../../lib/auth";
import { fmtDate } from "../../lib/format";
import { ServiceModeBadge } from "../portal/ServiceMode";
import { Card, DataTable, FilterSelect, ListToolbar, PageHeader, StatusBadge } from "../../ui";
import OpenPanelButton from "./OpenPanelButton";
import { RESTAURANT_STATUSES, useLookups } from "./shared";

export default function RestaurantList() {
  const nav = useNavigate();
  const { can } = useAuth();
  const { cities, zones, tiers, zoneName, tierName } = useLookups();
  const list = usePagedList("/admin/restaurants", { filters: { status: "", cityId: "", zoneId: "", commissionTierId: "", hasExpiringDocs: "", expiringDays: "" }, sortBy: "createdAt" });
  const f = list.filters;

  const columns = [
    {
      key: "name",
      title: "Restaurant",
      sortable: true,
      render: (r) => (
        <div>
          <Link to={`/restaurants/${r.id}`} className="fw-semibold text-primary-light" onClick={(e) => e.stopPropagation()}>
            {r.name}
          </Link>
          <div className="text-secondary-light text-xs">{r.email || r.phone || r.slug}</div>
        </div>
      ),
    },
    { key: "city", title: "City / Zone", render: (r) => [r.city, zoneName(r.zoneId)].filter(Boolean).join(" · ") || "—" },
    { key: "status", title: "Status", render: (r) => <StatusBadge status={r.status} /> },
    {
      key: "acceptingOrders",
      title: "Service mode",
      render: (r) => (r.status === "LIVE" ? <ServiceModeBadge mode={r.serviceMode} /> : <span className="text-secondary-light">—</span>),
    },
    { key: "rating", title: "Rating", sortable: true, render: (r) => (r.ratingCount ? `${Number(r.rating).toFixed(1)} (${r.ratingCount})` : "—") },
    { key: "commissionTierId", title: "Commission", render: (r) => tierName(r.commissionTierId) || "—" },
    { key: "reliabilityScore", title: "Reliability", render: (r) => (r.reliabilityScore != null ? `${Math.round(r.reliabilityScore)}` : "—") },
    { key: "createdAt", title: "Added", sortable: true, render: (r) => fmtDate(r.createdAt) },
    { key: "panel", title: "", render: (r) => <OpenPanelButton restaurant={r} label="Open panel" /> },
  ];

  return (
    <>
      <PageHeader
        title="Restaurants"
        subtitle="All restaurant locations on the platform"
        crumbs={[{ label: "Restaurants" }]}
        actions={
          can("restaurants", "create") && (
            <Link to="/restaurants/new" className="btn btn-primary-600 btn-sm radius-8 px-16 py-8">
              + Add restaurant
            </Link>
          )
        }
      />
      <Card>
        <ListToolbar
          list={list}
          placeholder="Search name, phone, email…"
          filters={
            <>
              <FilterSelect value={f.status} onChange={(v) => list.setFilter("status", v)} options={RESTAURANT_STATUSES} placeholder="All statuses" />
              <FilterSelect
                value={f.cityId}
                onChange={(v) => list.setFilters({ cityId: v, zoneId: "" })}
                options={cities.map((c) => ({ value: c.id, label: c.name }))}
                placeholder="All cities"
              />
              <FilterSelect
                value={f.zoneId}
                onChange={(v) => list.setFilter("zoneId", v)}
                options={zones.filter((z) => !f.cityId || z.cityId === f.cityId).map((z) => ({ value: z.id, label: z.name }))}
                placeholder="All zones"
              />
              <FilterSelect value={f.commissionTierId} onChange={(v) => list.setFilter("commissionTierId", v)} options={tiers.map((t) => ({ value: t.id, label: t.name }))} placeholder="Any tier" />
              <FilterSelect
                value={f.hasExpiringDocs ? f.expiringDays || "30" : ""}
                onChange={(v) => list.setFilters(v ? { hasExpiringDocs: "true", expiringDays: v } : { hasExpiringDocs: "", expiringDays: "" })}
                options={[
                  { value: "14", label: "Docs expiring in 14 days" },
                  { value: "30", label: "Docs expiring in 30 days" },
                  { value: "60", label: "Docs expiring in 60 days" },
                ]}
                placeholder="Documents: any"
              />
            </>
          }
        />
        <DataTable columns={columns} {...list.tableProps} error={list.error} onRetry={list.reload} onRowClick={(r) => nav(`/restaurants/${r.id}`)} emptyTitle="No restaurants match these filters" />
      </Card>
    </>
  );
}
