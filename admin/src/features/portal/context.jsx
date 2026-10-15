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
          out[id] = {
            name: d.restaurant?.name,
            status: d.restaurant?.status,
            serviceMode: d.restaurant?.serviceMode,
            serviceModeResumeAt: d.restaurant?.serviceModeResumeAt,
            // what kind of store (docs/store-types.md): grocery-type stores say "Catalog" and "picking" where restaurants say "Menu" and "kitchen"
            storeType: d.restaurant?.storeType,
            storeTypeLabel: d.restaurant?.storeTypeLabel,
            retail: !!d.restaurant?.retail,
            itemLabel: d.restaurant?.itemLabel,
            itemLabelPlural: d.restaurant?.itemLabelPlural,
            categoryLabel: d.restaurant?.categoryLabel,
          };
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
    () => ids.map((id) => ({ id, name: names[id]?.name || "Location", status: names[id]?.status, serviceMode: names[id]?.serviceMode, serviceModeResumeAt: names[id]?.serviceModeResumeAt, storeType: names[id]?.storeType, storeTypeLabel: names[id]?.storeTypeLabel, retail: !!names[id]?.retail, itemLabel: names[id]?.itemLabel || "item", itemLabelPlural: names[id]?.itemLabelPlural || "items", categoryLabel: names[id]?.categoryLabel || "Category" })),
    [ids, names]
  );

  const value = useMemo(
    () => ({
      restaurantId,
      setRestaurantId: setStored,
      locations,
      location: locations.find((l) => l.id === restaurantId),
      /** true when the selected location is a grocery / convenience / specialty store (catalog, picking list) */
      retail: !!locations.find((l) => l.id === restaurantId)?.retail,
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
  useContext(PortalCtx) || { restaurantId: null, locations: [], retail: false, params: {}, isOwner: false, isManager: false, setRestaurantId() {}, reloadLocations() {} };
