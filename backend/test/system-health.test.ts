/**
 * Unit tests for the System Health calculations (no server, no database):
 *
 *   cd backend && npx ts-node --transpile-only test/system-health.test.ts
 *
 * Covers the latency histogram / percentiles, threshold levels, instance status by heartbeat age, /proc parsing for host CPU and memory,
 * and the load-balance verdict. Prints PASS / FAIL per check and exits 1 on any FAIL.
 */
import {
  addToHist,
  balanceVerdict,
  cpuPercents,
  DEFAULT_THRESHOLDS,
  emptyHist,
  histCount,
  histIndex,
  histPercentile,
  instanceStatus,
  levelHigh,
  LATENCY_BOUNDS_MS,
  mergeHist,
  parseMeminfo,
  parseProcStat,
  pushCapped,
  round,
  worstLevel,
} from '../src/system-health/metrics.util';

let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : detail ? `  -> ${detail}` : ''}`);
  if (!ok) failed++;
};
const near = (a: number | null, b: number, eps = 0.01) => a !== null && Math.abs(a - b) <= eps;

// ---- histogram ----------------------------------------------------------------------------------------------------------------
check('bucket index: bounds are inclusive (5 ms -> first bucket, 5.1 ms -> second)', histIndex(5) === 0 && histIndex(5.1) === 1);
check('bucket index: anything above the last bound lands in the open bucket', histIndex(10_001) === LATENCY_BOUNDS_MS.length && histIndex(1e9) === LATENCY_BOUNDS_MS.length);
{
  const h = emptyHist();
  check('empty histogram has no percentile', histPercentile(h, 95) === null && histCount(h) === 0);
  for (let i = 0; i < 100; i++) addToHist(h, 3);
  check('100 samples at 3 ms: count is 100', histCount(h) === 100);
  check('100 samples at 3 ms: p50 is interpolated inside the 0-5 ms bucket (2.5)', near(histPercentile(h, 50), 2.5), String(histPercentile(h, 50)));
  check('100 samples at 3 ms: p95 stays inside the first bucket (4.75)', near(histPercentile(h, 95), 4.75), String(histPercentile(h, 95)));
}
{
  const h = emptyHist();
  for (let i = 0; i < 90; i++) addToHist(h, 8); // 5-10 ms bucket
  for (let i = 0; i < 10; i++) addToHist(h, 700); // 500-1000 ms bucket
  const p50 = histPercentile(h, 50) ?? -1;
  const p95 = histPercentile(h, 95) ?? -1;
  check('mixed load: p50 is in the fast bucket (5-10 ms)', p50 > 5 && p50 <= 10, String(p50));
  check('mixed load: p95 is in the slow bucket (500-1000 ms)', p95 > 500 && p95 <= 1000, String(p95));
  check('p100 is the top of the highest used bucket', near(histPercentile(h, 100), 1000), String(histPercentile(h, 100)));
}
{
  const h = emptyHist();
  addToHist(h, 60_000);
  check('a request slower than every bound reports the last bound (open bucket)', histPercentile(h, 99) === 10_000);
  const a = emptyHist();
  const b = emptyHist();
  addToHist(a, 3);
  addToHist(b, 3);
  addToHist(b, 700);
  const m = mergeHist(a, b, undefined, null);
  check('mergeHist adds bucket by bucket and ignores missing histograms', histCount(m) === 3 && m[0] === 2 && m[histIndex(700)] === 1);
  check('mergeHist tolerates short / garbage arrays from the database', histCount(mergeHist([1, 2] as any, undefined)) === 3);
}

// ---- levels / thresholds ------------------------------------------------------------------------------------------------------
check('levelHigh: below warn is ok, at warn is warn, at crit is crit', levelHigh(10, 50, 90) === 'ok' && levelHigh(50, 50, 90) === 'warn' && levelHigh(90, 50, 90) === 'crit');
check('levelHigh: missing values are not an alarm', levelHigh(null, 1, 2) === 'ok' && levelHigh(undefined, 1, 2) === 'ok' && levelHigh(NaN, 1, 2) === 'ok');
check('worstLevel picks the most severe', worstLevel(['ok', 'warn', 'ok']) === 'warn' && worstLevel(['ok', 'warn', 'crit']) === 'crit' && worstLevel([]) === 'ok');
check('round handles nulls and digits', round(null) === 0 && round(2.345, 1) === 2.3 && round(Infinity) === 0);
{
  const t = DEFAULT_THRESHOLDS;
  check('instanceStatus: fresh heartbeat is up', instanceStatus(1.5, t) === 'up');
  check('instanceStatus: a few missed heartbeats is stale', instanceStatus(t.heartbeatStaleSec, t) === 'stale' && instanceStatus(t.heartbeatDownSec - 0.1, t) === 'stale');
  check('instanceStatus: long silence is down', instanceStatus(t.heartbeatDownSec, t) === 'down' && instanceStatus(3600, t) === 'down');
}

// ---- /proc parsing ---------------------------------------------------------------------------------------------------------------
const STAT_A = 'cpu  1000 0 500 8000 400 0 100 0 0 0\ncpu0 500 0 250 4000 200 0 50 0 0 0\nintr 1\n';
const STAT_B = 'cpu  1300 0 700 8300 450 0 100 150 0 0\ncpu0 600 0 300 4100 220 0 50 70 0 0\nintr 2\n';
{
  const a = parseProcStat(STAT_A);
  const b = parseProcStat(STAT_B);
  check('parseProcStat reads the aggregate cpu line', !!a && a.user === 1000 && a.idle === 8000 && a.iowait === 400 && a.softirq === 100);
  check('parseProcStat rejects garbage', parseProcStat('nothing here') === null && parseProcStat('cpu  a b c d') === null);
  const p = a && b ? cpuPercents(a, b) : null;
  // delta: user 300 + system 200 + idle 300 + iowait 50 + steal 150 = 1000; idle+iowait = 350 -> busy 65 %
  check('cpuPercents: busy % over the interval (65)', !!p && near(p.busyPct, 65, 0.05), JSON.stringify(p));
  check('cpuPercents: iowait % (5) and steal % (15)', !!p && near(p.iowaitPct, 5, 0.05) && near(p.stealPct, 15, 0.05), JSON.stringify(p));
  check('cpuPercents: identical samples give no value (no division by zero)', !!a && cpuPercents(a, a) === null);
}
{
  const MEM = 'MemTotal:        1681428 kB\nMemFree:           90000 kB\nMemAvailable:     700000 kB\nBuffers:           20000 kB\nCached:           600000 kB\nSwapTotal:        524284 kB\nSwapFree:         262140 kB\n';
  const m = parseMeminfo(MEM);
  check('parseMeminfo: total / available / swap', !!m && m.memTotalKb === 1681428 && m.memAvailableKb === 700000 && m.swapTotalKb === 524284 && m.swapFreeKb === 262140);
  const old = parseMeminfo('MemTotal: 1000 kB\nMemFree: 100 kB\nBuffers: 50 kB\nCached: 150 kB\n');
  check('parseMeminfo: old kernels without MemAvailable fall back to free + buffers + cache', !!old && old.memAvailableKb === 300 && old.swapTotalKb === 0);
  check('parseMeminfo rejects garbage', parseMeminfo('hello') === null);
}

// ---- load balance verdict -------------------------------------------------------------------------------------------------------
{
  const t = DEFAULT_THRESHOLDS;
  check('balance: no instances is critical', balanceVerdict([], t).state === 'none' && balanceVerdict([], t).level === 'crit');
  const one = balanceVerdict([{ id: 'a', requests: 500 }], t);
  check('balance: a single instance means "no load balancing in place" (ok, not an error)', one.state === 'single' && one.level === 'ok' && one.shares[0].pct === 100);
  const idle = balanceVerdict([{ id: 'a', requests: 3 }, { id: 'b', requests: 2 }], t);
  check('balance: too little traffic is not judged', idle.state === 'idle' && idle.level === 'ok');
  const even = balanceVerdict([{ id: 'a', requests: 500 }, { id: 'b', requests: 480 }], t);
  check('balance: 51/49 is balanced', even.state === 'balanced' && even.level === 'ok' && even.expectedPct === 50, JSON.stringify(even));
  const skew = balanceVerdict([{ id: 'a', requests: 650 }, { id: 'b', requests: 350 }], t);
  check('balance: 65/35 is skewed (warn) and names the busy instance', skew.state === 'skewed' && skew.level === 'warn' && skew.message.includes('a handles 65%'), skew.message);
  const reversed = balanceVerdict([{ id: 'b', requests: 350 }, { id: 'a', requests: 650 }], t);
  check('balance: the verdict names the BUSIEST instance whatever the order (two instances are equally far from 50%)', reversed.message.includes('a handles 65%'), reversed.message);
  const bad = balanceVerdict([{ id: 'a', requests: 950 }, { id: 'b', requests: 50 }], t);
  check('balance: 95/5 is unbalanced (critical)', bad.state === 'unbalanced' && bad.level === 'crit' && bad.maxDeviationPts === 45, JSON.stringify(bad));
  const three = balanceVerdict([{ id: 'a', requests: 400 }, { id: 'b', requests: 400 }, { id: 'c', requests: 200 }], t);
  check('balance: three instances compare against a 33.3% even split', three.expectedPct === 33.3 && three.state === 'skewed', JSON.stringify(three));
  const starved = balanceVerdict([{ id: 'a', requests: 450 }, { id: 'b', requests: 450 }, { id: 'c', requests: 100 }], t);
  check('balance: with three instances an under-served one is named when it is furthest from the even split', starved.message.includes('c handles 10%'), starved.message);
  const drain = balanceVerdict([{ id: 'a', requests: 500 }, { id: 'b', requests: 500 }, { id: 'c', requests: 0, draining: true }], t);
  check('balance: a draining instance is not expected to take traffic (even split of the other two)', drain.expectedPct === 50 && drain.state === 'balanced' && drain.shares.find((s) => s.id === 'c')?.draining === true, JSON.stringify(drain));
  const allDrain = balanceVerdict([{ id: 'a', requests: 10, draining: true }, { id: 'b', requests: 10, draining: true }], t);
  check('balance: every instance draining is critical', allDrain.level === 'crit');
  const tuned = balanceVerdict([{ id: 'a', requests: 650 }, { id: 'b', requests: 350 }], { ...t, imbalanceWarnPts: 20, imbalanceCritPts: 40 });
  check('balance: thresholds can be tuned (65/35 is fine with a 20-point tolerance)', tuned.state === 'balanced');
}

// ---- series helper ---------------------------------------------------------------------------------------------------------------
{
  const a: number[] = [];
  for (let i = 0; i < 100; i++) pushCapped(a, i, 60);
  check('pushCapped keeps the newest 60 values', a.length === 60 && a[0] === 40 && a[59] === 99);
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall system-health checks passed');
process.exit(failed ? 1 : 0);
