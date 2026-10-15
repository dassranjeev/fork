/** Shared enums for the whole platform. Keep string values stable - they are stored in PostgreSQL. */

export enum UserType {
  SUPER_ADMIN = 'SUPER_ADMIN',
  STAFF = 'STAFF', // internal staff, permissions come from a Role
  RESTAURANT = 'RESTAURANT', // owner / manager / cashier / kitchen
  DRIVER = 'DRIVER',
  CUSTOMER = 'CUSTOMER',
}

export enum UserStatus {
  PENDING = 'PENDING',
  ACTIVE = 'ACTIVE',
  SUSPENDED = 'SUSPENDED',
  BLOCKED = 'BLOCKED',
  DELETED = 'DELETED',
}

/** RBAC modules (Admin Console sections). */
export enum Module {
  DASHBOARD = 'dashboard',
  LIVE_MAP = 'live_map',
  ORDERS = 'orders',
  RESTAURANTS = 'restaurants',
  DRIVERS = 'drivers',
  CUSTOMERS = 'customers',
  ZONES = 'zones',
  PRICING = 'pricing',
  PROMOTIONS = 'promotions',
  FINANCE = 'finance',
  SUPPORT = 'support',
  CONTENT = 'content',
  SETTINGS = 'settings',
  AUDIT = 'audit',
  STAFF = 'staff',
  ROLES = 'roles',
  REPORTS = 'reports',
  NOTIFICATIONS = 'notifications',
  OPERATIONS = 'operations',
}

export enum Action {
  VIEW = 'view',
  CREATE = 'create',
  EDIT = 'edit',
  DELETE = 'delete',
  APPROVE = 'approve',
  EXPORT = 'export',
}

export enum RestaurantRole {
  OWNER = 'OWNER',
  LOCATION_MANAGER = 'LOCATION_MANAGER',
  CASHIER = 'CASHIER',
  KITCHEN = 'KITCHEN',
}

export enum RestaurantStatus {
  APPLIED = 'APPLIED',
  DOCS_REVIEW = 'DOCS_REVIEW',
  MENU_SETUP = 'MENU_SETUP',
  TEST_ORDER = 'TEST_ORDER',
  LIVE = 'LIVE',
  PAUSED = 'PAUSED',
  SUSPENDED = 'SUSPENDED',
  REJECTED = 'REJECTED',
}

/** Store-controlled service mode: which fulfilment types customers can use right now. */
export enum RestaurantServiceMode {
  CLOSED = 'CLOSED',
  PICKUP_ONLY = 'PICKUP_ONLY',
  PICKUP_AND_DELIVERY = 'PICKUP_AND_DELIVERY',
}

export enum DriverStatus {
  APPLIED = 'APPLIED',
  DOCS_REVIEW = 'DOCS_REVIEW',
  BACKGROUND_CHECK = 'BACKGROUND_CHECK',
  TRAINING = 'TRAINING',
  APPROVED = 'APPROVED', // approved, waiting for zone activation
  ACTIVE = 'ACTIVE',
  SUSPENDED = 'SUSPENDED',
  DEACTIVATED = 'DEACTIVATED',
  REJECTED = 'REJECTED',
}

/** Has an account (driver or business) been verified? Separate from its lifecycle status. See docs/verification.md. */
export enum VerificationStatus {
  /** admitted without verification (instant registration); it may operate */
  UNVERIFIED = 'UNVERIFIED',
  /** verification is required and in progress: waiting for staff, or for the Certn check */
  PENDING = 'PENDING',
  /** the Certn check came back flagged / failed: a person must decide (never decided automatically) */
  NEEDS_REVIEW = 'NEEDS_REVIEW',
  VERIFIED = 'VERIFIED',
  REJECTED = 'REJECTED',
}

/** How an account was admitted / verified. */
export enum VerificationMethod {
  INSTANT = 'INSTANT',
  MANUAL = 'MANUAL',
  AUTOMATIC = 'AUTOMATIC',
}

/** Who the verification policy applies to: drivers, or businesses (a merchant and its restaurants). */
export enum VerificationAudience {
  DRIVER = 'DRIVER',
  BUSINESS = 'BUSINESS',
}

export enum VehicleType {
  CAR = 'CAR',
  BIKE = 'BIKE',
  E_BIKE = 'E_BIKE',
  SCOOTER = 'SCOOTER',
  ON_FOOT = 'ON_FOOT',
}

export enum DocStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  EXPIRED = 'EXPIRED',
}

export enum DriverDocType {
  LICENCE = 'LICENCE',
  VEHICLE_REGISTRATION = 'VEHICLE_REGISTRATION',
  INSURANCE = 'INSURANCE',
  PHOTO = 'PHOTO',
  WORK_ELIGIBILITY = 'WORK_ELIGIBILITY',
  BACKGROUND_CHECK = 'BACKGROUND_CHECK',
  OTHER = 'OTHER',
}

export enum RestaurantDocType {
  BUSINESS_LICENCE = 'BUSINESS_LICENCE',
  HEALTH_CERTIFICATE = 'HEALTH_CERTIFICATE',
  VOID_CHEQUE = 'VOID_CHEQUE',
  HST_CERTIFICATE = 'HST_CERTIFICATE',
  AGREEMENT = 'AGREEMENT',
  MENU = 'MENU',
  PHOTOS = 'PHOTOS',
  /** retail: needed before age-restricted goods (alcohol, tobacco) may be sold (docs/store-types.md) */
  LIQUOR_LICENCE = 'LIQUOR_LICENCE',
  TOBACCO_LICENCE = 'TOBACCO_LICENCE',
  FOOD_PREMISES_PERMIT = 'FOOD_PREMISES_PERMIT',
  OTHER = 'OTHER',
}

/**
 * What kind of business a location is. One platform, one store entity: the type decides how the catalog, picking and checkout behave
 * (see common/store-types.ts). RESTAURANT / CAFE / BAKERY are food service (made to order); GROCERY / CONVENIENCE / SPECIALTY are retail (picked from shelves).
 */
export enum StoreType {
  RESTAURANT = 'RESTAURANT',
  CAFE = 'CAFE',
  BAKERY = 'BAKERY',
  GROCERY = 'GROCERY',
  CONVENIENCE = 'CONVENIENCE',
  SPECIALTY = 'SPECIALTY',
}

export enum OrderType {
  DELIVERY = 'DELIVERY',
  PICKUP = 'PICKUP',
}

export enum FulfilmentMode {
  PLATFORM_DRIVER = 'PLATFORM_DRIVER',
  OWN_DRIVER = 'OWN_DRIVER',
  PICKUP = 'PICKUP',
}

/** 11 statuses: 8 flow states + 3 end states (Cancelled, Rejected, and Delivered/Collected). */
export enum OrderStatus {
  PLACED = 'PLACED',
  ACCEPTED = 'ACCEPTED',
  DRIVER_ASSIGNED = 'DRIVER_ASSIGNED',
  PREPARING = 'PREPARING',
  READY = 'READY',
  PICKED_UP = 'PICKED_UP',
  ON_THE_WAY = 'ON_THE_WAY',
  DELIVERED = 'DELIVERED',
  COLLECTED = 'COLLECTED',
  CANCELLED = 'CANCELLED',
  REJECTED = 'REJECTED',
}

export const ACTIVE_ORDER_STATUSES = [
  OrderStatus.PLACED,
  OrderStatus.ACCEPTED,
  OrderStatus.DRIVER_ASSIGNED,
  OrderStatus.PREPARING,
  OrderStatus.READY,
  OrderStatus.PICKED_UP,
  OrderStatus.ON_THE_WAY,
];
export const FINAL_ORDER_STATUSES = [
  OrderStatus.DELIVERED,
  OrderStatus.COLLECTED,
  OrderStatus.CANCELLED,
  OrderStatus.REJECTED,
];

export enum PaymentStatus {
  PENDING = 'PENDING',
  AUTHORIZED = 'AUTHORIZED',
  CAPTURED = 'CAPTURED',
  RELEASED = 'RELEASED', // auth hold released (rejected / cancelled before capture)
  PARTIALLY_REFUNDED = 'PARTIALLY_REFUNDED',
  REFUNDED = 'REFUNDED',
  FAILED = 'FAILED',
}

export enum PaymentMethod {
  CARD = 'CARD',
  APPLE_PAY = 'APPLE_PAY',
  GOOGLE_PAY = 'GOOGLE_PAY',
  WALLET = 'WALLET',
  GIFT_CARD = 'GIFT_CARD',
  CASH = 'CASH', // reserved, disabled by default
}

export enum ActorType {
  SYSTEM = 'SYSTEM',
  CUSTOMER = 'CUSTOMER',
  RESTAURANT = 'RESTAURANT',
  DRIVER = 'DRIVER',
  STAFF = 'STAFF',
}

export enum OfferStatus {
  PENDING = 'PENDING',
  ACCEPTED = 'ACCEPTED',
  DECLINED = 'DECLINED',
  EXPIRED = 'EXPIRED',
  CANCELLED = 'CANCELLED',
}

export enum PartyType {
  RESTAURANT = 'RESTAURANT',
  DRIVER = 'DRIVER',
  PLATFORM = 'PLATFORM',
  CUSTOMER = 'CUSTOMER',
}

export enum LedgerType {
  SALE = 'SALE', // restaurant: food subtotal + tax
  COMMISSION = 'COMMISSION', // restaurant: -commission
  RESTAURANT_PROMO = 'RESTAURANT_PROMO', // restaurant: -restaurant funded promo
  PLATFORM_PROMO = 'PLATFORM_PROMO', // platform: -platform funded promo
  DELIVERY_PAY = 'DELIVERY_PAY', // driver
  TIP = 'TIP', // driver 100%
  BOOST = 'BOOST', // driver incentive
  FEE_REVENUE = 'FEE_REVENUE', // platform: delivery/service/small-order fees
  COMMISSION_REVENUE = 'COMMISSION_REVENUE', // platform
  REFUND = 'REFUND', // charged party
  ADJUSTMENT = 'ADJUSTMENT',
  PAYOUT = 'PAYOUT', // negative when paid
  INSTANT_FEE = 'INSTANT_FEE',
  /** driver waited at the restaurant beyond the grace period: + for the driver, - for the restaurant (deducted from its payout) */
  WAIT_FEE = 'WAIT_FEE',
}

export enum PayoutStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  RELEASED = 'RELEASED',
  PAID = 'PAID',
  FAILED = 'FAILED',
  ON_HOLD = 'ON_HOLD',
}

export enum BatchStatus {
  DRAFT = 'DRAFT',
  LOCKED = 'LOCKED',
  APPROVED = 'APPROVED',
  RELEASED = 'RELEASED',
  COMPLETED = 'COMPLETED',
}

export enum RefundChargedTo {
  RESTAURANT = 'RESTAURANT',
  PLATFORM = 'PLATFORM',
  DRIVER = 'DRIVER',
}

export enum RefundType {
  REFUND = 'REFUND', // back to original payment method
  CREDIT = 'CREDIT', // FORKSY wallet credit
}

export enum RefundStatus {
  PENDING_APPROVAL = 'PENDING_APPROVAL',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  PROCESSED = 'PROCESSED',
}

export enum PromoType {
  PERCENT = 'PERCENT',
  FIXED = 'FIXED',
  FREE_DELIVERY = 'FREE_DELIVERY',
  BOGO = 'BOGO',
  FREE_ITEM = 'FREE_ITEM',
}

export enum FundedBy {
  PLATFORM = 'PLATFORM',
  RESTAURANT = 'RESTAURANT',
}

export enum TicketStatus {
  OPEN = 'OPEN',
  PENDING = 'PENDING',
  ESCALATED = 'ESCALATED',
  RESOLVED = 'RESOLVED',
  CLOSED = 'CLOSED',
}

export enum TicketTier {
  SELF_SERVE = 'SELF_SERVE',
  TIER1 = 'TIER1',
  TIER2 = 'TIER2',
  FINANCE = 'FINANCE',
}

export enum TicketCategory {
  MISSING_ITEM = 'MISSING_ITEM',
  WRONG_ITEM = 'WRONG_ITEM',
  NEVER_ARRIVED = 'NEVER_ARRIVED',
  VERY_LATE = 'VERY_LATE',
  FOOD_QUALITY = 'FOOD_QUALITY',
  RESTAURANT_CANCELLED = 'RESTAURANT_CANCELLED',
  PAYMENT = 'PAYMENT',
  PAYOUT = 'PAYOUT',
  ACCOUNT = 'ACCOUNT',
  SAFETY = 'SAFETY',
  OTHER = 'OTHER',
}

export enum NotificationChannel {
  PUSH = 'PUSH',
  SMS = 'SMS',
  EMAIL = 'EMAIL',
  IN_APP = 'IN_APP',
}

export enum DayPart {
  BREAKFAST = 'BREAKFAST',
  LUNCH = 'LUNCH',
  DINNER = 'DINNER',
  LATE_NIGHT = 'LATE_NIGHT',
}

export enum CaseTrigger {
  LOW_RATING = 'LOW_RATING',
  FRAUD_FLAG = 'FRAUD_FLAG',
  SAFETY_COMPLAINT = 'SAFETY_COMPLAINT',
  EXPIRED_DOCUMENTS = 'EXPIRED_DOCUMENTS',
  REPEATED_CANCELLATIONS = 'REPEATED_CANCELLATIONS',
  DELIVERY_DISPUTES = 'DELIVERY_DISPUTES',
  OTHER = 'OTHER',
}

export enum CaseDecision {
  PENDING = 'PENDING',
  REINSTATED = 'REINSTATED',
  WARNED = 'WARNED',
  SUSPENDED = 'SUSPENDED',
  DEACTIVATED = 'DEACTIVATED',
}

/** How the customer wants the order handed over (drives the proof-of-delivery requirement). */
export enum DropoffMethod {
  HAND_TO_ME = 'HAND_TO_ME',
  LEAVE_AT_DOOR = 'LEAVE_AT_DOOR',
  MEET_OUTSIDE = 'MEET_OUTSIDE',
}

/** Evidence kind stored on a DeliveryProof. NONE only occurs when an operator relaxed the proof settings or staff forced the delivery. */
export enum ProofType {
  PIN = 'PIN',
  PHOTO = 'PHOTO',
  PIN_AND_PHOTO = 'PIN_AND_PHOTO',
  EXCEPTION = 'EXCEPTION',
  NONE = 'NONE',
  /** PIN switched off by the customer and the driver handed the order over in person (no photo). */
  HANDED_OVER = 'HANDED_OVER',
}

/** Whether a restaurant may add / update / remove its own menu items (decided by FORKSY staff). */
export enum MenuEditStatus {
  NOT_ALLOWED = 'NOT_ALLOWED',
  REQUESTED = 'REQUESTED',
  ALLOWED = 'ALLOWED',
}

/** What the driver did at the door when the customer turned the PIN off. */
export enum DeliveryAction {
  HANDED_TO_CUSTOMER = 'HANDED_TO_CUSTOMER',
  LEFT_AT_LOCATION = 'LEFT_AT_LOCATION',
}

/** Reason codes a driver may give to complete a delivery without the normal proof (always flagged WEAK_PROOF and reviewed). */
export enum ProofExceptionReason {
  CUSTOMER_UNREACHABLE = 'CUSTOMER_UNREACHABLE',
  PIN_NOT_AVAILABLE = 'PIN_NOT_AVAILABLE',
  SAFETY_CONCERN = 'SAFETY_CONCERN',
}

/** Staff verdict on a "never arrived" dispute. */
export enum DisputeOutcome {
  UPHELD_DELIVERED = 'UPHELD_DELIVERED',
  NOT_DELIVERED = 'NOT_DELIVERED',
  INCONCLUSIVE = 'INCONCLUSIVE',
}
