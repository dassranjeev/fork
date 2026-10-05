import React from "react";
import { Link } from "react-router-dom";
import { useFetch, usePagedList } from "../../lib/hooks";
import { useAuth } from "../../lib/auth";
import { Badge, Card, DataTable, PageHeader, StatCard } from "../../ui";
import { ModerationButtons, RatingValue, ReviewMeta, REVIEW_TONE, TagChips } from "../ratings/shared";
import ReviewsTable from "./ReviewsTable";

/** Cross-restaurant review moderation: flagged queue first (fraud rules + restaurant reports), restaurant and driver sides. */
export default function ReviewsModeration() {
  const { can } = useAuth();
  const list = usePagedList("/admin/restaurants/reviews", { filters: { status: "FLAGGED", maxRating: "" } });
  const drv = useFetch("/admin/ratings/driver-reviews", { status: "FLAGGED" });
  const stats = useFetch("/admin/analytics/ratings", { limit: 1 });
  const m = stats.data?.moderation;
  return (
    <>
      <PageHeader title="Review moderation" subtitle="Flagged reviews are excluded from public ratings until you restore them. Every action needs a reason and is audit-logged." crumbs={[{ label: "Restaurants", to: "/restaurants" }, { label: "Reviews" }]} />
      <div className="row g-3 mb-24">
        <div className="col-6 col-md-4"><StatCard label="Flagged reviews" value={m ? m.flagged : "—"} icon="solar:flag-outline" tone="warning" loading={stats.loading && !m} /></div>
        <div className="col-6 col-md-4"><StatCard label="Hidden reviews" value={m ? m.hidden : "—"} icon="solar:eye-closed-outline" tone="info" loading={stats.loading && !m} /></div>
        <div className="col-6 col-md-4"><StatCard label="Reported by restaurants" value={m ? m.reportedPending : "—"} icon="solar:chat-round-line-outline" tone="danger" loading={stats.loading && !m} /></div>
      </div>
      <Card title="Restaurant reviews" className="mb-24">
        <ReviewsTable list={list} showRestaurant />
      </Card>
      <Card title="Driver ratings held back" subtitle="Flagged driver-side ratings (needs drivers:approve to act)" noPadding>
        <DataTable
          rows={Array.isArray(drv.data) ? drv.data : []}
          loading={drv.loading && !drv.data}
          error={drv.error}
          onRetry={drv.reload}
          emptyTitle="No flagged driver ratings"
          columns={[
            { key: "rating", title: "Rating", render: (r) => <RatingValue value={r.rating} digits={0} /> },
            { key: "comment", title: "Comment", render: (r) => <div style={{ maxWidth: 420 }}><div>{r.comment || <span className="text-secondary-light">No comment</span>}</div><TagChips tags={r.tags} empty="" /><ReviewMeta review={r} /></div> },
            { key: "driverName", title: "Driver", render: (r) => <Link to={`/drivers/${r.driverId}`}>{r.driverName}</Link> },
            { key: "status", title: "Status", render: (r) => <Badge tone={REVIEW_TONE[r.status] || "neutral"}>{r.status}</Badge> },
            { key: "actions", title: "", render: (r) => <ModerationButtons review={r} side="DRIVER" allowed={can("drivers", "approve")} onDone={drv.reload} /> },
          ]}
        />
      </Card>
    </>
  );
}
