import React from "react";
import { Link, useNavigate } from "react-router-dom";
import { Icon } from "@iconify/react/offline";
import { usePagedList } from "../../lib/hooks";
import { fmtDate, money, timeAgo } from "../../lib/format";
import { Avatar, Badge, Card, DataTable, FilterSelect, ListToolbar, PageHeader } from "../../ui";

export default function CustomerList() {
  const nav = useNavigate();
  const list = usePagedList("/admin/customers", { filters: { blocked: "", fraudFlag: "" }, sortBy: "createdAt" });

  const columns = [
    {
      key: "name",
      title: "Customer",
      render: (c) => (
        <div className="d-flex align-items-center gap-3">
          <Avatar name={c.name} size={36} />
          <div>
            <Link to={`/customers/${c.id}`} className="fw-semibold text-primary-light" onClick={(e) => e.stopPropagation()}>
              {c.name || "—"}
            </Link>
            <div className="text-secondary-light text-xs">{c.email || c.phone}</div>
          </div>
        </div>
      ),
    },
    { key: "phone", title: "Phone" },
    { key: "totalOrders", title: "Orders", align: "right" },
    { key: "lifetimeSpend", title: "Lifetime spend", align: "right", render: (c) => money(c.lifetimeSpend) },
    { key: "walletBalance", title: "Wallet", align: "right", render: (c) => money(c.walletBalance) },
    {
      key: "flags",
      title: "Flags",
      render: (c) => (
        <div className="d-flex gap-1 flex-wrap">
          {c.isBlocked && <Badge tone="danger">Blocked</Badge>}
          {c.fraudFlag && (
            <Badge tone="warning">
              <Icon icon="solar:danger-triangle-outline" /> Fraud
            </Badge>
          )}
          {(c.flags || []).map((f) => (
            <Badge key={f} tone="info">{f}</Badge>
          ))}
          {!c.isBlocked && !c.fraudFlag && !(c.flags || []).length && <span className="text-secondary-light">—</span>}
        </div>
      ),
    },
    { key: "lastOrderAt", title: "Last order", render: (c) => (c.lastOrderAt ? timeAgo(c.lastOrderAt) : "Never") },
    { key: "createdAt", title: "Joined", sortable: true, render: (c) => fmtDate(c.createdAt) },
  ];

  return (
    <>
      <PageHeader title="Customers" subtitle="Everyone who has ordered, or signed up to order, on Forksy" crumbs={[{ label: "Customers" }]} />
      <Card>
        <ListToolbar
          list={list}
          placeholder="Search name, email, phone…"
          filters={
            <>
              <FilterSelect value={list.filters.blocked} onChange={(v) => list.setFilter("blocked", v)} options={[{ value: "true", label: "Blocked" }, { value: "false", label: "Not blocked" }]} placeholder="Blocked: any" />
              <FilterSelect value={list.filters.fraudFlag} onChange={(v) => list.setFilter("fraudFlag", v)} options={[{ value: "true", label: "Fraud flagged" }, { value: "false", label: "No fraud flag" }]} placeholder="Fraud: any" />
            </>
          }
        />
        <DataTable columns={columns} {...list.tableProps} error={list.error} onRetry={list.reload} onRowClick={(c) => nav(`/customers/${c.id}`)} emptyTitle="No customers found" />
      </Card>
    </>
  );
}
