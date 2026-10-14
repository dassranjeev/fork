import React, { useState } from "react";
import { Icon } from "@iconify/react/offline";
import { toast } from "react-toastify";
import { Badge, Button, Card, DonutChart, EmptyState, Gauge, KeyValue, LineChart, Progress, useConfirm } from "../../ui";
import { errorMessage, http } from "../../lib/api";
import { LEVEL_HEX, LEVEL_ICON, LEVEL_LABEL, LEVEL_TONE, durationText, levelOf, mbText, msText, padLeft, pctText, verdictFor } from "./format";

const TEXT = { ok: "", warn: "text-warning-main", crit: "text-danger-main" };

export const LevelBadge = ({ level }) => <Badge tone={LEVEL_TONE[level] || "neutral"}>{LEVEL_LABEL[level] || level}</Badge>;

function InstanceStatus({ inst }) {
  if (inst.draining) return <Badge tone="warning">Draining</Badge>;
  if (inst.status === "up") return <Badge tone="success">Up</Badge>;
  if (inst.status === "stale") return <Badge tone="warning">Slow to report</Badge>;
  return <Badge tone="danger">{inst.replaced ? "Stopped (restarted)" : "Down"}</Badge>;
}

// ---------------------------------------------------------------------------------------------------------------- instances
export function InstancesCard({ snap, onChanged }) {
  const confirm = useConfirm();
  const [busy, setBusy] = useState("");
  const t = snap.thresholds || {};
  const live = snap.instances.filter((i) => i.status !== "down");
  const canDrain = live.filter((i) => !i.draining).length > 1;

  const act = async (inst, drain) => {
    const { confirmed } = await confirm(
      drain
        ? {
            title: `Drain ${inst.id}?`,
            message: "It will answer 503 on /api/v1/ready and refuse new realtime connections, so a load balancer that health-checks that URL stops sending it new requests. Requests already running finish normally. Draining only changes routing if your proxy checks /api/v1/ready (see docs/system-health.md).",
            confirmText: "Drain instance",
            danger: true,
          }
        : { title: `Resume ${inst.id}?`, message: "It will accept new traffic again.", confirmText: "Resume" },
    );
    if (!confirmed) return;
    setBusy(inst.id);
    try {
      await http.post(`/admin/system/instances/${encodeURIComponent(inst.id)}/${drain ? "drain" : "resume"}`);
      toast.success(drain ? "Draining: new traffic will stop within a few seconds" : "Resumed");
      onChanged?.();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy("");
    }
  };

  return (
    <Card title="API instances" subtitle="Every running API process reports here every 2 seconds" noPadding>
      <div className="table-responsive">
        <table className="table bordered-table mb-0 align-middle text-sm">
          <thead>
            <tr>
              <th>Instance</th>
              <th>Status</th>
              <th className="text-end">Req/s</th>
              <th style={{ minWidth: 130 }}>Traffic share</th>
              <th className="text-end">p95</th>
              <th className="text-end">5xx</th>
              <th className="text-end">CPU</th>
              <th className="text-end">Memory</th>
              <th className="text-end">Loop lag</th>
              <th className="text-end">Sockets</th>
              <th className="text-end">DB pool</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {snap.instances.map((i) => {
              const m = i.metrics || {};
              const rq = m.requests?.window60 || {};
              const judged = (rq.count || 0) >= (t.minRequestsForRates ?? 20);
              const p95L = judged ? levelOf(rq.p95, t.p95WarnMs, t.p95CritMs) : "ok";
              const errPct = rq.count ? (rq.errors5xx / rq.count) * 100 : 0;
              const errL = judged ? levelOf(errPct, t.errWarnPct, t.errCritPct) : "ok";
              const lagL = levelOf(m.process?.eventLoop?.p99, t.loopLagWarnMs, t.loopLagCritMs);
              const used = (m.db?.poolTotal || 0) - (m.db?.poolIdle || 0);
              const poolL = m.db?.poolMax ? levelOf((used / m.db.poolMax) * 100, t.dbPoolWarnPct, t.dbPoolCritPct) : "ok";
              const gone = i.status === "down";
              return (
                <tr key={i.id} className={gone ? "opacity-75" : ""}>
                  <td>
                    <div className="fw-semibold">
                      {i.id} {i.self && <Badge tone="info">You are connected here</Badge>}
                    </div>
                    <div className="text-secondary-light text-xs">host {i.hostname} · pid {i.pid}</div>
                    <div className="text-secondary-light text-xs">v{i.version} · node {i.nodeVersion}</div>
                  </td>
                  <td>
                    <InstanceStatus inst={i} />
                    <div className="text-secondary-light text-xs">{gone ? `last seen ${durationText(i.ageSec)} ago` : `up ${durationText(i.uptimeSec)}`}</div>
                  </td>
                  <td className="text-end">{gone ? "—" : (m.requests?.rps ?? 0).toFixed(1)}</td>
                  <td>{gone ? "—" : <Progress value={i.share || 0} tone={i.draining ? "warning" : "primary"} height={8} label={`${(i.share || 0).toFixed(0)}%`} />}</td>
                  <td className={`text-end ${TEXT[p95L]}`}>{gone ? "—" : msText(rq.p95)}</td>
                  <td className={`text-end ${TEXT[errL]}`}>{gone ? "—" : pctText(errPct, 1)}</td>
                  <td className="text-end">{gone ? "—" : pctText(m.process?.cpuPct, 0)}</td>
                  <td className="text-end">{gone ? "—" : mbText(m.process?.rssMb)}</td>
                  <td className={`text-end ${TEXT[lagL]}`}>{gone ? "—" : msText(m.process?.eventLoop?.p99)}</td>
                  <td className="text-end">{gone ? "—" : m.sockets?.total ?? 0}</td>
                  <td className={`text-end ${TEXT[poolL]}`}>{gone || !m.db ? "—" : `${used}/${m.db.poolMax ?? "?"}`}</td>
                  <td className="text-end">
                    {!gone && i.draining && (
                      <Button variant="light" loading={busy === i.id} onClick={() => act(i, false)}>
                        Resume
                      </Button>
                    )}
                    {!gone && !i.draining && (
                      <Button variant="outline-danger" disabled={!canDrain} loading={busy === i.id} onClick={() => act(i, true)} title={canDrain ? "Stop sending new traffic to this instance" : "The last instance that accepts traffic cannot be drained"}>
                        Drain
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
            {!snap.instances.length && (
              <tr>
                <td colSpan={12}>
                  <EmptyState title="No instance has reported yet" text="The API writes a heartbeat every 2 seconds once it is running and its database is migrated." />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------------------------- server resources
export function HostsCard({ snap }) {
  const hosts = snap.hosts || [];
  if (!hosts.length) return null;
  return (
    <>
      {hosts.map((h) => {
        const disk = Math.max(h.diskRoot?.usedPct ?? 0, h.diskUploads?.usedPct ?? 0);
        const name = snap.instances.find((i) => h.instances?.includes(i.id))?.hostname || h.key;
        const gauges = [
          { label: "CPU", value: h.cpuPct, level: h.levels.cpu, icon: "solar:cpu-outline" },
          { label: "Memory", value: h.memUsedPct, level: h.levels.memory },
          ...(h.swapTotalMb ? [{ label: "Swap", value: h.swapUsedPct, level: h.levels.swap }] : []),
          { label: "Disk", value: disk, level: h.levels.disk },
          ...(h.loadSupported ? [{ label: "Load", value: Math.min(100, (h.loadPerCore || 0) * 100), level: h.levels.load }] : []),
        ];
        return (
          <Card key={h.key} title={`Server resources · ${name}`} subtitle={`${h.cpus} CPU core${h.cpus === 1 ? "" : "s"} · ${mbText(h.memTotalMb)} RAM · up ${durationText(h.uptimeSec)}${h.instances?.length > 1 ? ` · ${h.instances.length} API instances share this server` : ""}`} className="mb-24">
            <div className="row gy-2 justify-content-center">
              {gauges.map((g) => (
                <div key={g.label} className="col-6 col-md-4 col-xl">
                  <Gauge value={g.value || 0} label={g.label} height={170} color={LEVEL_HEX[g.level]} />
                  <div className="text-center">
                    <LevelBadge level={g.level} />
                  </div>
                </div>
              ))}
            </div>
            <hr />
            <KeyValue
              cols={3}
              items={[
                { label: "CPU use", value: `${pctText(h.cpuPct)}${h.stealPct ? ` · steal ${pctText(h.stealPct)}` : ""}${h.iowaitPct ? ` · disk wait ${pctText(h.iowaitPct)}` : ""}` },
                { label: "Memory", value: `${mbText(h.memTotalMb - h.memAvailableMb)} used · ${mbText(h.memAvailableMb)} available of ${mbText(h.memTotalMb)}` },
                { label: "Swap", value: h.swapTotalMb ? `${mbText(h.swapUsedMb)} of ${mbText(h.swapTotalMb)} (${pctText(h.swapUsedPct, 0)})` : "none" },
                { label: "Load average (1 / 5 / 15 min)", value: h.loadSupported ? `${h.load1} / ${h.load5} / ${h.load15} (${h.loadPerCore} per core)` : "not available on this system" },
                { label: "Disk (system)", value: h.diskRoot ? `${h.diskRoot.freeGb} GB free of ${h.diskRoot.totalGb} GB (${pctText(h.diskRoot.usedPct, 0)} used)` : "—" },
                { label: "Uploads folder", value: h.diskUploads ? `${h.diskUploads.writable ? "writable" : "NOT writable"} · ${h.diskUploads.freeGb} GB free` : "—" },
                h.container && { label: "Container limits", value: `${h.container.memLimitMb ? `memory ${mbText(h.container.memUsedMb)} of ${mbText(h.container.memLimitMb)}` : "no memory limit"}${h.container.cpuLimit ? ` · ${h.container.cpuLimit} CPU` : ""}` },
              ]}
            />
          </Card>
        );
      })}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------- charts
export function ChartsSection({ snap }) {
  const per = snap.series?.perInstance || {};
  const ids = Object.keys(per);
  const hostSeries = Object.values(snap.series?.hosts || {})[0] || { cpu: [], mem: [] };
  const n = Math.max(0, ...ids.map((id) => (per[id].rps || []).length), (hostSeries.cpu || []).length);
  if (!n) return null;
  const step = (snap.series?.step || 5) * 1000;
  const end = Date.parse(snap.at) || Date.now();
  const xs = Array.from({ length: n }, (_, k) => end - (n - 1 - k) * step);
  const pts = (arr) => padLeft(arr, n).map((y, k) => ({ x: xs[k], y }));
  const nameOf = (id) => (snap.instances.find((i) => i.id === id)?.self ? `${id} (this one)` : id);
  const series = (key) => ids.map((id) => ({ name: nameOf(id), data: pts(per[id][key]) }));
  const charts = [
    { title: "Requests per second", sub: "per API instance", node: <LineChart series={series("rps")} time yMinWidth={40} height={220} stacked yFormatter={(v) => Number(v).toFixed(1)} /> },
    { title: "Response time, p95 (ms)", sub: "95% of requests are faster than this", node: <LineChart series={series("p95")} time yMinWidth={40} height={220} area={false} yFormatter={(v) => Math.round(v)} /> },
    {
      title: "Server CPU and memory (%)",
      sub: "whole server, not just the API",
      node: (
        <LineChart
          series={[
            { name: "CPU %", data: pts(hostSeries.cpu) },
            { name: "Memory used %", data: pts(hostSeries.mem) },
          ]}
          time
          yMinWidth={40}
          height={220}
          area={false}
          yFormatter={(v) => Math.round(v)}
        />
      ),
    },
    { title: "API memory (MB)", sub: "resident memory (RSS) per instance", node: <LineChart series={series("rss")} time yMinWidth={40} height={220} area={false} yFormatter={(v) => Math.round(v)} /> },
    { title: "Event-loop delay, p99 (ms)", sub: "how long the API was blocked; high = CPU-bound or stuck code", node: <LineChart series={series("lag")} time yMinWidth={40} height={220} area={false} yFormatter={(v) => Math.round(v)} /> },
    { title: "Server errors, 5xx (%)", sub: "% of requests that failed", node: <LineChart series={series("err")} time yMinWidth={40} height={220} area={false} yFormatter={(v) => Number(v).toFixed(1)} /> },
  ];
  return (
    <div className="row gy-4 mb-24">
      {charts.map((c) => (
        <div key={c.title} className="col-xl-6">
          <Card title={c.title} subtitle={`${c.sub} · last ${Math.round((n * (snap.series?.step || 5)) / 60)} min`}>
            {c.node}
          </Card>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------- load balancing
function BalanceTest({ snap }) {
  const [state, setState] = useState(null); // { running, done, total, counts }
  const N = 60;
  const run = async () => {
    const counts = {};
    let sent = 0;
    let done = 0;
    setState({ running: true, done: 0, total: N, counts: {} });
    const worker = async () => {
      while (sent < N) {
        sent++;
        try {
          const r = await http.get("/admin/system/whoami");
          counts[r.instanceId] = (counts[r.instanceId] || 0) + 1;
        } catch {
          counts["(failed)"] = (counts["(failed)"] || 0) + 1;
        }
        done++;
        if (done % 6 === 0) setState({ running: true, done, total: N, counts: { ...counts } });
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    setState({ running: false, done: N, total: N, counts: { ...counts } });
  };
  const counts = state?.counts || {};
  const answered = Object.fromEntries(Object.entries(counts).filter(([k]) => k !== "(failed)"));
  const total = Object.values(answered).reduce((a, b) => a + b, 0);
  const ids = Object.keys(answered).sort();
  const known = snap.instances.filter((i) => i.status !== "down" && !i.draining);
  const verdict = state && !state.running ? verdictFor(answered, snap.thresholds) : null;
  return (
    <div>
      <div className="d-flex flex-wrap align-items-center gap-2 mb-12">
        <Button variant="primary" icon="solar:transfer-horizontal-outline" loading={state?.running} onClick={run}>
          Test the balancer ({N} requests)
        </Button>
        <span className="text-secondary-light text-sm">Sends requests through the real route (proxy included) and counts which instance answers each one.</span>
      </div>
      {state && (
        <>
          {state.running && <Progress value={state.done} max={state.total} height={6} label={`${state.done} / ${state.total}`} />}
          {!!ids.length && (
            <div className="table-responsive mt-12">
              <table className="table bordered-table mb-0 text-sm align-middle">
                <thead>
                  <tr>
                    <th>Instance</th>
                    <th className="text-end">Answered</th>
                    <th style={{ minWidth: 160 }}>Share</th>
                    <th className="text-end">Even split</th>
                  </tr>
                </thead>
                <tbody>
                  {ids.map((id) => (
                    <tr key={id}>
                      <td>{id}</td>
                      <td className="text-end">{answered[id]}</td>
                      <td>
                        <Progress value={(answered[id] / Math.max(1, total)) * 100} height={8} label={`${((answered[id] / Math.max(1, total)) * 100).toFixed(0)}%`} />
                      </td>
                      <td className="text-end">{(100 / Math.max(1, known.length || ids.length)).toFixed(0)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {counts["(failed)"] > 0 && <p className="text-danger-main text-sm mt-8 mb-0">{counts["(failed)"]} request(s) failed.</p>}
          {verdict && (
            <p className={`mt-12 mb-0 text-sm ${TEXT[verdict.level]}`}>
              <Icon icon={LEVEL_ICON[verdict.level]} className="text-lg me-1" />
              {verdict.text}
            </p>
          )}
          {verdict && <p className="text-secondary-light text-xs mt-4 mb-0">If the proxy uses sticky sessions (ip_hash or a cookie), one browser always reaches the same instance, so this test cannot show a spread.</p>}
        </>
      )}
    </div>
  );
}

export function LoadBalancingCard({ snap }) {
  const b = snap.balance || {};
  const rd = snap.readiness || { blockers: [] };
  const shares = (b.shares || []).filter((s) => !snap.instances.find((i) => i.id === s.id)?.replaced);
  const hasTraffic = shares.some((s) => s.pct > 0);
  return (
    <Card title="Load balancing" subtitle="How requests are spread over the API instances, and what must hold before you run more than one" className="mb-24">
      <div className={`d-flex flex-wrap align-items-center gap-2 mb-16 ${TEXT[b.level]}`}>
        <LevelBadge level={b.level || "ok"} />
        <span className="fw-medium">{b.message}</span>
      </div>
      <div className="row gy-4">
        <div className="col-lg-4">
          <h6 className="text-md fw-semibold mb-8">Traffic share, last minute</h6>
          {hasTraffic ? (
            <DonutChart labels={shares.map((s) => s.id)} values={shares.map((s) => s.pct)} height={230} total={false} formatter={(v) => `${v.toFixed(0)}%`} />
          ) : (
            <EmptyState title="No traffic in the last minute" text="Shares appear as soon as the API serves requests." />
          )}
        </div>
        <div className="col-lg-8">
          <h6 className="text-md fw-semibold mb-8">Live balance test</h6>
          <BalanceTest snap={snap} />
        </div>
      </div>
      <hr />
      <h6 className="text-md fw-semibold mb-4">{rd.multiInstance ? "Multi-instance readiness" : "Before you run a second API instance"}</h6>
      <p className="text-secondary-light text-sm mb-12">
        {rd.multiInstance ? "More than one instance is running. Anything marked below is a live problem." : "One instance serves everything today. These parts of the app are per-process and must be made shared first; they are not problems while there is a single instance."}
      </p>
      <ul className="list-unstyled mb-0">
        {rd.blockers.map((x) => {
          const lvl = x.ok ? "ok" : rd.multiInstance ? "crit" : "warn";
          return (
            <li key={x.key} className="d-flex gap-12 mb-12">
              <Icon icon={x.ok ? "solar:check-circle-outline" : LEVEL_ICON[lvl]} className={`text-xl flex-shrink-0 ${x.ok ? "text-success-main" : TEXT[lvl]}`} />
              <div>
                <div className="fw-medium">{x.label}</div>
                <div className="text-secondary-light text-sm">{x.detail}</div>
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------------------------- database
export function DatabaseCard({ snap }) {
  const d = snap.db;
  const t = snap.thresholds || {};
  if (!d) {
    return (
      <Card title="Database" className="h-100">
        <p className="text-danger-main mb-0">The database is not reachable.</p>
      </Card>
    );
  }
  const connL = levelOf(d.connections.usedPct, t.dbConnWarnPct, t.dbConnCritPct);
  return (
    <Card title="Database" subtitle={`PostgreSQL ${d.version}`} className="h-100">
      <Progress value={d.connections.total} max={d.connections.max} tone={connL === "ok" ? "success" : connL === "warn" ? "warning" : "danger"} label={`Connections ${d.connections.total} of ${d.connections.max}`} />
      <div className="mt-16">
        <KeyValue
          items={[
            { label: "Round trip", value: msText(d.pingMs) },
            { label: "Active / idle", value: `${d.connections.active} / ${d.connections.idle}` },
            { label: "Idle in transaction", value: d.connections.idleInTransaction },
            { label: "Longest running query", value: d.longestQuerySec ? `${d.longestQuerySec} s` : "none running" },
            { label: "Lock requests waiting", value: d.locksWaiting },
            { label: "Cache hit ratio", value: d.cacheHitPct === null ? "—" : pctText(d.cacheHitPct) },
            { label: "Database size", value: mbText(d.sizeMb) },
            { label: "Deadlocks (since stats reset)", value: d.deadlocks },
          ]}
        />
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------------------------- checks
export function ChecksCard({ snap, onRecheck, busy }) {
  return (
    <Card
      title="Dependencies and configuration"
      subtitle="Database, migrations, storage, payments, certificates, proxy settings"
      className="h-100"
      actions={
        <Button variant="light" icon="solar:refresh-outline" loading={busy} onClick={onRecheck}>
          Re-run checks
        </Button>
      }
    >
      <ul className="list-unstyled mb-0">
        {(snap.checks || []).map((c) => (
          <li key={c.key} className="d-flex gap-12 mb-12">
            {c.off ? <Icon icon="solar:info-circle-outline" className="text-xl flex-shrink-0 text-secondary-light" /> : <Icon icon={LEVEL_ICON[c.level]} className={`text-xl flex-shrink-0 ${c.level === "ok" ? "text-success-main" : TEXT[c.level]}`} />}
            <div>
              <div className="fw-medium">{c.label}</div>
              <div className={`text-sm ${c.level === "ok" ? "text-secondary-light" : TEXT[c.level]}`}>{c.detail}</div>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------------------------- routes
export function RoutesCard({ snap }) {
  const [sort, setSort] = useState("count");
  const rows = [...(snap.routes || [])].sort((a, b) => (sort === "p95Ms" ? b.p95Ms - a.p95Ms : sort === "errors" ? b.errors5xx + b.errors4xx - (a.errors5xx + a.errors4xx) : b.count - a.count)).slice(0, 15);
  const t = snap.thresholds || {};
  return (
    <Card
      title="Busiest routes"
      subtitle="Last 5 minutes, all instances. Route patterns only: no ids, query strings or personal data"
      actions={
        <div className="btn-group btn-group-sm" role="group" aria-label="Sort routes">
          {[
            ["count", "Most requested"],
            ["p95Ms", "Slowest"],
            ["errors", "Most errors"],
          ].map(([k, label]) => (
            <button key={k} type="button" className={`btn ${sort === k ? "btn-primary-600" : "btn-outline-neutral-300 text-primary-light"}`} onClick={() => setSort(k)}>
              {label}
            </button>
          ))}
        </div>
      }
      noPadding
    >
      <div className="table-responsive">
        <table className="table bordered-table mb-0 align-middle text-sm">
          <thead>
            <tr>
              <th>Route</th>
              <th className="text-end">Requests</th>
              <th className="text-end">Average</th>
              <th className="text-end">p95 (worst instance)</th>
              <th className="text-end">5xx</th>
              <th className="text-end">4xx</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.route}>
                <td className="text-break">
                  <code>{r.route}</code>
                </td>
                <td className="text-end">{r.count}</td>
                <td className="text-end">{msText(r.avgMs)}</td>
                <td className={`text-end ${TEXT[levelOf(r.p95Ms, t.p95WarnMs, t.p95CritMs)]}`}>{msText(r.p95Ms)}</td>
                <td className={`text-end ${r.errors5xx ? "text-danger-main" : ""}`}>{r.errors5xx}</td>
                <td className="text-end">{r.errors4xx}</td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={6}>
                  <EmptyState title="No requests recorded yet" />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
