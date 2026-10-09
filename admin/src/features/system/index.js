import React from "react";
import { WS_URL } from "../../lib/api";

const StaffList = React.lazy(() => import("./StaffList"));
const Roles = React.lazy(() => import("./Roles"));
const AuditLog = React.lazy(() => import("./AuditLog"));
const Settings = React.lazy(() => import("./Settings"));
const NotificationMatrix = React.lazy(() => import("./NotificationMatrix"));
const Inbox = React.lazy(() => import("./Inbox"));
const Integrations = React.lazy(() => import("./Integrations"));
const Notifications = React.lazy(() => import("./Notifications"));
const NotificationSettings = React.lazy(() => import("../notifications/NotificationSettings"));

export const routes = [
  { path: "staff", element: <StaffList />, perm: ["staff", "view"] },
  { path: "roles", element: <Roles />, perm: ["roles", "view"] },
  { path: "audit-log", element: <AuditLog />, perm: ["audit", "view"] },
  { path: "settings", element: <Settings />, perm: ["settings", "view"] },
  { path: "notification-matrix", element: <NotificationMatrix />, perm: ["notifications", "view"] },
  { path: "notifications", element: <Notifications />, perm: ["notifications", "view"] },
  { path: "integrations", element: <Integrations />, perm: ["settings", "view"] },
  { path: "inbox", element: <Inbox /> },
  { path: "notification-settings", element: <NotificationSettings crumbs={[{ label: "System" }, { label: "Notification Settings" }]} /> },
];

export const menu = [
  { section: "ADMIN & SUPER ADMIN", order: 10, label: "Staff Users", icon: "solar:users-group-rounded-outline", to: "/staff", perm: ["staff", "view"] },
  { section: "ADMIN & SUPER ADMIN", order: 11, label: "Roles & Permissions", icon: "solar:shield-keyhole-outline", to: "/roles", perm: ["roles", "view"] },
  { section: "ADMIN & SUPER ADMIN", order: 12, label: "Audit Log", icon: "solar:document-text-outline", to: "/audit-log", perm: ["audit", "view"] },
  { section: "SYSTEM", order: 10, label: "Platform Settings", icon: "solar:settings-outline", to: "/settings", perm: ["settings", "view"] },
  { section: "SYSTEM", order: 10.5, label: "Integrations", icon: "solar:plug-circle-outline", to: "/integrations", perm: ["settings", "view"] },
  { section: "SYSTEM", order: 11, label: "Notification Matrix", icon: "solar:bell-bing-outline", to: "/notification-matrix", perm: ["notifications", "view"] },
  { section: "SYSTEM", order: 11.2, label: "Notifications", icon: "solar:bell-outline", to: "/notifications", perm: ["notifications", "view"] },
  { section: "SYSTEM", order: 12, label: "My Notifications", icon: "solar:inbox-outline", to: "/inbox" },
  { section: "SYSTEM", order: 12.5, label: "Notification Settings", icon: "solar:bell-outline", to: "/notification-settings" },
  { section: "SYSTEM", order: 20, label: "API Docs", icon: "solar:code-square-outline", href: `${WS_URL}/docs` },
];
