import { BadRequestException } from '@nestjs/common';

export const TZ = 'America/Toronto';

export const r2 = (n: number) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

export const money = (n: number) => `$${r2(n).toFixed(2)}`;

/** YYYY-MM-DD in Toronto for an instant. */
export function torontoDate(d: Date = new Date()): string {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  return p; // en-CA => YYYY-MM-DD
}

function tzOffsetMs(at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const g = (t: string) => Number(parts.find((x) => x.type === t)!.value);
  const asUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** Instant of 00:00 Toronto time on a YYYY-MM-DD date. */
export function torontoMidnight(date: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
  let res = new Date(guess.getTime() - tzOffsetMs(guess));
  res = new Date(guess.getTime() - tzOffsetMs(res));
  return res;
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** 0 = Sunday .. 6 = Saturday */
export function weekday(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Monday..Sunday week that ended before today (Toronto). */
export function previousWeek(now: Date = new Date()): { periodStart: string; periodEnd: string } {
  const today = torontoDate(now);
  const dow = weekday(today); // 0..6
  const mondayThis = addDays(today, -((dow + 6) % 7));
  return { periodStart: addDays(mondayThis, -7), periodEnd: addDays(mondayThis, -1) };
}

export function periodLabel(start: string, end: string): string {
  const f = (s: string) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(s + 'T00:00:00Z'));
  return start === end ? f(start) : `${f(start)} - ${f(end)}`;
}

export function assertDate(s: string | undefined, label: string): string {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new BadRequestException(`${label} must be YYYY-MM-DD`);
  return s;
}

/** Parse a query boolean ("true"/"1"/true). ValidationPipe implicit conversion turns "false" into true, so we take raw values as string. */
export function flag(v: any): boolean {
  return v === true || v === 'true' || v === '1' || v === 1;
}

export function csvCell(v: any): string {
  if (v === null || v === undefined) return '';
  let s = v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
  // guard against spreadsheet formula injection
  if (/^[=+@]/.test(s) || (/^-/.test(s) && Number.isNaN(Number(s)))) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: string[], rows: any[][]): string {
  return [headers.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\r\n') + '\r\n';
}

/** Rows returned by `UPDATE ... RETURNING` differ between typeorm/pg versions. */
export function returnedRows<T = any>(res: any): T[] {
  if (Array.isArray(res) && Array.isArray(res[0])) return res[0];
  return Array.isArray(res) ? res : [];
}

export function maskAccount(last4?: string | null) {
  return last4 ? `****${String(last4).slice(-4)}` : null;
}
