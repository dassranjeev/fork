import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../../lib/auth";
import { http } from "../../lib/api";
import { useLocalState } from "../../lib/hooks";
import { useSocketEvent } from "../../lib/socket";

const PortalCtx = createContext(null);

/**
 * Holds the selected restaurant location for the whole portal. Every /restaurant/* call
 * takes ?restaurantId= (required when the account has several locations).
 */
export function PortalProvider({ children }) {
  const { user, restaurantRole } = useAuth();
  const ids = useMemo(() => user?.restaurantIds || [], [user]);
  const [stored, setStored] = useLocalState("portal.restaurantId", null);
  const [names, setNames] = useState({});

  const restaurantId = ids.includes(stored) ? stored : ids[0] || null;

  const loadNames = useCallback(async () => {
    const out = {};
    await Promise.all(
      ids.map(async (id) => {
        try {
          const d = await http.get("/restaurant/dashboard", { restaurantId: id });
          out[id] = { name: d.restaurant?.name, status: d.restaurant?.status, serviceMode: d.restaurant?.serviceMode, serviceModeResumeAt: d.restaurant?.serviceModeResumeAt };
        } catch {
          out[id] = {};
        }
      })
    );
    setNames(out);
  }, [ids]);

  useEffect(() => {
    if (ids.length) loadNames();
  }, [ids, loadNames]);

  // live: the server pushes store.updated whenever the service mode / accepting flag changes
  const reloadTimer = useRef();
  useSocketEvent("store.updated", () => {
    clearTimeout(reloadTimer.current);
    reloadTimer.current = setTimeout(() => ids.length && loadNames(), 300);
  });
  useEffect(() => () => clearTimeout(reloadTimer.current), []);

  /** Optimistic update of the selected location after PATCH /restaurant/store/service-mode. */
  const setLocationMode = useCallback(
    (res) => {
      if (!res?.serviceMode) return;
      setNames((n) => ({ ...n, [restaurantId]: { ...(n[restaurantId] || {}), serviceMode: res.serviceMode, serviceModeResumeAt: res.serviceModeResumeAt } }));
    },
    [restaurantId]
  );

  const locations = useMemo(
    () => ids.map((id) => ({ id, name: names[id]?.name || "Location", status: names[id]?.status, serviceMode: names[id]?.serviceMode, serviceModeResumeAt: names[id]?.serviceModeResumeAt })),
    [ids, names]
  );

  const value = useMemo(
    () => ({
      restaurantId,
      setRestaurantId: setStored,
      locations,
      location: locations.find((l) => l.id === restaurantId),
      role: restaurantRole,
      isOwner: restaurantRole === "OWNER",
      isManager: restaurantRole === "OWNER" || restaurantRole === "LOCATION_MANAGER",
      params: restaurantId ? { restaurantId } : {},
      reloadLocations: loadNames,
      setLocationMode,
    }),
    [restaurantId, setStored, locations, restaurantRole, loadNames, setLocationMode]
  );

  return <PortalCtx.Provider value={value}>{children}</PortalCtx.Provider>;
}

export const usePortal = () =>
  useContext(PortalCtx) || { restaurantId: null, locations: [], params: {}, isOwner: false, isManager: false, setRestaurantId() {}, reloadLocations() {} };
