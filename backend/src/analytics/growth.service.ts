import { Injectable } from '@nestjs/common';
import { AuthUser } from '../common/auth.types';
import { Restaurant } from '../database/entities';
import { AnalyticsFilterDto } from './analytics.dto';
import { AnalyticsBase } from './analytics.base';
import {
  Ctx,
  Params,
  WHERE,
  addDays,
  bucketExpr,
  bucketKeys,
  div,
  done,
  fillSeries,
  kpi,
  localDate,
  pct,
  r2,
  rangeConds,
  revenueExpr,
  scopeConds,
  weekStart,
} from './analytics.util';

/** Executive dashboard + Customer & Growth dashboard (spec 12). */
@Injectable()
export class GrowthService {
  constructor(private readonly b: AnalyticsBase) {}

  // ------------------------------------------------------------------ Executive
  async executive(f: AnalyticsFilterDto, user: AuthUser) {
    const c = await this.b.ctx(f, user);
    const [cur, prev, newCur, newPrev] = await Promise.all([
      this.b.orderKpis(c, c.from, c.to),
      this.b.orderKpis(c, c.prevFrom, c.prevTo),
      this.b.newCustomers(c, c.from, c.to),
      this.b.newCustomers(c, c.prevFrom, c.prevTo),
    ]);
    const [spendCur, spendPrev] = await Promise.all([
      this.b.marketingSpend(c, c.from, c.to, cur.promoCost),
      this.b.marketingSpend(c, c.prevFrom, c.prevTo, prev.promoCost),
    ]);
    const cacCur = div(spendCur.total, newCur);
    const cacPrev = div(spendPrev.total, newPrev);
    const ltv = await this.ltv(c);

    const p = new Params();
    const bx = bucketExpr(c, p, 'o."createdAt"');
    const m = this.b.marginExpr(p);
    const rows = await this.b.q(
      `SELECT ${bx} bucket, COUNT(*)::int orders, COUNT(*) FILTER (WHERE ${done()})::int completed,
              COALESCE(SUM(o.total) FILTER (WHERE ${done()}), 0)::float8 gmv,
              COALESCE(SUM(${revenueExpr()} - o."platformPromoAmount") FILTER (WHERE ${done()}), 0)::float8 "netRevenue",
              COALESCE(SUM(${m}) FILTER (WHERE ${done()}), 0)::float8 margin,
              COUNT(DISTINCT o."customerId") FILTER (WHERE ${done()})::int "activeCustomers"
       FROM orders o ${AnalyticsBase.PLATFORM_REFUND_JOIN} ${WHERE([...rangeConds(p, 'o."createdAt"', c.from, c.to), ...scopeConds(c, p)])} GROUP BY 1`,
      p.v,
    );
    const newRows = await this.newBySeries(c);
    const series = fillSeries(bucketKeys(c.from, c.to, c.tz, c.groupBy), rows, { orders: 0, completed: 0, gmv: 0, netRevenue: 0, margin: 0, activeCustomers: 0 }).map((r) => ({
      ...r,
      gmv: r2(r.gmv)!,
      netRevenue: r2(r.netRevenue)!,
      margin: r2(r.margin)!,
      aov: div(r.gmv, r.completed),
      takeRatePct: pct(r.netRevenue, r.gmv),
      marginPerOrder: div(r.margin, r.completed),
      newCustomers: newRows.get(r.bucket) ?? 0,
    }));

    const pc = new Params();
    const byCity = await this.b.q(
      `SELECT ci.id "cityId", ci.name, COUNT(*)::int orders, COUNT(*) FILTER (WHERE ${done()})::int completed,
              COALESCE(SUM(o.total) FILTER (WHERE ${done()}), 0)::float8 gmv,
              COALESCE(SUM(${revenueExpr()} - o."platformPromoAmount") FILTER (WHERE ${done()}), 0)::float8 "netRevenue"
       FROM orders o JOIN cities ci ON ci.id = o."cityId"
       ${WHERE([...rangeConds(pc, 'o."createdAt"', c.from, c.to), ...scopeConds(c, pc)])} GROUP BY ci.id, ci.name ORDER BY gmv DESC`,
      pc.v,
    );

    return {
      range: this.b.rangeInfo(c),
      kpis: {
        gmv: kpi(cur.gmv, prev.gmv),
        netRevenue: kpi(cur.netRevenue, prev.netRevenue),
        takeRatePct: kpi(cur.takeRatePct, prev.takeRatePct),
        orders: kpi(cur.orders, prev.orders),
        completedOrders: kpi(cur.completed, prev.completed),
        aov: kpi(cur.aov, prev.aov),
        activeCustomers: kpi(cur.activeCustomers, prev.activeCustomers),
        newCustomers: kpi(newCur, newPrev),
        cac: kpi(cacCur, cacPrev),
        ltv: kpi(ltv.ltv, null),
        ltvToCac: kpi(cacCur && ltv.ltv ? r2(ltv.ltv / cacCur) : null, cacPrev && ltv.ltv ? r2(ltv.ltv / cacPrev) : null),
        marginPerOrder: kpi(cur.marginPerOrder, prev.marginPerOrder),
        contributionMargin: kpi(cur.margin, prev.margin),
        cancellationRatePct: kpi(pct(cur.cancelled + cur.rejected, cur.orders), pct(prev.cancelled + prev.rejected, prev.orders)),
      },
      marketingSpend: { current: spendCur, previous: spendPrev },
      economics: {
        definition: 'GMV = customer total of delivered/collected orders. Net revenue = commission + delivery/service/small-order fees - platform-funded promos. Margin = net revenue - driver pay/boost - payment processing - platform-charged refunds.',
        current: { gmv: cur.gmv, revenueGross: cur.revenueGross, promoCost: cur.promoCost, netRevenue: cur.netRevenue, driverCost: cur.driverCost, processingCost: cur.processingCost, platformRefunds: cur.platformRefunds, margin: cur.margin, tax: cur.tax, tip: cur.tip },
        ltv,
      },
      series,
      byCity,
    };
  }

  private async newBySeries(c: Ctx) {
    const p = new Params();
    const conds = [done(), ...scopeConds(c, p)];
    const bx = bucketExpr(c, p, 'x.f');
    const rows = await this.b.q(
      `SELECT ${bx} bucket, COUNT(*)::int n FROM (SELECT o."customerId", MIN(o."createdAt") f FROM orders o ${WHERE(conds)} GROUP BY o."customerId") x
       WHERE x.f >= ${p.add(c.from)} AND x.f < ${p.add(c.to)} GROUP BY 1`,
      p.v,
    );
    return new Map<string, number>(rows.map((r) => [r.bucket, r.n]));
  }

  /** Observed lifetime contribution margin per customer (all completed orders up to range end). */
  async ltv(c: Ctx) {
    const p = new Params();
    const m = this.b.marginExpr(p);
    const [x] = await this.b.q(
      `SELECT COUNT(*)::int customers, COALESCE(AVG(t.m), 0)::float8 ltv, COALESCE(AVG(t.n), 0)::float8 "ordersPerCustomer", COALESCE(AVG(t.g), 0)::float8 "gmvPerCustomer"
       FROM (SELECT o."customerId", SUM(${m}) m, COUNT(*) n, SUM(o.total) g FROM orders o ${AnalyticsBase.PLATFORM_REFUND_JOIN}
             ${WHERE([done(), `o."createdAt" < ${p.add(c.to)}`, ...scopeConds(c, p)])} GROUP BY o."customerId") t`,
      p.v,
    );
    return { ltv: r2(x.ltv), ordersPerCustomer: r2(x.ordersPerCustomer), gmvPerCustomer: r2(x.gmvPerCustomer), customers: x.customers };
  }

  /** Customers with a completed order in the 30 days ending at `end` who placed >= 2. (used by pilot KPIs too) */
  async repeat30Trailing(c: Ctx, end: Date) {
    const p = new Params();
    const [x] = await this.b.q(
      `SELECT COUNT(*)::int customers, COUNT(*) FILTER (WHERE t.n >= 2)::int repeaters
       FROM (SELECT o."customerId", COUNT(*) n FROM orders o ${WHERE([done(), `o."createdAt" >= ${p.add(new Date(end.getTime() - 30 * 86400_000))}`, `o."createdAt" < ${p.add(end)}`, ...scopeConds(c, p)])} GROUP BY 1) t`,
      p.v,
    );
    return { customers: x.customers, repeaters: x.repeaters, ratePct: pct(x.repeaters, x.customers) };
  }

  // ------------------------------------------------------------------ Customer & Growth
  async customerGrowth(f: AnalyticsFilterDto, user: AuthUser) {
    const c = await this.b.ctx(f, user);
    const nCohorts = f.cohorts ?? 8;
    const [activeSeries, newRows, cohorts, repeatMatured, trailing, freq, cuisines, promos, referrals, funnel] = await Promise.all([
      this.activeSeries(c),
      this.newBySeries(c),
      this.cohorts(c, nCohorts),
      this.repeatMatured(c),
      this.repeat30Trailing(c, c.to),
      this.frequency(c),
      this.topCuisines(c),
      this.promoRoi(c),
      this.referrals(c),
      this.funnel(c),
    ]);
    const series = fillSeries(bucketKeys(c.from, c.to, c.tz, c.groupBy), activeSeries, { active: 0, orders: 0 }).map((r) => {
      const nw = Math.min(newRows.get(r.bucket) ?? 0, r.active);
      return { bucket: r.bucket, orders: r.orders, activeCustomers: r.active, newCustomers: nw, returningCustomers: r.active - nw };
    });
    const totalActive = freq.activeCustomers;
    const totalNew = series.reduce((s, r) => s + r.newCustomers, 0);
    return {
      range: this.b.rangeInfo(c),
      kpis: {
        activeCustomers: totalActive,
        newCustomers: totalNew,
        returningCustomers: Math.max(totalActive - totalNew, 0),
        newSharePct: pct(totalNew, totalActive),
        repeatRate30dMaturedCohortPct: repeatMatured.ratePct,
        repeatRate30dTrailingPct: trailing.ratePct,
        ordersPerActiveCustomer: freq.avgOrders,
        promoRoiPct: promos.totals.roiPct,
        referralConversionPct: referrals.conversionPct,
      },
      series,
      retentionCohorts: cohorts,
      repeatRate: { maturedCohort: repeatMatured, trailing30d: trailing },
      orderFrequency: freq,
      topCuisines: cuisines,
      promoRoi: promos,
      referrals,
      funnel,
    };
  }

  private async activeSeries(c: Ctx) {
    const p = new Params();
    const bx = bucketExpr(c, p, 'o."createdAt"');
    return this.b.q<{ bucket: string; active: number; orders: number }>(
      `SELECT ${bx} bucket, COUNT(DISTINCT o."customerId")::int active, COUNT(*)::int orders FROM orders o
       ${WHERE([done(), ...rangeConds(p, 'o."createdAt"', c.from, c.to), ...scopeConds(c, p)])} GROUP BY 1`,
      p.v,
    );
  }

  /** Weekly cohort retention matrix: cohort = ISO week of first completed order; cell = % of cohort ordering N weeks later. */
  async cohorts(c: Ctx, n: number) {
    const curWeek = weekStart(localDate(new Date(c.to.getTime() - 1), c.tz));
    const startWeek = addDays(curWeek, -7 * (n - 1));
    const p = new Params();
    const tz = p.add(c.tz);
    const sc = scopeConds(c, p);
    const rows = await this.b.q(
      `WITH fo AS (
         SELECT o."customerId", date_trunc('week', MIN(o."createdAt") AT TIME ZONE ${tz}::text)::date cw FROM orders o ${WHERE([done(), ...sc])} GROUP BY o."customerId"
       ), act AS (
         SELECT DISTINCT o."customerId", date_trunc('week', o."createdAt" AT TIME ZONE ${tz}::text)::date aw FROM orders o ${WHERE([done(), ...sc])}
       )
       SELECT to_char(fo.cw, 'YYYY-MM-DD') cohort, ((act.aw - fo.cw) / 7)::int wk, COUNT(*)::int n
       FROM fo JOIN act ON act."customerId" = fo."customerId"
       WHERE fo.cw >= ${p.add(startWeek)}::date AND act.aw >= fo.cw GROUP BY 1, 2`,
      p.v,
    );
    const out: any[] = [];
    for (let i = 0; i < n; i++) {
      const cw = addDays(startWeek, 7 * i);
      const weeksElapsed = i === n - 1 ? 0 : n - 1 - i;
      const mine = rows.filter((r) => r.cohort === cw);
      const size = mine.find((r) => r.wk === 0)?.n ?? 0;
      const retention = [];
      for (let w = 0; w <= weeksElapsed; w++) {
        const cnt = mine.find((r) => r.wk === w)?.n ?? 0;
        retention.push({ week: w, customers: cnt, pct: pct(cnt, size) });
      }
      out.push({ cohortWeek: cw, size, retention });
    }
    return out;
  }

  private async repeatMatured(c: Ctx) {
    const p = new Params();
    const matureBefore = new Date(Math.min(c.to.getTime(), Date.now() - 30 * 86400_000));
    const [x] = await this.b.q(
      `WITH fo AS (SELECT o."customerId", MIN(o."createdAt") f FROM orders o ${WHERE([done(), ...scopeConds(c, p)])} GROUP BY o."customerId")
       SELECT COUNT(*)::int customers,
              COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM orders o2 WHERE o2."customerId" = fo."customerId" AND o2.status IN ('DELIVERED','COLLECTED') AND o2."createdAt" > fo.f AND o2."createdAt" <= fo.f + interval '30 days'))::int repeaters
       FROM fo WHERE fo.f >= ${p.add(c.from)} AND fo.f < ${p.add(matureBefore)}`,
      p.v,
    );
    return { customers: x.customers, repeaters: x.repeaters, ratePct: pct(x.repeaters, x.customers), note: 'Customers whose first completed order in range is at least 30 days old; repeater = another completed order within 30 days.' };
  }

  private async frequency(c: Ctx) {
    const p = new Params();
    const [x] = await this.b.q(
      `SELECT COUNT(*)::int customers, COALESCE(AVG(t.n), 0)::float8 avg,
              COUNT(*) FILTER (WHERE t.n = 1)::int one, COUNT(*) FILTER (WHERE t.n = 2)::int two,
              COUNT(*) FILTER (WHERE t.n BETWEEN 3 AND 4)::int "threeFour", COUNT(*) FILTER (WHERE t.n >= 5)::int "fivePlus"
       FROM (SELECT o."customerId", COUNT(*) n FROM orders o ${WHERE([done(), ...rangeConds(p, 'o."createdAt"', c.from, c.to), ...scopeConds(c, p)])} GROUP BY 1) t`,
      p.v,
    );
    return {
      activeCustomers: x.customers,
      avgOrders: r2(x.avg),
      distribution: [
        { orders: '1', customers: x.one },
        { orders: '2', customers: x.two },
        { orders: '3-4', customers: x.threeFour },
        { orders: '5+', customers: x.fivePlus },
      ],
    };
  }

  private async topCuisines(c: Ctx) {
    const md = this.b.ds.getMetadata(Restaurant).findRelationWithPropertyPath('cuisines')!;
    const jt = md.junctionEntityMetadata!;
    const own = jt.ownerColumns[0].databaseName;
    const inv = jt.inverseColumns[0].databaseName;
    const p = new Params();
    return this.b.q(
      `SELECT cu.id "cuisineId", cu.name, COUNT(DISTINCT o.id)::int orders, COUNT(DISTINCT o."restaurantId")::int restaurants, COUNT(DISTINCT o."customerId")::int customers,
              COALESCE(SUM(o.total), 0)::float8 gmv
       FROM orders o JOIN "${jt.tableName}" j ON j."${own}" = o."restaurantId" JOIN cuisines cu ON cu.id = j."${inv}"
       ${WHERE([done(), ...rangeConds(p, 'o."createdAt"', c.from, c.to), ...scopeConds(c, p)])}
       GROUP BY cu.id, cu.name ORDER BY orders DESC LIMIT 15`,
      p.v,
    );
  }

  private async promoRoi(c: Ctx) {
    const p = new Params();
    const sc = scopeConds(c, p);
    const rows = await this.b.q(
      `WITH fo AS (SELECT o."customerId", MIN(o."createdAt") f FROM orders o WHERE ${done()} GROUP BY o."customerId")
       SELECT pm.id "promotionId", pm.code, pm.name, pm.type, pm."fundedBy",
              COUNT(pr.id)::int redemptions, COALESCE(SUM(pr.discount), 0)::float8 "discountCost",
              COALESCE(SUM(pr.discount) FILTER (WHERE pm."fundedBy" = 'PLATFORM'), 0)::float8 "platformCost",
              COALESCE(SUM(o.total), 0)::float8 gmv, COALESCE(SUM(${revenueExpr()}), 0)::float8 "grossRevenue",
              COUNT(*) FILTER (WHERE fo.f = o."createdAt")::int "newCustomers"
       FROM promo_redemptions pr JOIN promotions pm ON pm.id = pr."promotionId" JOIN orders o ON o.id = pr."orderId" AND ${done()}
       LEFT JOIN fo ON fo."customerId" = o."customerId"
       ${WHERE([...rangeConds(p, 'pr."createdAt"', c.from, c.to), ...sc])} GROUP BY pm.id ORDER BY "discountCost" DESC LIMIT 50`,
      p.v,
    );
    const fmt = (r: any) => ({
      ...r,
      discountCost: r2(r.discountCost),
      platformCost: r2(r.platformCost),
      gmv: r2(r.gmv),
      grossRevenue: r2(r.grossRevenue),
      gmvPerDiscountDollar: div(r.gmv, r.discountCost),
      roiPct: r.platformCost > 0 ? r2(((r.grossRevenue - r.platformCost) / r.platformCost) * 100) : null,
    });
    const table = rows.map(fmt);
    const t = rows.reduce(
      (s, r) => ({ redemptions: s.redemptions + r.redemptions, discountCost: s.discountCost + r.discountCost, platformCost: s.platformCost + r.platformCost, gmv: s.gmv + r.gmv, grossRevenue: s.grossRevenue + r.grossRevenue, newCustomers: s.newCustomers + r.newCustomers }),
      { redemptions: 0, discountCost: 0, platformCost: 0, gmv: 0, grossRevenue: 0, newCustomers: 0 },
    );
    return { totals: fmt(t), table, definition: 'roiPct = (commission+fees earned on redeemed orders - platform-funded discount) / platform-funded discount. Upper bound: assumes orders are fully incremental.' };
  }

  private async referrals(c: Ctx) {
    const [x] = await this.b.q(
      `SELECT COUNT(*)::int total, COUNT(*) FILTER (WHERE status = 'REWARDED')::int rewarded, COUNT(*) FILTER (WHERE status = 'PENDING')::int pending, COUNT(*) FILTER (WHERE status = 'VOID')::int void,
              COALESCE(SUM("referrerReward" + "refereeReward") FILTER (WHERE status = 'REWARDED'), 0)::float8 "rewardsPaid"
       FROM referrals WHERE "createdAt" >= $1 AND "createdAt" < $2`,
      [c.from, c.to],
    );
    const [o] = await this.b.q(
      `SELECT COUNT(*)::int orders, COALESCE(SUM(o.total), 0)::float8 gmv FROM orders o JOIN referrals r ON r."refereeId" = o."customerId"
       WHERE ${done()} AND o."createdAt" >= $1 AND o."createdAt" < $2 AND r.status <> 'VOID'`,
      [c.from, c.to],
    );
    return { ...x, rewardsPaid: r2(x.rewardsPaid), conversionPct: pct(x.rewarded, x.total), referredOrders: o.orders, referredGmv: r2(o.gmv), costPerReferredCustomer: div(x.rewardsPaid, x.rewarded) };
  }

  /** App funnel approximations: signups -> first order -> delivered -> repeat, plus carts -> orders -> delivered. */
  private async funnel(c: Ctx) {
    const [s] = await this.b.q(
      `WITH su AS (SELECT id FROM users WHERE type = 'CUSTOMER' AND "createdAt" >= $1 AND "createdAt" < $2),
            oc AS (SELECT o."customerId", COUNT(*)::int placed, COUNT(*) FILTER (WHERE o.status IN ('DELIVERED','COLLECTED'))::int completed FROM orders o WHERE o."customerId" IN (SELECT id FROM su) GROUP BY 1)
       SELECT (SELECT COUNT(*) FROM su)::int signups, COUNT(*)::int "placedFirstOrder", COUNT(*) FILTER (WHERE completed >= 1)::int "completedFirstOrder", COUNT(*) FILTER (WHERE completed >= 2)::int "repeatCustomers" FROM oc`,
      [c.from, c.to],
    );
    const p = new Params();
    const sc = scopeConds(c, p);
    const [o] = await this.b.q(
      `SELECT COUNT(*)::int placed, COUNT(*) FILTER (WHERE ${done()})::int delivered, COUNT(*) FILTER (WHERE o.status IN ('CANCELLED','REJECTED'))::int failed
       FROM orders o ${WHERE([...rangeConds(p, 'o."createdAt"', c.from, c.to), ...sc])}`,
      p.v,
    );
    const [cart] = await this.b.q(`SELECT COUNT(*)::int n FROM carts WHERE "createdAt" >= $1 AND "createdAt" < $2`, [c.from, c.to]);
    return {
      signupFunnel: [
        { step: 'Signed up', count: s.signups, pctOfPrevious: 100 },
        { step: 'Placed first order', count: s.placedFirstOrder, pctOfPrevious: pct(s.placedFirstOrder, s.signups) },
        { step: 'First order delivered', count: s.completedFirstOrder, pctOfPrevious: pct(s.completedFirstOrder, s.placedFirstOrder) },
        { step: 'Repeat order', count: s.repeatCustomers, pctOfPrevious: pct(s.repeatCustomers, s.completedFirstOrder) },
      ],
      checkoutFunnel: [
        { step: 'Carts started', count: cart.n, pctOfPrevious: 100 },
        { step: 'Orders placed', count: o.placed, pctOfPrevious: pct(o.placed, cart.n) },
        { step: 'Orders delivered', count: o.delivered, pctOfPrevious: pct(o.delivered, o.placed) },
      ],
    };
  }
}
