import React, { useState } from "react";
import { safeUrl } from "../../lib/safe";
import { Link } from "react-router-dom";
import { toast } from "react-toastify";
import { API_URL, http } from "../../lib/api";
import { useFetch, useSubmit } from "../../lib/hooks";
import { useAuth } from "../../lib/auth";
import { Button, FormModal, NumberInput, TextArea, useConfirm } from "../../ui";

export const RESTAURANT_STATUSES = ["APPLIED", "DOCS_REVIEW", "MENU_SETUP", "TEST_ORDER", "LIVE", "PAUSED", "SUSPENDED", "REJECTED"];
export const PRE_LIVE = ["APPLIED", "DOCS_REVIEW", "MENU_SETUP", "TEST_ORDER"];
export const DOC_TYPES = ["BUSINESS_LICENCE", "HEALTH_CERTIFICATE", "VOID_CHEQUE", "HST_CERTIFICATE", "AGREEMENT", "MENU", "PHOTOS", "OTHER"];
export const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Files are served by the API host; stored urls can be relative ("/uploads/..."). */
export const assetUrl = (u) => {
  const s = safeUrl(u, "");
  if (!s) return "#";
  return s.startsWith("/") ? `${API_URL.replace(/\/api\/v\d+\/?$/, "")}${s}` : s;
};

export const listOf = (res) => res?.data ?? (Array.isArray(res) ? res : []);

/** Cities, zones and commission tiers used by filters and forms. */
export function useLookups() {
  const cities = useFetch("/admin/cities", { limit: 100 });
  const zones = useFetch("/admin/zones", { limit: 100 });
  const tiers = useFetch("/admin/commission-tiers", { limit: 100 });
  const c = listOf(cities.data);
  const z = listOf(zones.data);
  const t = listOf(tiers.data);
  return {
    cities: c,
    zones: z,
    tiers: t,
    zoneName: (id) => z.find((x) => x.id === id)?.name,
    tierName: (id) => t.find((x) => x.id === id)?.name,
  };
}

export const restaurantPost = (id, path, body) => http.post(`/admin/restaurants/${id}/${path}`, body || {});

/**
 * Lifecycle buttons for a restaurant, depending on its status and the viewer's permissions.
 *   <RestaurantActions restaurant={r} onChanged={reload} />
 */
export function RestaurantActions({ restaurant: r, onChanged, detailLink }) {
  const confirm = useConfirm();
  const { can, isSuper } = useAuth();
  const { busy, run } = useSubmit();
  const [pause, setPause] = useState(false);
  const [pauseForm, setPauseForm] = useState({ reason: "", hours: "" });
  const canEdit = can("restaurants", "edit");
  const canApprove = can("restaurants", "approve");
  const done = () => onChanged?.();
  const s = r.status;

  const withReason = async (path, title, success, { required = true, danger = false, confirmText } = {}) => {
    const res = await confirm({ title, danger, confirmText, prompt: { label: required ? "Reason" : "Reason (optional)", type: "textarea", required } });
    if (!res.confirmed) return;
    run(() => restaurantPost(r.id, path, res.value ? { reason: res.value } : {}), { success, onDone: done });
  };

  const goLive = async () => {
    const res = await confirm({ title: `Take ${r.name} live?`, message: "Documents, commission, zone, menu and test order are checked first.", confirmText: "Go live" });
    if (!res.confirmed) return;
    try {
      await restaurantPost(r.id, "go-live");
      toast.success("Restaurant is live");
      done();
    } catch (e) {
      const d = e?.response?.data;
      const msg = (Array.isArray(d?.details) && d.details.join(", ")) || d?.message || "Go-live checks failed";
      if (!isSuper) return toast.error(msg);
      const f = await confirm({
        title: "Go-live checks failed",
        danger: true,
        confirmText: "Force go-live",
        message: `${msg}. As super admin you can force this.`,
        prompt: { label: "Reason for override", type: "text", required: true },
      });
      if (f.confirmed) run(() => restaurantPost(r.id, "go-live", { force: true, reason: f.value }), { success: "Restaurant is live (forced)", onDone: done });
    }
  };

  const menuReview = async (approved) => {
    const res = await confirm({
      title: approved ? "Approve the menu?" : "Request menu changes",
      confirmText: approved ? "Approve" : "Send request",
      prompt: { label: approved ? "Notes (optional)" : "What needs to change?", type: "textarea", required: !approved },
    });
    if (!res.confirmed) return;
    run(() => restaurantPost(r.id, "menu-review", { approved, notes: res.value || undefined }), { success: approved ? "Menu approved" : "Change request sent", onDone: done });
  };

  const testOrder = async (action) => {
    const res = await confirm({ title: action === "request" ? "Request a test order" : "Mark test order complete", prompt: { label: "Notes (optional)", type: "textarea" } });
    if (!res.confirmed) return;
    run(() => restaurantPost(r.id, "test-order", { action, notes: res.value || undefined }), { success: action === "request" ? "Test order requested" : "Test order marked complete", onDone: done });
  };

  const submitPause = () => {
    run(() => restaurantPost(r.id, "pause", { reason: pauseForm.reason, resumeAfterHours: pauseForm.hours ? Number(pauseForm.hours) : undefined }), {
      success: "Restaurant paused",
      onDone: () => {
        setPause(false);
        setPauseForm({ reason: "", hours: "" });
        done();
      },
    });
  };

  const btns = [];
  if (detailLink)
    btns.push(
      <Link key="d" to={`/restaurants/${r.id}`} className="btn btn-outline-neutral-300 text-primary-light btn-sm radius-8">
        Open
      </Link>
    );
  if (canEdit && s === "TEST_ORDER") {
    btns.push(<Button key="to1" variant="light" onClick={() => testOrder("request")}>Request test order</Button>);
    btns.push(<Button key="to2" variant="light" onClick={() => testOrder("complete")}>Test order done</Button>);
  }
  if (canApprove && s === "MENU_SETUP") {
    btns.push(<Button key="m1" variant="success" onClick={() => menuReview(true)}>Approve menu</Button>);
    btns.push(<Button key="m2" variant="light" onClick={() => menuReview(false)}>Request changes</Button>);
  }
  if (canApprove && s === "TEST_ORDER") btns.push(<Button key="gl" variant="success" icon="solar:rocket-2-outline" onClick={goLive}>Go live</Button>);
  if (canApprove && ["APPLIED", "DOCS_REVIEW", "MENU_SETUP"].includes(s) && !detailLink) btns.push(<Button key="gl0" variant="light" onClick={goLive}>Go live…</Button>);
  if (canEdit && s === "LIVE") btns.push(<Button key="p" variant="warning" icon="solar:pause-circle-outline" onClick={() => setPause(true)}>Pause</Button>);
  if (canEdit && ["PAUSED", "SUSPENDED"].includes(s))
    btns.push(
      <Button key="r" variant="success" icon="solar:play-circle-outline" onClick={() => withReason("reactivate", `Reactivate ${r.name}?`, "Restaurant reactivated", { required: false, confirmText: "Reactivate" })}>
        Reactivate
      </Button>
    );
  if (canEdit && ["LIVE", "PAUSED"].includes(s))
    btns.push(
      <Button key="su" variant="outline-danger" onClick={() => withReason("suspend", `Suspend ${r.name}?`, "Restaurant suspended", { danger: true, confirmText: "Suspend" })}>
        Suspend
      </Button>
    );
  if (canApprove && PRE_LIVE.includes(s))
    btns.push(
      <Button key="rj" variant="outline-danger" onClick={() => withReason("reject", `Reject ${r.name}?`, "Application rejected", { danger: true, confirmText: "Reject" })}>
        Reject
      </Button>
    );

  if (!btns.length) return null;
  return (
    <>
      <div className="d-flex flex-wrap gap-2 align-items-center">{btns}</div>
      <FormModal open={pause} onClose={() => setPause(false)} title={`Pause ${r.name}`} onSubmit={submitPause} busy={busy} submitText="Pause" disabled={(pauseForm.reason || "").trim().length < 3}>
        <TextArea label="Reason" required value={pauseForm.reason} onChange={(v) => setPauseForm((f) => ({ ...f, reason: v }))} />
        <NumberInput label="Auto-resume after (hours)" hint="Leave empty to stay paused until reactivated." min={1} step={1} value={pauseForm.hours} onChange={(v) => setPauseForm((f) => ({ ...f, hours: v }))} />
      </FormModal>
    </>
  );
}
