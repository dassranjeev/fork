import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';
import { AuditLog } from '../database/entities';
import { AuthUser } from '../common/auth.types';
import { PageQueryDto, paginateQb } from '../common/pagination';

const SENSITIVE = /password|secret|token|otp|pin|apikey|api_key|authorization|cvc|card/i;

export function redact(obj: any, depth = 0): any {
  if (obj === null || obj === undefined) return obj;
  if (depth > 5) return '[depth]';
  if (Array.isArray(obj)) return obj.slice(0, 50).map((v) => redact(v, depth + 1));
  if (typeof obj === 'object') {
    if (obj instanceof Date) return obj;
    const out: any = {};
    for (const [k, v] of Object.entries(obj)) out[k] = SENSITIVE.test(k) ? '[REDACTED]' : redact(v, depth + 1);
    return out;
  }
  if (typeof obj === 'string' && obj.length > 2000) return obj.slice(0, 2000) + '...';
  return obj;
}

export interface AuditInput {
  actor?: Partial<AuthUser> | null;
  action: string; // e.g. 'restaurant.approve'
  entity?: string;
  entityId?: string;
  before?: any;
  after?: any;
  ip?: string;
  userAgent?: string;
  path?: string;
  method?: string;
}

/**
 * Non-editable audit trail. Call AuditService.log() for every sensitive action
 * (who changed what, when, from which IP). Failures never break the request.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(@InjectRepository(AuditLog) private repo: Repository<AuditLog>) {}

  async log(input: AuditInput): Promise<void> {
    try {
      await this.repo.insert({
        actorId: input.actor?.id ?? null,
        actorEmail: input.actor?.email ?? null,
        actorType: input.actor?.type ?? 'SYSTEM',
        actorRole: input.actor?.impersonatedBy
          ? `${input.actor?.roleName ?? input.actor?.restaurantRole ?? 'user'} [impersonated by ${input.actor.impersonatedBy}]`
          : (input.actor?.roleName ?? null),
        action: input.action,
        entity: input.entity ?? null,
        entityId: input.entityId ?? null,
        before: input.before === undefined ? null : redact(input.before),
        after: input.after === undefined ? null : redact(input.after),
        ip: input.ip ?? null,
        userAgent: input.userAgent?.slice(0, 250) ?? null,
        path: input.path ?? null,
        method: input.method ?? null,
      });
    } catch (e: any) {
      this.logger.error(`audit write failed: ${e.message}`);
    }
  }

  /** Convenience: log with request context. */
  logReq(req: any, action: string, entity?: string, entityId?: string, before?: any, after?: any) {
    return this.log({
      actor: req?.user,
      action,
      entity,
      entityId,
      before,
      after,
      ip: (req?.headers?.['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req?.ip,
      userAgent: req?.headers?.['user-agent'],
      path: req?.originalUrl,
      method: req?.method,
    });
  }

  async search(
    q: PageQueryDto & {
      actorId?: string;
      action?: string;
      entity?: string;
      entityId?: string;
      from?: string;
      to?: string;
    },
  ) {
    const qb = this.repo.createQueryBuilder('a');
    if (q.actorId) qb.andWhere('a.actorId = :actorId', { actorId: q.actorId });
    if (q.action) qb.andWhere('a.action ILIKE :action', { action: `%${q.action}%` });
    if (q.entity) qb.andWhere('a.entity = :entity', { entity: q.entity });
    if (q.entityId) qb.andWhere('a.entityId = :entityId', { entityId: q.entityId });
    if (q.from) qb.andWhere('a.createdAt >= :from', { from: q.from });
    if (q.to) qb.andWhere('a.createdAt <= :to', { to: q.to });
    if (q.search) {
      qb.andWhere(
        new Brackets((b) =>
          b
            .where('a.actorEmail ILIKE :s', { s: `%${q.search}%` })
            .orWhere('a.action ILIKE :s', { s: `%${q.search}%` })
            .orWhere('a.entityId ILIKE :s', { s: `%${q.search}%` })
            .orWhere('a.ip ILIKE :s', { s: `%${q.search}%` }),
        ),
      );
    }
    return paginateQb(qb, q, {
      sortable: { createdAt: 'a.createdAt', action: 'a.action', actorEmail: 'a.actorEmail' },
      defaultSort: ['a.createdAt', 'DESC'],
    });
  }
}
