import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "react-toastify";
import { errorMessage, http } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useFetch } from "../../lib/hooks";
import { Badge, Button, Card, ErrorState, Loading, PageHeader, StatCard, Switch, TextInput } from "../../ui";
import { BrandingFields, FaqEditor, clone, faqsInvalid, same } from "./parts";

const FIELDS = ["enabled", "name", "greeting", "color", "logoUrl", "faqs", "chips"];
const QUERY_OK = /^[A-Za-z0-9 ,.'-]{1,60}$/;

/** The main-website bot ("central"): look, on/off, FAQs about FORKY itself and the starter chips. */
export default function Central() {
  const { can } = useAuth();
  const canEdit = can("settings", "edit");
  const { data, loading, error, reload } = useFetch("/admin/assistant/central");
  const [view, setView] = useState(null);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const cur = view || data;

  useEffect(() => {
    if (data) {
      setView(null);
      setForm(clone(data.config));
    }
  }, [data]);

  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorState error={error} onRetry={reload} />;
  if (!cur || !form) return null;

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const original = cur.config;
  const dirty = FIELDS.some((k) => !same(form[k], original[k]));
  const chipsBad = form.chips.some((c) => !c.label.trim() || !QUERY_OK.test(c.query.trim()));
  const valid = form.name.trim() && !faqsInvalid(form.faqs) && !chipsBad;
  const s = cur.stats || {};

  const save = async () => {
    setSaving(true);
    try {
      const body = {};
      FIELDS.forEach((k) => {
        if (!same(form[k], original[k])) body[k] = k === "name" || k === "greeting" ? form[k].trim() : form[k];
      });
      const res = await http.patch("/admin/assistant/central", body);
      setView(res);
      setForm(clone(res.config));
      toast.success("Central assistant saved");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <PageHeader title="Central bot" subtitle="The assistant on the FORKY website: it finds restaurants, then continues as that restaurant's bot" crumbs={[{ label: "Assistant", to: "/assistant" }, { label: "Central bot" }]} actions={<div className="d-flex gap-2 align-items-center"><Badge tone={form.enabled && cur.platformEnabled ? "success" : "neutral"}>{form.enabled && cur.platformEnabled ? "Active" : "Off"}</Badge><Link className="btn btn-primary-600 btn-sm radius-8" to="/assistant/training/central">Train this bot</Link></div>} />
      {!cur.platformEnabled && <div className="alert alert-warning radius-8 mb-20">The assistant is switched off for the whole platform (Assistant &gt; Overview).</div>}
      <div className="row g-3 mb-20">
        <div className="col-6 col-md-4"><StatCard label="Website chats (7 days)" value={s.chats7d ?? 0} icon="solar:chat-round-dots-outline" hint={`${s.messages7d ?? 0} messages`} /></div>
        <div className="col-6 col-md-4"><StatCard label="Sent to checkout" value={s.handoffs7d ?? 0} icon="solar:link-round-outline" tone="warning" /></div>
      </div>
      <div className="row g-3">
        <div className="col-xl-7">
          <Card title="Look" subtitle={canEdit ? "Shown on the FORKY website chat. Changes are audit-logged." : "You need the 'edit settings' permission to change these."} className="mb-20">
            <Switch label="Central assistant enabled" hint="Off: the chat bubble disappears from the FORKY website (restaurant pages with their own bot are not affected)." checked={form.enabled} onChange={(v) => set({ enabled: v })} disabled={!canEdit} />
            <BrandingFields form={form} set={set} disabled={!canEdit} nameHint={`${form.name.length}/40, shown in the chat header`} />
          </Card>
          <Card title="Starter chips" subtitle="Quick buttons shown at the start of the chat (up to 6). Leave empty for the built-in defaults." className="mb-20">
            {form.chips.map((c, i) => (
              <div key={i} className="row align-items-end mb-8">
                <TextInput col={5} label={`Chip ${i + 1} label`} aria-label={`Chip ${i + 1} label`} value={c.label} maxLength={30} disabled={!canEdit} onChange={(v) => set({ chips: form.chips.map((x, j) => (j === i ? { ...x, label: v } : x)) })} />
                <TextInput col={5} label="Search text" aria-label={`Chip ${i + 1} search`} value={c.query} maxLength={60} disabled={!canEdit} error={c.query && !QUERY_OK.test(c.query) ? "Letters, digits, spaces and , . ' - only" : undefined} onChange={(v) => set({ chips: form.chips.map((x, j) => (j === i ? { ...x, query: v } : x)) })} />
                {canEdit && (
                  <div className="col-2 mb-16">
                    <Button variant="outline-danger" onClick={() => set({ chips: form.chips.filter((_, j) => j !== i) })}>
                      Remove
                    </Button>
                  </div>
                )}
              </div>
            ))}
            {!form.chips.length && <div className="text-secondary-light text-sm mb-12">Using the defaults: {cur.defaults.chips.map((c) => c.label).join(", ")}.</div>}
            {canEdit && form.chips.length < 6 && (
              <Button variant="light" icon="solar:add-circle-outline" onClick={() => set({ chips: [...form.chips, { label: "", query: "" }] })}>
                Add a chip
              </Button>
            )}
          </Card>
          <Card title="FAQs about FORKY" className="mb-20">
            <FaqEditor faqs={form.faqs} onChange={(faqs) => set({ faqs })} canEdit={canEdit} title="Questions the central bot answers" help="Delivery areas, fees, how ordering works, support contact. Answered when a guest asks something similar, before restaurant search (up to 20)." />
          </Card>
          {canEdit && (
            <div className="d-flex gap-2 mb-20">
              <Button loading={saving} disabled={!dirty || !valid} onClick={save}>
                Save changes
              </Button>
              {dirty && (
                <Button variant="light" onClick={() => setForm(clone(original))}>
                  Discard
                </Button>
              )}
            </div>
          )}
        </div>
        <div className="col-xl-5">
          <Card title="Good to know">
            <ul className="text-secondary-light text-sm ps-20 mb-0">
              <li>The central bot never takes payment: when a guest picks a restaurant it hands over to that restaurant's menu and cart.</li>
              <li>Answers to FAQs are shown exactly as written here. Do not put anything in them that you would not publish on the website.</li>
              <li>The logo is shown in the chat header; PNG, JPG or WebP.</li>
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}
