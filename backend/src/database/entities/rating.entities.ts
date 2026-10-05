import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../common/base.entity';

/**
 * Private feedback about a customer, written by the driver or the restaurant of an order.
 * Never shown to the customer, the public, or the rater's counterpart; only staff (customers:view) see it.
 */
@Entity('customer_ratings')
@Index(['orderId', 'raterType'], { unique: true })
export class CustomerRating extends BaseEntity {
  @Column({ type: 'uuid' })
  orderId: string;

  @Index()
  @Column({ type: 'uuid' })
  customerId: string; // users.id

  @Column({ type: 'varchar' })
  raterType: 'DRIVER' | 'RESTAURANT';

  /** users.id of whoever submitted it */
  @Column({ type: 'uuid' })
  raterId: string;

  /** DriverProfile.id | Restaurant.id */
  @Column({ type: 'uuid', nullable: true })
  raterRefId: string | null;

  @Column({ type: 'int' })
  rating: number;

  @Column({ type: 'jsonb', default: [] })
  tags: string[];

  @Column({ type: 'text', nullable: true })
  note: string | null;
}

/** Idempotency ledger for rating prompts (one row per order + audience + kind, enforced by the unique index). */
@Entity('rating_prompts')
@Index(['orderId', 'userId', 'kind'], { unique: true })
export class RatingPrompt extends BaseEntity {
  @Column({ type: 'uuid' })
  orderId: string;

  @Column({ type: 'uuid' })
  userId: string;

  /** CUSTOMER_PROMPT | CUSTOMER_REMINDER | DRIVER_PROMPT | RESTAURANT_PROMPT */
  @Column({ type: 'varchar' })
  kind: string;
}
