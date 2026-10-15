import { Column, Entity, Index, JoinColumn, ManyToOne, OneToMany, Relation } from 'typeorm';
import { BaseEntity, GeoColumn, MoneyColumn, PctColumn, QtyColumn } from '../../common/base.entity';
import {
  ActorType,
  DropoffMethod,
  FulfilmentMode,
  OrderStatus,
  OrderType,
  PaymentMethod,
  PaymentStatus,
} from '../../common/enums';
import { Restaurant } from './restaurant.entities';

export interface AddressSnapshot {
  label?: string;
  line1: string;
  line2?: string | null;
  city: string;
  province?: string;
  postalCode?: string;
  lat: number;
  lng: number;
  dropoffNotes?: string | null;
}

@Entity('orders')
export class Order extends BaseEntity {
  /** Human friendly code shown to everyone, e.g. FK-483920 */
  @Index({ unique: true })
  @Column()
  code: string;

  @Index()
  @Column({ type: 'uuid' })
  customerId: string; // users.id

  @Index()
  @Column({ type: 'uuid' })
  restaurantId: string;

  @ManyToOne(() => Restaurant, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'restaurantId' })
  restaurant: Relation<Restaurant>;

  /** DriverProfile.id (null until assigned). */
  @Index()
  @Column({ type: 'uuid', nullable: true })
  driverId: string | null;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  zoneId: string | null;

  @Column({ type: 'uuid', nullable: true })
  cityId: string | null;

  @Column({ type: 'enum', enum: OrderType })
  type: OrderType;

  @Column({ type: 'enum', enum: FulfilmentMode })
  fulfilment: FulfilmentMode;

  @Index()
  @Column({ type: 'enum', enum: OrderStatus, default: OrderStatus.PLACED })
  status: OrderStatus;

  @Column({ type: 'jsonb', nullable: true })
  deliveryAddress: AddressSnapshot | null;

  // ---- scheduling / timing ----
  @Column({ default: false })
  isScheduled: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  scheduledFor: Date | null;

  @Column({ type: 'int', nullable: true })
  prepTimeMin: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  estimatedReadyAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  estimatedDeliveryAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  acceptDeadlineAt: Date | null;

  /**
   * The order is only handed to the kitchen when the customer's cancellation window (orders.customerCancelGraceSeconds) has passed.
   * kitchenReleaseAt = placement + window; kitchenReleasedAt = when it really was sent. Orders created before this rule have
   * kitchenReleaseAt = null and count as released.
   */
  @Column({ type: 'timestamptz', nullable: true })
  kitchenReleaseAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  kitchenReleasedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  acceptedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  driverAssignedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  preparingAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  readyAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  pickedUpAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  onTheWayAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  deliveredAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  cancelledAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  driverArrivedRestaurantAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  driverArrivedCustomerAt: Date | null;

  // ---- money (all CAD) ----
  @MoneyColumn()
  subtotal: number;

  @MoneyColumn()
  deliveryFee: number;

  @MoneyColumn()
  serviceFee: number;

  @MoneyColumn()
  smallOrderFee: number;

  @MoneyColumn()
  taxAmount: number;

  @MoneyColumn()
  tip: number;

  /** Total discount given to the customer. */
  @MoneyColumn()
  discountTotal: number;

  /** split of discountTotal by who funds it */
  @MoneyColumn()
  platformPromoAmount: number;

  @MoneyColumn()
  restaurantPromoAmount: number;

  @MoneyColumn()
  walletUsed: number;

  @MoneyColumn()
  total: number;

  @Column({ type: 'uuid', nullable: true })
  promotionId: string | null;

  @Column({ type: 'varchar', nullable: true })
  promoCode: string | null;

  @PctColumn({ default: 0 })
  commissionPct: number;

  @MoneyColumn()
  commissionAmount: number;

  @MoneyColumn()
  restaurantPayout: number;

  @MoneyColumn()
  driverPay: number;

  @MoneyColumn()
  driverBoost: number;

  /** Minutes the driver waited at the restaurant after the promised ready time (see orders.waitFee.* settings); 0 = none */
  @Column({ type: 'int', default: 0 })
  driverWaitMinutes: number;

  /** Wait-time pay for the driver, deducted from the restaurant's payout. Posted to the ledger when the order is settled. */
  @MoneyColumn()
  driverWaitFee: number;

  @MoneyColumn()
  platformRevenue: number;

  @Column({ type: 'numeric', precision: 8, scale: 3, nullable: true, transformer: { to: (v) => v, from: (v) => (v == null ? v : parseFloat(v)) } })
  distanceKm: number | null;

  // ---- payment ----
  @Column({ type: 'enum', enum: PaymentMethod, default: PaymentMethod.CARD })
  paymentMethod: PaymentMethod;

  @Index()
  @Column({ type: 'enum', enum: PaymentStatus, default: PaymentStatus.PENDING })
  paymentStatus: PaymentStatus;

  /** Stripe PaymentIntent holding / having captured this order's card amount. One intent can back one order only. */
  @Index({ unique: true, where: '"paymentIntentId" IS NOT NULL' })
  @Column({ type: 'varchar', nullable: true })
  paymentIntentId: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  tipEditableUntil: Date | null;

  // ---- handoff / proof ----
  /** Code the driver / customer must show at the restaurant. */
  @Column({ type: 'varchar', nullable: true })
  pickupCode: string | null;

  /** High-value orders: PIN customer gives the driver. */
  @Column({ type: 'varchar', nullable: true })
  deliveryPin: string | null;

  @Column({ default: false })
  requiresPin: boolean;

  /** The customer's choice: use a private delivery PIN (default). false = no PIN, the driver must photograph the delivered order. */
  @Column({ default: true })
  usePin: boolean;

  /** Kept in sync with dropoffMethod === LEAVE_AT_DOOR (legacy flag, still returned to the apps). */
  @Column({ default: false })
  contactless: boolean;

  /** How the customer wants the handover; decides which proof of delivery is required (see docs/proof-of-delivery.md). */
  @Column({ type: 'enum', enum: DropoffMethod, default: DropoffMethod.HAND_TO_ME })
  dropoffMethod: DropoffMethod;

  /** Delivery instructions for the DRIVER (max 300, plain text). Not the kitchen note (customerNotes). */
  @Column({ type: 'varchar', length: 300, nullable: true })
  dropoffNotes: string | null;

  /** Buzzer / gate / door code. SENSITIVE: AES-GCM sealed (secretbox), never selected by default - load it with addSelect('o.accessCode') only where it is allowed. */
  @Column({ type: 'text', nullable: true, select: false })
  accessCode: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  accessCodePurgedAt: Date | null;

  @Column({ type: 'varchar', nullable: true })
  proofPhotoUrl: string | null;

  @Column({ type: 'text', nullable: true })
  customerNotes: string | null;

  @Column({ default: false })
  hasAllergyFlag: boolean;

  // ---- retail (groceries): see docs/store-types.md ----
  /** the basket holds age-restricted goods: ID is checked at hand-over (driver) or at the counter (pickup) */
  @Column({ default: false })
  requiresIdCheck: boolean;

  /** highest minimum age among the items (0 = none) */
  @Column({ default: 0 })
  minAge: number;

  /** the customer confirmed their age at checkout */
  @Column({ default: false })
  ageConfirmed: boolean;

  /** counts for the picker and the driver: { units, lines, weighed, chilled, frozen, heavyKg } */
  @Column({ type: 'jsonb', nullable: true })
  basket: { units: number; lines: number; weighed: number; chilled: number; frozen: number; estimatedKg: number } | null;

  // ---- exceptions ----
  @Column({ default: false })
  isLate: boolean;

  /** 0 = none, 1 = restaurant slow, 2 = dispatcher flagged, 3 = manual intervention */
  @Column({ default: 0 })
  escalationLevel: number;

  @Column({ default: false })
  unassignedFlag: boolean;

  @Column({ type: 'varchar', nullable: true })
  cancelReason: string | null;

  @Column({ type: 'varchar', nullable: true })
  cancelledBy: ActorType | null;

  @MoneyColumn()
  cancellationFee: number;

  @Column({ type: 'varchar', nullable: true })
  rejectReason: string | null;

  @Column({ default: 'app' })
  source: 'app' | 'web' | 'admin' | 'phone';

  @Column({ type: 'jsonb', default: {} })
  meta: Record<string, any>;

  @OneToMany(() => OrderItem, (i) => i.order)
  items: Relation<OrderItem[]>;
}

@Entity('order_items')
export class OrderItem extends BaseEntity {
  @Index()
  @Column({ type: 'uuid' })
  orderId: string;

  @ManyToOne(() => Order, (o) => o.items, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'orderId' })
  order: Relation<Order>;

  @Column({ type: 'uuid', nullable: true })
  menuItemId: string | null;

  @Column()
  name: string;

  @Column({ default: 1 })
  quantity: number;

  /** price per unit incl. modifiers */
  @MoneyColumn()
  unitPrice: number;

  @MoneyColumn()
  lineTotal: number;

  @MoneyColumn()
  taxAmount: number;

  @Column({ type: 'varchar', nullable: true })
  taxClassCode: string | null;

  @Column({ type: 'jsonb', default: [] })
  modifiers: { groupName: string; optionId: string; name: string; priceDelta: number }[];

  @Column({ type: 'text', nullable: true })
  notes: string | null;

  @Column({ type: 'uuid', nullable: true })
  stationId: string | null;

  @Column({ type: 'jsonb', default: [] })
  allergens: string[];

  // ---- retail line facts, copied from the product when the order is placed (the product may change later) ----
  @Column({ type: 'varchar', length: 64, nullable: true })
  sku: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  barcode: string | null;

  @Column({ type: 'varchar', length: 60, nullable: true })
  packSize: string | null;

  /** UNIT, or WEIGHT: `quantity` is then a number of steps of `stepSize` weight units, weighed when picked */
  @Column({ type: 'varchar', length: 10, default: 'UNIT' })
  sellBy: 'UNIT' | 'WEIGHT';

  @Column({ type: 'varchar', length: 4, default: 'KG' })
  weightUnit: 'KG' | 'LB';

  @QtyColumn({ default: 1 })
  stepSize: number;

  /** weighed items: what was ordered (steps x step size) and what the picker weighed (null until weighed) */
  @QtyColumn({ nullable: true })
  estimatedWeight: number | null;

  @QtyColumn({ nullable: true })
  actualWeight: number | null;

  @Column({ default: 0 })
  minAge: number;

  @Column({ type: 'varchar', length: 10, default: 'AMBIENT' })
  temperature: 'AMBIENT' | 'CHILLED' | 'FROZEN';

  /** what the customer wants if the store does not have it: ALLOW a replacement or REFUND it */
  @Column({ type: 'varchar', length: 10, default: 'ALLOW' })
  substitution: 'ALLOW' | 'REFUND';

  /** picking list state (retail): PENDING | PICKED | REPLACED | OUT_OF_STOCK */
  @Column({ type: 'varchar', length: 14, default: 'PENDING' })
  pickStatus: 'PENDING' | 'PICKED' | 'REPLACED' | 'OUT_OF_STOCK';

  /** REPLACED: what the customer gets instead { menuItemId, name, quantity, unitPrice, packSize } */
  @Column({ type: 'jsonb', nullable: true })
  replacement: { menuItemId: string; name: string; quantity: number; unitPrice: number; packSize?: string | null } | null;

  /** money given back for this line after picking (weighed lighter, replaced by a cheaper product, not handed over without ID) */
  @MoneyColumn({ default: 0 })
  adjustmentRefund: number;

  /** age-restricted line the recipient could not show ID for: not handed over, refunded */
  @Column({ default: false })
  idRefused: boolean;

  /** KDS station state */
  @Column({ type: 'varchar', default: 'NEW' })
  kitchenStatus: 'NEW' | 'PREPARING' | 'READY';

  /** Partial fulfilment: item removed because unavailable. */
  @Column({ default: false })
  removed: boolean;

  @Column({ type: 'varchar', nullable: true })
  removedReason: string | null;
}

/** Immutable status timeline of an order. */
@Entity('order_events')
export class OrderEvent extends BaseEntity {
  @Index()
  @Column({ type: 'uuid' })
  orderId: string;

  @Column({ type: 'varchar' })
  type: string; // STATUS_CHANGE, ETA_UPDATE, NOTE, REASSIGN, FLAG, REFUND, PARTIAL_FULFILMENT...

  @Column({ type: 'varchar', nullable: true })
  fromStatus: string | null;

  @Column({ type: 'varchar', nullable: true })
  toStatus: string | null;

  @Column({ type: 'varchar', default: ActorType.SYSTEM })
  actorType: ActorType;

  @Column({ type: 'uuid', nullable: true })
  actorId: string | null;

  @Column({ type: 'text', nullable: true })
  note: string | null;

  @Column({ type: 'jsonb', nullable: true })
  data: Record<string, any> | null;
}

/** Masked in-app chat scoped to an order. Real phone numbers are never exposed. */
@Entity('order_messages')
export class OrderMessage extends BaseEntity {
  @Index()
  @Column({ type: 'uuid' })
  orderId: string;

  @Column({ type: 'varchar' })
  senderType: ActorType;

  @Column({ type: 'uuid', nullable: true })
  senderId: string | null;

  /** who should receive it: CUSTOMER | DRIVER | RESTAURANT | STAFF */
  @Column({ type: 'varchar' })
  recipientType: ActorType;

  @Column({ type: 'text' })
  body: string;

  @Column({ type: 'timestamptz', nullable: true })
  readAt: Date | null;
}

@Entity('payments')
export class Payment extends BaseEntity {
  @Index()
  @Column({ type: 'uuid' })
  orderId: string;

  @Column({ default: 'stripe' })
  provider: string;

  @Column({ type: 'varchar' })
  kind: 'AUTHORIZE' | 'CAPTURE' | 'RELEASE' | 'REFUND' | 'TIP_ADJUST' | 'WALLET' | 'GIFT_CARD' | 'DISPUTE' | 'DISPUTE_REVERSAL';

  @MoneyColumn()
  amount: number;

  @Column({ default: 'CAD' })
  currency: string;

  @Column({ type: 'varchar', default: 'SUCCEEDED' })
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED';

  @Column({ type: 'varchar', nullable: true })
  externalId: string | null;

  @Column({ type: 'jsonb', nullable: true })
  meta: Record<string, any> | null;
}

@Entity('reviews')
export class Review extends BaseEntity {
  @Index({ unique: true })
  @Column({ type: 'uuid' })
  orderId: string;

  @Index()
  @Column({ type: 'uuid' })
  customerId: string;

  @Index()
  @Column({ type: 'uuid' })
  restaurantId: string;

  @Column({ type: 'uuid', nullable: true })
  driverId: string | null;

  /** 1-5 */
  @Column({ type: 'int', nullable: true })
  restaurantRating: number | null;

  @Column({ type: 'int', nullable: true })
  driverRating: number | null;

  @Column({ type: 'jsonb', default: [] })
  restaurantTags: string[];

  @Column({ type: 'jsonb', default: [] })
  driverTags: string[];

  @Column({ type: 'text', nullable: true })
  comment: string | null;

  @Column({ type: 'text', nullable: true })
  driverComment: string | null;

  @Column({ type: 'text', nullable: true })
  reply: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  repliedAt: Date | null;

  /** Moderation state of the RESTAURANT part of the review (and of the review as a whole for legacy readers). */
  @Column({ default: 'VISIBLE' })
  status: 'VISIBLE' | 'HIDDEN' | 'FLAGGED';

  // ---- ratings system (docs/ratings.md) ----
  /** Moderation state of the DRIVER part (staff with drivers:approve act on this; restaurant staff act on `status`). */
  @Column({ default: 'VISIBLE' })
  driverStatus: 'VISIBLE' | 'HIDDEN' | 'FLAGGED';

  /** How many times the customer edited the review (one edit allowed inside ratings.editWindowHours). */
  @Column({ default: 0 })
  editCount: number;

  @Column({ type: 'timestamptz', nullable: true })
  editedAt: Date | null;

  /** Previous versions: [{at, restaurantRating, driverRating, restaurantTags, driverTags, comment, driverComment}] */
  @Column({ type: 'jsonb', default: [] })
  history: Record<string, any>[];

  /** Why the review is FLAGGED: automatic fraud rules (FRAUD_ACCOUNT, REVIEW_BOMB, DUPLICATE_TEXT, REFUND_RETALIATION) or REPORTED_BY_RESTAURANT / STAFF. */
  @Column({ type: 'jsonb', default: [] })
  flagReasons: string[];

  /** Staff moderation log: [{side, action, reason, byId, byName, at}] */
  @Column({ type: 'jsonb', default: [] })
  moderation: Record<string, any>[];

  /** Restaurant report of an abusive review (one per review). */
  @Column({ type: 'timestamptz', nullable: true })
  reportedAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  reportedById: string | null;

  @Column({ type: 'text', nullable: true })
  reportReason: string | null;

  /** md5 of the normalised comment text, used for duplicate detection. */
  @Index()
  @Column({ type: 'varchar', length: 32, nullable: true })
  commentHash: string | null;
}
