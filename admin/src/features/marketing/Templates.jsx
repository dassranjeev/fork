import React, { useState } from "react";
import { http } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useFetch, useForm, useSubmit } from "../../lib/hooks";
import { Badge, BoolBadge, Button, FormModal, FormRow, IconButton, Select, Switch, TextArea, TextInput } from "../../ui";
import { CrudPage } from "../platform/crud";

const CHANNELS = ["PUSH", "SMS", "EMAIL", "IN_APP"];
const AUDIENCES = ["CUSTOMER", "RESTAURANT", "DRIVER", "ADMIN"];

function Preview({ subject, body }) {
  const { busy, run } = useSubmit();
  const [out, setOut] = useState(null);
  return (
    <div className="mb-16">
      <Button variant="light" icon="solar:eye-outline" loading={busy} disabled={!body} onClick={() => run(() => http.post("/admin/notification-templates/preview", { subject: subject || undefined, body }), { onDone: setOut })}>
        Preview with sample data
      </Button>
      {out && (
        <div className="border radius-8 p-16 mt-12 bg-neutral-100">
          {out.subject && <div className="fw-semibold mb-4">{out.subject}</div>}
          <div style={{ whiteSpace: "pre-wrap" }}>{out.body}</div>
        </div>
      )}
    </div>
  );
}

function TestSend({ tpl, onClose }) {
  const { busy, run } = useSubmit();
  const f = useForm({ to: "" });
  const [res, setRes] = useState(null);
  const hint = { EMAIL: "Email address", SMS: "Phone number (E.164, e.g. +14165550123)", PUSH: "User ID", IN_APP: "User ID" }[tpl.channel];
  return (
    <FormModal
      open
      onClose={onClose}
      title={`Test send: ${tpl.key} (${tpl.channel})`}
      busy={busy}
      submitText="Send test"
      disabled={!f.values.to}
      onSubmit={() => run(() => http.post(`/admin/notification-templates/${tpl.id}/test-send`, { to: f.values.to }), { success: "Test sent", onDone: setRes })}
    >
      <TextInput label="Send to" required hint={hint} {...f.bind("to")} />
      {res && (
        <div className="alert alert-success radius-8 mb-0">
          Sent via {res.channel} to {res.to}.
          <div className="mt-8" style={{ whiteSpace: "pre-wrap" }}>{res.subject ? <strong>{res.subject}<br /></strong> : null}{res.body}</div>
        </div>
      )}
    </FormModal>
  );
}

export default function Templates() {
  const { can } = useAuth();
  const { data: ev } = useFetch("/admin/notification-templates/events");
  const [test, setTest] = useState(null);
  const events = ev?.events ?? [];
  const eventKeys = events.map((e) => e.event);

  return (
    <CrudPage
      title="Notification Templates"
      subtitle="Message copy for every system notification, per channel, audience and language."
      path="/admin/notification-templates"
      module="content"
      itemName="template"
      modalSize="lg"
      limit={20}
      sortBy="key"
      sortDir="ASC"
      searchPlaceholder="Search key or text…"
      filterDefs={[
        { name: "channel", placeholder: "All channels", options: CHANNELS },
        { name: "audience", placeholder: "All audiences", options: AUDIENCES },
        { name: "language", placeholder: "All languages", options: ["en", "fr"] },
      ]}
      initial={{ key: "", channel: "PUSH", language: "en", audience: "CUSTOMER", subject: "", body: "", active: true }}
      toPayload={(v, editing) => ({
        subject: v.subject || null,
        body: v.body,
        active: !!v.active,
        ...(editing ? {} : { key: v.key, channel: v.channel, language: v.language, audience: v.audience }),
      })}
      columns={[
        { key: "key", title: "Event", sortable: true, render: (t) => <span className="fw-semibold font-monospace text-sm">{t.key}</span> },
        { key: "channel", title: "Channel", render: (t) => <Badge tone={t.channel === "EMAIL" ? "info" : t.channel === "SMS" ? "purple" : t.channel === "PUSH" ? "primary" : "neutral"}>{t.channel.replace("_", " ")}</Badge> },
        { key: "audience", title: "Audience" },
        { key: "language", title: "Lang", render: (t) => t.language.toUpperCase() },
        { key: "body", title: "Message", render: (t) => <div style={{ maxWidth: 420 }}>{t.subject && <div className="fw-medium text-sm">{t.subject}</div>}<div className="text-secondary-light text-xs text-truncate">{t.body}</div></div> },
        { key: "active", title: "Status", render: (t) => <BoolBadge value={t.active} yes="Active" no="Off" /> },
      ]}
      rowActions={(t) => can("content", "edit") && ["EMAIL", "SMS", "PUSH"].includes(t.channel) && <IconButton icon="solar:plain-outline" title="Send test" tone="success" onClick={() => setTest(t)} />}
      renderForm={({ f, editing }) => {
        const vars = events.find((e) => e.event === f.values.key)?.variables ?? [];
        return (
          <>
            <FormRow>
              <div className="col-md-6 mb-16">
                <label className="form-label fw-semibold text-primary-light text-sm mb-8">Event key *</label>
                <input className="form-control radius-8" list="tpl-events" disabled={editing} value={f.values.key} onChange={(e) => f.set("key", e.target.value)} />
                <datalist id="tpl-events">
                  {eventKeys.map((k) => (
                    <option key={k} value={k} />
                  ))}
                </datalist>
              </div>
              <Select col={2} label="Channel" allowEmpty={false} disabled={editing} options={CHANNELS} {...f.bind("channel")} />
              <Select col={2} label="Audience" allowEmpty={false} disabled={editing} options={AUDIENCES} {...f.bind("audience")} />
              <Select col={2} label="Language" allowEmpty={false} disabled={editing} options={ev?.languages || ["en", "fr"]} {...f.bind("language")} />
            </FormRow>
            {f.values.channel !== "SMS" && f.values.channel !== "IN_APP" ? <TextInput label="Subject / title" {...f.bind("subject")} /> : <TextInput label="Title" {...f.bind("subject")} />}
            <TextArea label="Body" required rows={5} {...f.bind("body")} />
            {vars.length > 0 && (
              <div className="mb-16 d-flex flex-wrap gap-2 align-items-center">
                <span className="text-secondary-light text-sm">Variables:</span>
                {vars.map((v) => (
                  <button type="button" key={v} className="badge bg-primary-50 text-primary-600 border-0" onClick={() => f.set("body", `${f.values.body}{{${v}}}`)}>
                    {`{{${v}}}`}
                  </button>
                ))}
              </div>
            )}
            <Preview subject={f.values.subject} body={f.values.body} />
            <Switch label="Active" {...f.bindCheck("active")} />
          </>
        );
      }}
    >
      {() => test && <TestSend tpl={test} onClose={() => setTest(null)} />}
    </CrudPage>
  );
}
