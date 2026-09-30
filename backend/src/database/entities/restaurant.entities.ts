import { Column, Entity, Index, JoinColumn, ManyToMany, ManyToOne, JoinTable, Relation } from 'typeorm';
import { BaseEntity, GeoColumn, MoneyColumn, PctColumn } from '../../common/base.entity';
import { DayPart, DocStatus, RestaurantDocType, RestaurantRole, RestaurantStatus } from '../../common/enums';
import { User } from './identity.entities';
import { City, CommissionTier, Zone } from './geo.entities';

@Entity('cuisines')
export class Cuisine extends BaseEntity {
  @Column()
  name: string;

  @Index({ unique: true })
  @Column()
  slug: string;

  @Column({ type: 'varchar', nullable: true })
  iconUrl: string | null;

  @Column({ default: 0 })
  sortOrder: number;

  @Column({ default: true })
  active: boolean;
}

/** A brand / business owner. One merchant can have many restaurant locations. */
@Entity('merchants')
export class Merchant extends BaseEntity {
  @Column()
  businessName: string;

  @Column({ type: 'varchar', nullable: true })
  legalName: string | null;

  @Column({ type: 'varchar', nullable: true })
  hstNumber: string | null;

  @Column({ type: 'varchar', nullable: true })
  contactEmail: string | null;

  @Column({ type: 'varchar', nullable: true })
  contactPhone: string | null;

  @Column({ type: 'varchar', nullable: true })
  stripeAccountId: string | null;

  /** Bank details for EFT payouts (account number stored masked, full value lives in Stripe). */
  @Column({ type: 'jsonb', nullable: true })
  bank: { institution?: string; transit?: string; accountLast4?: string; holder?: string; verified?: boolean } | null;

  @Column({ type: 'timestamptz', nullable: true })
  agreementSignedAt: Date | null;

  @Column({ type: 'varchar', nullable: true })
  agreementSignedBy: string | null;

  /** Finance: payouts for this merchant are held (FinanceModule). */
  @Column({ default: false })
  payoutHold: boolean;

  @Column({ type: 'varchar', nullable: true })
  payoutHoldReason: string | null;

  /** Micro-deposit bank verification state (FinanceModule, SOP-01 step 5). */
  @Column({ type: 'jsonb', nullable: true })
  bankVerification: { status: 'PENDING' | 'VERIFIED' | 'FAILED'; amounts?: number[]; initiatedAt?: string; verifiedAt?: string; attempts?: number } | null;
}

/** A single restaurant location (what customers see). */
@Entity('restaurants')
export class Restaurant extends BaseEntity {
  @Index()
  @Column({ type: 'uuid' })
  merchantId: string;

  @ManyToOne(() => Merchant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'merchantId' })
  merchant: Relation<Merchant>;

  @Column()
  name: string;

  @Index({ unique: true })
  @Column()
  slug: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'varchar', nullable: true })
  logoUrl: string | null;

  @Column({ type: 'varchar', nullable: true })
  coverUrl: string | null;

  @Column({ type: 'jsonb', default: [] })
  photos: string[];

  @Column({ type: 'varchar', nullable: true })
  phone: string | null;

  @Column({ type: 'varchar', nullable: true })
  email: string | null;

  @Column({ type: 'varchar', nullable: true })
  website: string | null;

  // ---- location ----
  @Column({ default: '' })
  addressLine1: string;

  @Column({ type: 'varchar', nullable: true })
  addressLine2: string | null;

  @Column({ default: '' })
  city: string;

  @Column({ default: 'ON' })
  province: string;

  @Column({ default: '' })
  postalCode: string;

  @GeoColumn()
  lat: number | null;

  @GeoColumn()
  lng: number | null;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  cityId: string | null;

  @ManyToOne(() => City, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'cityId' })
  cityRef: Relation<City> | null;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  zoneId: string | null;

  @ManyToOne(() => Zone, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'zoneId' })
  zone: Relation<Zone> | null;

  @ManyToMany(() => Cuisine, { eager: false })
  @JoinTable({ name: 'restaurant_cuisines' })
  cuisines: Relation<Cuisine[]>;

  /** 1..4 ($ .. $$$$) */
  @Column({ default: 2 })
  priceLevel: number;

  @Column({ type: 'varchar', nullable: true })
  hstNumber: string | null;

  // ---- lifecycle ----
  @Index()
  @Column({ type: 'enum', enum: RestaurantStatus, default: RestaurantStatus.APPLIED })
  status: RestaurantStatus;

  @Column({ type: 'text', nullable: true })
  statusReason: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  wentLiveAt: Date | null;

  /** Manual pause (from restaurant or ops) */
  @Column({ default: false })
  acceptingOrders: boolean;

  /** "Busy mode": pause until this time */
  @Column({ type: 'timestamptz', nullable: true })
  pausedUntil: Date | null;

  /** "Busy mode": extra prep minutes added to every order */
  @Column({ default: 0 })
  busyExtraPrepMin: number;

  // ---- commission ----
  @Column({ type: 'uuid', nullable: true })
  commissionTierId: string | null;

  @ManyToOne(() => CommissionTier, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'commissionTierId' })
  commissionTier: Relation<CommissionTier> | null;

  /** Overrides on top of the tier (null = use tier). */
  @PctColumn({ nullable: true })
  deliveryCommissionPct: number | null;

  @PctColumn({ nullable: true })
  pickupCommissionPct: number | null;

  @PctColumn({ nullable: true })
  ownDriverCommissionPct: number | null;

  // ---- fulfilment modes (PDF 4.4) ----
  @Column({ default: true })
  deliveryEnabled: boolean; // FORKSY drivers

  @Column({ default: false })
  ownDeliveryEnabled: boolean; // restaurant's own drivers

  @MoneyColumn({ default: 0 })
  ownDeliveryFee: number;

  @Column({ default: true })
  pickupEnabled: boolean;

  @Column({ default: true })
  scheduledEnabled: boolean;

  @Column({ default: false })
  dineInEnabled: boolean;

  @Column({ default: 20 })
  prepTimeMin: number;

  @Column({ default: 15 })
  pickupPrepTimeMin: number;

  @PctColumn({ default: 5 })
  deliveryRadiusKm: number;

  @MoneyColumn({ default: 0 })
  minimumOrder: number;

  @Column({ type: 'text', nullable: true })
  pickupInstructions: string | null;

  @Column({ type: 'text', nullable: true })
  parkingNotes: string | null;

  /** Scheduled orders: slot length (min), max orders per slot, lead time (min). */
  @Column({ default: 15 })
  slotMinutes: number;

  @Column({ default: 5 })
  maxOrdersPerSlot: number;

  @Column({ default: 45 })
  scheduleLeadMin: number;

  /** Seconds before an un-actioned order is auto-rejected. */
  @Column({ default: 180 })
  autoRejectSeconds: number;

  // ---- kitchen ----
  @Column({ default: true })
  kdsEnabled: boolean;

  @Column({ default: false })
  tabletActivated: boolean;

  @Column({ type: 'varchar', nullable: true })
  tabletCode: string | null;

  @Column({ default: false })
  receiptPrinterEnabled: boolean;

  @Column({ default: false })
  kitchenPrinterEnabled: boolean;

  // ---- performance ----
  @PctColumn({ default: 0 })
  rating: number;

  @Column({ default: 0 })
  ratingCount: number;

  /** 0..100, reduced by post-accept cancellations. */
  @PctColumn({ default: 100 })
  reliabilityScore: number;

  @Column({ default: false })
  isFeatured: boolean;

  @Column({ default: false })
  isNew: boolean;

  @Column({ default: 'WEEKLY' })
  payoutSchedule: 'WEEKLY' | 'DAILY';

  @Column({ type: 'jsonb', default: {} })
  meta: Record<string, any>;
}

@Entity('restaurant_members')
@Index(['userId', 'merchantId'])
export class RestaurantMember extends BaseEntity {
  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: Relation<User>;

  @Column({ type: 'uuid' })
  merchantId: string;

  /** null for OWNER (all locations) */
  @Column({ type: 'uuid', nullable: true })
  restaurantId: string | null;

  @Column({ type: 'enum', enum: RestaurantRole })
  role: RestaurantRole;

  @Column({ default: true })
  active: boolean;
}

@Entity('restaurant_hours')
@Index(['restaurantId', 'dayOfWeek'])
export class RestaurantHours extends BaseEntity {
  @Column({ type: 'uuid' })
  restaurantId: string;

  /** 0 = Sunday .. 6 = Saturday */
  @Column()
  dayOfWeek: number;

  /** 'HH:mm' in city timezone */
  @Column({ default: '09:00' })
  openTime: string;

  @Column({ default: '21:00' })
  closeTime: string;

  @Column({ default: false })
  closed: boolean;
}

/** Holiday hours / temporary closures. */
@Entity('restaurant_closures')
export class RestaurantClosure extends BaseEntity {
  @Index()
  @Column({ type: 'uuid' })
  restaurantId: string;

  @Column({ type: 'date' })
  startDate: string;

  @Column({ type: 'date' })
  endDate: string;

  @Column({ default: true })
  closed: boolean;

  /** when closed=false: special hours for that range */
  @Column({ type: 'varchar', nullable: true })
  openTime: string | null;

  @Column({ type: 'varchar', nullable: true })
  closeTime: string | null;

  @Column({ type: 'varchar', nullable: true })
  reason: string | null;
}

@Entity('restaurant_documents')
export class RestaurantDocument extends BaseEntity {
  @Index()
  @Column({ type: 'uuid' })
  restaurantId: string;

  @Column({ type: 'enum', enum: RestaurantDocType })
  type: RestaurantDocType;

  @Column()
  fileUrl: string;

  @Column({ type: 'varchar', nullable: true })
  fileName: string | null;

  @Column({ type: 'enum', enum: DocStatus, default: DocStatus.PENDING })
  status: DocStatus;

  @Column({ type: 'varchar', nullable: true })
  rejectReason: string | null;

  @Column({ type: 'date', nullable: true })
  expiresAt: string | null;

  @Column({ type: 'uuid', nullable: true })
  reviewedById: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  reviewedAt: Date | null;
}

@Entity('kitchen_stations')
export class KitchenStation extends BaseEntity {
  @Index()
  @Column({ type: 'uuid' })
  restaurantId: string;

  @Column()
  name: string; // Grill, Fryer, Cold, Drinks

  @Column({ default: 0 })
  sortOrder: number;
}

@Entity('menu_categories')
export class MenuCategory extends BaseEntity {
  @Index()
  @Column({ type: 'uuid' })
  restaurantId: string;

  @Column()
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ default: 0 })
  sortOrder: number;

  @Column({ default: true })
  active: boolean;

  /** Optional daypart restriction for the whole category. Empty = all day. */
  @Column({ type: 'jsonb', default: [] })
  dayparts: DayPart[];
}

@Entity('menu_items')
export class MenuItem extends BaseEntity {
  @Index()
  @Column({ type: 'uuid' })
  restaurantId: string;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  categoryId: string | null;

  @ManyToOne(() => MenuCategory, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'categoryId' })
  category: Relation<MenuCategory> | null;

  @Column()
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'varchar', nullable: true })
  imageUrl: string | null;

  @MoneyColumn()
  price: number;

  /** Optional separate price for pickup orders (PDF 4.3). */
  @MoneyColumn({ nullable: true })
  pickupPrice: number | null;

  @Column({ type: 'varchar', nullable: true })
  taxClassCode: string | null;

  @Column({ type: 'int', nullable: true })
  calories: number | null;

  @Column({ type: 'jsonb', default: [] })
  allergens: string[]; // peanuts, dairy, gluten...

  @Column({ type: 'jsonb', default: [] })
  dietaryTags: string[]; // vegan, vegetarian, halal, gluten-free...

  @Column({ default: 0 })
  sortOrder: number;

  /** Available toggle: false = "86'd" / out of stock. */
  @Column({ default: true })
  available: boolean;

  /** When set, item is auto-restocked at this time (next-day auto restock). */
  @Column({ type: 'timestamptz', nullable: true })
  restockAt: Date | null;

  /** Item only sells in these dayparts. Empty = all day. */
  @Column({ type: 'jsonb', default: [] })
  dayparts: DayPart[];

  @Column({ default: false })
  isCombo: boolean;

  /** Combo definition: [{ menuItemId, quantity }] */
  @Column({ type: 'jsonb', default: [] })
  comboItems: { menuItemId: string; quantity: number }[];

  @Column({ type: 'uuid', nullable: true })
  stationId: string | null;

  @Column({ type: 'int', nullable: true })
  prepTimeMin: number | null;

  @Column({ default: false })
  isPopular: boolean;

  @Column({ default: true })
  active: boolean;
}

@Entity('modifier_groups')
export class ModifierGroup extends BaseEntity {
  @Index()
  @Column({ type: 'uuid' })
  restaurantId: string;

  @Column()
  name: string; // Size, Add-ons, Spice level

  @Column({ default: false })
  required: boolean;

  @Column({ default: 0 })
  minSelect: number;

  @Column({ default: 1 })
  maxSelect: number;

  @Column({ default: 0 })
  sortOrder: number;
}

@Entity('modifier_options')
export class ModifierOption extends BaseEntity {
  @Index()
  @Column({ type: 'uuid' })
  groupId: string;

  @ManyToOne(() => ModifierGroup, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'groupId' })
  group: Relation<ModifierGroup>;

  @Column()
  name: string;

  @MoneyColumn()
  priceDelta: number;

  @Column({ default: false })
  isDefault: boolean;

  @Column({ default: true })
  available: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  restockAt: Date | null;

  @Column({ default: 0 })
  sortOrder: number;
}

@Entity('menu_item_modifier_groups')
@Index(['menuItemId', 'groupId'], { unique: true })
export class MenuItemModifierGroup extends BaseEntity {
  @Column({ type: 'uuid' })
  menuItemId: string;

  @Column({ type: 'uuid' })
  groupId: string;

  @Column({ default: 0 })
  sortOrder: number;
}

/** POS integration (Square / Toast / Clover / Deliverect / Otter). Phase 3 - config only. */
@Entity('restaurant_integrations')
export class RestaurantIntegration extends BaseEntity {
  @Index()
  @Column({ type: 'uuid' })
  restaurantId: string;

  @Column()
  provider: string;

  @Column({ default: 'DISCONNECTED' })
  status: string;

  @Column({ type: 'jsonb', default: {} })
  config: Record<string, any>;

  @Column({ type: 'timestamptz', nullable: true })
  lastSyncAt: Date | null;
}
