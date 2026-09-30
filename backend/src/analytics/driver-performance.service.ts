import { Injectable } from '@nestjs/common';
import { AuthUser } from '../common/auth.types';
import { AnalyticsFilterDto } from './analytics.dto';
import { AnalyticsBase } from './analytics.base';
import { Params, WHERE, div, driverScopeConds, paged, pct, r2 } from './analytics.util';

/** Admin "Driver Performance" dashboard (spec §12): ranking table + fleet KPIs. */
@Injectable()
export class DriverPerformanceService {
  constructor(private readonly b: AnalyticsBase) {}

  /** GET /admin/analytics/driver-performance */
  async list(f: AnalyticsFilterDto, user: AuthUser) {
    const c = await this.b.ctx(f, user);
    const p = new Params();
    const from = p.add(c.from);
    const to = p.add(c.to);
    const scope: string[] = [`d.status <> 'REJECTED'`, ...driverScopeConds(c, p)];

    const sortMap: Record<string, string> = {
      trips: 'trips',
      earnings: 'earnings',
      rating: 'd."rating"',
      onTimeRate: 'd."onTimeRate"',
      acceptanceRate: 'd."acceptanceRate"',
    };
    const sortCol = (c.sortBy && sortMap[c.sortBy]) || 'trips';
    const dir = c.sortBy && sortMap[c.sortBy] ? c.sortDir : 'DESC';

    const rows = await this.b.q(
      `SELECT d.id, d."userId", TRIM(CONCAT(u."firstName", ' ', u."lastName")) AS name, d.status, d."vehicleType", d.rating, d."ratingCount", d."acceptanceRate", d."completionRate",
              d."onTimeRate", d."isOnline", d."activeZoneId", d."cityId", d."totalTrips" "lifetimeTrips", d."lifetimeEarnings",
              COUNT(o.id) FILTER (WHERE o.status IN ('DELIVERED','COLLECTED'))::int trips,
              COUNT(o.id) FILTER (WHERE o.status IN ('DELIVERED','COLLECTED') AND NOT o."isLate")::int "onTimeTrips",
              COALESCE(SUM(o."driverPay" + o."driverBoost" + o.tip) FILTER (WHERE o.status IN ('DELIVERED','COLLECTED')), 0)::float8 earnings,
              COALESCE(AVG(EXTRACT(EPOCH FROM (o."deliveredAt" - o."pickedUpAt")) / 60) FILTER (WHERE o.status IN ('DELIVERED','COLLECTED')), 0)::float8 "avgTripMin"
       FROM driver_profiles d
       JOIN users u ON u.id = d."userId"
       LEFT JOIN orders o ON o."driverId" = d.id AND o."createdAt" >= ${from} AND o."createdAt" < ${to}
       ${WHERE(scope)}
       GROUP BY d.id, u."firstName", u."lastName"
       ORDER BY ${sortCol} ${dir} NULLS LAST
       LIMIT ${p.add(c.limit)} OFFSET ${p.add((c.page - 1) * c.limit)}`,
      p.v,
    );
    const pc = new Params();
    const scope2 = [`d.status <> 'REJECTED'`, ...driverScopeConds(c, pc)];
    const [{ n: total }] = await this.b.q<{ n: number }>(`SELECT COUNT(*)::int n FROM driver_profiles d ${WHERE(scope2)}`, pc.v);

    const data = rows.map((x) => ({ ...x, earnings: r2(x.earnings), avgTripMin: r2(x.avgTripMin), onTimeRatePeriodPct: pct(x.onTimeTrips, x.trips), earningsPerTrip: div(x.earnings, x.trips) }));

    const ps = new Params();
    const scope3 = [`d.status = 'ACTIVE'`, ...driverScopeConds(c, ps, 'd')];
    const [fleet] = await this.b.q(
      `SELECT COUNT(*)::int active, COUNT(*) FILTER (WHERE d."isOnline")::int online, COALESCE(AVG(d.rating), 0)::float8 "avgRating",
              COALESCE(AVG(d."acceptanceRate"), 0)::float8 "avgAcceptanceRate", COALESCE(AVG(d."onTimeRate"), 0)::float8 "avgOnTimeRate"
       FROM driver_profiles d ${WHERE(scope3)}`,
      ps.v,
    );

    return { range: this.b.rangeInfo(c), fleet: { ...fleet, avgRating: r2(fleet.avgRating), avgAcceptanceRate: r2(fleet.avgAcceptanceRate), avgOnTimeRate: r2(fleet.avgOnTimeRate) }, ...paged(data, total, c) };
  }
}
