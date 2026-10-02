import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ObjectLiteral, SelectQueryBuilder } from 'typeorm';

/** Standard list query: ?page=1&limit=20&search=abc&sortBy=createdAt&sortDir=DESC */
export class PageQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_000) // deep offsets are a cheap DoS (OFFSET n scans n rows)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number = 20;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  sortBy?: string;

  @IsOptional()
  @IsIn(['ASC', 'DESC', 'asc', 'desc'])
  sortDir?: string;
}

export interface Paginated<T> {
  data: T[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}

export function pageMeta(total: number, page = 1, limit = 20) {
  return { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
}

/**
 * Run a query builder with pagination + safe sorting.
 * @param sortable whitelist of `alias.column` strings that may be used in sortBy (mapped by short name).
 */
export async function paginateQb<T extends ObjectLiteral>(
  qb: SelectQueryBuilder<T>,
  q: PageQueryDto,
  opts: { sortable?: Record<string, string>; defaultSort?: [string, 'ASC' | 'DESC'] } = {},
): Promise<Paginated<T>> {
  const page = q.page ?? 1;
  const limit = q.limit ?? 20;
  // own-property lookup: sortBy=constructor / __proto__ must not resolve to inherited object members
  const sortCol = (q.sortBy && opts.sortable && Object.prototype.hasOwnProperty.call(opts.sortable, q.sortBy) ? opts.sortable[q.sortBy] : undefined) || opts.defaultSort?.[0];
  if (sortCol) {
    // anything other than ASC / DESC falls back to the default direction (never reaches the ORDER BY clause)
    const want = String(q.sortDir ?? '').toUpperCase();
    const dir: 'ASC' | 'DESC' = want === 'ASC' || want === 'DESC' ? want : opts.defaultSort?.[1] ?? 'DESC';
    qb.orderBy(sortCol, dir);
  }
  const [data, total] = await qb
    .skip((page - 1) * limit)
    .take(limit)
    .getManyAndCount();
  return { data, meta: pageMeta(total, page, limit) };
}

/** Escape % and _ for ILIKE. */
export const like = (s: string) => `%${String(s).slice(0, 100).replace(/[%_\\]/g, (m) => `\\${m}`)}%`;

/** Safe ?page / ?limit parsing for handlers that take raw query strings. */
export function clampPaging(page?: string | number, limit?: string | number, maxLimit = 100, dflt = 20): { page: number; limit: number } {
  const p = Math.trunc(Number(page));
  const l = Math.trunc(Number(limit));
  return { page: Number.isFinite(p) && p >= 1 ? Math.min(p, 10_000) : 1, limit: Number.isFinite(l) && l >= 1 ? Math.min(l, maxLimit) : dflt };
}
