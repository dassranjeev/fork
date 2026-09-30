import React from "react";
import { Icon } from "@iconify/react";
import { Link } from "react-router-dom";
import { http } from "../../lib/api";
import { useSubmit } from "../../lib/hooks";
import { useAuth } from "../../lib/auth";
import { fmtDate } from "../../lib/format";
import { Badge, DataTable, FilterSelect, ListToolbar, Button, useConfirm } from "../../ui";

const Stars = ({ n }) => (
  <span className="text-warning-main d-inline-flex align-items-center gap-1 text-nowrap">
    <Icon icon="solar:star-bold" /> {n ?? "—"}
  </span>
);

const TONE = { VISIBLE: "success", HIDDEN: "neutral", FLAGGED: "warning" };

/** Review list (+ moderation). `list` is a usePagedList over the admin reviews endpoint. */
export default function ReviewsTable({ list, showRestaurant, simple }) {
  const { can } = useAuth();
  const confirm = useConfirm();
  const { run } = useSubmit();

  const moderate = async (r, status) => {
    const res = await confirm({ title: `${status === "VISIBLE" ? "Restore" : status === "HIDDEN" ? "Hide" : "Flag"} this review?`, prompt: { label: "Reason (optional)", type: "text" } });
    if (!res.confirmed) return;
    run(() => http.post(`/admin/restaurants/reviews/${r.id}/moderate`, { status, reason: res.value || undefined }), { success: "Review updated", onDone: list.reload });
  };

  const columns = [
    { key: "rating", title: "Rating", render: (r) => <Stars n={r.restaurantRating ?? r.rating} /> },
    {
      key: "comment",
      title: "Review",
      render: (r) => (
        <div style={{ maxWidth: 420 }}>
          <div>{r.comment || r.restaurantComment || <span className="text-secondary-light">No comment</span>}</div>
          {r.reply && <div className="text-secondary-light text-xs mt-1">Reply: {r.reply}</div>}
        </div>
      ),
    },
    ...(showRestaurant
      ? [{ key: "restaurant", title: "Restaurant", render: (r) => (r.restaurantId ? <Link to={`/restaurants/${r.restaurantId}`}>{r.restaurantName || r.restaurant?.name || "Open"}</Link> : "—") }]
      : []),
    { key: "status", title: "Status", render: (r) => <Badge tone={TONE[r.status] || "neutral"}>{r.status || "VISIBLE"}</Badge> },
    { key: "createdAt", title: "Date", render: (r) => fmtDate(r.createdAt) },
    {
      key: "actions",
      title: "",
      render: (r) =>
        can("restaurants", "approve") && (
          <div className="d-flex gap-2">
            {r.status !== "HIDDEN" && <Button variant="light" onClick={() => moderate(r, "HIDDEN")}>Hide</Button>}
            {r.status !== "FLAGGED" && <Button variant="light" onClick={() => moderate(r, "FLAGGED")}>Flag</Button>}
            {r.status && r.status !== "VISIBLE" && <Button variant="outline" onClick={() => moderate(r, "VISIBLE")}>Restore</Button>}
          </div>
        ),
    },
  ];

  return (
    <>
      <ListToolbar
        list={list}
        placeholder="Search reviews…"
        filters={
          simple ? null : (
            <>
              <FilterSelect value={list.filters.status} onChange={(v) => list.setFilter("status", v)} options={["VISIBLE", "HIDDEN", "FLAGGED"]} placeholder="Any status" />
              <FilterSelect value={list.filters.maxRating} onChange={(v) => list.setFilter("maxRating", v)} options={[{ value: "2", label: "2 stars or less" }, { value: "3", label: "3 stars or less" }]} placeholder="Any rating" />
            </>
          )
        }
      />
      <DataTable columns={columns} {...list.tableProps} error={list.error} onRetry={list.reload} emptyTitle="No reviews" />
    </>
  );
}
