import React from "react";
import { Link } from "react-router-dom";
import { Badge, BarChart, Card, DataTable, ErrorState, LineChart, Loading, PageHeader, StatCard } from "../../../ui";
import { useFetch } from "../../../lib/hooks";
import { num } from "../../../lib/format";
import { RangeBar, useRangeState } from "../shared";
import { Distribution, RatingValue } from "../../ratings/shared";

const alertBadge = (a) => (a === "REVIEW" ? <Badge tone="danger">Review</Badge> : a === "WARN" ? <Badge tone="warning">Coaching</Badge> : null);

function Board({ title, rows, link, subtitle }) {
  return (
    <Card title={title} subtitle={subtitle} noPadding>
      <DataTable
        rows={rows || []}
        emptyTitle="Not enough ratings yet"
        columns={[
          { key: "name", title: "Name", render: (r) => <Link to={`${link}/${r.id}`} className="text-primary-600 fw-medium">{r.name}</Link> },
          { key: "rating", title: "Rating", align: "right", render: (r) => <RatingValue value={r.rating} /> },
          { key: "ratingCount", title: "Ratings", align: "right", render: (r) => num(r.ratingCount) },
          { key: "rating30d", title: "Last 30d", align: "right", render: (r) => (r.rating30d == null ? "—" : `${Number(r.rating30d).toFixed(2)} (${r.ratingCount30d})`) },
          { key: "alert", title: "", render: (r) => alertBadge(r.ratingAlert) },
        ]}
      />
    </Card>
  );
}

/** Admin > Analytics > Ratings: leaderboards, distribution, trend and moderation counts for restaurants and drivers. */
export default function RatingsPage() {
  const [f, set] = useRangeState();
  const { data: d, loading, error, reload } = useFetch("/admin/analytics/ratings", f);
  return (
    <>
      <PageHeader title="Ratings" subtitle="How customers rate restaurants and drivers. Rankings use the smoothed rolling rating and need a minimum number of ratings." crumbs={[{ label: "Analytics" }, { label: "Ratings" }]} />
      <RangeBar state={f} onChange={set} groupBy={false} />
      {error && !d && <ErrorState error={error} onRetry={reload} />}
      {loading && !d && <Loading />}
      {d && (
        <>
          <div className="row gy-4 mb-24">
            <div className="col-xl col-md-4 col-6"><StatCard label="Restaurant avg (period)" value={d.restaurant.average == null ? "—" : d.restaurant.average.toFixed(2)} hint={`${d.restaurant.count} ratings`} icon="solar:shop-2-outline" tone="warning" /></div>
            <div className="col-xl col-md-4 col-6"><StatCard label="Driver avg (period)" value={d.driver.average == null ? "—" : d.driver.average.toFixed(2)} hint={`${d.driver.count} ratings`} icon="solar:scooter-outline" tone="info" /></div>
            <div className="col-xl col-md-4 col-6"><StatCard label="Flagged reviews" value={num(d.moderation.flagged)} hint={`${d.moderation.reportedPending} reported by restaurants`} icon="solar:flag-outline" tone="danger" to="/restaurants/reviews" /></div>
            <div className="col-xl col-md-6 col-6"><StatCard label="In rating alert" value={num(d.alerts.driversInAlert + d.alerts.restaurantsInAlert)} hint={`${d.alerts.driversInAlert} drivers, ${d.alerts.restaurantsInAlert} restaurants`} icon="solar:danger-triangle-outline" tone="warning" /></div>
            <div className="col-xl col-md-6 col-6"><StatCard label="Customers flagged" value={num(d.customers.safetyFlags)} hint={`${d.customers.rated} rated by partners`} icon="solar:shield-warning-outline" tone="purple" /></div>
          </div>
          <div className="row gy-4 mb-24">
            <div className="col-lg-6"><Card title="Restaurant ratings - distribution"><Distribution distribution={d.restaurant.distribution} /></Card></div>
            <div className="col-lg-6"><Card title="Driver ratings - distribution"><Distribution distribution={d.driver.distribution} /></Card></div>
          </div>
          <Card title="Average rating trend" className="mb-24">
            {d.trend.length === 0 ? <div className="text-secondary-light">No ratings in this period</div> : (
              <LineChart height={280} area={false} categories={d.trend.map((t) => t.date)} series={[{ name: "Restaurants", data: d.trend.map((t) => t.restaurantAvg) }, { name: "Drivers", data: d.trend.map((t) => t.driverAvg) }]} yFormatter={(v) => (v == null ? "" : Number(v).toFixed(1))} />
            )}
          </Card>
          {d.trend.length > 0 && (
            <Card title="Ratings per day" className="mb-24">
              <BarChart height={220} categories={d.trend.map((t) => t.date)} series={[{ name: "Restaurant ratings", data: d.trend.map((t) => t.restaurantCount) }, { name: "Driver ratings", data: d.trend.map((t) => t.driverCount) }]} />
            </Card>
          )}
          <div className="row gy-4">
            <div className="col-12"><Board title="Lowest rated restaurants" subtitle={`At least ${d.minCountToShow} ratings`} rows={d.restaurants.lowest} link="/restaurants" /></div>
            <div className="col-12"><Board title="Highest rated restaurants" rows={d.restaurants.highest} link="/restaurants" /></div>
            <div className="col-12"><Board title="Lowest rated drivers" rows={d.drivers.lowest} link="/drivers" /></div>
            <div className="col-12"><Board title="Highest rated drivers" rows={d.drivers.highest} link="/drivers" /></div>
          </div>
        </>
      )}
    </>
  );
}
