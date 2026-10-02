import React, { useState } from "react";
import { Icon } from "@iconify/react/offline";
import { Badge, Button, EmptyState, ErrorState, FilterSelect, FormModal, Loading, Pager, TextArea } from "../../ui";
import { fmtDateTime } from "../../lib/format";
import { useLocalState } from "../../lib/hooks";
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

export default function Reviews() {
  const [page, setPage] = useState(1);
  const [maxRating, setMaxRating] = useLocalState("portal.reviews.max", "");
  const [replied, setReplied] = useLocalState("portal.reviews.replied", "");
  const [reply, setReply] = useState(null);
  const state = usePortalFetch("/restaurant/reviews", { page, limit: 10, maxRating: maxRating || undefined, replied: replied || undefined });
  const rows = state.data?.data || [];
  return (
    <PortalPage title="Reviews" subtitle="What customers say about your food">
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
            {r.tags?.length > 0 && <div className="d-flex gap-2 mb-8 flex-wrap">{r.tags.map((t) => <Badge key={t} tone="neutral">{t}</Badge>)}</div>}
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
          </div>
        </div>
      ))}
      {state.data?.meta && <Pager meta={state.data.meta} onPage={setPage} />}
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
