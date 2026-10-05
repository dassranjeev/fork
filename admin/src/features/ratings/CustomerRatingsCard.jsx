import React from "react";
import { Link } from "react-router-dom";
import { Badge, Card, DataTable, ErrorState, Loading, StatCard } from "../../ui";
import { useFetch } from "../../lib/hooks";
import { fmtDateTime } from "../../lib/format";
import { Distribution, RatingValue, TagChips } from "./shared";

const STATUS_TONE = { new: "neutral", good: "success", caution: "danger" };

/** Staff-only "Ratings received" card: private feedback from drivers and restaurants. Never shown to customers or partners. */
export default function CustomerRatingsCard({ customerId }) {
  const { data: r, loading, error, reload } = useFetch(`/admin/ratings/customers/${customerId}`);
  if (loading && !r) return <Loading />;
  if (error && !r) return <ErrorState error={error} onRetry={reload} />;
  if (!r) return null;
  const serious = (r.tags || []).filter((t) => t.serious);
  return (
    <>
      <div className="alert alert-light border mb-16 text-sm">Private feedback from drivers and restaurants. It is never shown to the customer, the public, or the drivers and restaurants themselves.</div>
      <div className="row g-3 mb-16">
        <div className="col-6 col-md-3"><StatCard label="Average (smoothed)" value={r.ratingAvg == null ? "—" : Number(r.ratingAvg).toFixed(2)} icon="solar:star-outline" tone="warning" /></div>
        <div className="col-6 col-md-3"><StatCard label="Ratings received" value={r.ratingCount} icon="solar:chat-square-like-outline" tone="info" /></div>
        <div className="col-6 col-md-3"><StatCard label="Low ratings (30 days)" value={r.lowRatingCount30d} icon="solar:danger-triangle-outline" tone={r.lowRatingCount30d ? "danger" : "success"} /></div>
        <div className="col-6 col-md-3"><StatCard label="Ops signal" value={r.status} icon="solar:shield-check-outline" tone={r.status === "caution" ? "danger" : r.status === "good" ? "success" : "primary"} /></div>
      </div>
      {(r.flags.length > 0 || serious.length > 0) && (
        <div className="mb-16 d-flex gap-2 flex-wrap align-items-center">
          {r.flags.map((f) => <Badge key={f} tone="danger">{f.replace(/_/g, " ")}</Badge>)}
          {serious.map((t) => <Badge key={t.tag} tone="danger">{t.label} x{t.count}</Badge>)}
        </div>
      )}
      <div className="row g-3 mb-16">
        <div className="col-lg-4"><Card title="Distribution"><Distribution distribution={r.distribution} /></Card></div>
        <div className="col-lg-8"><Card title="Tags"><TagChips tags={r.tags.map((t) => ({ ...t, tag: t.tag }))} empty="No tags yet" /></Card></div>
      </div>
      <Card title="Individual feedback" noPadding>
        <DataTable
          rows={r.items}
          emptyTitle="No feedback yet"
          columns={[
            { key: "raterType", title: "From", render: (x) => <span><Badge tone={x.raterType === "DRIVER" ? "info" : "purple"}>{x.raterType === "DRIVER" ? "Driver" : "Restaurant"}</Badge> <span className="text-sm">{x.raterName}</span></span> },
            { key: "rating", title: "Rating", render: (x) => <RatingValue value={x.rating} digits={0} /> },
            { key: "tags", title: "Tags", render: (x) => <TagChips tags={x.tags} empty="—" tone={x.rating <= 2 ? "danger" : "neutral"} /> },
            { key: "note", title: "Note", render: (x) => <div style={{ maxWidth: 340 }}>{x.note || <span className="text-secondary-light">—</span>}</div> },
            { key: "order", title: "Order", render: (x) => <Link to={`/orders/${x.orderId}`}>{x.orderCode}</Link> },
            { key: "createdAt", title: "Date", render: (x) => fmtDateTime(x.createdAt) },
          ]}
        />
      </Card>
    </>
  );
}
