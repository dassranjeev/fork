import { Column, Entity, Index, JoinColumn, ManyToOne, OneToOne, Relation } from 'typeorm';
import { BaseEntity, GeoColumn, MoneyColumn } from '../../common/base.entity';
import { User } from './identity.entities';

@Entity('customer_profiles')
export class CustomerProfile extends BaseEntity {
  @Index({ unique: true })
  @Column({ type: 'uuid' })
  userId: string;

  @OneToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: Relation<User>;

  @Column({ type: 'jsonb', default: [] })
  dietaryPreferences: string[]; // vegan, halal...

  @Column({ type: 'jsonb', default: [] })
  allergens: string[];

  /** FORKSY wallet / credits balance (CAD). Source of truth = wallet_transactions. */
  @MoneyColumn()
  walletBalance: number;

  @Column({ type: 'varchar', nullable: true })
  stripeCustomerId: string | null;

  @Index({ unique: true, where: '"referralCode" IS NOT NULL' })
  @Column({ type: 'varchar', nullable: true })
  referralCode: string | null;

  @Column({ type: 'uuid', nullable: true })
  referredById: string | null;

  /** CASL consent for marketing email / SMS. */
  @Column({ default: false })
  marketingEmailConsent: boolean;

  @Column({ default: false })
  marketingSmsConsent: boolean;

  @Column({ default: true })
  pushEnabled: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  marketingConsentAt: Date | null;

  // ---- fraud / risk ----
  @Column({ default: false })
  isBlocked: boolean;

  @Column({ type: 'varchar', nullable: true })
  blockReason: string | null;

  @Column({ default: false })
  fraudFlag: boolean;

  @Column({ type: 'jsonb', default: [] })
  flags: string[]; // e.g. 'REFUND_FREQUENCY', 'DEVICE_MISMATCH', 'CHARGEBACK'

  @Column({ default: 0 })
  refundCount30d: number;

  @Column({ default: 0 })
  totalOrders: number;

  @MoneyColumn()
  lifetimeSpend: number;

  @Column({ type: 'timestamptz', nullable: true })
  lastOrderAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  deletionRequestedAt: Date | null;

  @Column({ type: 'text', nullable: true })
  internalNotes: string | null;

  @Column({ type: 'jsonb', default: {} })
  meta: Record<string, any>;
}

@Entity('addresses')
export class Address extends BaseEntity {
  @Index()
  @Column({ type: 'uuid' })
  customerId: string; // users.id of the customer

  @Column({ default: 'Home' })
  label: string;

  @Column()
  line1: string;

  @Column({ type: 'varchar', nullable: true })
  line2: string | null; // unit / apt

  @Column()
  city: string;

  @Column({ default: 'ON' })
  province: string;

  @Column()
  postalCode: string;

  @GeoColumn()
  lat: number | null;

  @GeoColumn()
  lng: number | null;

  @Column({ type: 'text', nullable: true })
  dropoffNotes: string | null;

  @Column({ default: false })
  isDefault: boolean;
}

/** Persistent single-restaurant cart (v1). */
@Entity('carts')
export class Cart extends BaseEntity {
  @Index({ unique: true })
  @Column({ type: 'uuid' })
  customerId: string;

  @Column({ type: 'uuid', nullable: true })
  restaurantId: string | null;

  /** [{ menuItemId, quantity, modifierOptionIds: string[], notes }] */
  @Column({ type: 'jsonb', default: [] })
  items: { lineId?: string; menuItemId: string; quantity: number; modifierOptionIds?: string[]; notes?: string }[];

  @Column({ type: 'varchar', nullable: true })
  promoCode: string | null;
}

@Entity('favorites')
@Index(['customerId', 'restaurantId'], { unique: true })
export class Favorite extends BaseEntity {
  @Column({ type: 'uuid' })
  customerId: string;

  @Column({ type: 'uuid' })
  restaurantId: string;
}

@Entity('wallet_transactions')
export class WalletTransaction extends BaseEntity {
  @Index()
  @Column({ type: 'uuid' })
  customerId: string;

  /** +credit / -debit */
  @MoneyColumn()
  amount: number;

  @MoneyColumn()
  balanceAfter: number;

  @Column({ type: 'varchar' })
  type: 'CREDIT' | 'REFUND' | 'TOPUP' | 'PURCHASE' | 'GIFT_CARD' | 'REFERRAL' | 'ADJUSTMENT' | 'PROMO';

  @Column({ type: 'uuid', nullable: true })
  orderId: string | null;

  @Column({ type: 'varchar', nullable: true })
  note: string | null;

  @Column({ type: 'uuid', nullable: true })
  createdById: string | null;
}

@Entity('gift_cards')
export class GiftCard extends BaseEntity {
  @Index({ unique: true })
  @Column()
  code: string;

  @MoneyColumn()
  initialAmount: number;

  @MoneyColumn()
  balance: number;

  @Column({ type: 'timestamptz', nullable: true })
  expiresAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  purchasedById: string | null;

  @Column({ type: 'uuid', nullable: true })
  redeemedById: string | null;

  @Column({ type: 'varchar', nullable: true })
  recipientEmail: string | null;

  @Column({ default: true })
  active: boolean;
}

@Entity('referrals')
export class Referral extends BaseEntity {
  @Index()
  @Column({ type: 'uuid' })
  referrerId: string;

  @Index({ unique: true })
  @Column({ type: 'uuid' })
  refereeId: string;

  @Column({ default: 'PENDING' })
  status: 'PENDING' | 'REWARDED' | 'VOID';

  @MoneyColumn()
  referrerReward: number;

  @MoneyColumn()
  refereeReward: number;

  @Column({ type: 'timestamptz', nullable: true })
  rewardedAt: Date | null;
}

/** PIPEDA data access / deletion requests. */
@Entity('data_requests')
export class DataRequest extends BaseEntity {
  @Index()
  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'varchar' })
  type: 'ACCESS' | 'DELETION' | 'CORRECTION' | 'CONSENT_WITHDRAWAL';

  @Column({ default: 'PENDING' })
  status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'REJECTED';

  @Column({ type: 'text', nullable: true })
  notes: string | null;

  @Column({ type: 'uuid', nullable: true })
  handledById: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  completedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  dueAt: Date | null; // 30 day PIPEDA response window

  /** ACCESS requests: generated JSON export of the customer's data. */
  @Column({ type: 'jsonb', nullable: true })
  resultData: Record<string, any> | null;
}
