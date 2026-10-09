import React from "react";
import NotificationsPage from "../notifications/NotificationsPage";

/** "My Notifications" (Admin Console /inbox): the shared notification center page. */
export default function Inbox() {
  return <NotificationsPage title="My Notifications" subtitle="Alerts sent to your admin account" crumbs={[{ label: "System" }, { label: "Notifications" }]} />;
}
