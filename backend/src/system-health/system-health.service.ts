import { BadRequestException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import * as tls from 'tls';
import { SettingsService } from '../settings/settings.service';
import { IntegrationsService } from '../integrations/integrations.service';
import { clientIp, trustProxySetting } from '../common/security';
import { drainState } from '../common/drain-state';
import {
  balanceVerdict,
  BalanceResult,
  DEFAULT_THRESHOLDS,
  Hist,
  histPercentile,
  InstanceStatus,
  instanceStatus,
  Level,
  levelHigh,
  mergeHist,
  round,
  Thresholds,
  worstLevel,
} from './metrics.util';
import { SystemMetricsService } from './system-metrics.service';

export interface Issue {
  level: Level;
  area: 'instances' | 'cpu' | 'memory' | 'disk' | 'load' | 'latency' | 'errors' | 'database' | 'balance' | 'realtime' | 'checks' | 'readiness';
  message: string;
  target?: string;
}

export interface Check {
  key: string;
  label: string;
  level: Level;
  detail: string;
  /** optional integration that is simply not configured (shown grey, not green) */
  off?: boolean;
}

export interface DbStats {
  pingMs: number;
  connections: { total: number; active: number; idle: number; idleInTransaction: number; max: number; usedPct: number };
  sizeMb: number;
  longestQuerySec: number;
  locksWaiting: number;
  cacheHitPct: number | null;
  deadlocks: number;
  version: string;
  clockSkewMs: number;
}

/**
 * Builds the System Health view from the heartbeat rows of every instance plus a few cached database / dependency probes.
 * Super Admin only (see SystemHealthController); never returns secrets, environment values or raw URLs.
 */
@Injectable()
export class SystemHealthService {
  private readonly logger = new Logger('SystemHealth');
  private dbCache: { at: number; value: DbStats | null } = { at: 0, value: null };
  private checkCache: { at: number; value: Check[] } = { at: 0, value: [] };
  private tlsCache: { at: number; value: Check | null } = { at: 0, value: null };

  constructor(
    @InjectDataSource() private ds: DataSource,
    private metrics: SystemMetricsService,
    private settings: SettingsService,
    private config: ConfigService,
    @Optional() private integrations?: IntegrationsService,
  ) {}

  /** Defaults overridden by the numeric settings `system.health.<name>` (Platform Settings > system). */
  thresholds(): Thresholds {
    const t: Thresholds = { ...DEFAULT_THRESHOLDS };
    for (const k of Object.keys(t) as (keyof Thresholds)[]) {
      const v = this.settings.get<number | undefined>(`system.health.${k}`, undefined);
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) t[k] = v;
    }
    return t;
  }

  // ------------------------------------------------------------------ small endpoints
  whoami() {
    return {
      instanceId: this.metrics.instanceId,
      hostname: this.metrics.hostname,
      startedAt: new Date(this.metrics.startedAt).toISOString(),
      uptimeSec: Math.round(process.uptime()),
      draining: drainState.active,
      servedAt: new Date().toISOString(),
    };
  }

  async setDrain(id: string, on: boolean) {
    const t = this.thresholds();
    const rows: { id: string; drainRequested: boolean; ageSec: number }[] = await this.ds.query(
      `SELECT id, "drainRequested", EXTRACT(EPOCH FROM (now() - "lastSeenAt"))::float AS "ageSec" FROM system_instances`,
    );
    const target = rows.find((r) => r.id === id);
    if (!target) throw new NotFoundException('Unknown instance');
    if (on) {
      if (target.ageSec >= t.heartbeatDownSec) throw new BadRequestException('This instance is not running');
      const others = rows.filter((r) => r.id !== id && !r.drainRequested && r.ageSec < t.heartbeatStaleSec);
      if (!others.length) throw new BadRequestException('Refused: this is the last instance that accepts traffic. Draining it would take the site offline.');
    }
    await this.ds.query(`UPDATE system_instances SET "drainRequested" = $2 WHERE id = $1`, [id, on]);
    return { id, draining: on };
  }

  // ------------------------------------------------------------------ database
  async dbStats(force = false): Promise<DbStats | null> {
    if (!force && Date.now() - this.dbCache.at < 10_000) return this.dbCache.value;
    try {
      const t0 = process.hrtime.bigint();
      await this.ds.query('SELECT 1');
      const pingMs = round(Number(process.hrtime.bigint() - t0) / 1e6, 1);
      const [r] = await this.ds.query(`
        SELECT
          (SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database()) AS total,
          (SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database() AND state = 'active' AND pid <> pg_backend_pid()) AS active,
          (SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle') AS idle,
          (SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database() AND state LIKE 'idle in transaction%') AS "idleInTx",
          (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') AS "maxConnections",
          pg_database_size(current_database())::float8 AS "sizeBytes",
          (SELECT COALESCE(EXTRACT(EPOCH FROM (now() - min(query_start))), 0)::float8 FROM pg_stat_activity WHERE datname = current_database() AND state = 'active' AND pid <> pg_backend_pid()) AS "longestQuerySec",
          (SELECT count(*)::int FROM pg_locks WHERE NOT granted) AS "locksWaiting",
          (SELECT blks_hit::float8 / NULLIF(blks_hit + blks_read, 0) FROM pg_stat_database WHERE datname = current_database()) AS "cacheHit",
          (SELECT deadlocks::int FROM pg_stat_database WHERE datname = current_database()) AS deadlocks,
          split_part(version(), ' ', 2) AS version,
          (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::float8 AS "dbNowMs"`);
      const max = Number(r.maxConnections) || 100;
      const value: DbStats = {
        pingMs,
        connections: { total: Number(r.total), active: Number(r.active), idle: Number(r.idle), idleInTransaction: Number(r.idleInTx), max, usedPct: round((Number(r.total) / max) * 100, 1) },
        sizeMb: round(Number(r.sizeBytes) / 1048576, 1),
        longestQuerySec: round(Number(r.longestQuerySec), 1),
        locksWaiting: Number(r.locksWaiting),
        cacheHitPct: r.cacheHit === null ? null : round(Number(r.cacheHit) * 100, 1),
        deadlocks: Number(r.deadlocks) || 0,
        version: String(r.version ?? ''),
        clockSkewMs: Math.round(Date.now() - Number(r.dbNowMs)),
      };
      this.dbCache = { at: Date.now(), value };
      return value;
    } catch (e: any) {
      this.logger.warn(`database probe failed: ${e?.message}`);
      this.dbCache = { at: Date.now(), value: null };
      return null;
    }
  }

  // ------------------------------------------------------------------ dependency / configuration checks
  private async tlsCheck(t: Thresholds): Promise<Check | null> {
    const url = String(this.config.get('publicUrl') ?? '');
    if (!/^https:\/\//i.test(url)) return null;
    if (this.tlsCache.value && Date.now() - this.tlsCache.at < 6 * 3_600_000) return this.tlsCache.value;
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch {
      return null;
    }
    const check = await new Promise<Check>((resolve) => {
      const done = (c: Check) => resolve(c);
      const sock = tls.connect({ host, port: 443, servername: host, timeout: 4000 }, () => {
        const cert = sock.getPeerCertificate();
        sock.end();
        const end = cert?.valid_to ? new Date(cert.valid_to).getTime() : NaN;
        if (!Number.isFinite(end)) return done({ key: 'tls', label: 'TLS certificate', level: 'warn', detail: 'Could not read the certificate expiry' });
        const days = Math.floor((end - Date.now()) / 86_400_000);
        done({ key: 'tls', label: 'TLS certificate', level: days <= t.tlsCritDays ? 'crit' : days <= t.tlsWarnDays ? 'warn' : 'ok', detail: `${host}: expires in ${days} day${days === 1 ? '' : 's'}` });
      });
      // a certificate problem is a real alert; a network problem from inside the server (hairpin NAT, firewall) says nothing about the certificate
      const CERT_ERRORS = ['CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'];
      sock.on('error', (e: any) =>
        done(
          CERT_ERRORS.includes(String(e?.code))
            ? { key: 'tls', label: 'TLS certificate', level: 'crit', detail: `${host}: the certificate is not valid (${e.code}). Browsers will refuse the site.` }
            : { key: 'tls', label: 'TLS certificate', level: 'ok', off: true, detail: `${host}: could not be checked from inside the server (${e?.code || e?.message})` },
        ),
      );
      sock.on('timeout', () => {
        sock.destroy();
        done({ key: 'tls', label: 'TLS certificate', level: 'ok', off: true, detail: `${host}: check timed out (not judged)` });
      });
    });
    this.tlsCache = { at: Date.now(), value: check };
    return check;
  }

  private async checks(t: Thresholds, db: DbStats | null, uploads: { writable: boolean; freeGb: number } | null, force = false): Promise<Check[]> {
    if (!force && Date.now() - this.checkCache.at < 30_000) return this.checkCache.value;
    const out: Check[] = [];
    if (!db) out.push({ key: 'database', label: 'Database', level: 'crit', detail: 'Not reachable' });
    else out.push({ key: 'database', label: 'Database', level: levelHigh(db.pingMs, 100, 500), detail: `PostgreSQL ${db.version}, round trip ${db.pingMs} ms` });
    if (db) out.push({ key: 'clock', label: 'Clock drift (server vs database)', level: levelHigh(Math.abs(db.clockSkewMs), 2000, 10_000), detail: `${db.clockSkewMs} ms` });

    // migrations: loaded migration files vs rows in schema_migrations (development schemas come from DB_SYNC and have no table)
    try {
      const applied: { name: string }[] = await this.ds.query('SELECT name FROM schema_migrations');
      const pending = Math.max(0, this.ds.migrations.length - applied.length);
      out.push({ key: 'migrations', label: 'Database migrations', level: pending ? 'crit' : 'ok', detail: pending ? `${pending} pending: run node dist/database/migrate` : `${applied.length} applied, none pending` });
    } catch {
      out.push({ key: 'migrations', label: 'Database migrations', level: 'ok', detail: 'Schema is synchronised by DB_SYNC (development); no migration history', off: true });
    }

    if (uploads) {
      out.push({ key: 'uploads', label: 'Uploads folder', level: !uploads.writable ? 'crit' : uploads.freeGb < 1 ? 'crit' : uploads.freeGb < 5 ? 'warn' : 'ok', detail: `${uploads.writable ? 'writable' : 'NOT writable'}, ${uploads.freeGb} GB free` });
    }

    if (this.integrations) {
      try {
        const s = await this.integrations.status();
        const st = s.stripe;
        if (!st.configured) out.push({ key: 'stripe', label: 'Stripe payments', level: 'warn', detail: 'Not configured: customers cannot pay (System > Integrations)' });
        else out.push({ key: 'stripe', label: 'Stripe payments', level: st.mixedModes ? 'crit' : 'ok', detail: `${String(st.mode).toUpperCase()} mode${st.mixedModes ? ', secret and publishable keys are different modes' : ''}${st.warnings?.length && !st.mixedModes ? `, ${st.warnings.length} warning(s) on the Integrations page` : ''}` });
        out.push({ key: 'mapbox', label: 'Mapbox address search', level: 'ok', detail: s.mapbox.configured ? 'Configured' : 'Not configured (optional: the demo areas are used)', off: !s.mapbox.configured });
        out.push({ key: 'email', label: 'Email (SendGrid)', level: 'ok', detail: s.others.sendgrid.configured ? 'Configured' : 'Not configured (emails are not sent)', off: !s.others.sendgrid.configured });
        out.push({ key: 'sms', label: 'SMS (Twilio)', level: 'ok', detail: s.others.twilio.configured ? 'Configured' : 'Not configured (SMS is not sent)', off: !s.others.twilio.configured });
      } catch (e: any) {
        out.push({ key: 'integrations', label: 'Integrations', level: 'warn', detail: `Could not read the integration status (${e?.message})` });
      }
    }

    const tlsC = await this.tlsCheck(t);
    if (tlsC) out.push(tlsC);
    this.checkCache = { at: Date.now(), value: out };
    return out;
  }

  /** Request-specific: does the proxy chain match TRUST_PROXY? Wrong settings make every client look like the proxy (rate limits, audit log). */
  private proxyCheck(req: any): Check | null {
    if (!req) return null;
    const trust = trustProxySetting();
    const xff = String(req.headers?.['x-forwarded-for'] ?? '');
    const seen = clientIp(req);
    if (xff && !trust) {
      return { key: 'proxy', label: 'Proxy headers', level: 'warn', detail: `Requests arrive through a proxy (X-Forwarded-For is present) but TRUST_PROXY is not set: every client is seen as ${seen}, which breaks per-client rate limits and audit IPs.` };
    }
    if (!xff && trust) {
      return { key: 'proxy', label: 'Proxy headers', level: 'warn', detail: `TRUST_PROXY=${trust} but this request carried no X-Forwarded-For: if the API is reachable without the proxy, clients could spoof their IP.` };
    }
    return { key: 'proxy', label: 'Proxy headers', level: 'ok', detail: xff ? `Your address as the API sees it: ${seen} (${trust} trusted proxy hop${trust === 1 ? '' : 's'})` : `Direct connection from ${seen} (no proxy in front)` };
  }

  // ------------------------------------------------------------------ the snapshot
  async snapshot(opts: { req?: any; forceChecks?: boolean } = {}) {
    const t = this.thresholds();
    const rows: any[] = await this.ds.query(
      `SELECT id, hostname, pid, "startedAt", version, "nodeVersion", env, "drainRequested", metrics, series,
              EXTRACT(EPOCH FROM (now() - "lastSeenAt"))::float AS "ageSec"
       FROM system_instances ORDER BY "startedAt"`,
    );

    // 1. instances
    type Inst = ReturnType<SystemHealthService['mapInstance']>;
    const all: Inst[] = rows.map((r) => this.mapInstance(r, t));
    // a "down" row is the previous process of a RESTART (not an outage) when a live instance on the same host started after it stopped reporting;
    // two processes that ran side by side on one host (same hostname) are two instances, never a restart of each other
    const nowMs = Date.now();
    for (const i of all) {
      if (i.status !== 'down') continue;
      const lastSeenMs = nowMs - i.ageSec * 1000;
      if (all.some((o) => o.id !== i.id && o.hostname === i.hostname && o.status !== 'down' && new Date(o.startedAt).getTime() >= lastSeenMs - 5000)) i.replaced = true;
    }
    const live = all.filter((i) => i.status !== 'down');
    const accepting = live.filter((i) => !i.draining);

    // 2. totals + traffic share (last 60 s)
    const w = (i: Inst) => i.metrics?.requests?.window60 ?? { count: 0, errors5xx: 0, errors4xx: 0, hist: [] as Hist };
    const hist = mergeHist(...live.map((i) => w(i).hist));
    const requests60 = live.reduce((a, i) => a + (w(i).count || 0), 0);
    const e5 = live.reduce((a, i) => a + (w(i).errors5xx || 0), 0);
    const e4 = live.reduce((a, i) => a + (w(i).errors4xx || 0), 0);
    const totals = {
      instancesUp: live.filter((i) => i.status === 'up').length,
      instancesTotal: all.filter((i) => !i.replaced).length,
      rps: round(live.reduce((a, i) => a + (i.metrics?.requests?.rps || 0), 0), 2),
      inFlight: live.reduce((a, i) => a + (i.metrics?.requests?.inFlight || 0), 0),
      requests60,
      p50: round(histPercentile(hist, 50) ?? 0),
      p95: round(histPercentile(hist, 95) ?? 0),
      p99: round(histPercentile(hist, 99) ?? 0),
      errorRatePct: requests60 ? round((e5 / requests60) * 100, 2) : 0,
      clientErrorRatePct: requests60 ? round((e4 / requests60) * 100, 2) : 0,
      sockets: live.reduce((a, i) => a + (i.metrics?.sockets?.total || 0), 0),
      dbPoolUsed: live.reduce((a, i) => a + Math.max(0, (i.metrics?.db?.poolTotal || 0) - (i.metrics?.db?.poolIdle || 0)), 0),
      dbPoolMax: live.reduce((a, i) => a + (i.metrics?.db?.poolMax || 0), 0),
    };
    const balance: BalanceResult = balanceVerdict(live.map((i) => ({ id: i.id, requests: w(i).count || 0, draining: i.draining })), t);
    for (const i of live) i.share = balance.shares.find((s) => s.id === i.id)?.pct ?? 0;

    // 3. hosts (instances in the same OS share its CPU / memory / disk)
    const hostMap = new Map<string, Inst[]>();
    for (const i of live) {
      if (!i.metrics?.host) continue; // a row without host numbers yet (first heartbeat in flight) cannot describe a server
      const k = i.metrics.host.bootKey || i.hostname;
      hostMap.set(k, [...(hostMap.get(k) ?? []), i]);
    }
    const hosts = [...hostMap.entries()].map(([key, insts]) => {
      const freshest = insts.reduce((a, b) => (a.ageSec <= b.ageSec ? a : b));
      const h = freshest.metrics.host;
      const cores = h.cpus || 1;
      const loadPerCore = round((h.load5 || 0) / cores, 2);
      const levels = {
        cpu: levelHigh(h.cpuPct, t.cpuWarnPct, t.cpuCritPct),
        memory: levelHigh(h.memUsedPct, t.memWarnPct, t.memCritPct),
        swap: h.swapTotalMb ? levelHigh(h.swapUsedPct, t.swapWarnPct, t.swapCritPct) : ('ok' as Level),
        load: h.loadSupported ? levelHigh(loadPerCore, t.loadPerCoreWarn, t.loadPerCoreCrit) : ('ok' as Level),
        disk: levelHigh(Math.max(h.diskRoot?.usedPct ?? 0, h.diskUploads?.usedPct ?? 0), t.diskWarnPct, t.diskCritPct),
      };
      return { key, instances: insts.map((i) => i.id), ...h, loadPerCore, container: freshest.metrics.container ?? null, levels };
    });

    // 4. database + dependency checks
    const db = await this.dbStats();
    const uploads = hosts[0]?.diskUploads ? { writable: !!hosts[0].diskUploads.writable, freeGb: hosts[0].diskUploads.freeGb } : null;
    const checks = [...(await this.checks(t, db, uploads, !!opts.forceChecks))];
    const proxy = this.proxyCheck(opts.req);
    if (proxy) checks.push(proxy);

    // 5. scale-out readiness (what stops a second API instance from working correctly today)
    const adapter = live.map((i) => i.metrics?.sockets?.adapter).find(Boolean) ?? 'unknown';
    const multi = totals.instancesTotal > 1 || live.length > 1;
    const blockers = [
      { key: 'realtime', label: 'Realtime events reach every instance', ok: adapter !== 'Adapter' && adapter !== 'unknown', detail: adapter === 'Adapter' ? 'Socket.IO uses its in-memory adapter: an event emitted on one instance only reaches the clients connected to that instance (driver offers, order updates, chat). Needs a shared adapter (for example Redis).' : `Socket.IO adapter: ${adapter}` },
      { key: 'rate-limits', label: 'Rate limits are shared', ok: false, detail: 'Throttling counters are kept in memory per instance: with N instances every limit is effectively N times higher.' },
      { key: 'schedules', label: 'Scheduled jobs run on one instance only', ok: false, detail: 'Cron jobs (order automation, reports, cleanups) have no leader election and would run on every instance.' },
      { key: 'dispatch', label: 'Dispatch offers survive a restart / failover', ok: false, detail: 'Offer timers are in-process: if the instance running an offer stops, that offer is not resumed by another one.' },
      { key: 'uploads', label: 'Uploaded files are on shared storage', ok: false, detail: 'Uploads and proof-of-delivery photos live on a local disk volume: a second host would not see them.' },
    ];

    // 6. series for the charts
    const series: Record<string, any> = { step: 5, perInstance: {} as Record<string, any>, hosts: {} as Record<string, any> };
    for (const i of all) if (i.status !== 'down' || !i.replaced) series.perInstance[i.id] = i.series;
    for (const h of hosts) {
      const src = live.find((i) => i.id === h.instances[0])?.series ?? {};
      series.hosts[h.key] = { cpu: src.hcpu ?? [], mem: src.hmem ?? [] };
    }

    // 7. routes merged over the live instances
    const rmap = new Map<string, { route: string; count: number; errors5xx: number; errors4xx: number; sumMs: number; p95Ms: number }>();
    for (const i of live) {
      for (const r of i.metrics?.routes ?? []) {
        const a = rmap.get(r.route) ?? { route: r.route, count: 0, errors5xx: 0, errors4xx: 0, sumMs: 0, p95Ms: 0 };
        a.count += r.count;
        a.errors5xx += r.errors5xx;
        a.errors4xx += r.errors4xx;
        a.sumMs += r.avgMs * r.count;
        a.p95Ms = Math.max(a.p95Ms, r.p95Ms);
        rmap.set(r.route, a);
      }
    }
    const routes = [...rmap.values()].map((a) => ({ route: a.route, count: a.count, errors5xx: a.errors5xx, errors4xx: a.errors4xx, avgMs: round(a.sumMs / Math.max(1, a.count), 1), p95Ms: a.p95Ms })).sort((x, y) => y.count - x.count).slice(0, 40);

    // 8. issues -> overall status
    const issues: Issue[] = [];
    const push = (level: Level, area: Issue['area'], message: string, target?: string) => {
      if (level !== 'ok') issues.push({ level, area, message, target });
    };
    if (!live.length) push('crit', 'instances', 'No API instance is reporting a heartbeat.');
    for (const i of all) {
      if (i.status === 'down' && !i.replaced) push(live.length ? 'warn' : 'crit', 'instances', `Instance ${i.id} stopped reporting ${Math.round(i.ageSec)} s ago.`, i.id);
      if (i.status === 'down' && i.replaced && i.ageSec < 900) push('warn', 'instances', `The previous process on ${i.hostname} stopped without a clean shutdown ${Math.round(i.ageSec / 60)} min ago (crash or kill): it was replaced by a restart.`, i.id);
      if (i.status === 'stale') push('warn', 'instances', `Instance ${i.id} missed heartbeats (last one ${Math.round(i.ageSec)} s ago): its event loop may be blocked.`, i.id);
    }
    for (const i of live) {
      const m = i.metrics;
      push(levelHigh(m.process?.eventLoop?.p99, t.loopLagWarnMs, t.loopLagCritMs), 'latency', `Instance ${i.id}: event loop delay p99 is ${m.process?.eventLoop?.p99} ms (the process is busy or blocked).`, i.id);
      const rq = w(i);
      if (rq.count >= t.minRequestsForRates) {
        push(levelHigh(m.requests.window60.p95, t.p95WarnMs, t.p95CritMs), 'latency', `Instance ${i.id}: 95% of requests take under ${m.requests.window60.p95} ms (slow).`, i.id);
        const er = (rq.errors5xx / rq.count) * 100;
        push(levelHigh(er, t.errWarnPct, t.errCritPct), 'errors', `Instance ${i.id}: ${round(er, 1)}% of requests failed with a server error (5xx) in the last minute.`, i.id);
      }
      const poolPct = m.db?.poolMax ? ((m.db.poolTotal - m.db.poolIdle) / m.db.poolMax) * 100 : 0;
      push(levelHigh(poolPct, t.dbPoolWarnPct, t.dbPoolCritPct), 'database', `Instance ${i.id}: ${round(poolPct)}% of its database connection pool is in use.`, i.id);
      if (m.db?.poolWaiting > 0) push('warn', 'database', `Instance ${i.id}: ${m.db.poolWaiting} quer${m.db.poolWaiting === 1 ? 'y is' : 'ies are'} waiting for a free database connection.`, i.id);
    }
    for (const h of hosts) {
      const name = h.instances.length ? live.find((i) => i.id === h.instances[0])?.hostname ?? h.key : h.key;
      push(h.levels.cpu, 'cpu', `Host ${name}: CPU is at ${h.cpuPct}%.`, h.key);
      if (h.stealPct >= 10) push('warn', 'cpu', `Host ${name}: ${h.stealPct}% of CPU time is stolen by the hypervisor (noisy neighbour on the VPS).`, h.key);
      if (h.iowaitPct >= 30) push('warn', 'cpu', `Host ${name}: ${h.iowaitPct}% of CPU time is spent waiting for disk.`, h.key);
      push(h.levels.memory, 'memory', `Host ${name}: ${h.memUsedPct}% of memory is in use (${h.memAvailableMb} MB available).`, h.key);
      push(h.levels.swap, 'memory', `Host ${name}: ${h.swapUsedPct}% of swap is in use (${h.swapUsedMb} of ${h.swapTotalMb} MB): the server is short of RAM.`, h.key);
      push(h.levels.load, 'load', `Host ${name}: load average is ${h.load5} on ${h.cpus} core${h.cpus === 1 ? '' : 's'} (${h.loadPerCore} per core).`, h.key);
      push(h.levels.disk, 'disk', `Host ${name}: disk is ${Math.max(h.diskRoot?.usedPct ?? 0, h.diskUploads?.usedPct ?? 0)}% full.`, h.key);
    }
    if (!db) push('crit', 'database', 'The database is not reachable.');
    else {
      push(levelHigh(db.connections.usedPct, t.dbConnWarnPct, t.dbConnCritPct), 'database', `Database: ${db.connections.total} of ${db.connections.max} connections in use (${db.connections.usedPct}%).`);
      push(levelHigh(db.longestQuerySec, 30, 120), 'database', `Database: a query has been running for ${db.longestQuerySec} s.`);
      push(db.locksWaiting > 5 ? 'warn' : 'ok', 'database', `Database: ${db.locksWaiting} lock requests are waiting.`);
      push(db.connections.idleInTransaction > 5 ? 'warn' : 'ok', 'database', `Database: ${db.connections.idleInTransaction} connections are idle inside an open transaction.`);
    }
    push(balance.level, 'balance', balance.message);
    for (const c of checks) push(c.level, 'checks', `${c.label}: ${c.detail}`);
    if (multi) for (const b of blockers) if (!b.ok) push('crit', 'readiness', `More than one instance is running but: ${b.label.toLowerCase()} is not satisfied. ${b.detail}`);
    issues.sort((a, b) => (a.level === b.level ? 0 : a.level === 'crit' ? -1 : 1));

    return {
      at: new Date().toISOString(),
      status: worstLevel(issues.map((i) => i.level)),
      issues,
      self: this.metrics.instanceId,
      instances: all.filter((i) => !(i.replaced && i.ageSec > 900)),
      totals,
      balance,
      readiness: { multiInstance: multi, blockers },
      hosts,
      db,
      checks,
      routes,
      series,
      thresholds: t,
    };
  }

  private mapInstance(r: any, t: Thresholds) {
    const status: InstanceStatus = instanceStatus(Number(r.ageSec), t);
    const m = r.metrics ?? {};
    return {
      id: String(r.id),
      hostname: String(r.hostname),
      pid: Number(r.pid),
      version: String(r.version ?? ''),
      nodeVersion: String(r.nodeVersion ?? ''),
      env: String(r.env ?? ''),
      startedAt: new Date(r.startedAt).toISOString(),
      uptimeSec: status === 'down' ? 0 : Math.max(0, Math.round((Date.now() - new Date(r.startedAt).getTime()) / 1000)),
      ageSec: round(Number(r.ageSec), 1),
      status,
      draining: !!r.drainRequested || !!m.draining,
      drainRequested: !!r.drainRequested,
      self: String(r.id) === this.metrics.instanceId,
      replaced: false,
      share: 0,
      metrics: m,
      series: r.series ?? {},
    };
  }
}
