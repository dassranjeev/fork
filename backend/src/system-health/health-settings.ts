import { DEFAULT_THRESHOLDS, Thresholds } from './metrics.util';

/** Platform Settings (group "system"): when the System Health page turns a number amber / red. Defaults suit a small single-server install. */
const LABELS: Record<keyof Thresholds, string> = {
  cpuWarnPct: 'Server health: CPU use warning at (%)',
  cpuCritPct: 'Server health: CPU use critical at (%)',
  memWarnPct: 'Server health: memory use warning at (%)',
  memCritPct: 'Server health: memory use critical at (%)',
  swapWarnPct: 'Server health: swap use warning at (%)',
  swapCritPct: 'Server health: swap use critical at (%)',
  diskWarnPct: 'Server health: disk full warning at (%)',
  diskCritPct: 'Server health: disk full critical at (%)',
  loadPerCoreWarn: 'Server health: load average per CPU core, warning at',
  loadPerCoreCrit: 'Server health: load average per CPU core, critical at',
  loopLagWarnMs: 'Server health: event-loop delay (p99) warning at (ms)',
  loopLagCritMs: 'Server health: event-loop delay (p99) critical at (ms)',
  p95WarnMs: 'Server health: request time (p95) warning at (ms)',
  p95CritMs: 'Server health: request time (p95) critical at (ms)',
  errWarnPct: 'Server health: server-error (5xx) rate warning at (%)',
  errCritPct: 'Server health: server-error (5xx) rate critical at (%)',
  dbPoolWarnPct: 'Server health: database pool in use, warning at (%)',
  dbPoolCritPct: 'Server health: database pool in use, critical at (%)',
  dbConnWarnPct: 'Server health: database connections of max, warning at (%)',
  dbConnCritPct: 'Server health: database connections of max, critical at (%)',
  imbalanceWarnPts: 'Server health: load balancing skew warning at (percentage points off an even split)',
  imbalanceCritPts: 'Server health: load balancing skew critical at (percentage points off an even split)',
  minRequestsForRates: 'Server health: minimum requests in the last minute before rates and balance are judged',
  heartbeatStaleSec: 'Server health: instance "stale" after (sec without a heartbeat)',
  heartbeatDownSec: 'Server health: instance "down" after (sec without a heartbeat)',
  tlsWarnDays: 'Server health: TLS certificate warning when fewer than (days) are left',
  tlsCritDays: 'Server health: TLS certificate critical when fewer than (days) are left',
};

export const HEALTH_SETTING_DEFINITIONS = (Object.keys(LABELS) as (keyof Thresholds)[]).map((k) => ({
  key: `system.health.${k}`,
  group: 'system',
  label: LABELS[k],
  value: DEFAULT_THRESHOLDS[k],
  inputType: 'number',
}));
