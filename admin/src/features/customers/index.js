import React from "react";

const CustomerList = React.lazy(() => import("./CustomerList"));
const CustomerDetail = React.lazy(() => import("./CustomerDetail"));
const PrivacyRequests = React.lazy(() => import("./PrivacyRequests"));

export const routes = [
  { path: "customers", element: <CustomerList />, perm: ["customers", "view"] },
  { path: "customers/privacy", element: <PrivacyRequests />, perm: ["customers", "view"] },
  { path: "customers/:id", element: <CustomerDetail />, perm: ["customers", "view"] },
];

export const menu = [
  {
    section: "CUSTOMERS",
    order: 10,
    label: "Customers",
    icon: "solar:users-group-rounded-outline",
    perm: ["customers", "view"],
    children: [
      { label: "All Customers", to: "/customers" },
      { label: "Privacy Requests", to: "/customers/privacy" },
    ],
  },
];
