import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { constants as fsConstants, promises as fsp } from 'fs';
import { randomBytes } from 'crypto';
import { monitorEventLoopDelay, IntervalHistogram } from 'perf_hooks';
import * as os from 'os';
import { join } from 'path';
import { RealtimeService } from '../realtime/realtime.module';
import { drainState } from '../common/drain-state';
import { Hist, addToHist, cpuPercents, emptyHist, histCount, histPercentile, mergeHist, parseMeminfo, parseProcStat, ProcCpu, pushCapped, round } from './metrics.util';

const FINE_SECONDS = 120; // per-second request buckets kept for "last minute / last 2 minutes" numbers
const SERIES_POINTS = 60; // 5 minutes at 5 s
const LOOP_RESOLUTION_MS = 10; // event-loop timer interval; Node reports interval + delay, so the interval is subtracted
const SERIES_STEP_SEC = 5;
const ROUTE_MINUTES = 5;

interface Bucket {
  sec: number;
  count: number;
  e4: number;
  e5: number;
  sumMs: number;
  hist: Hist;
}

interface RouteAgg {
  count: number;
  e5: number;
  e4: number;
  sumMs: number;
  hist: Hist;
}

export interface RouteStat {
  route: string;
  count: number;
  errors5xx: number;
  errors4xx: number;
  avgMs: number;
  p95Ms: number;
}

export interface InstanceSeries {
  step: number;
  rps: number[];
  p95: number[];
  err: number[];
  cpu: number[];
  rss: number[];
  lag: number[];
  hcpu: number[];
  hmem: number[];
  sockets: number[];
}

const mb = (bytes: number) => round(bytes / 1048576, 1);

/**
 * Collects this process's health numbers: request throughput / latency / errors (fed by the request middleware), event-loop delay,
 * CPU and memory of the process, CPU / memory / swap / load / disk of the host it runs on, database pool usage and realtime connections.
 * Everything is kept in memory and cheap to read; SystemHeartbeatService publishes a snapshot to the database every couple of seconds.
 */
@Injectable()
export class SystemMetricsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('SystemMetrics');
  readonly startedAt = Date.now();
  readonly hostname = os.hostname();
  readonly instanceId = `${this.hostname.slice(0, 40)}-${randomBytes(2).toString('hex')}`;
  readonly nodeVersion = process.version;
  readonly version = SystemMetricsService.readVersion();

  private fine: Bucket[] = Array.from({ length: FINE_SECONDS }, () => ({ sec: 0, count: 0, e4: 0, e5: 0, sumMs: 0, hist: emptyHist() }));
  private routeMins: Map<string, RouteAgg>[] = Array.from({ length: ROUTE_MINUTES }, () => new Map());
  private routeMinute = Math.floor(Date.now() / 60000);
  private inFlight = 0;
  private peakInFlight = 0;
  private totalRequests = 0;

  private series: InstanceSeries = { step: SERIES_STEP_SEC, rps: [], p95: [], err: [], cpu: [], rss: [], lag: [], hcpu: [], hmem: [], sockets: [] };
  private loop: IntervalHistogram = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
  private timer: NodeJS.Timeout | null = null;
  private ticks = 0;
  private sampling = false;

  // sampled values (refreshed by tick())
  private lastCpuUsage = process.cpuUsage();
  private lastCpuAt = process.hrtime.bigint();
  private procCpuPct = 0;
  private lagMs = { p50: 0, p99: 0, max: 0 };
  private lastHostCpu: ProcCpu | null = null;
  private hostCpu = { busyPct: 0, iowaitPct: 0, stealPct: 0 };
  private hostMem = { totalMb: 0, availableMb: 0, usedPct: 0, swapTotalMb: 0, swapUsedMb: 0, swapUsedPct: 0 };
  private disk: { root: { totalGb: number; freeGb: number; usedPct: number } | null; uploads: { totalGb: number; freeGb: number; usedPct: number; writable: boolean } | null } = { root: null, uploads: null };
  private diskAt = 0;
  private container: { memLimitMb: number | null; memUsedMb: number | null; cpuLimit: number | null } | null = null;
  private containerAt = 0;
  private bootId = '';
  private socketTally: { total: number; byType: Record<string, number>; adapter: string } = { total: 0, byType: {}, adapter: 'unknown' };
  private socketAt = 0;

  constructor(
    @InjectDataSource() private ds: DataSource,
    @Optional() private rt?: RealtimeService,
  ) {}

  private static readVersion(): string {
    const sha = (process.env.APP_COMMIT || process.env.GIT_SHA || '').trim().slice(0, 12);
    let pkg = '';
    try {
      // dist/system-health -> ../../package.json (same layout under ts-node: src/system-health)
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      pkg = String(require(join(__dirname, '..', '..', 'package.json')).version ?? '');
    } catch {
      /* optional */
    }
    return [pkg, sha].filter(Boolean).join('+') || 'unknown';
  }

  async onModuleInit() {
    this.loop.enable();
    try {
      this.bootId = (await fsp.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
    } catch {
      this.bootId = `${os.hostname()}:${os.totalmem()}`; // not Linux: best effort host identity
    }
    await this.sample(); // first values immediately
    this.timer = setInterval(() => void this.tick(), 1000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.loop.disable();
  }

  // ------------------------------------------------------------------ request recording (called by the middleware)
  requestStarted() {
    this.inFlight++;
    if (this.inFlight > this.peakInFlight) this.peakInFlight = this.inFlight;
  }

  requestFinished(route: string, status: number, ms: number) {
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.totalRequests++;
    const b = this.bucket();
    b.count++;
    b.sumMs += ms;
    addToHist(b.hist, ms);
    if (status >= 500) b.e5++;
    else if (status >= 400) b.e4++;
    const agg = this.routeAgg(route);
    agg.count++;
    agg.sumMs += ms;
    addToHist(agg.hist, ms);
    if (status >= 500) agg.e5++;
    else if (status >= 400) agg.e4++;
  }

  private bucket(): Bucket {
    const sec = Math.floor(Date.now() / 1000);
    const b = this.fine[sec % FINE_SECONDS];
    if (b.sec !== sec) {
      b.sec = sec;
      b.count = 0;
      b.e4 = 0;
      b.e5 = 0;
      b.sumMs = 0;
      b.hist.fill(0);
    }
    return b;
  }

  private routeAgg(route: string): RouteAgg {
    this.rotateRoutes();
    const cur = this.routeMins[this.routeMins.length - 1];
    let a = cur.get(route);
    if (!a) {
      // bounded cardinality: routes are patterns (/orders/:id), never raw URLs; still cap it
      if (cur.size >= 400) route = '(other)';
      a = cur.get(route);
      if (!a) {
        a = { count: 0, e5: 0, e4: 0, sumMs: 0, hist: emptyHist() };
        cur.set(route, a);
      }
    }
    return a;
  }

  private rotateRoutes() {
    const minute = Math.floor(Date.now() / 60000);
    const gap = minute - this.routeMinute;
    if (gap <= 0) return;
    for (let i = 0; i < Math.min(gap, ROUTE_MINUTES); i++) {
      this.routeMins.shift();
      this.routeMins.push(new Map());
    }
    this.routeMinute = minute;
  }

  /** Sum of the last `seconds` complete-or-running seconds. */
  private window(seconds: number): { count: number; e4: number; e5: number; sumMs: number; hist: Hist } {
    const now = Math.floor(Date.now() / 1000);
    const out = { count: 0, e4: 0, e5: 0, sumMs: 0, hist: emptyHist() };
    for (const b of this.fine) {
      if (b.sec > now - seconds && b.sec <= now) {
        out.count += b.count;
        out.e4 += b.e4;
        out.e5 += b.e5;
        out.sumMs += b.sumMs;
        for (let i = 0; i < out.hist.length; i++) out.hist[i] += b.hist[i];
      }
    }
    return out;
  }

  routes(): RouteStat[] {
    this.rotateRoutes();
    const merged = new Map<string, RouteAgg>();
    for (const m of this.routeMins) {
      for (const [k, v] of m) {
        const a = merged.get(k) ?? { count: 0, e5: 0, e4: 0, sumMs: 0, hist: emptyHist() };
        a.count += v.count;
        a.e5 += v.e5;
        a.e4 += v.e4;
        a.sumMs += v.sumMs;
        a.hist = mergeHist(a.hist, v.hist);
        merged.set(k, a);
      }
    }
    return [...merged.entries()]
      .map(([route, a]) => ({ route, count: a.count, errors5xx: a.e5, errors4xx: a.e4, avgMs: round(a.sumMs / Math.max(1, a.count), 1), p95Ms: round(histPercentile(a.hist, 95) ?? 0, 0) }))
      .sort((x, y) => y.count - x.count)
      .slice(0, 60);
  }

  // ------------------------------------------------------------------ sampling
  private async tick() {
    this.ticks++;
    try {
      if (this.ticks % 2 === 0) await this.sample();
      if (this.ticks % SERIES_STEP_SEC === 0) this.pushSeriesPoint();
    } catch (e: any) {
      this.logger.debug(`sample failed: ${e?.message}`);
    }
  }

  private async sample() {
    if (this.sampling) return;
    this.sampling = true;
    try {
      // process CPU: share of ONE core used by this process since the last sample
      const cu = process.cpuUsage();
      const now = process.hrtime.bigint();
      const wallUs = Number(now - this.lastCpuAt) / 1000;
      if (wallUs > 0) this.procCpuPct = round((((cu.user - this.lastCpuUsage.user) + (cu.system - this.lastCpuUsage.system)) / wallUs) * 100, 1);
      this.lastCpuUsage = cu;
      this.lastCpuAt = now;

      // event loop delay since the last sample (ns -> ms, minus the timer interval); an empty histogram reports NaN / huge min
      const l = this.loop;
      const fin = (v: number) => (Number.isFinite(v) && v < 1e15 ? Math.max(0, v / 1e6 - LOOP_RESOLUTION_MS) : 0);
      this.lagMs = { p50: round(fin(l.percentile(50)), 1), p99: round(fin(l.percentile(99)), 1), max: round(fin(l.max), 1) };
      l.reset();

      await this.sampleHost();
      if (Date.now() - this.diskAt > 30_000) await this.sampleDisk();
      if (Date.now() - this.containerAt > 10_000) await this.sampleContainer();
      if (Date.now() - this.socketAt > 4_000) this.sampleSockets();
    } finally {
      this.sampling = false;
    }
  }

  private async sampleHost() {
    // CPU: Linux /proc/stat (adds iowait + steal, which matter on a VPS); elsewhere the aggregated os.cpus() times
    let cur: ProcCpu | null = null;
    try {
      cur = parseProcStat(await fsp.readFile('/proc/stat', 'utf8'));
    } catch {
      /* not Linux */
    }
    if (!cur) {
      const t = os.cpus().reduce((a, c) => ({ user: a.user + c.times.user, nice: a.nice + c.times.nice, system: a.system + c.times.sys, idle: a.idle + c.times.idle, iowait: 0, irq: a.irq + c.times.irq, softirq: 0, steal: 0 }), { user: 0, nice: 0, system: 0, idle: 0, iowait: 0, irq: 0, softirq: 0, steal: 0 });
      cur = t;
    }
    if (this.lastHostCpu) {
      const p = cpuPercents(this.lastHostCpu, cur);
      if (p) this.hostCpu = p;
    }
    this.lastHostCpu = cur;

    // memory: MemAvailable is what can be used without swapping (os.freemem() ignores reclaimable cache and looks alarming)
    let mi = null as ReturnType<typeof parseMeminfo>;
    try {
      mi = parseMeminfo(await fsp.readFile('/proc/meminfo', 'utf8'));
    } catch {
      /* not Linux */
    }
    if (mi) {
      const total = mi.memTotalKb / 1024;
      const avail = mi.memAvailableKb / 1024;
      const swapT = mi.swapTotalKb / 1024;
      const swapU = (mi.swapTotalKb - mi.swapFreeKb) / 1024;
      this.hostMem = { totalMb: round(total), availableMb: round(avail), usedPct: round(total ? ((total - avail) / total) * 100 : 0, 1), swapTotalMb: round(swapT), swapUsedMb: round(swapU), swapUsedPct: round(swapT ? (swapU / swapT) * 100 : 0, 1) };
    } else {
      const total = os.totalmem() / 1048576;
      const free = os.freemem() / 1048576;
      this.hostMem = { totalMb: round(total), availableMb: round(free), usedPct: round(total ? ((total - free) / total) * 100 : 0, 1), swapTotalMb: 0, swapUsedMb: 0, swapUsedPct: 0 };
    }
  }

  private async sampleDisk() {
    this.diskAt = Date.now();
    const stat = async (p: string) => {
      try {
        const s = await fsp.statfs(p);
        const total = s.blocks * s.bsize;
        const free = s.bavail * s.bsize;
        return { totalGb: round(total / 1073741824, 1), freeGb: round(free / 1073741824, 1), usedPct: round(total ? ((total - free) / total) * 100 : 0, 1) };
      } catch {
        return null;
      }
    };
    const root = await stat(process.platform === 'win32' ? process.cwd().slice(0, 3) : '/');
    const uploadsDir = join(process.cwd(), process.env.UPLOAD_DIR ?? 'uploads');
    const u = await stat(uploadsDir);
    let writable = false;
    try {
      await fsp.access(uploadsDir, fsConstants.W_OK);
      writable = true;
    } catch {
      /* not writable / missing */
    }
    this.disk = { root, uploads: u ? { ...u, writable } : null };
  }

  /** cgroup limits of the container this process runs in (Docker): only present on Linux with cgroups. */
  private async sampleContainer() {
    this.containerAt = Date.now();
    const read = async (p: string) => {
      try {
        return (await fsp.readFile(p, 'utf8')).trim();
      } catch {
        return null;
      }
    };
    const num = (s: string | null) => (s && /^\d+$/.test(s) ? Number(s) : null);
    let limit = num(await read('/sys/fs/cgroup/memory.max'));
    let used = num(await read('/sys/fs/cgroup/memory.current'));
    if (limit === null && used === null) {
      limit = num(await read('/sys/fs/cgroup/memory/memory.limit_in_bytes'));
      used = num(await read('/sys/fs/cgroup/memory/memory.usage_in_bytes'));
      if (limit !== null && limit > 1e15) limit = null; // "unlimited" sentinel of cgroup v1
    }
    const cpuMax = await read('/sys/fs/cgroup/cpu.max');
    let cpuLimit: number | null = null;
    if (cpuMax) {
      const [q, p] = cpuMax.split(/\s+/);
      if (q !== 'max' && Number(q) > 0 && Number(p) > 0) cpuLimit = round(Number(q) / Number(p), 2);
    }
    this.container = used === null && limit === null && cpuLimit === null ? null : { memLimitMb: limit === null ? null : round(limit / 1048576), memUsedMb: used === null ? null : round(used / 1048576), cpuLimit };
  }

  private sampleSockets() {
    this.socketAt = Date.now();
    const server: any = this.rt?.server;
    if (!server) return;
    const byType: Record<string, number> = {};
    let total = 0;
    try {
      for (const s of server.sockets.sockets.values()) {
        total++;
        const t = s.data?.user?.type ?? 'ANONYMOUS';
        byType[t] = (byType[t] ?? 0) + 1;
      }
    } catch {
      /* ignore */
    }
    this.socketTally = { total, byType, adapter: server.sockets?.adapter?.constructor?.name ?? 'unknown' };
  }

  private pushSeriesPoint() {
    const w = this.window(SERIES_STEP_SEC);
    const p95 = histPercentile(w.hist, 95) ?? 0;
    const s = this.series;
    pushCapped(s.rps, round(w.count / SERIES_STEP_SEC, 2), SERIES_POINTS);
    pushCapped(s.p95, round(p95), SERIES_POINTS);
    pushCapped(s.err, round(w.count ? (w.e5 / w.count) * 100 : 0, 2), SERIES_POINTS);
    pushCapped(s.cpu, this.procCpuPct, SERIES_POINTS);
    pushCapped(s.rss, mb(process.memoryUsage().rss), SERIES_POINTS);
    pushCapped(s.lag, this.lagMs.p99, SERIES_POINTS);
    pushCapped(s.hcpu, this.hostCpu.busyPct, SERIES_POINTS);
    pushCapped(s.hmem, this.hostMem.usedPct, SERIES_POINTS);
    pushCapped(s.sockets, this.socketTally.total, SERIES_POINTS);
  }

  // ------------------------------------------------------------------ snapshots
  get bootKey(): string {
    return this.bootId;
  }

  seriesSnapshot(): InstanceSeries {
    return this.series;
  }

  /** The numbers published for this instance (kept small: it is stored in the database every ~2 s). */
  snapshot() {
    const w60 = this.window(60);
    const w15 = this.window(15);
    const mem = process.memoryUsage();
    const pool = (this.ds.driver as any)?.master as { totalCount?: number; idleCount?: number; waitingCount?: number; options?: { max?: number } } | undefined;
    const cores = os.cpus().length || 1;
    const load = os.loadavg();
    return {
      at: Date.now(),
      uptimeSec: Math.round(process.uptime()),
      draining: drainState.active,
      requests: {
        rps: round(w15.count / 15, 2),
        inFlight: this.inFlight,
        peakInFlight: this.peakInFlight,
        total: this.totalRequests,
        window60: {
          count: w60.count,
          errors5xx: w60.e5,
          errors4xx: w60.e4,
          avgMs: round(w60.sumMs / Math.max(1, w60.count), 1),
          p50: round(histPercentile(w60.hist, 50) ?? 0),
          p95: round(histPercentile(w60.hist, 95) ?? 0),
          p99: round(histPercentile(w60.hist, 99) ?? 0),
          hist: w60.hist,
          samples: histCount(w60.hist),
        },
      },
      process: {
        pid: process.pid,
        cpuPct: this.procCpuPct,
        rssMb: mb(mem.rss),
        heapUsedMb: mb(mem.heapUsed),
        heapTotalMb: mb(mem.heapTotal),
        externalMb: mb(mem.external),
        eventLoop: this.lagMs,
      },
      host: {
        bootKey: this.bootId,
        platform: process.platform,
        cpus: cores,
        cpuPct: this.hostCpu.busyPct,
        iowaitPct: this.hostCpu.iowaitPct,
        stealPct: this.hostCpu.stealPct,
        load1: round(load[0], 2),
        load5: round(load[1], 2),
        load15: round(load[2], 2),
        loadSupported: process.platform !== 'win32',
        memTotalMb: this.hostMem.totalMb,
        memAvailableMb: this.hostMem.availableMb,
        memUsedPct: this.hostMem.usedPct,
        swapTotalMb: this.hostMem.swapTotalMb,
        swapUsedMb: this.hostMem.swapUsedMb,
        swapUsedPct: this.hostMem.swapUsedPct,
        uptimeSec: Math.round(os.uptime()),
        diskRoot: this.disk.root,
        diskUploads: this.disk.uploads,
      },
      container: this.container,
      db: { poolMax: pool?.options?.max ?? null, poolTotal: pool?.totalCount ?? 0, poolIdle: pool?.idleCount ?? 0, poolWaiting: pool?.waitingCount ?? 0 },
      sockets: this.socketTally,
      routes: this.routes().slice(0, 25),
    };
  }
}

export type InstanceMetrics = ReturnType<SystemMetricsService['snapshot']>;
