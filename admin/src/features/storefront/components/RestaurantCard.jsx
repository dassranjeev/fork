import React from "react";
import { Link } from "react-router-dom";
import { fmtOpens } from "../lib/fmt";
import { money } from "../lib/sfApi";
import { Pic, Ri, priceLevel } from "./ui";

/** One short, honest availability label for a restaurant card / header. */
export function availability(r) {
  if (r.serviceMode === "CLOSED") return { tone: "danger", text: "Closed", detail: "Not taking orders right now" };
  if (r.isOpen === false) {
    const opens = r.nextOpening || r.status?.opensAt;
    return { tone: "danger", text: opens ? `Closed - opens ${fmtOpens(opens)}` : "Closed now", detail: "You can browse the menu" };
  }
  if (r.serviceMode === "PICKUP_ONLY" || (r.pickupAvailable && !r.deliveryAvailable)) return { tone: "warn", text: "Pickup only", detail: r.serviceMode === "PICKUP_ONLY" ? "This store is not delivering right now" : "Delivery not available to your area" };
  return { tone: "ok", text: r.deliveryAvailable ? "Pickup & delivery" : "Open", detail: "" };
}

export function Rating({ r }) {
  if (r.rating == null) return <span className="sf-tag sf-tag-new">{r.ratingLabel || "New"}</span>;
  return (
    <span className="sf-rating" title={`${r.ratingCount} ratings`}>
      <Ri name="star-fill" /> {Number(r.rating).toFixed(1)} <span className="sf-muted">({r.ratingCount})</span>
    </span>
  );
}

export default function RestaurantCard({ r }) {
  const av = availability(r);
  const closed = r.serviceMode === "CLOSED" || r.isOpen === false;
  return (
    <Link to={`/order/r/${encodeURIComponent(r.slug)}`} className={`sf-card sf-rcard ${closed ? "is-closed" : ""}`} data-testid="restaurant-card" data-slug={r.slug}>
      <div className="sf-rcard-cover">
        <Pic src={r.coverUrl} name={r.name} className="sf-rcard-img" />
        <span className={`sf-tag sf-tag-${av.tone} sf-rcard-status`}>{av.text}</span>
        {r.promo?.label && <span className="sf-tag sf-tag-promo sf-rcard-promo">{r.promo.label}</span>}
      </div>
      <div className="sf-rcard-body">
        <div className="sf-rcard-title">
          <Pic src={r.logoUrl} name={r.name} className="sf-rcard-logo" rounded />
          <div className="sf-rcard-name">
            <h3>{r.name}</h3>
            <div className="sf-small sf-muted">
              {(r.cuisines || []).slice(0, 3).join(" - ")}
              {r.priceLevel ? ` - ${priceLevel(r.priceLevel)}` : ""}
            </div>
          </div>
        </div>
        <div className="sf-rcard-meta">
          <Rating r={r} />
          {r.etaRange ? (
            <span>
              <Ri name="time-line" /> {r.etaRange.min}-{r.etaRange.max} min
            </span>
          ) : null}
          {r.deliveryFee != null && r.deliveryAvailable ? (
            <span>
              <Ri name="e-bike-2-line" /> {r.deliveryFee === 0 ? "Free delivery" : money(r.deliveryFee)}
            </span>
          ) : null}
          {r.distanceKm != null && <span>{r.distanceKm} km</span>}
        </div>
        {r.matchedDishes?.length > 0 && (
          <div className="sf-small sf-muted sf-rcard-dishes">
            <Ri name="restaurant-2-line" /> {r.matchedDishes.map((d) => d.name).join(", ")}
          </div>
        )}
      </div>
    </Link>
  );
}
