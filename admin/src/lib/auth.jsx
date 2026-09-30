import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { http, tokens } from "./api";

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
      tokens.clear();
      setUser(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tokens.access) loadMe();
    const onLogout = () => setUser(null);
    window.addEventListener("forksy:logout", onLogout);
    return () => window.removeEventListener("forksy:logout", onLogout);
  }, [loadMe]);

  /** Accepts the response of /auth/login | /auth/2fa/verify | /auth/2fa/enable */
  const acceptSession = useCallback(async (res) => {
    tokens.set(res);
    if (res.user) setUser(res.user);
    else await loadMe();
    return res;
  }, [loadMe]);

  const logout = useCallback(async () => {
    try {
      await http.post("/auth/logout", { refreshToken: tokens.refresh });
    } catch {
      /* ignore */
    }
    tokens.clear();
    setUser(null);
  }, []);

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
      acceptSession,
      reload: loadMe,
      logout,
    };
  }, [user, loading, acceptSession, loadMe, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
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
