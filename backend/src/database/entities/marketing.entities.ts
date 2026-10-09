import { Column, Entity, Index } from 'typeorm';
import { BaseEntity, MoneyColumn, PctColumn } from '../../common/base.entity';
import { FundedBy, NotificationChannel, PromoType } from '../../common/enums';

@Entity('promotions')
export class Promotion extends BaseEntity {
  @Index({ unique: true, where: '"code" IS NOT NULL' })
  @Column({ type: 'varchar', nullable: true })
  code: string | null;

  @Column()
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'enum', enum: PromoType })
  type: PromoType;

  /** percent (0-100) or fixed $ amount, depending on type */
  @MoneyColumn()
  value: number;

  @MoneyColumn({ nullable: true })
  maxDiscount: number | null;

  @MoneyColumn()
  minSubtotal: number;

  @Column({ type: 'enum', enum: FundedBy, default: FundedBy.PLATFORM })
  fundedBy: FundedBy;

  /** for restaurant-funded promos / self-serve promotions */
  @Index()
  @Column({ type: 'uuid', nullable: true })
  restaurantId: string | null;

  @Column({ type: 'uuid', nullable: true })
  cityId: string | null;

  @Column({ type: 'jsonb', default: [] })
  zoneIds: string[];

  /** FREE_ITEM: menu item given free. BOGO: menu item that is buy-one-get-one. */
  @Column({ type: 'uuid', nullable: true })
  menuItemId: string | null;

  @Column({ type: 'jsonb', default: [] })
  orderTypes: string[]; // ['DELIVERY','PICKUP'], empty = all

  @Column({ type: 'timestamptz', nullable: true })
  startsAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  endsAt: Date | null;

  @Column({ type: 'int', nullable: true })
  usageLimit: number | null;

  @Column({ default: 0 })
  usedCount: number;

  @Column({ type: 'int', default: 1 })
  perUserLimit: number;

  @Column({ default: false })
  firstOrderOnly: boolean;

  /** auto-applies at checkout without a code (restaurant deals) */
  @Column({ default: false })
  autoApply: boolean;

  @Column({ default: true })
  active: boolean;

  /** self-serve promos created by a restaurant need ops approval when true */
  @Column({ default: false })
  pendingApproval: boolean;

  @Column({ type: 'uuid', nullable: true })
  createdById: string | null;

  @MoneyColumn()
  budget: number; // 0 = unlimited

  @MoneyColumn()
  spent: number;

  /** set when ops reject a restaurant self-serve promo */
  @Column({ type: 'text', nullable: true })
  rejectionReason: string | null;

  /** bulk-generated code batch id */
  @Index()
  @Column({ type: 'varchar', nullable: true })
  batchId: string | null;
}

@Entity('promo_redemptions')
export class PromoRedemption extends BaseEntity {
  @Index()
  @Column({ type: 'uuid' })
  promotionId: string;

  @Index()
  @Column({ type: 'uuid' })
  customerId: string;

  @Column({ type: 'uuid', nullable: true })
  orderId: string | null;

  @MoneyColumn()
  discount: number;
}

@Entity('banners')
export class Banner extends BaseEntity {
  @Column()
  title: string;

  @Column({ type: 'varchar', nullable: true })
  subtitle: string | null;

  @Column()
  imageUrl: string;

  /** deep link: restaurant:<id>, promo:<code>, url:https://... */
  @Column({ type: 'varchar', nullable: true })
  link: string | null;

  @Column({ default: 'HOME' })
  placement: 'HOME' | 'RESTAURANT_LIST' | 'CHECKOUT' | 'DRIVER_APP' | 'RESTAURANT_PORTAL';

  @Column({ type: 'uuid', nullable: true })
  cityId: string | null;

  @Column({ default: 0 })
  sortOrder: number;

  @Column({ type: 'timestamptz', nullable: true })
  startsAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  endsAt: Date | null;

  @Column({ default: true })
  active: boolean;
}

/** Legal pages, help centre articles, etc. */
@Entity('cms_pages')
@Index(['slug', 'language'], { unique: true })
export class CmsPage extends BaseEntity {
  @Column()
  slug: string; // terms, privacy, refund-policy, about

  @Column({ default: 'en' })
  language: string;

  @Column()
  title: string;

  @Column({ type: 'text' })
  body: string;

  @Column({ default: true })
  published: boolean;

  @Column({ default: 'LEGAL' })
  category: 'LEGAL' | 'HELP' | 'MARKETING';
}

@Entity('faqs')
export class Faq extends BaseEntity {
  @Column()
  question: string;

  @Column({ type: 'text' })
  answer: string;

  @Column({ default: 'CUSTOMER' })
  audience: 'CUSTOMER' | 'DRIVER' | 'RESTAURANT';

  @Column({ default: 'General' })
  category: string;

  @Column({ default: 'en' })
  language: string;

  @Column({ default: 0 })
  sortOrder: number;

  @Column({ default: true })
  active: boolean;
}

/** Email / SMS / push templates with {{variables}}. */
@Entity('notification_templates')
@Index(['key', 'channel', 'language', 'audience'], { unique: true })
export class NotificationTemplate extends BaseEntity {
  /** order.placed, order.accepted, driver.assigned, order.late, document.expiring, payout.sent ... */
  @Column()
  key: string;

  @Column({ type: 'enum', enum: NotificationChannel })
  channel: NotificationChannel;

  @Column({ default: 'en' })
  language: string;

  /** who receives it: CUSTOMER | RESTAURANT | DRIVER | ADMIN */
  @Column({ default: 'CUSTOMER' })
  audience: 'CUSTOMER' | 'RESTAURANT' | 'DRIVER' | 'ADMIN';

  @Column({ type: 'varchar', nullable: true })
  subject: string | null;

  @Column({ type: 'text' })
  body: string;

  @Column({ default: true })
  active: boolean;
}

/** In-app inbox + delivery log for push / sms / email. */
@Entity('notifications')
@Index('IDX_notifications_user_read_created', ['userId', 'readAt', 'createdAt'])
@Index('IDX_notifications_unread', ['userId', 'createdAt'], { where: "\"readAt\" IS NULL AND \"channel\" = 'IN_APP'" })
@Index('IDX_notifications_channel_created', ['channel', 'createdAt'])
export class Notification extends BaseEntity {
  @Index()
  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'enum', enum: NotificationChannel, default: NotificationChannel.IN_APP })
  channel: NotificationChannel;

  @Column()
  title: string;

  @Column({ type: 'text' })
  body: string;

  @Column({ type: 'varchar', nullable: true })
  event: string | null;

  @Column({ type: 'jsonb', nullable: true })
  data: Record<string, any> | null;

  @Column({ type: 'timestamptz', nullable: true })
  readAt: Date | null;

  @Column({ type: 'varchar', default: 'SENT' })
  deliveryStatus: 'QUEUED' | 'SENT' | 'FAILED' | 'SKIPPED';

  @Column({ type: 'varchar', nullable: true })
  error: string | null;

  /** orders | delivery | payments | support | promotions | system (see notifications/events.ts) */
  @Column({ type: 'varchar', nullable: true })
  category: string | null;

  /** deep link inside the web apps (e.g. /portal/orders?order=...) */
  @Column({ type: 'varchar', nullable: true })
  url: string | null;

  /** delivery attempts of a push / sms / email row */
  @Column({ type: 'int', default: 0 })
  attempts: number;

  /** delivery details of a non in-app row: { payload (the sanitised push payload), sent, failed, removed, ... } */
  @Column({ type: 'jsonb', nullable: true })
  meta: Record<string, any> | null;
}

/** A browser (W3C Web Push) subscription bound to the logged-in user. One row per browser profile / endpoint. */
@Entity('push_subscriptions')
export class WebPushSubscription extends BaseEntity {
  @Index()
  @Column({ type: 'uuid' })
  userId: string;

  /** customer | driver | restaurant | admin */
  @Column({ type: 'varchar', default: 'customer' })
  app: 'customer' | 'driver' | 'restaurant' | 'admin';

  @Column({ type: 'varchar', default: 'web' })
  platform: 'web';

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 2048 })
  endpoint: string;

  @Column({ type: 'varchar', length: 256 })
  p256dh: string;

  @Column({ type: 'varchar', length: 128 })
  auth: string;

  @Column({ type: 'varchar', length: 300, nullable: true })
  userAgent: string | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  lastSeenAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  lastSuccessAt: Date | null;

  /** consecutive failed deliveries (reset on success) */
  @Column({ type: 'int', default: 0 })
  failures: number;

  @Column({ type: 'varchar', length: 250, nullable: true })
  lastError: string | null;
}

/** Per-user notification preferences (categories x channels, quiet hours, sound). Customers' consents live on CustomerProfile (merged on read). */
@Entity('notification_preferences')
export class NotificationPreference extends BaseEntity {
  @Index({ unique: true })
  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'jsonb', default: {} })
  data: Record<string, any>;
}

/** Admin-composed push / email / SMS campaign (marketing manager). CASL: only opted-in users. */
@Entity('campaigns')
export class Campaign extends BaseEntity {
  @Column()
  name: string;

  @Column({ type: 'enum', enum: NotificationChannel })
  channel: NotificationChannel;

  @Column({ type: 'varchar', nullable: true })
  subject: string | null;

  @Column({ type: 'text' })
  body: string;

  /** CUSTOMERS | DRIVERS | RESTAURANTS */
  @Column({ default: 'CUSTOMERS' })
  audience: 'CUSTOMERS' | 'DRIVERS' | 'RESTAURANTS';

  @Column({ type: 'jsonb', default: {} })
  filters: { cityId?: string; zoneId?: string; minOrders?: number; inactiveDays?: number };

  @Column({ default: 'DRAFT' })
  status: 'DRAFT' | 'SCHEDULED' | 'SENDING' | 'SENT' | 'CANCELLED';

  @Column({ type: 'timestamptz', nullable: true })
  scheduledAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  sentAt: Date | null;

  @Column({ default: 0 })
  recipientCount: number;

  @Column({ default: 0 })
  deliveredCount: number;

  @Column({ type: 'uuid', nullable: true })
  createdById: string | null;
}
