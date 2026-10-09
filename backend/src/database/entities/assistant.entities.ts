import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../common/base.entity';

/** One line of an assistant (bot) cart. Mirrors a customer Cart line so it can be written to the real cart unchanged. */
export interface AssistantCartLine {
  lineId: string;
  menuItemId: string;
  quantity: number;
  modifierOptionIds: string[];
  notes?: string;
}

/** A question the bot asked and is waiting for the answer to (required modifier group, ambiguous item, restaurant switch). */
export type AssistantPending =
  | { kind: 'modifiers'; menuItemId: string; quantity: number; chosen: string[]; notes?: string; queue?: string[] }
  | { kind: 'choose'; menuItemIds: string[]; quantity: number; notes?: string; queue?: string[] }
  | { kind: 'switch'; slug: string };

export interface AssistantTranscriptEntry {
  role: 'user' | 'bot';
  text: string;
  at: string;
  /** bot messages: opaque id the widget sends back with a thumbs up / down */
  id?: string;
  /** bot messages: the taught entry that gave the answer */
  entry?: string | null;
}

/**
 * A chat with the ordering assistant. Guests are anonymous: no IP is stored, only the page origin (embedded mode).
 * The cart lives here until it is handed to the FORKSY website (one-time token) or written to a logged-in customer's real cart.
 */
@Entity('assistant_sessions')
export class AssistantSession extends BaseEntity {
  /** null = the central FORKSY bot that has not been scoped to a restaurant yet */
  @Index()
  @Column({ type: 'uuid', nullable: true })
  restaurantId: string | null;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  customerId: string | null;

  @Column({ type: 'varchar', default: 'site' })
  mode: 'embedded' | 'site';

  @Column({ type: 'varchar', nullable: true })
  origin: string | null;

  @Column({ type: 'jsonb', default: [] })
  cart: AssistantCartLine[];

  @Column({ type: 'text', nullable: true })
  orderNote: string | null;

  @Column({ type: 'jsonb', nullable: true })
  pending: AssistantPending | null;

  /** last 30 messages, each trimmed */
  @Column({ type: 'jsonb', default: [] })
  transcript: AssistantTranscriptEntry[];

  @Column({ default: 0 })
  messageCount: number;

  /** true once an item was ever added (for the "carts" statistic; the cart itself may be emptied again) */
  @Column({ default: false })
  cartTouched: boolean;

  /** SHA-256 (hex) of the one-time hand-off token. The token itself is never stored. */
  @Index()
  @Column({ type: 'varchar', nullable: true })
  handoffTokenHash: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  handoffExpiresAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  handoffUsedAt: Date | null;

  @Column({ default: 0 })
  handoffCount: number;

  @Column({ type: 'timestamptz', nullable: true })
  importedAt: Date | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  lastActiveAt: Date;

  @Index()
  @Column({ type: 'timestamptz' })
  expiresAt: Date;
}
