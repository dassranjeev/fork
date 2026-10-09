import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CustomerProfile, DeviceToken, Notification, NotificationPreference, NotificationTemplate, RestaurantMember, User, WebPushSubscription } from '../database/entities';
import { EventNotifierService } from './event-notifier.service';
import { FcmService } from './fcm.service';
import { NotificationsAdminController } from './notifications-admin.controller';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { PreferencesService } from './preferences.service';
import { WebPushService } from './web-push.service';

/**
 * Notifications for every app: stored in-app rows + Socket.IO `notification` events, browser push (Web Push / VAPID), native push
 * (FCM HTTP v1), per-user preferences and quiet hours, the notification-center API (/notifications/*) and the admin tooling
 * (/admin/notifications/*). The event registry lives in events.ts (docs/notifications.md).
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([Notification, NotificationTemplate, DeviceToken, WebPushSubscription, NotificationPreference, User, CustomerProfile, RestaurantMember])],
  providers: [NotificationsService, WebPushService, FcmService, PreferencesService, EventNotifierService],
  controllers: [NotificationsController, NotificationsAdminController],
  exports: [NotificationsService, PreferencesService, WebPushService],
})
export class NotificationsModule {}
