import { BadRequestException, Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserType } from '../common/enums';
import { CustomerProfile, NotificationPreference } from '../database/entities';
import {
  Audience,
  CATEGORIES,
  CATEGORY_KEYS,
  Category,
  ChannelToggles,
  LOCKED_IN_APP,
  Preferences,
  defaultPreferences,
  inQuietHours,
  validTimezone,
} from './events';

export const audienceOfUser = (type: UserType | string): Audience =>
  type === UserType.CUSTOMER ? 'CUSTOMER' : type === UserType.RESTAURANT ? 'RESTAURANT' : type === UserType.DRIVER ? 'DRIVER' : 'ADMIN';

export type PrefsPatch = {
  pushEnabled?: boolean;
  criticalBypassQuietHours?: boolean;
  soundEnabled?: boolean;
  soundVolume?: number;
  categories?: Partial<Record<Category, Partial<ChannelToggles>>>;
  quietHours?: Partial<Preferences['quietHours']>;
};

/**
 * Per-user notification preferences. Stored in notification_preferences (jsonb, only what the user changed); for customers the
 * fields that already live on CustomerProfile (pushEnabled, marketing e-mail / SMS consent, notificationPrefs in meta) are the
 * source of truth and are merged in on read / written through on update, so the old /customer/profile/consents and
 * /customer/profile/notifications routes and this API always agree.
 */
@Injectable()
export class PreferencesService {
  private cache = new Map<string, { at: number; prefs: Preferences }>();

  constructor(
    @InjectRepository(NotificationPreference) private repo: Repository<NotificationPreference>,
    @InjectRepository(CustomerProfile) private customers: Repository<CustomerProfile>,
  ) {}

  invalidate(userId: string) {
    this.cache.delete(userId);
  }

  /** the old customer routes (/customer/profile/consents, /customer/profile/notifications) changed the same fields */
  @OnEvent('notification.prefs.changed')
  onChanged(e: { userId: string }) {
    this.invalidate(e.userId);
  }

  private merge(base: Preferences, patch: any): Preferences {
    const out: Preferences = JSON.parse(JSON.stringify(base));
    if (!patch || typeof patch !== 'object') return out;
    if (typeof patch.pushEnabled === 'boolean') out.pushEnabled = patch.pushEnabled;
    if (typeof patch.criticalBypassQuietHours === 'boolean') out.criticalBypassQuietHours = patch.criticalBypassQuietHours;
    if (typeof patch.soundEnabled === 'boolean') out.soundEnabled = patch.soundEnabled;
    if (typeof patch.soundVolume === 'number' && patch.soundVolume >= 0 && patch.soundVolume <= 100) out.soundVolume = Math.round(patch.soundVolume);
    for (const c of CATEGORY_KEYS) {
      const p = patch.categories?.[c];
      if (!p) continue;
      for (const ch of ['inApp', 'push', 'email', 'sms'] as const) if (typeof p[ch] === 'boolean') out.categories[c][ch] = p[ch];
    }
    const q = patch.quietHours;
    if (q) {
      if (typeof q.enabled === 'boolean') out.quietHours.enabled = q.enabled;
      if (typeof q.start === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(q.start)) out.quietHours.start = q.start;
      if (typeof q.end === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(q.end)) out.quietHours.end = q.end;
      if (typeof q.timezone === 'string' && validTimezone(q.timezone)) out.quietHours.timezone = q.timezone;
    }
    for (const c of LOCKED_IN_APP) out.categories[c].inApp = true;
    return out;
  }

  /** Effective preferences (cached 15 s; invalidated on every write). */
  async get(userId: string, userType: UserType | string): Promise<Preferences> {
    const hit = this.cache.get(userId);
    if (hit && Date.now() - hit.at < 15_000) return hit.prefs;
    const aud = audienceOfUser(userType);
    const row = await this.repo.findOne({ where: { userId } });
    let prefs = this.merge(defaultPreferences(aud), row?.data);
    if (aud === 'CUSTOMER') {
      const p = await this.customers.findOne({ where: { userId } });
      if (p) {
        const np = (p.meta?.notificationPrefs ?? {}) as Record<string, any>;
        prefs.pushEnabled = p.pushEnabled !== false;
        prefs.categories.promotions.email = !!p.marketingEmailConsent;
        prefs.categories.promotions.sms = !!p.marketingSmsConsent;
        if (typeof np.orderUpdates === 'boolean') prefs.categories.orders.push = np.orderUpdates;
        if (typeof np.driverMessages === 'boolean') prefs.categories.delivery.push = np.driverMessages;
        prefs.categories.promotions.push = typeof np.promotions === 'boolean' ? np.promotions : true;
      }
    }
    this.cache.set(userId, { at: Date.now(), prefs });
    if (this.cache.size > 5000) this.cache.clear();
    return prefs;
  }

  async view(userId: string, userType: UserType | string) {
    const prefs = await this.get(userId, userType);
    const audience = audienceOfUser(userType);
    return {
      ...prefs,
      meta: {
        audience,
        categories: CATEGORIES,
        lockedInApp: LOCKED_IN_APP,
        quietNow: inQuietHours(prefs.quietHours),
        customerLinked: audience === 'CUSTOMER' ? ['pushEnabled', 'categories.promotions.email', 'categories.promotions.sms', 'categories.orders.push', 'categories.delivery.push', 'categories.promotions.push'] : [],
      },
    };
  }

  async update(userId: string, userType: UserType | string, patch: PrefsPatch) {
    if (patch.quietHours?.timezone && !validTimezone(patch.quietHours.timezone)) throw new BadRequestException('Unknown time zone');
    if (patch.quietHours?.start && patch.quietHours?.end && patch.quietHours.start === patch.quietHours.end && patch.quietHours.enabled) {
      throw new BadRequestException('Quiet hours must start and end at different times');
    }
    const aud = audienceOfUser(userType);
    const rest: PrefsPatch = JSON.parse(JSON.stringify(patch));
    if (aud === 'CUSTOMER') {
      const p = await this.customers.findOne({ where: { userId } });
      if (p) {
        const upd: Partial<CustomerProfile> = {};
        const meta = { ...(p.meta ?? {}) } as Record<string, any>;
        const np = { ...(meta.notificationPrefs ?? {}) } as Record<string, any>;
        if (typeof patch.pushEnabled === 'boolean') {
          upd.pushEnabled = patch.pushEnabled;
          delete rest.pushEnabled;
        }
        const pc = patch.categories?.promotions;
        if (pc) {
          if (typeof pc.email === 'boolean') (upd.marketingEmailConsent = pc.email), delete (rest.categories as any).promotions.email;
          if (typeof pc.sms === 'boolean') (upd.marketingSmsConsent = pc.sms), delete (rest.categories as any).promotions.sms;
          if (typeof pc.push === 'boolean') (np.promotions = pc.push), delete (rest.categories as any).promotions.push;
          // CASL: every consent change is logged like the /customer/profile/consents route does
          const log: any[] = [...(meta.consentLog ?? [])];
          const at = new Date().toISOString();
          if (typeof pc.email === 'boolean' && pc.email !== p.marketingEmailConsent) log.push({ at, channel: 'EMAIL', granted: pc.email, ip: null, source: 'notification_preferences' });
          if (typeof pc.sms === 'boolean' && pc.sms !== p.marketingSmsConsent) log.push({ at, channel: 'SMS', granted: pc.sms, ip: null, source: 'notification_preferences' });
          if (log.length !== (meta.consentLog ?? []).length) {
            upd.marketingConsentAt = new Date();
            meta.consentLog = log.slice(-100);
            upd.meta = { ...meta };
          }
        }
        if (typeof patch.categories?.orders?.push === 'boolean') (np.orderUpdates = patch.categories.orders.push), delete (rest.categories as any).orders.push;
        if (typeof patch.categories?.delivery?.push === 'boolean') (np.driverMessages = patch.categories.delivery.push), delete (rest.categories as any).delivery.push;
        if (Object.keys(np).length) upd.meta = { ...meta, ...(upd.meta ?? {}), notificationPrefs: np };
        if (Object.keys(upd).length) await this.customers.update({ userId }, upd as any);
      }
    }
    let row = await this.repo.findOne({ where: { userId } });
    const stored = this.merge(this.merge(defaultPreferences(aud), row?.data), rest);
    // persist only what differs from the defaults (keeps the row small and lets default changes reach users who never touched a setting)
    const data = this.diff(defaultPreferences(aud), stored);
    if (row) row.data = data;
    else row = this.repo.create({ userId, data });
    await this.repo.save(row);
    this.invalidate(userId);
    return this.view(userId, userType);
  }

  private diff(base: any, cur: any): Record<string, any> {
    const out: Record<string, any> = {};
    for (const k of Object.keys(cur)) {
      if (JSON.stringify(cur[k]) === JSON.stringify(base[k])) continue;
      if (cur[k] && typeof cur[k] === 'object' && !Array.isArray(cur[k])) {
        const d = this.diff(base[k] ?? {}, cur[k]);
        if (Object.keys(d).length) out[k] = d;
      } else out[k] = cur[k];
    }
    return out;
  }
}
