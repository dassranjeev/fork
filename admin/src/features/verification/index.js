import React from "react";

const Verification = React.lazy(() => import("./Verification"));

// superOnly: Super Admin accounts only (staff never see the menu item and the route answers "not allowed"); the API enforces it too.
export const routes = [{ path: "verification", element: <Verification />, superOnly: true }];

export const menu = [{ section: "SYSTEM", order: 9.5, label: "Verification", icon: "solar:shield-check-outline", to: "/verification", superOnly: true }];
