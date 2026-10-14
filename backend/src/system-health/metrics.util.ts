/**
 * Pure helpers for the System Health feature (no Nest, no I/O) so they can be unit-tested:
 * latency histograms, percentiles, threshold levels, /proc parsing and the load-balance verdict.
 */

// ------------------------------------------------------------------ latency histogram
/** Upper bounds (ms) of the latency buckets; one extra open bucket above the last bound. */
export const LATENCY_BOUNDS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000] as const;
export type Hist = number[];
export const HIST_LEN = LATENCY_BOUNDS_MS.length + 1;
export const emptyHist = (): Hist => new Array<number>(HIST_LEN).fill(0);

export function histIndex(ms: number): number {
  for (let i = 0; i < LATENCY_BOUNDS_MS.length; i++) if (ms <= LATENCY_BOUNDS_MS[i]) return i;
  return LATENCY_BOUNDS_MS.length;
}

export function addToHist(h: Hist, ms: number): void {
  h[histIndex(ms)]++;
}

export function mergeHist(...hs: (Hist | undefined | null)[]): Hist {
  const out = emptyHist();
  for (const h of hs) if (h) for (let i = 0; i < HIST_LEN; i++) out[i] += Number(h[i]) || 0;
  return out;
}

export const histCount = (h: Hist): number => h.reduce((a, b) => a + (Number(b) || 0), 0);

/**
 * p in 0..100. Linear interpolation inside the bucket that holds the rank; the open top bucket is reported as its lower bound.
 * Returns null for an empty histogram.
 */
export function histPercentile(h: Hist, p: number): number | null {
  const total = histCount(h);
  if (!total) return null;
  const rank = Math.max(1, Math.ceil((Math.min(100, Math.max(0, p)) / 100) * total));
  let acc = 0;
  for (let i = 0; i < h.length; i++) {
    const c = Number(h[i]) || 0;
    if (!c) continue;
    if (acc + c >= rank) {
      const lo = i === 0 ? 0 : LATENCY_BOUNDS_MS[i - 1];
      const hi = i < LATENCY_BOUNDS_MS.length ? LATENCY_BOUNDS_MS[i] : lo;
      if (hi === lo) return lo;
      return lo + (hi - lo) * ((rank - acc) / c);
    }
    acc += c;
  }
  return LATENCY_BOUNDS_MS[LATENCY_BOUNDS_MS.length - 1];
}

export const round = (n: number | null | undefined, digits = 0): number => {
  if (n === null || n === undefined || !Number.isFinite(n)) return 0;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};

// ------------------------------------------------------------------ levels & thresholds
export type Level = 'ok' | 'warn' | 'crit';
const ORDER: Record<Level, number> = { ok: 0, warn: 1, crit: 2 };
export const worstLevel = (levels: Level[]): Level => levels.reduce<Level>((a, b) => (ORDER[b] > ORDER[a] ? b : a), 'ok');

/** Higher values are worse. */
export function levelHigh(v: number | null | undefined, warn: number, crit: number): Level {
  if (v === null || v === undefined || Number.isNaN(v)) return 'ok';
  return v >= crit ? 'crit' : v >= warn ? 'warn' : 'ok';
}

export interface Thresholds {
  cpuWarnPct: number;
  cpuCritPct: number;
  memWarnPct: number;
  memCritPct: number;
  swapWarnPct: number;
  swapCritPct: number;
  diskWarnPct: number;
  diskCritPct: number;
  loadPerCoreWarn: number;
  loadPerCoreCrit: number;
  loopLagWarnMs: number;
  loopLagCritMs: number;
  p95WarnMs: number;
  p95CritMs: number;
  errWarnPct: number;
  errCritPct: number;
  dbPoolWarnPct: number;
  dbPoolCritPct: number;
  dbConnWarnPct: number;
  dbConnCritPct: number;
  imbalanceWarnPts: number;
  imbalanceCritPts: number;
  /** below this many requests in the last minute, rates (error %, balance) are not judged */
  minRequestsForRates: number;
  heartbeatStaleSec: number;
  heartbeatDownSec: number;
  tlsWarnDays: number;
  tlsCritDays: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  cpuWarnPct: 75,
  cpuCritPct: 90,
  memWarnPct: 85,
  memCritPct: 93,
  swapWarnPct: 25,
  swapCritPct: 60,
  diskWarnPct: 80,
  diskCritPct: 92,
  loadPerCoreWarn: 1,
  loadPerCoreCrit: 2,
  loopLagWarnMs: 100,
  loopLagCritMs: 500,
  p95WarnMs: 800,
  p95CritMs: 2500,
  errWarnPct: 1,
  errCritPct: 5,
  dbPoolWarnPct: 80,
  dbPoolCritPct: 95,
  dbConnWarnPct: 80,
  dbConnCritPct: 95,
  imbalanceWarnPts: 10,
  imbalanceCritPts: 25,
  minRequestsForRates: 20,
  heartbeatStaleSec: 8,
  heartbeatDownSec: 30,
  tlsWarnDays: 14,
  tlsCritDays: 5,
};

export type InstanceStatus = 'up' | 'stale' | 'down';
/** Heartbeats arrive every ~2 s: a few missed ones means the event loop is stuck, many means the process is gone. */
export function instanceStatus(ageSec: number, t: Pick<Thresholds, 'heartbeatStaleSec' | 'heartbeatDownSec'>): InstanceStatus {
  if (ageSec >= t.heartbeatDownSec) return 'down';
  if (ageSec >= t.heartbeatStaleSec) return 'stale';
  return 'up';
}

// ------------------------------------------------------------------ /proc parsing (Linux)
export interface ProcCpu {
  user: number;
  nice: number;
  system: number;
  idle: number;
  iowait: number;
  irq: number;
  softirq: number;
  steal: number;
}

/** First line of /proc/stat ("cpu  4705 150 1120 16250856 ...") */
export function parseProcStat(text: string): ProcCpu | null {
  const line = text.split('\n').find((l) => /^cpu\s/.test(l));
  if (!line) return null;
  const n = line.trim().split(/\s+/).slice(1).map(Number);
  if (n.length < 4 || n.some((x) => !Number.isFinite(x))) return null;
  return { user: n[0], nice: n[1] || 0, system: n[2] || 0, idle: n[3] || 0, iowait: n[4] || 0, irq: n[5] || 0, softirq: n[6] || 0, steal: n[7] || 0 };
}

export interface CpuPercents {
  busyPct: number;
  iowaitPct: number;
  stealPct: number;
}

/** Percentages over the interval between two samples. */
export function cpuPercents(prev: ProcCpu, cur: ProcCpu): CpuPercents | null {
  const sum = (c: ProcCpu) => c.user + c.nice + c.system + c.idle + c.iowait + c.irq + c.softirq + c.steal;
  const total = sum(cur) - sum(prev);
  if (total <= 0) return null;
  const idle = cur.idle + cur.iowait - (prev.idle + prev.iowait);
  return {
    busyPct: round(Math.min(100, Math.max(0, ((total - idle) / total) * 100)), 1),
    iowaitPct: round(Math.max(0, ((cur.iowait - prev.iowait) / total) * 100), 1),
    stealPct: round(Math.max(0, ((cur.steal - prev.steal) / total) * 100), 1),
  };
}

export interface MemInfo {
  memTotalKb: number;
  memAvailableKb: number;
  swapTotalKb: number;
  swapFreeKb: number;
}

export function parseMeminfo(text: string): MemInfo | null {
  const get = (k: string) => {
    const m = text.match(new RegExp(`^${k}:\\s+(\\d+)\\s*kB`, 'm'));
    return m ? Number(m[1]) : null;
  };
  const total = get('MemTotal');
  const avail = get('MemAvailable') ?? (get('MemFree') !== null ? (get('MemFree') as number) + (get('Buffers') ?? 0) + (get('Cached') ?? 0) : null);
  if (total === null || avail === null) return null;
  return { memTotalKb: total, memAvailableKb: avail, swapTotalKb: get('SwapTotal') ?? 0, swapFreeKb: get('SwapFree') ?? 0 };
}

// ------------------------------------------------------------------ load-balance verdict
export interface BalanceInput {
  id: string;
  /** requests served in the judging window */
  requests: number;
  draining?: boolean;
}

export type BalanceState = 'none' | 'single' | 'idle' | 'balanced' | 'skewed' | 'unbalanced';

export interface BalanceResult {
  state: BalanceState;
  level: Level;
  /** even split among the instances that accept traffic */
  expectedPct: number;
  /** largest distance (percentage points) of an instance from the even split */
  maxDeviationPts: number;
  shares: { id: string; pct: number; draining: boolean }[];
  message: string;
}

export function balanceVerdict(
  instances: BalanceInput[],
  t: Pick<Thresholds, 'imbalanceWarnPts' | 'imbalanceCritPts' | 'minRequestsForRates'> = DEFAULT_THRESHOLDS,
): BalanceResult {
  const total = instances.reduce((a, i) => a + Math.max(0, i.requests), 0);
  const shares = instances.map((i) => ({ id: i.id, pct: total ? round((Math.max(0, i.requests) / total) * 100, 1) : 0, draining: !!i.draining }));
  const serving = instances.filter((i) => !i.draining);
  const base = { shares, expectedPct: serving.length ? round(100 / serving.length, 1) : 0, maxDeviationPts: 0 };
  if (!instances.length) return { ...base, state: 'none', level: 'crit', message: 'No instance is reporting.' };
  if (!serving.length) return { ...base, state: 'none', level: 'crit', message: 'Every instance is draining: no instance accepts new traffic.' };
  if (instances.length === 1) return { ...base, state: 'single', level: 'ok', message: 'One instance serves all traffic: there is no load balancing in place.' };
  if (total < t.minRequestsForRates) {
    return { ...base, state: 'idle', level: 'ok', message: `Only ${total} request${total === 1 ? '' : 's'} in the last minute: too little traffic to judge the balance.` };
  }
  const servingShares = shares.filter((s) => !s.draining);
  const distance = (s: { pct: number }) => round(Math.abs(s.pct - base.expectedPct), 1);
  // the instance furthest from an even split; on a tie (with two instances both are equally far) the busier one is the one worth naming
  const worst = servingShares.reduce((a, s) => (distance(s) > distance(a) || (distance(s) === distance(a) && s.pct > a.pct) ? s : a), servingShares[0]);
  const dev = distance(worst);
  if (dev >= t.imbalanceCritPts) {
    return { ...base, maxDeviationPts: dev, state: 'unbalanced', level: 'crit', message: `Traffic is badly unbalanced: ${worst.id} handles ${worst.pct}% of requests (an even split would be ${base.expectedPct}%).` };
  }
  if (dev >= t.imbalanceWarnPts) {
    return { ...base, maxDeviationPts: dev, state: 'skewed', level: 'warn', message: `Traffic is skewed: ${worst.id} handles ${worst.pct}% of requests (an even split would be ${base.expectedPct}%).` };
  }
  return { ...base, maxDeviationPts: dev, state: 'balanced', level: 'ok', message: `Traffic is evenly spread (largest deviation ${dev} points from an even split).` };
}

/** Compact fixed-size series (newest last): pushes a value and keeps the last `max` entries. */
export function pushCapped(arr: number[], value: number, max: number): void {
  arr.push(value);
  if (arr.length > max) arr.splice(0, arr.length - max);
}
