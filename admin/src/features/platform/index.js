import React from "react";

const Cities = React.lazy(() => import("./Cities"));
const Zones = React.lazy(() => import("./Zones"));
const TaxClasses = React.lazy(() => import("./TaxClasses"));
const CommissionTiers = React.lazy(() => import("./CommissionTiers"));
const Cuisines = React.lazy(() => import("./Cuisines"));
const Pricing = React.lazy(() => import("./Pricing"));
const Incidents = React.lazy(() => import("./Incidents"));
const Checklists = React.lazy(() => import("./Checklists"));
const Supply = React.lazy(() => import("./Supply"));

export const routes = [
  { path: "cities", element: <Cities />, perm: ["zones", "view"] },
  { path: "zones", element: <Zones />, perm: ["zones", "view"] },
  { path: "tax-classes", element: <TaxClasses />, perm: ["pricing", "view"] },
  { path: "commission-tiers", element: <CommissionTiers />, perm: ["pricing", "view"] },
  { path: "pricing", element: <Pricing />, perm: ["pricing", "view"] },
  { path: "cuisines", element: <Cuisines />, perm: ["content", "view"] },
  { path: "incidents", element: <Incidents />, perm: ["operations", "view"] },
  { path: "ops-checklists", element: <Checklists />, perm: ["operations", "view"] },
  { path: "supply-demand", element: <Supply />, perm: ["operations", "view"] },
];

export const menu = [
  {
    section: "OPERATIONS",
    order: 60,
    label: "Cities & Zones",
    icon: "solar:map-point-outline",
    perm: ["zones", "view"],
    children: [
      { label: "Cities", to: "/cities", perm: ["zones", "view"] },
      { label: "Zones", to: "/zones", perm: ["zones", "view"] },
    ],
  },
  { section: "OPERATIONS", order: 61, label: "Supply & Demand", icon: "solar:chart-2-outline", to: "/supply-demand", perm: ["operations", "view"] },
  { section: "OPERATIONS", order: 62, label: "Incidents", icon: "solar:danger-triangle-outline", to: "/incidents", perm: ["operations", "view"] },
  { section: "OPERATIONS", order: 63, label: "Ops Checklists", icon: "solar:checklist-minimalistic-outline", to: "/ops-checklists", perm: ["operations", "view"] },
  {
    section: "OPERATIONS",
    order: 64,
    label: "Pricing & Tax",
    icon: "solar:tag-price-outline",
    perm: ["pricing", "view"],
    children: [
      { label: "Pricing & Simulator", to: "/pricing", perm: ["pricing", "view"] },
      { label: "Commission Tiers", to: "/commission-tiers", perm: ["pricing", "view"] },
      { label: "Tax Classes", to: "/tax-classes", perm: ["pricing", "view"] },
    ],
  },
  { section: "OPERATIONS", order: 65, label: "Cuisines", icon: "solar:chef-hat-outline", to: "/cuisines", perm: ["content", "view"] },
];
