import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../common/base.entity';

/**
 * The trainable knowledge base of the ordering assistant (docs/assistant-training.md).
 * scopeKey = "r:<restaurantId>" for a restaurant bot, "central" for the FORKSY website bot.
 */

/** The DRAFT being edited (one row per scope). The live bot never reads it. */
@Entity('assistant_kb_drafts')
export class AssistantKbDraft extends BaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 60 })
  scopeKey: string;

  @Column({ type: 'uuid', nullable: true })
  restaurantId: string | null;

  /** KbContent: entries, aliases, synonyms, documents, settings */
  @Column({ type: 'jsonb', default: {} })
  content: Record<string, any>;

  /** saved test cases (max 100) */
  @Column({ type: 'jsonb', default: [] })
  testCases: Record<string, any>[];

  /** the published version this draft started from */
  @Column({ default: 0 })
  baseVersion: number;

  @Column({ type: 'varchar', nullable: true })
  updatedByName: string | null;
}

/** An immutable numbered snapshot. The highest version of a scope is the LIVE one. */
@Entity('assistant_kb_versions')
@Index(['scopeKey', 'version'], { unique: true })
export class AssistantKbVersion extends BaseEntity {
  @Column({ type: 'varchar', length: 60 })
  scopeKey: string;

  @Column()
  version: number;

  @Column({ type: 'jsonb' })
  content: Record<string, any>;

  @Column({ type: 'varchar', length: 300, nullable: true })
  note: string | null;

  /** migration | publish | rollback | faq | approval */
  @Column({ type: 'varchar', length: 20, default: 'publish' })
  source: string;

  @Column({ type: 'uuid', nullable: true })
  publishedById: string | null;

  @Column({ type: 'varchar', nullable: true })
  publishedByName: string | null;

  @Column({ type: 'jsonb', default: {} })
  counts: Record<string, number>;

  /** rollback: the version that was restored */
  @Column({ type: 'int', nullable: true })
  restoredFrom: number | null;
}

/** How often an entry answered and how customers rated it (thumbs). */
@Entity('assistant_kb_stats')
@Index(['scopeKey', 'entryId'], { unique: true })
export class AssistantKbStat extends BaseEntity {
  @Column({ type: 'varchar', length: 60 })
  scopeKey: string;

  @Column({ type: 'varchar', length: 60 })
  entryId: string;

  @Column({ default: 0 })
  answered: number;

  @Column({ default: 0 })
  up: number;

  @Column({ default: 0 })
  down: number;

  @Column({ type: 'timestamptz', nullable: true })
  lastAnsweredAt: Date | null;
}

/**
 * Questions customers asked, grouped by normalised wording. NO session ids, NO ip, personal data stripped before storing.
 * outcome UNANSWERED rows are the "unanswered inbox".
 */
@Entity('assistant_questions')
@Index(['scopeKey', 'normKey', 'outcome'], { unique: true })
export class AssistantQuestion extends BaseEntity {
  @Column({ type: 'varchar', length: 60 })
  scopeKey: string;

  @Column({ type: 'varchar', length: 240 })
  normKey: string;

  /** a representative phrasing (sanitised) */
  @Column({ type: 'varchar', length: 240 })
  text: string;

  /** UNANSWERED | AMBIGUOUS | TRAINING | DOCUMENT */
  @Column({ type: 'varchar', length: 12 })
  outcome: string;

  @Column({ type: 'varchar', length: 60, nullable: true })
  entryId: string | null;

  @Column({ default: 1 })
  count: number;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  firstSeenAt: Date;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  lastSeenAt: Date;

  /** up to 5 other phrasings of the same question */
  @Column({ type: 'jsonb', default: [] })
  examples: string[];

  /** OPEN | TAUGHT | IGNORED */
  @Column({ type: 'varchar', length: 8, default: 'OPEN' })
  status: string;

  @Column({ type: 'varchar', length: 60, nullable: true })
  resolvedEntryId: string | null;
}

/** Daily counters for the training analytics: outcome = TRAINING | DOCUMENT | AMBIGUOUS | BUILTIN | UNANSWERED. */
@Entity('assistant_daily')
@Index(['scopeKey', 'day', 'outcome'], { unique: true })
export class AssistantDaily extends BaseEntity {
  @Column({ type: 'varchar', length: 60 })
  scopeKey: string;

  @Column({ type: 'date' })
  day: string;

  @Column({ type: 'varchar', length: 12 })
  outcome: string;

  @Column({ default: 0 })
  count: number;
}

/** A thumbs up / down on an answer that came from training. No session id. */
@Entity('assistant_feedback')
export class AssistantFeedback extends BaseEntity {
  @Index()
  @Column({ type: 'varchar', length: 60 })
  scopeKey: string;

  @Column({ type: 'varchar', length: 60, nullable: true })
  entryId: string | null;

  /** up | down */
  @Column({ type: 'varchar', length: 4 })
  rating: string;

  @Column({ type: 'varchar', length: 240, nullable: true })
  question: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  comment: string | null;

  @Column({ default: false })
  reviewed: boolean;
}

/** A restaurant asked for its draft to go live (only when assistant.training.requireApproval is on). */
@Entity('assistant_kb_requests')
export class AssistantKbRequest extends BaseEntity {
  @Index()
  @Column({ type: 'varchar', length: 60 })
  scopeKey: string;

  @Column({ type: 'uuid', nullable: true })
  restaurantId: string | null;

  /** publish | rollback | faq */
  @Column({ type: 'varchar', length: 10, default: 'publish' })
  kind: string;

  /** the exact content that goes live when approved */
  @Column({ type: 'jsonb' })
  content: Record<string, any>;

  @Column({ type: 'varchar', length: 300, nullable: true })
  note: string | null;

  /** PENDING | APPROVED | REJECTED | CANCELLED */
  @Index()
  @Column({ type: 'varchar', length: 10, default: 'PENDING' })
  status: string;

  @Column({ type: 'uuid', nullable: true })
  requestedById: string | null;

  @Column({ type: 'varchar', nullable: true })
  requestedByName: string | null;

  @Column({ type: 'jsonb', default: {} })
  counts: Record<string, number>;

  @Column({ default: 0 })
  regressions: number;

  @Column({ type: 'uuid', nullable: true })
  decidedById: string | null;

  @Column({ type: 'varchar', nullable: true })
  decidedByName: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  decidedAt: Date | null;

  @Column({ type: 'varchar', length: 300, nullable: true })
  decisionNote: string | null;

  @Column({ type: 'int', nullable: true })
  resultVersion: number | null;
}
