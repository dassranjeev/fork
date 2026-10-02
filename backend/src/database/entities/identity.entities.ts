import { Column, Entity, Index, JoinColumn, ManyToOne, Relation } from 'typeorm';
import { BaseEntity, MoneyColumn } from '../../common/base.entity';
import { UserStatus, UserType } from '../../common/enums';

/** Permission map stored on a Role: { orders: ['view','edit'], finance: ['view'] } */
export type PermissionMap = Record<string, string[]>;

@Entity('roles')
export class Role extends BaseEntity {
  @Index({ unique: true })
  @Column()
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string;

  /** System roles (the 8 default staff roles) can be cloned but not deleted. */
  @Column({ default: false })
  isSystem: boolean;

  @Column({ type: 'jsonb', default: {} })
  permissions: PermissionMap;

  /** Max single refund (CAD) this role may approve. null = unlimited. */
  @MoneyColumn({ nullable: true })
  refundLimit: number | null;

  /** Restrict role to these city ids (empty = all cities). */
  @Column({ type: 'jsonb', default: [] })
  cityIds: string[];

  /** Restrict role to these zone ids (empty = all zones). */
  @Column({ type: 'jsonb', default: [] })
  zoneIds: string[];
}

/** One login identity for every kind of user (staff, restaurant user, driver, customer). */
@Entity('users')
export class User extends BaseEntity {
  @Index({ unique: true, where: '"email" IS NOT NULL' })
  @Column({ type: 'varchar', nullable: true })
  email: string | null;

  @Index({ unique: true, where: '"phone" IS NOT NULL' })
  @Column({ type: 'varchar', nullable: true })
  phone: string | null;

  @Column({ type: 'varchar', nullable: true, select: false })
  passwordHash: string | null;

  @Column({ type: 'enum', enum: UserType })
  type: UserType;

  @Column({ type: 'enum', enum: UserStatus, default: UserStatus.ACTIVE })
  status: UserStatus;

  @Column({ default: '' })
  firstName: string;

  @Column({ default: '' })
  lastName: string;

  @Column({ type: 'varchar', nullable: true })
  avatarUrl: string | null;

  @Column({ default: 'en' })
  language: string;

  @Column({ default: false })
  emailVerified: boolean;

  @Column({ default: false })
  phoneVerified: boolean;

  /** Staff only: RBAC role. */
  @Column({ type: 'uuid', nullable: true })
  roleId: string | null;

  @ManyToOne(() => Role, { nullable: true, onDelete: 'SET NULL', eager: false })
  @JoinColumn({ name: 'roleId' })
  role: Relation<Role> | null;

  /** Social login identifiers. */
  @Column({ type: 'varchar', nullable: true })
  googleId: string | null;

  @Column({ type: 'varchar', nullable: true })
  appleId: string | null;

  /** TOTP 2FA (mandatory for staff & restaurant owners). */
  @Column({ default: false })
  twoFactorEnabled: boolean;

  @Column({ type: 'varchar', nullable: true, select: false })
  twoFactorSecret: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastLoginAt: Date | null;

  @Column({ type: 'varchar', nullable: true })
  lastLoginIp: string | null;

  @Column({ default: 0 })
  failedLoginCount: number;

  @Column({ type: 'timestamptz', nullable: true })
  lockedUntil: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  passwordChangedAt: Date | null;

  /** Access tokens issued before this instant are rejected (set on logout-all, password change/reset, block). */
  @Column({ type: 'timestamptz', nullable: true })
  tokensValidAfter: Date | null;

  /** Bumped on every revocation; access tokens carry the value they were issued under (`tv`) and die when it no longer matches. Exact, no clock-second races. */
  @Column({ type: 'int', default: 0 })
  tokenVersion: number;

  @Column({ type: 'timestamptz', nullable: true })
  deletedAt: Date | null;

  get fullName() {
    return `${this.firstName ?? ''} ${this.lastName ?? ''}`.trim();
  }
}

@Entity('refresh_tokens')
export class RefreshToken extends BaseEntity {
  @Index()
  @Column({ type: 'uuid' })
  userId: string;

  @Index()
  @Column()
  tokenHash: string;

  @Column({ type: 'timestamptz' })
  expiresAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  revokedAt: Date | null;

  @Column({ type: 'varchar', nullable: true })
  deviceInfo: string | null;

  @Column({ type: 'varchar', nullable: true })
  ip: string | null;
}

export type OtpPurpose = 'LOGIN' | 'SIGNUP' | 'RESET_PASSWORD' | 'VERIFY_PHONE' | 'VERIFY_EMAIL' | 'DELIVERY_PIN';

@Entity('otp_codes')
export class OtpCode extends BaseEntity {
  /** phone number or email the code was sent to */
  @Index()
  @Column()
  target: string;

  @Column()
  codeHash: string;

  @Column({ type: 'varchar' })
  purpose: OtpPurpose;

  @Column({ type: 'timestamptz' })
  expiresAt: Date;

  @Column({ default: 0 })
  attempts: number;

  @Column({ type: 'timestamptz', nullable: true })
  consumedAt: Date | null;
}

@Entity('device_tokens')
export class DeviceToken extends BaseEntity {
  @Index()
  @Column({ type: 'uuid' })
  userId: string;

  @Index({ unique: true })
  @Column()
  token: string;

  @Column({ type: 'varchar', default: 'android' })
  platform: 'ios' | 'android' | 'web';

  @Column({ type: 'varchar', default: 'customer' })
  app: 'customer' | 'driver' | 'restaurant' | 'admin';

  @Column({ type: 'varchar', nullable: true })
  appVersion: string | null;

  /** Device fingerprint used for fraud controls. */
  @Column({ type: 'varchar', nullable: true })
  fingerprint: string | null;
}
