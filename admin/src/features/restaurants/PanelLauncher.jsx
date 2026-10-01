import React from "react";
import { Link } from "react-router-dom";
import { usePagedList } from "../../lib/hooks";
import { Card, DataTable, ListToolbar, PageHeader, StatusBadge } from "../../ui";
import OpenPanelButton from "./OpenPanelButton";

const modeLabel = (r) => {
  const m = r.serviceMode || r.operatingMode;
  return m ? String(m).replace(/_/g, " ") : r.status === "LIVE" ? (r.acceptingOrders ? "Accepting orders" : "Not accepting") : "—";
};

/** Pick any restaurant and walk through its portal panels (dashboard, orders, KDS, menu, finance...). */
export default function PanelLauncher() {
  const list = usePagedList("/admin/restaurants", { filters: {}, sortBy: "name" });
  const columns = [
    {
      key: "name",
      title: "Restaurant",
      sortable: true,
      render: (r) => (
        <div>
          <Link to={`/restaurants/${r.id}`} className="fw-semibold text-primary-light">
            {r.name}
          </Link>
          <div className="text-secondary-light text-xs">{r.email || r.phone || r.slug}</div>
        </div>
      ),
    },
    { key: "city", title: "City", render: (r) => r.city || "—" },
    { key: "status", title: "Status", render: (r) => <StatusBadge status={r.status} /> },
    { key: "mode", title: "Service mode", render: modeLabel },
    { key: "panel", title: "", render: (r) => <OpenPanelButton restaurant={r} label="Open panel" /> },
  ];
  return (
    <>
      <PageHeader
        title="Restaurant panels"
        subtitle="Open the restaurant portal exactly as its owner sees it. Every session is audited and expires after 2 hours."
        crumbs={[{ label: "Restaurants", to: "/restaurants" }, { label: "Panels" }]}
      />
      <Card>
        <ListToolbar list={list} placeholder="Search restaurants by name, phone, email…" />
        <DataTable columns={columns} {...list.tableProps} error={list.error} onRetry={list.reload} emptyTitle="No restaurants found" />
      </Card>
    </>
  );
}
