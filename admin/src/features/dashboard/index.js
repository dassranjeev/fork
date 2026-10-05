import React from "react";

const DashboardPage = React.lazy(() => import("./DashboardPage"));
const LiveMapPage = React.lazy(() => import("./LiveMapPage"));
const ExecutivePage = React.lazy(() => import("./analytics/ExecutivePage"));
const RestaurantPerfPage = React.lazy(() => import("./analytics/RestaurantPerfPage"));
const DriverPerfPage = React.lazy(() => import("./analytics/DriverPerfPage"));
const CustomerGrowthPage = React.lazy(() => import("./analytics/CustomerGrowthPage"));
const FinanceAnalyticsPage = React.lazy(() => import("./analytics/FinanceAnalyticsPage"));
const SupportAnalyticsPage = React.lazy(() => import("./analytics/SupportAnalyticsPage"));
const RatingsPage = React.lazy(() => import("./analytics/RatingsPage"));
const PilotKpisPage = React.lazy(() => import("./analytics/PilotKpisPage"));

export const routes = [
  { index: true, path: "", element: <DashboardPage />, perm: ["dashboard", "view"] },
  { path: "live-map", element: <LiveMapPage />, perm: ["live_map", "view"] },
  { path: "analytics/executive", element: <ExecutivePage />, perm: ["reports", "view"] },
  { path: "analytics/restaurants", element: <RestaurantPerfPage />, perm: ["reports", "view"] },
  { path: "analytics/drivers", element: <DriverPerfPage />, perm: ["reports", "view"] },
  { path: "analytics/customers", element: <CustomerGrowthPage />, perm: ["reports", "view"] },
  { path: "analytics/finance", element: <FinanceAnalyticsPage />, perm: ["reports", "view"] },
  { path: "analytics/support", element: <SupportAnalyticsPage />, perm: ["reports", "view"] },
  { path: "analytics/ratings", element: <RatingsPage />, perm: ["reports", "view"] },
  { path: "analytics/pilot-kpis", element: <PilotKpisPage />, perm: ["reports", "view"] },
];

export const menu = [
  { section: "MAIN", order: 1, label: "Dashboard", icon: "solar:home-smile-angle-outline", to: "/", perm: ["dashboard", "view"] },
  { section: "OPERATIONS", order: 1, label: "Live Map", icon: "solar:map-point-wave-outline", to: "/live-map", perm: ["live_map", "view"] },
  {
    section: "OPERATIONS",
    order: 50,
    label: "Analytics",
    icon: "solar:chart-2-outline",
    perm: ["reports", "view"],
    children: [
      { label: "Executive", to: "/analytics/executive" },
      { label: "Restaurants", to: "/analytics/restaurants" },
      { label: "Drivers", to: "/analytics/drivers" },
      { label: "Ratings", to: "/analytics/ratings" },
      { label: "Customer growth", to: "/analytics/customers" },
      { label: "Finance", to: "/analytics/finance" },
      { label: "Support", to: "/analytics/support" },
      { label: "Pilot exit KPIs", to: "/analytics/pilot-kpis" },
    ],
  },
];
