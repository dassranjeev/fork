import { Injectable } from '@nestjs/common';
import { AuthUser } from '../common/auth.types';
import { AnalyticsFilterDto } from './analytics.dto';
import { AnalyticsBase } from './analytics.base';
import { Params, WHERE, bucketExpr, driverScopeConds, r2 } from './analytics.util';

/** Admin "Ratings" dashboard: lowest/highest rated restaurants and drivers, distribution, trend, moderation counts. */
@Injectable()
export class RatingsAnalyticsService {
  constructor(private readonly b: AnalyticsBase) {}

  /** GET /admin/analytics/ratings */
  async ratings(f: AnalyticsFilterDto, user: AuthUser) {
    const c = await this.b.ctx(f, user);
    const min = this.b.settings.get<number>('ratings.minCountToShow', 5);

    const dist = async (col: string, status: string) => {
      const p = new Params();
      const [x] = await this.b.q(
        `SELECT COUNT(*)::int n, COALESCE(AVG("${col}"), 0)::float8 avg,
                COUNT(*) FILTER (WHERE "${col}" = 1)::int s1, COUNT(*) FILTER (WHERE "${col}" = 2)::int s2, COUNT(*) FILTER (WHERE "${col}" = 3)::int s3,
                COUNT(*) FILTER (WHERE "${col}" = 4)::int s4, COUNT(*) FILTER (WHERE "${col}" = 5)::int s5
         FROM reviews WHERE "${col}" IS NOT NULL AND "${status}" = 'VISIBLE' AND "createdAt" >= ${p.add(c.from)} AND "createdAt" < ${p.add(c.to)}`,
        p.v,
      );
      return { count: x.n, average: x.n ? r2(x.avg) : null, distribution: [5, 4, 3, 2, 1].map((s) => ({ stars: s, count: x[`s${s}`] })) };
    };
    const [restaurant, driver] = await Promise.all([dist('restaurantRating', 'status'), dist('driverRating', 'driverStatus')]);

    const pt = new Params();
    const bucket = bucketExpr(c, pt, 'rv."createdAt"');
    const from = pt.add(c.from);
    const to = pt.add(c.to);
    const trend = await this.b.q(
      `SELECT ${bucket} AS date,
              COUNT(*) FILTER (WHERE rv."restaurantRating" IS NOT NULL AND rv.status = 'VISIBLE')::int "restaurantCount",
              ROUND(AVG(rv."restaurantRating") FILTER (WHERE rv.status = 'VISIBLE')::numeric, 2)::float8 "restaurantAvg",
              COUNT(*) FILTER (WHERE rv."driverRating" IS NOT NULL AND rv."driverStatus" = 'VISIBLE')::int "driverCount",
              ROUND(AVG(rv."driverRating") FILTER (WHERE rv."driverStatus" = 'VISIBLE')::numeric, 2)::float8 "driverAvg"
       FROM reviews rv WHERE rv."createdAt" >= ${from} AND rv."createdAt" < ${to} GROUP BY 1 ORDER BY 1`,
      pt.v,
    );

    const [mod] = await this.b.q(
      `SELECT COUNT(*) FILTER (WHERE status = 'FLAGGED' OR "driverStatus" = 'FLAGGED')::int flagged,
              COUNT(*) FILTER (WHERE status = 'HIDDEN' OR "driverStatus" = 'HIDDEN')::int hidden,
              COUNT(*) FILTER (WHERE "reportedAt" IS NOT NULL AND (status = 'FLAGGED'))::int "reportedPending"
       FROM reviews`,
    );

    const pr = new Params();
    const rScope: string[] = [`r."ratingCount" >= ${pr.add(min)}`, `r.status <> 'REJECTED'`];
    if (c.cityIds) rScope.push(`r."cityId" = ANY(${pr.add(c.cityIds)}::uuid[])`);
    if (c.zoneIds) rScope.push(`r."zoneId" = ANY(${pr.add(c.zoneIds)}::uuid[])`);
    const restCols = `r.id, r.name, r.rating, r."ratingCount", r."ratingAlert", r."rating30d", r."ratingCount30d"`;
    const lowestRestaurants = await this.b.q(`SELECT ${restCols} FROM restaurants r ${WHERE(rScope)} ORDER BY r.rating ASC, r."ratingCount" DESC LIMIT 10`, pr.v);
    const highestRestaurants = await this.b.q(`SELECT ${restCols} FROM restaurants r ${WHERE(rScope)} ORDER BY r.rating DESC, r."ratingCount" DESC LIMIT 10`, pr.v);

    const pd = new Params();
    const dScope: string[] = [`d."ratingCount" >= ${pd.add(min)}`, `d.status IN ('ACTIVE','SUSPENDED')`, ...driverScopeConds(c, pd)];
    const drvCols = `d.id, TRIM(u."firstName" || ' ' || u."lastName") AS name, d.rating, d."ratingCount", d."ratingAlert", d."rating30d", d."ratingCount30d"`;
    const lowestDrivers = await this.b.q(`SELECT ${drvCols} FROM driver_profiles d JOIN users u ON u.id = d."userId" ${WHERE(dScope)} ORDER BY d.rating ASC, d."ratingCount" DESC LIMIT 10`, pd.v);
    const highestDrivers = await this.b.q(`SELECT ${drvCols} FROM driver_profiles d JOIN users u ON u.id = d."userId" ${WHERE(dScope)} ORDER BY d.rating DESC, d."ratingCount" DESC LIMIT 10`, pd.v);

    const [alerts] = await this.b.q(
      `SELECT (SELECT COUNT(*) FROM driver_profiles WHERE "ratingAlert" IS NOT NULL)::int "driversInAlert", (SELECT COUNT(*) FROM restaurants WHERE "ratingAlert" IS NOT NULL)::int "restaurantsInAlert"`,
    );
    const [cust] = await this.b.q(
      `SELECT COUNT(*) FILTER (WHERE "ratingCount" > 0)::int rated, COUNT(*) FILTER (WHERE flags ? 'SAFETY_CONCERN')::int "safetyFlags", COUNT(*) FILTER (WHERE flags ? 'LOW_RATING_PATTERN')::int "lowPattern" FROM customer_profiles`,
    );

    const round1 = (rows: any[]) => rows.map((x) => ({ ...x, rating: r2(x.rating), rating30d: x.rating30d == null ? null : r2(x.rating30d) }));
    return {
      range: this.b.rangeInfo(c),
      minCountToShow: min,
      restaurant,
      driver,
      trend,
      moderation: { flagged: mod.flagged, hidden: mod.hidden, reportedPending: mod.reportedPending },
      restaurants: { lowest: round1(lowestRestaurants), highest: round1(highestRestaurants) },
      drivers: { lowest: round1(lowestDrivers), highest: round1(highestDrivers) },
      alerts,
      customers: cust,
    };
  }
}
