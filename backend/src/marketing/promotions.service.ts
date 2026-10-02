import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, DataSource, In, Repository } from 'typeorm';
import { CustomerProfile, Promotion, PromoRedemption } from '../database/entities';
import { FundedBy, OrderType, PromoType } from '../common/enums';
import { IPromotionsService, PromotionEvaluation } from '../common/contracts';

export type EvalInput = Parameters<IPromotionsService['evaluate']>[0];

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const money = (n: number) => `$${n.toFixed(2)}`;

/** Customer-facing shape of a promotion (deals feed / restaurant page). */
export interface DealView {
  id: string;
  code: string | null;
  name: string;
  description: string | null;
  type: PromoType;
  value: number;
  maxDiscount: number | null;
  minSubtotal: number;
  fundedBy: FundedBy;
  restaurantId: string | null;
  menuItemId: string | null;
  autoApply: boolean;
  endsAt: Date | null;
  /** short label such as "10% off" or "Free delivery" */
  badge: string;
}

export function promoBadge(p: Pick<Promotion, 'type' | 'value' | 'maxDiscount'>): string {
  switch (p.type) {
    case PromoType.PERCENT:
      return `${+p.value}% off`;
    case PromoType.FIXED:
      return `${money(+p.value)} off`;
    case PromoType.FREE_DELIVERY:
      return 'Free delivery';
    case PromoType.BOGO:
      return 'Buy 1 get 1 free';
    case PromoType.FREE_ITEM:
      return 'Free item';
  }
}

@Injectable()
export class PromotionsService implements IPromotionsService {
  private readonly logger = new Logger(PromotionsService.name);

  constructor(
    @InjectRepository(Promotion) private promos: Repository<Promotion>,
    @InjectRepository(PromoRedemption) private redemptions: Repository<PromoRedemption>,
    @InjectRepository(CustomerProfile) private customers: Repository<CustomerProfile>,
    private ds: DataSource,
  ) {}

  // ------------------------------------------------------------------ evaluate
  async evaluate(input: EvalInput): Promise<PromotionEvaluation | null> {
    const code = input.code?.trim();
    if (code) {
      const promo = await this.findByCode(code);
      if (!promo) throw new BadRequestException("That promo code isn't valid. Please check the code and try again.");
      await this.validate(promo, input);
      const ev = this.compute(promo, input);
      if (!ev || ev.discountTotal <= 0) throw new BadRequestException(this.notApplicableMessage(promo, input));
      return ev;
    }

    // auto-apply: best discount wins
    const candidates = await this.promos
      .createQueryBuilder('p')
      .where('p.active = true AND p.autoApply = true AND p.pendingApproval = false')
      .andWhere('(p.restaurantId IS NULL OR p.restaurantId = :rid)', { rid: input.restaurantId })
      .andWhere('(p.startsAt IS NULL OR p.startsAt <= now()) AND (p.endsAt IS NULL OR p.endsAt >= now())')
      .getMany();
    let best: PromotionEvaluation | null = null;
    for (const p of candidates) {
      try {
        await this.validate(p, input);
      } catch {
        continue;
      }
      const ev = this.compute(p, input);
      if (ev && ev.discountTotal > 0 && (!best || ev.discountTotal > best.discountTotal)) best = ev;
    }
    return best;
  }

  async findByCode(code: string): Promise<Promotion | null> {
    return this.promos
      .createQueryBuilder('p')
      .where('upper(p.code) = :c', { c: code.trim().toUpperCase() })
      .getOne();
  }

  /** Throws BadRequest with a friendly message when the promo cannot be used for this order. */
  async validate(p: Promotion, input: EvalInput): Promise<void> {
    const now = new Date();
    if (p.pendingApproval) throw new BadRequestException('This promotion is awaiting approval and is not available yet.');
    if (!p.active) throw new BadRequestException('This promo code is no longer active.');
    if (p.startsAt && p.startsAt > now) throw new BadRequestException(`This promo code is not active yet. It starts on ${p.startsAt.toISOString().slice(0, 10)}.`);
    if (p.endsAt && p.endsAt < now) throw new BadRequestException('This promo code has expired.');
    if (p.usageLimit != null && p.usedCount >= p.usageLimit) throw new BadRequestException('This promo code has reached its usage limit.');
    if (p.budget > 0 && p.spent >= p.budget) throw new BadRequestException('This promotion is no longer available (budget exhausted).');

    if (p.orderTypes?.length && !p.orderTypes.includes(input.orderType)) {
      throw new BadRequestException(`This promo code is only valid for ${p.orderTypes.map((t) => t.toLowerCase()).join(' / ')} orders.`);
    }
    if (p.restaurantId && p.restaurantId !== input.restaurantId) throw new BadRequestException('This promo code is only valid at a specific restaurant.');
    if (p.cityId && input.cityId && p.cityId !== input.cityId) throw new BadRequestException('This promo code is not valid in your city.');
    if (p.cityId && !input.cityId) throw new BadRequestException('This promo code is not valid in your area.');
    if (p.zoneIds?.length && (!input.zoneId || !p.zoneIds.includes(input.zoneId))) {
      throw new BadRequestException('This promo code is not valid in your delivery zone.');
    }
    if (p.minSubtotal > 0 && input.subtotal < p.minSubtotal) {
      throw new BadRequestException(`Add ${money(r2(p.minSubtotal - input.subtotal))} more to use this code (minimum order ${money(p.minSubtotal)}).`);
    }

    if (p.firstOrderOnly) {
      if (!input.customerId) throw new BadRequestException('Sign in to use this first-order promo code.');
      if (await this.hasPreviousOrders(input.customerId)) throw new BadRequestException('This promo code is only valid on your first order.');
    }
    if (input.customerId && p.perUserLimit > 0) {
      const used = await this.redemptions.count({ where: { promotionId: p.id, customerId: input.customerId } });
      if (used >= p.perUserLimit) {
        throw new BadRequestException(p.perUserLimit === 1 ? "You've already used this promo code." : `You've already used this promo code ${p.perUserLimit} times.`);
      }
    }
  }

  private async hasPreviousOrders(customerId: string): Promise<boolean> {
    const profile = await this.customers.findOne({ where: { userId: customerId }, select: ['id', 'totalOrders'] });
    if (profile && profile.totalOrders > 0) return true;
    const rows: { n: string }[] = await this.ds.query(
      `SELECT COUNT(*) n FROM orders WHERE "customerId" = $1 AND status NOT IN ('CANCELLED','REJECTED')`,
      [customerId],
    );
    return +rows[0].n > 0;
  }

  private notApplicableMessage(p: Promotion, input: EvalInput): string {
    if (p.type === PromoType.FREE_DELIVERY) {
      return input.orderType === OrderType.PICKUP ? 'Free delivery only applies to delivery orders.' : 'Your order already has no delivery fee.';
    }
    if (p.type === PromoType.BOGO) return 'Add two of the eligible item to your cart to use this offer.';
    if (p.type === PromoType.FREE_ITEM) return 'The free item is not in your cart. Add it to use this offer.';
    return 'This promo code does not apply to your order.';
  }

  /** Pure discount calculation (validation already done). Never negative, never above what it applies to. */
  compute(p: Promotion, input: EvalInput): PromotionEvaluation | null {
    const subtotal = Math.max(0, input.subtotal);
    const deliveryFee = Math.max(0, input.deliveryFee);
    const items = input.items ?? [];
    let discount = 0;
    let freeDelivery = false;

    switch (p.type) {
      case PromoType.PERCENT:
        discount = subtotal * (p.value / 100);
        if (p.maxDiscount != null && p.maxDiscount > 0) discount = Math.min(discount, p.maxDiscount);
        break;
      case PromoType.FIXED:
        discount = Math.min(p.value, subtotal);
        break;
      case PromoType.FREE_DELIVERY:
        if (input.orderType !== OrderType.DELIVERY || deliveryFee <= 0) return null;
        discount = deliveryFee;
        freeDelivery = true;
        if (p.maxDiscount != null && p.maxDiscount > 0) discount = Math.min(discount, p.maxDiscount);
        break;
      case PromoType.BOGO: {
        // buy one, get one free: for each eligible line, floor(qty / 2) units are free
        const eligible = items.filter((i) => !p.menuItemId || i.menuItemId === p.menuItemId);
        discount = eligible.reduce((s, i) => s + Math.floor(i.quantity / 2) * i.unitPrice, 0);
        if (p.maxDiscount != null && p.maxDiscount > 0) discount = Math.min(discount, p.maxDiscount);
        break;
      }
      case PromoType.FREE_ITEM: {
        const line = p.menuItemId
          ? items.find((i) => i.menuItemId === p.menuItemId)
          : [...items].sort((a, b) => a.unitPrice - b.unitPrice)[0];
        discount = line ? line.unitPrice : 0;
        break;
      }
    }

    if (!freeDelivery) discount = Math.min(discount, subtotal);
    if (p.budget > 0) discount = Math.min(discount, Math.max(0, p.budget - p.spent));
    discount = Math.max(0, r2(discount));
    if (discount <= 0) return null;

    const restaurantFunded = p.fundedBy === FundedBy.RESTAURANT;
    return {
      promotion: p,
      discountTotal: discount,
      platformAmount: restaurantFunded ? 0 : discount,
      restaurantAmount: restaurantFunded ? discount : 0,
      freeDelivery,
    };
  }

  // ------------------------------------------------------------------ redeem / unredeem
  async redeem(promotionId: string, customerId: string, orderId: string, discount: number): Promise<void> {
    try {
      await this.ds.transaction(async (m) => {
        const existing = await m.findOne(PromoRedemption, { where: { promotionId, orderId } });
        if (existing) return; // idempotent
        // serialise redemptions of one promo by one customer (per-user limit), then claim usage/budget atomically in a single UPDATE
        await m.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`promo:${promotionId}:${customerId}`]);
        const p = await m.findOne(Promotion, { where: { id: promotionId } });
        if (!p) throw new BadRequestException('This promo code is no longer available.');
        if (p.perUserLimit > 0) {
          const used = await m.count(PromoRedemption, { where: { promotionId, customerId } });
          if (used >= p.perUserLimit) throw new BadRequestException("You've already used this promo code.");
        }
        const d = r2(discount);
        const claimed = await m
          .createQueryBuilder()
          .update(Promotion)
          .set({ usedCount: () => '"usedCount" + 1', spent: () => `"spent" + ${d}` })
          .where('id = :id AND ("usageLimit" IS NULL OR "usedCount" < "usageLimit") AND (budget <= 0 OR "spent" + :d <= budget + 0.005)', { id: promotionId, d })
          .execute();
        if (!claimed.affected) throw new BadRequestException('This promo code has reached its usage limit.');
        await m.insert(PromoRedemption, { promotionId, customerId, orderId, discount: d });
      });
    } catch (e: any) {
      this.logger.error(`redeem failed for order ${orderId}: ${e.message}`);
      throw e;
    }
  }

  async unredeem(orderId: string): Promise<void> {
    await this.ds.transaction(async (m) => {
      const rows = await m.find(PromoRedemption, { where: { orderId } });
      for (const r of rows) {
        await m
          .createQueryBuilder()
          .update(Promotion)
          .set({ usedCount: () => 'GREATEST("usedCount" - 1, 0)', spent: () => `GREATEST("spent" - ${r2(r.discount)}, 0)` })
          .where('id = :id', { id: r.promotionId })
          .execute();
      }
      if (rows.length) await m.delete(PromoRedemption, { orderId });
    });
  }

  // ------------------------------------------------------------------ deals feed
  private toView(p: Promotion): DealView {
    return {
      id: p.id,
      code: p.code,
      name: p.name,
      description: p.description,
      type: p.type,
      value: p.value,
      maxDiscount: p.maxDiscount,
      minSubtotal: p.minSubtotal,
      fundedBy: p.fundedBy,
      restaurantId: p.restaurantId,
      menuItemId: p.menuItemId,
      autoApply: p.autoApply,
      endsAt: p.endsAt,
      badge: promoBadge(p),
    };
  }

  private liveQuery() {
    return this.promos
      .createQueryBuilder('p')
      .where('p.active = true AND p.pendingApproval = false')
      .andWhere('(p.startsAt IS NULL OR p.startsAt <= now()) AND (p.endsAt IS NULL OR p.endsAt >= now())')
      .andWhere('(p.usageLimit IS NULL OR p.usedCount < p.usageLimit)')
      .andWhere('(p.budget = 0 OR p.spent < p.budget)');
  }

  /** Promos to show on a restaurant page (restaurant deals + platform auto-apply / public promos). */
  async listActiveForRestaurant(restaurantId: string, opts: { cityId?: string | null; zoneId?: string | null } = {}): Promise<DealView[]> {
    const rows = await this.liveQuery()
      .andWhere('(p.restaurantId = :rid OR (p.restaurantId IS NULL AND p.autoApply = true))', { rid: restaurantId })
      .orderBy('p.createdAt', 'DESC')
      .getMany();
    return rows.filter((p) => this.inScope(p, opts)).map((p) => this.toView(p));
  }

  /** 'Deals' feed for the customer home: restaurant-specific auto-apply deals + public platform offers. */
  async dealsFeed(opts: { cityId?: string | null; zoneId?: string | null; restaurantIds?: string[]; limit?: number } = {}): Promise<DealView[]> {
    const qb = this.liveQuery().andWhere(
      new Brackets((w) => {
        w.where('p.autoApply = true').orWhere('p.code IS NOT NULL AND p.restaurantId IS NULL AND p.firstOrderOnly = false');
      }),
    );
    if (opts.restaurantIds?.length) qb.andWhere('(p.restaurantId IS NULL OR p.restaurantId IN (:...rids))', { rids: opts.restaurantIds });
    const rows = await qb.orderBy('p.createdAt', 'DESC').take(opts.limit ?? 50).getMany();
    return rows.filter((p) => this.inScope(p, opts)).map((p) => this.toView(p));
  }

  /** Ids of restaurants that currently run a live restaurant deal (for the "deals" carousel). */
  async restaurantIdsWithDeals(opts: { cityId?: string | null; zoneId?: string | null } = {}): Promise<string[]> {
    const rows = await this.liveQuery().andWhere('p.restaurantId IS NOT NULL AND p.autoApply = true').getMany();
    return [...new Set(rows.filter((p) => this.inScope(p, opts)).map((p) => p.restaurantId as string))];
  }

  private inScope(p: Promotion, opts: { cityId?: string | null; zoneId?: string | null }): boolean {
    if (p.cityId && opts.cityId && p.cityId !== opts.cityId) return false;
    if (p.zoneIds?.length && opts.zoneId && !p.zoneIds.includes(opts.zoneId)) return false;
    return true;
  }

  // ------------------------------------------------------------------ stats
  async stats(promotionId: string) {
    const p = await this.promos.findOneOrFail({ where: { id: promotionId } });
    const [row] = await this.ds.query(
      `SELECT COUNT(*)::int redemptions, COUNT(DISTINCT "customerId")::int customers, COALESCE(SUM(discount),0)::float discount
       FROM promo_redemptions WHERE "promotionId" = $1`,
      [promotionId],
    );
    const [ord] = await this.ds.query(
      `SELECT COUNT(*)::int orders,
              COALESCE(SUM(o.subtotal),0)::float revenue,
              COALESCE(SUM(o."platformPromoAmount"),0)::float platform,
              COALESCE(SUM(o."restaurantPromoAmount"),0)::float restaurant,
              COALESCE(SUM(o."platformRevenue"),0)::float "platformRevenue",
              COUNT(*) FILTER (WHERE NOT EXISTS (
                 SELECT 1 FROM orders o2 WHERE o2."customerId" = o."customerId" AND o2.id <> o.id
                   AND o2.status NOT IN ('CANCELLED','REJECTED')
                   AND o2."createdAt" < o."createdAt" AND o2."createdAt" > o."createdAt" - interval '30 days'))::int incremental,
              COALESCE(SUM(o.subtotal) FILTER (WHERE NOT EXISTS (
                 SELECT 1 FROM orders o2 WHERE o2."customerId" = o."customerId" AND o2.id <> o.id
                   AND o2.status NOT IN ('CANCELLED','REJECTED')
                   AND o2."createdAt" < o."createdAt" AND o2."createdAt" > o."createdAt" - interval '30 days')),0)::float "incrementalRevenue"
       FROM orders o WHERE o."promotionId" = $1 AND o.status NOT IN ('CANCELLED','REJECTED')`,
      [promotionId],
    );
    const discount = row.discount as number;
    // discount spent by funder: prefer the order split, fall back to the promo's funder
    const byPlatform = ord.orders ? ord.platform : p.fundedBy === FundedBy.PLATFORM ? discount : 0;
    const byRestaurant = ord.orders ? ord.restaurant : p.fundedBy === FundedBy.RESTAURANT ? discount : 0;
    return {
      promotionId,
      redemptions: row.redemptions,
      uniqueCustomers: row.customers,
      usedCount: p.usedCount,
      usageLimit: p.usageLimit,
      discountSpent: discount,
      discountByFunder: { platform: r2(byPlatform), restaurant: r2(byRestaurant) },
      budget: p.budget,
      budgetRemaining: p.budget > 0 ? r2(Math.max(0, p.budget - p.spent)) : null,
      orders: ord.orders,
      revenue: r2(ord.revenue),
      incrementalOrders: ord.incremental,
      incrementalRevenue: r2(ord.incrementalRevenue),
      avgDiscountPerOrder: ord.orders ? r2(discount / ord.orders) : 0,
      /** (incremental revenue - discount spent) / discount spent; null when nothing was discounted */
      roi: discount > 0 ? r2((ord.incrementalRevenue - discount) / discount) : null,
    };
  }

  async listRedemptions(promotionId: string | undefined, page = 1, limit = 20) {
    const qb = this.redemptions
      .createQueryBuilder('r')
      .leftJoin('users', 'u', 'u.id = r."customerId"')
      .leftJoin('orders', 'o', 'o.id = r."orderId"')
      .leftJoin('promotions', 'p', 'p.id = r."promotionId"')
      .select([
        'r.id AS id',
        'r."promotionId" AS "promotionId"',
        'p.name AS "promotionName"',
        'p.code AS "promotionCode"',
        'r."customerId" AS "customerId"',
        `TRIM(COALESCE(u."firstName",'') || ' ' || COALESCE(u."lastName",'')) AS "customerName"`,
        'r."orderId" AS "orderId"',
        'o.code AS "orderCode"',
        'r.discount::float AS discount',
        'r."createdAt" AS "createdAt"',
      ])
      .orderBy('r."createdAt"', 'DESC');
    if (promotionId) qb.where('r."promotionId" = :promotionId', { promotionId });
    const total = await qb.getCount();
    const data = await qb.offset((page - 1) * limit).limit(limit).getRawMany();
    return { data, meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } };
  }

  /** Overview cards for the promotions dashboard. */
  async overview() {
    const [a] = await this.ds.query(
      `SELECT COUNT(*) FILTER (WHERE active AND NOT "pendingApproval" AND ("endsAt" IS NULL OR "endsAt" >= now()))::int active,
              COUNT(*) FILTER (WHERE "pendingApproval")::int pending,
              COALESCE(SUM(spent),0)::float spent
       FROM promotions`,
    );
    const [b] = await this.ds.query(`SELECT COUNT(*)::int redemptions, COALESCE(SUM(discount),0)::float discount FROM promo_redemptions`);
    return { activePromotions: a.active, pendingApproval: a.pending, totalBudgetSpent: a.spent, redemptions: b.redemptions, totalDiscount: b.discount };
  }

  async byIds(ids: string[]) {
    return ids.length ? this.promos.find({ where: { id: In(ids) } }) : [];
  }
}
