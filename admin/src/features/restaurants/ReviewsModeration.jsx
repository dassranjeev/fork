import React from "react";
import { usePagedList } from "../../lib/hooks";
import { Card, PageHeader } from "../../ui";
import ReviewsTable from "./ReviewsTable";

/** Cross-restaurant review moderation queue. */
export default function ReviewsModeration() {
  const list = usePagedList("/admin/restaurants/reviews", { filters: { status: "", maxRating: "" } });
  return (
    <>
      <PageHeader title="Review moderation" subtitle="Hide or flag customer reviews; the restaurant rating recomputes automatically" crumbs={[{ label: "Restaurants", to: "/restaurants" }, { label: "Reviews" }]} />
      <Card>
        <ReviewsTable list={list} showRestaurant />
      </Card>
    </>
  );
}
