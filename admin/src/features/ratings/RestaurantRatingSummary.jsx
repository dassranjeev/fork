import React from "react";
import { Card, ErrorState, Loading, StatCard } from "../../ui";
import { Distribution, TagChips, TrendBars } from "./shared";

/** Rating summary for one restaurant. `state` is a useFetch result for a summary endpoint (portal or admin). */
export default function RestaurantRatingSummary({ state, staff }) {
  const { data: s, loading, error, reload } = state;
  if (loading && !s) return <Loading minHeight={120} />;
  if (error && !s) return <ErrorState error={error} onRetry={reload} />;
  if (!s) return null;
  const shown = s.rating !== null && s.rating !== undefined;
  return (
    <div className="mb-24">
      <div className="row g-3 mb-16">
        <div className="col-6 col-md-3"><StatCard label="Rating" value={shown ? Number(s.rating).toFixed(1) : "New"} icon="solar:star-outline" tone="warning" hint={shown ? `${s.ratingCount} reviews` : `Shown after ${s.minCountToShow} reviews (${s.ratingCount} so far)`} /></div>
        <div className="col-6 col-md-3"><StatCard label="Last 30 days" value={s.last30.average == null ? "—" : Number(s.last30.average).toFixed(2)} icon="solar:calendar-outline" tone={s.alert ? "danger" : "info"} hint={`${s.last30.count} reviews${s.alert ? " · below target" : ""}`} /></div>
        <div className="col-6 col-md-3"><StatCard label="Replied" value={`${s.repliedCount}/${s.totalReviews}`} icon="solar:chat-round-dots-outline" tone="success" /></div>
        <div className="col-6 col-md-3"><StatCard label={staff ? "Flagged / hidden" : "Under staff review"} value={staff ? `${s.flaggedCount} / ${s.hiddenCount}` : s.flaggedCount} icon="solar:flag-outline" tone={s.flaggedCount ? "warning" : "success"} /></div>
      </div>
      <div className="row g-3">
        <div className="col-lg-4"><Card title="Star distribution"><Distribution distribution={s.distribution} /></Card></div>
        <div className="col-lg-4"><Card title="Weekly trend" subtitle="Average rating per week"><TrendBars trend={s.trend} /></Card></div>
        <div className="col-lg-4">
          <Card title="Customers mention" subtitle={`Last ${s.rolling.days} days`}>
            <div className="mb-12"><TagChips tags={s.positiveTags} tone="success" empty="No positive tags yet" /></div>
            <TagChips tags={s.negativeTags} tone="danger" empty="No negative tags" />
          </Card>
        </div>
      </div>
    </div>
  );
}
