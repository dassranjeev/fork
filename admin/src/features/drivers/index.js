import React from "react";

const DriversList = React.lazy(() => import("./DriversList"));
const Pipeline = React.lazy(() => import("./Pipeline"));
const DriverDetail = React.lazy(() => import("./DriverDetail"));
const Incentives = React.lazy(() => import("./Incentives"));
const Shifts = React.lazy(() => import("./Shifts"));
const Training = React.lazy(() => import("./Training"));
const Sos = React.lazy(() => import("./Sos"));
const HeatMap = React.lazy(() => import("./HeatMap"));
const ExpiringDocs = React.lazy(() => import("./ExpiringDocs"));

const P = ["drivers", "view"];

export const routes = [
  { path: "drivers", element: <DriversList />, perm: P },
  { path: "driver-pipeline", element: <Pipeline />, perm: P },
  { path: "driver-incentives", element: <Incentives />, perm: P },
  { path: "driver-ops/shifts", element: <Shifts />, perm: P },
  { path: "driver-training", element: <Training />, perm: P },
  { path: "driver-ops/sos", element: <Sos />, perm: P },
  { path: "driver-ops/heat-map", element: <HeatMap />, perm: P },
  { path: "driver-documents/expiring", element: <ExpiringDocs />, perm: P },
  { path: "drivers/:id", element: <DriverDetail />, perm: P },
];

export const menu = [
  {
    section: "DRIVERS",
    order: 10,
    label: "Drivers",
    icon: "solar:scooter-outline",
    perm: P,
    children: [
      { label: "All drivers", to: "/drivers" },
      { label: "Application pipeline", to: "/driver-pipeline" },
      { label: "Expiring documents", to: "/driver-documents/expiring" },
    ],
  },
  {
    section: "DRIVERS",
    order: 20,
    label: "Fleet operations",
    icon: "solar:map-point-wave-outline",
    perm: P,
    children: [
      { label: "Demand heat map", to: "/driver-ops/heat-map" },
      { label: "SOS alerts", to: "/driver-ops/sos" },
      { label: "Shifts", to: "/driver-ops/shifts" },
    ],
  },
  {
    section: "DRIVERS",
    order: 30,
    label: "Incentives & boosts",
    icon: "solar:bolt-circle-outline",
    to: "/driver-incentives",
    perm: P,
  },
  {
    section: "DRIVERS",
    order: 40,
    label: "Training",
    icon: "solar:square-academic-cap-outline",
    to: "/driver-training",
    perm: P,
  },
];
