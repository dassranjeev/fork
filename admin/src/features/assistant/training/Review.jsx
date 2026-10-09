import React, { useCallback, useEffect, useState } from "react";
import { toast } from "react-toastify";
import { Badge, Button, Card, EmptyState } from "../../../ui";
import { problem } from "./kit";

/** Answers that guests rated "thumbs down": the bot's answer, the questions, the comments. */
export default function Review({ api, canEdit, onChanged }) {
  const [data, setData] = useState(null);
  const load = useCallback(() => {
    api.get("/feedback-review").then(setData).catch(() => setData({ data: [], total: 0 }));
  }, [api]);
  useEffect(load, [load]);
  const dismiss = async (id) => {
    try {
      await api.post(`/feedback-review/${id}/dismiss`);
      load();
      onChanged?.();
    } catch (e) {
      toast.error(problem(e).message);
    }
  };
  if (!data) return null;
  return (
    <Card title="Needs review" subtitle="Answers that guests marked with a thumbs down" className="mt-20">
      {!data.data.length ? (
        <EmptyState icon="solar:like-outline" title="No downvoted answers" text="When a guest taps thumbs down on an answer, it shows up here." />
      ) : (
        <div className="d-flex flex-column gap-3">
          {data.data.map((r) => (
            <div key={r.entryId} className="border radius-8 p-12" data-testid="review-row">
              <div className="d-flex justify-content-between flex-wrap gap-2">
                <div>
                  <b>{r.title}</b> <Badge tone="danger">{r.pending} new thumbs down</Badge> <span className="text-secondary-light text-sm">({r.up} up, {r.down} down in total)</span>
                </div>
                {canEdit && (
                  <Button variant="light" onClick={() => dismiss(r.entryId)}>
                    Mark reviewed
                  </Button>
                )}
              </div>
              <div className="text-secondary-light text-sm mt-4">{r.answer}</div>
              {r.recent.map((x, i) => (
                <div key={i} className="text-sm mt-4">
                  "{x.question || "(question not recorded)"}" {x.comment ? `: ${x.comment}` : ""}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
