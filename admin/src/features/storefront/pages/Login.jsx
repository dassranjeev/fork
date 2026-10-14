import React, { useEffect, useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import AuthForms from "../components/AuthForms";
import { Notice } from "../components/ui";
import { useSfAuth } from "../lib/SfAuth";
import { SF_KEYS, sfStore } from "../lib/sfApi";

/** Only allow a same-app /order path as a post-login destination (no open redirects). */
export function safeNext(p, fallback = "/order") {
  if (typeof p !== "string" || !/^\/order(\/|\?|$)/.test(p) || p.includes("\\") || [...p].some((ch) => ch.charCodeAt(0) < 32) || p.startsWith("//")) return fallback;
  return p;
}

export default function Login() {
  const { user, loading } = useSfAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const next = safeNext(params.get("next"));
  const [notice] = useState(() => {
    const n = sfStore.get(SF_KEYS.notice);
    if (n) sfStore.del(SF_KEYS.notice);
    return n;
  });
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);
  if (!loading && user) return <Navigate to={next} replace />;
  return (
    <div className="sf-container sf-narrow">
      <h1 className="sf-h1">Welcome to FORKY</h1>
      <p className="sf-muted">Sign in or create an account to place your order and follow it live.</p>
      {notice && <Notice tone="info">{notice}</Notice>}
      {next === "/order/checkout" && <Notice tone="info" icon="shopping-basket-2-line">Your cart is saved. Sign in and we take you straight to checkout.</Notice>}
      <div className="sf-card sf-pad">
        <AuthForms defaultTab={params.get("tab")} onDone={() => navigate(next, { replace: true })} />
      </div>
    </div>
  );
}
