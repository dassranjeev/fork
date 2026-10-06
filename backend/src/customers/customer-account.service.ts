import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { DataSource, In, IsNull } from 'typeorm';
import {
  Address,
  CustomerProfile,
  DataRequest,
  Favorite,
  Order,
  Referral,
  RefreshToken,
  Restaurant,
  User,
  WalletTransaction,
} from '../database/entities';
import { UserStatus, UserType, OrderStatus, ACTIVE_ORDER_STATUSES } from '../common/enums';
import { assertLatLng, fullName, maskName, round2 } from './util';
import { AuthService, ReqCtx } from '../auth/auth.service';
import { JwtStrategy } from '../auth/jwt.strategy';
import { SettingsService } from '../settings/settings.service';
import { AuditService } from '../audit/audit.service';
import { ExternalServices } from './lazy';
import { DiscoveryService } from './discovery.service';
import { DataRequestsService } from './data-requests.service';
import { cleanAccessCode, cleanNotes, maskCode, openCode, sealCode } from '../orders/delivery-instructions';

export interface AddressInput {
  label?: string;
  line1: string;
  line2?: string | null;
  city: string;
  province?: string;
  postalCode: string;
  lat?: number | null;
  lng?: number | null;
  dropoffNotes?: string | null;
  dropoffMethod?: string;
  usePin?: boolean;
  accessCode?: string | null;
  isDefault?: boolean;
}

export interface NotificationPrefs {
  orderUpdates: boolean;
  promotions: boolean;
  newsletters: boolean;
  driverMessages: boolean;
}
const DEFAULT_PREFS: NotificationPrefs = { orderUpdates: true, promotions: true, newsletters: false, driverMessages: true };

@Injectable()
export class CustomerAccountService {
  constructor(
    @InjectDataSource() private ds: DataSource,
    private auth: AuthService,
    private strategy: JwtStrategy,
    private settings: SettingsService,
    private audit: AuditService,
    private ext: ExternalServices,
    private discovery: DiscoveryService,
    private dataRequests: DataRequestsService,
  ) {}

  private profiles = () => this.ds.getRepository(CustomerProfile);
  private users = () => this.ds.getRepository(User);

  async profileOf(userId: string) {
    const p = await this.profiles().findOne({ where: { userId } });
    if (!p) throw new NotFoundException('Customer profile not found');
    return p;
  }

  // ------------------------------------------------------------------ profile
  async getProfile(userId: string) {
    const [user, profile, addressCount] = await Promise.all([
      this.users().findOne({ where: { id: userId } }),
      this.profileOf(userId),
      this.ds.getRepository(Address).count({ where: { customerId: userId } }),
    ]);
    if (!user) throw new NotFoundException();
    return this.shape(user, profile, addressCount);
  }

  private shape(user: User, p: CustomerProfile, addressCount = 0) {
    return {
      id: user.id,
      email: user.email,
      phone: user.phone,
      firstName: user.firstName,
      lastName: user.lastName,
      avatarUrl: user.avatarUrl,
      language: user.language,
      emailVerified: user.emailVerified,
      phoneVerified: user.phoneVerified,
      isGuest: !!p.meta?.guest,
      dietaryPreferences: p.dietaryPreferences,
      allergens: p.allergens,
      walletBalance: p.walletBalance,
      referralCode: p.referralCode,
      consents: { marketingEmail: p.marketingEmailConsent, marketingSms: p.marketingSmsConsent, push: p.pushEnabled, consentedAt: p.marketingConsentAt },
      notificationPrefs: { ...DEFAULT_PREFS, ...(p.meta?.notificationPrefs ?? {}) },
      totalOrders: p.totalOrders,
      addressCount,
      deletionRequestedAt: p.deletionRequestedAt,
      createdAt: user.createdAt,
    };
  }

  async updateProfile(userId: string, dto: { firstName?: string; lastName?: string; language?: string; avatarUrl?: string | null }) {
    if (dto.language && !['en', 'fr'].includes(dto.language)) throw new BadRequestException('Language must be en or fr');
    const patch: Partial<User> = {};
    if (dto.firstName !== undefined) patch.firstName = dto.firstName.trim();
    if (dto.lastName !== undefined) patch.lastName = dto.lastName.trim();
    if (dto.language !== undefined) patch.language = dto.language;
    if (dto.avatarUrl !== undefined) patch.avatarUrl = dto.avatarUrl;
    if (Object.keys(patch).length) await this.users().update(userId, patch);
    this.strategy.invalidate(userId);
    return this.getProfile(userId);
  }

  async setDietary(userId: string, dto: { dietaryPreferences?: string[]; allergens?: string[] }) {
    const clean = (a?: string[]) => [...new Set((a ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean))].slice(0, 30);
    const patch: Partial<CustomerProfile> = {};
    if (dto.dietaryPreferences) patch.dietaryPreferences = clean(dto.dietaryPreferences);
    if (dto.allergens) patch.allergens = clean(dto.allergens);
    await this.profiles().update({ userId }, patch);
    return this.getProfile(userId);
  }

  /** CASL: every change is timestamped and kept in meta.consentLog. */
  async setConsents(userId: string, dto: { marketingEmail?: boolean; marketingSms?: boolean; push?: boolean }, ctx: ReqCtx = {}) {
    const p = await this.profileOf(userId);
    const log: any[] = [...(p.meta?.consentLog ?? [])];
    const now = new Date();
    const patch: Partial<CustomerProfile> = {};
    const rec = (channel: string, granted: boolean) => log.push({ at: now.toISOString(), channel, granted, ip: ctx.ip ?? null, source: 'customer_api' });
    if (dto.marketingEmail !== undefined && dto.marketingEmail !== p.marketingEmailConsent) {
      patch.marketingEmailConsent = dto.marketingEmail;
      rec('EMAIL', dto.marketingEmail);
    }
    if (dto.marketingSms !== undefined && dto.marketingSms !== p.marketingSmsConsent) {
      patch.marketingSmsConsent = dto.marketingSms;
      rec('SMS', dto.marketingSms);
    }
    if (dto.push !== undefined) patch.pushEnabled = dto.push;
    if (log.length !== (p.meta?.consentLog ?? []).length) {
      patch.marketingConsentAt = now;
      patch.meta = { ...p.meta, consentLog: log.slice(-100) };
    }
    if (Object.keys(patch).length) await this.profiles().update({ userId }, patch);
    return this.getProfile(userId);
  }

  async setNotificationPrefs(userId: string, dto: Partial<NotificationPrefs>) {
    const p = await this.profileOf(userId);
    const prefs = { ...DEFAULT_PREFS, ...(p.meta?.notificationPrefs ?? {}) };
    for (const k of Object.keys(DEFAULT_PREFS) as (keyof NotificationPrefs)[]) if (typeof dto[k] === 'boolean') prefs[k] = dto[k]!;
    await this.profiles().update({ userId }, { meta: { ...p.meta, notificationPrefs: prefs } });
    return { notificationPrefs: prefs };
  }

  // ------------------------------------------------------------------ addresses
  private addressQb() {
    return this.ds.getRepository(Address).createQueryBuilder('a').addSelect('a.accessCode');
  }

  /** accessCode in responses: masked in lists, clear only in the owner's single-address GET (never the sealed ciphertext) */
  private shapeAddress(a: Address, reveal = false) {
    const raw = (a as any).accessCode as string | null | undefined;
    return { ...a, accessCode: reveal ? openCode(raw) : maskCode(raw), accessCodeSet: !!raw };
  }

  async listAddresses(customerId: string) {
    const rows = await this.addressQb().where('a.customerId = :customerId', { customerId }).orderBy('a.isDefault', 'DESC').addOrderBy('a.createdAt', 'DESC').getMany();
    return rows.map((a) => this.shapeAddress(a));
  }

  async getAddress(customerId: string, id: string) {
    const a = await this.addressQb().where('a.id = :id AND a.customerId = :customerId', { id, customerId }).getOne();
    if (!a) throw new NotFoundException('Address not found');
    return this.shapeAddress(a, true);
  }

  private async maskedAddress(customerId: string, id: string) {
    const a = await this.addressQb().where('a.id = :id AND a.customerId = :customerId', { id, customerId }).getOne();
    if (!a) throw new NotFoundException('Address not found');
    return this.shapeAddress(a);
  }

  async createAddress(customerId: string, dto: AddressInput) {
    assertLatLng(dto.lat, dto.lng);
    const repo = this.ds.getRepository(Address);
    const count = await repo.count({ where: { customerId } });
    if (count >= 20) throw new BadRequestException('You can save up to 20 addresses');
    const makeDefault = dto.isDefault || count === 0;
    const saved = await this.ds.transaction(async (em) => {
      if (makeDefault) await em.update(Address, { customerId }, { isDefault: false });
      return em.save(
        em.create(Address, {
          customerId,
          label: dto.label?.trim() || 'Home',
          line1: dto.line1.trim(),
          line2: dto.line2?.trim() || null,
          city: dto.city.trim(),
          province: dto.province?.trim() || 'ON',
          postalCode: dto.postalCode.trim().toUpperCase(),
          lat: dto.lat ?? null,
          lng: dto.lng ?? null,
          dropoffNotes: cleanNotes(dto.dropoffNotes),
          dropoffMethod: dto.dropoffMethod ?? 'HAND_TO_ME',
          usePin: dto.usePin ?? true,
          accessCode: sealCode(cleanAccessCode(dto.accessCode)),
          isDefault: makeDefault,
        }),
      );
    });
    return this.maskedAddress(customerId, saved.id);
  }

  async ownAddress(customerId: string, id: string) {
    const a = await this.ds.getRepository(Address).findOne({ where: { id, customerId } });
    if (!a) throw new NotFoundException('Address not found');
    return a;
  }

  async updateAddress(customerId: string, id: string, dto: Partial<AddressInput>) {
    const a = await this.ownAddress(customerId, id);
    assertLatLng(dto.lat ?? a.lat, dto.lng ?? a.lng);
    const patch: Partial<Address> = {};
    for (const k of ['label', 'line1', 'city', 'province'] as const) if (dto[k] !== undefined) patch[k] = String(dto[k]).trim() as never;
    if (dto.line2 !== undefined) patch.line2 = dto.line2?.trim() || null;
    if (dto.postalCode !== undefined) patch.postalCode = dto.postalCode.trim().toUpperCase();
    if (dto.lat !== undefined) patch.lat = dto.lat;
    if (dto.lng !== undefined) patch.lng = dto.lng;
    if (dto.dropoffNotes !== undefined) patch.dropoffNotes = cleanNotes(dto.dropoffNotes);
    if (dto.dropoffMethod !== undefined) patch.dropoffMethod = dto.dropoffMethod;
    if (dto.usePin !== undefined) patch.usePin = dto.usePin;
    if (dto.accessCode !== undefined) patch.accessCode = sealCode(cleanAccessCode(dto.accessCode));
    await this.ds.transaction(async (em) => {
      if (dto.isDefault) await em.update(Address, { customerId }, { isDefault: false });
      if (dto.isDefault !== undefined) patch.isDefault = dto.isDefault || a.isDefault;
      if (Object.keys(patch).length) await em.update(Address, id, patch);
    });
    return this.maskedAddress(customerId, id);
  }

  async setDefaultAddress(customerId: string, id: string) {
    await this.ownAddress(customerId, id);
    await this.ds.transaction(async (em) => {
      await em.update(Address, { customerId }, { isDefault: false });
      await em.update(Address, id, { isDefault: true });
    });
    return this.listAddresses(customerId);
  }

  async deleteAddress(customerId: string, id: string) {
    const a = await this.ownAddress(customerId, id);
    await this.ds.getRepository(Address).delete(id);
    if (a.isDefault) {
      const next = await this.ds.getRepository(Address).findOne({ where: { customerId }, order: { createdAt: 'DESC' } });
      if (next) await this.ds.getRepository(Address).update(next.id, { isDefault: true });
    }
    return { ok: true };
  }

  // ------------------------------------------------------------------ favourites
  async listFavorites(customerId: string, lat?: number, lng?: number) {
    const favs = await this.ds.getRepository(Favorite).find({ where: { customerId }, order: { createdAt: 'DESC' } });
    if (!favs.length) return { data: [] };
    const loc = await this.discovery.resolveLocation(lat, lng);
    const rs = await this.ds.getRepository(Restaurant).find({ where: { id: In(favs.map((f) => f.restaurantId)) }, relations: { cuisines: true } });
    const order = new Map(favs.map((f, i) => [f.restaurantId, i]));
    const cards = await (this.discovery as any).buildCards(rs.sort((a, b) => order.get(a.id)! - order.get(b.id)!), loc, { favorites: new Set(favs.map((f) => f.restaurantId)) });
    return { data: cards };
  }

  async addFavorite(customerId: string, restaurantId: string) {
    const r = await this.ds.getRepository(Restaurant).findOne({ where: { id: restaurantId } });
    if (!r) throw new NotFoundException('Restaurant not found');
    await this.ds.getRepository(Favorite).createQueryBuilder().insert().values({ customerId, restaurantId }).orIgnore().execute();
    return { ok: true, isFavorite: true };
  }

  async removeFavorite(customerId: string, restaurantId: string) {
    await this.ds.getRepository(Favorite).delete({ customerId, restaurantId });
    return { ok: true, isFavorite: false };
  }

  // ------------------------------------------------------------------ saved cards
  listCards(customerId: string) {
    return this.ext.payments.listPaymentMethods(customerId).then((data) => ({ data }));
  }
  setupCard(customerId: string) {
    return this.ext.payments.createSetupIntent(customerId);
  }
  async removeCard(customerId: string, paymentMethodId: string) {
    await this.ext.payments.detachPaymentMethod(customerId, paymentMethodId);
    return { ok: true };
  }

  // ------------------------------------------------------------------ wallet
  async wallet(customerId: string, page = 1, limit = 20) {
    const p = await this.profileOf(customerId);
    const [rows, total] = await this.ds.getRepository(WalletTransaction).findAndCount({ where: { customerId }, order: { createdAt: 'DESC' }, skip: (page - 1) * limit, take: limit });
    return {
      balance: p.walletBalance,
      transactions: { data: rows, meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } },
    };
  }

  async redeemGiftCard(customerId: string, code: string) {
    if (!this.settings.get<boolean>('payments.giftCardsEnabled', true)) throw new BadRequestException('Gift cards are disabled');
    return this.ext.giftCards.redeem(customerId, code.trim().toUpperCase());
  }

  // ------------------------------------------------------------------ referrals
  async referrals(customerId: string) {
    const p = await this.profileOf(customerId);
    const rows = await this.ds.getRepository(Referral).find({ where: { referrerId: customerId }, order: { createdAt: 'DESC' } });
    const users = rows.length ? await this.users().find({ where: { id: In(rows.map((r) => r.refereeId)) } }) : [];
    const um = new Map(users.map((u) => [u.id, u]));
    return {
      code: p.referralCode,
      shareText: `Order on FORKSY with my code ${p.referralCode} and get a credit on your first order.`,
      rewards: {
        referrer: this.settings.get<number>('marketing.referralReferrerReward', 10),
        referee: this.settings.get<number>('marketing.referralRefereeReward', 10),
      },
      stats: {
        invited: rows.length,
        rewarded: rows.filter((r) => r.status === 'REWARDED').length,
        pending: rows.filter((r) => r.status === 'PENDING').length,
        earned: round2(rows.filter((r) => r.status === 'REWARDED').reduce((s, r) => s + r.referrerReward, 0)),
      },
      referrals: rows.map((r) => ({ id: r.id, name: maskName(um.get(r.refereeId)?.firstName, um.get(r.refereeId)?.lastName), status: r.status, reward: r.referrerReward, joinedAt: r.createdAt, rewardedAt: r.rewardedAt })),
    };
  }

  // ------------------------------------------------------------------ privacy (PIPEDA)
  requestDeletion(userId: string, reason?: string) {
    return this.dataRequests.create(userId, 'DELETION', reason);
  }
  requestData(userId: string, type: 'ACCESS' | 'CORRECTION' | 'CONSENT_WITHDRAWAL', notes?: string) {
    return this.dataRequests.create(userId, type, notes);
  }
  myDataRequests(userId: string) {
    return this.dataRequests.forUser(userId);
  }
  myDataExport(userId: string, id: string) {
    return this.dataRequests.exportForOwner(userId, id);
  }

  async cancelDeletionRequest(userId: string) {
    const open = await this.ds.getRepository(DataRequest).find({ where: { userId, type: 'DELETION', status: In(['PENDING', 'IN_PROGRESS']) } });
    for (const r of open) await this.ds.getRepository(DataRequest).update(r.id, { status: 'REJECTED', notes: `${r.notes ?? ''}\n[Withdrawn by customer]`.trim(), completedAt: new Date() });
    await this.profiles().update({ userId }, { deletionRequestedAt: null });
    return { ok: true, cancelled: open.length };
  }

  // ------------------------------------------------------------------ guest checkout
  /**
   * Passwordless CUSTOMER for the web guest checkout. Same-email guests are only re-used when they never ordered
   * (so nobody can open another guest's order history by typing their e-mail).
   */
  async guestSession(dto: { email: string; phone?: string; firstName?: string; lastName?: string }, ctx: ReqCtx) {
    if (!this.settings.get<boolean>('customers.guestCheckoutEnabled', true)) throw new ForbiddenException('Guest checkout is disabled');
    const email = dto.email.trim().toLowerCase();
    const phone = dto.phone ? this.auth.normalizePhone(dto.phone) : null;
    const existing = await this.users().findOne({ where: { email } });
    let user: User;
    if (existing) {
      const prof = existing.type === UserType.CUSTOMER ? await this.profiles().findOne({ where: { userId: existing.id } }) : null;
      if (!prof?.meta?.guest) throw Object.assign(new ConflictException({ statusCode: 409, code: 'ACCOUNT_EXISTS', message: 'An account with this email already exists. Please sign in.' }), {});
      if (prof.totalOrders > 0 || existing.status !== UserStatus.ACTIVE)
        throw new ConflictException({ statusCode: 409, code: 'GUEST_EMAIL_IN_USE', message: 'This email was already used for a guest order. Please sign in with a one-time code or use another email.' });
      user = existing;
      const patch: Partial<User> = {};
      if (dto.firstName) patch.firstName = dto.firstName.trim();
      if (dto.lastName) patch.lastName = dto.lastName.trim();
      if (Object.keys(patch).length) await this.users().update(user.id, patch);
      Object.assign(user, patch);
    } else {
      if (phone && (await this.users().findOne({ where: { phone } }))) throw new ConflictException({ statusCode: 409, code: 'ACCOUNT_EXISTS', message: 'An account with this phone already exists. Please sign in.' });
      user = await this.auth.createCustomer({ email, phone: phone ?? undefined, firstName: dto.firstName?.trim() || 'Guest', lastName: dto.lastName?.trim() || '' });
      // `meta` is Record<string, any>; TypeORM's QueryDeepPartialEntity mapping over an
      // index-signature type mis-infers each property's type here, so cast the patch.
      await this.profiles().update({ userId: user.id }, { meta: { guest: true, guestCreatedAt: new Date().toISOString() } } as any);
    }
    return { ...(await this.auth.completeLogin(user, ctx)), guest: true };
  }

  /** Turn a guest into a full account by setting a password (and optionally completing contact details). */
  async upgradeGuest(userId: string, dto: { password: string; firstName?: string; lastName?: string; phone?: string }) {
    const profile = await this.profileOf(userId);
    if (!profile.meta?.guest) throw new BadRequestException('This account is already registered');
    const user = await this.users().findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException();
    const patch: Partial<User> = { passwordHash: await this.auth.hash(dto.password), passwordChangedAt: new Date() };
    if (dto.firstName) patch.firstName = dto.firstName.trim();
    if (dto.lastName) patch.lastName = dto.lastName.trim();
    if (dto.phone) {
      const phone = this.auth.normalizePhone(dto.phone);
      const clash = await this.users().findOne({ where: { phone } });
      if (clash && clash.id !== userId) throw new ConflictException('Phone already registered');
      patch.phone = phone;
    }
    await this.users().update(userId, patch);
    const { guest, guestCreatedAt, ...meta } = profile.meta ?? {};
    await this.profiles().update({ userId }, { meta: { ...meta, upgradedAt: new Date().toISOString() } } as any);
    this.strategy.invalidate(userId);
    await this.audit.log({ actor: { id: userId, email: user.email, type: user.type } as any, action: 'customer.guest_upgraded', entity: 'user', entityId: userId });
    return this.getProfile(userId);
  }

  /** Sessions list for "log out everywhere". */
  async logoutEverywhere(userId: string) {
    await this.ds.getRepository(RefreshToken).update({ userId, revokedAt: IsNull() }, { revokedAt: new Date() });
    return { ok: true };
  }

  /** Cheap check used before checkout. */
  async assertCanOrder(userId: string) {
    const [user, profile] = await Promise.all([this.users().findOne({ where: { id: userId } }), this.profiles().findOne({ where: { userId } })]);
    if (!user || user.status !== UserStatus.ACTIVE) throw new ForbiddenException('Your account is not active');
    if (profile?.isBlocked) throw new ForbiddenException('Your account has been restricted. Please contact support.');
    return { user, profile };
  }

  async activeOrderCount(userId: string) {
    return this.ds.getRepository(Order).count({ where: { customerId: userId, status: In(ACTIVE_ORDER_STATUSES as OrderStatus[]) } });
  }

  displayName(u: User) {
    return fullName(u);
  }
}
