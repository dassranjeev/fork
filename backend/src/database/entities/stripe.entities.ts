import { Column, Entity, Index } from 'typeorm';
import { BaseEntity, MoneyColumn } from '../../common/base.entity';

/**
 * Every Stripe PaymentIntent FORKSY created for a customer (checkout hold, wallet top-up, gift card purchase).
 * It is the server-side record that lets us (a) prove an intent belongs to the customer, (b) credit a top-up exactly once,
 * (c) cancel or refund payments that never became an order (clean-up cron) and (d) show provider ids in the admin.
 */
@Entity('stripe_intents')
export class StripeIntent extends BaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar' })
  intentId: string;

  @Index()
  @Column({ type: 'uuid' })
  customerId: string;

  /** ORDER (the card payment of an order, charged at checkout) | TOPUP (wallet) | GIFT_CARD (purchase) */
  @Column({ type: 'varchar' })
  purpose: 'ORDER' | 'TOPUP' | 'GIFT_CARD';

  /** CAD dollars */
  @MoneyColumn()
  amount: number;

  @Column({ type: 'varchar', default: 'cad' })
  currency: string;

  /** fingerprint of the priced cart (ORDER intents) */
  @Column({ type: 'varchar', nullable: true })
  quoteHash: string | null;

  /** last status we saw from Stripe */
  @Column({ type: 'varchar', default: 'requires_payment_method' })
  status: string;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  orderId: string | null;

  /** TOPUP / GIFT_CARD: set once the wallet was credited / the card issued (exactly-once claim) */
  @Column({ type: 'timestamptz', nullable: true })
  consumedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  canceledAt: Date | null;

  @Column({ type: 'jsonb', nullable: true })
  meta: Record<string, any> | null;
}

/** Idempotency + audit record of every Stripe webhook event we received. */
@Entity('stripe_events')
export class StripeEvent extends BaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar' })
  eventId: string;

  @Index()
  @Column({ type: 'varchar' })
  type: string;

  @Column({ default: false })
  livemode: boolean;

  /** connected account the event is about (Connect events), if any */
  @Column({ type: 'varchar', nullable: true })
  account: string | null;

  /** id of the main object (pi_..., ch_..., acct_..., tr_...) for quick lookups */
  @Index()
  @Column({ type: 'varchar', nullable: true })
  objectId: string | null;

  /** RECEIVED | PROCESSED | IGNORED | FAILED */
  @Index()
  @Column({ type: 'varchar', default: 'RECEIVED' })
  status: 'RECEIVED' | 'PROCESSED' | 'IGNORED' | 'FAILED';

  @Column({ default: false })
  processed: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  processedAt: Date | null;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  /** the event as Stripe sent it (needed for the admin "replay") */
  @Column({ type: 'jsonb', nullable: true })
  payload: Record<string, any> | null;
}
