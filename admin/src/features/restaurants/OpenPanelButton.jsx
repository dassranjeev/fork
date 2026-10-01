import React from "react";
import { useAuth, useOpenPanel } from "../../lib/auth";

/** "Open restaurant panel": view the restaurant portal as its owner (audited, short-lived). Needs restaurants:edit. */
export default function OpenPanelButton({ restaurant, small = true, label = "Open restaurant panel" }) {
  const { can } = useAuth();
  const { openPanel, busy } = useOpenPanel();
  if (!can("restaurants", "edit")) return null;
  return (
    <button
      type="button"
      className={`btn btn-outline-primary-600 radius-8 ${small ? "btn-sm px-12 py-6" : "px-16 py-8"}`}
      disabled={!!busy}
      onClick={(e) => {
        e.stopPropagation();
        openPanel(restaurant);
      }}
    >
      {busy === restaurant.id ? "Opening…" : label}
    </button>
  );
}
