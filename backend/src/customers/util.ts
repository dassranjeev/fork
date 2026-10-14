import { BadRequestException } from '@nestjs/common';

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s?: string | null): s is string => !!s && UUID_RE.test(s);

/** Query-string boolean: "true"/"1"/"yes" (implicit conversion would turn "false" into true, so query DTOs keep strings). */
export const parseBool = (v: unknown): boolean | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'boolean') return v;
  return ['true', '1', 'yes', 'on'].includes(String(v).toLowerCase());
};

export const csv = (v: unknown): string[] =>
  v === undefined || v === null || v === ''
    ? []
    : (Array.isArray(v) ? v : String(v).split(','))
        .map((s) => String(s).trim())
        .filter(Boolean);

export const num = (v: unknown): number | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

export function assertLatLng(lat?: number | null, lng?: number | null) {
  if (lat === undefined || lat === null || lng === undefined || lng === null) return;
  if (!(lat >= -90 && lat <= 90) || !(lng >= -180 && lng <= 180)) throw new BadRequestException('Invalid coordinates');
}

/** "Jane D." style name for lists shown to other customers. */
export const maskName = (first?: string | null, last?: string | null) => {
  const f = (first ?? '').trim();
  const l = (last ?? '').trim();
  return f ? `${f}${l ? ` ${l[0]}.` : ''}` : 'FORKY customer';
};

export const fullName = (u?: { firstName?: string | null; lastName?: string | null } | null) =>
  `${u?.firstName ?? ''} ${u?.lastName ?? ''}`.trim();

export const newId = () => require('crypto').randomUUID() as string;
