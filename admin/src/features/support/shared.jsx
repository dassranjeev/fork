import React from "react";
import { Badge } from "../../ui";
import { timeAgo } from "../../lib/format";

export const TICKET_STATUSES = ["OPEN", "PENDING", "ESCALATED", "RESOLVED", "CLOSED"];
export const TIERS = ["SELF_SERVE", "TIER1", "TIER2", "FINANCE"];
export const PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"];
export const CATEGORIES = ["MISSING_ITEM", "WRONG_ITEM", "NEVER_ARRIVED", "VERY_LATE", "FOOD_QUALITY", "RESTAURANT_CANCELLED", "PAYMENT", "PAYOUT", "ACCOUNT", "SAFETY", "OTHER"];
export const CHARGED_TO = [{ value: "PLATFORM", label: "Platform" }, { value: "RESTAURANT", label: "Restaurant" }, { value: "DRIVER", label: "Driver" }];
export const CASE_STATUSES = ["PROPOSED", "OPEN", "AWAITING_RESPONSE", "DECIDED", "CLOSED", "DISMISSED"];
export const CASE_TRIGGERS = ["LOW_RATING", "FRAUD_FLAG", "SAFETY_COMPLAINT", "EXPIRED_DOCUMENTS", "REPEATED_CANCELLATIONS", "OTHER"];
export const CASE_DECISIONS = ["REINSTATED", "WARNED", "SUSPENDED", "DEACTIVATED"];

export const tierLabel = (t) => ({ SELF_SERVE: "Self-serve", TIER1: "Tier 1", TIER2: "Tier 2", FINANCE: "Finance" }[t] || t);

/** SLA indicator: breached, or time left to the next deadline. */
export function SlaBadge({ ticket }) {
  if (ticket.slaBreached) return <Badge tone="danger">SLA breached</Badge>;
  if (["RESOLVED", "CLOSED"].includes(ticket.status)) return <span className="text-secondary-light">-</span>;
  const due = ticket.firstResponseAt ? ticket.slaResolutionDueAt : ticket.slaFirstResponseDueAt;
  if (!due) return <span className="text-secondary-light">-</span>;
  const late = new Date(due).getTime() < Date.now();
  return (
    <span className={`text-sm text-nowrap ${late ? "text-danger-main" : "text-secondary-light"}`}>
      {ticket.firstResponseAt ? "resolve " : "reply "}
      {timeAgo(due)}
    </span>
  );
}
