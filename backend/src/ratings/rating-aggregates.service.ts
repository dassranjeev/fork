import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { OnEvent } from '@nestjs/event-emitter';
import { Cron } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { DriverProfile, Restaurant, Review } from '../database/entities';
import { Events, ReviewCreatedEvent } from '../common/contracts';
import { SettingsService } from '../settings/settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ReviewCasesService } from '../support/review-cases.service';
import {
  DEFAULT_RATING_CONFIG,
  RatingConfig,
  REVIEW_TAG_SETS,
  TagCount,
  canonTag,
  round,
  smooth,
  tagLabel,
} from './ratings.constants';

export interface AlertConfig {
  driver: { warn: number; review: number; min: number };
  restaurant: { warn: number; min: number };
}

export interface AlertTransition {
  kind: 'DRIVER' | 'RESTAURANT';
  id: string;
  prev: string | null;
  next: string | null;
  avg30: number | null;
  n30: number;
}

export interface RatingStats {
  all: { count: number; avg: number | null; smoothed: number };
  rolling: { days: number; count: number; avg: number | null; smoothed: number };
  last30: { count: number; avg: number | null };
  distribution: Record<'1' | '2' | '3' | '4' | '5', number>;
  positiveTags: TagCount[];
  negativeTags: TagCount[];
  updatedAt: string;
}

const KINDS = {
  RESTAURANT: { table: Restaurant, rating: 'restaurantRating', tags: 'restaurantTags', target: 'restaurantId', tagKind: 'restaurant' as const },
  DRIVER: { table: DriverProfile, rating: 'driverRating', tags: 'driverTags', target: 'driverId', tagKind: 'driver' as const },
};
const STATUS_COL = { RESTAURANT: 'status', DRIVER: 'driverStatus' };

/**
 * Recomputes the rating columns of restaurants and/or drivers from VISIBLE Review rows only
 * (hidden and flagged reviews never count). Pass ids to limit the work, or omit both to recompute every target
 * that has (or had) reviews. Shared by the live listener, the nightly job, the seeds and the tests.
 *
 *   Restaurant/DriverProfile.rating        = smoothed rolling window (default 90 days)  <- every existing reader (discovery, analytics, dispatch)
 *   Restaurant/DriverProfile.ratingCount   = number of visible reviews, all time
 *   ratingAllTime / rating90d / ratingCount90d / rating30d (raw) / ratingCount30d / ratingStats (distribution, top tags)
 *
 * Smoothing: smooth(sum, n, prior, m) = (m x prior + sum) / (m + n), m = ratings.priorWeight (10).
 *   all-time  = smooth(all stars, platform prior mean)
 *   rolling   = smooth(stars in window, n in window, prior = smoothed value of the reviews OLDER than the window)
 *               - recent reviews dominate, but a quiet period falls back to the long-run record, never to zero.
 * With `alerts` supplied, ratingAlert is maintained and the state transitions are returned.
 */
export async function recomputeRatingAggregates(
  em: EntityManager | DataSource,
  ids: { restaurantIds?: string[]; driverIds?: string[] } = {},
  opts: { cfg?: RatingConfig; alerts?: AlertConfig; now?: Date } = {},
): Promise<AlertTransition[]> {
  const cfg = opts.cfg ?? DEFAULT_RATING_CONFIG;
  const transitions: AlertTransition[] = [];
  const all = !ids.restaurantIds && !ids.driverIds;
  if (all || ids.restaurantIds?.length) transitions.push(...(await recomputeKind(em, 'RESTAURANT', ids.restaurantIds, cfg, opts.alerts, opts.now)));
  if (all || ids.driverIds?.length) transitions.push(...(await recomputeKind(em, 'DRIVER', ids.driverIds, cfg, opts.alerts, opts.now)));
  return transitions;
}

async function recomputeKind(
  em: EntityManager | DataSource,
  kind: 'RESTAURANT' | 'DRIVER',
  only: string[] | undefined,
  cfg: RatingConfig,
  alerts: AlertConfig | undefined,
  nowIn?: Date,
): Promise<AlertTransition[]> {
  const k = KINDS[kind];
  const reviews = em.getRepository(Review).metadata.tableName;
  const table = em.getRepository(k.table as any).metadata.tableName;
  const statusCol = STATUS_COL[kind];
  const now = nowIn ?? new Date();
  const rollFrom = new Date(now.getTime() - cfg.rollingDays * 86400_000);
  const from30 = new Date(now.getTime() - 30 * 86400_000);
  const prior = kind === 'DRIVER' ? cfg.driverPriorMean : cfg.restaurantPriorMean;
  const m = cfg.priorWeight;
  const idFilter = only ? ` AND "${k.target}" = ANY($3::uuid[])` : '';
  const params: any[] = [rollFrom, from30, ...(only ? [only] : [])];

  const rows: any[] = await em.query(
    `SELECT "${k.target}" AS id,
            COUNT(*)::int AS n, COALESCE(SUM("${k.rating}"), 0)::int AS s,
            COUNT(*) FILTER (WHERE "createdAt" >= $1)::int AS n90, COALESCE(SUM("${k.rating}") FILTER (WHERE "createdAt" >= $1), 0)::int AS s90,
            COUNT(*) FILTER (WHERE "createdAt" >= $2)::int AS n30, COALESCE(SUM("${k.rating}") FILTER (WHERE "createdAt" >= $2), 0)::int AS s30,
            COUNT(*) FILTER (WHERE "${k.rating}" = 1)::int AS d1, COUNT(*) FILTER (WHERE "${k.rating}" = 2)::int AS d2,
            COUNT(*) FILTER (WHERE "${k.rating}" = 3)::int AS d3, COUNT(*) FILTER (WHERE "${k.rating}" = 4)::int AS d4,
            COUNT(*) FILTER (WHERE "${k.rating}" = 5)::int AS d5
     FROM "${reviews}"
     WHERE "${k.rating}" IS NOT NULL AND "${k.target}" IS NOT NULL AND "${statusCol}" = 'VISIBLE'${idFilter}
     GROUP BY "${k.target}"`,
    params,
  );
  const tagRows: any[] = await em.query(
    `SELECT "${k.target}" AS id, t.tag AS tag, COUNT(*)::int AS c
     FROM "${reviews}", jsonb_array_elements_text(CASE WHEN jsonb_typeof("${k.tags}") = 'array' THEN "${k.tags}" ELSE '[]'::jsonb END) AS t(tag)
     WHERE "${k.rating}" IS NOT NULL AND "${k.target}" IS NOT NULL AND "${statusCol}" = 'VISIBLE' AND "createdAt" >= $1${only ? ` AND "${k.target}" = ANY($2::uuid[])` : ''}
     GROUP BY 1, 2`,
    only ? [rollFrom, only] : [rollFrom],
  );
  const sets = REVIEW_TAG_SETS[k.tagKind];
  const tagsByTarget = new Map<string, { positive: Map<string, number>; negative: Map<string, number> }>();
  for (const t of tagRows) {
    const code = canonTag(t.tag);
    const bucket = sets.positive.has(code) ? 'positive' : sets.negative.has(code) ? 'negative' : null;
    if (!bucket) continue;
    const e = tagsByTarget.get(t.id) ?? { positive: new Map(), negative: new Map() };
    e[bucket].set(code, (e[bucket].get(code) ?? 0) + t.c);
    tagsByTarget.set(t.id, e);
  }
  const top = (mp: Map<string, number> | undefined): TagCount[] =>
    [...(mp?.entries() ?? [])].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([tag, count]) => ({ tag, label: tagLabel(k.tagKind, tag), count }));

  const prevAlerts = new Map<string, string | null>();
  if (alerts) {
    const pr: any[] = await em.query(`SELECT id, "ratingAlert" FROM "${table}"${only ? ' WHERE id = ANY($1::uuid[])' : ''}`, only ? [only] : []);
    for (const p of pr) prevAlerts.set(p.id, p.ratingAlert ?? null);
  }

  const transitions: AlertTransition[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    seen.add(r.id);
    const allSm = smooth(r.s, r.n, prior, m);
    const nOld = r.n - r.n90;
    const sOld = r.s - r.s90;
    const histSm = smooth(sOld, nOld, prior, m);
    const rollSm = smooth(r.s90, r.n90, histSm, m);
    const tg = tagsByTarget.get(r.id);
    const stats: RatingStats = {
      all: { count: r.n, avg: round(r.s / r.n, 3), smoothed: round(allSm, 3) },
      rolling: { days: cfg.rollingDays, count: r.n90, avg: r.n90 ? round(r.s90 / r.n90, 3) : null, smoothed: round(rollSm, 3) },
      last30: { count: r.n30, avg: r.n30 ? round(r.s30 / r.n30, 3) : null },
      distribution: { '1': r.d1, '2': r.d2, '3': r.d3, '4': r.d4, '5': r.d5 },
      positiveTags: top(tg?.positive),
      negativeTags: top(tg?.negative),
      updatedAt: now.toISOString(),
    };
    const avg30 = r.n30 ? r.s30 / r.n30 : null;
    let alertSql = '';
    const args: any[] = [r.id, round(rollSm, 3), r.n, round(allSm, 3), r.n90, avg30 == null ? null : round(avg30, 3), r.n30, JSON.stringify(stats)];
    if (alerts) {
      const next = nextAlert(kind, avg30, r.n30, alerts);
      const prev = prevAlerts.get(r.id) ?? null;
      alertSql = `, "ratingAlert" = $9`;
      args.push(next);
      if (next !== prev) transitions.push({ kind, id: r.id, prev, next, avg30, n30: r.n30 });
    }
    await em.query(
      `UPDATE "${table}" SET "rating" = $2, "rating90d" = $2, "ratingCount" = $3, "ratingAllTime" = $4, "ratingCount90d" = $5, "rating30d" = $6, "ratingCount30d" = $7, "ratingStats" = $8::jsonb${alertSql} WHERE id = $1`,
      args,
    );
  }

  // targets that had ratings before but now have no visible review (everything hidden/flagged): fall back to the prior
  const stale: any[] = await em.query(
    `SELECT id FROM "${table}" WHERE ("ratingAllTime" IS NOT NULL OR "ratingCount" > 0)${only ? ' AND id = ANY($1::uuid[])' : ''}`,
    only ? [only] : [],
  );
  for (const s of stale) {
    if (seen.has(s.id)) continue;
    const stats = { all: { count: 0, avg: null, smoothed: round(prior, 3) }, rolling: { days: cfg.rollingDays, count: 0, avg: null, smoothed: round(prior, 3) }, last30: { count: 0, avg: null }, distribution: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 }, positiveTags: [], negativeTags: [], updatedAt: now.toISOString() };
    await em.query(
      `UPDATE "${table}" SET "rating" = $2, "rating90d" = $2, "ratingCount" = 0, "ratingAllTime" = $2, "ratingCount90d" = 0, "rating30d" = NULL, "ratingCount30d" = 0, "ratingStats" = $3::jsonb${alerts ? ', "ratingAlert" = NULL' : ''} WHERE id = $1`,
      [s.id, round(prior, 3), JSON.stringify(stats)],
    );
    if (alerts && (prevAlerts.get(s.id) ?? null) !== null) transitions.push({ kind, id: s.id, prev: prevAlerts.get(s.id) ?? null, next: null, avg30: null, n30: 0 });
  }
  return transitions;
}

/** WARN / REVIEW / null from the raw 30-day average (the minimum count is the fairness guard, not extra smoothing). */
export function nextAlert(kind: 'DRIVER' | 'RESTAURANT', avg30: number | null, n30: number, a: AlertConfig): string | null {
  if (avg30 == null) return null;
  if (kind === 'DRIVER') {
    if (n30 < a.driver.min) return null;
    if (avg30 < a.driver.review) return 'REVIEW';
    if (avg30 < a.driver.warn) return 'WARN';
    return null;
  }
  if (n30 < a.restaurant.min) return null;
  return avg30 < a.restaurant.warn ? 'WARN' : null;
}

/** Keeps rating aggregates fresh (events + nightly job) and fires the threshold consequences. */
@Injectable()
export class RatingAggregatesService {
  private readonly logger = new Logger(RatingAggregatesService.name);

  constructor(
    @InjectDataSource() private ds: DataSource,
    private settings: SettingsService,
    private notifications: NotificationsService,
    private moduleRef: ModuleRef,
  ) {}

  config(): RatingConfig {
    const s = this.settings;
    return {
      priorWeight: s.get('ratings.priorWeight', 10),
      restaurantPriorMean: s.get('ratings.restaurant.priorMean', 4.3),
      driverPriorMean: s.get('ratings.driver.priorMean', 4.7),
      rollingDays: s.get('ratings.rollingDays', 90),
      minCountToShow: s.get('ratings.minCountToShow', 5),
    };
  }

  alertConfig(): AlertConfig {
    const s = this.settings;
    return {
      driver: { warn: s.get('ratings.driver.warnBelow', 4.5), review: s.get('ratings.driver.reviewBelow', 4.2), min: s.get('ratings.driver.minRatings', 20) },
      restaurant: { warn: s.get('ratings.restaurant.warnBelow', 4.0), min: s.get('ratings.restaurant.minRatings', 20) },
    };
  }

  /** Recompute + run the threshold consequences. Never throws. */
  async refresh(ids: { restaurantIds?: string[]; driverIds?: string[] } = {}): Promise<void> {
    try {
      const t = await recomputeRatingAggregates(this.ds, ids, { cfg: this.config(), alerts: this.alertConfig() });
      for (const x of t) await this.onTransition(x);
    } catch (err) {
      this.logger.warn(`rating aggregate update failed: ${(err as Error).message}`);
    }
  }

  @OnEvent(Events.REVIEW_CREATED, { async: true })
  async onReviewCreated(e: ReviewCreatedEvent): Promise<void> {
    await this.refreshForReview(e.restaurantId, e.driverId, e.orderId);
  }

  /** Emitted on edit / hide / restore / flag. */
  @OnEvent('review.updated', { async: true })
  async onReviewUpdated(e: ReviewCreatedEvent): Promise<void> {
    await this.refreshForReview(e.restaurantId, e.driverId, e.orderId);
  }

  private async refreshForReview(restaurantId?: string | null, driverId?: string | null, orderId?: string) {
    if ((!restaurantId || driverId === undefined) && orderId) {
      const [o] = await this.ds.query(`SELECT "restaurantId", "driverId" FROM orders WHERE id = $1`, [orderId]);
      restaurantId = restaurantId || o?.restaurantId;
      if (driverId === undefined) driverId = o?.driverId ?? null;
    }
    await this.refresh({ restaurantIds: restaurantId ? [restaurantId] : [], driverIds: driverId ? [driverId] : [] });
  }

  /** Nightly full recompute: rolling windows slide even when nobody posts a review. */
  @Cron('0 3 * * *')
  async nightly(): Promise<void> {
    await this.refresh();
    this.logger.log('nightly rating recompute done');
  }

  // ------------------------------------------------------------------ consequences
  private async topNegative(kind: 'DRIVER' | 'RESTAURANT', id: string): Promise<string[]> {
    const k = KINDS[kind];
    const rows: any[] = await this.ds.query(
      `SELECT t.tag, COUNT(*)::int c FROM reviews, jsonb_array_elements_text(CASE WHEN jsonb_typeof("${k.tags}") = 'array' THEN "${k.tags}" ELSE '[]'::jsonb END) t(tag)
       WHERE "${k.target}" = $1 AND "${STATUS_COL[kind]}" = 'VISIBLE' AND "createdAt" >= now() - interval '30 days' GROUP BY 1 ORDER BY 2 DESC`,
      [id],
    );
    const neg = REVIEW_TAG_SETS[k.tagKind].negative;
    return rows.filter((r) => neg.has(canonTag(r.tag))).slice(0, 3).map((r) => tagLabel(k.tagKind, canonTag(r.tag)).toLowerCase());
  }

  private async onTransition(t: AlertTransition): Promise<void> {
    const worse = (t.next === 'REVIEW' && t.prev !== 'REVIEW') || (t.next === 'WARN' && t.prev === null);
    if (!worse) return; // recovering or unchanged: state saved, no message
    const a = this.alertConfig();
    const rating = t.avg30 != null ? round(t.avg30, 2) : '';
    if (t.kind === 'DRIVER') {
      const [d] = await this.ds.query(`SELECT d."userId", u."firstName", u."lastName" FROM driver_profiles d JOIN users u ON u.id = d."userId" WHERE d.id = $1`, [t.id]);
      if (!d) return;
      const neg = await this.topNegative('DRIVER', t.id);
      const coaching = neg.length ? `Customers mentioned most often: ${neg.join(', ')}. Small changes here move your rating quickly.` : 'Review your recent trips for ways to improve the customer experience.';
      const subject = `${d.firstName} ${d.lastName}`.trim();
      await this.notifications.notify({ userId: d.userId, audience: 'DRIVER', event: 'rating.driver_warn', vars: { rating, count: t.n30, coaching }, data: { driverId: t.id, state: t.next } });
      await this.notifications.notifyOps('rating.driver_warn', { subject, rating, count: t.n30, threshold: t.next === 'REVIEW' ? a.driver.review : a.driver.warn }, { driverId: t.id, state: t.next });
      if (t.next === 'REVIEW') {
        try {
          // SOP-08: the existing detector proposes the case (rolling-30-day rating is one of its triggers)
          await this.moduleRef.get(ReviewCasesService, { strict: false }).runDetector();
        } catch (err) {
          this.logger.warn(`SOP-08 detector run failed: ${(err as Error).message}`);
        }
      }
    } else {
      const [r] = await this.ds.query(`SELECT r.id, r.name, r."merchantId" FROM restaurants r WHERE r.id = $1`, [t.id]);
      if (!r) return;
      const neg = await this.topNegative('RESTAURANT', t.id);
      const coaching = neg.length ? `Customers mentioned most often: ${neg.join(', ')}.` : 'Read the recent reviews in the Reviews page for details.';
      const owners: any[] = await this.ds.query(`SELECT DISTINCT "userId" FROM restaurant_members WHERE "merchantId" = $1 AND role = 'OWNER' AND active = true`, [r.merchantId]);
      await Promise.all(owners.map((o) => this.notifications.notify({ userId: o.userId, audience: 'RESTAURANT', event: 'rating.restaurant_warn', vars: { subject: r.name, rating, count: t.n30, coaching }, data: { restaurantId: t.id } })));
      await this.notifications.notifyOps('rating.restaurant_warn', { subject: r.name, rating, count: t.n30, threshold: a.restaurant.warn }, { restaurantId: t.id });
    }
  }
}
