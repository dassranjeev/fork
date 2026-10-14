import React, { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "react-toastify";
import { Icon } from "@iconify/react/offline";
import { Badge, Button, Card, EmptyState, ErrorState, Loading, PageHeader, Pager, Segmented, Select, StatCard, StatusBadge, Switch, Tabs, useConfirm } from "../../ui";
import { useFetch } from "../../lib/hooks";
import { useAuth } from "../../lib/auth";
import { errorMessage, http } from "../../lib/api";
import { fmtDateTime, num, pct, timeAgo, titleCase } from "../../lib/format";

const CH_TONE = { PUSH: "primary", IN_APP: "info", EMAIL: "neutral", SMS: "warning" };
const CH_LABEL = { IN_APP: "In-app", PUSH: "Push", EMAIL: "Email", SMS: "SMS" };
const STATUS_TONE = { SENT: "success", FAILED: "danger", SKIPPED: "warning", QUEUED: "info" };
const APPS = ["customer", "driver", "restaurant", "admin"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const shortKey = (k) => (k && k.length > 24 ? `${k.slice(0, 12)}…${k.slice(-8)}` : k || "—");
async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success("Copied");
  } catch {
    toast.error("Could not copy - select and copy it by hand");
  }
}
const ChannelBadge = ({ c }) => <Badge tone={CH_TONE[c] || "neutral"}>{CH_LABEL[c] || titleCase(c)}</Badge>;
const DeliveryBadge = ({ status }) => <StatusBadge status={status} tone={STATUS_TONE[status]} />;

// ------------------------------------------------------------------------------------------------ 1. push health
function Health({ canEdit }) {
  const { data, loading, error, reload } = useFetch("/admin/notifications/overview", undefined, { refreshMs: 30000 });
  const confirm = useConfirm();
  const [busy, setBusy] = useState(null);

  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorState error={error} onRetry={reload} />;
  const { switches = {}, vapid = {}, fcm = {}, health = {} } = data || {};
  const d = health.last24h || {};
  const byApp = Object.entries(health.byApp || {});

  const setSwitch = async (key, label, value) => {
    if (!value) {
      const r = await confirm({
        title: `Switch off ${label}?`,
        message: key === "enabled" ? "No push notification will be sent to anybody (web or native) until you switch it back on. Critical alerts such as new orders and driver offers are also stopped." : `${label} stops for every user until you switch it back on.`,
        confirmText: "Switch off",
        danger: true,
      });
      if (!r.confirmed) return;
    }
    setBusy(key);
    try {
      await http.put("/admin/notifications/switches", { [key]: value });
      toast.success(`${label} is now ${value ? "on" : "off"}`);
      reload();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const sw = [
    ["enabled", "All push notifications", "Master switch: stops web and native push for everybody."],
    ["webEnabled", "Browser (web) push", "Admin Console, Restaurant Portal, customer website and driver pages."],
    ["fcmEnabled", "Native app push (FCM)", "iOS and Android apps."],
  ];

  return (
    <>
      {error && <ErrorState error={error} onRetry={reload} />}
      <div className="row gy-3 mb-24">
        <div className="col-xxl-3 col-md-6">
          <StatCard label="Web push (VAPID)" value={vapid.configured ? "Configured" : "Not configured"} tone={vapid.configured ? "success" : "danger"} icon="solar:key-outline" hint={vapid.configured ? `Key source: ${vapid.source || "unknown"}` : "Browsers cannot subscribe"} />
        </div>
        <div className="col-xxl-3 col-md-6">
          <StatCard label="Browser subscriptions" value={num(health.subscriptions)} icon="solar:smartphone-outline" hint={byApp.length ? byApp.map(([a, n]) => `${a} ${n}`).join(" · ") : "none yet"} />
        </div>
        <div className="col-xxl-3 col-md-6">
          <StatCard label="Users with push" value={num(health.users)} tone="info" icon="solar:users-group-rounded-outline" hint={`${num(health.failingSubscriptions)} subscription(s) failing`} />
        </div>
        <div className="col-xxl-3 col-md-6">
          <StatCard label="Failure rate (24 h)" value={pct(d.failureRate)} tone={d.failureRate > 20 ? "danger" : d.failureRate > 5 ? "warning" : "success"} icon="solar:danger-triangle-outline" hint={`${num(d.sent)} sent · ${num(d.failed)} failed · ${num(d.skipped)} skipped`} />
        </div>
        <div className="col-xxl-3 col-md-6">
          <StatCard label="Dead subscriptions removed" value={`${num(d.deadRemoved)} / ${num(health.deadRemoved7d)}`} tone="neutral" icon="solar:trash-bin-minimalistic-outline" hint="last 24 h / last 7 days" />
        </div>
        <div className="col-xxl-3 col-md-6">
          <StatCard label="Native push (FCM)" value={fcm.configured ? "Configured" : "Not configured"} tone={fcm.configured ? "success" : "neutral"} icon="solar:smartphone-outline" hint={fcm.configured ? "iOS / Android devices" : "native apps only; FCM is not configured"} />
        </div>
        <div className="col-xxl-3 col-md-6">
          <StatCard label="Notification events" value={num(data?.events)} tone="purple" icon="solar:bell-bing-outline" hint="in the event registry" />
        </div>
      </div>

      <div className="row gy-3">
        <div className="col-lg-6">
          <Card title="Web push key" subtitle="The public VAPID key browsers subscribe with. The private key never leaves the server." bodyClassName="p-24">
            {vapid.configured ? (
              <>
                <div className="d-flex flex-wrap align-items-center gap-2 mb-12">
                  <code className="text-break" title={vapid.publicKey} data-testid="vapid-key">{shortKey(vapid.publicKey)}</code>
                  <Button variant="light" icon="solar:copy-outline" onClick={() => copy(vapid.publicKey)} aria-label="Copy the public key">
                    Copy
                  </Button>
                </div>
                <div className="text-sm text-secondary-light mb-4">
                  Source: <strong className="text-primary-light">{vapid.source || "unknown"}</strong>
                  {vapid.source === "generated" && " - generated automatically and stored; set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY in production so it survives a rebuild."}
                </div>
                <div className="text-sm text-secondary-light">
                  Contact (subject): <strong className="text-primary-light text-break">{vapid.subject || "—"}</strong>
                </div>
              </>
            ) : (
              <p className="mb-0 text-secondary-light">No VAPID key is available, so browser push is off.</p>
            )}
          </Card>
        </div>
        <div className="col-lg-6">
          <Card title="Kill switches" subtitle="Stop sending push platform-wide in an incident. Every change is written to the audit log." bodyClassName="p-24">
            {sw.map(([key, label, hint]) =>
              canEdit ? (
                <Switch key={key} label={label} hint={hint} checked={switches[key] !== false} disabled={busy === key} onChange={(v) => setSwitch(key, label, v)} className="mb-16" />
              ) : (
                <div key={key} className="d-flex justify-content-between align-items-start gap-3 mb-16">
                  <div>
                    <div className="fw-medium text-primary-light">{label}</div>
                    <div className="text-secondary-light text-xs">{hint}</div>
                  </div>
                  <Badge tone={switches[key] !== false ? "success" : "danger"}>{switches[key] !== false ? "On" : "Off"}</Badge>
                </div>
              )
            )}
            {!canEdit && <p className="text-secondary-light text-xs mb-0">You can view these switches; changing them needs the Notifications &gt; Edit permission.</p>}
            {switches.enabled === false && <div className="alert alert-warning radius-8 mt-12 mb-0">Push is switched off for the whole platform right now.</div>}
          </Card>
        </div>
      </div>
    </>
  );
}

// ------------------------------------------------------------------------------------------------ 2. delivery log
const dayStart = (d) => (d ? new Date(`${d}T00:00:00`).toISOString() : undefined);
const dayEnd = (d) => (d ? new Date(`${d}T23:59:59.999`).toISOString() : undefined);

function Detail({ row }) {
  const items = [
    ["Title", row.title],
    ["Category", row.category],
    ["User", `${row.user || "—"}${row.userType ? ` (${titleCase(row.userType)})` : ""}`],
    ["Delivery id", row.id],
    ["Attempts", row.attempts],
    ["Created", fmtDateTime(row.createdAt)],
    ["Devices sent / failed / removed", row.result ? `${row.result.sent ?? 0} / ${row.result.failed ?? 0} / ${row.result.removed ?? 0}` : "—"],
  ];
  return (
    <div className="p-16 bg-neutral-50 radius-8">
      <div className="row gy-2">
        {items.map(([k, v]) => (
          <div key={k} className="col-md-6 col-xl-4">
            <div className="text-secondary-light text-xs">{k}</div>
            <div className="text-sm text-break fw-medium">{v === undefined || v === null || v === "" ? "—" : String(v)}</div>
          </div>
        ))}
        {row.error && (
          <div className="col-12">
            <div className="text-secondary-light text-xs">Error</div>
            <div className="text-sm text-danger-main text-break">{row.error}</div>
          </div>
        )}
      </div>
    </div>
  );
}

function DeliveryLog({ canEdit }) {
  const [f, setF] = useState({ channel: "", status: "", event: "", q: "", from: "", to: "" });
  const [applied, setApplied] = useState(f);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [open, setOpen] = useState(null);
  const [retrying, setRetrying] = useState(null);
  const params = useMemo(() => ({ page, limit, channel: applied.channel, status: applied.status, event: applied.event.trim(), q: applied.q.trim(), from: dayStart(applied.from), to: dayEnd(applied.to) }), [applied, page, limit]);
  const { data, loading, error, reload } = useFetch("/admin/notifications/log", params);
  const rows = data?.data || [];
  const meta = data?.meta || { page, limit, total: 0, totalPages: 1 };
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target ? e.target.value : e }));
  const apply = (e) => {
    e?.preventDefault();
    setPage(1);
    setApplied(f);
  };
  const clear = () => {
    const z = { channel: "", status: "", event: "", q: "", from: "", to: "" };
    setF(z);
    setApplied(z);
    setPage(1);
  };

  const retry = async (row) => {
    setRetrying(row.id);
    try {
      const r = await http.post(`/admin/notifications/log/${row.id}/retry`, {});
      if (r?.status === "SENT") toast.success("Re-sent");
      else toast.warn(`Retry finished: ${r?.status || "unknown"}${r?.error ? ` - ${r.error}` : ""}`);
      reload();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setRetrying(null);
    }
  };

  return (
    <Card title="Delivery log" subtitle="Push, SMS and e-mail deliveries. In-app notifications are not listed." actions={<Button variant="light" icon="solar:refresh-outline" onClick={reload}>Refresh</Button>}>
      <form className="row g-2 mb-20 align-items-end" onSubmit={apply}>
        <div className="col-6 col-md-2">
          <label className="form-label text-xs mb-1">Channel</label>
          <select className="form-select form-select-sm radius-8" value={f.channel} onChange={set("channel")} aria-label="Channel">
            <option value="">All</option>
            {["PUSH", "SMS", "EMAIL"].map((c) => (
              <option key={c} value={c}>{CH_LABEL[c]}</option>
            ))}
          </select>
        </div>
        <div className="col-6 col-md-2">
          <label className="form-label text-xs mb-1">Status</label>
          <select className="form-select form-select-sm radius-8" value={f.status} onChange={set("status")} aria-label="Status">
            <option value="">All</option>
            {["SENT", "FAILED", "SKIPPED", "QUEUED"].map((c) => (
              <option key={c} value={c}>{titleCase(c)}</option>
            ))}
          </select>
        </div>
        <div className="col-6 col-md-3">
          <label className="form-label text-xs mb-1">Event</label>
          <input className="form-control form-control-sm radius-8" placeholder="e.g. order.new" maxLength={80} value={f.event} onChange={set("event")} aria-label="Event" />
        </div>
        <div className="col-6 col-md-3">
          <label className="form-label text-xs mb-1">Search (user, event, title, error)</label>
          <input className="form-control form-control-sm radius-8" maxLength={80} value={f.q} onChange={set("q")} aria-label="Search" />
        </div>
        <div className="col-6 col-md-2">
          <label className="form-label text-xs mb-1">From</label>
          <input type="date" className="form-control form-control-sm radius-8" value={f.from} max={f.to || undefined} onChange={set("from")} aria-label="From date" />
        </div>
        <div className="col-6 col-md-2">
          <label className="form-label text-xs mb-1">To</label>
          <input type="date" className="form-control form-control-sm radius-8" value={f.to} min={f.from || undefined} onChange={set("to")} aria-label="To date" />
        </div>
        <div className="col-12 col-md-auto d-flex gap-2">
          <Button type="submit">Apply</Button>
          <Button variant="light" onClick={clear}>Clear</Button>
        </div>
      </form>

      {error && <ErrorState error={error} onRetry={reload} />}
      <div className="table-responsive scroll-sm">
        <table className="table bordered-table sm-table mb-0 align-middle" data-testid="delivery-log">
          <thead>
            <tr>
              <th>Time</th>
              <th>User</th>
              <th>Channel</th>
              <th>Event</th>
              <th>Status</th>
              <th>Error</th>
              <th className="text-end">Attempts</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {loading && rows.length === 0 ? (
              <tr><td colSpan={8}><Loading minHeight={120} /></td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={8}><EmptyState title="No deliveries match" text="Pushes, SMS and e-mails appear here as they are sent." /></td></tr>
            ) : (
              rows.map((r) => {
                const isOpen = open === r.id;
                const canRetry = canEdit && (r.status === "FAILED" || r.status === "SKIPPED");
                return (
                  <React.Fragment key={r.id}>
                    <tr onClick={() => setOpen(isOpen ? null : r.id)} style={{ cursor: "pointer", opacity: loading ? 0.6 : 1 }} aria-expanded={isOpen}>
                      <td className="text-nowrap text-sm" title={fmtDateTime(r.createdAt)}>{timeAgo(r.createdAt)}</td>
                      <td className="text-sm text-break" style={{ maxWidth: 220 }}>{r.user || "—"}</td>
                      <td><ChannelBadge c={r.channel} /></td>
                      <td className="font-monospace text-sm text-break">{r.event || "—"}</td>
                      <td><DeliveryBadge status={r.status} /></td>
                      <td className="text-sm text-secondary-light text-break" style={{ maxWidth: 260 }}>{r.error ? (r.error.length > 80 ? `${r.error.slice(0, 80)}…` : r.error) : "—"}</td>
                      <td className="text-end">{r.attempts}</td>
                      <td className="text-end text-nowrap">
                        {canRetry && (
                          <Button variant="outline" size="sm" loading={retrying === r.id} onClick={(e) => { e.stopPropagation(); retry(r); }}>
                            Retry
                          </Button>
                        )}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td colSpan={8} className="p-0 border-0"><Detail row={r} /></td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      <Pager meta={meta} onPage={setPage} onLimit={(n) => { setLimit(n); setPage(1); }} />
    </Card>
  );
}

// ------------------------------------------------------------------------------------------------ 3. send a test
function SendTest() {
  const confirm = useConfirm();
  const roles = useFetch("/admin/roles");
  const [kind, setKind] = useState("user");
  const [userId, setUserId] = useState("");
  const [roleId, setRoleId] = useState("");
  const [app, setApp] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [err, setErr] = useState("");
  const roleList = roles.data?.data || (Array.isArray(roles.data) ? roles.data : []);

  const me = async () => {
    try {
      const r = await http.get("/auth/me");
      const id = r?.id || r?.user?.id || r?.data?.id;
      if (id) setUserId(id);
      else toast.error("Could not read your user id");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const target = kind === "user" ? userId.trim() : kind === "role" ? roleId : app;
  const valid = kind === "user" ? UUID.test(target) : !!target;
  const send = async () => {
    setErr("");
    if (kind !== "user") {
      const label = kind === "role" ? `every active staff member with the role "${roleList.find((r) => r.id === roleId)?.name || ""}"` : `every ${app} user with a browser subscription`;
      const r = await confirm({ title: "Send a test push?", message: `A test notification will be sent to ${label} (up to 200 people).`, confirmText: "Send" });
      if (!r.confirmed) return;
    }
    setBusy(true);
    setResult(null);
    try {
      const body = { [kind === "user" ? "userId" : kind === "role" ? "roleId" : "app"]: target };
      if (message.trim()) body.message = message.trim();
      setResult(await http.post("/admin/notifications/test", body));
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="row gy-3">
      <div className="col-lg-6">
        <Card title="Send a test push" subtitle="Sends a real notification (push + in-app) so you can check the whole chain end to end." bodyClassName="p-24">
          <div className="mb-16">
            <Segmented value={kind} onChange={(k) => { setKind(k); setResult(null); setErr(""); }} options={[{ value: "user", label: "One user" }, { value: "role", label: "Staff role" }, { value: "app", label: "An app" }]} />
          </div>
          {kind === "user" && (
            <div className="mb-16">
              <label className="form-label fw-semibold text-sm">User id</label>
              <div className="d-flex flex-wrap gap-2">
                <input className="form-control radius-8" style={{ flex: "1 1 280px" }} placeholder="00000000-0000-0000-0000-000000000000" value={userId} onChange={(e) => setUserId(e.target.value)} aria-label="User id" />
                <Button variant="light" icon="solar:user-rounded-outline" onClick={me}>Myself</Button>
              </div>
              {userId && !UUID.test(userId.trim()) && <div className="text-danger-main text-xs mt-4">That is not a valid user id (UUID).</div>}
              <div className="text-secondary-light text-xs mt-4">Tip: the id is shown in the address bar of a customer, driver or staff detail page.</div>
            </div>
          )}
          {kind === "role" && (
            <Select label="Staff role" value={roleId} onChange={setRoleId} options={roleList.map((r) => ({ value: r.id, label: r.name }))} placeholder={roles.loading ? "Loading…" : "Choose a role"} />
          )}
          {kind === "app" && <Select label="App" value={app} onChange={setApp} options={APPS.map((a) => ({ value: a, label: titleCase(a) }))} placeholder="Choose an app" hint="Everyone of that app who has at least one browser subscription (max 200)." />}
          <div className="mb-16">
            <label className="form-label fw-semibold text-sm">Message (optional)</label>
            <input className="form-control radius-8" maxLength={120} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="This is a test push from FORKY." aria-label="Message" />
          </div>
          <Button icon="solar:plain-outline" loading={busy} disabled={!valid} onClick={send}>Send test</Button>
          {err && <div className="alert alert-danger radius-8 mt-16 mb-0">{err}</div>}
        </Card>
      </div>
      <div className="col-lg-6">
        <Card title="Result" bodyClassName="p-24">
          {!result ? (
            <p className="text-secondary-light mb-0">The delivery result of each target shows here after you send.</p>
          ) : (
            <>
              <div className="mb-12" data-testid="test-summary">
                <strong>{result.sent}</strong> of <strong>{result.targets}</strong> target(s) received the push.
              </div>
              {result.targets === 0 ? (
                <EmptyState title="Nobody to notify" text="No active user matched this target (or nobody has a browser subscription)." />
              ) : (
                <div className="table-responsive scroll-sm">
                  <table className="table bordered-table sm-table mb-0 align-middle">
                    <thead>
                      <tr><th>User</th><th>Push</th><th>Detail</th></tr>
                    </thead>
                    <tbody>
                      {(result.results || []).map((r) => (
                        <tr key={r.userId}>
                          <td className="font-monospace text-xs text-break">{r.userId}</td>
                          <td><DeliveryBadge status={r.push} /></td>
                          <td className="text-sm text-secondary-light text-break">{r.error || (r.push === "SENT" ? "Delivered to the push service" : "—")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="text-secondary-light text-xs mt-12">The notification also appears in each user&apos;s in-app list. See the Delivery log tab for the stored result.</div>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ 4. coverage
const sameChannels = (a = [], b = []) => a.length === b.length && a.every((x) => b.includes(x));

function Coverage() {
  const { data, loading, error, reload } = useFetch("/admin/notifications/coverage");
  const [cat, setCat] = useState("");
  const [aud, setAud] = useState("");
  const [q, setQ] = useState("");
  const rows = data?.rows || [];
  const cats = useMemo(() => (Array.isArray(data?.categories) ? data.categories : []).map((c) => (typeof c === "string" ? { key: c, label: titleCase(c) } : c)), [data]);
  const catLabel = (k) => cats.find((c) => c.key === k)?.label || titleCase(k);
  const audiences = useMemo(() => [...new Set(rows.map((r) => r.audience))], [rows]);
  const shown = useMemo(() => rows.filter((r) => (!cat || r.category === cat) && (!aud || r.audience === aud) && (!q.trim() || r.event.toLowerCase().includes(q.trim().toLowerCase()))), [rows, cat, aud, q]);

  return (
    <>
      <div className="d-flex flex-wrap gap-2 mb-20">
        <Link to="/notification-matrix" className="btn btn-primary-600 btn-sm px-16 py-8 radius-8 d-inline-flex align-items-center gap-2">
          <Icon icon="solar:bell-bing-outline" className="text-lg" /> Edit channels in Notification Matrix
        </Link>
        <Link to="/notification-templates" className="btn btn-outline-primary-600 btn-sm px-16 py-8 radius-8 d-inline-flex align-items-center gap-2">
          <Icon icon="solar:chat-square-like-outline" className="text-lg" /> Edit copy in Notification Templates
        </Link>
      </div>
      <Card title="Event coverage" subtitle="Every event, who receives it and through which channels (read-only; this is the effective configuration)." actions={<Button variant="light" icon="solar:refresh-outline" onClick={reload}>Refresh</Button>}>
        <div className="d-flex flex-wrap gap-2 mb-20">
          <select className="form-select form-select-sm h-40-px w-auto radius-8" value={cat} onChange={(e) => setCat(e.target.value)} aria-label="Category">
            <option value="">All categories</option>
            {cats.map((c) => (
              <option key={c.key} value={c.key}>{c.label}</option>
            ))}
          </select>
          <select className="form-select form-select-sm h-40-px w-auto radius-8" value={aud} onChange={(e) => setAud(e.target.value)} aria-label="Audience">
            <option value="">All audiences</option>
            {audiences.map((c) => (
              <option key={c} value={c}>{titleCase(c)}</option>
            ))}
          </select>
          <input className="form-control form-control-sm h-40-px radius-8" style={{ maxWidth: 260 }} placeholder="Search event…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search events" />
          <span className="text-secondary-light text-sm align-self-center">{shown.length} of {rows.length} rows</span>
        </div>
        {error && <ErrorState error={error} onRetry={reload} />}
        <div className="table-responsive scroll-sm">
          <table className="table bordered-table sm-table mb-0 align-middle" data-testid="coverage">
            <thead>
              <tr><th>Event</th><th>Audience</th><th>Category</th><th>Effective channels</th><th>Flags</th></tr>
            </thead>
            <tbody>
              {loading && rows.length === 0 ? (
                <tr><td colSpan={5}><Loading minHeight={120} /></td></tr>
              ) : shown.length === 0 ? (
                <tr><td colSpan={5}><EmptyState title="No events match" /></td></tr>
              ) : (
                shown.map((r) => {
                  const custom = !sameChannels(r.channels, r.defaultChannels);
                  const pushNoCopy = (r.channels || []).includes("PUSH") && !r.hasPushCopy;
                  return (
                    <tr key={`${r.event}|${r.audience}`}>
                      <td className="font-monospace text-sm text-break">{r.event}</td>
                      <td>{titleCase(r.audience)}</td>
                      <td>{catLabel(r.category)}</td>
                      <td>
                        <div className="d-flex flex-wrap gap-1 align-items-center">
                          {(r.channels || []).length === 0 ? <span className="text-secondary-light text-sm">none</span> : r.channels.map((c) => <ChannelBadge key={c} c={c} />)}
                          {custom && <span className="text-xs text-warning-main" title={`Default: ${(r.defaultChannels || []).map((c) => CH_LABEL[c] || c).join(", ") || "none"}`}>customised</span>}
                        </div>
                      </td>
                      <td>
                        <div className="d-flex flex-wrap gap-1">
                          {r.critical && <Badge tone="danger">Critical</Badge>}
                          {r.urgency && r.urgency !== "normal" && <Badge tone={r.urgency === "high" ? "warning" : "neutral"}>Urgency: {r.urgency}</Badge>}
                          {r.requireInteraction && <Badge tone="info">Stays until dismissed</Badge>}
                          {r.neverPush && <Badge tone="neutral">Never pushed</Badge>}
                          {pushNoCopy && <Badge tone="warning">No push copy</Badge>}
                          {!r.critical && !r.requireInteraction && !r.neverPush && !pushNoCopy && (!r.urgency || r.urgency === "normal") && <span className="text-secondary-light">—</span>}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

// ------------------------------------------------------------------------------------------------ page
export default function Notifications() {
  const { can } = useAuth();
  const canEdit = can("notifications", "edit");
  return (
    <>
      <PageHeader
        title="Notifications"
        subtitle="Push health, delivery log, test sends and event coverage."
        crumbs={[{ label: "System" }, { label: "Notifications" }]}
        actions={
          <Link to="/notification-matrix" className="btn btn-outline-primary-600 btn-sm px-16 py-8 radius-8 d-inline-flex align-items-center gap-2">
            <Icon icon="solar:bell-bing-outline" className="text-lg" /> Notification Matrix
          </Link>
        }
      />
      <Tabs
        tabs={[
          { key: "health", label: "Push health", content: <Health canEdit={canEdit} /> },
          { key: "log", label: "Delivery log", content: <DeliveryLog canEdit={canEdit} /> },
          { key: "test", label: "Send a test", hidden: !canEdit, content: <SendTest /> },
          { key: "coverage", label: "Coverage", content: <Coverage /> },
        ]}
      />
    </>
  );
}
