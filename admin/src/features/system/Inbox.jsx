import React from "react";
import { Badge, Button, Card, DataTable, PageHeader } from "../../ui";
import { usePagedList, useSubmit } from "../../lib/hooks";
import { http } from "../../lib/api";
import { fmtDateTime, timeAgo, titleCase } from "../../lib/format";

export default function Inbox() {
  const list = usePagedList("/notifications", { limit: 20 });
  const { busy, run } = useSubmit();

  const markAll = () => run(() => http.post("/notifications/read", {}), { success: "All notifications marked as read", onDone: list.reload });
  const markOne = (n) => n.readAt || run(() => http.post("/notifications/read", { id: n.id }), { onDone: list.reload });

  const columns = [
    { key: "state", title: "", width: 24, render: (n) => <span className={`d-inline-block radius-50 ${n.readAt ? "" : "bg-primary-600"}`} style={{ width: 8, height: 8 }} /> },
    {
      key: "title",
      title: "Notification",
      render: (n) => (
        <div>
          <div className={n.readAt ? "" : "fw-semibold"}>{n.title?.includes(".") ? titleCase(n.title.replace(/\./g, " ")) : n.title}</div>
          {n.body && <div className="text-xs text-secondary-light">{n.body}</div>}
        </div>
      ),
    },
    { key: "event", title: "Event", render: (n) => <span className="font-monospace text-sm">{n.event || "—"}</span> },
    { key: "channel", title: "Channel", render: (n) => <Badge tone="info">{n.channel}</Badge> },
    { key: "createdAt", title: "Received", render: (n) => <span title={fmtDateTime(n.createdAt)} className="text-nowrap">{timeAgo(n.createdAt)}</span> },
  ];

  return (
    <>
      <PageHeader title="My Notifications" subtitle="Alerts sent to your admin account" crumbs={[{ label: "System" }, { label: "Notifications" }]} actions={<Button variant="light" loading={busy} onClick={markAll}>Mark all as read</Button>} />
      <Card noPadding>
        <DataTable columns={columns} {...list.tableProps} error={list.error} onRetry={list.reload} onRowClick={markOne} emptyTitle="You're all caught up" emptyText="New alerts will show up here." />
      </Card>
    </>
  );
}
