import React from "react";
import VerificationBanner from "../verification/VerificationBanner";
import { useRealtimeReload, usePortalFetch } from "./shared";

/**
 * The "your business is not verified yet" banner for portal pages that do not load the store view themselves (the dashboard).
 * The verification state is on the store view (GET /restaurant/store). It is an extra hint: when it cannot be loaded the page simply shows no banner.
 */
export default function VerificationNotice() {
  const state = usePortalFetch("/restaurant/store");
  useRealtimeReload(() => state.reload(), ["store.updated"]);
  const v = state.data?.verification;
  // a business waiting for staff review has documents to upload
  const action = v?.status === "PENDING" && v?.method !== "AUTOMATIC" ? { label: "Upload documents", to: "/portal/store?tab=documents" } : undefined;
  return <VerificationBanner verification={v} className="mb-24" action={action} />;
}
