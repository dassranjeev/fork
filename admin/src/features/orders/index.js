import React from "react";

const OrdersList = React.lazy(() => import("./OrdersList"));
const OrderDetail = React.lazy(() => import("./OrderDetail"));

export const routes = [
  { path: "orders", element: <OrdersList />, perm: ["orders", "view"] },
  { path: "orders/:id", element: <OrderDetail />, perm: ["orders", "view"] },
];

export const menu = [
  { section: "OPERATIONS", order: 20, label: "Orders", icon: "solar:bag-check-outline", to: "/orders", perm: ["orders", "view"] },
];
