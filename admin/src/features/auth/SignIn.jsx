import React, { useState } from "react";
import { safeImgUrl } from "../../lib/safe";
import { Icon } from "@iconify/react/offline";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { toast } from "react-toastify";
import { errorMessage, http } from "../../lib/api";
import { useAuth } from "../../lib/auth";

export function AuthFrame({ title, subtitle, children }) {
  return (
    <section className="auth bg-base d-flex flex-wrap">
      <div className="auth-left d-lg-flex d-none align-items-center justify-content-center" style={{ background: "linear-gradient(135deg,#ff6917,#ff8340 55%,#ffa66f)" }}>
        <div className="text-white p-48" style={{ maxWidth: 520 }}>
          <img src="/brand/logo-horizontal-white.png" alt="FORKSY" className="mb-40" style={{ height: 64 }} />
          <h3 className="text-white mb-16">Run the whole delivery network from one console.</h3>
          <p className="text-white opacity-75 mb-32">Customers, restaurants and drivers, live dispatch, payouts and support, all in one place.</p>
          <ul className="list-unstyled d-grid gap-3 mb-0">
            {["Live operations map & dispatch", "Restaurant onboarding, menus & KDS", "Driver onboarding, incentives & payouts", "Role-based access with a full audit trail"].map((t) => (
              <li key={t} className="d-flex align-items-center gap-3">
                <Icon icon="solar:check-circle-bold" className="text-xl" /> {t}
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="auth-right py-32 px-24 d-flex flex-column justify-content-center">
        <div className="max-w-464-px mx-auto w-100">
          <img src="/brand/logo-horizontal-orange.png" alt="FORKSY" className="mb-32 d-lg-none" style={{ height: 48 }} />
          <h4 className="mb-12">{title}</h4>
          <p className="mb-32 text-secondary-light text-lg">{subtitle}</p>
          {children}
        </div>
      </div>
    </section>
  );
}

export default function SignIn() {
  const { user, acceptSession, isAdmin, isRestaurant } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState("password"); // password | code | setup
  const [tempToken, setTempToken] = useState("");
  const [code, setCode] = useState("");
  const [qr, setQr] = useState(null);

  if (user) {
    const dest = location.state?.from?.pathname;
    return <Navigate to={dest && dest !== "/sign-in" ? dest : isRestaurant ? "/portal" : isAdmin ? "/" : "/sign-in"} replace />;
  }

  const finish = async (res) => {
    const me = await acceptSession(res);
    const t = me.user?.type;
    if (t === "DRIVER" || t === "CUSTOMER") {
      toast.info("This account is for the mobile app. Use the FORKSY app.");
    }
    navigate(t === "RESTAURANT" ? "/portal" : "/", { replace: true });
  };

  const submitPassword = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await http.post("/auth/login", { identifier: identifier.trim(), password });
      if (res.requires2fa) {
        setTempToken(res.tempToken);
        setStep("code");
      } else if (res.requires2faSetup) {
        setTempToken(res.tempToken);
        const s = await http.post("/auth/2fa/setup", {}, { headers: { Authorization: `Bearer ${res.tempToken}` } });
        setQr(s);
        setStep("setup");
      } else {
        await finish(res);
      }
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const res =
        step === "setup"
          ? await http.post("/auth/2fa/enable", { code }, { headers: { Authorization: `Bearer ${tempToken}` } })
          : await http.post("/auth/2fa/verify", { tempToken, code });
      await finish(res);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (step !== "password") {
    return (
      <AuthFrame title={step === "setup" ? "Set up two-factor authentication" : "Two-factor authentication"} subtitle={step === "setup" ? "Two-factor authentication is required for your account." : "Enter the 6-digit code from your authenticator app."}>
        {step === "setup" && qr && (
          <div className="text-center mb-24">
            <img src={safeImgUrl(qr.qrCode)} alt="2FA QR" style={{ width: 200 }} />
            <p className="text-sm text-secondary-light mt-2 mb-1">Scan with Google Authenticator, Authy or 1Password, or enter this key:</p>
            <code className="user-select-all">{qr.secret}</code>
          </div>
        )}
        <form onSubmit={submitCode}>
          <input className="form-control h-56-px bg-neutral-50 radius-12 text-center fs-4 letter-spacing-2" style={{ letterSpacing: 8 }} inputMode="numeric" maxLength={6} placeholder="000000" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} autoFocus />
          <button type="submit" disabled={busy || code.length !== 6} className="btn btn-primary-600 text-sm btn-sm px-12 py-16 w-100 radius-12 mt-32">
            {busy ? "Verifying…" : step === "setup" ? "Enable & sign in" : "Verify & sign in"}
          </button>
          <button type="button" className="btn btn-link w-100 mt-16 text-secondary-light" onClick={() => { setStep("password"); setCode(""); }}>
            Back to sign in
          </button>
        </form>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame title="Sign in to FORKSY" subtitle="Admin console and restaurant portal. Welcome back!">
      <form onSubmit={submitPassword}>
        <div className="icon-field mb-16">
          <span className="icon top-50 translate-middle-y">
            <Icon icon="mage:email" />
          </span>
          <input type="text" className="form-control h-56-px bg-neutral-50 radius-12" placeholder="Email" name="username" autoComplete="username" value={identifier} onChange={(e) => setIdentifier(e.target.value)} autoFocus required />
        </div>
        <div className="position-relative mb-20">
          <div className="icon-field">
            <span className="icon top-50 translate-middle-y">
              <Icon icon="solar:lock-password-outline" />
            </span>
            <input type={show ? "text" : "password"} className="form-control h-56-px bg-neutral-50 radius-12" placeholder="Password" name="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          <span className="cursor-pointer position-absolute end-0 top-50 translate-middle-y me-16 text-secondary-light" onClick={() => setShow(!show)}>
            <Icon icon={show ? "solar:eye-closed-outline" : "solar:eye-outline"} />
          </span>
        </div>
        <div className="d-flex justify-content-end">
          <Link to="/forgot-password" className="text-primary-600 fw-medium">
            Forgot password?
          </Link>
        </div>
        <button type="submit" disabled={busy} className="btn btn-primary-600 text-sm btn-sm px-12 py-16 w-100 radius-12 mt-32">
          {busy ? "Signing in…" : "Sign In"}
        </button>
        <div className="mt-32 text-center text-sm">
          <p className="mb-0">
            Own a restaurant?{" "}
            <Link to="/apply" className="text-primary-600 fw-semibold">
              Apply to join FORKSY
            </Link>
          </p>
        </div>
      </form>
    </AuthFrame>
  );
}
