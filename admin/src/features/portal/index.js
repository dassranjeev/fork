import React from "react";
import { Navigate } from "react-router-dom";
import { PortalProvider } from "./context";

const Dashboard = React.lazy(() => import("./Dashboard"));
const Orders = React.lazy(() => import("./Orders"));
const Kds = React.lazy(() => import("./Kds"));
const Menu = React.lazy(() => import("./Menu"));
const Store = React.lazy(() => import("./Store"));
const Staff = React.lazy(() => import("./Staff"));
const Reviews = React.lazy(() => import("./Reviews"));
const Finance = React.lazy(() => import("./Finance"));
const Reports = React.lazy(() => import("./Reports"));
const Promotions = React.lazy(() => import("./Promotions"));
const Assistant = React.lazy(() => import("./Assistant"));
const Notifications = React.lazy(() => import("../notifications/NotificationsPage"));
const NotificationSettings = React.lazy(() => import("../notifications/NotificationSettings"));

const MANAGERS = ["OWNER", "LOCATION_MANAGER"];
const OWNER = ["OWNER"];

/** Holds the selected restaurant location for all portal pages. */
export const Provider = PortalProvider;

export const routes = [
  { index: true, element: <Dashboard /> },
  // where a new restaurant lands after applying: the dashboard shows its verification status, next step and document checklist
  { path: "onboarding", element: <Navigate to="/portal" replace /> },
  { path: "orders", element: <Orders /> },
  { path: "kds", element: <Kds /> },
  { path: "menu", element: <Menu /> },
  { path: "store", element: <Store />, roles: MANAGERS },
  { path: "staff", element: <Staff />, roles: MANAGERS },
  { path: "reviews", element: <Reviews />, roles: MANAGERS },
  { path: "finance", element: <Finance />, roles: OWNER },
  { path: "reports", element: <Reports />, roles: MANAGERS },
  { path: "promotions", element: <Promotions />, roles: MANAGERS },
  { path: "assistant", element: <Assistant />, roles: MANAGERS },
  { path: "notifications", element: <Notifications title="Notifications" subtitle="Alerts for your restaurant" /> },
  { path: "notification-settings", element: <NotificationSettings /> },
];

export const menu = [
  { section: "STORE", order: 10, label: "Dashboard", icon: "solar:home-smile-angle-outline", to: "/portal" },
  { section: "STORE", order: 20, label: "Live Orders", retailLabel: "Orders & picking", icon: "solar:bag-check-outline", to: "/portal/orders" },
  { section: "STORE", order: 30, label: "Kitchen Display", hideForRetail: true, icon: "solar:chef-hat-outline", to: "/portal/kds" },
  { section: "STORE", order: 40, label: "Store Settings", icon: "solar:shop-2-outline", to: "/portal/store", roles: MANAGERS },
  { section: "MENU", order: 10, label: "Menu", retailLabel: "Catalog", icon: "solar:clipboard-list-outline", to: "/portal/menu" },
  { section: "MONEY", order: 10, label: "Finance", icon: "solar:wallet-money-outline", to: "/portal/finance", roles: OWNER },
  { section: "MONEY", order: 20, label: "Reports", icon: "solar:chart-2-outline", to: "/portal/reports", roles: MANAGERS },
  { section: "GROWTH", order: 10, label: "Promotions", icon: "solar:tag-price-outline", to: "/portal/promotions", roles: MANAGERS },
  { section: "GROWTH", order: 15, label: "Assistant", icon: "solar:chat-round-dots-outline", to: "/portal/assistant", roles: MANAGERS },
  { section: "GROWTH", order: 20, label: "Reviews", icon: "solar:star-outline", to: "/portal/reviews", roles: MANAGERS },
  { section: "ACCOUNT", order: 10, label: "Staff", icon: "solar:users-group-rounded-outline", to: "/portal/staff", roles: MANAGERS },
  { section: "ACCOUNT", order: 15, label: "Notifications", icon: "solar:inbox-outline", to: "/portal/notifications" },
  { section: "ACCOUNT", order: 16, label: "Notification Settings", icon: "solar:bell-outline", to: "/portal/notification-settings" },
  { section: "ACCOUNT", order: 20, label: "My Account", icon: "solar:user-circle-outline", to: "/portal/account" },
];
