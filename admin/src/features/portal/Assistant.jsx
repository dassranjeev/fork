import React, { useCallback, useEffect, useState } from "react";
import { Icon } from "@iconify/react/offline";
import { toast } from "react-toastify";
import { errorMessage } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { Button, Card, ErrorState, Loading, PageHeader, Tabs, useConfirm } from "../../ui";
import TrainingArea from "../assistant/training/TrainingArea";
import { BrandingPreview, EmbedBox, FaqEditor, OriginsEditor, StatsStrip, clone, faqsInvalid, originsInvalid, same } from "../assistant/parts";
import { usePortal } from "./context";
import { useApi, usePortalFetch } from "./shared";

const MANAGERS = ["OWNER", "LOCATION_MANAGER"];

function HowItWorks() {
  const steps = [
    ["solar:chat-round-dots-outline", "Answers questions about your restaurant only", "Menu, prices, dietary tags and allergens as you recorded them, opening hours, delivery or pickup, minimum order, plus your own FAQs below. It never invents menu items or prices and never claims a dish is safe for an allergy."],
    ["solar:cart-large-2-outline", "Builds the order with the guest", "\"Add 2 margherita and a pop\", \"no onions\", \"what do you recommend\". Items are validated against your live menu (available, valid options, 1-20 each)."],
    ["solar:link-round-outline", "Hands over to FORKY to pay", "When the guest taps Checkout they are sent to the FORKY website with the same items and kitchen note; they log in or register there and pay. Orders then arrive exactly like any other order."],
    ["solar:shield-check-outline", "Safe on your site", "The bot key is public (it sits in your page source). It only works from the websites you list below, is rate limited, and only exposes what your public restaurant page already shows."],
  ];
  return (
    <Card title="How it works" className="mb-20">
      <div className="row g-3">
        {steps.map(([icon, title, text]) => (
          <div key={title} className="col-md-6 col-xl-3">
            <div className="d-flex gap-3">
              <Icon icon={icon} className="text-primary-600 text-3xl flex-shrink-0" />
              <div>
                <div className="fw-semibold mb-4">{title}</div>
                <div className="text-secondary-light text-sm">{text}</div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

/**
 * Restaurant portal > Assistant. The restaurant manages ONLY its FAQs and the websites that may show the bot (plus the embed code / key).
 * The look (name, greeting, colour, logo) and the on/off switch are set by FORKY and shown here read-only.
 */
function AssistantSettings() {
  const { restaurantRole } = useAuth();
  const canEdit = MANAGERS.includes(restaurantRole);
  const { data, loading, error, reload } = usePortalFetch("/restaurant/assistant");
  const api = useApi();
  const confirm = useConfirm();
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [view, setView] = useState(null);
  const current = view || data;

  useEffect(() => {
    if (data) {
      setView(null);
      setForm({ faqs: clone(data.config.faqs), allowedOrigins: clone(data.config.allowedOrigins) });
    }
  }, [data]);

  const setPart = useCallback((patch) => setForm((f) => ({ ...f, ...patch })), []);

  if (loading && !data) return <Loading />;
  if (error && !data)
    return (
      <>
        <PageHeader title="Assistant" />
        <ErrorState error={error} onRetry={reload} />
      </>
    );
  if (!data || !form) return null;

  const original = { faqs: current.config.faqs, allowedOrigins: current.config.allowedOrigins };
  const dirty = !same(form, original);
  const valid = !faqsInvalid(form.faqs) && !originsInvalid(form.allowedOrigins);
  const forcedOff = current.forcedOff;
  const platformOff = !current.platformEnabled;
  const live = current.config.enabled && !forcedOff && !platformOff;

  const save = async () => {
    setSaving(true);
    try {
      const body = {};
      if (!same(form.faqs, original.faqs)) body.faqs = form.faqs.map((f) => ({ q: f.q.trim(), a: f.a.trim() }));
      if (!same(form.allowedOrigins, original.allowedOrigins)) body.allowedOrigins = form.allowedOrigins.map((o) => o.trim());
      const res = await api.patch("/restaurant/assistant", body);
      setView(res);
      setForm({ faqs: clone(res.config.faqs), allowedOrigins: clone(res.config.allowedOrigins) });
      toast.success("Assistant saved");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const rotate = async () => {
    const res = await confirm({
      title: "Rotate the bot key?",
      message: "The current key stops working immediately. The assistant on your website disappears until you paste the new embed code there.",
      confirmText: "Rotate key",
      danger: true,
    });
    if (!res.confirmed) return;
    setRotating(true);
    try {
      const r = await api.post("/restaurant/assistant/rotate-key");
      setView({ ...current, config: { ...current.config, botKey: r.botKey }, embedSnippet: r.embedSnippet });
      toast.success("New key created. Update the embed code on your website.");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setRotating(false);
    }
  };

  return (
    <>
      <PageHeader title="Ordering assistant" subtitle="A private chat assistant for your restaurant, for your own website and for the FORKY website." />

      {platformOff && (
        <div className="alert alert-warning radius-8 mb-20" role="alert">
          FORKY has turned the ordering assistant off for the whole platform for now. Your settings are kept.
        </div>
      )}
      {forcedOff && (
        <div className="alert alert-danger radius-8 mb-20" role="alert">
          FORKY has turned the assistant off for your restaurant. Please contact FORKY support if you think this is a mistake.
        </div>
      )}
      {!current.embedEnabled && !platformOff && (
        <div className="alert alert-info radius-8 mb-20" role="alert">
          Embedding on merchant websites is currently switched off by FORKY. The assistant still works on the FORKY website.
        </div>
      )}

      <StatsStrip stats={current.stats} />
      <BrandingPreview config={current.config} fallbackLogo={current.effectiveLogoUrl} forcedOff={forcedOff} platformOff={platformOff} />
      <HowItWorks />

      <div className="row g-3">
        <div className="col-xl-7">
          <Card title="Questions and answers" subtitle={canEdit ? "Your own answers, shown by the bot when a guest asks something similar." : "Only an owner or location manager can change these."} className="mb-20">
            <FaqEditor faqs={form.faqs} onChange={(faqs) => setPart({ faqs })} canEdit={canEdit} title="Your FAQs" />
          </Card>
          <Card title="Websites" subtitle="The embed code only works on the websites you list here.">
            <OriginsEditor origins={form.allowedOrigins} onChange={(v) => setPart({ allowedOrigins: v })} />
          </Card>
          {canEdit && (
            <div className="d-flex gap-2 mt-16">
              <Button loading={saving} disabled={!dirty || !valid} onClick={save}>
                Save changes
              </Button>
              {dirty && (
                <Button variant="light" onClick={() => setForm({ faqs: clone(original.faqs), allowedOrigins: clone(original.allowedOrigins) })}>
                  Discard
                </Button>
              )}
            </div>
          )}
        </div>

        <div className="col-xl-5">
          <Card title="Put it on your website" subtitle="Paste this just before the closing </body> tag of your site." className={live ? "" : "opacity-75"}>
            <EmbedBox snippet={current.embedSnippet} onRotate={canEdit ? rotate : undefined} rotating={rotating} />
          </Card>
        </div>
      </div>
    </>
  );
}

/** Restaurant portal > Assistant: the settings / embed code, and the Training area (teach the bot, inbox, test bench, publish). */
export default function Assistant() {
  const { restaurantRole } = useAuth();
  const { restaurantId } = usePortal();
  const canEdit = MANAGERS.includes(restaurantRole);
  const [tab, setTab] = useState("settings");
  const ov = usePortalFetch("/restaurant/assistant/training/overview");
  const badge = ov.data ? ov.data.unanswered.groups + ov.data.needsReview : 0;
  return (
    <Tabs
      active={tab}
      onChange={setTab}
      tabs={[
        { key: "settings", label: "Settings & embed code", content: <AssistantSettings /> },
        {
          key: "training",
          label: "Training",
          badge: badge || undefined,
          content: (
            <>
              <PageHeader title="Train your assistant" subtitle="Teach it your answers, see what guests asked that it could not answer, test, then publish." />
              <TrainingArea base="/restaurant/assistant/training" params={{ restaurantId }} canEdit={canEdit} />
            </>
          ),
        },
      ]}
    />
  );
}
