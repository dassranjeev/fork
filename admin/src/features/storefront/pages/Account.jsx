import React, { useCallback, useEffect, useRef, useState } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import { usePushState } from "../../../lib/notify";
import { ErrorBox, Loading, Notice, Ri, Spinner, useSfConfirm } from "../components/ui";
import { CATEGORY_KEYS, categoryIcon, timeAgo } from "../lib/notifyFmt";
import { errorMessage, sfHttp } from "../lib/sfApi";
import { useSfAuth } from "../lib/SfAuth";

/** customer-facing wording (the API's category text is written for every audience) */
const CAT = {
  orders: { title: "Orders", text: "Order placed, accepted, being prepared, ready, cancelled or running late." },
  delivery: { title: "Delivery and drivers", text: "Your driver is assigned, has arrived, and how your order was handed over." },
  payments: { title: "Payments and refunds", text: "Refunds, FORKSY credit and payment problems." },
  support: { title: "Support", text: "Replies from FORKSY Support to your chats and tickets." },
  promotions: { title: "Offers and news", text: "Deals and news from FORKSY. Marketing messages only with your consent." },
  system: { title: "Account and safety", text: "Security and account messages." },
};
const ZONES = ["America/Toronto", "America/Halifax", "America/St_Johns", "America/Winnipeg", "America/Regina", "America/Edmonton", "America/Vancouver"];

function Toggle({ label, hint, checked, disabled, onChange, testId }) {
  return (
    <label className={`sf-switch sf-tgl ${disabled ? "is-disabled" : ""}`}>
      <input type="checkbox" role="switch" checked={!!checked} disabled={disabled} onChange={(e) => onChange?.(e.target.checked)} data-testid={testId} />
      <span className="sf-switch-ui" />
      <span className="sf-tgl-text">
        {label}
        {hint ? <small className="sf-muted d-block">{hint}</small> : null}
      </span>
    </label>
  );
}

/** One clear sentence per state of the browser push on this device. */
function pushStatus(state) {
  if (!state) return { kind: "loading" };
  if (!state.support?.ok) return { kind: "unsupported", reason: state.support?.reason, text: state.support?.message };
  if (!state.config?.enabled || state.platformEnabled === false) return { kind: "platform-off" };
  if (state.permission === "denied") return { kind: "denied" };
  if (state.otherAccount) return { kind: "other" };
  if (state.on) return { kind: "on" };
  return { kind: "off" };
}

function PushDevice({ prefs, onMaster, onChanged }) {
  const { state, busy, error, enable, disable, push, reload } = usePushState();
  const [test, setTest] = useState({ busy: false, msg: "", tone: "info" });
  const st = pushStatus(state);

  const sendTest = async () => {
    setTest({ busy: true, msg: "", tone: "info" });
    try {
      const r = await push.sendTest();
      const p = (r?.results || []).find((x) => x.channel === "PUSH");
      if (r?.ok) setTest({ busy: false, tone: "success", msg: "Test sent. If this page is in front you will see it here; otherwise it arrives as a system notification." });
      else setTest({ busy: false, tone: "warn", msg: p ? `Not delivered: ${p.error || p.status}.` : "Not delivered. Turn push on for this device first." });
    } catch (e) {
      setTest({ busy: false, tone: "danger", msg: errorMessage(e) });
    }
  };

  return (
    <div className="sf-card sf-pad" data-testid="push-device">
      <h3 className="sf-h3">
        <Ri name="smartphone-line" /> This device
      </h3>
      {st.kind === "loading" && <Spinner />}
      {st.kind === "unsupported" && (
        <Notice tone="info" icon="information-line">
          <span data-testid="push-state">{st.text || "Notifications are not available in this browser."}</span>
        </Notice>
      )}
      {st.kind === "platform-off" && (
        <Notice tone="warn">
          <span data-testid="push-state">Push notifications are switched off by FORKSY right now. You still get everything in the app and by email where you chose it.</span>
        </Notice>
      )}
      {st.kind === "denied" && (
        <Notice tone="warn" icon="notification-off-line">
          <span data-testid="push-state">
            <b>Notifications are blocked for this site in your browser.</b> To turn them on, open the site settings from the lock icon next to the address (or the browser menu: Settings, Privacy, Site settings, Notifications), set FORKSY to Allow, then reload this page.
          </span>
        </Notice>
      )}
      {st.kind === "other" && (
        <>
          <Notice tone="info">
            <span data-testid="push-state">This browser is currently set up for notifications of a different FORKSY account (a shared computer?). You can switch it to yours.</span>
          </Notice>
          <button type="button" className="sf-btn sf-btn-primary" onClick={enable} disabled={busy} data-testid="push-enable">
            {busy ? <Spinner size={16} /> : null} Use this browser for my notifications
          </button>
        </>
      )}
      {st.kind === "off" && (
        <>
          <p className="sf-muted mb-2" data-testid="push-state">
            Notifications are off on this device. Turn them on to hear about your order even when this page is closed.
          </p>
          <button type="button" className="sf-btn sf-btn-primary" onClick={enable} disabled={busy} data-testid="push-enable">
            {busy ? <Spinner size={16} /> : <Ri name="notification-badge-line" />} Turn on notifications
          </button>
        </>
      )}
      {st.kind === "on" && (
        <>
          <p className="mb-2" data-testid="push-state">
            <span className="sf-tag sf-tag-ok">On</span> This device receives your notifications
            {prefs && prefs.pushEnabled === false ? ", but push is switched off for your whole account below." : "."}
          </p>
          <div className="sf-btnrow">
            <button type="button" className="sf-btn sf-btn-light" onClick={sendTest} disabled={test.busy} data-testid="push-test">
              {test.busy ? <Spinner size={16} /> : <Ri name="send-plane-line" />} Send a test notification
            </button>
            <button
              type="button"
              className="sf-btn sf-btn-light"
              disabled={busy}
              onClick={async () => {
                await disable();
                onChanged?.();
              }}
              data-testid="push-disable"
            >
              Turn off on this device
            </button>
          </div>
          {test.msg && (
            <p className={`sf-small mt-2 ${test.tone === "success" ? "sf-ok" : test.tone === "danger" ? "sf-danger" : "sf-muted"}`} role="status" data-testid="push-test-result">
              {test.msg}
            </p>
          )}
        </>
      )}
      {error && (
        <p className="sf-error mt-2" role="alert" data-testid="push-error">
          {error.message}
        </p>
      )}
      {prefs && (st.kind === "on" || st.kind === "off" || st.kind === "other") && (
        <div className="sf-switchrow mt-3">
          <Toggle
            label="Push notifications on all my devices"
            hint="Turn this off to stop push on every phone and computer at once. Messages in the app and by email are not affected."
            checked={prefs.pushEnabled}
            onChange={onMaster}
            testId="pref-master-push"
          />
        </div>
      )}
      {st.kind !== "loading" && (
        <button
          type="button"
          className="sf-btn sf-btn-link mt-1"
          onClick={() => {
            reload();
            onChanged?.();
          }}
        >
          Check again
        </button>
      )}
    </div>
  );
}

function Devices({ refreshKey, onChanged }) {
  const { push, state } = usePushState();
  const confirm = useSfConfirm();
  const [list, setList] = useState(null);
  const [err, setErr] = useState("");
  const load = useCallback(async () => {
    if (!push) return;
    try {
      setList(await push.devices());
      setErr("");
    } catch (e) {
      setErr(errorMessage(e));
    }
  }, [push]);
  useEffect(() => {
    load();
  }, [load, refreshKey, state?.browserSubscribed, state?.serverSubscribed]);

  const remove = async (d) => {
    if (!(await confirm({ title: "Remove this device?", message: `${d.label || "This device"} will stop receiving push notifications.${d.current ? " That is the browser you are using now." : ""}`, confirmText: "Remove", danger: true }))) return;
    try {
      await push.removeDevice(d.id);
      if (d.current) await push.disable();
      await load();
      onChanged?.();
    } catch (e) {
      setErr(errorMessage(e));
    }
  };
  return (
    <div className="sf-card sf-pad" data-testid="push-devices">
      <h3 className="sf-h3">
        <Ri name="macbook-line" /> Devices that get push notifications
      </h3>
      {err && <p className="sf-error">{err}</p>}
      {!list && !err && <Spinner />}
      {list && list.length === 0 && <p className="sf-muted mb-0">No devices yet.</p>}
      {list && list.length > 0 && (
        <ul className="sf-devlist">
          {list.map((d) => (
            <li key={d.id} data-testid="device-row">
              <div className="flex-grow-1">
                <b>{d.label || "Browser"}</b> {d.current && <span className="sf-tag sf-tag-ok ms-1">This device</span>}
                <div className="sf-small sf-muted">{d.lastSeenAt ? `Last seen ${timeAgo(d.lastSeenAt)}` : `Added ${timeAgo(d.createdAt)}`}</div>
              </div>
              <button type="button" className="sf-btn sf-btn-sm sf-btn-danger-outline" onClick={() => remove(d)} aria-label={`Remove ${d.label || "device"}`} data-testid="device-remove">
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function QuietHours({ prefs, save, saving }) {
  const q = prefs.quietHours;
  const [d, setD] = useState(q);
  useEffect(() => setD(prefs.quietHours), [prefs.quietHours]);
  const dirty = JSON.stringify(d) !== JSON.stringify(q);
  const zones = ZONES.includes(d.timezone) ? ZONES : [d.timezone, ...ZONES];
  const bad = d.enabled && d.start === d.end;
  return (
    <div className="sf-card sf-pad" data-testid="quiet-hours">
      <h3 className="sf-h3">
        <Ri name="moon-line" /> Quiet hours
      </h3>
      <p className="sf-small sf-muted">During quiet hours we hold push and text messages. Messages in the app are still saved for you.</p>
      <Toggle label="Use quiet hours" checked={d.enabled} onChange={(v) => setD({ ...d, enabled: v })} testId="quiet-enabled" />
      <div className="sf-two mt-2">
        <div className="sf-field">
          <label className="sf-label" htmlFor="qh-start">From</label>
          <input id="qh-start" type="time" className="sf-input" value={d.start} disabled={!d.enabled} onChange={(e) => setD({ ...d, start: e.target.value })} data-testid="quiet-start" />
        </div>
        <div className="sf-field">
          <label className="sf-label" htmlFor="qh-end">Until</label>
          <input id="qh-end" type="time" className="sf-input" value={d.end} disabled={!d.enabled} onChange={(e) => setD({ ...d, end: e.target.value })} data-testid="quiet-end" />
        </div>
      </div>
      <div className="sf-field">
        <label className="sf-label" htmlFor="qh-tz">Time zone</label>
        <select id="qh-tz" className="sf-input" value={d.timezone} disabled={!d.enabled} onChange={(e) => setD({ ...d, timezone: e.target.value })} data-testid="quiet-tz">
          {zones.map((z) => (
            <option key={z} value={z}>
              {z.replace(/_/g, " ")}
            </option>
          ))}
        </select>
      </div>
      <Toggle
        label="Let urgent order alerts through"
        hint="For example when your driver has arrived or your order was declined."
        checked={prefs.criticalBypassQuietHours}
        disabled={!d.enabled}
        onChange={(v) => save({ criticalBypassQuietHours: v }, "quiet-bypass")}
        testId="quiet-bypass"
      />
      {bad && <p className="sf-error">Start and end must be different times.</p>}
      <button type="button" className="sf-btn sf-btn-primary mt-3" disabled={!dirty || bad || saving.has("quiet")} onClick={() => save({ quietHours: d }, "quiet")} data-testid="quiet-save">
        {saving.has("quiet") ? <Spinner size={16} /> : null} Save quiet hours
      </button>
    </div>
  );
}

function Notifications() {
  const [prefs, setPrefs] = useState(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(new Set());
  const [saved, setSaved] = useState("");
  const [bump, setBump] = useState(0);
  const timer = useRef(null);

  const load = useCallback(async () => {
    try {
      setPrefs(await sfHttp.get("/notifications/preferences"));
      setError("");
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);
  useEffect(() => {
    load();
    return () => clearTimeout(timer.current);
  }, [load]);

  /** partial PUT; the answer is the full, merged view (so what the server really stored is what is shown) */
  const save = useCallback(async (patch, key) => {
    setSaving((s) => new Set(s).add(key));
    setError("");
    try {
      setPrefs(await sfHttp.put("/notifications/preferences", patch));
      setSaved("Saved");
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setSaved(""), 2500);
    } catch (e) {
      setError(errorMessage(e));
      load();
    } finally {
      setSaving((s) => {
        const n = new Set(s);
        n.delete(key);
        return n;
      });
    }
  }, [load]);

  const setChannel = (cat, ch, value) => {
    // optimistic: the switch moves at once, the answer of the API replaces it
    setPrefs((p) => (p ? { ...p, categories: { ...p.categories, [cat]: { ...p.categories[cat], [ch]: value } } } : p));
    save({ categories: { [cat]: { [ch]: value } } }, `${cat}.${ch}`);
  };

  const cats = (prefs?.meta?.categories || []).map((c) => c.key).filter((k) => CAT[k]);
  const order = cats.length ? cats : CATEGORY_KEYS;
  const locked = prefs?.meta?.lockedInApp || ["orders", "delivery", "payments", "support"];

  return (
    <section id="notifications" aria-labelledby="notif-h" data-testid="account-notifications">
      <div className="sf-row-between">
        <h2 className="sf-h2" id="notif-h">
          Notifications
        </h2>
        <span className="sf-small sf-ok" role="status" data-testid="prefs-saved">
          {saved}
        </span>
      </div>
      <p className="sf-muted">Choose how FORKSY keeps you posted about your orders.</p>
      {error && <ErrorBox message={error} onRetry={load} />}

      <PushDevice prefs={prefs} onMaster={(v) => save({ pushEnabled: v }, "master")} onChanged={() => setBump((n) => n + 1)} />

      {!prefs && !error && <Loading />}
      {prefs && (
        <>
          <h3 className="sf-h3 mt-3">What we tell you, and how</h3>
          {prefs.pushEnabled === false && (
            <Notice tone="warn" icon="notification-off-line">
              Push is switched off for your whole account (see "This device"). The Push switches below apply once you turn it back on.
            </Notice>
          )}
          <div className="sf-ncats">
            {order.map((k) => {
              const c = prefs.categories[k] || {};
              const lock = locked.includes(k);
              const promo = k === "promotions";
              return (
                <div key={k} className="sf-card sf-pad sf-ncat" data-testid={`cat-${k}`}>
                  <div className="sf-ncat-head">
                    <span className="sf-nic">
                      <Ri name={categoryIcon(k)} />
                    </span>
                    <div>
                      <b>{CAT[k].title}</b>
                      <div className="sf-small sf-muted">{CAT[k].text}</div>
                    </div>
                  </div>
                  <div className="sf-nchan">
                    <Toggle label="In the app" hint={lock ? "Always on" : undefined} checked={lock ? true : c.inApp} disabled={lock} onChange={(v) => setChannel(k, "inApp", v)} testId={`pref-${k}-inApp`} />
                    <Toggle label="Push" checked={c.push} onChange={(v) => setChannel(k, "push", v)} testId={`pref-${k}-push`} />
                    <Toggle
                      label={promo ? "Send me offers by email (optional)" : "Email"}
                      hint={promo ? "Marketing consent. Off unless you say yes; withdraw any time." : undefined}
                      checked={c.email}
                      onChange={(v) => setChannel(k, "email", v)}
                      testId={`pref-${k}-email`}
                    />
                    <Toggle
                      label={promo ? "Send me offers by text message (optional)" : "Text message"}
                      hint={promo ? "Marketing consent. Off unless you say yes; withdraw any time." : undefined}
                      checked={c.sms}
                      onChange={(v) => setChannel(k, "sms", v)}
                      testId={`pref-${k}-sms`}
                    />
                  </div>
                </div>
              );
            })}
          </div>
          <div className="mt-3">
            <QuietHours prefs={prefs} save={save} saving={saving} />
          </div>
        </>
      )}
      <div className="mt-3">
        <Devices refreshKey={bump} onChanged={() => setBump((n) => n + 1)} />
      </div>
    </section>
  );
}

export default function Account() {
  const { user, loading } = useSfAuth();
  const loc = useLocation();
  useEffect(() => {
    if (user && loc.hash === "#notifications") {
      const t = setTimeout(() => document.getElementById("notifications")?.scrollIntoView?.({ block: "start" }), 400);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [user, loc.hash]);
  if (loading) return <div className="sf-container"><Loading /></div>;
  if (!user) return <Navigate to="/order/login?next=/order/account" replace />;
  return (
    <div className="sf-container sf-narrow" data-testid="account-page">
      <h1 className="sf-h1">My account</h1>
      <div className="sf-card sf-pad">
        <div className="sf-row-between">
          <div>
            <b>{[user.firstName, user.lastName].filter(Boolean).join(" ") || "Your account"}</b>
            <div className="sf-small sf-muted">{[user.email, user.phone].filter(Boolean).join(" - ")}</div>
          </div>
          <Ri name="user-3-line" className="sf-bigicon" />
        </div>
        <div className="sf-chips-sm">
          <Link to="/order/orders" className="sf-chip sf-chip-sm">
            <Ri name="receipt-line" /> My orders
          </Link>
          <Link to="/order/wallet" className="sf-chip sf-chip-sm">
            <Ri name="wallet-3-line" /> Wallet and cards
          </Link>
          <Link to="/order/notifications" className="sf-chip sf-chip-sm">
            <Ri name="notification-3-line" /> Notification inbox
          </Link>
        </div>
      </div>
      <Notifications />
    </div>
  );
}
