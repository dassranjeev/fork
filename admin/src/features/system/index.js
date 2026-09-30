import React from "react";

const StaffList = React.lazy(() => import("./StaffList"));
const Roles = React.lazy(() => import("./Roles"));
const AuditLog = React.lazy(() => import("./AuditLog"));
const Settings = React.lazy(() => import("./Settings"));
const NotificationMatrix = React.lazy(() => import("./NotificationMatrix"));
const Inbox = React.lazy(() => import("./Inbox"));

export const routes = [
  { path: "staff", element: <StaffList />, perm: ["staff", "view"] },
  { path: "roles", element: <Roles />, perm: ["roles", "view"] },
  { path: "audit-log", element: <AuditLog />, perm: ["audit", "view"] },
  { path: "settings", element: <Settings />, perm: ["settings", "view"] },
  { path: "notification-matrix", element: <NotificationMatrix />, perm: ["notifications", "view"] },
  { path: "inbox", element: <Inbox /> },
];

export const menu = [
  { section: "ADMIN & SUPER ADMIN", order: 10, label: "Staff Users", icon: "solar:users-group-rounded-outline", to: "/staff", perm: ["staff", "view"] },
  { section: "ADMIN & SUPER ADMIN", order: 11, label: "Roles & Permissions", icon: "solar:shield-keyhole-outline", to: "/roles", perm: ["roles", "view"] },
  { section: "ADMIN & SUPER ADMIN", order: 12, label: "Audit Log", icon: "solar:document-text-outline", to: "/audit-log", perm: ["audit", "view"] },
  { section: "SYSTEM", order: 10, label: "Platform Settings", icon: "solar:settings-outline", to: "/settings", perm: ["settings", "view"] },
  { section: "SYSTEM", order: 11, label: "Notification Matrix", icon: "solar:bell-bing-outline", to: "/notification-matrix", perm: ["notifications", "view"] },
  { section: "SYSTEM", order: 12, label: "My Notifications", icon: "solar:inbox-outline", to: "/inbox" },
];
