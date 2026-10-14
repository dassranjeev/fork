// Small formatting helpers for the System Health page.

export const LEVEL_TONE = { ok: "success", warn: "warning", crit: "danger" };
export const LEVEL_HEX = { ok: "#22c55e", warn: "#eab308", crit: "#ef4444" };
export const LEVEL_LABEL = { ok: "OK", warn: "Warning", crit: "Critical" };
export const LEVEL_ICON = { ok: "solar:check-circle-outline", warn: "solar:danger-triangle-outline", crit: "solar:close-circle-outline" };

/** 0..max value -> level using the thresholds the API returned (so the page and the server always agree). */
export function levelOf(value, warn, crit) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "ok";
  return value >= crit ? "crit" : value >= warn ? "warn" : "ok";
}

export const worst = (levels) => levels.reduce((a, b) => (b === "crit" || (b === "warn" && a === "ok") ? b : a), "ok");

export function mbText(v) {
  if (v === null || v === undefined) return "—";
  return v >= 1024 ? `${(v / 1024).toFixed(1)} GB` : `${Math.round(v)} MB`;
}

export function msText(v) {
  if (v === null || v === undefined) return "—";
  return v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`;
}

export function durationText(sec) {
  if (sec === null || sec === undefined || sec < 0) return "—";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${Math.floor(sec % 60)}s`;
  return `${Math.floor(sec)}s`;
}

export const pctText = (v, d = 1) => (v === null || v === undefined ? "—" : `${Number(v).toFixed(d)}%`);

/** Left-pad a series with nulls so instances that started later still line up on the right edge (the newest point). */
export function padLeft(arr, n) {
  const a = Array.isArray(arr) ? arr : [];
  return a.length >= n ? a.slice(a.length - n) : [...new Array(n - a.length).fill(null), ...a];
}

/** Time labels for a series that ends at `endIso` with `step` seconds between points. */
export function timeLabels(endIso, step, n) {
  const end = Date.parse(endIso) || Date.now();
  return Array.from({ length: n }, (_, k) => new Date(end - (n - 1 - k) * step * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
}

/** Verdict for the browser-side balance test (same idea as the server's: compare each instance with an even split). */
export function verdictFor(counts, thresholds) {
  const ids = Object.keys(counts);
  const total = ids.reduce((a, k) => a + counts[k], 0);
  if (!total) return { level: "warn", text: "No answers came back." };
  if (ids.length === 1) return { level: "ok", text: "Every request was answered by the same instance: either there is only one, or the proxy keeps this browser on one instance (sticky sessions)." };
  const expected = 100 / ids.length;
  const worstId = ids.reduce((a, k) => (Math.abs((counts[k] / total) * 100 - expected) > Math.abs((counts[a] / total) * 100 - expected) ? k : a), ids[0]);
  const dev = Math.abs((counts[worstId] / total) * 100 - expected);
  const level = dev >= (thresholds?.imbalanceCritPts ?? 25) ? "crit" : dev >= (thresholds?.imbalanceWarnPts ?? 10) ? "warn" : "ok";
  const share = ((counts[worstId] / total) * 100).toFixed(0);
  return { level, text: level === "ok" ? `Evenly spread across ${ids.length} instances (largest deviation ${dev.toFixed(1)} points).` : `${worstId} answered ${share}% of the requests (an even split would be ${expected.toFixed(0)}%).` };
}
