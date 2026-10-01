import React from "react";

const LiveChat = React.lazy(() => import("./LiveChat"));
const Queue = React.lazy(() => import("./Queue"));
const TicketDetail = React.lazy(() => import("./TicketDetail"));
const RefundApprovals = React.lazy(() => import("./RefundApprovals"));
const CannedReplies = React.lazy(() => import("./CannedReplies"));
const ReviewCases = React.lazy(() => import("./ReviewCases"));
const CaseDetail = React.lazy(() => import("./CaseDetail"));
const Kpis = React.lazy(() => import("./Kpis"));

export const routes = [
  { path: "support/chat", element: <LiveChat />, perm: ["support", "view"] },
  { path: "support/tickets", element: <Queue />, perm: ["support", "view"] },
  { path: "support/tickets/:id", element: <TicketDetail />, perm: ["support", "view"] },
  { path: "support/refunds", element: <RefundApprovals />, perm: ["support", "approve"] },
  { path: "support/canned-replies", element: <CannedReplies />, perm: ["support", "view"] },
  { path: "support/cases", element: <ReviewCases />, perm: ["support", "view"] },
  { path: "support/cases/:id", element: <CaseDetail />, perm: ["support", "view"] },
  { path: "support/kpis", element: <Kpis />, perm: ["support", "view"] },
];

export const menu = [
  {
    section: "SUPPORT",
    order: 10,
    label: "Support",
    icon: "solar:headphones-round-sound-outline",
    perm: ["support", "view"],
    children: [
      { label: "Live chat", to: "/support/chat", perm: ["support", "view"] },
      { label: "Ticket queue", to: "/support/tickets", perm: ["support", "view"] },
      { label: "Refund approvals", to: "/support/refunds", perm: ["support", "approve"] },
      { label: "Review cases (SOP-08)", to: "/support/cases", perm: ["support", "view"] },
      { label: "Canned replies", to: "/support/canned-replies", perm: ["support", "view"] },
      { label: "Support KPIs", to: "/support/kpis", perm: ["support", "view"] },
    ],
  },
];
