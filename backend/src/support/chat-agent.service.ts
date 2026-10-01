import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { In, MoreThan, Repository } from 'typeorm';
import { ChatSession, CustomerProfile, DriverProfile, Order, Ticket, User } from '../database/entities';
import { Action, Module as Mod, TicketStatus, TicketTier } from '../common/enums';
import { AuthUser } from '../common/auth.types';
import { hasPermission } from '../common/guards';
import { AuditService } from '../audit/audit.service';
import { TicketsService } from './tickets.service';
import { OrderContextService } from './order-context.service';
import { ChatService } from './chat.service';
import { ChatPresenceService } from './chat-presence.service';
import { ChatEndDto, ChatTransferDto } from './chat.dto';
import { fullName, maskPhone, prepareChatMessage } from './chat.util';

/** Agent-console side of live chat (`/admin/support/chat/*`). */
@Injectable()
export class ChatAgentService {
  private readonly logger = new Logger(ChatAgentService.name);

  constructor(
    private chat: ChatService,
    private presence: ChatPresenceService,
    private tickets: TicketsService,
    private orderContext: OrderContextService,
    private audit: AuditService,
    @InjectRepository(ChatSession) private sessions: Repository<ChatSession>,
    @InjectRepository(Order) private orders: Repository<Order>,
    @InjectRepository(User) private users: Repository<User>,
    @InjectRepository(CustomerProfile) private profiles: Repository<CustomerProfile>,
    @InjectRepository(DriverProfile) private drivers: Repository<DriverProfile>,
  ) {}

  private async load(id: string): Promise<ChatSession> {
    const s = /^[0-9a-f-]{36}$/i.test(id) ? await this.sessions.findOne({ where: { id } }) : null;
    if (!s) throw new NotFoundException('Chat not found');
    return s;
  }

  /** the assigned agent, or a supervisor (support:approve) / super admin */
  private assertCanAct(user: AuthUser, s: ChatSession) {
    if (s.agentId === user.id || hasPermission(user, Mod.SUPPORT, Action.APPROVE)) return;
    throw new ForbiddenException('This chat is handled by another agent');
  }

  private log(user: AuthUser | null, action: string, s: ChatSession, after?: any, before?: any) {
    void this.audit.log({ actor: user, action: `support.chat.${action}`, entity: 'chat_session', entityId: s.id, before, after });
  }

  // ------------------------------------------------------------------ lists
  async queue(user: AuthUser, status?: string) {
    const wanted = (status ? status.split(',') : ['WAITING', 'ACTIVE']).map((x) => x.trim().toUpperCase()).filter((x) => ['WAITING', 'ACTIVE', 'ENDED', 'MISSED'].includes(x));
    const day = new Date(Date.now() - 24 * 3600_000);
    const open = wanted.filter((x) => x === 'WAITING' || x === 'ACTIVE');
    const closed = wanted.filter((x) => x === 'ENDED' || x === 'MISSED');
    const rows: ChatSession[] = [];
    if (open.length) rows.push(...(await this.sessions.find({ where: { status: In(open) } })));
    if (closed.length) rows.push(...(await this.sessions.find({ where: { status: In(closed), endedAt: MoreThan(day) }, take: 100 })));
    const rank = (s: ChatSession) => (s.status === 'WAITING' ? 0 : s.status === 'ACTIVE' ? 1 : 2);
    rows.sort((a, b) => rank(a) - rank(b) || (rank(a) === 0 ? a.queuedAt.getTime() - b.queuedAt.getTime() : (b.lastActivityAt?.getTime() ?? 0) - (a.lastActivityAt?.getTime() ?? 0)));
    return { data: await this.chat.agentItems(rows, user.id), serverTime: new Date() };
  }

  async agents() {
    const list = await this.presence.eligibleAgents();
    return list.map((a) => ({ id: a.id, name: a.name, firstName: a.firstName, role: a.role, status: a.status, activeChats: a.load, maxConcurrentChats: a.max, canTier2: a.canTier2, canFinance: a.canFinance, lastHeartbeatAt: a.lastHeartbeatAt }));
  }

  async stats(user: AuthUser) {
    const today = `date_trunc('day', now())`;
    const q = (sql: string, params: any[] = []) => this.sessions.query(sql, params);
    const [[row], perAgent, agents] = await Promise.all([
      q(`SELECT
          COUNT(*) FILTER (WHERE status='WAITING')::int AS waiting,
          COUNT(*) FILTER (WHERE status='ACTIVE')::int AS active,
          COALESCE(EXTRACT(EPOCH FROM now() - MIN("queuedAt") FILTER (WHERE status='WAITING')),0)::int AS "longestWaitSec",
          COALESCE(ROUND(AVG("waitSec") FILTER (WHERE "acceptedAt" >= ${today})),0)::int AS "avgWaitSec",
          COALESCE(ROUND(AVG("firstResponseSec") FILTER (WHERE "queuedAt" >= ${today})),0)::int AS "avgFirstResponseSec",
          COUNT(*) FILTER (WHERE "queuedAt" >= ${today} AND "acceptedAt" IS NULL AND status IN ('ENDED','MISSED'))::int AS abandoned,
          COUNT(*) FILTER (WHERE "queuedAt" >= ${today})::int AS "startedToday",
          COUNT(*) FILTER (WHERE "endedAt" >= ${today} AND status='ENDED')::int AS "endedToday",
          ROUND(AVG(rating) FILTER (WHERE "queuedAt" >= ${today}),2)::float AS "avgRating"
        FROM chat_sessions`),
      q(`SELECT "agentId", COUNT(*)::int AS n FROM chat_sessions WHERE "acceptedAt" >= ${today} AND "agentId" IS NOT NULL GROUP BY "agentId"`),
      this.presence.eligibleAgents(),
    ]);
    const names = new Map(agents.map((a) => [a.id, a.name]));
    return {
      ...row,
      agentsOnline: agents.filter((a) => a.status === 'ONLINE').length,
      agentsAway: agents.filter((a) => a.status === 'AWAY').length,
      chatsPerAgentToday: perAgent.map((r: any) => ({ agentId: r.agentId, name: names.get(r.agentId) ?? 'Agent', chats: r.n })).sort((a: any, b: any) => b.chats - a.chats),
      me: await this.presence.mine(user.id),
    };
  }

  // ------------------------------------------------------------------ detail
  private async requesterSummary(s: ChatSession) {
    const u = await this.users.findOne({ where: { id: s.requesterUserId } });
    if (!u) return null;
    const base = { id: u.id, type: s.requesterType, name: fullName(u), email: u.email, phoneMasked: maskPhone(u.phone), memberSince: u.createdAt, language: u.language };
    if (s.requesterType === 'CUSTOMER') {
      const [p, orders] = await Promise.all([this.profiles.findOne({ where: { userId: u.id } }), this.orders.count({ where: { customerId: u.id } })]);
      return { ...base, orders, fraudFlag: !!p?.fraudFlag, blocked: !!p?.isBlocked };
    }
    const d = await this.drivers.findOne({ where: { userId: u.id } });
    const orders = d ? await this.orders.count({ where: { driverId: d.id } }) : 0;
    return { ...base, orders, driverProfileId: d?.id ?? null, driverStatus: d?.status ?? null, rating: d?.rating ?? null, vehicleType: d?.vehicleType ?? null };
  }

  /** Order context for the agent. Cross-party PII is trimmed: a driver chat never shows the customer's contact details or history, and vice versa. */
  private async contextFor(s: ChatSession) {
    if (!s.orderId) return null;
    const ctx: any = await this.orderContext.context(s.orderId);
    if (!ctx) return null;
    if (s.requesterType === 'DRIVER') {
      ctx.customer = ctx.customer ? { name: ctx.customer.name } : null;
      delete ctx.customerHistory;
      if (ctx.order) delete ctx.order.deliveryAddress;
    } else if (ctx.driver) {
      delete ctx.driver.phoneMasked;
    }
    return ctx;
  }

  async detail(user: AuthUser, id: string) {
    const s = await this.load(id);
    const [item] = await this.chat.agentItems([s], user.id);
    const [ticket, messages, orderContext, requester, prevSessions, prevTickets] = await Promise.all([
      this.tickets.get(s.ticketId),
      this.chat.messagesFor(s, { forAgent: true }),
      this.contextFor(s),
      this.requesterSummary(s),
      this.sessions.find({ where: { requesterUserId: s.requesterUserId }, order: { queuedAt: 'DESC' }, take: 6 }),
      this.tickets.tickets.find({ where: { requesterId: s.requesterUserId }, order: { createdAt: 'DESC' }, take: 8 }),
    ]);
    return {
      session: item,
      ticket: { id: ticket.id, number: ticket.number, status: ticket.status, tier: ticket.tier, priority: ticket.priority, category: ticket.category, assignedToId: ticket.assignedToId, slaBreached: ticket.slaBreached, tags: ticket.tags, csat: ticket.csat, resolution: ticket.resolution },
      messages,
      orderContext,
      requester,
      history: {
        chats: prevSessions.filter((x) => x.id !== s.id).map((x) => ({ id: x.id, ticketId: x.ticketId, status: x.status, topic: x.topic, queuedAt: x.queuedAt, rating: x.rating })),
        tickets: prevTickets.filter((t) => t.id !== s.ticketId).map((t) => ({ id: t.id, number: t.number, subject: t.subject, status: t.status, category: t.category, source: t.source, createdAt: t.createdAt })),
      },
    };
  }

  // ------------------------------------------------------------------ actions
  async accept(user: AuthUser, id: string) {
    const s = await this.load(id);
    if (s.status !== 'WAITING') throw new ConflictException(s.status === 'ACTIVE' ? 'Another agent already took this chat' : 'This chat is no longer waiting');
    const agent = await this.presence.agent(user.id);
    if (!agent) throw new ForbiddenException('You are not set up as a support agent');
    if (agent.status === 'OFFLINE') throw new ConflictException('Set your presence to Online before accepting chats');
    if (!this.presence.hasCapacity(agent)) throw new ConflictException(`You already have ${agent.load} active chats (max ${agent.max})`);
    const t = await this.tickets.get(s.ticketId);
    if (!this.presence.canHandle(agent, t.tier)) throw new ForbiddenException(`Your role cannot handle ${t.tier} chats`);
    if (!(await this.chat.claim(id, agent, 'accept'))) throw new ConflictException('Another agent already took this chat');
    return this.detail(user, id);
  }

  async reply(user: AuthUser, id: string, input: { body?: string; attachments?: string[] }) {
    const s = await this.load(id);
    if (s.status === 'MISSED') {
      // converted/offline chat: reply as a normal ticket message (requester is notified via push/email by the ticket flow)
      const { text, files } = prepareChatMessage(input.body, input.attachments, this.chat.publicBase);
      const m = await this.tickets.addMessage(s.ticketId, this.tickets.actorFromStaff(user), { body: text || 'Attachment', attachments: files });
      const v = await this.chat.fanout(s, m, false);
      await this.sessions.update(s.id, { lastActivityAt: new Date() });
      return v.agentView;
    }
    this.assertCanAct(user, s);
    if (s.status !== 'ACTIVE') throw new ConflictException(s.status === 'WAITING' ? 'Accept the chat before replying' : 'This chat has ended');
    return (await this.chat.post(s, { type: 'STAFF', id: user.id }, input)).agentView;
  }

  async note(user: AuthUser, id: string, body: string) {
    const s = await this.load(id);
    return (await this.chat.post(s, { type: 'STAFF', id: user.id }, { body, internal: true })).agentView;
  }

  async typing(user: AuthUser, id: string, typing: boolean) {
    const s = await this.load(id);
    if (s.agentId !== user.id || s.status !== 'ACTIVE') return { ok: true };
    this.chat.toRequester(s, 'chat.typing', { sessionId: s.id, by: 'AGENT', typing, agent: { firstName: s.agentFirstName } });
    this.chat.toAgents('chat.typing', { sessionId: s.id, by: 'AGENT', typing, agentId: user.id });
    return { ok: true };
  }

  async read(id: string) {
    return this.chat.markRead(await this.load(id), 'AGENT');
  }

  async transfer(user: AuthUser, id: string, dto: ChatTransferDto) {
    const s = await this.load(id);
    this.assertCanAct(user, s);
    if (s.status !== 'ACTIVE') throw new ConflictException('Only active chats can be transferred');
    if (!dto.agentId && !dto.tier) throw new BadRequestException('Provide agentId (another agent) or tier (TIER2 | FINANCE) to escalate');
    const before = { agentId: s.agentId };
    if (dto.agentId) {
      if (dto.agentId === s.agentId) throw new BadRequestException('Chat is already with this agent');
      const target = await this.presence.agent(dto.agentId);
      if (!target) throw new BadRequestException('That user cannot handle chats');
      if (target.status === 'OFFLINE') throw new ConflictException(`${target.name} is offline`);
      if (!this.presence.hasCapacity(target)) throw new ConflictException(`${target.name} is at capacity`);
      const t = await this.tickets.get(s.ticketId);
      if (!this.presence.canHandle(target, t.tier)) throw new BadRequestException(`${target.name} cannot handle ${t.tier} tickets`);
      await this.sessions.update(s.id, { agentId: target.id, agentFirstName: target.firstName, transferCount: s.transferCount + 1, lastActivityAt: new Date() });
      await this.tickets.tickets.update(t.id, { assignedToId: target.id });
      await this.tickets.sysNote(t.id, `Chat transferred from ${user.name} to ${target.name}${dto.reason ? `: ${dto.reason}` : ''}`);
      const fresh = await this.load(id);
      const text = `You are now chatting with ${target.firstName} from FORKSY Support.`;
      const sys = await this.chat.msgs.save(this.chat.msgs.create({ ticketId: s.ticketId, senderType: 'SYSTEM', senderId: null, body: text, attachments: [], internal: false }));
      this.chat.toRequester(fresh, 'chat.transferred', { sessionId: s.id, agent: { firstName: target.firstName }, status: 'ACTIVE' });
      this.chat.toRequester(fresh, 'chat.message', { sessionId: s.id, message: { id: sys.id, senderType: 'SYSTEM', senderName: null, body: text, attachments: [], createdAt: sys.createdAt, readAt: null } });
      this.chat.toAgents('chat.message', { sessionId: s.id, message: this.chat.agentMsg(sys, new Map()) });
      await this.chat.emitUpdated(fresh, { event: 'transferred', fromAgentId: user.id });
      this.log(user, 'transfer', s, { toAgentId: target.id, reason: dto.reason }, before);
    } else {
      const tier = dto.tier === 'FINANCE' ? TicketTier.FINANCE : TicketTier.TIER2;
      await this.tickets.escalate(s.ticketId, this.tickets.actorFromStaff(user), { tier, reason: dto.reason || `Live chat escalated to ${tier}` });
      await this.sessions.update(s.id, { status: 'WAITING', agentId: null, agentFirstName: null, acceptedAt: null, waitSec: null, transferCount: s.transferCount + 1 });
      const text = 'We are connecting you with a specialist. Please stay in the chat.';
      const sys = await this.chat.msgs.save(this.chat.msgs.create({ ticketId: s.ticketId, senderType: 'SYSTEM', senderId: null, body: text, attachments: [], internal: false }));
      const fresh = await this.load(id);
      const pos = await this.chat.queuePosition(fresh);
      this.chat.toRequester(fresh, 'chat.transferred', { sessionId: s.id, agent: null, status: 'WAITING', tier, queue: pos });
      this.chat.toRequester(fresh, 'chat.message', { sessionId: s.id, message: { id: sys.id, senderType: 'SYSTEM', senderName: null, body: text, attachments: [], createdAt: sys.createdAt, readAt: null } });
      this.chat.toAgents('chat.message', { sessionId: s.id, message: this.chat.agentMsg(sys, new Map()) });
      await this.chat.emitUpdated(fresh, { event: 'escalated', fromAgentId: user.id });
      this.log(user, 'escalate', s, { tier, reason: dto.reason }, before);
      await this.chat.broadcastQueue();
      void this.chat.dispatchWaiting().catch(() => undefined);
    }
    return this.detail(user, id);
  }

  async end(user: AuthUser, id: string, dto: ChatEndDto) {
    const s = await this.load(id);
    if (s.status !== 'ACTIVE' && s.status !== 'WAITING') return this.detail(user, id);
    if (s.status === 'ACTIVE') this.assertCanAct(user, s);
    if (dto.reasonCode && !dto.chargedTo) throw new BadRequestException('chargedTo is required together with reasonCode');
    await this.chat.finish(s, { by: 'AGENT', reason: 'AGENT_ENDED', message: dto.note ? `The agent ended the chat: ${dto.note}` : 'The agent ended the chat. Thanks for contacting FORKSY Support.' });
    if (dto.reasonCode && dto.chargedTo) {
      await this.tickets.resolve(s.ticketId, this.tickets.actorFromStaff(user), { reasonCode: dto.reasonCode, chargedTo: dto.chargedTo, resolution: dto.resolution });
    }
    this.log(user, 'end', s, { resolved: !!dto.reasonCode, note: dto.note });
    return this.detail(user, id);
  }

  /** Keep the conversation as an open ticket for follow-up (ends the live chat first when still running). */
  async convert(user: AuthUser, id: string) {
    const s = await this.load(id);
    if (s.status === 'ACTIVE') this.assertCanAct(user, s);
    if (s.status === 'ACTIVE' || s.status === 'WAITING') {
      await this.chat.finish(s, { by: 'AGENT', reason: 'CONVERTED', converted: true, message: 'We will continue this by ticket. Our team will reply by notification and email.' });
    }
    const t = await this.tickets.get(s.ticketId);
    if (t.status === TicketStatus.RESOLVED || t.status === TicketStatus.CLOSED) await this.tickets.reopen(t.id, this.tickets.actorFromStaff(user), 'Follow-up needed after live chat');
    await this.tickets.update(t.id, this.tickets.actorFromStaff(user), { tags: [...new Set([...(t.tags ?? []), 'chat-followup'])] });
    await this.tickets.tickets.update(t.id, { status: TicketStatus.OPEN, assignedToId: s.agentId ?? user.id });
    await this.sessions.createQueryBuilder().update(ChatSession).set({ meta: { ...(s.meta ?? {}), convertedToTicket: true } as any }).where('id = :id', { id: s.id }).execute();
    this.log(user, 'convert', s, { ticketId: t.id });
    return this.detail(user, id);
  }

  // ------------------------------------------------------------------ presence
  async setPresence(user: AuthUser, status: 'ONLINE' | 'AWAY' | 'OFFLINE', max?: number) {
    if (!(await this.presence.agent(user.id))) throw new ForbiddenException('You are not set up as a support agent');
    const r = await this.presence.set(user.id, status, max);
    this.log(user, 'presence', { id: user.id } as ChatSession, { status });
    if (status === 'ONLINE') void this.chat.dispatchWaiting().catch(() => undefined);
    return r;
  }

  async heartbeat(user: AuthUser) {
    await this.presence.heartbeat(user.id);
    return this.presence.mine(user.id);
  }

  // ------------------------------------------------------------------ socket client -> server
  @OnEvent('chat.socket.presence')
  async onSocketPresence(p: { userId: string; status: string }) {
    try {
      if (!['ONLINE', 'AWAY', 'OFFLINE'].includes(p.status) || !(await this.presence.agent(p.userId))) return;
      await this.presence.set(p.userId, p.status as 'ONLINE' | 'AWAY' | 'OFFLINE');
      if (p.status === 'ONLINE') await this.chat.dispatchWaiting();
    } catch (e: any) {
      this.logger.debug(`socket presence failed: ${e.message}`);
    }
  }

  @OnEvent('chat.socket.heartbeat')
  async onSocketHeartbeat(p: { userId: string }) {
    await this.presence.heartbeat(p.userId).catch(() => undefined);
  }

  @OnEvent('chat.socket.typing')
  async onSocketTyping(p: { userId: string; sessionId: string; typing: boolean }) {
    try {
      const s = /^[0-9a-f-]{36}$/i.test(p.sessionId ?? '') ? await this.sessions.findOne({ where: { id: p.sessionId } }) : null;
      if (!s || (s.status !== 'ACTIVE' && s.status !== 'WAITING')) return;
      if (s.requesterUserId === p.userId) this.chat.toAgents('chat.typing', { sessionId: s.id, by: 'REQUESTER', typing: !!p.typing, agentId: s.agentId });
      else if (s.agentId === p.userId && s.status === 'ACTIVE') {
        this.chat.toRequester(s, 'chat.typing', { sessionId: s.id, by: 'AGENT', typing: !!p.typing, agent: { firstName: s.agentFirstName } });
        this.chat.toAgents('chat.typing', { sessionId: s.id, by: 'AGENT', typing: !!p.typing, agentId: p.userId });
      }
    } catch (e: any) {
      this.logger.debug(`socket typing failed: ${e.message}`);
    }
  }
}
