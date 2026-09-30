import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.types';
import { SettingsService } from '../settings/settings.service';
import { AnalyticsFilterDto } from './analytics.dto';
import {
  Ctx,
  GroupBy,
  Params,
  WHERE,
  addDays,
  done,
  intersectScope,
  localDate,
  parseRangeInput,
  pct,
  div,
  r2,
  rangeConds,
  revenueExpr,
  scopeConds,
  startOfLocalDay,
  validTz,
  zonedInstant,
} from './analytics.util';

export interface OrderKpis {
  orders: number;
  completed: number;
  cancelled: number;
  rejected: number;
  gmv: number;
  foodSales: number;
  revenueGross: number;
  promoCost: number;
  driverCost: number;
  processingCost: number;
  platformRefunds: number;
  tax: number;
  tip: number;
  netRevenue: number;
  margin: number;
  activeCustomers: number;
  aov: number | null;
  takeRatePct: number | null;
  marginPerOrder: number | null;
}

/** Shared context builder + the "single source of truth" order KPI aggregation used by all dashboards. */
@Injectable()
export class AnalyticsBase {
  private tzCache = new Map<string, { tz: string; at: number }>();

  constructor(
    readonly ds: DataSource,
    readonly settings: SettingsService,
  ) {}

  q<T = any>(sql: string, params: any[] = []): Promise<T[]> {
    return this.ds.query(sql, params);
  }

  async cityTz(cityId: string): Promise<string> {
    const hit = this.tzCache.get(cityId);
    if (hit && Date.now() - hit.at < 300_000) return hit.tz;
    const rows = await this.q<{ timezone: string }>(`SELECT timezone FROM cities WHERE id = $1`, [cityId]);
    const tz = validTz(rows[0]?.timezone, this.defaultTz());
    this.tzCache.set(cityId, { tz, at: Date.now() });
    return tz;
  }

  defaultTz() {
    return validTz(this.settings.get<string>('analytics.timezone', 'America/Toronto'));
  }

  /**
   * Turn request filters + user scope into a Ctx. Default range = last 30 local days (incl. today).
   * @param restaurantScope forces restaurant ids (restaurant portal)
   */
  async ctx(f: AnalyticsFilterDto = {}, user?: AuthUser, opts: { restaurantScope?: string[]; defaultDays?: number } = {}): Promise<Ctx> {
    const cityIds = intersectScope(f.cityId, user?.scopeCityIds);
    const zoneIds = intersectScope(f.zoneId, user?.scopeZoneIds);
    let restaurantIds: string[] | null = null;
    if (opts.restaurantScope) {
      restaurantIds = f.restaurantId ? (opts.restaurantScope.includes(f.restaurantId) ? [f.restaurantId] : []) : opts.restaurantScope;
    } else if (f.restaurantId) restaurantIds = [f.restaurantId];
    const tz = cityIds && cityIds.length === 1 ? await this.cityTz(cityIds[0]) : this.defaultTz();
    const now = new Date();
    const tomorrow = zonedInstant(addDays(localDate(now, tz), 1), 0, tz);
    let to = parseRangeInput(f.to, tz, true) ?? tomorrow;
    let from = parseRangeInput(f.from, tz, false) ?? zonedInstant(addDays(localDate(to.getTime() - 1 > 0 ? new Date(to.getTime() - 1) : to, tz), -((opts.defaultDays ?? 30) - 1)), 0, tz);
    if (from >= to) [from, to] = [to, from];
    const maxSpan = 400 * 86400_000;
    if (to.getTime() - from.getTime() > maxSpan) from = new Date(to.getTime() - maxSpan);
    const span = to.getTime() - from.getTime();
    const days = span / 86400_000;
    const groupBy: GroupBy = f.groupBy ?? (days > 120 ? 'month' : days > 45 ? 'week' : 'day');
    return {
      from,
      to,
      prevFrom: new Date(from.getTime() - span),
      prevTo: from,
      tz,
      groupBy,
      cityIds,
      zoneIds,
      restaurantIds,
      page: f.page ?? 1,
      limit: f.limit ?? 25,
      sortBy: f.sortBy,
      sortDir: (f.sortDir ?? 'DESC').toUpperCase() as 'ASC' | 'DESC',
      search: f.search,
      f,
    };
  }

  rangeInfo(c: Ctx) {
    return { from: c.from.toISOString(), to: c.to.toISOString(), timezone: c.tz, groupBy: c.groupBy, previousFrom: c.prevFrom.toISOString(), previousTo: c.prevTo.toISOString() };
  }

  cost() {
    return {
      feePct: +this.settings.get('analytics.paymentFeePct', 2.9),
      feeFixed: +this.settings.get('analytics.paymentFeeFixed', 0.3),
    };
  }

  /** Per-order platform contribution margin (completed orders). Requires join alias `pr` (platform refunds) - see PLATFORM_REFUND_JOIN. */
  marginExpr(p: Params, a = 'o') {
    const { feePct, feeFixed } = this.cost();
    return `(${revenueExpr(a)} - ${a}."platformPromoAmount" - ${a}."driverPay" - ${a}."driverBoost" - (${p.add(feePct)}::numeric / 100 * ${a}."total" + ${p.add(feeFixed)}::numeric) - COALESCE(pr.amt, 0))`;
  }

  static PLATFORM_REFUND_JOIN = `LEFT JOIN (SELECT "orderId", SUM(amount) amt FROM refunds WHERE "chargedTo" = 'PLATFORM' AND status IN ('APPROVED','PROCESSED') GROUP BY "orderId") pr ON pr."orderId" = o.id`;

  /** Aggregate KPIs for orders created in [from,to) within the ctx scope. */
  async orderKpis(c: Ctx, from: Date, to: Date, extra: string[] = []): Promise<OrderKpis> {
    const p = new Params();
    const { feePct, feeFixed } = this.cost();
    const conds = [...rangeConds(p, 'o."createdAt"', from, to), ...scopeConds(c, p), ...extra];
    const fp = p.add(feePct);
    const fx = p.add(feeFixed);
    const rows = await this.q(
      `SELECT COUNT(*)::int orders,
        COUNT(*) FILTER (WHERE ${done()})::int completed,
        COUNT(*) FILTER (WHERE o.status = 'CANCELLED')::int cancelled,
        COUNT(*) FILTER (WHERE o.status = 'REJECTED')::int rejected,
        COALESCE(SUM(o.total) FILTER (WHERE ${done()}), 0)::float8 gmv,
        COALESCE(SUM(o.subtotal) FILTER (WHERE ${done()}), 0)::float8 "foodSales",
        COALESCE(SUM(${revenueExpr()}) FILTER (WHERE ${done()}), 0)::float8 "revenueGross",
        COALESCE(SUM(o."platformPromoAmount") FILTER (WHERE ${done()}), 0)::float8 "promoCost",
        COALESCE(SUM(o."driverPay" + o."driverBoost") FILTER (WHERE ${done()}), 0)::float8 "driverCost",
        COALESCE(SUM(${fp}::numeric / 100 * o.total + ${fx}::numeric) FILTER (WHERE ${done()}), 0)::float8 "processingCost",
        COALESCE(SUM(pr.amt) FILTER (WHERE ${done()}), 0)::float8 "platformRefunds",
        COALESCE(SUM(o."taxAmount") FILTER (WHERE ${done()}), 0)::float8 tax,
        COALESCE(SUM(o.tip) FILTER (WHERE ${done()}), 0)::float8 tip,
        COUNT(DISTINCT o."customerId") FILTER (WHERE ${done()})::int "activeCustomers"
       FROM orders o ${AnalyticsBase.PLATFORM_REFUND_JOIN} ${WHERE(conds)}`,
      p.v,
    );
    const x = rows[0];
    const netRevenue = x.revenueGross - x.promoCost;
    const margin = netRevenue - x.driverCost - x.processingCost - x.platformRefunds;
    return {
      ...x,
      netRevenue: r2(netRevenue)!,
      margin: r2(margin)!,
      aov: div(x.gmv, x.completed),
      takeRatePct: pct(netRevenue, x.gmv),
      marginPerOrder: div(margin, x.completed),
    };
  }

  /** Customers whose first completed order (in scope) falls in [from,to). */
  async newCustomers(c: Ctx, from: Date, to: Date): Promise<number> {
    const p = new Params();
    const conds = [done(), ...scopeConds(c, p)];
    const f = p.add(from);
    const t = p.add(to);
    const rows = await this.q(
      `SELECT COUNT(*)::int n FROM (SELECT o."customerId", MIN(o."createdAt") f FROM orders o ${WHERE(conds)} GROUP BY o."customerId") x WHERE x.f >= ${f} AND x.f < ${t}`,
      p.v,
    );
    return rows[0].n;
  }

  /** Marketing spend proxy for [from,to): platform promos + campaigns + referral rewards + configured other spend. */
  async marketingSpend(c: Ctx, from: Date, to: Date, promoCost: number) {
    const cpm = +this.settings.get('analytics.campaignCostPerMessage', 0.02);
    const otherMonthly = +this.settings.get('analytics.otherMarketingSpendMonthly', 0);
    const [camp] = await this.q(`SELECT COALESCE(SUM("deliveredCount"),0)::int n FROM campaigns WHERE "sentAt" >= $1 AND "sentAt" < $2`, [from, to]);
    const [ref] = await this.q(
      `SELECT COALESCE(SUM("referrerReward" + "refereeReward"),0)::float8 amt FROM referrals WHERE status = 'REWARDED' AND "rewardedAt" >= $1 AND "rewardedAt" < $2`,
      [from, to],
    );
    const days = (to.getTime() - from.getTime()) / 86400_000;
    const campaigns = camp.n * cpm;
    const other = (otherMonthly * days) / 30;
    const total = promoCost + campaigns + ref.amt + other;
    return { promoDiscounts: r2(promoCost)!, campaigns: r2(campaigns)!, referralRewards: r2(ref.amt)!, other: r2(other)!, total: r2(total)! };
  }

  startOfToday(c: Ctx) {
    return startOfLocalDay(new Date(), c.tz);
  }
}
