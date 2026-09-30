import React, { useState } from "react";
import { http } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useFetch, useSubmit } from "../../lib/hooks";
import { fmtDateTime, num, titleCase } from "../../lib/format";
import { Badge, Button, DateInput, FormRow, IconButton, NumberInput, Select, StatusBadge, TextArea, TextInput, useConfirm } from "../../ui";
import { CrudPage } from "../platform/crud";

const CHANNELS = ["PUSH", "EMAIL", "SMS", "IN_APP"];
const AUDIENCES = ["CUSTOMERS", "DRIVERS", "RESTAURANTS"];
const locked = (c) => c.status === "SENT" || c.status === "SENDING";

function buildBody(v) {
  const filters = {};
  if (v.audience === "CUSTOMERS") {
    if (v.minOrders !== "") filters.minOrders = Number(v.minOrders);
    if (v.inactiveDays !== "") filters.inactiveDays = Number(v.inactiveDays);
  } else {
    if (v.cityId) filters.cityId = v.cityId;
    if (v.zoneId) filters.zoneId = v.zoneId;
  }
  return { audience: v.audience, filters };
}

function Estimate({ values }) {
  const { busy, run } = useSubmit();
  const [n, setN] = useState(null);
  return (
    <div className="d-flex align-items-center gap-3 mb-16">
      <Button variant="light" icon="solar:users-group-rounded-outline" loading={busy} onClick={() => run(() => http.post("/admin/campaigns/preview", { name: values.name || "preview", channel: values.channel, body: values.body || "preview", ...buildBody(values) }), { onDone: (r) => setN(r.estimatedRecipients) })}>
        Estimate audience
      </Button>
      {n !== null && <span><strong>{num(n)}</strong> recipient(s) match</span>}
    </div>
  );
}

function Targeting({ f }) {
  const v = f.values;
  const { data: cities } = useFetch("/admin/cities", { limit: 100 });
  const { data: zones } = useFetch(v.cityId && v.audience !== "CUSTOMERS" ? "/admin/zones" : null, { cityId: v.cityId, limit: 100 });
  return v.audience === "CUSTOMERS" ? (
    <FormRow>
      <NumberInput col={6} label="Min. completed orders" step="1" min={0} hint="Blank = everyone" {...f.bind("minOrders")} />
      <NumberInput col={6} label="Inactive for at least (days)" step="1" min={0} hint="Blank = any activity" {...f.bind("inactiveDays")} />
    </FormRow>
  ) : (
    <FormRow>
      <Select col={6} label="City" placeholder="All cities" options={(cities?.data ?? []).map((c) => ({ value: c.id, label: c.name }))} value={v.cityId} onChange={(x) => { f.set("cityId", x); f.set("zoneId", ""); }} />
      {v.audience === "DRIVERS" && <Select col={6} label="Zone" disabled={!v.cityId} placeholder="All zones" options={(zones?.data ?? []).map((z) => ({ value: z.id, label: z.name }))} {...f.bind("zoneId")} />}
    </FormRow>
  );
}

export default function Campaigns() {
  const { can } = useAuth();
  const confirm = useConfirm();
  const { run } = useSubmit();
  return (
    <CrudPage
      title="Campaigns"
      subtitle="Push, email and SMS blasts to customers, drivers or restaurants. Marketing messages respect customer consent."
      path="/admin/campaigns"
      module="notifications"
      itemName="campaign"
      modalSize="lg"
      sortBy="createdAt"
      searchPlaceholder="Search campaigns…"
      filterDefs={[
        { name: "status", placeholder: "All statuses", options: ["DRAFT", "SCHEDULED", "SENDING", "SENT", "CANCELLED"] },
        { name: "channel", placeholder: "All channels", options: CHANNELS },
        { name: "audience", placeholder: "All audiences", options: AUDIENCES },
      ]}
      initial={{ name: "", channel: "PUSH", subject: "", body: "", audience: "CUSTOMERS", minOrders: "", inactiveDays: "", cityId: "", zoneId: "", scheduledAt: null }}
      toForm={(c) => ({
        name: c.name, channel: c.channel, subject: c.subject || "", body: c.body, audience: c.audience,
        minOrders: c.filters?.minOrders ?? "", inactiveDays: c.filters?.inactiveDays ?? "", cityId: c.filters?.cityId || "", zoneId: c.filters?.zoneId || "",
        scheduledAt: c.scheduledAt,
      })}
      toPayload={(v) => ({ name: v.name, channel: v.channel, subject: v.subject || null, body: v.body, scheduledAt: v.scheduledAt || null, ...buildBody(v) })}
      canEditRow={(c) => !locked(c) && c.status !== "CANCELLED"}
      canDelete={(c) => !locked(c)}
      columns={[
        { key: "name", title: "Campaign", render: (c) => <div><div className="fw-semibold">{c.name}</div><div className="text-secondary-light text-xs text-truncate" style={{ maxWidth: 320 }}>{c.body}</div></div> },
        { key: "channel", title: "Channel", render: (c) => <Badge tone="info">{c.channel.replace("_", " ")}</Badge> },
        { key: "audience", title: "Audience", render: (c) => titleCase(c.audience) },
        { key: "status", title: "Status", render: (c) => <StatusBadge status={c.status} /> },
        { key: "when", title: "Scheduled / sent", render: (c) => (c.sentAt ? fmtDateTime(c.sentAt) : c.scheduledAt ? fmtDateTime(c.scheduledAt) : "—") },
        { key: "recipientCount", title: "Delivered", render: (c) => (c.status === "SENT" ? `${num(c.deliveredCount)} / ${num(c.recipientCount)}` : "—") },
      ]}
      rowActions={(c, reload) =>
        can("notifications", "edit") && (
          <>
            {(c.status === "DRAFT" || c.status === "SCHEDULED") && (
              <IconButton
                icon="solar:plain-2-outline"
                title="Send now"
                tone="success"
                onClick={async () => {
                  const r = await confirm({ title: `Send "${c.name}" now?`, message: "This immediately sends to every matching recipient and cannot be undone.", confirmText: "Send now" });
                  if (r.confirmed) run(() => http.post(`/admin/campaigns/${c.id}/send`), { success: "Campaign sent", onDone: reload });
                }}
              />
            )}
            {c.status === "SCHEDULED" && <IconButton icon="solar:close-circle-outline" title="Cancel schedule" tone="warning" onClick={() => run(() => http.post(`/admin/campaigns/${c.id}/cancel`), { success: "Campaign cancelled", onDone: reload })} />}
          </>
        )
      }
      renderForm={({ f }) => (
        <>
          <FormRow>
            <TextInput col={6} label="Campaign name" required {...f.bind("name")} />
            <Select col={3} label="Channel" allowEmpty={false} options={CHANNELS} {...f.bind("channel")} />
            <Select col={3} label="Audience" allowEmpty={false} options={AUDIENCES} value={f.values.audience} onChange={(v) => { f.set("audience", v); }} />
          </FormRow>
          <TextInput label="Subject / title" {...f.bind("subject")} />
          <TextArea label="Message" required rows={5} {...f.bind("body")} />
          <h6 className="text-md mb-12">Audience filters</h6>
          <Targeting f={f} />
          <Estimate values={f.values} />
          <DateInput label="Schedule for later" hint="Leave empty to save as draft and send manually." withTime value={f.values.scheduledAt} onChange={(v) => f.set("scheduledAt", v)} />
        </>
      )}
    />
  );
}
