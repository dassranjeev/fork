import React from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "react-toastify";
import { errorMessage, http } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { fmtDateTime } from "../../lib/format";
import { usePagedList } from "../../lib/hooks";
import { Button, Card, DataTable, FilterSelect, ListToolbar, PageHeader, StatusBadge, useConfirm } from "../../ui";
import { BotStatusBadge } from "./parts";

export default function Restaurants() {
  const nav = useNavigate();
  const confirm = useConfirm();
  const { can } = useAuth();
  const canEdit = can("restaurants", "edit");
  const list = usePagedList("/admin/assistant/restaurants", { filters: { status: "" }, sortBy: "chats7d" });

  const toggle = async (r, forcedOff) => {
    const res = await confirm({
      title: forcedOff ? `Turn off the assistant for ${r.name}?` : `Allow the assistant for ${r.name} again?`,
      message: forcedOff ? "The bot stops answering on the restaurant's website and on FORKY at once, and the restaurant cannot switch it back on." : "The restaurant's bot follows its own on/off setting again.",
      confirmText: forcedOff ? "Turn off" : "Allow again",
      danger: forcedOff,
    });
    if (!res.confirmed) return;
    try {
      await http.patch(`/admin/restaurants/${r.id}/assistant`, { forcedOff });
      toast.success(forcedOff ? "Assistant turned off" : "Assistant allowed again");
      list.reload();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const columns = [
    {
      key: "name",
      title: "Restaurant",
      sortable: true,
      render: (r) => (
        <div>
          <Link to={`/assistant/restaurants/${r.id}`} className="fw-semibold text-primary-light" onClick={(e) => e.stopPropagation()}>
            {r.name}
          </Link>
          <div className="text-secondary-light text-xs">{r.slug}</div>
        </div>
      ),
    },
    { key: "status", title: "Restaurant status", render: (r) => <StatusBadge status={r.status} /> },
    { key: "botName", title: "Bot name", render: (r) => r.botName || <span className="text-secondary-light">default</span> },
    { key: "botStatus", title: "Bot", render: (r) => <BotStatusBadge status={r.botStatus} /> },
    { key: "origins", title: "Websites", align: "end", render: (r) => r.origins },
    { key: "faqs", title: "FAQs", align: "end", render: (r) => r.faqs },
    { key: "chats7d", title: "Chats 7d", sortable: true, align: "end", render: (r) => r.chats7d },
    { key: "handoffs7d", title: "Checkouts 7d", sortable: true, align: "end", render: (r) => r.handoffs7d },
    { key: "lastActivityAt", title: "Last activity", sortable: true, render: (r) => (r.lastActivityAt ? fmtDateTime(r.lastActivityAt) : <span className="text-secondary-light">never</span>) },
    {
      key: "forcedOff",
      title: "Force off",
      render: (r) => (
        <div className="form-check form-switch switch-primary mb-0" onClick={(e) => e.stopPropagation()}>
          <input className="form-check-input" type="checkbox" role="switch" aria-label={`Force off the assistant of ${r.name}`} checked={r.forcedOff} disabled={!canEdit} onChange={(e) => toggle(r, e.target.checked)} />
        </div>
      ),
    },
    {
      key: "edit",
      title: "",
      render: (r) => (
        <Button
          variant="outline"
          onClick={(e) => {
            e.stopPropagation();
            nav(`/assistant/restaurants/${r.id}`);
          }}
        >
          Edit
        </Button>
      ),
    },
  ];

  return (
    <>
      <PageHeader title="Restaurant bots" subtitle="Every restaurant's ordering assistant" crumbs={[{ label: "Assistant", to: "/assistant" }, { label: "Restaurant bots" }]} />
      <Card>
        <ListToolbar
          list={list}
          placeholder="Search restaurant name or slug…"
          filters={
            <FilterSelect
              value={list.filters.status}
              onChange={(v) => list.setFilter("status", v)}
              options={[
                { value: "active", label: "Active" },
                { value: "disabled", label: "Off (by restaurant)" },
                { value: "forced_off", label: "Off (by FORKY)" },
              ]}
              placeholder="All bots"
            />
          }
        />
        <DataTable columns={columns} {...list.tableProps} error={list.error} onRetry={list.reload} onRowClick={(r) => nav(`/assistant/restaurants/${r.id}`)} emptyTitle="No restaurants match" />
      </Card>
    </>
  );
}
