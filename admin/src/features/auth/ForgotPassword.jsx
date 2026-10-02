import React, { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "react-toastify";
import { errorMessage, http } from "../../lib/api";
import { AuthFrame } from "./SignIn";

export default function ForgotPassword() {
  const [identifier, setIdentifier] = useState("");
  const [step, setStep] = useState("request");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [devCode, setDevCode] = useState(null);
  const navigate = useNavigate();

  const request = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await http.post("/auth/forgot-password", { identifier: identifier.trim() });
      setDevCode(r.devCode || null);
      setStep("reset");
      toast.success("If the account exists, a code was sent.");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const reset = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await http.post("/auth/reset-password", { identifier: identifier.trim(), code, newPassword: password });
      toast.success("Password updated. Please sign in.");
      navigate("/sign-in");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame title="Forgot password?" subtitle={step === "request" ? "Enter your email and we will send you a verification code." : "Enter the code and choose a new password."}>
      {step === "request" ? (
        <form onSubmit={request}>
          <input className="form-control h-56-px bg-neutral-50 radius-12" placeholder="Email" value={identifier} onChange={(e) => setIdentifier(e.target.value)} required autoFocus />
          <button type="submit" disabled={busy} className="btn btn-primary-600 text-sm btn-sm px-12 py-16 w-100 radius-12 mt-32">
            Send code
          </button>
        </form>
      ) : (
        <form onSubmit={reset}>
          {devCode && <div className="alert alert-warning py-8 text-sm">Dev mode code: <b>{devCode}</b></div>}
          <input className="form-control h-56-px bg-neutral-50 radius-12 mb-16" placeholder="6-digit code" autoComplete="one-time-code" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} required />
          <input type="password" className="form-control h-56-px bg-neutral-50 radius-12" placeholder="New password (min 8, letters + numbers)" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
          <button type="submit" disabled={busy} className="btn btn-primary-600 text-sm btn-sm px-12 py-16 w-100 radius-12 mt-32">
            Reset password
          </button>
        </form>
      )}
      <div className="text-center mt-24">
        <Link to="/sign-in" className="text-primary-600 fw-semibold">
          Back to sign in
        </Link>
      </div>
    </AuthFrame>
  );
}
