import React, { useEffect, useState } from "react";
import { Icon } from "@iconify/react/offline";
import { Button, FormModal, MultiCheck, TextArea } from "../../ui";
import { http } from "../../lib/api";
import { useAction, useApi } from "../portal/shared";
import { usePortal } from "../portal/context";

/** Portal order detail: private "rate this customer" action (roles OWNER / LOCATION_MANAGER / CASHIER). */
export default function RateCustomerPanel({ order }) {
  const { role } = usePortal();
  const api = useApi();
  const { busy, run } = useAction();
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);
  const [rating, setRating] = useState(0);
  const [tags, setTags] = useState([]);
  const [note, setNote] = useState("");
  const [opts, setOpts] = useState(null);
  useEffect(() => {
    if (open && !opts) http.get("/public/rating-options").then((r) => setOpts(r.customerFeedback), () => setOpts({ positive: [], negative: [] }));
  }, [open, opts]);
  if (!["OWNER", "LOCATION_MANAGER", "CASHIER"].includes(role)) return null;
  const submit = async () => {
    const r = await run("rate", () => api.post(`/restaurant/orders/${order.id}/rate-customer`, { rating, tags, note: note.trim() || undefined }), "Thanks - your feedback was recorded");
    if (r.ok) {
      setDone(true);
      setOpen(false);
    }
  };
  const all = opts ? [...opts.positive, ...opts.negative] : [];
  return (
    <div className="mt-16 p-12 bg-neutral-100 radius-8">
      <div className="d-flex justify-content-between align-items-center gap-2 flex-wrap">
        <div>
          <div className="fw-semibold text-sm">Customer feedback</div>
          <div className="text-secondary-light text-xs">Private: only FORKY staff see it, never the customer.</div>
        </div>
        {done ? <span className="text-success-600 text-sm"><Icon icon="solar:check-circle-bold" /> Submitted</span> : <Button variant="outline" icon="solar:star-outline" onClick={() => setOpen(true)}>Rate customer</Button>}
      </div>
      <FormModal open={open} onClose={() => setOpen(false)} title={`Rate the customer for ${order.code}`} onSubmit={submit} busy={!!busy} submitText="Submit feedback" disabled={!rating}>
        <div className="mb-16" role="radiogroup" aria-label="Rating">
          {[1, 2, 3, 4, 5].map((i) => (
            <button key={i} type="button" className="btn p-0 border-0 bg-transparent me-1" aria-label={`${i} stars`} aria-pressed={rating >= i} onClick={() => setRating(i)}>
              <Icon icon="solar:star-bold" style={{ fontSize: 30, color: i <= rating ? "#f59e0b" : "#d1d5db" }} />
            </button>
          ))}
        </div>
        <MultiCheck label="What stood out? (optional)" options={all.map((t) => ({ value: t.code, label: t.label }))} value={tags} onChange={setTags} cols={2} />
        <TextArea label="Note for FORKY (optional)" rows={2} value={note} onChange={setNote} maxLength={500} />
      </FormModal>
    </div>
  );
}
