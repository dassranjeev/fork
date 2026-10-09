import React, { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { toast } from "react-toastify";
import { errorMessage, http } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { fmtDateTime } from "../../lib/format";
import { useFetch } from "../../lib/hooks";
import { Button, Card, ErrorState, Loading, PageHeader, Switch, useConfirm } from "../../ui";
import { BotStatusBadge, BrandingFields, EmbedBox, FaqEditor, OriginsEditor, StatsStrip, clone, faqsInvalid, originsInvalid, same } from "./parts";

const FIELDS = ["enabled", "name", "greeting", "color", "logoUrl", "faqs", "allowedOrigins"];

/** Full control of ONE restaurant's bot: branding, on/off, FAQs, allowed websites, embed code, key, live preview. */
export default function Editor() {
  const { id } = useParams();
  const { can } = useAuth();
  const confirm = useConfirm();
  const canEdit = can("restaurants", "edit");
  const rest = useFetch(`/admin/restaurants/${id}`);
  const { data, loading, error, reload } = useFetch(`/admin/restaurants/${id}/assistant`);
  const [view, setView] = useState(null);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [rotating, setRotating] = useState(false);
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
  const valid = form.name.trim() && !faqsInvalid(form.faqs) && !originsInvalid(form.allowedOrigins);
  const restaurant = rest.data;
  const status = cur.forcedOff ? "forced_off" : cur.config.enabled ? "active" : "disabled";
  const testOrigin = window.location.origin;

  const save = async () => {
    setSaving(true);
    try {
      const body = {};
      FIELDS.forEach((k) => {
        if (!same(form[k], original[k])) body[k] = k === "name" || k === "greeting" ? form[k].trim() : form[k];
      });
      const res = await http.patch(`/admin/restaurants/${id}/assistant`, body);
      setView(res);
      setForm(clone(res.config));
      toast.success("Assistant saved");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const forceOff = async (forcedOff) => {
    const res = await confirm({
      title: forcedOff ? "Turn this assistant off?" : "Allow this assistant again?",
      message: forcedOff ? "The bot stops answering at once, on the restaurant's website and on FORKSY, and the restaurant cannot switch it back on." : "The bot follows the restaurant's own on/off setting again.",
      confirmText: forcedOff ? "Turn off" : "Allow again",
      danger: forcedOff,
    });
    if (!res.confirmed) return;
    try {
      const r = await http.patch(`/admin/restaurants/${id}/assistant`, { forcedOff });
      setView(r);
      toast.success(forcedOff ? "Assistant turned off" : "Assistant allowed again");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const rotate = async () => {
    const res = await confirm({ title: "Rotate the bot key?", message: "The current key stops working immediately. The restaurant must paste the new embed code on its website.", confirmText: "Rotate key", danger: true });
    if (!res.confirmed) return;
    setRotating(true);
    try {
      const r = await http.post(`/admin/assistant/restaurants/${id}/rotate-key`, {});
      setView({ ...cur, config: { ...cur.config, botKey: r.botKey }, embedSnippet: r.embedSnippet });
      toast.success("New key created");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setRotating(false);
    }
  };

  const openPreview = () => window.open(`/assistant-demo.html?key=${encodeURIComponent(cur.config.botKey)}`, "_blank", "noopener");
  const originOk = form.allowedOrigins.includes(testOrigin) && original.allowedOrigins.includes(testOrigin);

  return (
    <>
      <PageHeader
        title={restaurant?.name ? `${restaurant.name} - assistant` : "Restaurant assistant"}
        subtitle="Full control of this restaurant's ordering bot"
        crumbs={[{ label: "Assistant", to: "/assistant" }, { label: "Restaurant bots", to: "/assistant/restaurants" }, { label: restaurant?.name || "Editor" }]}
        actions={
          <div className="d-flex gap-2 align-items-center">
            <BotStatusBadge status={status} />
            <Link className="btn btn-primary-600 btn-sm radius-8" to={`/assistant/training/restaurants/${id}`}>
              Train this bot
            </Link>
            <Link className="btn btn-outline-primary-600 btn-sm radius-8" to={`/restaurants/${id}`}>
              Restaurant page
            </Link>
          </div>
        }
      />
      {!cur.platformEnabled && <div className="alert alert-warning radius-8 mb-20">The assistant is switched off for the whole platform (Assistant &gt; Overview).</div>}
      <StatsStrip stats={cur.stats} />
      <div className="text-secondary-light text-sm mb-20">Last activity: {cur.stats?.lastActivityAt ? fmtDateTime(cur.stats.lastActivityAt) : "no chats yet"}</div>

      <div className="row g-3">
        <div className="col-xl-7">
          <Card title="Look and availability" subtitle={canEdit ? "Changes apply to guests immediately and are written to the audit log." : "You need the 'edit restaurants' permission to change these."} className="mb-20">
            <Switch label="Assistant enabled" hint="The restaurant's own on/off. Use Force off below to override it." checked={form.enabled} onChange={(v) => set({ enabled: v })} disabled={!canEdit} />
            <BrandingFields form={form} set={set} disabled={!canEdit} fallbackLogo={restaurant?.logoUrl} />
            <hr />
            <FaqEditor faqs={form.faqs} onChange={(faqs) => set({ faqs })} canEdit={canEdit} title="FAQs (also editable by the restaurant)" />
            <hr className="my-20" />
            <OriginsEditor origins={form.allowedOrigins} onChange={(v) => set({ allowedOrigins: v })} disabled={!canEdit} />
            {canEdit && (
              <div className="d-flex gap-2 mt-16">
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
          </Card>
        </div>
        <div className="col-xl-5">
          <Card title="Force off" subtitle="Overrides the restaurant's own switch" className="mb-20">
            <Switch label="Force off (admin)" hint="The restaurant cannot turn the bot back on while this is set." checked={!!cur.forcedOff} onChange={forceOff} disabled={!canEdit} className="mb-0" />
          </Card>
          <Card title="Embed code" subtitle="What the restaurant pastes into its website" className="mb-20">
            <EmbedBox snippet={cur.embedSnippet} onRotate={canEdit ? rotate : undefined} rotating={rotating} />
          </Card>
          <Card title="Live preview" subtitle="Opens a fake merchant page with this bot's widget">
            <p className="text-secondary-light text-sm">
              The demo page runs on <code>{testOrigin}</code>, so that address must be in the allowed websites above (and saved).
            </p>
            {canEdit && !originOk && !dirty && (
              <Button variant="light" className="me-2" onClick={() => set({ allowedOrigins: [...form.allowedOrigins, testOrigin].slice(0, 10) })}>
                Add {testOrigin} for testing
              </Button>
            )}
            <Button icon="solar:eye-outline" disabled={!originOk} onClick={openPreview}>
              Open live preview
            </Button>
            {!originOk && <div className="text-secondary-light text-xs mt-8">Add and save {testOrigin} first.</div>}
          </Card>
        </div>
      </div>
    </>
  );
}
