import React, { useState } from "react";
import { Notice, Ri, Spinner } from "./ui";
import { errorMessage } from "../lib/sfApi";
import { useSfAuth } from "../lib/SfAuth";

function Field({ label, id, hint, children }) {
  return (
    <div className="sf-field">
      <label className="sf-label" htmlFor={id}>
        {label}
      </label>
      {children}
      {hint && <div className="sf-small sf-muted">{hint}</div>}
    </div>
  );
}

function SignInForm({ onDone }) {
  const { login, requestOtp, verifyOtp } = useSfAuth();
  const [mode, setMode] = useState("password"); // password | phone | code
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [otp, setOtp] = useState(null); // { isNewUser, devCode }
  const [names, setNames] = useState({ firstName: "", lastName: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const run = async (fn) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e?.response ? errorMessage(e) : e?.message || "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  if (mode === "password") {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            await login(identifier, password);
            onDone();
          });
        }}
      >
        <Field label="Email or phone" id="sf-identifier">
          <input id="sf-identifier" className="sf-input" autoComplete="username" value={identifier} onChange={(e) => setIdentifier(e.target.value)} required maxLength={254} data-testid="login-identifier" />
        </Field>
        <Field label="Password" id="sf-password">
          <div className="sf-pw">
            <input id="sf-password" className="sf-input" type={show ? "text" : "password"} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required maxLength={128} data-testid="login-password" />
            <button type="button" className="sf-iconbtn" onClick={() => setShow((v) => !v)} aria-label={show ? "Hide password" : "Show password"}>
              <Ri name={show ? "eye-off-line" : "eye-line"} />
            </button>
          </div>
        </Field>
        {error && <Notice tone="danger">{error}</Notice>}
        <button type="submit" className="sf-btn sf-btn-primary sf-btn-block mt-2" disabled={busy} data-testid="login-submit">
          {busy ? <Spinner size={16} /> : null} Sign in
        </button>
        <button type="button" className="sf-btn sf-btn-link sf-btn-block" onClick={() => { setMode("phone"); setError(""); }}>
          Use a phone code instead
        </button>
      </form>
    );
  }

  if (mode === "phone") {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            const r = await requestOtp(phone);
            setOtp({ isNewUser: !!r.isNewUser, devCode: r.devCode });
            setMode("code");
          });
        }}
      >
        <Field label="Mobile phone number" id="sf-phone" hint="We text you a 6-digit code. New number? We create your account.">
          <input id="sf-phone" className="sf-input" type="tel" autoComplete="tel" placeholder="+1 905 555 0123" value={phone} onChange={(e) => setPhone(e.target.value)} required maxLength={30} data-testid="otp-phone" />
        </Field>
        {error && <Notice tone="danger">{error}</Notice>}
        <button type="submit" className="sf-btn sf-btn-primary sf-btn-block mt-2" disabled={busy || !phone.trim()} data-testid="otp-request">
          {busy ? <Spinner size={16} /> : null} Send code
        </button>
        <button type="button" className="sf-btn sf-btn-link sf-btn-block" onClick={() => { setMode("password"); setError(""); }}>
          Use my password
        </button>
      </form>
    );
  }

  // mode === "code"
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        run(async () => {
          await verifyOtp(phone, code, otp?.isNewUser ? { firstName: names.firstName.trim(), lastName: names.lastName.trim() } : {});
          onDone();
        });
      }}
    >
      <p className="sf-small">We sent a code to <b>{phone}</b>.</p>
      {otp?.devCode && (
        <Notice tone="warn" icon="code-s-slash-line">
          Development only: the API returned the one-time code <code data-testid="dev-otp">{otp.devCode}</code>. It is never shown in production.
        </Notice>
      )}
      <Field label="6-digit code" id="sf-code">
        <input id="sf-code" className="sf-input sf-code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 8))} required data-testid="otp-code" />
      </Field>
      {otp?.isNewUser && (
        <div className="sf-two">
          <Field label="First name" id="sf-on-first">
            <input id="sf-on-first" className="sf-input" value={names.firstName} onChange={(e) => setNames({ ...names, firstName: e.target.value })} required maxLength={80} />
          </Field>
          <Field label="Last name" id="sf-on-last">
            <input id="sf-on-last" className="sf-input" value={names.lastName} onChange={(e) => setNames({ ...names, lastName: e.target.value })} required maxLength={80} />
          </Field>
        </div>
      )}
      {error && <Notice tone="danger">{error}</Notice>}
      <button type="submit" className="sf-btn sf-btn-primary sf-btn-block mt-2" disabled={busy || code.length < 4} data-testid="otp-verify">
        {busy ? <Spinner size={16} /> : null} Verify and continue
      </button>
      <button type="button" className="sf-btn sf-btn-link sf-btn-block" onClick={() => { setMode("phone"); setCode(""); setError(""); }}>
        Use a different number
      </button>
    </form>
  );
}

function RegisterForm({ onDone }) {
  const { register } = useSfAuth();
  const [f, setF] = useState({ firstName: "", lastName: "", email: "", phone: "", password: "", marketing: false });
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });
  const weak = f.password.length > 0 && f.password.length < 8;
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (!f.email.trim() && !f.phone.trim()) return setError("Enter an email address or a phone number.");
        setBusy(true);
        setError("");
        try {
          await register(f);
          onDone();
        } catch (err) {
          setError(err?.response ? errorMessage(err) : err?.message || "Something went wrong");
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="sf-two">
        <Field label="First name" id="sf-first">
          <input id="sf-first" className="sf-input" autoComplete="given-name" value={f.firstName} onChange={set("firstName")} required maxLength={80} data-testid="reg-first" />
        </Field>
        <Field label="Last name" id="sf-last">
          <input id="sf-last" className="sf-input" autoComplete="family-name" value={f.lastName} onChange={set("lastName")} required maxLength={80} data-testid="reg-last" />
        </Field>
      </div>
      <Field label="Email" id="sf-email">
        <input id="sf-email" className="sf-input" type="email" autoComplete="email" value={f.email} onChange={set("email")} maxLength={254} data-testid="reg-email" />
      </Field>
      <Field label="Mobile phone (optional)" id="sf-rphone" hint="Used for delivery updates and phone-code sign in.">
        <input id="sf-rphone" className="sf-input" type="tel" autoComplete="tel" value={f.phone} onChange={set("phone")} maxLength={30} data-testid="reg-phone" />
      </Field>
      <Field label="Password" id="sf-rpassword" hint="At least 8 characters.">
        <div className="sf-pw">
          <input id="sf-rpassword" className={`sf-input ${weak ? "has-error" : ""}`} type={show ? "text" : "password"} autoComplete="new-password" value={f.password} onChange={set("password")} required minLength={8} maxLength={128} data-testid="reg-password" />
          <button type="button" className="sf-iconbtn" onClick={() => setShow((v) => !v)} aria-label={show ? "Hide password" : "Show password"}>
            <Ri name={show ? "eye-off-line" : "eye-line"} />
          </button>
        </div>
      </Field>
      <label className="sf-check">
        <input type="checkbox" checked={f.marketing} onChange={set("marketing")} /> Send me offers by email (optional)
      </label>
      {error && <Notice tone="danger">{error}</Notice>}
      <button type="submit" className="sf-btn sf-btn-primary sf-btn-block mt-2" disabled={busy || weak} data-testid="reg-submit">
        {busy ? <Spinner size={16} /> : null} Create account
      </button>
      <p className="sf-small sf-muted mt-2 mb-0">By creating an account you agree to place orders with the restaurants you choose. This is a development site.</p>
    </form>
  );
}

/** Sign in / Create account tabs. onDone() runs after a session was accepted. */
export default function AuthForms({ onDone, defaultTab = "login" }) {
  const [tab, setTab] = useState(defaultTab === "register" ? "register" : "login");
  return (
    <div className="sf-authbox">
      <div className="sf-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "login"} className={tab === "login" ? "on" : ""} onClick={() => setTab("login")} data-testid="tab-login">
          Sign in
        </button>
        <button type="button" role="tab" aria-selected={tab === "register"} className={tab === "register" ? "on" : ""} onClick={() => setTab("register")} data-testid="tab-register">
          Create account
        </button>
      </div>
      <div role="tabpanel">{tab === "login" ? <SignInForm onDone={onDone} /> : <RegisterForm onDone={onDone} />}</div>
    </div>
  );
}
