import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@iconify/react/offline";
import { toast } from "react-toastify";
import { errorMessage, http } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { timeAgo } from "../../lib/format";
import { useAlerts, useNotify } from "../../lib/notify";
import { Badge, Button, Card, EmptyState, ErrorState, Loading, PageHeader, Select, Switch, useConfirm } from "../../ui";
import { CATEGORY_META, pushAdvice, useSharedPush } from "./shared";

const CHANNELS = [
  { key: "inApp", label: "In-app" },
  { key: "push", label: "Push" },
  { key: "email", label: "E-mail" },
  { key: "sms", label: "SMS" },
];

const CA_ZONES = [
  ["America/St_Johns", "Newfoundland (St. John's)"],
  ["America/Halifax", "Atlantic (Halifax)"],
  ["America/Toronto", "Eastern (Toronto, Ottawa)"],
  ["America/Winnipeg", "Central (Winnipeg)"],
  ["America/Regina", "Central, no daylight saving (Regina)"],
  ["America/Edmonton", "Mountain (Edmonton, Calgary)"],
  ["America/Vancouver", "Pacific (Vancouver)"],
  ["America/Whitehorse", "Yukon (Whitehorse)"],
];

const CSS = `
.fk-ns-opt{display:inline-flex;align-items:center;gap:8px;margin:0 18px 6px 0;cursor:pointer}
.fk-ns-opt input:disabled{opacity:1}
.fk-ns-opt.locked{cursor:not-allowed;color:var(--bs-secondary-color,#6b7280)}
`;

const clone = (o) => JSON.parse(JSON.stringify(o));
const pick = (p, restaurant) => ({
  pushEnabled: p.pushEnabled !== false,
  criticalBypassQuietHours: p.criticalBypassQuietHours !== false,
  ...(restaurant ? { soundEnabled: p.soundEnabled !== false, soundVolume: Number.isFinite(p.soundVolume) ? p.soundVolume : 80 } : {}),
  categories: clone(p.categories || {}),
  quietHours: { enabled: !!p.quietHours?.enabled, start: p.quietHours?.start || "22:00", end: p.quietHours?.end || "07:00", timezone: p.quietHours?.timezone || "America/Toronto" },
});

function deviceStatus(st, impersonating) {
  if (!st) return { tone: "neutral", label: "Checking..." };
  if (impersonating) return { tone: "neutral", label: "Not available" };
  if (!st.support?.ok) return { tone: "neutral", label: "Not supported" };
  if (st.config && !st.config.enabled && !st.browserSubscribed) return { tone: "neutral", label: "Switched off by FORKSY" };
  if (st.permission === "denied") return { tone: "warning", label: "Blocked in browser" };
  if (st.otherAccount) return { tone: "warning", label: "Another account" };
  if (st.on && st.pushEnabledPref === false) return { tone: "warning", label: "On, muted in preferences" };
  if (st.on) return { tone: "success", label: "On" };
  return { tone: "neutral", label: "Off" };
}

function TestResult({ result }) {
  if (!result) return null;
  const tone = (s) => (s === "SENT" ? "success" : s === "SKIPPED" || s === "PENDING" ? "warning" : "danger");
  return (
    <div className="mt-16 p-12 radius-8 border" data-testid="test-result" role="status">
      <div className="fw-semibold text-sm mb-8">{result.ok ? "The test notification was sent." : "The test was created, but it was not delivered to a device."}</div>
      <ul className="list-unstyled mb-0 d-flex flex-column gap-1">
        {(result.results || []).map((r, i) => (
          <li key={`${r.channel}-${i}`} className="d-flex flex-wrap align-items-center gap-2 text-sm">
            <span style={{ minWidth: 64 }}>{r.channel === "IN_APP" ? "In-app" : r.channel === "PUSH" ? "Push" : String(r.channel)}</span>
            <Badge tone={tone(r.status)}>{String(r.status)}</Badge>
            {r.error && <span className="text-secondary-light text-xs text-break">{String(r.error).slice(0, 160)}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Notification settings: this device (push), preferences (channels, quiet hours, restaurant sound) and the devices of the account. */
export default function NotificationSettings({ title = "Notification settings", subtitle = "Choose how and where FORKSY alerts you", crumbs }) {
  const ctx = useNotify();
  const restaurant = ctx?.app === "restaurant";
  const { impersonating } = useAuth();
  const sp = useSharedPush();
  const alerts = useAlerts();
  const confirm = useConfirm();
  const st = sp.state;
  const advice = pushAdvice(st, restaurant ? "restaurant" : "admin");

  // ------------------------------------------------------------------ this device
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const sendTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await http.post("/notifications/push/test", {}));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setTesting(false);
    }
  };
  const status = deviceStatus(st, impersonating);
  const canEnable = !!st && !impersonating && st.support?.ok && st.config?.enabled && st.permission !== "denied" && !st.on;

  // ------------------------------------------------------------------ preferences
  const [form, setForm] = useState(null);
  const [orig, setOrig] = useState("");
  const [meta, setMeta] = useState(null);
  const [loadErr, setLoadErr] = useState(null);
  const [saving, setSaving] = useState(false);
  const loadPrefs = useCallback(async () => {
    try {
      const p = await http.get("/notifications/preferences");
      const f = pick(p, restaurant);
      setMeta(p.meta || {});
      setForm(f);
      setOrig(JSON.stringify(f));
      setLoadErr(null);
    } catch (e) {
      setLoadErr(errorMessage(e));
    }
  }, [restaurant]);
  useEffect(() => {
    loadPrefs();
  }, [loadPrefs]);

  const dirty = !!form && JSON.stringify(form) !== orig;
  const locked = useMemo(() => new Set(meta?.lockedInApp || []), [meta]);
  const categories = useMemo(() => {
    const list = meta?.categories?.length ? meta.categories : Object.keys(CATEGORY_META).map((key) => ({ key, label: CATEGORY_META[key].label, description: "" }));
    return list.filter((c) => form?.categories?.[c.key]);
  }, [meta, form]);
  const zones = useMemo(() => {
    const out = [...CA_ZONES];
    const add = (tz, label) => tz && !out.some(([z]) => z === tz) && out.push([tz, label]);
    try {
      const b = Intl.DateTimeFormat().resolvedOptions().timeZone;
      add(b, `${b} (this device)`);
    } catch {
      /* ignore */
    }
    add(form?.quietHours?.timezone, form?.quietHours?.timezone);
    return out.map(([value, label]) => ({ value, label }));
  }, [form?.quietHours?.timezone]);

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const setChannel = (cat, ch, v) => setForm((f) => ({ ...f, categories: { ...f.categories, [cat]: { ...f.categories[cat], [ch]: v } } }));
  const setQuiet = (patch) => setForm((f) => ({ ...f, quietHours: { ...f.quietHours, ...patch } }));

  const save = async () => {
    setSaving(true);
    try {
      const saved = await http.put("/notifications/preferences", form);
      const f = pick(saved && saved.categories ? saved : form, restaurant);
      setForm(f);
      setOrig(JSON.stringify(f));
      if (saved?.meta) setMeta(saved.meta);
      toast.success("Notification preferences saved");
      window.dispatchEvent(new Event("fk:prefs-changed"));
      sp.reload();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const playTest = async () => {
    await alerts.unlockSound();
    const s = alerts.sound;
    if (s) {
      const saved = Number(JSON.parse(orig || "{}").soundVolume ?? 80);
      s.setVolume(form?.soundVolume ?? 80);
      alerts.playTest();
      setTimeout(() => s.setVolume(saved), 1500);
    }
  };

  // ------------------------------------------------------------------ devices
  const [devices, setDevices] = useState(null);
  const [devErr, setDevErr] = useState(null);
  const push = sp.push;
  const loadDevices = useCallback(async () => {
    if (!push) return;
    try {
      setDevices(await push.devices());
      setDevErr(null);
    } catch (e) {
      setDevErr(errorMessage(e));
    }
  }, [push]);
  useEffect(() => {
    loadDevices();
  }, [loadDevices, st?.on, st?.browserSubscribed]);

  const removeDevice = async (d) => {
    const r = await confirm({ title: `Remove ${d.label || "this device"}?`, message: d.current ? "This browser will stop receiving notifications until you turn them on again." : "That device will stop receiving push notifications until it is turned on again.", danger: true, confirmText: "Remove" });
    if (!r?.confirmed) return;
    try {
      if (d.current) await sp.disable();
      else await http.del(`/notifications/push/devices/${d.id}`);
      toast.success("Device removed");
    } catch (e) {
      toast.error(errorMessage(e));
    }
    loadDevices();
    sp.reload();
  };

  return (
    <>
      <style>{CSS}</style>
      <PageHeader title={title} subtitle={subtitle} crumbs={crumbs} />
      <div className="row gy-4">
        {/* ------------------------------------------------------------ this device */}
        <div className="col-12">
          <Card title="This device" subtitle="Browser notifications on this computer or phone" actions={<Badge tone={status.tone}>{status.label}</Badge>}>
            {impersonating && <p className="mb-0 text-secondary-light">Notifications cannot be turned on while you are viewing another account.</p>}
            {!impersonating && !st && <Loading minHeight={80} />}
            {!impersonating && st && (
              <>
                {advice && (
                  <div className="p-12 radius-8 border mb-16" data-testid="device-advice" data-kind={advice.kind}>
                    <div className="fw-semibold">{advice.title}</div>
                    <div className="text-secondary-light text-sm">{advice.text}</div>
                  </div>
                )}
                {!advice && st.on && (
                  <p className="text-secondary-light mb-16">
                    Notifications are on for this browser. You will get alerts here even when the FORKSY tab is closed{restaurant ? ", including new-order alerts" : ""}.
                    {st.pushEnabledPref === false && " Push is currently muted by the master switch below."}
                  </p>
                )}
                {sp.error && (
                  <div className="text-danger-600 text-sm mb-12" role="alert">
                    {sp.error.message}
                  </div>
                )}
                <div className="d-flex flex-wrap gap-2">
                  {canEnable && (
                    <Button loading={sp.busy} onClick={() => sp.enable()} icon="solar:bell-bing-outline" data-testid="enable-push">
                      {st.otherAccount ? "Use for my account" : "Turn on notifications"}
                    </Button>
                  )}
                  {st.on && (
                    <Button variant="light" loading={sp.busy} onClick={() => sp.disable()} icon="solar:bell-off-outline" data-testid="disable-push">
                      Turn off on this device
                    </Button>
                  )}
                  <Button variant="outline" loading={testing} onClick={sendTest} icon="solar:letter-outline" data-testid="send-test">
                    Send test notification to me
                  </Button>
                </div>
              </>
            )}
            <TestResult result={testResult} />
          </Card>
        </div>

        {/* ------------------------------------------------------------ preferences */}
        <div className="col-12">
          <Card
            title="Preferences"
            subtitle="Which alerts you get, and on which channel"
            actions={
              <>
                {meta?.quietNow && <Badge tone="info">Quiet hours active now</Badge>}
                <Button loading={saving} disabled={!dirty} onClick={save} data-testid="save-prefs">
                  Save preferences
                </Button>
              </>
            }
          >
            {loadErr && !form && <ErrorState error={loadErr} onRetry={loadPrefs} />}
            {!form && !loadErr && <Loading minHeight={120} />}
            {form && (
              <>
                <Switch label="Push notifications" hint="Master switch for browser and phone push on all your devices. In-app alerts are not affected." checked={form.pushEnabled} onChange={(v) => set({ pushEnabled: v })} />

                <h6 className="fw-semibold mt-8 mb-4">Channels per category</h6>
                <p className="text-secondary-light text-sm mb-8">In-app is always on for orders, delivery, payments and support so you never lose a record.</p>
                <div className="border-top" data-testid="prefs-categories">
                  {categories.map((c) => (
                    <div key={c.key} className="row align-items-center py-12 border-bottom gx-3">
                      <div className="col-md-5 mb-8 mb-md-0">
                        <div className="fw-semibold">{c.label}</div>
                        {c.description && <div className="text-secondary-light text-xs">{c.description}</div>}
                      </div>
                      <div className="col-md-7 d-flex flex-wrap">
                        {CHANNELS.map((ch) => {
                          const isLocked = ch.key === "inApp" && locked.has(c.key);
                          return (
                            <label key={ch.key} className={`fk-ns-opt ${isLocked ? "locked" : ""}`} title={isLocked ? "Always on" : undefined}>
                              <input
                                type="checkbox"
                                className="form-check-input m-0"
                                checked={isLocked ? true : !!form.categories[c.key][ch.key]}
                                disabled={isLocked}
                                onChange={(e) => setChannel(c.key, ch.key, e.target.checked === true)}
                                data-cat={c.key}
                                data-ch={ch.key}
                              />
                              <span className="text-sm">
                                {ch.label}
                                {isLocked ? " (always on)" : ""}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>

                <h6 className="fw-semibold mt-24 mb-8">Quiet hours</h6>
                <Switch label="Mute push during quiet hours" hint="Alerts are still saved in your notification list." checked={form.quietHours.enabled} onChange={(v) => setQuiet({ enabled: v })} className="mb-12" />
                <div className="row g-3">
                  <div className="col-6 col-md-3">
                    <label className="form-label fw-semibold text-primary-light text-sm mb-8" htmlFor="fk-qh-start">
                      From
                    </label>
                    <input id="fk-qh-start" type="time" className="form-control radius-8" value={form.quietHours.start} disabled={!form.quietHours.enabled} onChange={(e) => setQuiet({ start: e.target.value })} />
                  </div>
                  <div className="col-6 col-md-3">
                    <label className="form-label fw-semibold text-primary-light text-sm mb-8" htmlFor="fk-qh-end">
                      Until
                    </label>
                    <input id="fk-qh-end" type="time" className="form-control radius-8" value={form.quietHours.end} disabled={!form.quietHours.enabled} onChange={(e) => setQuiet({ end: e.target.value })} />
                  </div>
                  <div className="col-12 col-md-6">
                    <Select label="Time zone" id="fk-qh-tz" value={form.quietHours.timezone} options={zones} allowEmpty={false} disabled={!form.quietHours.enabled} onChange={(v) => setQuiet({ timezone: v })} className="mb-0" />
                  </div>
                </div>
                <Switch
                  label="Critical alerts ignore quiet hours"
                  hint={restaurant ? "New orders, cancellation requests and safety alerts still come through." : "Urgent incidents and safety alerts still come through."}
                  checked={form.criticalBypassQuietHours}
                  onChange={(v) => set({ criticalBypassQuietHours: v })}
                  className="mt-16 mb-0"
                />

                {restaurant && (
                  <>
                    <h6 className="fw-semibold mt-24 mb-8">Alarm sound</h6>
                    <Switch label="Ring the alarm for new orders and cancellation requests" hint="The alarm repeats until you accept the order or acknowledge it. The banner is always shown." checked={form.soundEnabled} onChange={(v) => set({ soundEnabled: v })} className="mb-12" />
                    <div className="row g-3 align-items-end">
                      <div className="col-12 col-md-6">
                        <label className="form-label fw-semibold text-primary-light text-sm mb-8" htmlFor="fk-volume">
                          Volume: <span data-testid="volume-value">{form.soundVolume}</span>%
                        </label>
                        <input id="fk-volume" type="range" min={0} max={100} step={5} className="form-range" value={form.soundVolume} disabled={!form.soundEnabled} onChange={(e) => set({ soundVolume: Number(e.target.value) })} />
                      </div>
                      <div className="col-12 col-md-6 d-flex flex-wrap align-items-center gap-2">
                        <Button variant="outline" icon="solar:volume-loud-outline" onClick={playTest} data-testid="play-test-sound">
                          Play test sound
                        </Button>
                        {alerts.soundState === "running" && <Badge tone="success">Sound ready</Badge>}
                        {alerts.soundState === "blocked" && (
                          <button type="button" className="btn btn-warning-600 btn-sm radius-8 px-12 py-6" onClick={alerts.unlockSound} data-testid="unlock-sound">
                            Sound blocked - click to enable
                          </button>
                        )}
                        {alerts.soundState === "unsupported" && <Badge tone="neutral">Sound not supported in this browser</Badge>}
                      </div>
                    </div>
                  </>
                )}
              </>
            )}
          </Card>
        </div>

        {/* ------------------------------------------------------------ devices */}
        <div className="col-12">
          <Card title="My devices" subtitle="Browsers and phones that receive your push notifications">
            {devErr && <ErrorState error={devErr} onRetry={loadDevices} />}
            {!devErr && devices === null && <Loading minHeight={80} />}
            {!devErr && devices && devices.length === 0 && <EmptyState icon="solar:smartphone-outline" title="No devices yet" text="Turn on notifications on this device to receive alerts here, even when the tab is closed." />}
            {!devErr && devices && devices.length > 0 && (
              <ul className="list-unstyled mb-0" data-testid="device-list">
                {devices.map((d) => (
                  <li key={d.id} className="d-flex flex-wrap align-items-center justify-content-between gap-2 py-12 border-bottom">
                    <div className="d-flex align-items-center gap-3" style={{ minWidth: 0 }}>
                      <Icon icon={d.kind === "native" ? "solar:smartphone-outline" : "solar:monitor-outline"} className="text-2xl text-secondary-light flex-shrink-0" aria-hidden="true" />
                      <div style={{ minWidth: 0 }}>
                        <div className="fw-semibold text-break">
                          {d.label || (d.kind === "native" ? "Phone app" : "Web browser")} {d.current && <Badge tone="primary" className="ms-1">This browser</Badge>}
                        </div>
                        <div className="text-secondary-light text-xs">
                          {[d.platform, d.app].filter(Boolean).join(" - ")}
                          {d.lastSeenAt ? ` - last seen ${timeAgo(d.lastSeenAt)}` : ""}
                          {d.failures > 0 ? ` - ${d.failures} failed deliveries` : ""}
                        </div>
                      </div>
                    </div>
                    <Button variant="outline-danger" onClick={() => removeDevice(d)} aria-label={`Remove ${d.label || "device"}`}>
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
