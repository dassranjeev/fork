import { Injectable } from '@nestjs/common';
import { AuthUser } from '../common/auth.types';
import { AnalyticsFilterDto } from './analytics.dto';
import { AnalyticsBase } from './analytics.base';
import {
  ACTIVE,
  Ctx,
  Params,
  WHERE,
  active,
  addDays,
  bucketExpr,
  bucketKeys,
  done,
  fillSeries,
  kpi,
  localDate,
  pct,
  r2,
  rangeConds,
  scopeConds,
  zonedInstant,
} from './analytics.util';

/** Home dashboard (spec 3.2) + Live Operations dashboard (spec 12). Real-time - no caching. */
@Injectable()
export class DashboardService {
  constructor(private readonly b: AnalyticsBase) {}

  /** Conditions for driver_profiles ("d" alias) honouring city/zone scope. */
  private driverScope(c: Ctx, p: Params, a = 'd') {
    const out: string[] = [];
    if (c.cityIds) out.push(`${a}."cityId" = ANY(${p.add(c.cityIds)}::uuid[])`);
    if (c.zoneIds) out.push(`${a}."activeZoneId" = ANY(${p.add(c.zoneIds)}::uuid[])`);
    return out;
  }

  private async liveByStatus(c: Ctx) {
    const p = new Params();
    const rows = await this.b.q(
      `SELECT o.status, COUNT(*)::int count, COALESCE(MAX(EXTRACT(EPOCH FROM (now() - o."createdAt")) / 60), 0)::float8 "oldestMin",
              COUNT(*) FILTER (WHERE o."isLate")::int late
       FROM orders o ${WHERE([active(), ...scopeConds(c, p)])} GROUP BY o.status`,
      p.v,
    );
    const order = ['PLACED', 'ACCEPTED', 'DRIVER_ASSIGNED', 'PREPARING', 'READY', 'PICKED_UP', 'ON_THE_WAY'];
    const m = new Map(rows.map((r) => [r.status, r]));
    return order.map((s) => ({ status: s, count: m.get(s)?.count ?? 0, late: m.get(s)?.late ?? 0, oldestMin: r2(m.get(s)?.oldestMin ?? 0)! }));
  }

  private unassignedCond(a = 'o') {
    return `${a}."type" = 'DELIVERY' AND ${a}."fulfilment" = 'PLATFORM_DRIVER' AND ${a}."driverId" IS NULL AND ${a}."status" IN ('ACCEPTED','PREPARING','READY')`;
  }

  /** GET /admin/dashboard */
  async home(f: AnalyticsFilterDto, user: AuthUser) {
    const c = await this.b.ctx(f, user);
    const tz = c.tz;
    const now = new Date();
    const today = localDate(now, tz);
    const t0 = zonedInstant(today, 0, tz);
    const t1 = zonedInstant(addDays(today, 1), 0, tz);
    const y0 = zonedInstant(addDays(today, -1), 0, tz);
    const w0 = zonedInstant(addDays(today, -7), 0, tz);
    const elapsed = now.getTime() - t0.getTime();
    const sameTimeYesterday = new Date(y0.getTime() + elapsed);
    const sameTimeLastWeek = new Date(w0.getTime() + elapsed);

    const [todayK, ydayK, ydaySoFar, lastWeekSoFar] = await Promise.all([
      this.b.orderKpis(c, t0, t1),
      this.b.orderKpis(c, y0, t0),
      this.b.orderKpis(c, y0, sameTimeYesterday),
      this.b.orderKpis(c, w0, sameTimeLastWeek),
    ]);

    const live = await this.liveByStatus(c);
    const p1 = new Params();
    const [ex] = await this.b.q(
      `SELECT COUNT(*) FILTER (WHERE o."isLate")::int late,
              COUNT(*) FILTER (WHERE ${this.unassignedCond()})::int unassigned,
              COUNT(*) FILTER (WHERE o."escalationLevel" >= 2)::int escalated
       FROM orders o ${WHERE([active(), ...scopeConds(c, p1)])}`,
      p1.v,
    );

    const p2 = new Params();
    const [drv] = await this.b.q(
      `SELECT COUNT(*) FILTER (WHERE d."isOnline")::int online, COUNT(*) FILTER (WHERE d."isOnline" AND d."onTrip")::int "onTrip",
              COUNT(*) FILTER (WHERE d."isOnline" AND NOT d."onTrip")::int idle
       FROM driver_profiles d ${WHERE([`d.status = 'ACTIVE'`, ...this.driverScope(c, p2)])}`,
      p2.v,
    );

    const p3 = new Params();
    const scoped = c.cityIds || c.zoneIds || c.restaurantIds;
    const tickets = await this.b.q(
      scoped
        ? `SELECT COUNT(*)::int n FROM tickets t JOIN orders o ON o.id = t."orderId" ${WHERE([`t.status IN ('OPEN','PENDING','ESCALATED')`, ...scopeConds(c, p3)])}`
        : `SELECT COUNT(*)::int n FROM tickets t WHERE t.status IN ('OPEN','PENDING','ESCALATED')`,
      p3.v,
    );
    const [breach] = await this.b.q(`SELECT COUNT(*)::int n FROM tickets WHERE status IN ('OPEN','PENDING','ESCALATED') AND "slaBreached"`);

    const approvals = await this.pendingApprovals(c);

    const p4 = new Params();
    const top = await this.b.q(
      `SELECT r.id "restaurantId", r.name, COUNT(*)::int orders, COALESCE(SUM(o.total) FILTER (WHERE ${done()}), 0)::float8 gmv
       FROM orders o JOIN restaurants r ON r.id = o."restaurantId"
       ${WHERE([...rangeConds(p4, 'o."createdAt"', t0, t1), `o.status NOT IN ('CANCELLED','REJECTED')`, ...scopeConds(c, p4)])}
       GROUP BY r.id, r.name ORDER BY gmv DESC, orders DESC LIMIT 5`,
      p4.v,
    );

    const hourly = await this.hourly(c, y0, t1);
    const byCity = await this.breakdown(c, t0, t1, 'city');
    const byZone = await this.breakdown(c, t0, t1, 'zone');

    return {
      generatedAt: now.toISOString(),
      timezone: tz,
      live: { byStatus: live, activeOrders: live.reduce((s, x) => s + x.count, 0), late: ex.late, unassigned: ex.unassigned, escalated: ex.escalated },
      today: {
        gmv: kpi(todayK.gmv, ydaySoFar.gmv),
        orders: kpi(todayK.orders, ydaySoFar.orders),
        completedOrders: kpi(todayK.completed, ydaySoFar.completed),
        aov: kpi(todayK.aov, ydaySoFar.aov),
        cancellations: kpi(todayK.cancelled + todayK.rejected, ydaySoFar.cancelled + ydaySoFar.rejected),
        cancellationRatePct: pct(todayK.cancelled + todayK.rejected, todayK.orders),
      },
      gmvComparison: {
        today: todayK.gmv,
        yesterdaySoFar: ydaySoFar.gmv,
        yesterdayFull: ydayK.gmv,
        lastWeekSameDaySoFar: lastWeekSoFar.gmv,
        vsYesterdayPct: kpi(todayK.gmv, ydaySoFar.gmv).changePct,
        vsLastWeekPct: kpi(todayK.gmv, lastWeekSoFar.gmv).changePct,
      },
      drivers: { online: drv.online, onTrip: drv.onTrip, idle: drv.idle },
      openTickets: { total: tickets[0].n, slaBreached: breach.n },
      pendingApprovals: approvals,
      topRestaurants: top,
      hourlyOrders: hourly,
      byCity,
      byZone,
    };
  }

  private async pendingApprovals(c: Ctx) {
    const pr = new Params();
    const rc: string[] = [`r.status IN ('APPLIED','DOCS_REVIEW','MENU_SETUP','TEST_ORDER')`];
    if (c.cityIds) rc.push(`r."cityId" = ANY(${pr.add(c.cityIds)}::uuid[])`);
    if (c.zoneIds) rc.push(`r."zoneId" = ANY(${pr.add(c.zoneIds)}::uuid[])`);
    const pd = new Params();
    const dc = [`d.status IN ('APPLIED','DOCS_REVIEW','BACKGROUND_CHECK','TRAINING')`, ...this.driverScope(c, pd)];
    const [r] = await this.b.q(`SELECT COUNT(*)::int n FROM restaurants r ${WHERE(rc)}`, pr.v);
    const [d] = await this.b.q(`SELECT COUNT(*)::int n FROM driver_profiles d ${WHERE(dc)}`, pd.v);
    const [rd] = await this.b.q(`SELECT COUNT(*)::int n FROM restaurant_documents WHERE status = 'PENDING'`);
    const [dd] = await this.b.q(`SELECT COUNT(*)::int n FROM driver_documents WHERE status = 'PENDING'`);
    const [pp] = await this.b.q(`SELECT COUNT(*)::int n FROM promotions WHERE "pendingApproval" = true`);
    const [rf] = await this.b.q(`SELECT COUNT(*)::int n FROM refunds WHERE status = 'PENDING_APPROVAL'`);
    return {
      restaurants: r.n,
      drivers: d.n,
      restaurantDocuments: rd.n,
      driverDocuments: dd.n,
      promotions: pp.n,
      refunds: rf.n,
      total: r.n + d.n + rd.n + dd.n + pp.n + rf.n,
    };
  }

  /** Orders per local hour for yesterday + today (24 points each). */
  private async hourly(c: Ctx, from: Date, to: Date) {
    const p = new Params();
    const tzp = p.add(c.tz);
    const rows = await this.b.q(
      `SELECT to_char(date_trunc('day', o."createdAt" AT TIME ZONE ${tzp}::text), 'YYYY-MM-DD') d,
              EXTRACT(HOUR FROM o."createdAt" AT TIME ZONE ${tzp}::text)::int h, COUNT(*)::int orders,
              COALESCE(SUM(o.total) FILTER (WHERE ${done()}), 0)::float8 gmv
       FROM orders o ${WHERE([...rangeConds(p, 'o."createdAt"', from, to), `o.status NOT IN ('CANCELLED','REJECTED')`, ...scopeConds(c, p)])}
       GROUP BY 1, 2`,
      p.v,
    );
    const today = localDate(new Date(), c.tz);
    const yday = addDays(today, -1);
    const mk = (day: string) => Array.from({ length: 24 }, (_, h) => ({ hour: h, orders: rows.find((r) => r.d === day && r.h === h)?.orders ?? 0, gmv: rows.find((r) => r.d === day && r.h === h)?.gmv ?? 0 }));
    return { today: mk(today), yesterday: mk(yday) };
  }

  private async breakdown(c: Ctx, from: Date, to: Date, by: 'city' | 'zone') {
    const p = new Params();
    const key = by === 'city' ? 'cityId' : 'zoneId';
    const tbl = by === 'city' ? 'cities' : 'zones';
    const pf = p.add(from);
    const pt = p.add(to);
    const inRange = `(o."createdAt" >= ${pf} AND o."createdAt" < ${pt})`;
    const rows = await this.b.q(
      `SELECT x.id, x.name ${by === 'zone' ? ', x."cityId"' : ''},
              COUNT(o.id) FILTER (WHERE ${inRange})::int orders,
              COALESCE(SUM(o.total) FILTER (WHERE ${inRange} AND ${done()}), 0)::float8 gmv,
              COUNT(o.id) FILTER (WHERE ${active()})::int "activeOrders",
              COUNT(o.id) FILTER (WHERE ${active()} AND o."isLate")::int "lateOrders",
              COUNT(o.id) FILTER (WHERE ${inRange} AND o.status IN ('CANCELLED','REJECTED'))::int cancellations
       FROM ${tbl} x
       LEFT JOIN orders o ON o."${key}" = x.id AND (${inRange} OR ${active()})
       ${WHERE([
         ...(by === 'city' && c.cityIds ? [`x.id = ANY(${p.add(c.cityIds)}::uuid[])`] : []),
         ...(by === 'zone' && c.cityIds ? [`x."cityId" = ANY(${p.add(c.cityIds)}::uuid[])`] : []),
         ...(by === 'zone' && c.zoneIds ? [`x.id = ANY(${p.add(c.zoneIds)}::uuid[])`] : []),
       ])}
       GROUP BY x.id, x.name ${by === 'zone' ? ', x."cityId"' : ''} ORDER BY gmv DESC, x.name`,
      p.v,
    );
    const pd = new Params();
    const dcol = by === 'city' ? 'cityId' : 'activeZoneId';
    const drv = await this.b.q(
      `SELECT d."${dcol}" id, COUNT(*)::int online FROM driver_profiles d WHERE d."isOnline" AND d.status = 'ACTIVE' GROUP BY 1`,
      pd.v,
    );
    return rows.map((r) => ({ ...r, driversOnline: drv.find((d) => d.id === r.id)?.online ?? 0 }));
  }

  // ------------------------------------------------------------------ Live Operations
  /** GET /admin/analytics/live-ops */
  async liveOps(f: AnalyticsFilterDto, user: AuthUser) {
    const c = await this.b.ctx(f, user);
    const now = new Date();
    const hourAgo = new Date(now.getTime() - 3600_000);
    const t0 = zonedInstant(localDate(now, c.tz), 0, c.tz);
    const byStatus = await this.liveByStatus(c);

    const timing = async (from: Date) => {
      const p = new Params();
      const [x] = await this.b.q(
        `SELECT COUNT(*)::int n,
                COALESCE(AVG(EXTRACT(EPOCH FROM (o."deliveredAt" - o."createdAt")) / 60), 0)::float8 "avgDeliveryMin",
                COALESCE(AVG(EXTRACT(EPOCH FROM (o."deliveredAt" - o."pickedUpAt")) / 60), 0)::float8 "avgLastMileMin",
                COALESCE(AVG(EXTRACT(EPOCH FROM (o."acceptedAt" - o."createdAt")) / 60), 0)::float8 "avgAcceptMin",
                COALESCE(AVG(EXTRACT(EPOCH FROM (o."driverAssignedAt" - o."acceptedAt")) / 60), 0)::float8 "avgAssignMin"
         FROM orders o ${WHERE([`o.status = 'DELIVERED'`, `o."deliveredAt" >= ${p.add(from)}`, ...scopeConds(c, p)])}`,
        p.v,
      );
      return { deliveredOrders: x.n, avgDeliveryMin: r2(x.avgDeliveryMin), avgLastMileMin: r2(x.avgLastMileMin), avgAcceptMin: r2(x.avgAcceptMin), avgAssignMin: r2(x.avgAssignMin) };
    };
    const [lastHour, todayT] = await Promise.all([timing(hourAgo), timing(t0)]);

    const p1 = new Params();
    const [tot] = await this.b.q(
      `SELECT COUNT(*) FILTER (WHERE o."isLate")::int late, COUNT(*) FILTER (WHERE ${this.unassignedCond()})::int unassigned,
              COUNT(*) FILTER (WHERE o."escalationLevel" >= 2)::int escalated
       FROM orders o ${WHERE([active(), ...scopeConds(c, p1)])}`,
      p1.v,
    );

    const p2 = new Params();
    const attention = await this.b.q(
      `SELECT o.id, o.code, o.status, o."isLate", o."escalationLevel", o."unassignedFlag", o."restaurantId", r.name "restaurantName", o."zoneId", z.name "zoneName", o."driverId",
              ROUND((EXTRACT(EPOCH FROM (now() - o."createdAt")) / 60)::numeric, 1)::float8 "ageMin",
              CASE WHEN o."estimatedDeliveryAt" < now() THEN ROUND((EXTRACT(EPOCH FROM (now() - o."estimatedDeliveryAt")) / 60)::numeric, 1)::float8 ELSE 0 END "minutesOverEta",
              (${this.unassignedCond()}) unassigned
       FROM orders o JOIN restaurants r ON r.id = o."restaurantId" LEFT JOIN zones z ON z.id = o."zoneId"
       ${WHERE([active(), `(o."isLate" OR o."escalationLevel" >= 1 OR (${this.unassignedCond()}))`, ...scopeConds(c, p2)])}
       ORDER BY o."escalationLevel" DESC, "minutesOverEta" DESC, o."createdAt" ASC LIMIT 50`,
      p2.v,
    );

    const zones = await this.supplyDemand(c);

    const hp = new Params();
    const hourlyRows = await this.b.q(
      `SELECT ${bucketExpr(c, hp, 'o."createdAt"', 'day')} bucket, EXTRACT(HOUR FROM o."createdAt" AT TIME ZONE ${hp.add(c.tz)}::text)::int h, COUNT(*)::int orders
       FROM orders o ${WHERE([...rangeConds(hp, 'o."createdAt"', t0, new Date(now.getTime() + 1)), ...scopeConds(c, hp)])} GROUP BY 1, 2 ORDER BY 2`,
      hp.v,
    );

    return {
      generatedAt: now.toISOString(),
      timezone: c.tz,
      kpis: {
        activeOrders: byStatus.reduce((s, x) => s + x.count, 0),
        lateOrders: tot.late,
        unassignedOrders: tot.unassigned,
        escalatedOrders: tot.escalated,
        avgDeliveryMinLastHour: lastHour.avgDeliveryMin,
        avgDeliveryMinToday: todayT.avgDeliveryMin,
        driversOnline: zones.reduce((s, z) => s + z.driversOnline, 0),
        driversIdle: zones.reduce((s, z) => s + z.driversIdle, 0),
      },
      byStatus,
      timings: { lastHour, today: todayT },
      driversVsDemandByZone: zones,
      needsAttention: attention,
      todayOrdersByHour: hourlyRows.map((r) => ({ hour: r.h, orders: r.orders })),
    };
  }

  /** Drivers vs open demand per zone. */
  async supplyDemand(c: Ctx) {
    const p = new Params();
    const conds: string[] = [`z.active = true`];
    if (c.cityIds) conds.push(`z."cityId" = ANY(${p.add(c.cityIds)}::uuid[])`);
    if (c.zoneIds) conds.push(`z.id = ANY(${p.add(c.zoneIds)}::uuid[])`);
    const rows = await this.b.q(
      `SELECT z.id "zoneId", z.name "zoneName", z."cityId", z."targetDrivers" "targetDrivers",
        (SELECT COUNT(*) FROM driver_profiles d WHERE d."isOnline" AND d.status = 'ACTIVE' AND d."activeZoneId" = z.id)::int "driversOnline",
        (SELECT COUNT(*) FROM driver_profiles d WHERE d."isOnline" AND d.status = 'ACTIVE' AND d."activeZoneId" = z.id AND NOT d."onTrip")::int "driversIdle",
        (SELECT COUNT(*) FROM orders o WHERE o."zoneId" = z.id AND o.status IN ${ACTIVE})::int "activeOrders",
        (SELECT COUNT(*) FROM orders o WHERE o."zoneId" = z.id AND ${this.unassignedCond()})::int "ordersWaitingForDriver"
       FROM zones z ${WHERE(conds)} ORDER BY z.name`,
      p.v,
    );
    return rows.map((r) => {
      // one courier can carry ~1.5 concurrent orders in the pilot; demand = orders still needing a courier + in-flight
      const demandDrivers = Math.ceil((r.ordersWaitingForDriver + (r.activeOrders - r.ordersWaitingForDriver) * 0.5) / 1.5);
      const gap = r.driversIdle - r.ordersWaitingForDriver;
      return {
        ...r,
        ordersPerDriver: r.driversOnline ? r2(r.activeOrders / r.driversOnline) : null,
        driverGap: r.driversOnline - Math.max(demandDrivers, 0),
        status: r.ordersWaitingForDriver > 0 && gap < 0 ? 'SHORT' : r.targetDrivers && r.driversOnline < r.targetDrivers ? 'BELOW_TARGET' : 'OK',
      };
    });
  }

  // used by executive series and other services
  async ordersSeries(c: Ctx) {
    const p = new Params();
    const b = bucketExpr(c, p, 'o."createdAt"');
    const rows = await this.b.q(
      `SELECT ${b} bucket, COUNT(*)::int orders, COUNT(*) FILTER (WHERE ${done()})::int completed FROM orders o ${WHERE([...rangeConds(p, 'o."createdAt"', c.from, c.to), ...scopeConds(c, p)])} GROUP BY 1`,
      p.v,
    );
    return fillSeries(bucketKeys(c.from, c.to, c.tz, c.groupBy), rows, { orders: 0, completed: 0 });
  }
}
