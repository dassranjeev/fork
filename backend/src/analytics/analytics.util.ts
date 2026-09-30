import { BadRequestException } from '@nestjs/common';
import { AuthUser } from '../common/auth.types';
import { AnalyticsFilterDto } from './analytics.dto';

export type GroupBy = 'day' | 'week' | 'month';

/** Resolved, scope-checked filter context shared by every query. null = unrestricted, [] = nothing visible. */
export interface Ctx {
  from: Date;
  to: Date; // exclusive
  prevFrom: Date;
  prevTo: Date;
  tz: string;
  groupBy: GroupBy;
  cityIds: string[] | null;
  zoneIds: string[] | null;
  restaurantIds: string[] | null;
  page: number;
  limit: number;
  sortBy?: string;
  sortDir: 'ASC' | 'DESC';
  search?: string;
  f: AnalyticsFilterDto;
}

/** Positional parameter collector for raw parameterised SQL. */
export class Params {
  v: any[] = [];
  add(x: any): string {
    this.v.push(x);
    return `$${this.v.length}`;
  }
}

export const DONE = `('DELIVERED','COLLECTED')`;
export const ACTIVE = `('PLACED','ACCEPTED','DRIVER_ASSIGNED','PREPARING','READY','PICKED_UP','ON_THE_WAY')`;
export const done = (a = 'o') => `${a}."status" IN ${DONE}`;
export const active = (a = 'o') => `${a}."status" IN ${ACTIVE}`;
/** Gross platform revenue of an order (commission + customer fees). */
export const revenueExpr = (a = 'o') => `(${a}."commissionAmount" + ${a}."deliveryFee" + ${a}."serviceFee" + ${a}."smallOrderFee")`;
/** "Order had an issue" = at least one support ticket or refund attached. */
export const hasIssue = (a = 'o') =>
  `(EXISTS (SELECT 1 FROM tickets t WHERE t."orderId" = ${a}.id) OR EXISTS (SELECT 1 FROM refunds rf WHERE rf."orderId" = ${a}.id))`;

export const r2 = (n: any) => (n === null || n === undefined || Number.isNaN(+n) ? null : Math.round(+n * 100) / 100);
export const pct = (a: number, b: number) => (b > 0 ? r2((a / b) * 100) : null);
export const div = (a: number, b: number) => (b > 0 ? r2(a / b) : null);
export const change = (cur: number | null, prev: number | null) =>
  cur === null || prev === null || prev === 0 ? null : r2(((cur - prev) / Math.abs(prev)) * 100);

export interface Kpi {
  value: number | null;
  previous: number | null;
  changePct: number | null;
}
export const kpi = (value: number | null, previous: number | null): Kpi => ({ value: r2(value), previous: r2(previous), changePct: change(value, previous) });

// ------------------------------------------------------------------ time zone helpers
const dtfCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string) {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    dtfCache.set(tz, f);
  }
  return f;
}

export function validTz(tz: string | undefined | null, fallback = 'America/Toronto'): string {
  try {
    if (tz) {
      fmt(tz);
      return tz;
    }
  } catch {
    /* fall through */
  }
  return fallback;
}

function tzOffsetMs(at: Date, tz: string) {
  const p: Record<string, string> = {};
  for (const part of fmt(tz).formatToParts(at)) p[part.type] = part.value;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** Local calendar date (YYYY-MM-DD) of an instant in tz. */
export function localDate(at: Date, tz: string): string {
  const p: Record<string, string> = {};
  for (const part of fmt(tz).formatToParts(at)) p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day}`;
}

export function localMinutes(at: Date, tz: string): number {
  const p: Record<string, string> = {};
  for (const part of fmt(tz).formatToParts(at)) p[part.type] = part.value;
  return +p.hour * 60 + +p.minute;
}

/** UTC instant of local wall-clock `minutes` after midnight of `dateStr` in tz. */
export function zonedInstant(dateStr: string, minutes: number, tz: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, minutes);
  let t = guess - tzOffsetMs(new Date(guess), tz);
  const off2 = tzOffsetMs(new Date(t), tz);
  t = guess - off2;
  return new Date(t);
}

export function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function dowOf(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Monday of the week containing dateStr. */
export function weekStart(dateStr: string): string {
  const dow = dowOf(dateStr);
  return addDays(dateStr, -((dow + 6) % 7));
}

export function startOfLocalDay(at: Date, tz: string): Date {
  return zonedInstant(localDate(at, tz), 0, tz);
}

export function parseRangeInput(v: string | undefined, tz: string, isEnd: boolean): Date | null {
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return zonedInstant(isEnd ? addDays(v, 1) : v, 0, tz);
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new BadRequestException(`Invalid date: ${v}`);
  return d;
}

/** Every bucket key (YYYY-MM-DD, local) between from and to for the given grouping. */
export function bucketKeys(from: Date, to: Date, tz: string, g: GroupBy): string[] {
  const out: string[] = [];
  let cur = localDate(from, tz);
  if (g === 'week') cur = weekStart(cur);
  if (g === 'month') cur = cur.slice(0, 8) + '01';
  const last = localDate(new Date(to.getTime() - 1), tz);
  let guard = 0;
  while (cur <= last && guard++ < 1000) {
    out.push(cur);
    if (g === 'day') cur = addDays(cur, 1);
    else if (g === 'week') cur = addDays(cur, 7);
    else {
      const [y, m] = cur.split('-').map(Number);
      cur = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
    }
  }
  return out;
}

/** Fill gaps: returns one row per bucket key using `zero` for missing buckets. */
export function fillSeries<T extends { bucket: string }>(keys: string[], rows: T[], zero: Omit<T, 'bucket'>): T[] {
  const m = new Map(rows.map((r) => [r.bucket, r]));
  return keys.map((k) => m.get(k) ?? ({ bucket: k, ...zero } as T));
}

// ------------------------------------------------------------------ SQL scope helpers
/** City / zone / restaurant conditions (no dates). `a` = orders alias. */
export function scopeConds(c: Ctx, p: Params, a = 'o'): string[] {
  const out: string[] = [];
  if (c.cityIds) out.push(`${a}."cityId" = ANY(${p.add(c.cityIds)}::uuid[])`);
  if (c.zoneIds) out.push(`${a}."zoneId" = ANY(${p.add(c.zoneIds)}::uuid[])`);
  if (c.restaurantIds) out.push(`${a}."restaurantId" = ANY(${p.add(c.restaurantIds)}::uuid[])`);
  return out;
}

export function rangeConds(p: Params, col: string, from: Date, to: Date): string[] {
  return [`${col} >= ${p.add(from)}`, `${col} < ${p.add(to)}`];
}

/** City / zone conditions for driver_profiles ("d" alias by default). */
export function driverScopeConds(c: Ctx, p: Params, a = 'd'): string[] {
  const out: string[] = [];
  if (c.cityIds) out.push(`${a}."cityId" = ANY(${p.add(c.cityIds)}::uuid[])`);
  if (c.zoneIds) out.push(`${a}."activeZoneId" = ANY(${p.add(c.zoneIds)}::uuid[])`);
  return out;
}

export function bucketExpr(c: Ctx, p: Params, col: string, g: GroupBy = c.groupBy): string {
  return `to_char(date_trunc('${g}', ${col} AT TIME ZONE ${p.add(c.tz)}::text), 'YYYY-MM-DD')`;
}

export const WHERE = (conds: string[]) => (conds.length ? `WHERE ${conds.join(' AND ')}` : '');

/** Intersect a requested id with the user's scope. */
export function intersectScope(requested: string | undefined, scope: string[] | undefined): string[] | null {
  const s = scope && scope.length ? scope : null;
  if (requested) return s && !s.includes(requested) ? [] : [requested];
  return s;
}

export function scopeOf(user?: AuthUser) {
  return { cities: user?.scopeCityIds, zones: user?.scopeZoneIds };
}

/** Plain SQL rows -> numbers where pg returned numeric strings for known numeric keys. */
export function nums<T extends Record<string, any>>(row: T | undefined, keys: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of keys) out[k] = row && row[k] !== null && row[k] !== undefined ? +row[k] : 0;
  return out;
}

/** Safe sort column selection from a whitelist. */
export function orderBy(c: Ctx, map: Record<string, string>, def: string, defDir: 'ASC' | 'DESC' = 'DESC'): string {
  const col = (c.sortBy && map[c.sortBy]) || map[def];
  const dir = c.sortBy && map[c.sortBy] ? c.sortDir : defDir;
  return `ORDER BY ${col} ${dir} NULLS LAST`;
}

export function paged<T>(rows: T[], total: number, c: Ctx) {
  return { data: rows, meta: { page: c.page, limit: c.limit, total, totalPages: Math.max(1, Math.ceil(total / c.limit)) } };
}
