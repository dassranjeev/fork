import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntity } from '../../common/base.entity';

/** Non-editable audit log. A DB trigger (see AuditModule.onModuleInit) blocks UPDATE/DELETE. Retain 7 years. */
@Entity('audit_logs')
@Index(['entity', 'entityId'])
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  actorId: string | null;

  @Column({ type: 'varchar', nullable: true })
  actorEmail: string | null;

  @Column({ type: 'varchar', nullable: true })
  actorType: string | null;

  @Column({ type: 'varchar', nullable: true })
  actorRole: string | null;

  /** e.g. restaurant.approve, order.refund, role.update, auth.login */
  @Index()
  @Column()
  action: string;

  @Column({ type: 'varchar', nullable: true })
  entity: string | null;

  @Column({ type: 'varchar', nullable: true })
  entityId: string | null;

  @Column({ type: 'jsonb', nullable: true })
  before: Record<string, any> | null;

  @Column({ type: 'jsonb', nullable: true })
  after: Record<string, any> | null;

  @Column({ type: 'varchar', nullable: true })
  ip: string | null;

  @Column({ type: 'varchar', nullable: true })
  userAgent: string | null;

  @Column({ type: 'varchar', nullable: true })
  path: string | null;

  @Column({ type: 'varchar', nullable: true })
  method: string | null;
}

/** Key/value platform settings. group: general | payments | maps | notifications | taxes | languages | security ... */
@Entity('settings')
export class Setting extends BaseEntity {
  @Index({ unique: true })
  @Column()
  key: string;

  @Column({ type: 'jsonb', nullable: true })
  value: any;

  @Column({ default: 'general' })
  group: string;

  @Column({ type: 'varchar', nullable: true })
  label: string | null;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  /** secrets (API keys) are masked in API responses */
  @Column({ default: false })
  isSecret: boolean;

  /** ui hint: text | number | boolean | json | select | password | textarea */
  @Column({ default: 'text' })
  inputType: string;

  /** exposed to apps through GET /public/config */
  @Column({ default: false })
  isPublic: boolean;
}

@Entity('feature_flags')
export class FeatureFlag extends BaseEntity {
  @Index({ unique: true })
  @Column()
  key: string;

  @Column({ default: false })
  enabled: boolean;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  /** 0-100 percent rollout */
  @Column({ default: 100 })
  rolloutPct: number;

  /** limit to these cities (empty = all) */
  @Column({ type: 'jsonb', default: [] })
  cityIds: string[];
}

/** Minimum / latest app versions - drives force-update in mobile apps. */
@Entity('app_versions')
@Index(['app', 'platform'], { unique: true })
export class AppVersion extends BaseEntity {
  @Column({ type: 'varchar' })
  app: 'customer' | 'driver' | 'restaurant';

  @Column({ type: 'varchar' })
  platform: 'ios' | 'android';

  @Column({ default: '1.0.0' })
  minVersion: string;

  @Column({ default: '1.0.0' })
  latestVersion: string;

  @Column({ default: false })
  forceUpdate: boolean;

  @Column({ type: 'varchar', nullable: true })
  storeUrl: string | null;

  @Column({ type: 'text', nullable: true })
  releaseNotes: string | null;
}

/** SOP-10 incident tracking + in-app status banner. */
@Entity('incidents')
export class Incident extends BaseEntity {
  @Column()
  title: string;

  @Column({ type: 'varchar' })
  severity: 'P1' | 'P2' | 'P3';

  @Column({ default: 'OPEN' })
  status: 'OPEN' | 'MITIGATED' | 'RESOLVED';

  @Column({ type: 'text', nullable: true })
  description: string | null;

  /** if set, shown as a status banner in all apps */
  @Column({ type: 'varchar', nullable: true })
  bannerMessage: string | null;

  @Column({ default: false })
  bannerActive: boolean;

  @Column({ default: false })
  pauseNewOrders: boolean;

  @Column({ type: 'jsonb', default: [] })
  timeline: { at: string; by?: string; note: string }[];

  @Column({ type: 'timestamptz', nullable: true })
  resolvedAt: Date | null;

  @Column({ type: 'text', nullable: true })
  postIncidentReport: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  reportDueAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  ownerId: string | null;
}

/** SOP-03 daily operations open / close checklist. */
@Entity('ops_checklists')
@Index(['date', 'kind', 'cityId'], { unique: true })
export class OpsChecklist extends BaseEntity {
  @Column({ type: 'date' })
  date: string;

  @Column({ type: 'varchar' })
  kind: 'OPEN' | 'CLOSE';

  @Column({ type: 'uuid', nullable: true })
  cityId: string | null;

  /** [{ key, label, done, doneAt, doneBy }] */
  @Column({ type: 'jsonb', default: [] })
  items: { key: string; label: string; done: boolean; doneAt?: string; doneBy?: string }[];

  @Column({ type: 'text', nullable: true })
  notes: string | null;

  @Column({ type: 'uuid', nullable: true })
  completedById: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  completedAt: Date | null;
}
