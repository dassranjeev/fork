import React from "react";
import { Badge, Card, EmptyState, ErrorState, Loading, StatCard } from "../../ui";
import { useFetch } from "../../lib/hooks";
import { useAuth } from "../../lib/auth";
import { Distribution, ModerationButtons, RatingValue, REVIEW_TONE, ReviewMeta, TagChips, TrendBars } from "./shared";

/** Admin driver Performance tab: smoothed + 90-day rating, distribution, top tags, recent comments with hide/flag/restore. */
export default function DriverRatingCard({ driverId }) {
  const { can } = useAuth();
  const { data: r, loading, error, reload } = useFetch(`/admin/ratings/drivers/${driverId}`);
  if (loading && !r) return <Loading />;
  if (error && !r) return <ErrorState error={error} onRetry={reload} />;
  if (!r) return null;
  const canModerate = can("drivers", "approve");
  return (
    <div className="mb-24">
      <div className="row g-3 mb-16">
        <div className="col-6 col-md-3"><StatCard label="Rating (rolling 90 days, smoothed)" value={r.rating == null ? "New" : Number(r.rating).toFixed(2)} icon="solar:star-outline" tone="warning" hint={`${r.ratingCount} ratings in total`} /></div>
        <div className="col-6 col-md-3"><StatCard label="All-time (smoothed)" value={r.smoothedAllTime == null ? "—" : Number(r.smoothedAllTime).toFixed(2)} icon="solar:medal-ribbon-star-outline" tone="info" hint={r.rawAverage != null ? `raw average ${Number(r.rawAverage).toFixed(2)}` : undefined} /></div>
        <div className="col-6 col-md-3"><StatCard label="Last 30 days (raw)" value={r.last30.average == null ? "—" : Number(r.last30.average).toFixed(2)} icon="solar:calendar-outline" tone={r.alert ? "danger" : "success"} hint={`${r.last30.count} ratings`} /></div>
        <div className="col-6 col-md-3"><StatCard label="Alert state" value={r.alert === "REVIEW" ? "Review candidate" : r.alert === "WARN" ? "Coaching sent" : "OK"} icon="solar:shield-warning-outline" tone={r.alert ? "danger" : "success"} /></div>
      </div>
      <div className="row g-3">
        <div className="col-lg-4">
          <Card title="Star distribution" subtitle="Visible ratings only (hidden and flagged are excluded)">
            <Distribution distribution={r.distribution} />
            <div className="mt-16"><div className="text-secondary-light text-sm mb-6">Weekly average</div><TrendBars trend={r.trend} /></div>
          </Card>
        </div>
        <div className="col-lg-8">
          <Card title="What customers say" subtitle={`Top tags, last ${r.rolling.days} days`}>
            <div className="mb-12"><div className="text-sm fw-semibold mb-6">Positive</div><TagChips tags={r.positiveTags} tone="success" /></div>
            <div><div className="text-sm fw-semibold mb-6">Negative</div><TagChips tags={r.negativeTags} tone="danger" empty="No negative tags" /></div>
          </Card>
        </div>
      </div>
      <Card title="Recent driver ratings" className="mt-16" noPadding={false}>
        {r.recent.length === 0 && <EmptyState title="No ratings yet" />}
        {r.recent.map((x) => (
          <div key={x.id} className="py-12 border-bottom d-flex flex-wrap justify-content-between gap-3">
            <div style={{ maxWidth: 560 }}>
              <div className="d-flex align-items-center gap-2 flex-wrap">
                <RatingValue value={x.rating} digits={0} />
                <span className="text-sm">{x.customerName}</span>
                <Badge tone={REVIEW_TONE[x.status] || "neutral"}>{x.status}</Badge>
                <TagChips tags={x.tags} empty="" />
              </div>
              <div className="mt-1">{x.comment || <span className="text-secondary-light">No comment</span>}</div>
              <ReviewMeta review={x} />
            </div>
            <ModerationButtons review={x} side="DRIVER" allowed={canModerate} onDone={reload} />
          </div>
        ))}
      </Card>
    </div>
  );
}
