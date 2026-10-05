import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Review } from '../database/entities';
import { AuthUser } from '../common/auth.types';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RatingAggregatesService } from './rating-aggregates.service';
import { FLAG, ratingDisplay, round } from './ratings.constants';

type Side = 'RESTAURANT' | 'DRIVER';
type Action = 'HIDE' | 'FLAG' | 'RESTORE';
const TO_STATUS: Record<Action, 'HIDDEN' | 'FLAGGED' | 'VISIBLE'> = { HIDE: 'HIDDEN', FLAG: 'FLAGGED', RESTORE: 'VISIBLE' };

@Injectable()
export class RatingsAdminService {
  constructor(
    @InjectDataSource() private ds: DataSource,
    private audit: AuditService,
    private settings: SettingsService,
    private notifications: NotificationsService,
    private aggregates: RatingAggregatesService,
  ) {}

  // ------------------------------------------------------------------ staff moderation
  /** HIDE / FLAG / RESTORE one side of a review (reason required, audit-logged). Aggregates update immediately. */
  async moderate(reviewId: string, side: Side, action: Action, reason: string, req: any) {
    if (!/^[0-9a-f-]{36}$/i.test(reviewId)) throw new NotFoundException('Review not found');
    const repo = this.ds.getRepository(Review);
    const rv = await repo.findOne({ where: { id: reviewId } });
    if (!rv) throw new NotFoundException('Review not found');
    const hasSide = side === 'RESTAURANT' ? rv.restaurantRating != null : rv.driverRating != null;
    if (!hasSide) throw new BadRequestException(`This review has no ${side.toLowerCase()} rating`);
    const reasonTrim = (reason ?? '').trim();
    if (reasonTrim.length < 3) throw new BadRequestException('A reason is required');
    const field = side === 'RESTAURANT' ? 'status' : 'driverStatus';
    const before = rv[field];
    const after = TO_STATUS[action];
    rv[field] = after;
    const actor = req?.user as AuthUser | undefined;
    rv.moderation = [...(rv.moderation ?? []), { side, action, reason: reasonTrim, byId: actor?.id ?? null, byName: actor?.name ?? null, at: new Date().toISOString() }];
    if (action === 'FLAG' && !rv.flagReasons.includes(FLAG.STAFF)) rv.flagReasons = [...rv.flagReasons, FLAG.STAFF];
    if (rv.status === 'VISIBLE' && (rv.driverStatus === 'VISIBLE' || rv.driverRating == null)) rv.flagReasons = [];
    await repo.save(rv);
    await this.audit.logReq(req, `review.${action.toLowerCase()}`, 'review', reviewId, { side, status: before }, { side, status: after, reason: reasonTrim });
    await this.aggregates.refresh(side === 'RESTAURANT' ? { restaurantIds: [rv.restaurantId] } : { driverIds: rv.driverId ? [rv.driverId] : [] });
    return { id: rv.id, side, status: after, moderation: rv.moderation };
  }

  // ------------------------------------------------------------------ restaurant reports an abusive review
  async report(reviewId: string, restaurantIds: string[], reason: string, actor: AuthUser) {
    const repo = this.ds.getRepository(Review);
    const rv = /^[0-9a-f-]{36}$/i.test(reviewId) ? await repo.findOne({ where: { id: reviewId } }) : null;
    if (!rv || !restaurantIds.includes(rv.restaurantId) || rv.restaurantRating == null) throw new NotFoundException('Review not found');
    if (rv.reportedAt) throw new ConflictException('This review was already reported');
    if (rv.status === 'HIDDEN') throw new BadRequestException('This review is already hidden');
    const cap = this.settings.get<number>('ratings.restaurant.maxReportsPer30d', 10);
    const [{ n }] = await this.ds.query(`SELECT COUNT(*)::int n FROM reviews WHERE "restaurantId" = $1 AND "reportedAt" >= now() - interval '30 days'`, [rv.restaurantId]);
    if (n >= cap) throw new BadRequestException(`You can report at most ${cap} reviews per 30 days. Contact support for more.`);
    rv.reportedAt = new Date();
    rv.reportedById = actor.id;
    rv.reportReason = reason.trim();
    if (rv.status === 'VISIBLE') rv.status = 'FLAGGED';
    if (!rv.flagReasons.includes(FLAG.REPORTED)) rv.flagReasons = [...rv.flagReasons, FLAG.REPORTED];
    await repo.save(rv);
    await this.audit.log({ actor, action: 'review.report', entity: 'review', entityId: reviewId, after: { reason: rv.reportReason } });
    const [r] = await this.ds.query(`SELECT name FROM restaurants WHERE id = $1`, [rv.restaurantId]);
    await this.notifications.notifyOps('review.reported', { subject: r?.name ?? 'A restaurant', reason: rv.reportReason }, { reviewId, restaurantId: rv.restaurantId });
    await this.aggregates.refresh({ restaurantIds: [rv.restaurantId] });
    return { id: rv.id, reported: true, status: rv.status };
  }

  // ------------------------------------------------------------------ summaries
  private async trend(kind: Side, id: string, weeks: number) {
    const col = kind === 'RESTAURANT' ? 'restaurantRating' : 'driverRating';
    const tgt = kind === 'RESTAURANT' ? 'restaurantId' : 'driverId';
    const st = kind === 'RESTAURANT' ? 'status' : 'driverStatus';
    const rows: any[] = await this.ds.query(
      `SELECT to_char(date_trunc('week', "createdAt"), 'YYYY-MM-DD') AS week, COUNT(*)::int AS count, ROUND(AVG("${col}")::numeric, 2)::float AS avg
       FROM reviews WHERE "${tgt}" = $1 AND "${col}" IS NOT NULL AND "${st}" = 'VISIBLE' AND "createdAt" >= date_trunc('week', now()) - ($2 || ' weeks')::interval
       GROUP BY 1 ORDER BY 1`,
      [id, String(weeks)],
    );
    return rows;
  }

  private shapeAggregate(row: any) {
    const cfgMin = this.settings.get<number>('ratings.minCountToShow', 5);
    const s = row.ratingStats ?? {};
    const disp = ratingDisplay(row.rating, row.ratingCount, cfgMin);
    return {
      rating: disp.rating,
      ratingLabel: disp.ratingLabel,
      ratingCount: row.ratingCount,
      minCountToShow: cfgMin,
      smoothedRolling: row.rating == null ? null : round(Number(row.rating), 2),
      smoothedAllTime: row.ratingAllTime == null ? null : round(Number(row.ratingAllTime), 2),
      rawAverage: s.all?.avg ?? null,
      rolling: { days: s.rolling?.days ?? 90, count: row.ratingCount90d ?? 0, average: s.rolling?.avg ?? null, smoothed: s.rolling?.smoothed ?? null },
      last30: { count: row.ratingCount30d ?? 0, average: row.rating30d == null ? null : round(Number(row.rating30d), 2) },
      distribution: s.distribution ?? { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 },
      positiveTags: s.positiveTags ?? [],
      negativeTags: s.negativeTags ?? [],
      alert: row.ratingAlert ?? null,
      updatedAt: s.updatedAt ?? null,
    };
  }

  /** Portal Reviews header / admin restaurant Reviews tab. */
  async restaurantSummary(restaurantId: string, weeks = 12) {
    const [row] = await this.ds.query(
      `SELECT id, name, rating, "ratingCount", "ratingAllTime", "ratingCount90d", "rating30d", "ratingCount30d", "ratingStats", "ratingAlert" FROM restaurants WHERE id = $1`,
      [restaurantId],
    );
    if (!row) throw new NotFoundException('Restaurant not found');
    const [counts] = await this.ds.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'FLAGGED' AND "restaurantRating" IS NOT NULL)::int flagged, COUNT(*) FILTER (WHERE status = 'HIDDEN' AND "restaurantRating" IS NOT NULL)::int hidden,
              COUNT(*) FILTER (WHERE "restaurantRating" IS NOT NULL AND reply IS NOT NULL)::int replied, COUNT(*) FILTER (WHERE "restaurantRating" IS NOT NULL AND status <> 'HIDDEN')::int total
       FROM reviews WHERE "restaurantId" = $1`,
      [restaurantId],
    );
    return { restaurantId, name: row.name, ...this.shapeAggregate(row), flaggedCount: counts.flagged, hiddenCount: counts.hidden, repliedCount: counts.replied, totalReviews: counts.total, trend: await this.trend('RESTAURANT', restaurantId, Math.min(Math.max(weeks, 1), 52)) };
  }

  /** forStaff = admin Performance tab (review ids, status, full names of tags); otherwise the driver's own app view. */
  async driverSummary(driverId: string, forStaff: boolean, weeks = 12) {
    const [row] = await this.ds.query(
      `SELECT id, rating, "ratingCount", "ratingAllTime", "ratingCount90d", "rating30d", "ratingCount30d", "ratingStats", "ratingAlert" FROM driver_profiles WHERE id = $1`,
      [driverId],
    );
    if (!row) throw new NotFoundException('Driver not found');
    const recent: any[] = await this.ds.query(
      `SELECT rv.id, rv."driverRating" AS rating, rv."driverTags" AS tags, rv."driverComment" AS comment, rv."driverStatus" AS status, rv."flagReasons", rv.moderation, rv."createdAt", rv."orderId", o.code AS "orderCode",
              u."firstName" AS "firstName", u."lastName" AS "lastName"
       FROM reviews rv JOIN orders o ON o.id = rv."orderId" LEFT JOIN users u ON u.id = rv."customerId"
       WHERE rv."driverId" = $1 AND rv."driverRating" IS NOT NULL ${forStaff ? '' : `AND rv."driverStatus" = 'VISIBLE'`}
       ORDER BY rv."createdAt" DESC LIMIT ${forStaff ? 30 : 15}`,
      [driverId],
    );
    const base = { driverId, ...this.shapeAggregate(row), trend: await this.trend('DRIVER', driverId, Math.min(Math.max(weeks, 1), 52)) };
    if (forStaff) {
      return {
        ...base,
        recent: recent.map((r) => ({ id: r.id, rating: r.rating, tags: r.tags, comment: r.comment, status: r.status, flagReasons: r.flagReasons, moderation: r.moderation, createdAt: r.createdAt, orderId: r.orderId, orderCode: r.orderCode, customerName: `${r.firstName ?? ''} ${(r.lastName ?? '').slice(0, 1)}.`.trim() })),
      };
    }
    // driver app: customer first name only, no PII, no order ids; internal alert state stays private
    delete (base as any).alert;
    return { ...base, recent: recent.filter((r) => r.comment || r.rating).map((r) => ({ rating: r.rating, tags: r.tags, comment: r.comment, customer: r.firstName || 'Customer', createdAt: r.createdAt })) };
  }

  /** Flagged / hidden queue of driver-side reviews for staff (drivers:view). */
  async driverReviews(driverId: string, status?: string) {
    return this.ds.query(
      `SELECT rv.id, rv."driverRating" AS rating, rv."driverTags" AS tags, rv."driverComment" AS comment, rv."driverStatus" AS status, rv."flagReasons", rv.moderation, rv."createdAt", o.code AS "orderCode", rv."orderId"
       FROM reviews rv JOIN orders o ON o.id = rv."orderId" WHERE rv."driverId" = $1 AND rv."driverRating" IS NOT NULL ${status ? `AND rv."driverStatus" = $2` : ''} ORDER BY rv."createdAt" DESC LIMIT 100`,
      status ? [driverId, status] : [driverId],
    );
  }
}
