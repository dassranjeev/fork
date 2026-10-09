import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { teardownActivePush } from "../../../lib/notify";
import { SF_KEYS, SF_LOGOUT_EVENT, sfHttp, sfStore, sfTokens } from "./sfApi";
import { closeSfRealtime } from "./sfRealtime";

/**
 * Customer session for the storefront. Only CUSTOMER accounts are accepted: every sign-in call sends app: "customer"
 * (the API refuses admin / restaurant / driver accounts for it) and the profile type is checked again here.
 */
const SfAuthContext = createContext(null);
export const useSfAuth = () => useContext(SfAuthContext);

const num = (v, d) => (v === undefined || v === "" || Number.isNaN(Number(v)) ? d : Number(v));
/** idle auto-logout in minutes (0 disables) */
export const IDLE_MINUTES = num(process.env.REACT_APP_IDLE_MINUTES_STOREFRONT, 30);
const EVENTS = ["mousedown", "keydown", "touchstart", "scroll", "pointermove"];

export function SfAuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(!!sfTokens.access);
  const [loginCount, setLoginCount] = useState(0); // bumps on every successful sign-in (cart sync listens to it)

  const loadMe = useCallback(async () => {
    try {
      const me = await sfHttp.get("/auth/me");
      if (me?.type !== "CUSTOMER") throw new Error("not a customer account");
      setUser(me);
      return me;
    } catch {
      sfTokens.clear();
      setUser(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (sfTokens.access) loadMe();
    else setLoading(false);
    const onLogout = () => {
      closeSfRealtime();
      setUser(null);
    };
    window.addEventListener(SF_LOGOUT_EVENT, onLogout);
    return () => window.removeEventListener(SF_LOGOUT_EVENT, onLogout);
  }, [loadMe]);

  /** Accepts the response of /auth/login | /auth/customer/register | /auth/otp/verify */
  const acceptSession = useCallback(async (res) => {
    if (res?.user && res.user.type !== "CUSTOMER") {
      throw new Error("This account is not a customer account. Please use the FORKSY Admin or Restaurant Portal to sign in.");
    }
    sfTokens.set(res);
    setUser(res.user || null);
    if (!res.user) await loadMe();
    setLoginCount((n) => n + 1);
    return res;
  }, [loadMe]);

  const login = useCallback(
    async (identifier, password) => {
      const res = await sfHttp.post("/auth/login", { identifier: identifier.trim(), password, app: "customer" }, { noAuth: true });
      if (res.requires2fa || res.requires2faSetup) throw new Error("Two-factor sign-in is not supported on the website yet.");
      return acceptSession(res);
    },
    [acceptSession]
  );

  const register = useCallback(
    async (data) => {
      const body = {
        firstName: data.firstName.trim(),
        lastName: data.lastName.trim(),
        email: data.email?.trim() || undefined,
        phone: data.phone?.trim() || undefined,
        password: data.password,
        marketingEmailConsent: !!data.marketing,
      };
      return acceptSession(await sfHttp.post("/auth/customer/register", body, { noAuth: true }));
    },
    [acceptSession]
  );

  const requestOtp = useCallback((phone) => sfHttp.post("/auth/otp/request", { phone: phone.trim(), app: "customer" }, { noAuth: true }), []);
  const verifyOtp = useCallback(
    async (phone, code, extra = {}) => acceptSession(await sfHttp.post("/auth/otp/verify", { phone: phone.trim(), code: code.trim(), app: "customer", ...extra }, { noAuth: true })),
    [acceptSession]
  );

  const logout = useCallback(async (reason) => {
    const refreshToken = sfTokens.refresh;
    // this browser stops receiving the customer's push notifications FIRST (it needs the session), never blocking the sign-out for long
    await Promise.race([teardownActivePush(), new Promise((r) => setTimeout(r, 4000))]);
    closeSfRealtime();
    try {
      if (refreshToken) await sfHttp.post("/auth/logout", { refreshToken }, { noAuth: true });
    } catch {
      /* ignore */
    }
    sfTokens.clear();
    closeSfRealtime();
    sfStore.del(SF_KEYS.lastActive);
    sfStore.del(SF_KEYS.botSession);
    sfStore.del(SF_KEYS.botLog);
    sfStore.del(SF_KEYS.botScope);
    if (reason) sfStore.set(SF_KEYS.notice, reason);
    setUser(null);
  }, []);

  // idle auto-logout (no warning dialog: a customer's cart survives, see SfCart)
  const logoutRef = useRef(logout);
  logoutRef.current = logout;
  useEffect(() => {
    if (!user || !IDLE_MINUTES) return undefined;
    const idleMs = IDLE_MINUTES * 60 * 1000;
    let last = Date.now();
    const touch = () => {
      last = Date.now();
    };
    EVENTS.forEach((e) => window.addEventListener(e, touch, { passive: true, capture: true }));
    const tick = setInterval(() => {
      if (Date.now() - last >= idleMs) {
        clearInterval(tick);
        logoutRef.current("You were signed out because you were inactive for a while.");
      }
    }, 5000);
    return () => {
      clearInterval(tick);
      EVENTS.forEach((e) => window.removeEventListener(e, touch, { capture: true }));
    };
  }, [user]);

  const value = useMemo(
    () => ({ user, loading, loginCount, isLoggedIn: !!user, login, register, requestOtp, verifyOtp, logout, reload: loadMe }),
    [user, loading, loginCount, login, register, requestOtp, verifyOtp, logout, loadMe]
  );
  return <SfAuthContext.Provider value={value}>{children}</SfAuthContext.Provider>;
}
