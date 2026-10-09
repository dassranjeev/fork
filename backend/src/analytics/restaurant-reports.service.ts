import { Injectable } from '@nestjs/common';
import { AuthUser } from '../common/auth.types';
import { AnalyticsFilterDto } from './analytics.dto';
import { AnalyticsBase } from './analytics.base';
import { Ctx, Params, WHERE, bucketExpr, bucketKeys, div, done, fillSeries, kpi, pct, r2, rangeConds, scopeConds } from './analytics.util';

/**
 * Restaurant self-serve reports (spec §12 + §4): `/restaurant/reports/*`, scoped to the caller's
 * restaurantIds/merchantId. Also reused by the admin Restaurant Performance detail view.
 */
@Injectable()
export class RestaurantReportsService {
  constructor(private readonly b: AnalyticsBase) {}

  private async ctxFor(f: AnalyticsFilterDto, user: AuthUser) {
    return this.b.ctx(f, user, { restaurantScope: user.restaurantIds ?? [], defaultDays: 30 });
  }

  /** GET /restaurant/reports/sales */
  async salesFor(f: AnalyticsFilterDto, user: AuthUser) {
    const c = await this.ctxFor(f, user);
    return this.sales(c);
  }

  private async payoutTotals(c: Ctx, from: Date, to: Date) {
    const p = new Params();
    const [x] = await this.b.q(
      `SELECT COALESCE(SUM(o."restaurantPayout") FILTER (WHERE ${done()}), 0)::float8 payout, COALESCE(SUM(o."commissionAmount") FILTER (WHERE ${done()}), 0)::float8 commission
       FROM orders o ${WHERE([`(o."kitchenReleaseAt" IS NULL OR o."kitchenReleasedAt" IS NOT NULL)`, ...rangeConds(p, 'o."createdAt"', from, to), ...scopeConds(c, p)])}`,
      p.v,
    );
    return { payout: r2(x.payout)!, commission: r2(x.commission)! };
  }

  async sales(c: Ctx) {
    const [cur, prev, payoutCur, payoutPrev] = await Promise.all([
      this.b.orderKpis(c, c.from, c.to),
      this.b.orderKpis(c, c.prevFrom, c.prevTo),
      this.payoutTotals(c, c.from, c.to),
      this.payoutTotals(c, c.prevFrom, c.prevTo),
    ]);
    const p = new Params();
    const bx = bucketExpr(c, p, 'o."createdAt"');
    const rows = await this.b.q(
      `SELECT ${bx} bucket, COUNT(*)::int orders, COUNT(*) FILTER (WHERE ${done()})::int completed,
              COALESCE(SUM(o.total) FILTER (WHERE ${done()}), 0)::float8 gmv,
              COALESCE(SUM(o."restaurantPayout") FILTER (WHERE ${done()}), 0)::float8 payout,
              COALESCE(SUM(o."commissionAmount") FILTER (WHERE ${done()}), 0)::float8 commission
       FROM orders o ${WHERE([`(o."kitchenReleaseAt" IS NULL OR o."kitchenReleasedAt" IS NOT NULL)`, ...rangeConds(p, 'o."createdAt"', c.from, c.to), ...scopeConds(c, p)])} GROUP BY 1`,
      p.v,
    );
    const series = fillSeries(bucketKeys(c.from, c.to, c.tz, c.groupBy), rows, { orders: 0, completed: 0, gmv: 0, payout: 0, commission: 0 }).map((r) => ({
      ...r,
      gmv: r2(r.gmv)!,
      payout: r2(r.payout)!,
      commission: r2(r.commission)!,
      aov: div(r.gmv, r.completed),
    }));
    return {
      range: this.b.rangeInfo(c),
      kpis: {
        orders: kpi(cur.orders, prev.orders),
        completedOrders: kpi(cur.completed, prev.completed),
        gmv: kpi(cur.gmv, prev.gmv),
        payout: kpi(payoutCur.payout, payoutPrev.payout),
        commission: kpi(payoutCur.commission, payoutPrev.commission),
        aov: kpi(cur.aov, prev.aov),
        cancellationRatePct: kpi(pct(cur.cancelled + cur.rejected, cur.orders), pct(prev.cancelled + prev.rejected, prev.orders)),
      },
      series,
    };
  }

  /** GET /restaurant/reports/top-items */
  async topItemsFor(f: AnalyticsFilterDto, user: AuthUser) {
    const c = await this.ctxFor(f, user);
    return this.topItems(c);
  }

  async topItems(c: Ctx) {
    const p = new Params();
    const rows = await this.b.q(
      `SELECT oi."menuItemId" "menuItemId", oi.name, COUNT(*)::int lines, COALESCE(SUM(oi.quantity), 0)::int qty,
              COALESCE(SUM(oi."lineTotal"), 0)::float8 revenue, COUNT(DISTINCT oi."orderId")::int orders
       FROM order_items oi JOIN orders o ON o.id = oi."orderId"
       ${WHERE([`(o."kitchenReleaseAt" IS NULL OR o."kitchenReleasedAt" IS NOT NULL)`, done(), `NOT oi.removed`, ...rangeConds(p, 'o."createdAt"', c.from, c.to), ...scopeConds(c, p)])}
       GROUP BY oi."menuItemId", oi.name ORDER BY revenue DESC LIMIT ${p.add(c.limit)}`,
      p.v,
    );
    return rows.map((r) => ({ ...r, revenue: r2(r.revenue), avgPrice: div(r.revenue, r.qty) }));
  }

  /** GET /restaurant/reports/peak-hours - order volume heatmap by local day-of-week x hour. */
  async peakHoursFor(f: AnalyticsFilterDto, user: AuthUser) {
    const c = await this.ctxFor(f, user);
    return this.peakHours(c);
  }

  async peakHours(c: Ctx) {
    const p = new Params();
    const tzp = p.add(c.tz);
    const rows = await this.b.q(
      `SELECT EXTRACT(DOW FROM o."createdAt" AT TIME ZONE ${tzp}::text)::int AS dow,
              EXTRACT(HOUR FROM o."createdAt" AT TIME ZONE ${tzp}::text)::int AS hour,
              COUNT(*)::int orders, COALESCE(SUM(o.total) FILTER (WHERE ${done()}), 0)::float8 gmv
       FROM orders o ${WHERE([`(o."kitchenReleaseAt" IS NULL OR o."kitchenReleasedAt" IS NOT NULL)`, `o.status NOT IN ('CANCELLED','REJECTED')`, ...rangeConds(p, 'o."createdAt"', c.from, c.to), ...scopeConds(c, p)])}
       GROUP BY 1, 2`,
      p.v,
    );
    const grid: { dow: number; hour: number; orders: number; gmv: number }[] = [];
    for (let dow = 0; dow < 7; dow++) {
      for (let hour = 0; hour < 24; hour++) {
        const hit = rows.find((r) => r.dow === dow && r.hour === hour);
        grid.push({ dow, hour, orders: hit?.orders ?? 0, gmv: r2(hit?.gmv ?? 0)! });
      }
    }
    const busiest = [...grid].sort((a, b) => b.orders - a.orders).slice(0, 5);
    return { grid, busiest };
  }

  /** GET /restaurant/reports/ratings */
  async ratingsFor(f: AnalyticsFilterDto, user: AuthUser) {
    const c = await this.ctxFor(f, user);
    return this.ratings(c);
  }

  async ratings(c: Ctx) {
    const p = new Params();
    const [x] = await this.b.q(
      `SELECT COUNT(*)::int total, COALESCE(AVG(rv."restaurantRating"), 0)::float8 avg,
              COUNT(*) FILTER (WHERE rv."restaurantRating" = 5)::int r5, COUNT(*) FILTER (WHERE rv."restaurantRating" = 4)::int r4,
              COUNT(*) FILTER (WHERE rv."restaurantRating" = 3)::int r3, COUNT(*) FILTER (WHERE rv."restaurantRating" = 2)::int r2,
              COUNT(*) FILTER (WHERE rv."restaurantRating" = 1)::int r1, COUNT(*) FILTER (WHERE rv.reply IS NOT NULL)::int replied
       FROM reviews rv JOIN orders o ON o.id = rv."orderId"
       ${WHERE([`(o."kitchenReleaseAt" IS NULL OR o."kitchenReleasedAt" IS NOT NULL)`, `rv."restaurantRating" IS NOT NULL`, `rv.status = 'VISIBLE'`, ...rangeConds(p, 'rv."createdAt"', c.from, c.to), ...scopeConds(c, p)])}`,
      p.v,
    );
    const p2 = new Params();
    const recent = await this.b.q(
      `SELECT rv.id, rv."restaurantRating" rating, rv.comment, rv."restaurantTags" tags, rv.reply, rv."createdAt", o.code "orderCode"
       FROM reviews rv JOIN orders o ON o.id = rv."orderId"
       ${WHERE([`(o."kitchenReleaseAt" IS NULL OR o."kitchenReleasedAt" IS NOT NULL)`, `rv."restaurantRating" IS NOT NULL`, `rv.status = 'VISIBLE'`, ...scopeConds(c, p2)])}
       ORDER BY rv."createdAt" DESC LIMIT 25`,
      p2.v,
    );
    return {
      average: r2(x.avg),
      total: x.total,
      distribution: [
        { stars: 5, count: x.r5 },
        { stars: 4, count: x.r4 },
        { stars: 3, count: x.r3 },
        { stars: 2, count: x.r2 },
        { stars: 1, count: x.r1 },
      ],
      repliedPct: pct(x.replied, x.total),
      recent,
    };
  }

  /** GET /restaurant/reports/payouts - by merchantId (payouts are per money-party, not per location). */
  async payoutsFor(f: AnalyticsFilterDto, user: AuthUser) {
    const c = await this.ctxFor(f, user);
    if (!user.merchantId) return { kpis: { paid: 0, pending: 0 }, data: [], meta: { page: c.page, limit: c.limit, total: 0, totalPages: 1 } };
    const p = new Params();
    const rows = await this.b.q(
      `SELECT id, "periodStart", "periodEnd", gross, deductions, fee, net, "orderCount", status, instant, "paidAt"
       FROM payouts WHERE "partyType" = 'RESTAURANT' AND "partyId" = ${p.add(user.merchantId)}
       ORDER BY "periodStart" DESC LIMIT ${p.add(c.limit)} OFFSET ${p.add((c.page - 1) * c.limit)}`,
      p.v,
    );
    const [{ n: total }] = await this.b.q<{ n: number }>(`SELECT COUNT(*)::int n FROM payouts WHERE "partyType" = 'RESTAURANT' AND "partyId" = $1`, [user.merchantId]);
    const [sum] = await this.b.q(
      `SELECT COALESCE(SUM(net) FILTER (WHERE status = 'PAID'), 0)::float8 paid, COALESCE(SUM(net) FILTER (WHERE status IN ('PENDING','APPROVED','RELEASED')), 0)::float8 pending
       FROM payouts WHERE "partyType" = 'RESTAURANT' AND "partyId" = $1`,
      [user.merchantId],
    );
    return { kpis: { paid: r2(sum.paid), pending: r2(sum.pending) }, data: rows, meta: { page: c.page, limit: c.limit, total, totalPages: Math.max(1, Math.ceil(total / c.limit)) } };
  }

  /** GET /restaurant/reports/promotions - self-serve promos owned by the restaurant + platform promos applied to their orders. */
  async promotionsFor(f: AnalyticsFilterDto, user: AuthUser) {
    const c = await this.ctxFor(f, user);
    const ids = c.restaurantIds ?? [];
    if (!ids.length) return { owned: [], platformImpact: { redemptions: 0, discountCost: 0, gmv: 0 } };
    const p1 = new Params();
    const owned = await this.b.q(
      `SELECT pm.id, pm.code, pm.name, pm.type, pm.active, pm."pendingApproval", pm.budget, pm.spent, pm."usedCount",
              COUNT(pr.id)::int redemptions, COALESCE(SUM(pr.discount), 0)::float8 "discountCost", COALESCE(SUM(o.total), 0)::float8 gmv
       FROM promotions pm
       LEFT JOIN promo_redemptions pr ON pr."promotionId" = pm.id AND pr."createdAt" >= ${p1.add(c.from)} AND pr."createdAt" < ${p1.add(c.to)}
       LEFT JOIN orders o ON o.id = pr."orderId" AND ${done()}
       WHERE pm."restaurantId" = ANY(${p1.add(ids)}::uuid[])
       GROUP BY pm.id ORDER BY pm."createdAt" DESC`,
      p1.v,
    );
    const p2 = new Params();
    const sc = scopeConds(c, p2);
    const [impact] = await this.b.q(
      `SELECT COUNT(pr.id)::int redemptions, COALESCE(SUM(pr.discount), 0)::float8 "discountCost", COALESCE(SUM(o.total), 0)::float8 gmv
       FROM promo_redemptions pr JOIN orders o ON o.id = pr."orderId" AND ${done()}
       ${WHERE([`(o."kitchenReleaseAt" IS NULL OR o."kitchenReleasedAt" IS NOT NULL)`, ...rangeConds(p2, 'pr."createdAt"', c.from, c.to), ...sc])}`,
      p2.v,
    );
    return {
      range: this.b.rangeInfo(c),
      owned: owned.map((r) => ({ ...r, discountCost: r2(r.discountCost), gmv: r2(r.gmv) })),
      platformImpact: { redemptions: impact.redemptions, discountCost: r2(impact.discountCost), gmv: r2(impact.gmv) },
    };
  }
}
