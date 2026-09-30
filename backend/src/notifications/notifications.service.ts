import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { CustomerProfile, DeviceToken, Notification, NotificationTemplate, RestaurantMember, User } from '../database/entities';
import { NotificationChannel, UserStatus, UserType } from '../common/enums';
import { SettingsService } from '../settings/settings.service';
import { RealtimeService } from '../realtime/realtime.module';

export type Audience = 'CUSTOMER' | 'RESTAURANT' | 'DRIVER' | 'ADMIN';

export interface NotifyInput {
  userId: string;
  audience: Audience;
  event: string;
  vars?: Record<string, any>;
  data?: Record<string, any>;
  /** override channels from the notification matrix */
  channels?: NotificationChannel[];
  /** marketing messages honour CASL opt-in */
  marketing?: boolean;
  /** literal message (skips templates) */
  title?: string;
  body?: string;
}

/** Built-in message copy. Copied into notification_templates on first boot so admins can edit it. */
export const DEFAULT_MESSAGES: Record<string, Partial<Record<Audience, { title: string; body: string }>>> = {
  'order.placed': {
    CUSTOMER: { title: 'Order placed', body: 'Thanks! Your order {{code}} from {{restaurant}} was placed. Total {{total}}.' },
    RESTAURANT: { title: 'New order {{code}}', body: 'New {{type}} order {{code}} - {{itemCount}} items, {{total}}. Accept it within {{acceptMinutes}} min.' },
  },
  'order.accepted': { CUSTOMER: { title: 'Order accepted', body: '{{restaurant}} accepted your order {{code}}. Ready in about {{prepMinutes}} min.' } },
  'order.rejected': { CUSTOMER: { title: 'Order declined', body: '{{restaurant}} could not take order {{code}} ({{reason}}). You have not been charged.' } },
  'driver.offer': { DRIVER: { title: 'New delivery offer', body: '{{restaurant}} - {{pickupKm}} km to pickup, {{dropKm}} km to drop-off. Est. pay {{pay}}. Respond in {{seconds}}s.' } },
  'driver.assigned': {
    CUSTOMER: { title: 'Driver on the way to the restaurant', body: '{{driverName}} ({{vehicle}}) will pick up your order {{code}}.' },
    RESTAURANT: { title: 'Driver assigned', body: '{{driverName}} is arriving in about {{etaMinutes}} min for order {{code}}.' },
  },
  'order.ready': {
    CUSTOMER: { title: 'Your order is ready', body: 'Order {{code}} is ready. {{pickupHint}}' },
    DRIVER: { title: 'Order ready for pickup', body: 'Order {{code}} is ready at {{restaurant}}. Pickup code {{pickupCode}}.' },
  },
  'order.picked_up': { CUSTOMER: { title: 'Order picked up', body: '{{driverName}} picked up order {{code}} and is heading your way.' } },
  'order.delivered': {
    CUSTOMER: { title: 'Delivered - enjoy!', body: 'Order {{code}} was delivered. Rate your experience in the app.' },
    DRIVER: { title: 'Trip complete', body: 'You earned {{earnings}} for order {{code}}.' },
    RESTAURANT: { title: 'Order {{code}} completed', body: 'Order {{code}} was handed off. Ticket closed.' },
  },
  'incident.opened': { ADMIN: { title: '{{severity}} incident: {{title}}', body: 'Incident opened ({{severity}}): {{title}}. Update stakeholders every 30 min (SOP-10).' } },
  'incident.resolved': { ADMIN: { title: 'Incident resolved: {{title}}', body: 'Post-incident report due by {{reportDueAt}}.' } },
  'order.late': {
    CUSTOMER: { title: 'Your order is running late', body: 'New ETA for order {{code}}: {{eta}}. Sorry for the wait.' },
    RESTAURANT: { title: 'Order {{code}} is late', body: 'Order {{code}} is past its promised time.' },
    DRIVER: { title: 'Order {{code}} is late', body: 'Please pick up / deliver order {{code}} as soon as possible.' },
    ADMIN: { title: 'Late order {{code}}', body: 'Order {{code}} is late ({{reason}}).' },
  },
  'order.no_driver': {
    CUSTOMER: { title: 'Small delay finding a driver', body: 'We are still looking for a driver for order {{code}}.' },
    RESTAURANT: { title: 'No driver yet for {{code}}', body: 'We are still looking for a driver for order {{code}}.' },
    ADMIN: { title: 'No driver found: {{code}}', body: 'Order {{code}} has no driver after escalation - assign manually.' },
  },
  'order.cancelled': {
    CUSTOMER: { title: 'Order cancelled', body: 'Order {{code}} was cancelled. {{refundNote}}' },
    RESTAURANT: { title: 'Order {{code}} cancelled', body: 'Order {{code}} was cancelled ({{reason}}).' },
    DRIVER: { title: 'Order {{code}} cancelled', body: 'Order {{code}} was cancelled. You will be compensated where applicable.' },
  },
  'document.expiring': {
    RESTAURANT: { title: 'Document expiring', body: 'Your {{docType}} expires on {{expiresAt}}. Upload a new one to stay live.' },
    DRIVER: { title: 'Document expiring', body: 'Your {{docType}} expires on {{expiresAt}}. Upload a renewed copy to keep driving.' },
    ADMIN: { title: 'Document expiring', body: '{{subject}} - {{docType}} expires {{expiresAt}}.' },
  },
  'finance.batch_draft': { ADMIN: { title: 'Payout batch ready', body: 'Draft payout batch for {{period}} was created. Lock, reconcile and approve it (SOP-07).' } },
  'finance.payout_failed': { ADMIN: { title: 'Payout failed', body: 'Payout to {{party}} ({{amount}}) failed: {{reason}}' } },
  'finance.refund_pending': { ADMIN: { title: 'Refund awaiting approval', body: 'Refund of {{amount}} on order {{code}} needs approval.' } },
  'payout.sent': {
    RESTAURANT: { title: 'Payout sent', body: 'Your payout of {{amount}} for {{period}} has been sent.' },
    DRIVER: { title: 'Payout sent', body: 'Your payout of {{amount}} has been sent.' },
  },
  'account.approved': {
    RESTAURANT: { title: 'You are live on FORKSY', body: '{{name}} is now live. Welcome aboard!' },
    DRIVER: { title: 'You are approved!', body: 'Welcome to FORKSY. You can go online in your approved zones.' },
  },
  'account.rejected': {
    RESTAURANT: { title: 'Application update', body: 'We could not approve {{name}}: {{reason}}' },
    DRIVER: { title: 'Application update', body: 'We could not approve your application: {{reason}}' },
  },
  'account.deactivation_notice': {
    DRIVER: { title: 'Account review notice', body: 'Your account is under review ({{reason}}). Please respond by {{respondBy}}.' },
    RESTAURANT: { title: 'Account review notice', body: 'Your store is under review ({{reason}}). Please respond by {{respondBy}}.' },
  },
  'order.item_removed': { CUSTOMER: { title: 'An item is unavailable', body: '{{restaurant}} could not make "{{item}}" for order {{code}}. Approve the change to get {{amount}} back, or cancel the order.' } },
  'order.partial_refund': { CUSTOMER: { title: 'Order updated', body: 'Order {{code}} was updated and {{amount}} will be refunded.' } },
  'order.tip_updated': { DRIVER: { title: 'Tip updated', body: 'The tip for order {{code}} is now {{tip}}.' } },
  'order.stuck': { ADMIN: { title: 'Order {{code}} needs attention', body: 'Order {{code}}: {{reason}}' } },
  'refund.pending_approval': { ADMIN: { title: 'Refund needs approval', body: 'A refund of {{amount}} on order {{code}} is waiting for approval ({{reason}}).' } },
  'refund.rejected': { CUSTOMER: { title: 'Refund request update', body: 'Your refund request for order {{code}} was not approved.' } },
  'payment.failed': { ADMIN: { title: 'Payment problem', body: 'Order {{code}}: {{reason}}' } },
  'refund.issued': { CUSTOMER: { title: 'Refund issued', body: 'We refunded {{amount}} for order {{code}}.' } },
  'credit.issued': { CUSTOMER: { title: 'FORKSY credit added', body: '{{amount}} of credit was added to your wallet.' } },
  'promo.pending': { ADMIN: { title: 'Promotion awaiting approval', body: '{{restaurant}} submitted "{{name}}" for approval.' } },
  'promo.approved': { RESTAURANT: { title: 'Promotion approved', body: 'Your promotion "{{name}}" was approved and is now live.' } },
  'promo.rejected': { RESTAURANT: { title: 'Promotion not approved', body: 'Your promotion "{{name}}" was not approved: {{reason}}' } },
  'campaign.message': { CUSTOMER: { title: '{{title}}', body: '{{body}}' }, DRIVER: { title: '{{title}}', body: '{{body}}' }, RESTAURANT: { title: '{{title}}', body: '{{body}}' } },
  'ticket.update': { CUSTOMER: { title: 'Support update', body: 'There is an update on ticket {{number}}.' } },
  'sos.alert': { ADMIN: { title: 'SOS from driver', body: 'Driver {{driverName}} triggered the safety button.' } },
  'supply.alert': { DRIVER: { title: 'Busy in {{zone}}', body: 'Demand is high in {{zone}}. Go online for a {{boost}} boost.' } },
  'otp.code': {
    CUSTOMER: { title: 'Your FORKSY code', body: 'Your FORKSY verification code is {{code}}. It expires in {{minutes}} minutes.' },
    DRIVER: { title: 'Your FORKSY code', body: 'Your FORKSY verification code is {{code}}. It expires in {{minutes}} minutes.' },
    RESTAURANT: { title: 'Your FORKSY code', body: 'Your FORKSY verification code is {{code}}. It expires in {{minutes}} minutes.' },
    ADMIN: { title: 'Your FORKSY code', body: 'Your FORKSY verification code is {{code}}. It expires in {{minutes}} minutes.' },
  },
};

export function renderTemplate(tpl: string, vars: Record<string, any> = {}): string {
  return tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, k) => {
    const v = k.split('.').reduce((o: any, p: string) => (o == null ? o : o[p]), vars);
    return v === undefined || v === null ? '' : String(v);
  });
}

@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private config: ConfigService,
    private settings: SettingsService,
    private rt: RealtimeService,
    @InjectRepository(Notification) private repo: Repository<Notification>,
    @InjectRepository(NotificationTemplate) private templates: Repository<NotificationTemplate>,
    @InjectRepository(DeviceToken) private tokens: Repository<DeviceToken>,
    @InjectRepository(User) private users: Repository<User>,
    @InjectRepository(CustomerProfile) private customers: Repository<CustomerProfile>,
    @InjectRepository(RestaurantMember) private members: Repository<RestaurantMember>,
  ) {}

  /** Seed editable templates from DEFAULT_MESSAGES using the channel matrix. */
  async onModuleInit() {
    try {
      const count = await this.templates.count();
      if (count > 0) return;
      const matrix = this.settings.get<Record<string, Record<string, string[]>>>('notifications.matrix', {});
      const rows: Partial<NotificationTemplate>[] = [];
      for (const [key, byAud] of Object.entries(DEFAULT_MESSAGES)) {
        for (const [aud, msg] of Object.entries(byAud)) {
          const channels = (matrix[key]?.[aud] as NotificationChannel[]) ?? [NotificationChannel.IN_APP];
          for (const channel of new Set([...channels, NotificationChannel.IN_APP])) {
            rows.push({
              key,
              audience: aud as Audience,
              channel,
              language: 'en',
              subject: msg.title,
              body: msg.body,
              active: true,
            });
          }
        }
      }
      if (rows.length) await this.templates.insert(rows);
    } catch (e: any) {
      this.logger.warn(`template seed skipped: ${e.message}`);
    }
  }

  /** Main entry point. Never throws - notifications must not break business flows. */
  async notify(input: NotifyInput): Promise<void> {
    try {
      const user = await this.users.findOne({ where: { id: input.userId } });
      if (!user || user.status === UserStatus.DELETED) return;
      const matrix = this.settings.get<Record<string, Record<string, string[]>>>('notifications.matrix', {});
      let channels: NotificationChannel[] =
        input.channels ?? ((matrix[input.event]?.[input.audience] as NotificationChannel[]) ?? [NotificationChannel.IN_APP]);
      if (input.marketing) channels = await this.filterByConsent(user, channels);
      const lang = user.language || 'en';
      for (const channel of new Set([...channels, NotificationChannel.IN_APP])) {
        const { title, body } = await this.render(input, channel, lang);
        if (channel === NotificationChannel.IN_APP) {
          const n = await this.repo.save(
            this.repo.create({
              userId: user.id,
              channel,
              title,
              body,
              event: input.event,
              data: input.data ?? null,
              deliveryStatus: 'SENT',
            }),
          );
          this.rt.emitToUser(user.id, 'notification', { id: n.id, title, body, event: input.event, data: input.data, at: n.createdAt });
          continue;
        }
        let status: Notification['deliveryStatus'] = 'SENT';
        let error: string | null = null;
        try {
          if (channel === NotificationChannel.PUSH) await this.sendPush(user.id, title, body, input.data);
          else if (channel === NotificationChannel.SMS && user.phone) await this.sendSms(user.phone, body);
          else if (channel === NotificationChannel.EMAIL && user.email) await this.sendEmail(user.email, title, body);
          else status = 'SKIPPED';
        } catch (e: any) {
          status = 'FAILED';
          error = String(e.message ?? e).slice(0, 250);
          this.logger.warn(`${channel} to ${user.id} failed: ${error}`);
        }
        await this.repo.save(
          this.repo.create({ userId: user.id, channel, title, body, event: input.event, data: input.data ?? null, deliveryStatus: status, error }),
        );
      }
    } catch (e: any) {
      this.logger.error(`notify(${input.event}) failed: ${e.message}`);
    }
  }

  /** Notify everyone who works at a restaurant location (owner + location staff). */
  async notifyRestaurant(restaurantId: string, event: string, vars?: Record<string, any>, data?: Record<string, any>) {
    const rows: { merchantId: string }[] = await this.users.manager.query(`SELECT "merchantId" FROM restaurants WHERE id = $1`, [restaurantId]);
    if (!rows.length) return;
    const ms = await this.members
      .createQueryBuilder('m')
      .where('m.active = true AND m.merchantId = :mid AND (m.restaurantId IS NULL OR m.restaurantId = :rid)', { mid: rows[0].merchantId, rid: restaurantId })
      .getMany();
    const ids = [...new Set(ms.map((m) => m.userId))];
    await Promise.all(ids.map((userId) => this.notify({ userId, audience: 'RESTAURANT', event, vars, data: { ...data, restaurantId } })));
    this.rt.emitToRestaurant(restaurantId, event, { ...data, vars });
  }

  /** Notify staff (in-app + ops room). Optionally limit to specific permission-holding roles later. */
  async notifyOps(event: string, vars?: Record<string, any>, data?: Record<string, any>) {
    this.rt.emitToOps(event, { ...data, vars });
    const staff = await this.users.find({ where: { type: In([UserType.STAFF, UserType.SUPER_ADMIN]), status: UserStatus.ACTIVE }, select: ['id'] });
    await Promise.all(staff.map((s) => this.notify({ userId: s.id, audience: 'ADMIN', event, vars, data, channels: [NotificationChannel.IN_APP] })));
  }

  async render(input: NotifyInput, channel: NotificationChannel, lang: string) {
    if (input.title && input.body) {
      return { title: renderTemplate(input.title, input.vars), body: renderTemplate(input.body, input.vars) };
    }
    let tpl =
      (await this.templates.findOne({ where: { key: input.event, channel, language: lang, audience: input.audience, active: true } })) ??
      (await this.templates.findOne({ where: { key: input.event, channel, language: 'en', audience: input.audience, active: true } })) ??
      (await this.templates.findOne({ where: { key: input.event, channel: NotificationChannel.IN_APP, language: 'en', audience: input.audience, active: true } }));
    const fallback = DEFAULT_MESSAGES[input.event]?.[input.audience];
    const title = tpl?.subject ?? fallback?.title ?? input.title ?? input.event;
    const body = tpl?.body ?? fallback?.body ?? input.body ?? '';
    return { title: renderTemplate(title, input.vars), body: renderTemplate(body, input.vars) };
  }

  private async filterByConsent(user: User, channels: NotificationChannel[]) {
    if (user.type !== UserType.CUSTOMER) return channels;
    const p = await this.customers.findOne({ where: { userId: user.id } });
    return channels.filter((c) => {
      if (c === NotificationChannel.EMAIL) return !!p?.marketingEmailConsent;
      if (c === NotificationChannel.SMS) return !!p?.marketingSmsConsent;
      if (c === NotificationChannel.PUSH) return p?.pushEnabled !== false;
      return true;
    });
  }

  // ---------------------------------------------------------------- adapters
  async sendPush(userId: string, title: string, body: string, data?: Record<string, any>) {
    const key = this.settings.get<string>('notifications.fcmServerKey') || this.config.get<string>('fcm.serverKey');
    const devices = await this.tokens.find({ where: { userId } });
    if (!devices.length) return;
    if (!key) {
      this.logger.log(`[push:mock] -> ${userId} (${devices.length} devices): ${title} - ${body}`);
      return;
    }
    // FCM legacy HTTP API. Swap for firebase-admin (HTTP v1) in production - kept behind this adapter.
    const res = await fetch('https://fcm.googleapis.com/fcm/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `key=${key}` },
      body: JSON.stringify({ registration_ids: devices.map((d) => d.token), notification: { title, body }, data: data ?? {} }),
    });
    if (!res.ok) throw new Error(`FCM ${res.status}`);
  }

  async sendSms(to: string, body: string) {
    const sid = this.settings.get<string>('notifications.twilioAccountSid') || this.config.get<string>('twilio.accountSid');
    const token = this.settings.get<string>('notifications.twilioAuthToken') || this.config.get<string>('twilio.authToken');
    const from = this.settings.get<string>('notifications.twilioFrom') || this.config.get<string>('twilio.from');
    if (!sid || !token || !from) {
      this.logger.log(`[sms:mock] -> ${to}: ${body}`);
      return;
    }
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: to, From: from, Body: body }).toString(),
    });
    if (!res.ok) throw new Error(`Twilio ${res.status}`);
  }

  async sendEmail(to: string, subject: string, body: string) {
    const key = this.settings.get<string>('notifications.sendgridApiKey') || this.config.get<string>('sendgrid.apiKey');
    const from = this.settings.get<string>('notifications.emailFrom') || this.config.get<string>('sendgrid.from');
    if (!key) {
      this.logger.log(`[email:mock] -> ${to}: ${subject}`);
      return;
    }
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: from },
        subject,
        content: [{ type: 'text/plain', value: body }],
      }),
    });
    if (!res.ok) throw new Error(`SendGrid ${res.status}`);
  }

  // ---------------------------------------------------------------- inbox API helpers
  inbox(userId: string, page = 1, limit = 30) {
    return this.repo.findAndCount({
      where: { userId, channel: NotificationChannel.IN_APP },
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
  }

  unreadCount(userId: string) {
    return this.repo.count({ where: { userId, channel: NotificationChannel.IN_APP, readAt: null as any } });
  }

  async markRead(userId: string, id?: string) {
    const qb = this.repo
      .createQueryBuilder()
      .update(Notification)
      .set({ readAt: new Date() })
      .where('userId = :userId AND readAt IS NULL AND channel = :ch', { userId, ch: NotificationChannel.IN_APP });
    if (id) qb.andWhere('id = :id', { id });
    await qb.execute();
  }

  async registerDevice(userId: string, dto: { token: string; platform?: 'ios' | 'android' | 'web'; app?: any; appVersion?: string; fingerprint?: string }) {
    const existing = await this.tokens.findOne({ where: { token: dto.token } });
    if (existing) {
      Object.assign(existing, { userId, platform: dto.platform ?? existing.platform, app: dto.app ?? existing.app, appVersion: dto.appVersion, fingerprint: dto.fingerprint });
      return this.tokens.save(existing);
    }
    return this.tokens.save(this.tokens.create({ userId, ...dto } as any));
  }

  async unregisterDevice(token: string) {
    await this.tokens.delete({ token });
  }
}
