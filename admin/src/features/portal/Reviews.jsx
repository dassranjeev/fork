import React, { useState } from "react";
import { Icon } from "@iconify/react/offline";
import { Badge, Button, EmptyState, ErrorState, FilterSelect, FormModal, Loading, Pager, TextArea } from "../../ui";
import { fmtDateTime } from "../../lib/format";
import { useLocalState } from "../../lib/hooks";
import RestaurantRatingSummary from "../ratings/RestaurantRatingSummary";
import { PortalPage, useAction, useApi, usePortalFetch } from "./shared";

export function Stars({ value }) {
  return (
    <span className="d-inline-flex gap-1" aria-label={`${value} stars`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <Icon key={i} icon="solar:star-bold" style={{ color: i <= value ? "#f59e0b" : "#d1d5db" }} />
      ))}
    </span>
  );
}

function ReplyModal({ review, onClose, onDone }) {
  const api = useApi();
  const { busy, run } = useAction();
  const [text, setText] = useState("");
  React.useEffect(() => setText(review?.reply || ""), [review]);
  if (!review) return null;
  const submit = async () => {
    const r = await run("reply", () => api.post(`/restaurant/reviews/${review.id}/reply`, { reply: text.trim() }), "Reply sent");
    if (r.ok) onDone();
  };
  return (
    <FormModal open onClose={onClose} title={`Reply to ${review.customerName || "customer"}`} onSubmit={submit} busy={!!busy} submitText="Send reply" disabled={!text.trim()}>
      <div className="p-12 bg-neutral-100 radius-8 mb-16">
        <Stars value={review.rating} />
        <div className="mt-4 text-sm">{review.comment || <em className="text-secondary-light">No comment</em>}</div>
      </div>
      <TextArea label="Your reply" rows={4} value={text} onChange={setText} placeholder="Thank you for your feedback…" />
      <p className="text-secondary-light text-xs mb-0">The customer is notified and the reply is shown publicly.</p>
    </FormModal>
  );
}

function ReportModal({ review, onClose, onDone }) {
  const api = useApi();
  const { busy, run } = useAction();
  const [text, setText] = useState("");
  if (!review) return null;
  const submit = async () => {
    const r = await run("report", () => api.post(`/restaurant/reviews/${review.id}/report`, { reason: text.trim() }), "Reported - FORKY staff will review it");
    if (r.ok) onDone();
  };
  return (
    <FormModal open onClose={onClose} title="Report this review" onSubmit={submit} busy={!!busy} submitText="Report review" submitVariant="danger" disabled={text.trim().length < 5}>
      <div className="p-12 bg-neutral-100 radius-8 mb-16">
        <Stars value={review.rating} />
        <div className="mt-4 text-sm">{review.comment || <em className="text-secondary-light">No comment</em>}</div>
      </div>
      <TextArea label="Why is it abusive or untrue?" rows={3} value={text} onChange={setText} placeholder="Hate speech, spam, a different restaurant, personal details…" maxLength={500} />
      <p className="text-secondary-light text-xs mb-0">While staff review it, the review is held back from your public rating. You can report each review once. Reports are for abuse, not for disagreeing with a rating.</p>
    </FormModal>
  );
}

export default function Reviews() {
  const [page, setPage] = useState(1);
  const [maxRating, setMaxRating] = useLocalState("portal.reviews.max", "");
  const [replied, setReplied] = useLocalState("portal.reviews.replied", "");
  const [reply, setReply] = useState(null);
  const [report, setReport] = useState(null);
  const summary = usePortalFetch("/restaurant/reviews/summary");
  const state = usePortalFetch("/restaurant/reviews", { page, limit: 10, maxRating: maxRating || undefined, replied: replied || undefined });
  const rows = state.data?.data || [];
  return (
    <PortalPage title="Reviews" subtitle="What customers say about your food">
      <RestaurantRatingSummary state={summary} />
      <div className="d-flex flex-wrap gap-3 mb-20">
        <FilterSelect
          value={maxRating}
          onChange={(v) => {
            setMaxRating(v);
            setPage(1);
          }}
          placeholder="All ratings"
          options={[
            { value: "2", label: "2 stars and below" },
            { value: "3", label: "3 stars and below" },
            { value: "4", label: "4 stars and below" },
          ]}
        />
        <FilterSelect
          value={replied}
          onChange={(v) => {
            setReplied(v);
            setPage(1);
          }}
          placeholder="Replied or not"
          options={[
            { value: "false", label: "Needs reply" },
            { value: "true", label: "Replied" },
          ]}
        />
      </div>
      {state.error && !state.data && <ErrorState error={state.error} onRetry={state.reload} />}
      {state.loading && !state.data && <Loading />}
      {state.data && rows.length === 0 && <EmptyState icon="solar:star-outline" title="No reviews found" text="Try changing the filters." />}
      {rows.map((r) => (
        <div key={r.id} className="card radius-12 border-0 shadow-sm mb-12" style={{ opacity: state.loading ? 0.6 : 1 }}>
          <div className="card-body p-20">
            <div className="d-flex flex-wrap justify-content-between gap-2 mb-8">
              <div className="d-flex align-items-center gap-3">
                <Stars value={r.rating} />
                <span className="fw-semibold">{r.customerName || "Customer"}</span>
                <span className="text-secondary-light text-sm">Order {r.orderCode}</span>
              </div>
              <span className="text-secondary-light text-sm">{fmtDateTime(r.createdAt)}</span>
            </div>
            {r.status && r.status !== "VISIBLE" && <div className="mb-8"><Badge tone="warning">{r.status === "HIDDEN" ? "Hidden by FORKY staff" : "Held back for staff review"}</Badge></div>}
            {r.tags?.length > 0 && <div className="d-flex gap-2 mb-8 flex-wrap">{r.tags.map((t) => <Badge key={t} tone="neutral">{String(t).replace(/_/g, " ").toLowerCase()}</Badge>)}</div>}
            <p className="mb-12">{r.comment || <em className="text-secondary-light">No comment left</em>}</p>
            {r.reply ? (
              <div className="p-12 bg-primary-50 radius-8 d-flex justify-content-between gap-3">
                <div>
                  <div className="text-xs text-secondary-light mb-4">Your reply · {fmtDateTime(r.repliedAt)}</div>
                  <div className="text-sm">{r.reply}</div>
                </div>
                <Button variant="outline" onClick={() => setReply(r)}>
                  Edit
                </Button>
              </div>
            ) : (
              <Button variant="outline" icon="solar:chat-round-dots-outline" onClick={() => setReply(r)}>
                Reply
              </Button>
            )}
            {!r.reportedAt && r.status !== "HIDDEN" && (
              <Button variant="link" className="ms-2 text-danger-600" icon="solar:flag-outline" onClick={() => setReport(r)}>
                Report as abusive
              </Button>
            )}
            {r.reportedAt && <span className="text-secondary-light text-xs ms-2">Reported {fmtDateTime(r.reportedAt)}</span>}
          </div>
        </div>
      ))}
      {state.data?.meta && <Pager meta={state.data.meta} onPage={setPage} />}
      <ReportModal
        review={report}
        onClose={() => setReport(null)}
        onDone={() => {
          setReport(null);
          state.reload();
          summary.reload();
        }}
      />
      <ReplyModal
        review={reply}
        onClose={() => setReply(null)}
        onDone={() => {
          setReply(null);
          state.reload();
        }}
      />
    </PortalPage>
  );
}
