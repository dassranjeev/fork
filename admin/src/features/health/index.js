import React from "react";

const SystemHealth = React.lazy(() => import("./SystemHealth"));

// superOnly: Super Admin accounts only (staff never see the menu item and the route answers "not allowed"); the API enforces it too.
export const routes = [{ path: "system-health", element: <SystemHealth />, superOnly: true }];

export const menu = [{ section: "SYSTEM", order: 9, label: "System Health", icon: "solar:server-square-outline", to: "/system-health", superOnly: true }];
