import { Injectable } from '@nestjs/common';
import { AuthUser } from '../common/auth.types';
import { AnalyticsFilterDto } from './analytics.dto';
import { AnalyticsBase } from './analytics.base';
import { Params, WHERE, bucketExpr, bucketKeys, fillSeries, kpi, r2, rangeConds } from './analytics.util';

/** Admin Finance dashboard (spec §12): revenue/cost breakdown, ledger explorer, payouts & refunds status, HST. */
@Injectable()
export class FinanceAnalyticsService {
  constructor(private readonly b: AnalyticsBase) {}

  /** GET /admin/analytics/finance */
  async finance(f: AnalyticsFilterDto, user: AuthUser) {
    const c = await this.b.ctx(f, user);
    const [cur, prev] = await Promise.all([this.b.orderKpis(c, c.from, c.to), this.b.orderKpis(c, c.prevFrom, c.prevTo)]);

    const p = new Params();
    const ledgerByType = await this.b.q(
      `SELECT type, COALESCE(SUM(amount), 0)::float8 amount, COUNT(*)::int n
       FROM ledger_entries ${WHERE(rangeConds(p, '"createdAt"', c.from, c.to))} GROUP BY type ORDER BY type`,
      p.v,
    );

    const p2 = new Params();
    const refundsByCharge = await this.b.q(
      `SELECT "chargedTo", status, COUNT(*)::int n, COALESCE(SUM(amount), 0)::float8 amount
       FROM refunds ${WHERE(rangeConds(p2, '"createdAt"', c.from, c.to))} GROUP BY "chargedTo", status`,
      p2.v,
    );
    const pendingApprovalRefunds = await this.b.q(`SELECT COUNT(*)::int n, COALESCE(SUM(amount), 0)::float8 amount FROM refunds WHERE status = 'PENDING_APPROVAL'`);

    const batches = await this.b.q(
      `SELECT id, "periodStart", "periodEnd", status, "restaurantCount", "driverCount", total, "requiresSuperAdmin", "approvedAt", "releasedAt"
       FROM payout_batches ORDER BY "periodStart" DESC LIMIT 10`,
    );
    const batchStatusCounts = await this.b.q(`SELECT status, COUNT(*)::int n, COALESCE(SUM(total), 0)::float8 total FROM payout_batches GROUP BY status`);

    const p3 = new Params();
    const payoutStatusCounts = await this.b.q(
      `SELECT status, "partyType", COUNT(*)::int n, COALESCE(SUM(net), 0)::float8 net
       FROM payouts ${WHERE(rangeConds(p3, '"createdAt"', c.from, c.to))} GROUP BY status, "partyType"`,
      p3.v,
    );

    const p4 = new Params();
    const [hst] = await this.b.q(
      `SELECT COALESCE(SUM("taxAmount"), 0)::float8 collected FROM orders o ${WHERE([`o.status IN ('DELIVERED','COLLECTED')`, ...rangeConds(p4, 'o."createdAt"', c.from, c.to)])}`,
      p4.v,
    );
    const p5 = new Params();
    const [invoices] = await this.b.q(
      `SELECT COUNT(*)::int n, COALESCE(SUM(total), 0)::float8 total, COALESCE(SUM("hstAmount"), 0)::float8 hst
       FROM invoices ${WHERE([...rangeConds(p5, '"createdAt"', c.from, c.to), `status <> 'VOID'`])}`,
      p5.v,
    );

    const p6 = new Params();
    const bx = bucketExpr(c, p6, '"createdAt"');
    const netRevenueSeriesRows = await this.b.q(
      `SELECT ${bx} bucket, COALESCE(SUM(amount) FILTER (WHERE type IN ('FEE_REVENUE','COMMISSION_REVENUE')), 0)::float8 revenue,
              COALESCE(SUM(amount) FILTER (WHERE type = 'PLATFORM_PROMO'), 0)::float8 promo,
              COALESCE(-SUM(amount) FILTER (WHERE type = 'REFUND'), 0)::float8 refund
       FROM ledger_entries ${WHERE([...rangeConds(p6, '"createdAt"', c.from, c.to), `"partyType" = 'PLATFORM'`])} GROUP BY 1`,
      p6.v,
    );
    const series = fillSeries(bucketKeys(c.from, c.to, c.tz, c.groupBy), netRevenueSeriesRows, { revenue: 0, promo: 0, refund: 0 }).map((r) => ({
      bucket: r.bucket,
      revenue: r2(r.revenue)!,
      promo: r2(r.promo)!,
      refund: r2(r.refund)!,
      net: r2(r.revenue - r.promo - r.refund)!,
    }));

    return {
      range: this.b.rangeInfo(c),
      kpis: {
        netRevenue: kpi(cur.netRevenue, prev.netRevenue),
        driverCost: kpi(cur.driverCost, prev.driverCost),
        processingCost: kpi(cur.processingCost, prev.processingCost),
        platformRefunds: kpi(cur.platformRefunds, prev.platformRefunds),
        margin: kpi(cur.margin, prev.margin),
        hstCollected: kpi(r2(hst.collected), null),
      },
      series,
      ledgerByType: ledgerByType.map((r) => ({ ...r, amount: r2(r.amount) })),
      refunds: { byChargeAndStatus: refundsByCharge.map((r) => ({ ...r, amount: r2(r.amount) })), pendingApproval: { n: pendingApprovalRefunds[0].n, amount: r2(pendingApprovalRefunds[0].amount) } },
      payoutBatches: { recent: batches, byStatus: batchStatusCounts.map((r) => ({ ...r, total: r2(r.total) })) },
      payouts: { byStatus: payoutStatusCounts.map((r) => ({ ...r, net: r2(r.net) })) },
      invoices: { count: invoices.n, total: r2(invoices.total), hst: r2(invoices.hst) },
    };
  }
}
