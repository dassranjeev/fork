import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { NotificationChannel } from '../common/enums';
import { SettingsService } from '../settings/settings.service';
import { NotificationsService } from '../notifications/notifications.service';

const NON_DELIVERY_SQL = `EXISTS (SELECT 1 FROM refunds f WHERE f."orderId" = o.id AND f.status IN ('PROCESSED','APPROVED') AND f."reasonCode" ~* 'NEVER|NOT_DELIVERED|NOT_RECEIVED|NO_DELIVERY' AND f.amount >= o.total * 0.99)`;

/**
 * Rating prompts. Every send is claimed first with INSERT ... ON CONFLICT DO NOTHING on rating_prompts
 * (unique per order + recipient + kind), so a prompt is sent exactly once even across restarts or two instances.
 * Look-back limits stop a fresh deploy from messaging customers about old orders.
 */
@Injectable()
export class RatingsSchedulerService {
  private readonly logger = new Logger(RatingsSchedulerService.name);
  private running = false;

  constructor(
    @InjectDataSource() private ds: DataSource,
    private settings: SettingsService,
    private notifications: NotificationsService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await this.customerPrompts();
      await this.customerReminders();
      await this.partnerPrompts();
    } catch (e) {
      this.logger.warn(`rating prompt job failed: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  private async claim(orderId: string, userId: string, kind: string): Promise<boolean> {
    const r: any[] = await this.ds.query(
      `INSERT INTO rating_prompts (id, "orderId", "userId", kind, "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, $2, $3, now(), now()) ON CONFLICT DO NOTHING RETURNING id`,
      [orderId, userId, kind],
    );
    return r.length > 0;
  }

  private closesOn(done: Date) {
    const d = new Date(new Date(done).getTime() + this.settings.get<number>('ratings.windowDays', 7) * 86400_000);
    return d.toISOString().slice(0, 10);
  }

  /** First prompt, ratings.promptDelayMinutes after delivery (look-back 24 h). */
  async customerPrompts() {
    const delay = this.settings.get<number>('ratings.promptDelayMinutes', 10);
    const rows: any[] = await this.ds.query(
      `SELECT o.id, o.code, o."customerId", r.name AS restaurant, COALESCE(o."deliveredAt", o."updatedAt") AS done
       FROM orders o JOIN restaurants r ON r.id = o."restaurantId"
       WHERE o.status IN ('DELIVERED','COLLECTED') AND COALESCE(o."deliveredAt", o."updatedAt") <= now() - ($1 || ' minutes')::interval AND COALESCE(o."deliveredAt", o."updatedAt") >= now() - interval '24 hours'
         AND NOT EXISTS (SELECT 1 FROM reviews rv WHERE rv."orderId" = o.id) AND NOT ${NON_DELIVERY_SQL}
         AND NOT EXISTS (SELECT 1 FROM rating_prompts p WHERE p."orderId" = o.id AND p."userId" = o."customerId" AND p.kind = 'CUSTOMER_PROMPT')
       LIMIT 100`,
      [String(delay)],
    );
    for (const o of rows) {
      if (!(await this.claim(o.id, o.customerId, 'CUSTOMER_PROMPT'))) continue;
      await this.notifications.notify({ userId: o.customerId, audience: 'CUSTOMER', event: 'rating.prompt', vars: { code: o.code, restaurant: o.restaurant }, data: { orderId: o.id, action: 'rate_order' }, channels: [NotificationChannel.PUSH, NotificationChannel.IN_APP] });
    }
    return rows.length;
  }

  /** One reminder, ratings.reminderDelayHours after delivery, only if a prompt was sent and the order is still unrated and inside the window. */
  async customerReminders() {
    const hours = this.settings.get<number>('ratings.reminderDelayHours', 24);
    const days = this.settings.get<number>('ratings.windowDays', 7);
    const rows: any[] = await this.ds.query(
      `SELECT o.id, o.code, o."customerId", r.name AS restaurant, COALESCE(o."deliveredAt", o."updatedAt") AS done
       FROM orders o JOIN restaurants r ON r.id = o."restaurantId"
       WHERE o.status IN ('DELIVERED','COLLECTED') AND COALESCE(o."deliveredAt", o."updatedAt") <= now() - ($1 || ' hours')::interval AND COALESCE(o."deliveredAt", o."updatedAt") >= now() - ($2 || ' days')::interval
         AND NOT EXISTS (SELECT 1 FROM reviews rv WHERE rv."orderId" = o.id) AND NOT ${NON_DELIVERY_SQL}
         AND EXISTS (SELECT 1 FROM rating_prompts p WHERE p."orderId" = o.id AND p."userId" = o."customerId" AND p.kind = 'CUSTOMER_PROMPT')
         AND NOT EXISTS (SELECT 1 FROM rating_prompts p WHERE p."orderId" = o.id AND p."userId" = o."customerId" AND p.kind = 'CUSTOMER_REMINDER')
       LIMIT 100`,
      [String(hours), String(days)],
    );
    for (const o of rows) {
      if (!(await this.claim(o.id, o.customerId, 'CUSTOMER_REMINDER'))) continue;
      await this.notifications.notify({ userId: o.customerId, audience: 'CUSTOMER', event: 'rating.reminder', vars: { code: o.code, restaurant: o.restaurant, closesOn: this.closesOn(o.done) }, data: { orderId: o.id, action: 'rate_order' }, channels: [NotificationChannel.PUSH, NotificationChannel.IN_APP] });
    }
    return rows.length;
  }

  /** Drivers and restaurants: one private "rate the customer" prompt, no reminder (look-back 12 h). */
  async partnerPrompts() {
    const delay = this.settings.get<number>('ratings.partnerPromptDelayMinutes', 5);
    const rows: any[] = await this.ds.query(
      `SELECT o.id, o.code, o."restaurantId", o."driverId", o.fulfilment, d."userId" AS "driverUserId",
              EXISTS (SELECT 1 FROM customer_ratings c WHERE c."orderId" = o.id AND c."raterType" = 'DRIVER') AS "driverDone",
              EXISTS (SELECT 1 FROM customer_ratings c WHERE c."orderId" = o.id AND c."raterType" = 'RESTAURANT') AS "restDone"
       FROM orders o LEFT JOIN driver_profiles d ON d.id = o."driverId"
       WHERE o.status IN ('DELIVERED','COLLECTED') AND COALESCE(o."deliveredAt", o."updatedAt") <= now() - ($1 || ' minutes')::interval AND COALESCE(o."deliveredAt", o."updatedAt") >= now() - interval '12 hours'
       LIMIT 100`,
      [String(delay)],
    );
    for (const o of rows) {
      if (o.driverUserId && o.fulfilment === 'PLATFORM_DRIVER' && !o.driverDone && (await this.claim(o.id, o.driverUserId, 'DRIVER_PROMPT'))) {
        await this.notifications.notify({ userId: o.driverUserId, audience: 'DRIVER', event: 'rating.prompt_partner', vars: { code: o.code }, data: { orderId: o.id, action: 'rate_customer' } });
      }
      if (!o.restDone && (await this.claim(o.id, o.restaurantId, 'RESTAURANT_PROMPT'))) {
        await this.notifications.notifyRestaurant(o.restaurantId, 'rating.prompt_partner', { code: o.code }, { orderId: o.id, action: 'rate_customer' });
      }
    }
    return rows.length;
  }
}
