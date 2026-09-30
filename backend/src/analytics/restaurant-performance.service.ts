import { Injectable } from '@nestjs/common';
import { AuthUser } from '../common/auth.types';
import { like } from '../common/pagination';
import { AnalyticsFilterDto } from './analytics.dto';
import { AnalyticsBase } from './analytics.base';
import { RestaurantReportsService } from './restaurant-reports.service';
import { Params, WHERE, div, paged, pct, r2 } from './analytics.util';

/** Admin "Restaurant Performance" dashboard (spec §12): ranking table + per-restaurant deep dive. */
@Injectable()
export class RestaurantPerformanceService {
  constructor(
    private readonly b: AnalyticsBase,
    private readonly reports: RestaurantReportsService,
  ) {}

  /** GET /admin/analytics/restaurant-performance */
  async list(f: AnalyticsFilterDto, user: AuthUser) {
    const c = await this.b.ctx(f, user);
    const p = new Params();
    const from = p.add(c.from);
    const to = p.add(c.to);
    const scope: string[] = [];
    if (c.cityIds) scope.push(`r."cityId" = ANY(${p.add(c.cityIds)}::uuid[])`);
    if (c.zoneIds) scope.push(`r."zoneId" = ANY(${p.add(c.zoneIds)}::uuid[])`);
    if (c.restaurantIds) scope.push(`r.id = ANY(${p.add(c.restaurantIds)}::uuid[])`);
    if (c.search) scope.push(`r.name ILIKE ${p.add(like(c.search))}`);

    const sortMap: Record<string, string> = {
      gmv: 'gmv',
      orders: 'orders',
      rating: 'r."rating"',
      cancellationRatePct: '"cancellationRatePct"',
      reliabilityScore: 'r."reliabilityScore"',
      avgPrepMin: '"avgPrepMin"',
    };
    const sortCol = (c.sortBy && sortMap[c.sortBy]) || 'gmv';
    const dir = c.sortBy && sortMap[c.sortBy] ? c.sortDir : 'DESC';

    const rows = await this.b.q(
      `SELECT r.id, r.name, r.status, r.rating, r."ratingCount", r."reliabilityScore", r."cityId", r."zoneId",
              COUNT(o.id)::int orders,
              COUNT(o.id) FILTER (WHERE o.status IN ('DELIVERED','COLLECTED'))::int completed,
              COUNT(o.id) FILTER (WHERE o.status = 'CANCELLED')::int cancelled,
              COUNT(o.id) FILTER (WHERE o.status = 'REJECTED')::int rejected,
              COUNT(o.id) FILTER (WHERE o."isLate")::int late,
              COALESCE(SUM(o.total) FILTER (WHERE o.status IN ('DELIVERED','COLLECTED')), 0)::float8 gmv,
              COALESCE(SUM(o."commissionAmount") FILTER (WHERE o.status IN ('DELIVERED','COLLECTED')), 0)::float8 commission,
              COALESCE(SUM(o."restaurantPayout") FILTER (WHERE o.status IN ('DELIVERED','COLLECTED')), 0)::float8 payout,
              COALESCE(AVG(EXTRACT(EPOCH FROM (o."readyAt" - o."acceptedAt")) / 60) FILTER (WHERE o."readyAt" IS NOT NULL AND o."acceptedAt" IS NOT NULL), 0)::float8 "avgPrepMin"
       FROM restaurants r
       LEFT JOIN orders o ON o."restaurantId" = r.id AND o."createdAt" >= ${from} AND o."createdAt" < ${to}
       ${WHERE(scope)}
       GROUP BY r.id
       ORDER BY ${sortCol} ${dir} NULLS LAST
       LIMIT ${p.add(c.limit)} OFFSET ${p.add((c.page - 1) * c.limit)}`,
      p.v,
    );
    const pc = new Params();
    const scope2: string[] = [];
    if (c.cityIds) scope2.push(`r."cityId" = ANY(${pc.add(c.cityIds)}::uuid[])`);
    if (c.zoneIds) scope2.push(`r."zoneId" = ANY(${pc.add(c.zoneIds)}::uuid[])`);
    if (c.restaurantIds) scope2.push(`r.id = ANY(${pc.add(c.restaurantIds)}::uuid[])`);
    if (c.search) scope2.push(`r.name ILIKE ${pc.add(like(c.search))}`);
    const [{ n: total }] = await this.b.q<{ n: number }>(`SELECT COUNT(*)::int n FROM restaurants r ${WHERE(scope2)}`, pc.v);

    const data = rows.map((x) => ({
      ...x,
      gmv: r2(x.gmv),
      commission: r2(x.commission),
      payout: r2(x.payout),
      avgPrepMin: r2(x.avgPrepMin),
      aov: div(x.gmv, x.completed),
      cancellationRatePct: pct(x.cancelled + x.rejected, x.orders),
      lateRatePct: pct(x.late, x.completed),
    }));

    const totals = await this.b.orderKpis(c, c.from, c.to);
    return { range: this.b.rangeInfo(c), kpis: { orders: totals.orders, gmv: totals.gmv, aov: totals.aov, cancellationRatePct: pct(totals.cancelled + totals.rejected, totals.orders) }, ...paged(data, total, c) };
  }

  /** GET /admin/analytics/restaurant-performance/:id - deep dive, reuses the restaurant self-serve report queries. */
  async detail(id: string, f: AnalyticsFilterDto, user: AuthUser) {
    const c = await this.b.ctx(f, user, { restaurantScope: [id] });
    const [sales, topItems, peakHours, ratings] = await Promise.all([
      this.reports.sales(c),
      this.reports.topItems(c),
      this.reports.peakHours(c),
      this.reports.ratings(c),
    ]);
    return { range: this.b.rangeInfo(c), sales, topItems, peakHours, ratings };
  }
}
