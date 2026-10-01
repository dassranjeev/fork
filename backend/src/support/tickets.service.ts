import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Brackets, In, Repository } from 'typeorm';
import { CustomerProfile, DriverProfile, Order, Ticket, TicketMessage, User } from '../database/entities';
import { ActorType, NotificationChannel, TicketCategory, TicketStatus, TicketTier, UserType } from '../common/enums';
import { Events } from '../common/contracts';
import { AuthUser } from '../common/auth.types';
import { hasPermission } from '../common/guards';
import { pageMeta, PageQueryDto, like } from '../common/pagination';
import { Action, Module as Mod } from '../common/enums';
import { CodesService } from '../core/core.module';
import { SettingsService } from '../settings/settings.service';
import { NotificationsService, Audience } from '../notifications/notifications.service';
import { RealtimeService } from '../realtime/realtime.module';
import {
  ChargedTo,
  defaultPriority,
  OPEN_STATUSES,
  Priority,
  PRIORITY_WEIGHT,
  Requester,
  routeTier,
  SLA_FACTOR,
  TICKET_TRANSITIONS,
} from './support.constants';

export interface TicketActor {
  type: Requester | 'SYSTEM';
  id?: string | null;
  name?: string;
}

export interface CreateTicketInput {
  requesterType: Requester;
  requesterId?: string | null;
  subject: string;
  body?: string;
  category?: TicketCategory;
  orderId?: string | null;
  restaurantId?: string | null;
  driverId?: string | null;
  priority?: Priority;
  tier?: TicketTier;
  attachments?: string[];
  tags?: string[];
  source?: 'MANUAL' | 'SELF_SERVE' | 'AUTO' | 'CHAT';
  meta?: Record<string, any>;
  assignedToId?: string | null;
  /** account is flagged (fraud / refund frequency) -> Tier 2 */
  flaggedAccount?: boolean;
  /** extra system note stored as an internal message */
  systemNote?: string;
}

export interface TicketQuery extends PageQueryDto {
  status?: string;
  tier?: string;
  priority?: string;
  category?: string;
  assignee?: string; // uuid | me | unassigned
  slaBreached?: string;
  requesterType?: string;
  requesterId?: string;
  orderId?: string;
  orderCode?: string;
  restaurantId?: string;
  tag?: string;
  source?: string;
  from?: string;
  to?: string;
  open?: string; // 'true' = only open statuses
}

const AUDIENCE: Record<Requester, Audience> = { CUSTOMER: 'CUSTOMER', RESTAURANT: 'RESTAURANT', DRIVER: 'DRIVER', STAFF: 'ADMIN' };
const short = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n - 1)}...` : s);

/** Ticket lifecycle. Injectable from any module (`support/tickets.service.ts`). */
@Injectable()
export class TicketsService {
  private readonly logger = new Logger(TicketsService.name);

  constructor(
    private settings: SettingsService,
    private codes: CodesService,
    private notifications: NotificationsService,
    private rt: RealtimeService,
    private events: EventEmitter2,
    @InjectRepository(Ticket) readonly tickets: Repository<Ticket>,
    @InjectRepository(TicketMessage) readonly messages: Repository<TicketMessage>,
    @InjectRepository(Order) private orders: Repository<Order>,
    @InjectRepository(User) private users: Repository<User>,
    @InjectRepository(CustomerProfile) private profiles: Repository<CustomerProfile>,
    @InjectRepository(DriverProfile) private drivers: Repository<DriverProfile>,
  ) {}

  // ------------------------------------------------------------------ SLA
  slaDates(priority: Priority, from = new Date()) {
    const f = SLA_FACTOR[priority] ?? 1;
    const firstMin = this.settings.get<number>('support.slaFirstResponseMin', 15);
    const resHours = this.settings.get<number>('support.slaResolutionHours', 24);
    return {
      slaFirstResponseDueAt: new Date(from.getTime() + firstMin * f * 60_000),
      slaResolutionDueAt: new Date(from.getTime() + resHours * f * 3600_000),
    };
  }

  // ------------------------------------------------------------------ create
  async create(input: CreateTicketInput): Promise<Ticket> {
    const category = input.category ?? TicketCategory.OTHER;
    let restaurantId = input.restaurantId ?? null;
    let driverId = input.driverId ?? null;
    if (input.orderId) {
      const order = await this.orders.findOne({ where: { id: input.orderId } });
      if (!order) throw new NotFoundException('Order not found');
      restaurantId = restaurantId ?? order.restaurantId;
      driverId = driverId ?? order.driverId;
    }
    let flagged = !!input.flaggedAccount;
    if (!flagged && input.requesterType === 'CUSTOMER' && input.requesterId) {
      const p = await this.profiles.findOne({ where: { userId: input.requesterId } });
      flagged = !!p && (p.fraudFlag || p.isBlocked);
    }
    const routed = routeTier({ category, requesterType: input.requesterType, tags: input.tags, subject: input.subject, flaggedAccount: flagged, requestedTier: input.tier });
    const tier = input.tier === TicketTier.SELF_SERVE && routed.tier === TicketTier.TIER1 ? TicketTier.SELF_SERVE : routed.tier;
    const priority = input.priority ?? defaultPriority(category, tier);
    const now = new Date();
    const status = routed.reason && tier !== TicketTier.TIER1 ? TicketStatus.ESCALATED : TicketStatus.OPEN;
    const number = await this.codes.ticketNumber();
    const saved = await this.tickets.save(
      this.tickets.create({
        number,
        subject: input.subject.slice(0, 200),
        requesterType: input.requesterType,
        requesterId: input.requesterId ?? null,
        orderId: input.orderId ?? null,
        restaurantId,
        driverId,
        category,
        priority,
        status,
        tier,
        assignedToId: input.assignedToId ?? null,
        ...this.slaDates(priority, now),
        attachments: input.attachments ?? [],
        tags: [...new Set((input.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean))],
        source: input.source ?? 'MANUAL',
        meta: input.meta ?? {},
        escalatedAt: status === TicketStatus.ESCALATED ? now : null,
        escalationReason: status === TicketStatus.ESCALATED ? routed.reason : null,
        lastMessageAt: input.body ? now : null,
        lastMessageBy: input.body ? input.requesterType : null,
      }),
    );
    if (input.body) {
      await this.messages.save(this.messages.create({ ticketId: saved.id, senderType: input.requesterType, senderId: input.requesterId ?? null, body: input.body, attachments: input.attachments ?? [], internal: false }));
    }
    if (routed.reason) await this.sysNote(saved.id, `Routed to ${tier}: ${routed.reason}`);
    if (input.systemNote) await this.sysNote(saved.id, input.systemNote);
    this.events.emit(Events.TICKET_CREATED, { ticketId: saved.id, number, category, tier, orderId: saved.orderId, requesterType: saved.requesterType, requesterId: saved.requesterId, source: saved.source });
    this.publish(saved, 'created');
    if (input.source !== 'AUTO' && (priority === 'URGENT' || priority === 'HIGH' || tier !== TicketTier.TIER1)) {
      void this.notifications.notifyOps('ticket.update', { number, subject: saved.subject }, { ticketId: saved.id, tier, priority, event: 'created' }).catch(() => undefined);
    }
    return saved;
  }

  // ------------------------------------------------------------------ helpers
  async get(id: string): Promise<Ticket> {
    const t = await this.tickets.findOne({ where: { id } });
    if (!t) throw new NotFoundException('Ticket not found');
    return t;
  }

  /** Requester-scoped fetch (customer/restaurant/driver endpoints). */
  async getFor(id: string, type: Requester, scope: { userId?: string; restaurantIds?: string[]; driverId?: string }): Promise<Ticket> {
    const t = await this.get(id);
    let ok = t.requesterType === type;
    if (ok && type === 'CUSTOMER') ok = t.requesterId === scope.userId;
    if (ok && type === 'RESTAURANT') ok = t.requesterId === scope.userId || (!!t.restaurantId && !!scope.restaurantIds?.includes(t.restaurantId));
    if (ok && type === 'DRIVER') ok = t.requesterId === scope.userId || (!!scope.driverId && t.driverId === scope.driverId);
    if (!ok) throw new NotFoundException('Ticket not found');
    return t;
  }

  async sysNote(ticketId: string, body: string, internal = true) {
    await this.messages.save(this.messages.create({ ticketId, senderType: 'SYSTEM', senderId: null, body, attachments: [], internal }));
  }

  /** realtime `ticket.updated` to requester (user room) and admin:ops */
  publish(t: Ticket, event: string, extra: Record<string, any> = {}) {
    const payload = { ticketId: t.id, number: t.number, status: t.status, tier: t.tier, priority: t.priority, assignedToId: t.assignedToId, slaBreached: t.slaBreached, event, at: new Date(), ...extra };
    const { internalBody: _hidden, ...publicPayload } = payload as any;
    if (t.requesterId) this.rt.emitToUser(t.requesterId, 'ticket.updated', publicPayload);
    if (t.requesterType === 'RESTAURANT' && t.restaurantId) this.rt.emitToRestaurant(t.restaurantId, 'ticket.updated', publicPayload);
    this.rt.emitToOps('ticket.updated', payload);
  }

  private async notifyRequester(t: Ticket, body: string) {
    if (!t.requesterId || t.requesterType === 'STAFF') return;
    await this.notifications.notify({
      userId: t.requesterId,
      audience: AUDIENCE[t.requesterType],
      event: 'ticket.update',
      title: 'Support update - {{number}}',
      body: '{{text}}',
      vars: { number: t.number, text: short(body) },
      data: { ticketId: t.id, number: t.number, status: t.status },
      channels: [NotificationChannel.PUSH, NotificationChannel.IN_APP],
    });
  }

  private async save(t: Ticket, patch: Partial<Ticket>) {
    Object.assign(t, patch);
    return this.tickets.save(t);
  }

  private assertTransition(from: TicketStatus, to: TicketStatus) {
    if (from === to) return;
    if (!TICKET_TRANSITIONS[from].includes(to)) throw new BadRequestException(`Cannot move ticket from ${from} to ${to}`);
  }

  // ------------------------------------------------------------------ permissions by tier
  canHandleTier(user: AuthUser, tier: TicketTier): boolean {
    if (user.type === UserType.SUPER_ADMIN) return true;
    if (tier === TicketTier.TIER2) return hasPermission(user, Mod.SUPPORT, Action.APPROVE);
    if (tier === TicketTier.FINANCE) return hasPermission(user, Mod.FINANCE, Action.VIEW) && hasPermission(user, Mod.SUPPORT, Action.EDIT);
    return hasPermission(user, Mod.SUPPORT, Action.EDIT);
  }

  private async staffCanHandle(userId: string, tier: TicketTier): Promise<boolean> {
    const u = await this.users.findOne({ where: { id: userId }, relations: { role: true } });
    if (!u) return false;
    if (u.type === UserType.SUPER_ADMIN) return true;
    if (u.type !== UserType.STAFF) return false;
    const perms = u.role?.permissions ?? {};
    const has = (m: string, a: string) => !!perms[m]?.includes(a);
    if (tier === TicketTier.TIER2) return has(Mod.SUPPORT, Action.APPROVE);
    if (tier === TicketTier.FINANCE) return has(Mod.FINANCE, Action.VIEW) && has(Mod.SUPPORT, Action.EDIT);
    return has(Mod.SUPPORT, Action.EDIT);
  }

  // ------------------------------------------------------------------ messages
  async addMessage(ticketId: string, actor: TicketActor, input: { body: string; internal?: boolean; attachments?: string[] }) {
    const t = await this.get(ticketId);
    if (t.status === TicketStatus.CLOSED && actor.type !== 'STAFF') throw new BadRequestException('This ticket is closed. Reopen it to continue.');
    const internal = !!input.internal && actor.type === 'STAFF';
    const msg = await this.messages.save(
      this.messages.create({ ticketId, senderType: actor.type, senderId: actor.id ?? null, body: input.body, attachments: input.attachments ?? [], internal }),
    );
    const patch: Partial<Ticket> = {};
    if (input.attachments?.length && actor.type === t.requesterType) patch.attachments = [...new Set([...(t.attachments ?? []), ...input.attachments])];
    if (!internal) {
      patch.lastMessageAt = new Date();
      patch.lastMessageBy = actor.type;
      if (actor.type === 'STAFF' || actor.type === 'SYSTEM') {
        if (!t.firstResponseAt && actor.type === 'STAFF') patch.firstResponseAt = new Date();
        if (actor.type === 'STAFF' && t.status === TicketStatus.OPEN) patch.status = TicketStatus.PENDING; // waiting on requester
      } else if (t.status === TicketStatus.PENDING || t.status === TicketStatus.RESOLVED) {
        patch.status = TicketStatus.OPEN;
        if (t.status === TicketStatus.RESOLVED) {
          patch.reopenCount = t.reopenCount + 1;
          patch.resolvedAt = null;
          Object.assign(patch, this.slaDates(t.priority));
          patch.slaBreached = false;
        }
      }
    }
    await this.save(t, patch);
    this.publish(t, internal ? 'note' : 'message', internal ? {} : { message: this.publicMessage(msg) });
    if (!internal && actor.type === 'STAFF') await this.notifyRequester(t, input.body);
    return msg;
  }

  publicMessage(m: TicketMessage) {
    return { id: m.id, senderType: m.senderType, senderId: m.senderId, body: m.body, attachments: m.attachments, createdAt: m.createdAt };
  }

  async listMessages(ticketId: string, includeInternal: boolean) {
    const rows = await this.messages.find({ where: { ticketId, ...(includeInternal ? {} : { internal: false }) }, order: { createdAt: 'ASC' } });
    return rows.map((m) => (includeInternal ? { ...this.publicMessage(m), internal: m.internal } : this.publicMessage(m)));
  }

  // ------------------------------------------------------------------ assignment
  async assign(ticketId: string, assigneeId: string | null, actor: AuthUser) {
    const t = await this.get(ticketId);
    if (t.status === TicketStatus.CLOSED) throw new BadRequestException('Ticket is closed');
    if (assigneeId) {
      if (assigneeId === actor.id) {
        if (!this.canHandleTier(actor, t.tier)) throw new ForbiddenException(`Your role cannot handle ${t.tier} tickets - escalate or ask a supervisor`);
      } else if (!(await this.staffCanHandle(assigneeId, t.tier))) {
        throw new BadRequestException(`Assignee cannot handle ${t.tier} tickets`);
      }
    }
    const patch: Partial<Ticket> = { assignedToId: assigneeId };
    if (assigneeId && t.status === TicketStatus.ESCALATED) patch.status = TicketStatus.OPEN; // picked up by the higher tier
    await this.save(t, patch);
    await this.sysNote(t.id, assigneeId ? `Assigned to ${assigneeId === actor.id ? actor.name : assigneeId} by ${actor.name}` : `Unassigned by ${actor.name}`);
    this.publish(t, 'assigned');
    return t;
  }

  // ------------------------------------------------------------------ status changes
  async escalate(ticketId: string, actor: TicketActor, input: { tier?: TicketTier; reason: string }) {
    const t = await this.get(ticketId);
    if (t.status === TicketStatus.CLOSED) throw new BadRequestException('Ticket is closed');
    const order = [TicketTier.SELF_SERVE, TicketTier.TIER1, TicketTier.TIER2, TicketTier.FINANCE];
    const target = input.tier ?? (t.tier === TicketTier.SELF_SERVE ? TicketTier.TIER1 : t.tier === TicketTier.TIER1 ? TicketTier.TIER2 : t.tier);
    if (target === TicketTier.SELF_SERVE) throw new BadRequestException('Cannot escalate down to SELF_SERVE');
    if (target === t.tier && t.status === TicketStatus.ESCALATED) throw new ConflictException('Already escalated to this tier');
    const priority = PRIORITY_WEIGHT[t.priority] < PRIORITY_WEIGHT.HIGH ? 'HIGH' : t.priority;
    const patch: Partial<Ticket> = { tier: target, status: TicketStatus.ESCALATED, escalatedAt: new Date(), escalationReason: input.reason, assignedToId: null, priority };
    if (priority !== t.priority) Object.assign(patch, this.slaDates(priority as Priority));
    if (t.status === TicketStatus.RESOLVED) patch.resolvedAt = null;
    await this.save(t, patch);
    await this.sysNote(t.id, `Escalated ${order.indexOf(target) >= order.indexOf(t.tier) ? 'to' : 'back to'} ${target} by ${actor.name ?? actor.type}: ${input.reason}`);
    this.publish(t, 'escalated', { reason: input.reason });
    void this.notifications.notifyOps('ticket.update', { number: t.number, subject: `Escalated to ${target}: ${t.subject}` }, { ticketId: t.id, tier: target, event: 'escalated' }).catch(() => undefined);
    return t;
  }

  /** SOP-06 step 3: reason code and charged party are mandatory. */
  async resolve(ticketId: string, actor: TicketActor, input: { reasonCode: string; chargedTo: ChargedTo; resolution?: string; message?: string; autoResolved?: boolean }) {
    if (!input.reasonCode?.trim()) throw new BadRequestException('reasonCode is required to resolve a ticket');
    if (!['RESTAURANT', 'PLATFORM', 'DRIVER'].includes(input.chargedTo)) throw new BadRequestException('chargedTo (RESTAURANT | PLATFORM | DRIVER) is required to resolve a ticket');
    const t = await this.get(ticketId);
    this.assertTransition(t.status, TicketStatus.RESOLVED);
    if (t.status === TicketStatus.RESOLVED) throw new ConflictException('Ticket already resolved');
    const patch: Partial<Ticket> = {
      status: TicketStatus.RESOLVED,
      resolvedAt: new Date(),
      reasonCode: input.reasonCode.trim().toUpperCase(),
      chargedTo: input.chargedTo,
      resolution: input.resolution ?? t.resolution,
      autoResolved: !!input.autoResolved,
    };
    if (!t.firstResponseAt && actor.type === 'STAFF') patch.firstResponseAt = new Date();
    if (!t.slaBreached && t.slaResolutionDueAt && patch.resolvedAt! > t.slaResolutionDueAt) {
      patch.slaBreached = true;
      patch.slaBreachType = t.slaBreachType ?? 'RESOLUTION';
    }
    await this.save(t, patch);
    await this.sysNote(t.id, `Resolved by ${actor.name ?? actor.type}: reason ${patch.reasonCode}, charged to ${input.chargedTo}${input.resolution ? ` - ${input.resolution}` : ''}`);
    if (input.message) await this.addMessage(t.id, actor.type === 'SYSTEM' ? { type: 'SYSTEM' } : actor, { body: input.message });
    this.publish(t, 'resolved');
    if (actor.type !== 'SYSTEM' || !input.message) await this.notifyRequester(t, `Your ticket ${t.number} was resolved. Please confirm or reply if you still need help.`);
    return this.get(t.id);
  }

  async close(ticketId: string, actor: TicketActor, note?: string) {
    const t = await this.get(ticketId);
    if (t.status === TicketStatus.CLOSED) return t;
    if (t.status !== TicketStatus.RESOLVED) {
      // closing an unresolved ticket requires the resolve fields first
      throw new BadRequestException('Resolve the ticket (reason code + charged party) before closing it');
    }
    await this.save(t, { status: TicketStatus.CLOSED, closedAt: new Date() });
    await this.sysNote(t.id, `Closed by ${actor.name ?? actor.type}${note ? `: ${note}` : ''}`);
    this.publish(t, 'closed');
    return t;
  }

  async reopen(ticketId: string, actor: TicketActor, reason?: string) {
    const t = await this.get(ticketId);
    if (t.status !== TicketStatus.RESOLVED && t.status !== TicketStatus.CLOSED) throw new BadRequestException('Only resolved or closed tickets can be reopened');
    const patch: Partial<Ticket> = { status: TicketStatus.OPEN, resolvedAt: null, closedAt: null, reopenCount: t.reopenCount + 1, slaBreached: false, slaBreachType: null, slaBreachNotifiedAt: null, ...this.slaDates(t.priority) };
    // an automated decision the customer disputes goes to a person
    if (t.tier === TicketTier.SELF_SERVE) patch.tier = TicketTier.TIER1;
    if (t.firstResponseAt && t.autoResolved) patch.firstResponseAt = null;
    await this.save(t, patch);
    await this.sysNote(t.id, `Reopened by ${actor.name ?? actor.type}${reason ? `: ${reason}` : ''}${t.autoResolved ? ' (customer asked for a person to review an automatic decision)' : ''}`);
    this.publish(t, 'reopened');
    if (actor.type !== 'STAFF') void this.notifications.notifyOps('ticket.update', { number: t.number, subject: `Reopened: ${t.subject}` }, { ticketId: t.id, event: 'reopened' }).catch(() => undefined);
    return t;
  }

  async setStatus(ticketId: string, actor: TicketActor, to: TicketStatus.OPEN | TicketStatus.PENDING) {
    const t = await this.get(ticketId);
    this.assertTransition(t.status, to);
    await this.save(t, { status: to });
    await this.sysNote(t.id, `Status set to ${to} by ${actor.name ?? actor.type}`);
    this.publish(t, 'status');
    return t;
  }

  async update(ticketId: string, actor: TicketActor, patch: { priority?: Priority; tags?: string[]; category?: TicketCategory; subject?: string; addAttachments?: string[] }) {
    const t = await this.get(ticketId);
    const p: Partial<Ticket> = {};
    if (patch.subject) p.subject = patch.subject.slice(0, 200);
    if (patch.category) p.category = patch.category;
    if (patch.tags) p.tags = [...new Set(patch.tags.map((x) => x.trim().toLowerCase()).filter(Boolean))];
    if (patch.addAttachments?.length) p.attachments = [...new Set([...(t.attachments ?? []), ...patch.addAttachments])];
    if (patch.priority && patch.priority !== t.priority) {
      p.priority = patch.priority;
      if (!t.firstResponseAt) p.slaFirstResponseDueAt = this.slaDates(patch.priority, t.createdAt).slaFirstResponseDueAt;
      p.slaResolutionDueAt = this.slaDates(patch.priority, t.createdAt).slaResolutionDueAt;
    }
    await this.save(t, p);
    // retagging can trigger the escalation rules (fraud/dispute/ban -> Tier 2, chargeback/... -> Finance)
    if (patch.tags || patch.category) {
      const r = routeTier({ category: t.category, requesterType: t.requesterType, tags: t.tags, subject: t.subject });
      const rank = { SELF_SERVE: 0, TIER1: 1, TIER2: 2, FINANCE: 3 } as Record<string, number>;
      if (r.reason && rank[r.tier] > rank[t.tier] && OPEN_STATUSES.includes(t.status)) await this.escalate(t.id, actor, { tier: r.tier, reason: r.reason });
    }
    await this.sysNote(t.id, `Updated by ${actor.name ?? actor.type}: ${Object.keys(patch).join(', ')}`);
    this.publish(t, 'updated');
    return this.get(t.id);
  }

  /** CSAT from the requester after resolution. */
  async rate(ticketId: string, requesterId: string, csat: number, comment?: string) {
    if (!Number.isInteger(csat) || csat < 1 || csat > 5) throw new BadRequestException('csat must be 1-5');
    const t = await this.get(ticketId);
    if (t.requesterId !== requesterId) throw new NotFoundException('Ticket not found');
    if (t.status !== TicketStatus.RESOLVED && t.status !== TicketStatus.CLOSED) throw new BadRequestException('You can rate a ticket once it is resolved');
    await this.save(t, { csat, csatComment: comment ?? null });
    this.publish(t, 'csat', { csat });
    return t;
  }

  /** Requester confirms the outcome -> closed (SOP-06 step 4). */
  async confirm(ticketId: string, requesterId: string, csat?: number, comment?: string) {
    const t = await this.get(ticketId);
    if (t.requesterId !== requesterId) throw new NotFoundException('Ticket not found');
    if (t.status !== TicketStatus.RESOLVED) throw new BadRequestException('Ticket is not awaiting confirmation');
    if (csat) await this.rate(ticketId, requesterId, csat, comment);
    return this.close(ticketId, { type: t.requesterType, id: requesterId, name: 'Requester' }, 'confirmed by requester');
  }

  // ------------------------------------------------------------------ queue / lists
  applyFilters(qb: ReturnType<Repository<Ticket>['createQueryBuilder']>, q: TicketQuery, me?: AuthUser) {
    const list = (v?: string) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
    if (q.status) qb.andWhere('t.status IN (:...st)', { st: list(q.status) });
    if (q.open === 'true') qb.andWhere('t.status IN (:...ost)', { ost: OPEN_STATUSES });
    if (q.tier) qb.andWhere('t.tier IN (:...tier)', { tier: list(q.tier) });
    if (q.priority) qb.andWhere('t.priority IN (:...pr)', { pr: list(q.priority) });
    if (q.category) qb.andWhere('t.category IN (:...cat)', { cat: list(q.category) });
    if (q.requesterType) qb.andWhere('t.requesterType IN (:...rt)', { rt: list(q.requesterType) });
    if (q.requesterId) qb.andWhere('t.requesterId = :rid', { rid: q.requesterId });
    if (q.restaurantId) qb.andWhere('t.restaurantId = :rest', { rest: q.restaurantId });
    if (q.source) qb.andWhere('t.source = :src', { src: q.source });
    if (q.slaBreached === 'true' || q.slaBreached === 'false') qb.andWhere('t.slaBreached = :sb', { sb: q.slaBreached === 'true' });
    if (q.assignee === 'unassigned') qb.andWhere('t.assignedToId IS NULL');
    else if (q.assignee === 'me' && me) qb.andWhere('t.assignedToId = :me', { me: me.id });
    else if (q.assignee) qb.andWhere('t.assignedToId = :asg', { asg: q.assignee });
    if (q.orderId) qb.andWhere('t.orderId = :oid', { oid: q.orderId });
    if (q.orderCode) qb.andWhere('t.orderId IN (SELECT o.id FROM orders o WHERE o.code ILIKE :oc)', { oc: like(q.orderCode) });
    if (q.tag) qb.andWhere('t.tags @> :tag::jsonb', { tag: JSON.stringify([q.tag.toLowerCase()]) });
    if (q.from) qb.andWhere('t.createdAt >= :from', { from: q.from });
    if (q.to) qb.andWhere('t.createdAt <= :to', { to: q.to });
    if (q.search) {
      const s = like(q.search);
      qb.andWhere(
        new Brackets((b) =>
          b
            .where('t.number ILIKE :s', { s })
            .orWhere('t.subject ILIKE :s', { s })
            .orWhere('t.orderId IN (SELECT o.id FROM orders o WHERE o.code ILIKE :s)', { s })
            .orWhere('t.requesterId IN (SELECT u.id FROM users u WHERE u.email ILIKE :s OR u."firstName" ILIKE :s OR u."lastName" ILIKE :s OR u.phone ILIKE :s)', { s }),
        ),
      );
    }
    return qb;
  }

  /** Enrich ticket rows with requester / assignee / order code for list screens. */
  async decorate(rows: Ticket[]) {
    const userIds = [...new Set(rows.flatMap((t) => [t.requesterId, t.assignedToId]).filter((x): x is string => !!x))];
    const orderIds = [...new Set(rows.map((t) => t.orderId).filter((x): x is string => !!x))];
    const [users, orders] = await Promise.all([
      userIds.length ? this.users.find({ where: { id: In(userIds) } }) : [],
      orderIds.length ? this.orders.find({ where: { id: In(orderIds) }, select: ['id', 'code', 'status', 'total'] }) : [],
    ]);
    const um = new Map<string, User>(users.map((u): [string, User] => [u.id, u]));
    const om = new Map<string, Order>(orders.map((o): [string, Order] => [o.id, o]));
    const nm = (u?: User) => (u ? `${u.firstName} ${u.lastName}`.trim() || u.email : null);
    return rows.map((t) => ({
      ...t,
      requesterName: t.requesterId ? nm(um.get(t.requesterId)) : null,
      requesterEmail: t.requesterId ? um.get(t.requesterId)?.email ?? null : null,
      assigneeName: t.assignedToId ? nm(um.get(t.assignedToId)) : null,
      orderCode: t.orderId ? om.get(t.orderId)?.code ?? null : null,
      orderStatus: t.orderId ? om.get(t.orderId)?.status ?? null : null,
    }));
  }

  async queue(q: TicketQuery, me?: AuthUser) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 20;
    const qb = this.applyFilters(this.tickets.createQueryBuilder('t'), q, me);
    const sortable: Record<string, string> = { createdAt: 't.createdAt', updatedAt: 't.updatedAt', priority: 't.priority', status: 't.status', number: 't.number', slaResolutionDueAt: 't.slaResolutionDueAt', slaFirstResponseDueAt: 't.slaFirstResponseDueAt' };
    if (q.sortBy && sortable[q.sortBy]) {
      qb.orderBy(sortable[q.sortBy], (q.sortDir ?? 'DESC').toUpperCase() as 'ASC' | 'DESC');
    } else {
      // default work queue: SLA breached first, then priority, then oldest
      qb.orderBy('t.slaBreached', 'DESC')
        .addOrderBy(`CASE t.priority WHEN 'URGENT' THEN 4 WHEN 'HIGH' THEN 3 WHEN 'NORMAL' THEN 2 ELSE 1 END`, 'DESC')
        .addOrderBy('t.createdAt', 'ASC');
    }
    const [rows, total] = await qb.skip((page - 1) * limit).take(limit).getManyAndCount();
    return { data: await this.decorate(rows), meta: pageMeta(total, page, limit) };
  }

  async counts(me: AuthUser) {
    const rows: { status: string; tier: string; n: string }[] = await this.tickets.createQueryBuilder('t').select('t.status', 'status').addSelect('t.tier', 'tier').addSelect('COUNT(*)', 'n').groupBy('t.status').addGroupBy('t.tier').getRawMany();
    const byStatus: Record<string, number> = {};
    const openByTier: Record<string, number> = {};
    for (const r of rows) {
      byStatus[r.status] = (byStatus[r.status] ?? 0) + Number(r.n);
      if (OPEN_STATUSES.includes(r.status as TicketStatus)) openByTier[r.tier] = (openByTier[r.tier] ?? 0) + Number(r.n);
    }
    const open = OPEN_STATUSES;
    const [unassigned, breached, mine] = await Promise.all([
      this.tickets.createQueryBuilder('t').where('t.status IN (:...o) AND t.assignedToId IS NULL', { o: open }).getCount(),
      this.tickets.createQueryBuilder('t').where('t.status IN (:...o) AND t.slaBreached = true', { o: open }).getCount(),
      this.tickets.createQueryBuilder('t').where('t.status IN (:...o) AND t.assignedToId = :me', { o: open, me: me.id }).getCount(),
    ]);
    return { byStatus, openByTier, unassigned, slaBreached: breached, mine };
  }

  /** Requester-side list (customer / restaurant / driver apps). */
  async listForRequester(type: Requester, scope: { userId: string; restaurantIds?: string[]; driverId?: string }, q: PageQueryDto & { status?: string; open?: string }) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 20;
    const qb = this.tickets.createQueryBuilder('t').where('t.requesterType = :type', { type });
    if (type === 'CUSTOMER') qb.andWhere('t.requesterId = :uid', { uid: scope.userId });
    else if (type === 'RESTAURANT') qb.andWhere(new Brackets((b) => b.where('t.requesterId = :uid', { uid: scope.userId }).orWhere(scope.restaurantIds?.length ? 't.restaurantId IN (:...rids)' : '1=0', { rids: scope.restaurantIds })));
    else qb.andWhere(new Brackets((b) => b.where('t.requesterId = :uid', { uid: scope.userId }).orWhere(scope.driverId ? 't.driverId = :did' : '1=0', { did: scope.driverId })));
    if (q.status) qb.andWhere('t.status IN (:...st)', { st: q.status.split(',') });
    if (q.open === 'true') qb.andWhere('t.status IN (:...ost)', { ost: OPEN_STATUSES });
    if (q.search) qb.andWhere('(t.number ILIKE :s OR t.subject ILIKE :s)', { s: like(q.search) });
    qb.orderBy('t.updatedAt', 'DESC');
    const [rows, total] = await qb.skip((page - 1) * limit).take(limit).getManyAndCount();
    const dec = await this.decorate(rows);
    return { data: dec.map((t) => this.requesterView(t)), meta: pageMeta(total, page, limit) };
  }

  /** What a requester may see of a ticket (no internal fields). */
  requesterView(t: any) {
    return {
      id: t.id,
      number: t.number,
      subject: t.subject,
      category: t.category,
      status: t.status,
      orderId: t.orderId,
      orderCode: t.orderCode ?? null,
      autoResolved: t.autoResolved,
      resolution: t.resolution,
      resolvedAt: t.resolvedAt,
      csat: t.csat,
      attachments: t.attachments,
      lastMessageAt: t.lastMessageAt,
      lastMessageBy: t.lastMessageBy,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      canConfirm: t.status === TicketStatus.RESOLVED,
      canReopen: t.status === TicketStatus.RESOLVED || t.status === TicketStatus.CLOSED,
    };
  }

  async requesterDetail(t: Ticket) {
    const [dec] = await this.decorate([t]);
    return { ...this.requesterView(dec), messages: await this.listMessages(t.id, false) };
  }

  async agents() {
    const staff = await this.users.find({ where: { type: In([UserType.STAFF, UserType.SUPER_ADMIN]) }, relations: { role: true } });
    const eligible = staff.filter((u) => u.status === 'ACTIVE' && (u.type === UserType.SUPER_ADMIN || u.role?.permissions?.[Mod.SUPPORT]?.includes(Action.EDIT)));
    const loads: { id: string; n: string; b: string }[] = await this.tickets
      .createQueryBuilder('t')
      .select('t.assignedToId', 'id')
      .addSelect('COUNT(*)', 'n')
      .addSelect('SUM(CASE WHEN t.slaBreached THEN 1 ELSE 0 END)', 'b')
      .where('t.status IN (:...o) AND t.assignedToId IS NOT NULL', { o: OPEN_STATUSES })
      .groupBy('t.assignedToId')
      .getRawMany();
    const lm = new Map(loads.map((l) => [l.id, l]));
    return eligible.map((u) => ({
      id: u.id,
      name: `${u.firstName} ${u.lastName}`.trim() || u.email,
      email: u.email,
      role: u.type === UserType.SUPER_ADMIN ? 'Super Admin' : u.role?.name ?? null,
      canHandleTier2: u.type === UserType.SUPER_ADMIN || !!u.role?.permissions?.[Mod.SUPPORT]?.includes(Action.APPROVE),
      canHandleFinance: u.type === UserType.SUPER_ADMIN || (!!u.role?.permissions?.[Mod.FINANCE]?.includes(Action.VIEW)),
      refundLimit: u.type === UserType.SUPER_ADMIN ? null : u.role?.refundLimit ?? 0,
      openTickets: Number(lm.get(u.id)?.n ?? 0),
      slaBreached: Number(lm.get(u.id)?.b ?? 0),
    }));
  }

  actorFromStaff(u: AuthUser): TicketActor {
    return { type: 'STAFF', id: u.id, name: u.name };
  }

  actorType(t: Requester): ActorType {
    return t as unknown as ActorType;
  }
}
