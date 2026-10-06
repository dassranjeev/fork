import React from "react";
import { http } from "../../lib/api";
import { useSubmit } from "../../lib/hooks";
import { useAuth } from "../../lib/auth";
import { fmtDateTime } from "../../lib/format";
import { Badge, Button, Card, useConfirm } from "../../ui";

export const MENU_ACCESS_LABEL = { ALLOWED: "Can edit menu", NOT_ALLOWED: "Menu locked", REQUESTED: "Access requested" };
const TONE = { ALLOWED: "success", NOT_ALLOWED: "neutral", REQUESTED: "warning" };

export function MenuAccessBadge({ status }) {
  const s = status || "NOT_ALLOWED";
  return <Badge tone={TONE[s] || "neutral"}>{MENU_ACCESS_LABEL[s] || s}</Badge>;
}

/** Admin: allow or disallow the restaurant adding / updating / removing its own menu items, at any time. */
export function MenuAccessCard({ r, reload }) {
  const confirm = useConfirm();
  const { can } = useAuth();
  const { busy, run } = useSubmit();
  const status = r.menuEditStatus || "NOT_ALLOWED";
  const canApprove = can("restaurants", "approve");

  const decide = async (allowed) => {
    const res = await confirm({
      title: allowed ? `Allow ${r.name} to edit its menu?` : `Turn off menu editing for ${r.name}?`,
      message: allowed
        ? "The restaurant will be able to add, update and remove its own menu items, categories and modifiers."
        : "The restaurant will keep a read-only menu. It can still mark items out of stock (86) and back in stock.",
      confirmText: allowed ? "Allow editing" : "Turn off",
      danger: !allowed,
      prompt: { label: "Note for the restaurant (optional)", type: "textarea", required: false },
    });
    if (!res.confirmed) return;
    run(() => http.patch(`/admin/restaurants/${r.id}/menu-access`, { allowed, note: res.value || undefined }), {
      success: allowed ? "Menu editing allowed" : "Menu editing turned off",
      onDone: reload,
    });
  };

  return (
    <Card title="Menu editing" subtitle="Can this restaurant add, update and remove its own menu items?" className="mb-20">
      <div className="d-flex flex-wrap align-items-center justify-content-between gap-3">
        <div>
          <MenuAccessBadge status={status} />
          {status === "REQUESTED" && (
            <div className="text-sm mt-8">
              Requested {fmtDateTime(r.menuEditRequestedAt)}
              {r.menuEditRequestNote ? `: "${r.menuEditRequestNote}"` : ""}
            </div>
          )}
          {status !== "REQUESTED" && r.menuEditDecidedAt && (
            <div className="text-secondary-light text-sm mt-8">
              Last decision {fmtDateTime(r.menuEditDecidedAt)}
              {r.menuEditDecisionNote ? ` - ${r.menuEditDecisionNote}` : ""}
            </div>
          )}
        </div>
        {canApprove ? (
          <div className="d-flex gap-2">
            {status !== "ALLOWED" && (
              <Button variant="success" loading={!!busy} onClick={() => decide(true)}>
                {status === "REQUESTED" ? "Approve request" : "Allow editing"}
              </Button>
            )}
            {status !== "NOT_ALLOWED" && (
              <Button variant="outline-danger" loading={!!busy} onClick={() => decide(false)}>
                {status === "REQUESTED" ? "Decline" : "Turn off editing"}
              </Button>
            )}
          </div>
        ) : (
          <span className="text-secondary-light text-sm">You need the "approve restaurants" permission to change this.</span>
        )}
      </div>
    </Card>
  );
}
