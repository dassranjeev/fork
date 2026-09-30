import React, { useState } from "react";
import { BoolBadge, Button, Card, DataTable, FilterSelect, FormModal, IconButton, ListToolbar, PageHeader, Select, Switch, TextArea, TextInput, useConfirm } from "../../ui";
import { useForm, usePagedList, useSubmit } from "../../lib/hooks";
import { useAuth } from "../../lib/auth";
import { http } from "../../lib/api";
import { titleCase } from "../../lib/format";
import { CATEGORIES } from "./shared";

const AUDIENCES = ["ANY", "CUSTOMER", "RESTAURANT", "DRIVER"];

function ReplyModal({ reply, onClose, onDone }) {
  const f = useForm({ title: reply?.title || "", body: reply?.body || "", category: reply?.category || "", audience: reply?.audience || "ANY", shortcut: reply?.shortcut || "", active: reply?.active ?? true });
  const { busy, run } = useSubmit();
  const v = f.values;
  const submit = () => {
    const payload = { title: v.title, body: v.body, audience: v.audience, category: v.category || undefined, shortcut: v.shortcut || undefined, active: v.active };
    return run(() => (reply ? http.patch(`/admin/support/canned-replies/${reply.id}`, payload) : http.post("/admin/support/canned-replies", payload)), { success: reply ? "Reply updated" : "Reply created", onDone: () => { onClose(); onDone(); } });
  };
  return (
    <FormModal open onClose={onClose} title={reply ? "Edit canned reply" : "New canned reply"} onSubmit={submit} busy={busy} size="lg" disabled={!v.title.trim() || !v.body.trim()}>
      <div className="row">
        <TextInput col="col-md-8" label="Title" required {...f.bind("title")} />
        <TextInput col="col-md-4" label="Shortcut" placeholder="/hello" {...f.bind("shortcut")} />
        <Select col="col-md-6" label="Category" options={CATEGORIES} placeholder="Any category" {...f.bind("category")} />
        <Select col="col-md-6" label="Audience" allowEmpty={false} options={AUDIENCES} {...f.bind("audience")} />
      </div>
      <TextArea label="Body" required rows={5} hint="Variables: {{customerName}} {{orderCode}} {{agentName}} {{ticketNumber}}" {...f.bind("body")} />
      <Switch label="Active" checked={v.active} onChange={(x) => f.set("active", x)} />
    </FormModal>
  );
}

export default function CannedReplies() {
  const { can } = useAuth();
  const confirm = useConfirm();
  const list = usePagedList("/admin/support/canned-replies", { filters: { category: "", audience: "" } });
  const [editing, setEditing] = useState(null); // {} = new
  const { run } = useSubmit();

  const remove = async (r) => {
    const res = await confirm({ title: `Delete "${r.title}"?`, danger: true, confirmText: "Delete" });
    if (res.confirmed) run(() => http.del(`/admin/support/canned-replies/${r.id}`), { success: "Deleted", onDone: list.reload });
  };

  const cols = [
    { key: "title", title: "Title", sortable: true, render: (r) => <span className="fw-semibold">{r.title}</span> },
    { key: "shortcut", title: "Shortcut", render: (r) => (r.shortcut ? <code>{r.shortcut}</code> : "-") },
    { key: "body", title: "Body", render: (r) => <div style={{ maxWidth: 420 }} className="text-truncate text-secondary-light">{r.body}</div> },
    { key: "category", title: "Category", render: (r) => (r.category ? titleCase(r.category) : "Any") },
    { key: "audience", title: "Audience", render: (r) => titleCase(r.audience) },
    { key: "usageCount", title: "Used", sortable: true },
    { key: "active", title: "Active", render: (r) => <BoolBadge value={r.active} /> },
    {
      key: "actions", title: "", align: "right", render: (r) => (
        <div className="d-flex gap-2 justify-content-end">
          {can("support", "edit") && <IconButton icon="solar:pen-outline" title="Edit" tone="primary" onClick={() => setEditing(r)} />}
          {can("support", "delete") && <IconButton icon="solar:trash-bin-trash-outline" title="Delete" tone="danger" onClick={() => remove(r)} />}
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader title="Canned replies" subtitle="Reusable answers agents can insert into a ticket" crumbs={[{ label: "Support" }, { label: "Canned replies" }]} />
      <Card noPadding>
        <div className="p-24 pb-0">
          <ListToolbar
            list={list}
            placeholder="Search title, body, shortcut…"
            filters={
              <>
                <FilterSelect value={list.filters.category} onChange={(v) => list.setFilter("category", v)} options={CATEGORIES} placeholder="Any category" />
                <FilterSelect value={list.filters.audience} onChange={(v) => list.setFilter("audience", v)} options={AUDIENCES.slice(1)} placeholder="Any audience" />
              </>
            }
            actions={can("support", "create") && <Button icon="solar:add-circle-outline" onClick={() => setEditing({})}>New reply</Button>}
          />
        </div>
        <DataTable columns={cols} {...list.tableProps} error={list.error} onRetry={list.reload} emptyTitle="No canned replies" />
      </Card>
      {editing && <ReplyModal reply={editing.id ? editing : null} onClose={() => setEditing(null)} onDone={list.reload} />}
    </>
  );
}
