import React from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "react-toastify";
import { Card, DataTable, FilterSelect, ListToolbar, PageHeader, StatusBadge, Badge } from "../../ui";
import { usePagedList } from "../../lib/hooks";
import { useAuth } from "../../lib/auth";
import { http, errorMessage } from "../../lib/api";
import { ORDER_STATUSES, fmtDateTime, money, titleCase } from "../../lib/format";
import { useLookups } from "./lookups";

export default function OrdersList() {
  const nav = useNavigate();
  const { can } = useAuth();
  const { restaurants, cities, restaurantName, cityName } = useLookups();
  const list = usePagedList("/admin/orders", { filters: { status: "", restaurantId: "", cityId: "", isLate: "" }, sortBy: "createdAt", sortDir: "DESC", refreshMs: 30000 });

  const exportCsv = async () => {
    try {
      const res = await http.get("/admin/orders/export/csv");
      const blob = new Blob([res.csv], { type: "text/csv" });
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      a.download = `orders-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(href);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const columns = [
    { key: "code", title: "Order", render: (o) => <span className="fw-semibold text-primary-600">{o.code}</span> },
    { key: "createdAt", title: "Placed", sortable: true, render: (o) => <span className="text-nowrap">{fmtDateTime(o.createdAt)}</span> },
    { key: "restaurantId", title: "Restaurant", render: (o) => restaurantName[o.restaurantId] || <span className="text-secondary-light">{o.restaurantId.slice(0, 8)}</span> },
    { key: "cityId", title: "City", render: (o) => cityName[o.cityId] || o.deliveryAddress?.city || "—" },
    { key: "type", title: "Type", render: (o) => titleCase(o.type) },
    { key: "status", title: "Status", sortable: true, render: (o) => (<><StatusBadge status={o.status} />{o.isLate && <Badge tone="danger" className="ms-2">Late</Badge>}</>) },
    { key: "paymentStatus", title: "Payment", render: (o) => <StatusBadge status={o.paymentStatus} /> },
    { key: "total", title: "Total", sortable: true, align: "right", render: (o) => <span className="fw-semibold">{money(o.total)}</span> },
  ];

  return (
    <>
      <PageHeader title="Orders" subtitle="Search, filter and manage every order on the platform" crumbs={[{ label: "Operations" }, { label: "Orders" }]} />
      <Card noPadding>
        <div className="p-24 pb-0">
          <ListToolbar
            list={list}
            placeholder="Search by order code…"
            onExport={can("orders", "export") ? exportCsv : undefined}
            filters={
              <>
                <FilterSelect value={list.filters.status} onChange={(v) => list.setFilter("status", v)} options={ORDER_STATUSES} placeholder="All statuses" />
                <FilterSelect value={list.filters.restaurantId} onChange={(v) => list.setFilter("restaurantId", v)} options={restaurants.map((r) => ({ value: r.id, label: r.name }))} placeholder="All restaurants" />
                <FilterSelect value={list.filters.cityId} onChange={(v) => list.setFilter("cityId", v)} options={cities.map((c) => ({ value: c.id, label: c.name }))} placeholder="All cities" />
                <FilterSelect value={list.filters.isLate} onChange={(v) => list.setFilter("isLate", v)} options={[{ value: "true", label: "Late only" }, { value: "false", label: "On time" }]} placeholder="Late: any" />
              </>
            }
          />
        </div>
        <DataTable columns={columns} {...list.tableProps} error={list.error} onRetry={list.reload} onRowClick={(o) => nav(`/orders/${o.id}`)} emptyTitle="No orders match these filters" />
      </Card>
    </>
  );
}
