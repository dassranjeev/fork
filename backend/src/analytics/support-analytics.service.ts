import { Injectable } from '@nestjs/common';
import { AuthUser } from '../common/auth.types';
import { AnalyticsFilterDto } from './analytics.dto';
import { AnalyticsBase } from './analytics.base';
import { Params, WHERE, bucketExpr, bucketKeys, fillSeries, kpi, pct, r2, rangeConds, scopeConds } from './analytics.util';

/** Admin Support dashboard (spec §12): ticket volume, SLA, CSAT, refunds raised from tickets. */
@Injectable()
export class SupportAnalyticsService {
  constructor(private readonly b: AnalyticsBase) {}

  /** GET /admin/analytics/support */
  async support(f: AnalyticsFilterDto, user: AuthUser) {
    const c = await this.b.ctx(f, user);
    const scoped = !!(c.cityIds || c.zoneIds || c.restaurantIds);
    const joinOrders = scoped ? `JOIN orders o ON o.id = t."orderId"` : '';

    const p = new Params();
    const conds = [...rangeConds(p, 't."createdAt"', c.from, c.to), ...(scoped ? scopeConds(c, p) : [])];
    const [totals] = await this.b.q(
      `SELECT COUNT(*)::int created, COUNT(*) FILTER (WHERE t.status IN ('OPEN','PENDING','ESCALATED'))::int open,
              COUNT(*) FILTER (WHERE t.status = 'RESOLVED' OR t.status = 'CLOSED')::int resolved,
              COUNT(*) FILTER (WHERE t."slaBreached")::int breached,
              COUNT(*) FILTER (WHERE t."autoResolved")::int "autoResolved",
              COALESCE(AVG(EXTRACT(EPOCH FROM (t."firstResponseAt" - t."createdAt")) / 60) FILTER (WHERE t."firstResponseAt" IS NOT NULL), 0)::float8 "avgFirstResponseMin",
              COALESCE(AVG(EXTRACT(EPOCH FROM (t."resolvedAt" - t."createdAt")) / 3600) FILTER (WHERE t."resolvedAt" IS NOT NULL), 0)::float8 "avgResolutionHours",
              COALESCE(AVG(t.csat), 0)::float8 "avgCsat", COUNT(*) FILTER (WHERE t.csat IS NOT NULL)::int "csatResponses",
              COALESCE(SUM(t."refundedTotal"), 0)::float8 "refundedTotal"
       FROM tickets t ${joinOrders} ${WHERE(conds)}`,
      p.v,
    );

    const p2 = new Params();
    const byCategory = await this.b.q(
      `SELECT t.category, COUNT(*)::int n FROM tickets t ${joinOrders} ${WHERE([...rangeConds(p2, 't."createdAt"', c.from, c.to), ...(scoped ? scopeConds(c, p2) : [])])} GROUP BY t.category ORDER BY n DESC`,
      p2.v,
    );
    const p3 = new Params();
    const byTier = await this.b.q(
      `SELECT t.tier, COUNT(*)::int n FROM tickets t ${joinOrders} ${WHERE([...rangeConds(p3, 't."createdAt"', c.from, c.to), ...(scoped ? scopeConds(c, p3) : [])])} GROUP BY t.tier ORDER BY t.tier`,
      p3.v,
    );
    const p4 = new Params();
    const byPriority = await this.b.q(
      `SELECT t.priority, COUNT(*)::int n FROM tickets t ${joinOrders} ${WHERE([`t.status IN ('OPEN','PENDING','ESCALATED')`, ...(scoped ? scopeConds(c, p4) : [])])} GROUP BY t.priority`,
      p4.v,
    );

    const p5 = new Params();
    const bx = bucketExpr(c, p5, 't."createdAt"');
    const seriesRows = await this.b.q(
      `SELECT ${bx} bucket, COUNT(*)::int created, COUNT(*) FILTER (WHERE t.status IN ('RESOLVED','CLOSED'))::int resolved
       FROM tickets t ${joinOrders} ${WHERE([...rangeConds(p5, 't."createdAt"', c.from, c.to), ...(scoped ? scopeConds(c, p5) : [])])} GROUP BY 1`,
      p5.v,
    );
    const series = fillSeries(bucketKeys(c.from, c.to, c.tz, c.groupBy), seriesRows, { created: 0, resolved: 0 });

    return {
      range: this.b.rangeInfo(c),
      kpis: {
        created: kpi(totals.created, null),
        open: kpi(totals.open, null),
        resolved: kpi(totals.resolved, null),
        slaBreachPct: kpi(pct(totals.breached, totals.created), null),
        autoResolvedPct: kpi(pct(totals.autoResolved, totals.created), null),
        avgFirstResponseMin: kpi(r2(totals.avgFirstResponseMin), null),
        avgResolutionHours: kpi(r2(totals.avgResolutionHours), null),
        avgCsat: kpi(r2(totals.avgCsat), null),
        csatResponseRatePct: kpi(pct(totals.csatResponses, totals.resolved), null),
        refundedTotal: kpi(r2(totals.refundedTotal), null),
      },
      byCategory,
      byTier,
      openByPriority: byPriority,
      series,
    };
  }
}
