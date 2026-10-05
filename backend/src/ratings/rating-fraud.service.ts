import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { createHash } from 'crypto';
import { CustomerProfile, Review, User } from '../database/entities';
import { SettingsService } from '../settings/settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { FLAG, normaliseText } from './ratings.constants';

export const commentHashOf = (text?: string | null, minLen = 15): string | null => {
  const n = normaliseText(text ?? '');
  return n.length >= minLen ? createHash('md5').update(n).digest('hex') : null;
};

/**
 * Review-bombing / fraud protection. Suspicious reviews are FLAGGED (never deleted): a flagged side is excluded
 * from every public aggregate and list until staff RESTORE it. Staff decisions are final: once a review has been
 * restored by staff, the automatic rules do not flag it again.
 */
@Injectable()
export class RatingFraudService {
  private readonly logger = new Logger(RatingFraudService.name);

  constructor(
    @InjectDataSource() private ds: DataSource,
    private settings: SettingsService,
    private notifications: NotificationsService,
  ) {}

  /** Evaluates one review (after it was saved) and flags it - and any review in the same burst - when a rule fires. */
  async evaluate(review: Review): Promise<string[]> {
    if (!this.settings.get<boolean>('ratings.fraud.enabled', true)) return [];
    try {
      if ((review.moderation ?? []).some((m: any) => m.action === 'RESTORE')) return []; // staff already cleared it
      const reasons = new Set<string>();

      const [profile] = await this.ds.query(`SELECT "fraudFlag", "isBlocked" FROM customer_profiles WHERE "userId" = $1`, [review.customerId]);
      if (profile?.fraudFlag || profile?.isBlocked) reasons.add(FLAG.FRAUD_ACCOUNT);

      const burst = await this.burst(review);
      if (burst) reasons.add(FLAG.REVIEW_BOMB);

      if (await this.duplicateText(review)) reasons.add(FLAG.DUPLICATE_TEXT);
      if (await this.refundRetaliation(review)) reasons.add(FLAG.REFUND_RETALIATION);

      if (reasons.size) await this.flag([review.id], [...reasons], `${review.restaurantId}`);
      return [...reasons];
    } catch (e) {
      this.logger.warn(`fraud evaluation failed for review ${review.id}: ${(e as Error).message}`);
      return [];
    }
  }

  /** N+ one-star reviews on one target within a window, written by brand-new accounts. Flags the whole burst. */
  private async burst(review: Review): Promise<boolean> {
    const n = this.settings.get<number>('ratings.fraud.burstCount', 3);
    const hours = this.settings.get<number>('ratings.fraud.burstWindowHours', 24);
    const newDays = this.settings.get<number>('ratings.fraud.newAccountDays', 14);
    const since = new Date(Date.now() - hours * 3600_000);
    const newSince = new Date(Date.now() - newDays * 86400_000);
    const [author] = await this.ds.query(`SELECT "createdAt" FROM users WHERE id = $1`, [review.customerId]);
    if (!author || new Date(author.createdAt) < newSince) return false; // only new accounts count towards a burst
    let hit = false;
    const targets: { col: string; statusCol: string; id: string | null; rating: number | null }[] = [
      { col: 'restaurantId', statusCol: 'status', id: review.restaurantId, rating: review.restaurantRating },
      { col: 'driverId', statusCol: 'driverStatus', id: review.driverId, rating: review.driverRating },
    ];
    for (const t of targets) {
      if (!t.id || t.rating !== 1) continue;
      const rows: { id: string }[] = await this.ds.query(
        `SELECT rv.id FROM reviews rv JOIN users u ON u.id = rv."customerId"
         WHERE rv."${t.col}" = $1 AND rv."${t.col === 'restaurantId' ? 'restaurantRating' : 'driverRating'}" = 1 AND rv."createdAt" >= $2 AND u."createdAt" >= $3
           AND rv."${t.statusCol}" IN ('VISIBLE','FLAGGED')`,
        [t.id, since, newSince],
      );
      if (rows.length >= n) {
        hit = true;
        await this.flag(rows.map((r) => r.id), [FLAG.REVIEW_BOMB], t.id);
      }
    }
    return hit;
  }

  private async duplicateText(review: Review): Promise<boolean> {
    const minLen = this.settings.get<number>('ratings.fraud.duplicateMinLength', 15);
    const need = this.settings.get<number>('ratings.fraud.duplicateCount', 2);
    const hash = commentHashOf(review.comment, minLen);
    const since = new Date(Date.now() - 30 * 86400_000);
    if (hash) {
      const [{ n }] = await this.ds.query(
        `SELECT COUNT(*)::int n FROM reviews WHERE "commentHash" = $1 AND "createdAt" >= $2 AND (id <> $3) AND ("customerId" = $4 OR "restaurantId" = $5)`,
        [hash, since, review.id, review.customerId, review.restaurantId],
      );
      if (n + 1 >= need) return true;
    }
    const dc = normaliseText(review.driverComment ?? '');
    if (dc.length >= minLen && review.driverId) {
      const [{ n }] = await this.ds.query(
        `SELECT COUNT(*)::int n FROM reviews WHERE "createdAt" >= $1 AND id <> $2 AND "driverComment" IS NOT NULL AND lower(regexp_replace("driverComment", '\\s+', ' ', 'g')) = $3 AND ("customerId" = $4 OR "driverId" = $5)`,
        [since, review.id, dc, review.customerId, review.driverId],
      );
      if (n + 1 >= need) return true;
    }
    return false;
  }

  /** A low rating after the customer's refund request on the same order was rejected / closed without a refund. */
  private async refundRetaliation(review: Review): Promise<boolean> {
    const low = Math.min(review.restaurantRating ?? 5, review.driverRating ?? 5);
    if (low > 2) return false;
    const [{ rejected }] = await this.ds.query(`SELECT COUNT(*)::int rejected FROM refunds WHERE "orderId" = $1 AND status = 'REJECTED'`, [review.orderId]);
    if (rejected > 0) return true;
    const [{ dispute }] = await this.ds.query(
      `SELECT COUNT(*)::int dispute FROM tickets t WHERE t."orderId" = $1 AND t."requesterId" = $2 AND t.status IN ('RESOLVED','CLOSED')
         AND NOT EXISTS (SELECT 1 FROM refunds r WHERE r."orderId" = t."orderId" AND r.status IN ('PROCESSED','APPROVED','PENDING_APPROVAL'))`,
      [review.orderId, review.customerId],
    );
    return dispute > 0;
  }

  /** Marks the VISIBLE sides of the given reviews FLAGGED and records why. HIDDEN stays HIDDEN. */
  async flag(reviewIds: string[], reasons: string[], subject: string): Promise<void> {
    if (!reviewIds.length) return;
    const changed: { id: string }[] = await this.ds.query(
      `UPDATE reviews SET
         status = CASE WHEN status = 'VISIBLE' AND "restaurantRating" IS NOT NULL THEN 'FLAGGED' ELSE status END,
         "driverStatus" = CASE WHEN "driverStatus" = 'VISIBLE' AND "driverRating" IS NOT NULL THEN 'FLAGGED' ELSE "driverStatus" END,
         "flagReasons" = (SELECT COALESCE(jsonb_agg(DISTINCT x), '[]'::jsonb) FROM jsonb_array_elements_text("flagReasons" || $2::jsonb) x)
       WHERE id = ANY($1::uuid[]) AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(moderation) m WHERE m->>'action' = 'RESTORE')
       RETURNING id, "restaurantId", "driverId", status, "driverStatus"`,
      [reviewIds, JSON.stringify(reasons)],
    );
    if (changed.length) {
      this.notifications.notifyOps('review.flagged', { subject: subject, reasons: reasons.join(', ') }, { reviewIds: changed.map((c: any) => c.id), reasons }).catch(() => undefined);
    }
  }
}
