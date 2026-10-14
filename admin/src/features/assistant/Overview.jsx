import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "react-toastify";
import { errorMessage, http } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useFetch } from "../../lib/hooks";
import { Button, Card, ErrorState, Loading, NumberInput, PageHeader, StatCard, Switch } from "../../ui";
import { clone, same } from "./parts";

const STATS = [
  ["chats", "Chats"],
  ["embeddedChats", "- on merchant websites"],
  ["siteChats", "- on the FORKY website"],
  ["messages", "Messages"],
  ["carts", "Carts started"],
  ["handoffs", "Sent to checkout"],
  ["imported", "Carts imported on FORKY"],
];

export default function Overview() {
  const { can } = useAuth();
  const canEdit = can("settings", "edit");
  const { data, loading, error, reload } = useFetch("/admin/assistant/overview");
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (data) setForm(clone(data.platform));
  }, [data]);

  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorState error={error} onRetry={reload} />;
  if (!data || !form) return null;
  const dirty = !same(form, data.platform);

  const save = async () => {
    setSaving(true);
    try {
      const values = {
        "assistant.enabled": form.enabled,
        "assistant.embed.enabled": form.embedEnabled,
        "assistant.sessionTtlHours": Number(form.sessionTtlHours),
        "assistant.maxMessagesPerSession": Number(form.maxMessagesPerSession),
        "assistant.handoffTtlMinutes": Number(form.handoffTtlMinutes),
      };
      await http.put("/admin/settings", { values });
      if (form.centralEnabled !== data.platform.centralEnabled) await http.patch("/admin/assistant/central", { enabled: form.centralEnabled });
      toast.success("Assistant settings saved");
      reload();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  const num = (k, label, hint, min, max) => (
    <NumberInput col={4} label={label} hint={hint} value={form[k]} min={min} max={max} step={1} disabled={!canEdit} onChange={(v) => setForm((f) => ({ ...f, [k]: v }))} />
  );
  const r = data.restaurants;

  return (
    <>
      <PageHeader title="Assistant" subtitle="Ordering bots for every restaurant and for the FORKY website" crumbs={[{ label: "Assistant" }]} />

      <div className="row g-3 mb-20">
        <div className="col-6 col-xl-3">
          <StatCard label="Restaurants" value={r.total} icon="solar:shop-2-outline" to="/assistant/restaurants" hint="all locations" />
        </div>
        <div className="col-6 col-xl-3">
          <StatCard label="Bot active" value={r.active} icon="solar:chat-round-dots-outline" tone="success" to="/assistant/restaurants" hint={`${r.withOrigins} with a website`} />
        </div>
        <div className="col-6 col-xl-3">
          <StatCard label="Off (restaurant)" value={r.disabled} icon="solar:power-outline" tone="warning" to="/assistant/restaurants" />
        </div>
        <div className="col-6 col-xl-3">
          <StatCard label="Off (by FORKY)" value={r.forcedOff} icon="solar:shield-warning-outline" tone="danger" to="/assistant/restaurants" />
        </div>
      </div>

      <Card title="Platform switches" subtitle={canEdit ? "These apply to every bot immediately." : "You need the 'edit settings' permission to change these."} className="mb-20">
        <div className="row">
          <Switch col={4} label="Assistant enabled (all bots)" hint="Master switch for the FORKY website bot and every restaurant bot." checked={form.enabled} disabled={!canEdit} onChange={(v) => setForm((f) => ({ ...f, enabled: v }))} />
          <Switch col={4} label="Embedding on merchant websites" hint="Off: restaurants' own websites lose the widget; the FORKY website keeps working." checked={form.embedEnabled} disabled={!canEdit} onChange={(v) => setForm((f) => ({ ...f, embedEnabled: v }))} />
          <Switch col={4} label="Central bot (FORKY website)" hint="The restaurant finder on the main website. More options under Central bot." checked={form.centralEnabled} disabled={!canEdit} onChange={(v) => setForm((f) => ({ ...f, centralEnabled: v }))} />
        </div>
        <div className="row">
          {num("sessionTtlHours", "Chat expires after (hours of inactivity)", "The cart in the chat is lost after this.", 1, 168)}
          {num("maxMessagesPerSession", "Max messages per chat", "After this the guest starts a new chat.", 10, 2000)}
          {num("handoffTtlMinutes", "Checkout link valid for (minutes)", "One-time link to the FORKY website.", 1, 1440)}
        </div>
        {canEdit && (
          <Button loading={saving} disabled={!dirty} onClick={save}>
            Save settings
          </Button>
        )}
      </Card>

      <div className="row g-3 mb-20">
        {[
          ["d7", "Last 7 days"],
          ["d30", "Last 30 days"],
        ].map(([k, title]) => (
          <div className="col-lg-6" key={k}>
            <Card title={title} subtitle="Platform-wide, all bots">
              <table className="table mb-0">
                <tbody>
                  {STATS.map(([key, label]) => (
                    <tr key={key}>
                      <td className="text-secondary-light">{label}</td>
                      <td className="text-end fw-semibold" data-testid={`${k}-${key}`}>
                        {data.stats[k][key]}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </div>
        ))}
      </div>
      <Card title="Teach the bots" subtitle="Each bot can be trained with its own answers, nicknames and documents. Unanswered questions are collected (without names or contact details) so owners can teach them." className="mb-20">
        <Link className="btn btn-primary-600 btn-sm radius-8" to="/assistant/training">
          Bot training
        </Link>
      </Card>

      <Card title="How the assistant works">
        <ul className="mb-16 ps-20">
          <li>Each restaurant has a private bot that only knows that restaurant's menu, hours and FAQs. It builds a cart and hands the guest over to FORKY to pay.</li>
          <li>A restaurant can show its bot on its own website with an embed code; the bot only runs on the websites listed for it.</li>
          <li>The central bot on the FORKY website finds restaurants and then continues as that restaurant's bot.</li>
          <li>Restaurants teach their bot (answers, nicknames, documents) and set allowed websites; FORKY controls the name, greeting, colour, logo and on/off.</li>
        </ul>
        <div className="d-flex flex-wrap gap-2">
          <Link className="btn btn-primary-600 btn-sm radius-8" to="/assistant/restaurants">
            Restaurant bots
          </Link>
          {can("settings", "view") && (
            <Link className="btn btn-outline-primary-600 btn-sm radius-8" to="/assistant/central">
              Central bot
            </Link>
          )}
        </div>
      </Card>
    </>
  );
}
