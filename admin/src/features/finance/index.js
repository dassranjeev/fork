import React from "react";

const Dashboard = React.lazy(() => import("./Dashboard"));
const Batches = React.lazy(() => import("./Batches"));
const BatchDetail = React.lazy(() => import("./BatchDetail"));
const Payouts = React.lazy(() => import("./Payouts"));
const PayoutDetail = React.lazy(() => import("./PayoutDetail"));
const Statement = React.lazy(() => import("./Statement"));
const Ledger = React.lazy(() => import("./Ledger"));
const Invoices = React.lazy(() => import("./Invoices"));
const Hst = React.lazy(() => import("./Hst"));
const Refunds = React.lazy(() => import("./Refunds"));
const Parties = React.lazy(() => import("./Parties"));

const P = ["finance", "view"];

export const routes = [
  { path: "finance", element: <Dashboard />, perm: P },
  { path: "finance/overview", element: <Dashboard />, perm: P },
  { path: "finance/batches", element: <Batches />, perm: P },
  { path: "finance/batches/:id", element: <BatchDetail />, perm: P },
  { path: "finance/payouts", element: <Payouts />, perm: P },
  { path: "finance/payouts/:id", element: <PayoutDetail />, perm: P },
  { path: "finance/statements", element: <Payouts mode="statements" />, perm: P },
  { path: "finance/statements/:payoutId", element: <Statement />, perm: P },
  { path: "finance/ledger", element: <Ledger />, perm: P },
  { path: "finance/adjustments", element: <Ledger adjustments />, perm: P },
  { path: "finance/invoices", element: <Invoices />, perm: P },
  { path: "finance/hst", element: <Hst />, perm: P },
  { path: "finance/refunds", element: <Refunds />, perm: P },
  { path: "finance/parties", element: <Parties />, perm: P },
];

export const menu = [
  { section: "FINANCE", order: 10, label: "Finance overview", icon: "solar:wallet-money-outline", to: "/finance/overview", perm: P },
  {
    section: "FINANCE",
    order: 20,
    label: "Payouts",
    icon: "solar:card-send-outline",
    perm: P,
    children: [
      { label: "Payout batches", to: "/finance/batches" },
      { label: "All payouts", to: "/finance/payouts" },
      { label: "Statements", to: "/finance/statements" },
      { label: "Bank and holds", to: "/finance/parties" },
    ],
  },
  {
    section: "FINANCE",
    order: 30,
    label: "Ledger",
    icon: "solar:book-2-outline",
    perm: P,
    children: [
      { label: "Ledger explorer", to: "/finance/ledger" },
      { label: "Manual adjustments", to: "/finance/adjustments" },
    ],
  },
  { section: "FINANCE", order: 40, label: "Invoices", icon: "solar:bill-list-outline", to: "/finance/invoices", perm: P },
  { section: "FINANCE", order: 50, label: "HST reports", icon: "solar:chart-2-outline", to: "/finance/hst", perm: P },
  { section: "FINANCE", order: 60, label: "Refund approvals", icon: "solar:undo-left-round-outline", to: "/finance/refunds", perm: P },
];
