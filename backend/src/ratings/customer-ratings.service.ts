import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Cron } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { CustomerRating, Order } from '../database/entities';
import { FulfilmentMode, OrderStatus } from '../common/enums';
import { SettingsService } from '../settings/settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditService } from '../audit/audit.service';
import { CUSTOMER_TAGS, CUSTOMER_TAG_SETS, canonTag, round, smooth, tagLabel } from './ratings.constants';
import { RateCustomerDto } from './ratings.dto';

const DONE = [OrderStatus.DELIVERED, OrderStatus.COLLECTED];

/**
 * Private feedback about customers from drivers and restaurants. Aggregated on CustomerProfile (staff-only columns),
 * never returned by any customer, driver, restaurant or public endpoint.
 */
@Injectable()
export class CustomerRatingsService {
  private readonly logger = new Logger(CustomerRatingsService.name);

  constructor(
    @InjectDataSource() private ds: DataSource,
    private settings: SettingsService,
    private notifications: NotificationsService,
    private audit: AuditService,
  ) {}

  async rate(raterType: 'DRIVER' | 'RESTAURANT', orderId: string, who: { userId: string; driverId?: string; restaurantIds?: string[] }, dto: RateCustomerDto) {
    if (!/^[0-9a-f-]{36}$/i.test(orderId)) throw new NotFoundException('Order not found');
    const order = await this.ds.getRepository(Order).findOne({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Order not found');
    let refId: string;
    if (raterType === 'DRIVER') {
      if (!who.driverId || order.driverId !== who.driverId) throw new NotFoundException('Order not found');
      if (order.fulfilment !== FulfilmentMode.PLATFORM_DRIVER) throw new BadRequestException('Only deliveries completed by a FORKY driver can be rated');
      refId = who.driverId;
    } else {
      if (!who.restaurantIds?.includes(order.restaurantId)) throw new NotFoundException('Order not found');
      refId = order.restaurantId;
    }
    if (!DONE.includes(order.status)) throw new BadRequestException('You can rate the customer after the order is completed');
    const days = this.settings.get<number>('ratings.partnerWindowDays', 3);
    const doneAt = order.deliveredAt ?? order.updatedAt;
    if (Date.now() > doneAt.getTime() + days * 86400_000) throw new BadRequestException(`The window to rate this customer (${days} days) has closed`);

    const tags: string[] = [];
    for (const t of dto.tags ?? []) {
      const code = canonTag(t);
      if (!CUSTOMER_TAG_SETS.positive.has(code) && !CUSTOMER_TAG_SETS.negative.has(code)) throw new BadRequestException(`Unknown tag "${String(t).slice(0, 40)}"`);
      if (!tags.includes(code)) tags.push(code);
    }
    const note = (dto.note ?? '').trim() || null;
    const repo = this.ds.getRepository(CustomerRating);
    if (await repo.exist({ where: { orderId, raterType } })) throw new ConflictException('You already rated the customer for this order');
    let saved: CustomerRating;
    try {
      saved = await repo.save(repo.create({ orderId, customerId: order.customerId, raterType, raterId: who.userId, raterRefId: refId, rating: dto.rating, tags, note }));
    } catch (e: any) {
      if (e?.code === '23505') throw new ConflictException('You already rated the customer for this order');
      throw e;
    }
    await this.recomputeCustomer(order.customerId);
    const lowMax = this.settings.get<number>('ratings.customer.lowRatingMax', 2);
    const serious = tags.filter((t) => CUSTOMER_TAGS.safety.includes(t));
    if (serious.length && dto.rating <= lowMax) await this.raiseSafety(order, raterType, serious, saved);
    return { ok: true, orderId, rating: saved.rating, tags: saved.tags };
  }

  private async raiseSafety(order: Order, raterType: string, serious: string[], r: CustomerRating) {
    await this.ds.query(
      `UPDATE customer_profiles SET flags = (SELECT COALESCE(jsonb_agg(DISTINCT x), '[]'::jsonb) FROM jsonb_array_elements_text(flags || '["SAFETY_CONCERN"]'::jsonb) x),
         "internalNotes" = COALESCE("internalNotes" || E'\\n', '') || $2 WHERE "userId" = $1`,
      [order.customerId, `[ratings] ${new Date().toISOString().slice(0, 10)} ${raterType.toLowerCase()} reported ${serious.join(', ')} on order ${order.code} (${r.rating} stars)`],
    );
    const [u] = await this.ds.query(`SELECT "firstName", "lastName" FROM users WHERE id = $1`, [order.customerId]);
    await this.notifications.notifyOps('rating.customer_safety', { raterType: raterType.toLowerCase(), tags: serious.join(', '), customer: `${u?.firstName ?? ''} ${u?.lastName ?? ''}`.trim(), code: order.code }, { customerId: order.customerId, orderId: order.id, ratingId: r.id });
    await this.audit.log({ actor: null, action: 'customer.safety_flag', entity: 'CustomerProfile', entityId: order.customerId, after: { tags: serious, orderId: order.id, raterType } });
  }

  /** Bayesian-smoothed average + 30-day low-rating count on the profile. Safe to call any time. */
  async recomputeCustomer(customerId?: string) {
    const prior = this.settings.get<number>('ratings.customer.priorMean', 4.5);
    const m = this.settings.get<number>('ratings.customer.priorWeight', 3);
    const lowMax = this.settings.get<number>('ratings.customer.lowRatingMax', 2);
    const lowFlag = this.settings.get<number>('ratings.customer.lowCountFlag', 3);
    const rows: any[] = await this.ds.query(
      `SELECT "customerId" id, COUNT(*)::int n, SUM(rating)::int s, COUNT(*) FILTER (WHERE rating <= $1 AND "createdAt" >= now() - interval '30 days')::int low
       FROM customer_ratings ${customerId ? 'WHERE "customerId" = $2' : ''} GROUP BY 1`,
      customerId ? [lowMax, customerId] : [lowMax],
    );
    for (const r of rows) {
      await this.ds.query(
        `UPDATE customer_profiles SET "ratingAvg" = $2, "ratingCount" = $3, "lowRatingCount30d" = $4, "ratingUpdatedAt" = now() WHERE "userId" = $1`,
        [r.id, round(smooth(r.s, r.n, prior, m), 3), r.n, r.low],
      );
      if (r.low >= lowFlag) {
        const res: any[] = await this.ds.query(
          `UPDATE customer_profiles SET flags = flags || '["LOW_RATING_PATTERN"]'::jsonb WHERE "userId" = $1 AND NOT (flags ? 'LOW_RATING_PATTERN') RETURNING id`,
          [r.id],
        );
        if (res.length) await this.notifications.notifyOps('rating.customer_safety', { raterType: 'partners', tags: `${r.low} low ratings in 30 days`, customer: r.id, code: '-' }, { customerId: r.id }).catch(() => undefined);
      }
    }
    return rows.length;
  }

  @Cron('15 3 * * *')
  async nightly() {
    try {
      await this.ds.query(`UPDATE customer_profiles SET "lowRatingCount30d" = 0 WHERE "lowRatingCount30d" > 0`);
      await this.recomputeCustomer();
    } catch (e) {
      this.logger.warn(`customer rating recompute failed: ${(e as Error).message}`);
    }
  }

  // ------------------------------------------------------------------ staff read (customers:view)
  async forStaff(customerId: string) {
    const [p] = await this.ds.query(`SELECT "ratingAvg", "ratingCount", "lowRatingCount30d", "ratingUpdatedAt", flags FROM customer_profiles WHERE "userId" = $1`, [customerId]);
    if (!p) throw new NotFoundException('Customer not found');
    const items: any[] = await this.ds.query(
      `SELECT cr.id, cr."orderId", o.code AS "orderCode", cr."raterType", cr.rating, cr.tags, cr.note, cr."createdAt",
              CASE WHEN cr."raterType" = 'DRIVER' THEN (SELECT TRIM(u."firstName" || ' ' || LEFT(u."lastName", 1) || '.') FROM driver_profiles d JOIN users u ON u.id = d."userId" WHERE d.id = cr."raterRefId")
                   ELSE (SELECT r.name FROM restaurants r WHERE r.id = cr."raterRefId") END AS "raterName"
       FROM customer_ratings cr JOIN orders o ON o.id = cr."orderId" WHERE cr."customerId" = $1 ORDER BY cr."createdAt" DESC LIMIT 100`,
      [customerId],
    );
    const dist: Record<string, number> = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };
    const tagCounts = new Map<string, number>();
    for (const i of items) {
      dist[String(i.rating)]++;
      for (const t of i.tags ?? []) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
    }
    const tags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).map(([tag, count]) => ({ tag, label: tagLabel('customer', tag), count, serious: CUSTOMER_TAGS.safety.includes(tag) }));
    const ratingAvg = p.ratingAvg == null ? null : Number(p.ratingAvg);
    return {
      ratingAvg,
      ratingCount: p.ratingCount,
      lowRatingCount30d: p.lowRatingCount30d,
      updatedAt: p.ratingUpdatedAt,
      status: this.coarse(ratingAvg, p.ratingCount),
      flags: (p.flags ?? []).filter((f: string) => ['SAFETY_CONCERN', 'LOW_RATING_PATTERN'].includes(f)),
      distribution: dist,
      tags,
      items,
    };
  }

  /** Coarse signal for ops (not exposed to drivers/restaurants by default - docs/ratings.md). */
  coarse(avg: number | null, count: number): 'new' | 'good' | 'caution' {
    if (avg == null || count < 3) return 'new';
    return avg < 3.5 ? 'caution' : 'good';
  }

  /** Support view of the feedback on one order, for disputes (support:view). */
  async forOrder(orderId: string) {
    return this.ds.query(
      `SELECT "raterType", rating, tags, note, "createdAt" FROM customer_ratings WHERE "orderId" = $1 ORDER BY "createdAt"`,
      [orderId],
    );
  }

  assertNotCustomer(type: string) {
    if (type === 'CUSTOMER') throw new ForbiddenException();
  }
}
