import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { DriverProfile, Order, Restaurant, Review } from '../database/entities';
import { Events, ReviewCreatedEvent } from '../common/contracts';

/**
 * Recomputes Restaurant.rating/ratingCount and DriverProfile.rating/ratingCount from Review rows
 * (hidden reviews are ignored). Pass ids to limit the update, or omit both to recompute everything
 * that has at least one review. Shared by the listener below and by seedOrders.
 */
export async function recomputeRatingAggregates(
  em: EntityManager | DataSource,
  ids: { restaurantIds?: string[]; driverIds?: string[] } = {},
): Promise<void> {
  const reviews = em.getRepository(Review).metadata.tableName;
  const restaurants = em.getRepository(Restaurant).metadata.tableName;
  const drivers = em.getRepository(DriverProfile).metadata.tableName;
  const all = !ids.restaurantIds && !ids.driverIds;

  if (all || ids.restaurantIds?.length) {
    const filter = ids.restaurantIds ? ' AND r."id" = ANY($1::uuid[])' : '';
    await em.query(
      `UPDATE "${restaurants}" r SET "rating" = s.avg, "ratingCount" = s.n
       FROM (SELECT "restaurantId" AS id, ROUND(AVG("restaurantRating")::numeric, 2) AS avg, COUNT(*)::int AS n
             FROM "${reviews}" WHERE "restaurantRating" IS NOT NULL AND "status" <> 'HIDDEN' GROUP BY "restaurantId") s
       WHERE r."id" = s.id${filter}`,
      ids.restaurantIds ? [ids.restaurantIds] : [],
    );
  }
  if (all || ids.driverIds?.length) {
    const filter = ids.driverIds ? ' AND d."id" = ANY($1::uuid[])' : '';
    await em.query(
      `UPDATE "${drivers}" d SET "rating" = s.avg, "ratingCount" = s.n
       FROM (SELECT "driverId" AS id, ROUND(AVG("driverRating")::numeric, 2) AS avg, COUNT(*)::int AS n
             FROM "${reviews}" WHERE "driverRating" IS NOT NULL AND "driverId" IS NOT NULL AND "status" <> 'HIDDEN' GROUP BY "driverId") s
       WHERE d."id" = s.id${filter}`,
      ids.driverIds ? [ids.driverIds] : [],
    );
  }
}

/** Keeps rating aggregates fresh when a customer reviews an order (Events.REVIEW_CREATED). */
@Injectable()
export class RatingAggregatesService {
  private readonly logger = new Logger(RatingAggregatesService.name);

  constructor(@InjectDataSource() private ds: DataSource) {}

  @OnEvent(Events.REVIEW_CREATED, { async: true })
  async onReviewCreated(e: ReviewCreatedEvent): Promise<void> {
    try {
      let restaurantId = e.restaurantId;
      let driverId = e.driverId;
      if ((!restaurantId || driverId === undefined) && e.orderId) {
        const order = await this.ds.getRepository(Order).findOne({ where: { id: e.orderId } });
        restaurantId = restaurantId || order?.restaurantId;
        if (driverId === undefined) driverId = order?.driverId ?? null;
      }
      await recomputeRatingAggregates(this.ds, {
        restaurantIds: restaurantId ? [restaurantId] : [],
        driverIds: driverId ? [driverId] : [],
      });
    } catch (err) {
      this.logger.warn(`rating aggregate update failed: ${(err as Error).message}`);
    }
  }
}
