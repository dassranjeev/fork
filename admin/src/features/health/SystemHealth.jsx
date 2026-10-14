import React, { useState } from "react";
import { Icon } from "@iconify/react/offline";
import { Badge, Button, Card, ErrorState, Loading, PageHeader, StatCard } from "../../ui";
import { useHealth } from "./useHealth";
import { LEVEL_ICON, LEVEL_TONE, levelOf, msText, pctText } from "./format";
import { ChartsSection, ChecksCard, DatabaseCard, HostsCard, InstancesCard, LevelBadge, LoadBalancingCard, RoutesCard } from "./sections";

const BANNER = {
  ok: { title: "All systems healthy", bg: "bg-success-100 text-success-600", border: "border-success-main" },
  warn: { title: "needs attention", bg: "bg-warning-100 text-warning-600", border: "border-warning-main" },
  crit: { title: "critical", bg: "bg-danger-100 text-danger-600", border: "border-danger-main" },
};

function StatusBanner({ snap }) {
  const crit = snap.issues.filter((i) => i.level === "crit");
  const warn = snap.issues.filter((i) => i.level === "warn");
  const [all, setAll] = useState(false);
  const b = BANNER[snap.status] || BANNER.ok;
  const title = snap.status === "ok" ? b.title : snap.status === "crit" ? `${crit.length} critical problem${crit.length === 1 ? "" : "s"}${warn.length ? ` and ${warn.length} warning${warn.length === 1 ? "" : "s"}` : ""}` : `${warn.length} warning${warn.length === 1 ? " needs" : "s need"} attention`;
  const shown = all ? snap.issues : snap.issues.slice(0, 5);
  return (
    <div className={`card radius-12 border shadow-sm mb-24 ${b.border}`} role="status" aria-live="polite">
      <div className="card-body p-20">
        <div className="d-flex flex-wrap align-items-center gap-3">
          <div className={`w-56-px h-56-px rounded-circle d-flex justify-content-center align-items-center ${b.bg}`}>
            <Icon icon={snap.status === "ok" ? "solar:pulse-2-outline" : LEVEL_ICON[snap.status]} className="text-3xl mb-0" />
          </div>
          <div className="flex-grow-1">
            <h5 className="mb-4" data-testid="health-title">
              {title}
            </h5>
            <p className="mb-0 text-secondary-light">
              {snap.totals.instancesUp} of {snap.totals.instancesTotal} API instance{snap.totals.instancesTotal === 1 ? "" : "s"} up · updated {new Date(snap.at).toLocaleTimeString()}
            </p>
          </div>
        </div>
        {snap.issues.length > 0 && (
          <ul className="list-unstyled mt-16 mb-0" data-testid="health-issues">
            {shown.map((i, k) => (
              <li key={`${i.area}-${k}`} className="d-flex gap-12 mb-8">
                <Icon icon={LEVEL_ICON[i.level]} className={`text-xl flex-shrink-0 ${i.level === "crit" ? "text-danger-main" : "text-warning-main"}`} />
                <span>
                  <span className="text-secondary-light text-uppercase text-xs fw-semibold d-inline-block me-2" style={{ minWidth: 84 }}>{i.area}</span>
                  {i.message}
                </span>
              </li>
            ))}
            {snap.issues.length > 5 && (
              <li>
                <button type="button" className="btn btn-link text-primary-600 p-0 text-sm" onClick={() => setAll((v) => !v)}>
                  {all ? "Show fewer" : `Show all ${snap.issues.length}`}
                </button>
              </li>
            )}
          </ul>
        )}
      </div>
    </div>
  );
}

function Kpis({ snap }) {
  const t = snap.thresholds || {};
  const tot = snap.totals;
  const judged = tot.requests60 >= (t.minRequestsForRates ?? 20);
  const p95L = judged ? levelOf(tot.p95, t.p95WarnMs, t.p95CritMs) : "ok";
  const errL = judged ? levelOf(tot.errorRatePct, t.errWarnPct, t.errCritPct) : "ok";
  const instL = tot.instancesUp === 0 ? "crit" : tot.instancesUp < tot.instancesTotal ? "warn" : "ok";
  const dbL = snap.db ? levelOf(snap.db.connections.usedPct, t.dbConnWarnPct, t.dbConnCritPct) : "crit";
  const tone = (l) => LEVEL_TONE[l] || "primary";
  return (
    <div className="row gy-4 mb-24">
      <div className="col-xl-4 col-md-6">
        <StatCard label="API instances up" value={`${tot.instancesUp} / ${tot.instancesTotal}`} icon="solar:server-square-outline" tone={tone(instL)} hint={snap.balance?.state === "single" ? "no load balancer in front" : snap.balance?.state} />
      </div>
      <div className="col-xl-4 col-md-6">
        <StatCard label="Requests / second" value={tot.rps.toFixed(1)} icon="solar:transfer-horizontal-outline" tone="info" hint={`${tot.requests60} in the last minute · ${tot.inFlight} running now`} />
      </div>
      <div className="col-xl-4 col-md-6">
        <StatCard label="Response time (p95)" value={tot.requests60 ? msText(tot.p95) : "—"} icon="solar:clock-circle-outline" tone={tone(p95L)} hint={tot.requests60 ? `p50 ${msText(tot.p50)} · p99 ${msText(tot.p99)}` : "no traffic yet"} />
      </div>
      <div className="col-xl-4 col-md-6">
        <StatCard label="Server errors (5xx)" value={tot.requests60 ? pctText(tot.errorRatePct, 2) : "—"} icon="solar:danger-triangle-outline" tone={tone(errL)} hint={`client errors (4xx) ${pctText(tot.clientErrorRatePct, 1)}`} />
      </div>
      <div className="col-xl-4 col-md-6">
        <StatCard label="Live connections" value={tot.sockets} icon="solar:global-outline" tone="primary" hint="realtime websockets (apps, consoles)" />
      </div>
      <div className="col-xl-4 col-md-6">
        <StatCard label="Database connections" value={snap.db ? `${snap.db.connections.total} / ${snap.db.connections.max}` : "down"} icon="solar:database-outline" tone={tone(dbL)} hint={snap.db ? `round trip ${msText(snap.db.pingMs)} · pool ${tot.dbPoolUsed}/${tot.dbPoolMax || "?"}` : "not reachable"} />
      </div>
    </div>
  );
}

export default function SystemHealth() {
  const { snap, error, live, loading, paused, setPaused, reload } = useHealth();
  const [rechecking, setRechecking] = useState(false);
  const crumbs = [{ label: "System" }, { label: "System Health" }];

  const recheck = async () => {
    setRechecking(true);
    try {
      await reload({ manual: true, recheck: true });
    } finally {
      setRechecking(false);
    }
  };

  const liveBadge = paused ? <Badge tone="neutral">Paused</Badge> : live ? <Badge tone="success">● Live (every 2 s)</Badge> : <Badge tone="warning">Polling every 5 s</Badge>;

  if (loading && !snap) {
    return (
      <>
        <PageHeader title="System Health" subtitle="Server health, CPU, memory and load balancing" crumbs={crumbs} />
        <Loading />
      </>
    );
  }
  if (!snap) {
    return (
      <>
        <PageHeader title="System Health" crumbs={crumbs} />
        <ErrorState error={error || "No data"} onRetry={() => reload({ manual: true })} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="System Health"
        subtitle="Server health, CPU, memory and load balancing across every API instance. Super Admin only."
        crumbs={crumbs}
        actions={
          <>
            {liveBadge}
            <Button variant="outline" icon={paused ? "solar:play-outline" : "solar:pause-outline"} onClick={() => setPaused((p) => !p)}>
              {paused ? "Resume" : "Pause"}
            </Button>
            <Button variant="outline" icon="solar:refresh-outline" onClick={() => reload({ manual: true })}>
              Refresh
            </Button>
          </>
        }
      />
      {error && (
        <div className="alert alert-warning radius-8 mb-24" role="alert">
          Could not refresh: {error}. Showing the last data received.
        </div>
      )}
      <StatusBanner snap={snap} />
      <Kpis snap={snap} />
      <HostsCard snap={snap} />
      <ChartsSection snap={snap} />
      <div className="mb-24">
        <InstancesCard snap={snap} onChanged={() => reload({ manual: true })} />
      </div>
      <LoadBalancingCard snap={snap} />
      <div className="row gy-4 mb-24">
        <div className="col-xl-5">
          <DatabaseCard snap={snap} />
        </div>
        <div className="col-xl-7">
          <ChecksCard snap={snap} onRecheck={recheck} busy={rechecking} />
        </div>
      </div>
      <div className="mb-24">
        <RoutesCard snap={snap} />
      </div>
      <Card className="mb-24" bodyClassName="p-16">
        <p className="mb-0 text-secondary-light text-sm d-flex align-items-start gap-2">
          <Icon icon="solar:info-circle-outline" className="text-lg flex-shrink-0 mt-1" />
          <span>
            The amber and red limits come from Platform Settings, group <strong>system</strong> (CPU, memory, disk, response time, error rate, balance skew ...). Numbers are measured from inside the API process and from the server it runs on; they are kept in memory and in one small table
            in the database, and nothing here contains personal data. <LevelBadge level="ok" /> green, <LevelBadge level="warn" /> amber, <LevelBadge level="crit" /> red.
          </span>
        </p>
      </Card>
    </>
  );
}
