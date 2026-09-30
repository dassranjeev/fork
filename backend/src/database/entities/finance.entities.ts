import { Column, Entity, Index } from 'typeorm';
import { BaseEntity, MoneyColumn, PctColumn } from '../../common/base.entity';
import {
  BatchStatus,
  LedgerType,
  PartyType,
  PayoutStatus,
  RefundChargedTo,
  RefundStatus,
  RefundType,
} from '../../common/enums';

/**
 * Double-entry-ish ledger. One row per money movement for a party.
 * Positive = party is owed / earned, negative = deducted.
 * Orders write these rows when they reach DELIVERED / COLLECTED (see LedgerService.settleOrder).
 */
@Entity('ledger_entries')
@Index(['partyType', 'partyId', 'createdAt'])
export class LedgerEntry extends BaseEntity {
  @Column({ type: 'enum', enum: PartyType })
  partyType: PartyType;

  /** merchantId | driver profile id | customer user id | null for PLATFORM */
  @Column({ type: 'uuid', nullable: true })
  partyId: string | null;

  /** for restaurants we also keep the location */
  @Index()
  @Column({ type: 'uuid', nullable: true })
  restaurantId: string | null;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  orderId: string | null;

  @Column({ type: 'enum', enum: LedgerType })
  type: LedgerType;

  @MoneyColumn()
  amount: number;

  @Column({ default: 'CAD' })
  currency: string;

  @Column({ type: 'varchar', nullable: true })
  description: string | null;

  /** set once included in a payout */
  @Index()
  @Column({ type: 'uuid', nullable: true })
  payoutId: string | null;

  @Column({ type: 'jsonb', nullable: true })
  meta: Record<string, any> | null;
}

@Entity('payout_batches')
export class PayoutBatch extends BaseEntity {
  @Column({ type: 'date' })
  periodStart: string;

  @Column({ type: 'date' })
  periodEnd: string;

  @Column({ type: 'enum', enum: BatchStatus, default: BatchStatus.DRAFT })
  status: BatchStatus;

  @Column({ default: 0 })
  restaurantCount: number;

  @Column({ default: 0 })
  driverCount: number;

  @MoneyColumn()
  totalRestaurants: number;

  @MoneyColumn()
  totalDrivers: number;

  @MoneyColumn()
  total: number;

  /** batches over the city threshold need Super Admin release. */
  @Column({ default: false })
  requiresSuperAdmin: boolean;

  /** Stripe reconciliation result: captured payments vs balance. */
  @Column({ type: 'jsonb', nullable: true })
  reconciliation: {
    captured?: number;
    stripeBalance?: number;
    gap?: number;
    resolved?: boolean;
    notes?: string;
    source?: 'stripe' | 'mock';
    checkedAt?: string;
    resolvedById?: string;
    error?: string;
  } | null;

  @Column({ type: 'uuid', nullable: true })
  createdById: string | null;

  @Column({ type: 'uuid', nullable: true })
  approvedById: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  approvedAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  releasedById: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  releasedAt: Date | null;

  @Column({ type: 'text', nullable: true })
  notes: string | null;

  /** generation summary: held / carried-forward parties etc. (FinanceModule) */
  @Column({ type: 'jsonb', nullable: true })
  summary: Record<string, any> | null;
}

@Entity('payouts')
export class Payout extends BaseEntity {
  @Index()
  @Column({ type: 'uuid', nullable: true })
  batchId: string | null;

  @Column({ type: 'enum', enum: PartyType })
  partyType: PartyType; // RESTAURANT | DRIVER

  /** merchantId or driver profile id */
  @Index()
  @Column({ type: 'uuid' })
  partyId: string;

  @Column({ type: 'varchar', nullable: true })
  partyName: string | null;

  @Column({ type: 'date' })
  periodStart: string;

  @Column({ type: 'date' })
  periodEnd: string;

  @MoneyColumn()
  gross: number;

  @MoneyColumn()
  deductions: number;

  @MoneyColumn()
  fee: number; // instant cash-out fee

  @MoneyColumn()
  net: number;

  @Column({ default: 0 })
  orderCount: number;

  @Column({ type: 'enum', enum: PayoutStatus, default: PayoutStatus.PENDING })
  status: PayoutStatus;

  @Column({ default: false })
  instant: boolean;

  @Column({ type: 'varchar', default: 'EFT' })
  method: 'EFT' | 'DEBIT_CARD' | 'MANUAL';

  @Column({ type: 'varchar', nullable: true })
  externalRef: string | null;

  @Column({ type: 'text', nullable: true })
  failureReason: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  paidAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  statementSentAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  approvedById: string | null;

  /** breakdown, hold reasons, provider info (FinanceModule) */
  @Column({ type: 'jsonb', nullable: true })
  meta: Record<string, any> | null;
}

@Entity('refunds')
export class Refund extends BaseEntity {
  @Index()
  @Column({ type: 'uuid' })
  orderId: string;

  @Column({ type: 'uuid', nullable: true })
  ticketId: string | null;

  @MoneyColumn()
  amount: number;

  @Column({ type: 'enum', enum: RefundType, default: RefundType.REFUND })
  type: RefundType;

  @Column({ type: 'enum', enum: RefundChargedTo })
  chargedTo: RefundChargedTo;

  /** e.g. MISSING_ITEM, WRONG_ITEM, LATE, NEVER_ARRIVED, QUALITY, RESTAURANT_CANCELLED, GOODWILL */
  @Column()
  reasonCode: string;

  @Column({ type: 'text', nullable: true })
  notes: string | null;

  @Column({ type: 'enum', enum: RefundStatus, default: RefundStatus.PROCESSED })
  status: RefundStatus;

  /** who raised it */
  @Column({ type: 'uuid', nullable: true })
  createdById: string | null;

  @Column({ type: 'varchar', default: 'STAFF' })
  createdByType: 'STAFF' | 'SYSTEM' | 'CUSTOMER';

  @Column({ type: 'uuid', nullable: true })
  approvedById: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  processedAt: Date | null;

  /** true = created automatically by self-serve rule engine */
  @Column({ default: false })
  auto: boolean;
}

/** Monthly / weekly commission invoice to a restaurant (includes FORKSY's HST). */
@Entity('invoices')
export class Invoice extends BaseEntity {
  @Index({ unique: true })
  @Column()
  number: string;

  @Index()
  @Column({ type: 'uuid' })
  merchantId: string;

  @Column({ type: 'uuid', nullable: true })
  payoutId: string | null;

  @Column({ type: 'date' })
  periodStart: string;

  @Column({ type: 'date' })
  periodEnd: string;

  @MoneyColumn()
  commissionAmount: number;

  @MoneyColumn()
  feeAmount: number;

  @MoneyColumn()
  hstAmount: number;

  @MoneyColumn()
  total: number;

  @Column({ type: 'varchar', nullable: true })
  forksyHstNumber: string | null;

  @Column({ default: 'ISSUED' })
  status: 'DRAFT' | 'ISSUED' | 'PAID' | 'VOID';

  @Column({ type: 'jsonb', default: [] })
  lines: { orderId: string; code: string; subtotal: number; commission: number }[];

  @Column({ type: 'varchar', nullable: true })
  voidReason: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  voidedAt: Date | null;
}

@Entity('scheduled_reports')
export class ScheduledReport extends BaseEntity {
  @Column()
  name: string;

  /** executive | live_ops | restaurant_performance | driver_performance | customer_growth | finance | support */
  @Column()
  dashboard: string;

  /** simple cron-like: DAILY | WEEKLY | MONTHLY */
  @Column({ default: 'WEEKLY' })
  frequency: 'DAILY' | 'WEEKLY' | 'MONTHLY';

  @Column({ type: 'jsonb', default: [] })
  recipients: string[];

  @Column({ default: 'CSV' })
  format: 'CSV' | 'XLSX';

  @Column({ type: 'jsonb', default: {} })
  filters: Record<string, any>;

  @Column({ default: true })
  active: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  lastRunAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  createdById: string | null;
}
