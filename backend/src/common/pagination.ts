import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { ObjectLiteral, SelectQueryBuilder } from 'typeorm';

/** Standard list query: ?page=1&limit=20&search=abc&sortBy=createdAt&sortDir=DESC */
export class PageQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number = 20;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsString()
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
  const sortCol = (q.sortBy && opts.sortable?.[q.sortBy]) || opts.defaultSort?.[0];
  if (sortCol) {
    const dir = (q.sortDir ? q.sortDir.toUpperCase() : opts.defaultSort?.[1] ?? 'DESC') as 'ASC' | 'DESC';
    qb.orderBy(sortCol, dir);
  }
  const [data, total] = await qb
    .skip((page - 1) * limit)
    .take(limit)
    .getManyAndCount();
  return { data, meta: pageMeta(total, page, limit) };
}

/** Escape % and _ for ILIKE. */
export const like = (s: string) => `%${s.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
