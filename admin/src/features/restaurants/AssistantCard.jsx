import React from "react";
import { Link } from "react-router-dom";
import { http } from "../../lib/api";
import { useFetch, useSubmit } from "../../lib/hooks";
import { useAuth } from "../../lib/auth";
import { Badge, Card, Switch, useConfirm } from "../../ui";

/** Admin: status of a restaurant's ordering assistant (bot), the force-off switch and a link to the full editor (Assistant > Restaurant bots). */
export default function AssistantCard({ r, className = "mb-20" }) {
  const confirm = useConfirm();
  const { can } = useAuth();
  const { busy, run } = useSubmit();
  const { data, loading, error, reload } = useFetch(`/admin/restaurants/${r.id}/assistant`);
  const canEdit = can("restaurants", "edit");

  const status = !data ? null : !data.platformEnabled ? ["Platform off", "warning"] : data.forcedOff ? ["Off (by FORKY)", "danger"] : !data.config.enabled ? ["Off (by restaurant)", "neutral"] : ["Active", "success"];

  const toggle = async (forcedOff) => {
    const res = await confirm({
      title: forcedOff ? `Turn off the assistant for ${r.name}?` : `Allow the assistant for ${r.name} again?`,
      message: forcedOff ? "The bot stops answering on the restaurant's website and on FORKY at once, and the restaurant cannot switch it back on." : "The restaurant can use the assistant again (it follows the restaurant's own on/off setting).",
      confirmText: forcedOff ? "Turn off" : "Allow again",
      danger: forcedOff,
    });
    if (!res.confirmed) return;
    run(() => http.patch(`/admin/restaurants/${r.id}/assistant`, { forcedOff }), { success: forcedOff ? "Assistant turned off" : "Assistant allowed again", onDone: reload });
  };

  const s = data?.stats || {};
  return (
    <Card title="Ordering assistant" subtitle="The restaurant's chat bot (menu questions, cart building, hand-off to checkout)." className={className} actions={<Link className="btn btn-outline-primary-600 btn-sm radius-8" to={`/assistant/restaurants/${r.id}`}>Manage assistant</Link>}>
      {loading && !data ? (
        <div className="text-secondary-light">Loading…</div>
      ) : error && !data ? (
        <div className="text-danger-main">Could not load the assistant status.</div>
      ) : (
        <div className="d-flex flex-wrap align-items-center justify-content-between gap-3">
          <div>
            <Badge tone={status[1]}>{status[0]}</Badge>
            <div className="text-secondary-light text-sm mt-8">
              Last 7 days: {s.chats7d ?? 0} chats, {s.carts7d ?? 0} carts, {s.handoffs7d ?? 0} sent to checkout, {s.imported7d ?? 0} imported
            </div>
            <div className="text-secondary-light text-sm">{data.config.allowedOrigins.length ? `Allowed websites: ${data.config.allowedOrigins.join(", ")}` : "No website is allowed yet (works on FORKY only)."}</div>
          </div>
          {canEdit ? (
            <Switch label="Force off (admin)" hint="Overrides the restaurant's own switch." className="mb-0" checked={!!data.forcedOff} disabled={!!busy} onChange={toggle} />
          ) : (
            <span className="text-secondary-light text-sm">You need the "edit restaurants" permission to change this.</span>
          )}
        </div>
      )}
    </Card>
  );
}
