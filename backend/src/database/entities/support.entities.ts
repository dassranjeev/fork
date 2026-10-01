import { Column, Entity, Index } from 'typeorm';
import { BaseEntity, MoneyColumn } from '../../common/base.entity';
import { CaseDecision, CaseTrigger, TicketCategory, TicketStatus, TicketTier } from '../../common/enums';

@Entity('tickets')
export class Ticket extends BaseEntity {
  @Index({ unique: true })
  @Column()
  number: string; // T-000123

  @Column()
  subject: string;

  /** who opened it: CUSTOMER | RESTAURANT | DRIVER | STAFF */
  @Column({ default: 'CUSTOMER' })
  requesterType: 'CUSTOMER' | 'RESTAURANT' | 'DRIVER' | 'STAFF';

  @Index()
  @Column({ type: 'uuid', nullable: true })
  requesterId: string | null; // users.id

  @Index()
  @Column({ type: 'uuid', nullable: true })
  orderId: string | null;

  @Column({ type: 'uuid', nullable: true })
  restaurantId: string | null;

  @Column({ type: 'uuid', nullable: true })
  driverId: string | null;

  @Column({ type: 'enum', enum: TicketCategory, default: TicketCategory.OTHER })
  category: TicketCategory;

  @Column({ type: 'varchar', default: 'NORMAL' })
  priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';

  @Index()
  @Column({ type: 'enum', enum: TicketStatus, default: TicketStatus.OPEN })
  status: TicketStatus;

  @Column({ type: 'enum', enum: TicketTier, default: TicketTier.TIER1 })
  tier: TicketTier;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  assignedToId: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  slaFirstResponseDueAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  slaResolutionDueAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  firstResponseAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  resolvedAt: Date | null;

  @Column({ default: false })
  slaBreached: boolean;

  /** Reason code recorded on resolution (SOP-06 step 3) */
  @Column({ type: 'varchar', nullable: true })
  reasonCode: string | null;

  @Column({ type: 'varchar', nullable: true })
  chargedTo: 'RESTAURANT' | 'PLATFORM' | 'DRIVER' | null;

  @Column({ type: 'jsonb', default: [] })
  attachments: string[]; // photo urls

  @Column({ type: 'jsonb', default: [] })
  tags: string[];

  @Column({ type: 'int', nullable: true })
  csat: number | null; // 1-5 customer satisfaction on close

  // ---- added by SupportModule ----
  @Column({ type: 'text', nullable: true })
  csatComment: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  closedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  escalatedAt: Date | null;

  @Column({ type: 'varchar', nullable: true })
  escalationReason: string | null;

  /** FIRST_RESPONSE | RESOLUTION (first breach wins) */
  @Column({ type: 'varchar', nullable: true })
  slaBreachType: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  slaBreachNotifiedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastMessageAt: Date | null;

  /** who wrote the last public message: CUSTOMER | RESTAURANT | DRIVER | STAFF | SYSTEM */
  @Column({ type: 'varchar', nullable: true })
  lastMessageBy: string | null;

  /** MANUAL (agent/app form) | SELF_SERVE (issue report) | AUTO (system generated) */
  @Column({ type: 'varchar', default: 'MANUAL' })
  source: string;

  /** self-serve rule engine settled it without an agent */
  @Column({ default: false })
  autoResolved: boolean;

  /** free text outcome shown to the requester */
  @Column({ type: 'text', nullable: true })
  resolution: string | null;

  @Column({ default: 0 })
  reopenCount: number;

  /** sum of refunds/credits issued from this ticket (PROCESSED + PENDING) */
  @MoneyColumn()
  refundedTotal: number;

  /** itemsAffected, rule outcome, evidence summary, device fingerprint, ... */
  @Column({ type: 'jsonb', default: {} })
  meta: Record<string, any>;
}

@Entity('ticket_messages')
export class TicketMessage extends BaseEntity {
  @Index()
  @Column({ type: 'uuid' })
  ticketId: string;

  @Column({ type: 'varchar' })
  senderType: 'CUSTOMER' | 'RESTAURANT' | 'DRIVER' | 'STAFF' | 'SYSTEM';

  @Column({ type: 'uuid', nullable: true })
  senderId: string | null;

  @Column({ type: 'text' })
  body: string;

  @Column({ type: 'jsonb', default: [] })
  attachments: string[];

  /** internal notes are hidden from the requester */
  @Column({ default: false })
  internal: boolean;

  // ---- added by live chat ----
  /** when the other side of a live chat read this message */
  @Column({ type: 'timestamptz', nullable: true })
  readAt: Date | null;
}

/** SOP-08: deactivation and account review case (drivers & restaurants). */
@Entity('review_cases')
export class ReviewCase extends BaseEntity {
  @Column({ type: 'varchar' })
  subjectType: 'DRIVER' | 'RESTAURANT';

  /** driver profile id or restaurant id */
  @Index()
  @Column({ type: 'uuid' })
  subjectId: string;

  @Column({ type: 'enum', enum: CaseTrigger })
  trigger: CaseTrigger;

  @Column({ type: 'text' })
  details: string;

  @Column({ type: 'timestamptz', nullable: true })
  noticeSentAt: Date | null;

  /** Ontario gig-worker rules: written notice with time to respond */
  @Column({ type: 'timestamptz', nullable: true })
  respondBy: Date | null;

  @Column({ type: 'text', nullable: true })
  subjectResponse: string | null;

  @Column({ type: 'enum', enum: CaseDecision, default: CaseDecision.PENDING })
  decision: CaseDecision;

  @Column({ type: 'text', nullable: true })
  decisionNotes: string | null;

  @Column({ type: 'uuid', nullable: true })
  reviewerId: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  decidedAt: Date | null;

  @Column({ default: 'NONE' })
  appealStatus: 'NONE' | 'REQUESTED' | 'UPHELD' | 'OVERTURNED';

  @Column({ type: 'text', nullable: true })
  appealNotes: string | null;

  @Column({ default: false })
  finalPayoutDone: boolean;

  @Column({ default: 'OPEN' })
  status: 'PROPOSED' | 'OPEN' | 'AWAITING_RESPONSE' | 'DECIDED' | 'CLOSED' | 'DISMISSED';

  // ---- added by SupportModule ----
  /** auto-detector proposal awaiting a human to open it */
  @Column({ default: false })
  proposed: boolean;

  @Column({ type: 'varchar', nullable: true })
  subjectName: string | null;

  /** users.id of the subject (driver user / restaurant owner) for notices */
  @Column({ type: 'uuid', nullable: true })
  subjectUserId: string | null;

  @Column({ type: 'text', nullable: true })
  noticeBody: string | null;

  /** [{ type: 'NOTE'|'PHOTO'|'RATING'|'DOCUMENT'|'ORDER'|'TICKET', ref?, url?, note, addedById, at }] */
  @Column({ type: 'jsonb', default: [] })
  evidence: Record<string, any>[];

  @Column({ type: 'uuid', nullable: true })
  assignedToId: string | null;

  /** status of the subject before the decision (for reinstatement) */
  @Column({ type: 'varchar', nullable: true })
  previousStatus: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  appealRequestedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  appealDecidedAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  appealDecidedById: string | null;

  @MoneyColumn({ nullable: true })
  finalPayoutAmount: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  finalPayoutAt: Date | null;

  @Column({ type: 'jsonb', default: {} })
  meta: Record<string, any>;
}

/** Saved reply snippets for agents. */
@Entity('canned_replies')
export class CannedReply extends BaseEntity {
  @Column()
  title: string;

  @Column({ type: 'text' })
  body: string; // supports {{customerName}} {{orderCode}} {{agentName}} {{ticketNumber}}

  @Column({ type: 'enum', enum: TicketCategory, nullable: true })
  category: TicketCategory | null;

  /** who it suits: ANY | CUSTOMER | RESTAURANT | DRIVER */
  @Column({ type: 'varchar', default: 'ANY' })
  audience: string;

  @Index({ unique: true, where: '"shortcut" IS NOT NULL' })
  @Column({ type: 'varchar', nullable: true })
  shortcut: string | null; // e.g. /late

  @Column({ default: true })
  active: boolean;

  @Column({ default: 0 })
  usageCount: number;

  @Column({ type: 'uuid', nullable: true })
  createdById: string | null;
}

/** Live support chat session (one per chat; the conversation itself lives on the linked Ticket / TicketMessage rows). */
@Entity('chat_sessions')
@Index('uq_chat_sessions_one_open_per_user', ['requesterUserId'], { unique: true, where: `"status" IN ('WAITING','ACTIVE')` })
export class ChatSession extends BaseEntity {
  @Index()
  @Column({ type: 'uuid' })
  ticketId: string;

  @Index()
  @Column({ type: 'uuid' })
  requesterUserId: string;

  @Column({ type: 'varchar' })
  requesterType: 'CUSTOMER' | 'DRIVER';

  /** WAITING (queued) | ACTIVE (agent attached) | ENDED | MISSED (queue timeout, kept as ticket) */
  @Index()
  @Column({ type: 'varchar', default: 'WAITING' })
  status: 'WAITING' | 'ACTIVE' | 'ENDED' | 'MISSED';

  @Column({ type: 'varchar', default: 'OTHER' })
  topic: string;

  @Column({ type: 'uuid', nullable: true })
  orderId: string | null;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  agentId: string | null;

  /** first name only - the only agent identity requesters ever see */
  @Column({ type: 'varchar', nullable: true })
  agentFirstName: string | null;

  @Column({ type: 'timestamptz' })
  queuedAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  acceptedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  endedAt: Date | null;

  /** REQUESTER | AGENT | SYSTEM */
  @Column({ type: 'varchar', nullable: true })
  endedBy: string | null;

  /** REQUESTER_ENDED | AGENT_ENDED | IDLE | QUEUE_TIMEOUT */
  @Column({ type: 'varchar', nullable: true })
  endReason: string | null;

  /** seconds from queuedAt to acceptedAt */
  @Column({ type: 'int', nullable: true })
  waitSec: number | null;

  /** seconds from acceptedAt to the first agent message */
  @Column({ type: 'int', nullable: true })
  firstResponseSec: number | null;

  @Column({ type: 'timestamptz' })
  lastActivityAt: Date;

  @Column({ type: 'int', default: 0 })
  transferCount: number;

  @Column({ type: 'int', nullable: true })
  rating: number | null;

  @Column({ type: 'text', nullable: true })
  feedback: string | null;

  @Column({ type: 'jsonb', default: {} })
  meta: Record<string, any>;
}

/** Support agent availability for live chat. */
@Entity('agent_presence')
export class AgentPresence extends BaseEntity {
  @Index({ unique: true })
  @Column({ type: 'uuid' })
  userId: string;

  /** ONLINE | AWAY | OFFLINE */
  @Column({ type: 'varchar', default: 'OFFLINE' })
  status: 'ONLINE' | 'AWAY' | 'OFFLINE';

  /** overrides setting support.chat.maxConcurrentPerAgent */
  @Column({ type: 'int', nullable: true })
  maxConcurrentChats: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastHeartbeatAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  statusChangedAt: Date | null;
}
