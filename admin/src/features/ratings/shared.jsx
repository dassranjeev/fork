import React from "react";
import { Icon } from "@iconify/react/offline";
import { Badge, Button, Progress, useConfirm } from "../../ui";
import { http } from "../../lib/api";
import { useSubmit } from "../../lib/hooks";
import { fmtDate } from "../../lib/format";

/** Star glyph + number. `label` shown instead of the number when the target is still "New". */
export function RatingValue({ value, label, count, digits = 2 }) {
  if (value === null || value === undefined) {
    return <span className="text-secondary-light">{label || "New"}{count ? ` (${count})` : ""}</span>;
  }
  return (
    <span className="text-nowrap d-inline-flex align-items-center gap-1">
      <Icon icon="solar:star-bold" className="text-warning-main" />
      <span className="fw-semibold">{Number(value).toFixed(digits)}</span>
      {count !== undefined && count !== null && <span className="text-secondary-light text-xs">({count})</span>}
    </span>
  );
}

export const STAR_ROW = [5, 4, 3, 2, 1];

/** 5..1 distribution bars. `distribution` is {1..5: n} or [{stars,count}]. */
export function Distribution({ distribution }) {
  const map = Array.isArray(distribution) ? Object.fromEntries(distribution.map((d) => [d.stars, d.count])) : distribution || {};
  const total = STAR_ROW.reduce((a, s) => a + (Number(map[s]) || 0), 0);
  return (
    <div>
      {STAR_ROW.map((s) => {
        const n = Number(map[s]) || 0;
        return (
          <div key={s} className="d-flex align-items-center gap-2 mb-6" aria-label={`${s} stars: ${n}`}>
            <span className="text-sm text-nowrap" style={{ width: 28 }}>{s} <Icon icon="solar:star-bold" className="text-warning-main" /></span>
            <div style={{ flex: 1 }}>
              <Progress value={n} max={total || 1} tone={s >= 4 ? "success" : s === 3 ? "warning" : "danger"} height={8} />
            </div>
            <span className="text-sm text-secondary-light text-end" style={{ width: 36 }}>{n}</span>
          </div>
        );
      })}
    </div>
  );
}

export function TagChips({ tags = [], tone = "neutral", empty = "No tags yet" }) {
  if (!tags.length) return <span className="text-secondary-light text-sm">{empty}</span>;
  return (
    <div className="d-flex gap-2 flex-wrap">
      {tags.map((t) => (
        <Badge key={t.tag || t} tone={tone}>
          {t.label || String(t.tag || t).replace(/_/g, " ").toLowerCase()}
          {t.count !== undefined ? ` · ${t.count}` : ""}
        </Badge>
      ))}
    </div>
  );
}

export const REVIEW_TONE = { VISIBLE: "success", HIDDEN: "neutral", FLAGGED: "warning" };
export const FLAG_LABEL = {
  FRAUD_ACCOUNT: "Account has fraud flag",
  REVIEW_BOMB: "Review bomb pattern",
  DUPLICATE_TEXT: "Duplicate text",
  REFUND_RETALIATION: "After a refused refund",
  REPORTED_BY_RESTAURANT: "Reported by restaurant",
  STAFF_FLAGGED: "Flagged by staff",
};

/** Mini weekly trend as a list of bars (avoids a heavy chart for tiny data). */
export function TrendBars({ trend = [] }) {
  if (!trend.length) return <span className="text-secondary-light text-sm">Not enough data for a trend yet</span>;
  return (
    <div className="d-flex align-items-end gap-2" style={{ height: 90 }} aria-label="weekly rating trend">
      {trend.map((w) => (
        <div key={w.week} className="text-center" style={{ flex: 1, minWidth: 18 }} title={`${w.week}: ${w.avg} (${w.count})`}>
          <div className="text-xs text-secondary-light">{Number(w.avg).toFixed(1)}</div>
          <div className="bg-warning-main radius-4" style={{ height: Math.max(6, (Number(w.avg) / 5) * 56) }} />
          <div className="text-xs text-secondary-light">{String(w.week).slice(5)}</div>
        </div>
      ))}
    </div>
  );
}

/** Moderation buttons for one review side (hide / flag / restore with a required reason). */
export function ModerationButtons({ review, side, onDone, allowed = true }) {
  const confirm = useConfirm();
  const { run } = useSubmit();
  if (!allowed) return null;
  const act = async (action) => {
    const label = action === "HIDE" ? "Hide" : action === "FLAG" ? "Flag" : "Restore";
    const res = await confirm({ title: `${label} this review?`, danger: action !== "RESTORE", prompt: { label: "Reason (required, audit-logged)", type: "text", required: true } });
    if (!res.confirmed || !res.value) return;
    const path = side === "DRIVER" ? `/admin/ratings/driver-reviews/${review.id}/moderate` : `/admin/ratings/restaurant-reviews/${review.id}/moderate`;
    run(() => http.post(path, { action, reason: res.value }), { success: "Review updated", onDone });
  };
  const st = review.status || "VISIBLE";
  return (
    <div className="d-flex gap-2 flex-wrap">
      {st !== "HIDDEN" && <Button variant="light" onClick={() => act("HIDE")}>Hide</Button>}
      {st === "VISIBLE" && <Button variant="light" onClick={() => act("FLAG")}>Flag</Button>}
      {st !== "VISIBLE" && <Button variant="outline" onClick={() => act("RESTORE")}>Restore</Button>}
    </div>
  );
}

export function ReviewMeta({ review }) {
  const reasons = (review.flagReasons || []).map((r) => FLAG_LABEL[r] || r);
  const last = (review.moderation || []).slice(-1)[0];
  return (
    <div className="text-xs text-secondary-light mt-1">
      {fmtDate(review.createdAt)}
      {review.orderCode ? ` · order ${review.orderCode}` : ""}
      {reasons.length > 0 && <span className="text-warning-main"> · {reasons.join(", ")}</span>}
      {last && <span> · {last.action.toLowerCase()} by {last.byName || "staff"}: {last.reason}</span>}
      {review.reportReason && <span> · restaurant report: {review.reportReason}</span>}
    </div>
  );
}
