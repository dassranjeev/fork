import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { toast } from "react-toastify";
import { act, clearAppStorage, http, impersonation, tokens } from "./api";
import { disconnectSocket } from "./socket";
import { IdleGuard } from "./idle";

const AuthContext = createContext(null);

export const ADMIN_TYPES = ["SUPER_ADMIN", "STAFF"];

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(!!tokens.access);

  const loadMe = useCallback(async () => {
    try {
      const me = await http.get("/auth/me");
      setUser(me);
      return me;
    } catch {
      if (impersonation.active) {
        const back = impersonation.info?.returnTo || "/";
        impersonation.stop();
        window.location.assign(back);
        return null;
      }
      tokens.clear();
      setUser(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tokens.access) loadMe();
    const onLogout = () => {
      disconnectSocket();
      setUser(null);
    };
    // another tab logged out / its tokens were removed: drop this tab's session too
    const onStorage = (e) => {
      if (e.key === "forksy.access" && !e.newValue && !impersonation.active) onLogout();
    };
    // back/forward cache: never show a restored authenticated page after logout
    const onPageShow = (e) => {
      if (e.persisted && !tokens.access) window.location.reload();
    };
    window.addEventListener("forksy:logout", onLogout);
    window.addEventListener("storage", onStorage);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      window.removeEventListener("forksy:logout", onLogout);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [loadMe]);

  /** Accepts the response of /auth/login | /auth/2fa/verify | /auth/2fa/enable */
  const acceptSession = useCallback(async (res) => {
    tokens.set(res);
    if (res.user) setUser(res.user);
    else await loadMe();
    return res;
  }, [loadMe]);

  /** Leave "view as restaurant": drop the impersonation token; the admin session is untouched. */
  const exitImpersonation = useCallback(() => {
    const back = impersonation.info?.returnTo || "/";
    impersonation.stop();
    window.location.assign(back);
  }, []);

  const logout = useCallback(async () => {
    if (impersonation.active) return exitImpersonation();
    try {
      await http.post("/auth/logout", { refreshToken: tokens.refresh });
    } catch {
      /* ignore */
    }
    tokens.clear();
    clearAppStorage();
    disconnectSocket();
    setUser(null);
  }, [exitImpersonation]);

  const value = useMemo(() => {
    const isSuper = user?.type === "SUPER_ADMIN";
    return {
      user,
      loading,
      isAdmin: !!user && ADMIN_TYPES.includes(user.type),
      isRestaurant: user?.type === "RESTAURANT",
      isSuper,
      /** staff permission check: can("orders", "view"). Super admin can do anything. */
      can: (module, action = "view") => {
        if (!user) return false;
        if (isSuper) return true;
        if (user.type !== "STAFF") return false;
        return !!user.permissions?.[module]?.includes(action);
      },
      /** refund limit for the current staff member: null = unlimited */
      refundLimit: isSuper ? null : user?.refundLimit ?? 0,
      restaurantRole: user?.restaurantRole,
      impersonating: !!user?.impersonatedBy && impersonation.active,
      impersonationInfo: impersonation.active ? impersonation.info : null,
      exitImpersonation,
      acceptSession,
      reload: loadMe,
      logout,
    };
  }, [user, loading, acceptSession, loadMe, logout, exitImpersonation]);

  return (
    <AuthContext.Provider value={value}>
      {children}
      {user && <IdleGuard type={user.type === "RESTAURANT" ? "restaurant" : "admin"} suspended={/^\/portal\/kds/.test(window.location.pathname)} onTimeout={() => { logout().then(() => window.location.replace("/sign-in?reason=idle")); }} />}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);

/** Guard for a route tree. `type`: 'admin' | 'restaurant' */
export function RequireAuth({ type, children }) {
  const { user, loading, isAdmin, isRestaurant } = useAuth();
  const location = useLocation();
  if (loading) return <div className="p-5 text-center text-secondary-light">Loading…</div>;
  if (!user) return <Navigate to="/sign-in" state={{ from: location }} replace />;
  if (type === "admin" && !isAdmin) return <Navigate to={isRestaurant ? "/portal" : "/sign-in"} replace />;
  if (type === "restaurant" && !isRestaurant) return <Navigate to={isAdmin ? "/" : "/sign-in"} replace />;
  return children;
}

/** Hide children unless the staff user has the permission. */
export function Can({ module, action = "view", children, fallback = null }) {
  const { can } = useAuth();
  return can(module, action) ? children : fallback;
}

/**
 * Admin action: open the restaurant portal for any restaurant (server-side impersonation, audited).
 * Returns `openPanel(restaurant)`; `restaurant` = { id, name? }.
 */
export function useOpenPanel() {
  const [busy, setBusy] = useState(null);
  const { user } = useAuth();
  const openPanel = useCallback(
    async (restaurant) => {
      if (!restaurant?.id || busy) return;
      setBusy(restaurant.id);
      const res = await act(() => http.post(`/admin/restaurants/${restaurant.id}/impersonate`, {}));
      if (!res) return setBusy(null);
      try {
        localStorage.setItem("forksy.ui.portal.restaurantId", JSON.stringify(res.restaurantId));
      } catch {
        /* ignore */
      }
      impersonation.start({
        accessToken: res.accessToken,
        expiresAt: Date.now() + (res.expiresIn || 7200) * 1000,
        restaurantId: res.restaurantId,
        restaurantName: res.restaurantName,
        adminName: res.impersonatedBy?.name || res.impersonatedBy?.email || [user?.firstName, user?.lastName].filter(Boolean).join(" "),
        returnTo: `/restaurants/${res.restaurantId}`,
      });
      toast.info(`Opening ${res.restaurantName} panel...`, { autoClose: 1200 });
      window.location.assign("/portal");
    },
    [busy, user]
  );
  return { openPanel, busy };
}
