import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, UnauthorizedException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes, randomInt } from 'crypto';
import * as bcrypt from 'bcryptjs';
import { authenticator } from 'otplib';
import * as QRCode from 'qrcode';
import { DataSource, In, IsNull, MoreThan, Repository } from 'typeorm';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import {
  City,
  CustomerProfile,
  Cuisine,
  DriverProfile,
  Merchant,
  OtpCode,
  OtpPurpose,
  RefreshToken,
  Referral,
  Restaurant,
  RestaurantMember,
  User,
} from '../database/entities';
import { AuthUser, JwtPayload } from '../common/auth.types';
import { DriverStatus, RestaurantRole, RestaurantStatus, UserStatus, UserType } from '../common/enums';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { JwtStrategy } from './jwt.strategy';
import { ChangePasswordDto, CustomerRegisterDto, DriverRegisterDto, LoginDto, RestaurantApplyDto, SocialLoginDto } from './dto';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

export interface ReqCtx {
  ip?: string;
  userAgent?: string;
  deviceInfo?: string;
}

const APP_TYPES: Record<string, UserType[]> = {
  admin: [UserType.STAFF, UserType.SUPER_ADMIN],
  restaurant: [UserType.RESTAURANT],
  driver: [UserType.DRIVER],
  customer: [UserType.CUSTOMER],
};

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private appleJwks = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));

  constructor(
    private jwt: JwtService,
    private config: ConfigService,
    private audit: AuditService,
    private settings: SettingsService,
    private notifications: NotificationsService,
    private strategy: JwtStrategy,
    @InjectDataSource() private ds: DataSource,
    @InjectRepository(User) private users: Repository<User>,
    @InjectRepository(RefreshToken) private refreshTokens: Repository<RefreshToken>,
    @InjectRepository(OtpCode) private otps: Repository<OtpCode>,
    @InjectRepository(CustomerProfile) private customers: Repository<CustomerProfile>,
    @InjectRepository(DriverProfile) private drivers: Repository<DriverProfile>,
    @InjectRepository(Referral) private referrals: Repository<Referral>,
  ) {}

  // ------------------------------------------------------------------ helpers
  private isEmail(v: string) {
    return v.includes('@');
  }

  normalizePhone(p: string) {
    const digits = p.replace(/[^\d+]/g, '');
    if (digits.startsWith('+')) return digits;
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
    return `+${digits}`;
  }

  async findByIdentifier(identifier: string, withSecrets = true) {
    const id = identifier.trim();
    const where = this.isEmail(id) ? { email: id.toLowerCase() } : { phone: this.normalizePhone(id) };
    const qb = this.users.createQueryBuilder('u').where(this.isEmail(id) ? 'u.email = :v' : 'u.phone = :v', { v: Object.values(where)[0] });
    if (withSecrets) qb.addSelect(['u.passwordHash', 'u.twoFactorSecret']);
    return qb.getOne();
  }

  private accessToken(user: User, extra: Partial<JwtPayload> = {}) {
    const payload: JwtPayload = { sub: user.id, type: user.type, ...extra };
    return this.jwt.sign(payload, { expiresIn: extra.pending2fa ? '5m' : (this.config.get('jwt.accessTtl') as any) });
  }

  private async issueRefresh(user: User, ctx: ReqCtx) {
    const raw = randomBytes(48).toString('base64url');
    const days = this.config.get<number>('jwt.refreshTtlDays');
    await this.refreshTokens.save(
      this.refreshTokens.create({
        userId: user.id,
        tokenHash: sha(raw),
        expiresAt: new Date(Date.now() + days * 86400_000),
        deviceInfo: ctx.deviceInfo ?? ctx.userAgent?.slice(0, 200) ?? null,
        ip: ctx.ip ?? null,
      }),
    );
    return raw;
  }

  async publicUser(user: User) {
    const au = await this.strategy.validate({ sub: user.id, type: user.type });
    this.strategy.invalidate(user.id);
    const { pending2fa, ...rest } = au as any;
    return {
      ...rest,
      firstName: user.firstName,
      lastName: user.lastName,
      avatarUrl: user.avatarUrl,
      language: user.language,
      twoFactorEnabled: user.twoFactorEnabled,
      emailVerified: user.emailVerified,
      phoneVerified: user.phoneVerified,
      lastLoginAt: user.lastLoginAt,
    };
  }

  /** Issue access + refresh tokens for an already-authenticated user. */
  async completeLogin(user: User, ctx: ReqCtx) {
    user.lastLoginAt = new Date();
    user.lastLoginIp = ctx.ip ?? null;
    user.failedLoginCount = 0;
    user.lockedUntil = null;
    await this.users.update(user.id, { lastLoginAt: user.lastLoginAt, lastLoginIp: user.lastLoginIp, failedLoginCount: 0, lockedUntil: null });
    await this.audit.log({ actor: { id: user.id, email: user.email, type: user.type }, action: 'auth.login', entity: 'user', entityId: user.id, ip: ctx.ip, userAgent: ctx.userAgent });
    return {
      accessToken: this.accessToken(user),
      refreshToken: await this.issueRefresh(user, ctx),
      expiresIn: this.config.get('jwt.accessTtl'),
      user: await this.publicUser(user),
    };
  }

  /** 2FA is mandatory for staff & restaurant owners when enforced (spec 10.1). */
  private async needs2fa(user: User) {
    if (user.type === UserType.STAFF || user.type === UserType.SUPER_ADMIN) {
      return this.config.get('security.enforce2fa') && this.settings.get('security.enforce2faStaff', true);
    }
    if (user.type === UserType.RESTAURANT) {
      const owner = await this.ds.getRepository(RestaurantMember).findOne({ where: { userId: user.id, role: RestaurantRole.OWNER } });
      return !!owner && this.config.get('security.enforce2fa') && this.settings.get('security.enforce2faRestaurantOwner', true);
    }
    return false;
  }

  // ------------------------------------------------------------------ login
  async login(dto: LoginDto, ctx: ReqCtx) {
    const user = await this.findByIdentifier(dto.identifier);
    const maxFails = this.config.get<number>('security.maxFailedLogins');
    if (!user || !user.passwordHash) throw new UnauthorizedException('Invalid credentials');
    if (user.lockedUntil && user.lockedUntil > new Date()) throw new ForbiddenException('Account temporarily locked. Try again later.');
    const ok = await bcrypt.compare(dto.password, user.passwordHash);
    if (!ok) {
      const fails = user.failedLoginCount + 1;
      const lock = fails >= maxFails ? new Date(Date.now() + this.config.get<number>('security.lockMinutes') * 60_000) : null;
      await this.users.update(user.id, { failedLoginCount: lock ? 0 : fails, lockedUntil: lock });
      await this.audit.log({ actor: { id: user.id, email: user.email, type: user.type }, action: 'auth.login_failed', entity: 'user', entityId: user.id, ip: ctx.ip });
      throw new UnauthorizedException('Invalid credentials');
    }
    if (user.status === UserStatus.BLOCKED || user.status === UserStatus.DELETED) throw new ForbiddenException('Account is blocked');
    if (user.status === UserStatus.SUSPENDED) throw new ForbiddenException('Account is suspended. Contact support.');
    if (dto.app && !APP_TYPES[dto.app].includes(user.type)) throw new ForbiddenException(`This account cannot sign in to the ${dto.app} app`);

    if (user.twoFactorEnabled) {
      return { requires2fa: true, tempToken: this.accessToken(user, { pending2fa: true }) };
    }
    if (await this.needs2fa(user)) {
      return { requires2faSetup: true, tempToken: this.accessToken(user, { pending2fa: true }) };
    }
    return this.completeLogin(user, ctx);
  }

  async verify2fa(tempToken: string, code: string, ctx: ReqCtx) {
    let payload: JwtPayload;
    try {
      payload = this.jwt.verify<JwtPayload>(tempToken, { secret: this.config.get('jwt.secret') });
    } catch {
      throw new UnauthorizedException('Session expired, sign in again');
    }
    if (!payload.pending2fa) throw new BadRequestException();
    const user = await this.users.createQueryBuilder('u').addSelect('u.twoFactorSecret').where('u.id = :id', { id: payload.sub }).getOne();
    if (!user?.twoFactorSecret || !authenticator.verify({ token: code, secret: user.twoFactorSecret })) {
      throw new UnauthorizedException('Invalid authentication code');
    }
    return this.completeLogin(user, ctx);
  }

  /** Step 1 of enrolment (accepts the pending-2fa token or a full session). */
  async setup2fa(userId: string) {
    const user = await this.users.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException();
    const secret = authenticator.generateSecret();
    await this.users.update(userId, { twoFactorSecret: secret, twoFactorEnabled: false });
    const label = user.email ?? user.phone ?? user.id;
    const otpauthUrl = authenticator.keyuri(label, 'FORKSY', secret);
    return { secret, otpauthUrl, qrCode: await QRCode.toDataURL(otpauthUrl) };
  }

  /** Step 2: confirm code. If called with a pending token this also completes the login. */
  async enable2fa(userId: string, code: string, ctx: ReqCtx, completeLogin: boolean) {
    const user = await this.users.createQueryBuilder('u').addSelect('u.twoFactorSecret').where('u.id = :id', { id: userId }).getOne();
    if (!user?.twoFactorSecret) throw new BadRequestException('Start 2FA setup first');
    if (!authenticator.verify({ token: code, secret: user.twoFactorSecret })) throw new BadRequestException('Invalid code');
    await this.users.update(userId, { twoFactorEnabled: true });
    await this.audit.log({ actor: { id: user.id, email: user.email, type: user.type }, action: 'auth.2fa_enabled', entity: 'user', entityId: user.id, ip: ctx.ip });
    this.strategy.invalidate(userId);
    if (completeLogin) return this.completeLogin(user, ctx);
    return { enabled: true };
  }

  async disable2fa(userId: string, password: string) {
    const user = await this.users.createQueryBuilder('u').addSelect('u.passwordHash').where('u.id = :id', { id: userId }).getOne();
    if (!user || !(await bcrypt.compare(password, user.passwordHash ?? ''))) throw new UnauthorizedException('Wrong password');
    if (await this.needs2fa(user)) throw new ForbiddenException('2FA is mandatory for your account');
    await this.users.update(userId, { twoFactorEnabled: false, twoFactorSecret: null });
    return { enabled: false };
  }

  // ------------------------------------------------------------------ refresh / logout
  async refresh(raw: string, ctx: ReqCtx) {
    const rt = await this.refreshTokens.findOne({ where: { tokenHash: sha(raw) } });
    if (!rt || rt.revokedAt || rt.expiresAt < new Date()) {
      if (rt?.revokedAt) await this.refreshTokens.update({ userId: rt.userId, revokedAt: IsNull() }, { revokedAt: new Date() }); // reuse detected
      throw new UnauthorizedException('Invalid refresh token');
    }
    const user = await this.users.findOne({ where: { id: rt.userId } });
    if (!user || [UserStatus.BLOCKED, UserStatus.DELETED, UserStatus.SUSPENDED].includes(user.status)) throw new UnauthorizedException();
    await this.refreshTokens.update(rt.id, { revokedAt: new Date() });
    return {
      accessToken: this.accessToken(user),
      refreshToken: await this.issueRefresh(user, ctx),
      expiresIn: this.config.get('jwt.accessTtl'),
    };
  }

  async logout(raw?: string) {
    if (raw) await this.refreshTokens.update({ tokenHash: sha(raw) }, { revokedAt: new Date() });
    return { ok: true };
  }

  async logoutAll(userId: string) {
    await this.refreshTokens.update({ userId, revokedAt: IsNull() }, { revokedAt: new Date() });
    return { ok: true };
  }

  // ------------------------------------------------------------------ password
  private checkPassword(pw: string) {
    const min = this.settings.get<number>('security.passwordMinLength', 8);
    if (pw.length < Math.min(min, 8) && pw.length < 8) throw new BadRequestException(`Password must be at least ${Math.min(min, 8)} characters`);
    if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) throw new BadRequestException('Password must contain letters and numbers');
  }

  hash(pw: string) {
    this.checkPassword(pw);
    return bcrypt.hash(pw, 12);
  }

  async changePassword(userId: string, dto: ChangePasswordDto) {
    const user = await this.users.createQueryBuilder('u').addSelect('u.passwordHash').where('u.id = :id', { id: userId }).getOne();
    if (!user || !(await bcrypt.compare(dto.currentPassword, user.passwordHash ?? ''))) throw new UnauthorizedException('Current password is wrong');
    await this.users.update(userId, { passwordHash: await this.hash(dto.newPassword), passwordChangedAt: new Date() });
    await this.logoutAll(userId);
    await this.audit.log({ actor: { id: user.id, email: user.email, type: user.type }, action: 'auth.password_changed', entity: 'user', entityId: userId });
    return { ok: true };
  }

  async forgotPassword(identifier: string) {
    const user = await this.findByIdentifier(identifier, false);
    // Always answer OK (no account enumeration)
    if (!user) return { ok: true };
    const target = this.isEmail(identifier) ? user.email : user.phone;
    const { devCode } = await this.sendOtp(target!, 'RESET_PASSWORD', user.type);
    return { ok: true, ...(devCode ? { devCode } : {}) };
  }

  async resetPassword(identifier: string, code: string, newPassword: string) {
    const user = await this.findByIdentifier(identifier, false);
    if (!user) throw new BadRequestException('Invalid code');
    const target = this.isEmail(identifier) ? user.email : user.phone;
    await this.consumeOtp(target!, 'RESET_PASSWORD', code);
    await this.users.update(user.id, { passwordHash: await this.hash(newPassword), passwordChangedAt: new Date(), failedLoginCount: 0, lockedUntil: null });
    await this.logoutAll(user.id);
    await this.audit.log({ actor: { id: user.id, email: user.email, type: user.type }, action: 'auth.password_reset', entity: 'user', entityId: user.id });
    return { ok: true };
  }

  // ------------------------------------------------------------------ OTP
  async sendOtp(target: string, purpose: OtpPurpose, type: UserType = UserType.CUSTOMER) {
    const t = this.isEmail(target) ? target.toLowerCase() : this.normalizePhone(target);
    const recent = await this.otps.findOne({ where: { target: t, purpose, createdAt: MoreThan(new Date(Date.now() - 45_000)) } });
    if (recent) throw new BadRequestException('Please wait a moment before requesting another code');
    const code = String(randomInt(100000, 999999));
    const ttl = this.config.get<number>('security.otpTtlMinutes');
    await this.otps.save(this.otps.create({ target: t, purpose, codeHash: sha(`${t}:${code}`), expiresAt: new Date(Date.now() + ttl * 60_000) }));
    const body = `Your FORKSY verification code is ${code}. It expires in ${ttl} minutes.`;
    try {
      if (this.isEmail(t)) await this.notifications.sendEmail(t, 'Your FORKSY code', body);
      else await this.notifications.sendSms(t, body);
    } catch (e: any) {
      this.logger.warn(`OTP delivery failed: ${e.message}`);
    }
    const expose = this.config.get('security.exposeOtp') && this.config.get('env') !== 'production';
    if (expose) this.logger.log(`[otp] ${t} (${purpose}) = ${code}`);
    return { devCode: expose ? code : undefined };
  }

  async consumeOtp(target: string, purpose: OtpPurpose, code: string) {
    const t = this.isEmail(target) ? target.toLowerCase() : this.normalizePhone(target);
    const rec = await this.otps.findOne({ where: { target: t, purpose, consumedAt: IsNull(), expiresAt: MoreThan(new Date()) }, order: { createdAt: 'DESC' } });
    if (!rec || rec.attempts >= 5) throw new BadRequestException('Invalid or expired code');
    if (rec.codeHash !== sha(`${t}:${code}`)) {
      await this.otps.update(rec.id, { attempts: rec.attempts + 1 });
      throw new BadRequestException('Invalid or expired code');
    }
    await this.otps.update(rec.id, { consumedAt: new Date() });
  }

  async requestLoginOtp(phone: string, app: 'customer' | 'driver' | 'restaurant' = 'customer') {
    const p = this.normalizePhone(phone);
    const existing = await this.users.findOne({ where: { phone: p } });
    if (existing && !APP_TYPES[app].includes(existing.type)) throw new ForbiddenException(`This phone is registered to a different kind of account`);
    return { ok: true, isNewUser: !existing, ...(await this.sendOtp(p, existing ? 'LOGIN' : 'SIGNUP')) };
  }

  /** Phone OTP sign-in. Unknown phone + app=customer => auto sign-up. */
  async verifyLoginOtp(
    dto: { phone: string; code: string; app?: 'customer' | 'driver' | 'restaurant'; firstName?: string; lastName?: string; email?: string; referralCode?: string },
    ctx: ReqCtx,
  ) {
    const app = dto.app ?? 'customer';
    const p = this.normalizePhone(dto.phone);
    let user = await this.users.findOne({ where: { phone: p } });
    await this.consumeOtp(p, user ? 'LOGIN' : 'SIGNUP', dto.code);
    if (!user) {
      if (app !== 'customer') throw new NotFoundException('No account for this phone. Please register first.');
      user = await this.createCustomer({ phone: p, firstName: dto.firstName ?? '', lastName: dto.lastName ?? '', email: dto.email, referralCode: dto.referralCode, phoneVerified: true });
    } else if (!APP_TYPES[app].includes(user.type)) {
      throw new ForbiddenException('Wrong app for this account');
    }
    if (user.status === UserStatus.BLOCKED || user.status === UserStatus.DELETED || user.status === UserStatus.SUSPENDED) throw new ForbiddenException('Account is not active');
    if (!user.phoneVerified) await this.users.update(user.id, { phoneVerified: true });
    return this.completeLogin(user, ctx);
  }

  // ------------------------------------------------------------------ customer sign-up
  private async uniqueReferralCode() {
    for (let i = 0; i < 10; i++) {
      const code = randomBytes(4).toString('hex').toUpperCase().slice(0, 7);
      if (!(await this.customers.findOne({ where: { referralCode: code } }))) return code;
    }
    return randomBytes(6).toString('hex').toUpperCase();
  }

  async createCustomer(input: {
    email?: string;
    phone?: string;
    password?: string;
    firstName: string;
    lastName: string;
    referralCode?: string;
    marketingEmailConsent?: boolean;
    marketingSmsConsent?: boolean;
    language?: string;
    phoneVerified?: boolean;
    emailVerified?: boolean;
    googleId?: string;
    appleId?: string;
  }) {
    if (!input.email && !input.phone) throw new BadRequestException('Email or phone is required');
    const email = input.email?.toLowerCase() ?? null;
    const phone = input.phone ? this.normalizePhone(input.phone) : null;
    if (email && (await this.users.findOne({ where: { email } }))) throw new ConflictException('Email already registered');
    if (phone && (await this.users.findOne({ where: { phone } }))) throw new ConflictException('Phone already registered');
    return this.ds.transaction(async (em) => {
      const user = await em.save(
        em.create(User, {
          type: UserType.CUSTOMER,
          status: UserStatus.ACTIVE,
          email,
          phone,
          firstName: input.firstName,
          lastName: input.lastName,
          language: input.language ?? 'en',
          passwordHash: input.password ? await this.hash(input.password) : null,
          phoneVerified: !!input.phoneVerified,
          emailVerified: !!input.emailVerified,
          googleId: input.googleId ?? null,
          appleId: input.appleId ?? null,
        }),
      );
      const consent = !!(input.marketingEmailConsent || input.marketingSmsConsent);
      let referredById: string | null = null;
      if (input.referralCode) {
        const ref = await em.findOne(CustomerProfile, { where: { referralCode: input.referralCode.toUpperCase() } });
        if (ref) referredById = ref.userId;
      }
      await em.save(
        em.create(CustomerProfile, {
          userId: user.id,
          referralCode: await this.uniqueReferralCode(),
          referredById,
          marketingEmailConsent: !!input.marketingEmailConsent,
          marketingSmsConsent: !!input.marketingSmsConsent,
          marketingConsentAt: consent ? new Date() : null,
        }),
      );
      if (referredById) {
        await em.save(
          em.create(Referral, {
            referrerId: referredById,
            refereeId: user.id,
            referrerReward: this.settings.get('marketing.referralReferrerReward', 10),
            refereeReward: this.settings.get('marketing.referralRefereeReward', 10),
          }),
        );
      }
      return user;
    });
  }

  async registerCustomer(dto: CustomerRegisterDto, ctx: ReqCtx) {
    const user = await this.createCustomer(dto);
    return this.completeLogin(user, ctx);
  }

  async socialLogin(dto: SocialLoginDto, ctx: ReqCtx) {
    let sub: string;
    let email: string | undefined;
    let first = dto.firstName ?? '';
    let last = dto.lastName ?? '';
    if (dto.provider === 'google') {
      const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(dto.idToken)}`);
      if (!res.ok) throw new UnauthorizedException('Invalid Google token');
      const info: any = await res.json();
      sub = info.sub;
      email = info.email_verified === 'true' || info.email_verified === true ? info.email : undefined;
      first = first || info.given_name || '';
      last = last || info.family_name || '';
    } else {
      try {
        const { payload } = await jwtVerify(dto.idToken, this.appleJwks, { issuer: 'https://appleid.apple.com' });
        sub = payload.sub as string;
        email = (payload as any).email;
      } catch {
        throw new UnauthorizedException('Invalid Apple token');
      }
    }
    const col = dto.provider === 'google' ? 'googleId' : 'appleId';
    let user = await this.users.findOne({ where: { [col]: sub } as any });
    if (!user && email) {
      user = await this.users.findOne({ where: { email: email.toLowerCase() } });
      if (user) await this.users.update(user.id, { [col]: sub } as any);
    }
    if (!user) {
      user = await this.createCustomer({ email, firstName: first, lastName: last, referralCode: dto.referralCode, emailVerified: !!email, [col]: sub } as any);
    }
    if (user.type !== UserType.CUSTOMER) throw new ForbiddenException('Social sign-in is for customers only');
    return this.completeLogin(user, ctx);
  }

  // ------------------------------------------------------------------ driver sign-up (PDF 5.1 step 1)
  async registerDriver(dto: DriverRegisterDto, ctx: ReqCtx) {
    const phone = this.normalizePhone(dto.phone);
    const email = dto.email.toLowerCase();
    await this.consumeOtp(phone, 'SIGNUP', dto.otpCode);
    if (await this.users.findOne({ where: { email } })) throw new ConflictException('Email already registered');
    if (await this.users.findOne({ where: { phone } })) throw new ConflictException('Phone already registered');
    const city = await this.ds.getRepository(City).findOne({ where: { id: dto.cityId } });
    if (!city) throw new BadRequestException('Unknown city');
    const user = await this.ds.transaction(async (em) => {
      const u = await em.save(
        em.create(User, {
          type: UserType.DRIVER,
          status: UserStatus.ACTIVE, // can log in to finish onboarding; cannot go online until DriverStatus is ACTIVE
          email,
          phone,
          phoneVerified: true,
          firstName: dto.firstName,
          lastName: dto.lastName,
          language: dto.language ?? 'en',
          passwordHash: await this.hash(dto.password),
        }),
      );
      await em.save(
        em.create(DriverProfile, {
          userId: u.id,
          cityId: dto.cityId,
          status: DriverStatus.APPLIED,
          vehicleType: dto.vehicleType,
          vehicleMake: dto.vehicleMake ?? null,
          vehicleModel: dto.vehicleModel ?? null,
          vehicleColor: dto.vehicleColor ?? null,
          licensePlate: dto.licensePlate ?? null,
        }),
      );
      return u;
    });
    await this.audit.log({ actor: { id: user.id, email, type: UserType.DRIVER }, action: 'driver.apply', entity: 'user', entityId: user.id, ip: ctx.ip });
    this.notifications.notifyOps('driver.applied', { name: `${dto.firstName} ${dto.lastName}` }, { userId: user.id }).catch(() => undefined);
    return this.completeLogin(user, ctx);
  }

  // ------------------------------------------------------------------ restaurant application (PDF 4.2 step 1)
  async applyRestaurant(dto: RestaurantApplyDto, ctx: ReqCtx) {
    const email = dto.email.toLowerCase();
    const phone = this.normalizePhone(dto.phone);
    if (await this.users.findOne({ where: { email } })) throw new ConflictException('Email already registered');
    if (await this.users.findOne({ where: { phone } })) throw new ConflictException('Phone already registered');
    const result = await this.ds.transaction(async (em) => {
      const user = await em.save(
        em.create(User, {
          type: UserType.RESTAURANT,
          status: UserStatus.ACTIVE,
          email,
          phone,
          firstName: dto.ownerFirstName,
          lastName: dto.ownerLastName,
          passwordHash: await this.hash(dto.password),
        }),
      );
      const merchant = await em.save(
        em.create(Merchant, { businessName: dto.businessName, legalName: dto.legalName ?? null, hstNumber: dto.hstNumber ?? null, contactEmail: email, contactPhone: phone }),
      );
      let slug = slugify(dto.restaurantName) || 'restaurant';
      if (await em.findOne(Restaurant, { where: { slug } })) slug = `${slug}-${randomBytes(2).toString('hex')}`;
      const cuisines = dto.cuisineIds?.length ? await em.find(Cuisine, { where: { id: In(dto.cuisineIds) } }) : [];
      const restaurant = await em.save(
        em.create(Restaurant, {
          merchantId: merchant.id,
          name: dto.restaurantName,
          slug,
          description: dto.description ?? null,
          phone,
          email,
          addressLine1: dto.addressLine1,
          addressLine2: dto.addressLine2 ?? null,
          city: dto.city,
          province: dto.province ?? 'ON',
          postalCode: dto.postalCode,
          lat: dto.lat ?? null,
          lng: dto.lng ?? null,
          cityId: dto.cityId ?? null,
          hstNumber: dto.hstNumber ?? null,
          status: RestaurantStatus.APPLIED,
          acceptingOrders: false,
          deliveryEnabled: dto.deliveryEnabled ?? true,
          pickupEnabled: dto.pickupEnabled ?? true,
          cuisines,
        }),
      );
      await em.save(em.create(RestaurantMember, { userId: user.id, merchantId: merchant.id, restaurantId: null, role: RestaurantRole.OWNER }));
      return { user, merchant, restaurant };
    });
    await this.audit.log({ actor: { id: result.user.id, email, type: UserType.RESTAURANT }, action: 'restaurant.apply', entity: 'restaurant', entityId: result.restaurant.id, ip: ctx.ip });
    this.notifications.notifyOps('restaurant.applied', { name: dto.restaurantName }, { restaurantId: result.restaurant.id }).catch(() => undefined);
    // owners must enrol in 2FA when enforced, so route through login rules
    if (await this.needs2fa(result.user)) return { requires2faSetup: true, tempToken: this.accessToken(result.user, { pending2fa: true }), restaurantId: result.restaurant.id };
    return { ...(await this.completeLogin(result.user, ctx)), restaurantId: result.restaurant.id };
  }

  // ------------------------------------------------------------------ misc
  me(authUser: AuthUser) {
    return this.users.findOne({ where: { id: authUser.id } }).then((u) => this.publicUser(u!));
  }

  async updateProfile(userId: string, dto: { firstName?: string; lastName?: string; avatarUrl?: string; language?: string }) {
    const patch: Partial<User> = {};
    for (const k of ['firstName', 'lastName', 'avatarUrl', 'language'] as const) if (dto[k] !== undefined) (patch as any)[k] = dto[k];
    await this.users.update(userId, patch);
    this.strategy.invalidate(userId);
    return this.me({ id: userId } as AuthUser);
  }
}
