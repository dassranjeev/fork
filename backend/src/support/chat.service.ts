import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { ChatSession, Order, Ticket, TicketMessage, User } from '../database/entities';
import { NotificationChannel, TicketCategory, TicketStatus } from '../common/enums';
import { SettingsService } from '../settings/settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RealtimeService } from '../realtime/realtime.module';
import { AuditService } from '../audit/audit.service';
import { TicketsService } from './tickets.service';
import { AGENTS_ROOM, ChatAgent, ChatPresenceService } from './chat-presence.service';
import { CHAT_TOPICS, fullName, prepareChatMessage, withinChatHours } from './chat.util';
import { StartChatDto } from './chat.dto';

export interface ChatRequester {
  type: 'CUSTOMER' | 'DRIVER';
  userId: string;
  driverId?: string;
  name?: string;
}

type Sender = { type: 'CUSTOMER' | 'DRIVER' | 'STAFF' | 'SYSTEM'; id?: string | null };
const OPEN: ChatSession['status'][] = ['WAITING', 'ACTIVE'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Live chat core: a chat is a Ticket (source CHAT) + a ChatSession (queue / agent / timing state). Messages are
 * TicketMessage rows, so agents keep every ticket tool (order context, refunds, notes, escalation, CSAT).
 * Protocol: docs/api/live-chat.md.
 */
@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);
  private dispatching = false;
  private lastPush = new Map<string, number>();
  /** WAITING sessions: last time the requester app touched the API (REST calls count as a heartbeat) */
  private lastSeen = new Map<string, number>();
  private unavailableSince: number | null = null;

  constructor(
    private settings: SettingsService,
    private config: ConfigService,
    private rt: RealtimeService,
    private notifications: NotificationsService,
    private audit: AuditService,
    readonly tickets: TicketsService,
    readonly presence: ChatPresenceService,
    @InjectRepository(ChatSession) readonly sessions: Repository<ChatSession>,
    @InjectRepository(Order) private orders: Repository<Order>,
    @InjectRepository(User) private users: Repository<User>,
  ) {}

  get msgs(): Repository<TicketMessage> {
    return this.tickets.messages;
  }
  get publicBase() {
    return this.publicUrl;
  }
  private get publicUrl() {
    return this.config.get<string>('publicUrl') ?? 'http://localhost:4000';
  }

  // ------------------------------------------------------------------ emit helpers
  toRequester(s: ChatSession, event: string, payload: any) {
    this.rt.emitToUser(s.requesterUserId, event, payload);
  }
  toAgents(event: string, payload: any) {
    this.rt.emitToRoom(AGENTS_ROOM, event, payload);
  }

  // ------------------------------------------------------------------ availability
  async unavailableReason(): Promise<'DISABLED' | 'OUTSIDE_HOURS' | 'NO_AGENTS' | null> {
    if (this.settings.get<boolean>('support.chat.enabled', true) === false) return 'DISABLED';
    if (!withinChatHours(this.settings.get('support.chat.hours', null))) return 'OUTSIDE_HOURS';
    return (await this.presence.eligibleAgents()).some((a) => a.live) ? null : 'NO_AGENTS';
  }

  async availability(type: 'CUSTOMER' | 'DRIVER') {
    const reason = await this.unavailableReason();
    const live = (await this.presence.eligibleAgents()).filter((a) => a.live);
    const waiting = await this.sessions.count({ where: { status: 'WAITING' } });
    return {
      enabled: this.settings.get<boolean>('support.chat.enabled', true) !== false,
      available: reason === null,
      reason,
      hours: this.settings.get('support.chat.hours', null),
      agentsOnline: live.length,
      waiting,
      estimatedWaitSec: this.estimate(waiting + 1, live.length),
      topics: CHAT_TOPICS.filter((t) => t.audience.includes(type)).map(({ code, label }) => ({ code, label })),
      limits: { maxMessageLength: 2000, maxAttachments: 3, attachmentTypes: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic'] },
    };
  }

  private estimate(position: number, agents: number) {
    const handle = Math.max(1, Number(this.settings.get('support.chat.estimatedHandleMinutes', 5)) || 5) * 60;
    return Math.round((Math.ceil(position / Math.max(1, agents)) * handle) / 10) * 10;
  }

  async queuePosition(s: ChatSession): Promise<{ position: number; estimatedWaitSec: number } | null> {
    if (s.status !== 'WAITING') return null;
    const waiting = await this.sessions.find({ where: { status: 'WAITING' }, order: { queuedAt: 'ASC', id: 'ASC' }, select: ['id'] });
    const idx = waiting.findIndex((w) => w.id === s.id);
    const position = idx < 0 ? 1 : idx + 1;
    const agents = (await this.presence.eligibleAgents()).filter((a) => a.live).length;
    return { position, estimatedWaitSec: this.estimate(position, agents) };
  }

  /** Tell every waiting requester where they are in line. */
  async broadcastQueue() {
    const waiting = await this.sessions.find({ where: { status: 'WAITING' }, order: { queuedAt: 'ASC', id: 'ASC' } });
    if (!waiting.length) return;
    const agents = (await this.presence.eligibleAgents()).filter((a) => a.live).length;
    waiting.forEach((s, i) => this.toRequester(s, 'chat.queue_position', { sessionId: s.id, position: i + 1, estimatedWaitSec: this.estimate(i + 1, agents) }));
  }

  // ------------------------------------------------------------------ views
  async requesterView(s: ChatSession) {
    const [ticket, order, queue, unread] = await Promise.all([
      this.tickets.tickets.findOne({ where: { id: s.ticketId }, select: ['id', 'number'] }),
      s.orderId ? this.orders.findOne({ where: { id: s.orderId }, select: ['id', 'code'] }) : null,
      this.queuePosition(s),
      this.msgs.count({ where: { ticketId: s.ticketId, internal: false, senderType: In(['STAFF', 'SYSTEM']), readAt: IsNull() } }),
    ]);
    return {
      id: s.id,
      ticketId: s.ticketId,
      ticketNumber: ticket?.number ?? null,
      status: s.status,
      requesterType: s.requesterType,
      topic: s.topic,
      orderId: s.orderId,
      orderCode: order?.code ?? null,
      agent: s.agentFirstName && s.status === 'ACTIVE' ? { firstName: s.agentFirstName } : null,
      queue,
      queuedAt: s.queuedAt,
      acceptedAt: s.acceptedAt,
      endedAt: s.endedAt,
      endedBy: s.endedBy,
      endReason: s.endReason,
      convertedToTicket: s.status === 'MISSED' || !!s.meta?.convertedToTicket,
      lastActivityAt: s.lastActivityAt,
      rating: s.rating,
      canRate: s.status === 'ENDED' && s.rating == null && !!s.acceptedAt,
      unread,
    };
  }

  /** requester-safe message (no staff ids / emails; agents appear by first name only; internal notes never) */
  private reqMsg(m: TicketMessage, names: Map<string, string>) {
    return {
      id: m.id,
      senderType: m.senderType === 'STAFF' ? 'AGENT' : m.senderType,
      senderName: m.senderType === 'STAFF' && m.senderId ? names.get(m.senderId) ?? 'Support' : null,
      body: m.body,
      attachments: m.attachments,
      createdAt: m.createdAt,
      readAt: m.readAt,
    };
  }

  private async userNames(ids: (string | null)[]) {
    const uniq = [...new Set(ids.filter((x): x is string => !!x))];
    const rows = uniq.length ? await this.users.find({ where: { id: In(uniq) }, select: ['id', 'firstName', 'lastName', 'email'] }) : [];
    return { first: new Map(rows.map((u): [string, string] => [u.id, u.firstName || 'Support'])), full: new Map(rows.map((u): [string, string] => [u.id, fullName(u)])) };
  }

  async messagesFor(s: ChatSession, opts: { forAgent: boolean; after?: string }) {
    const qb = this.msgs.createQueryBuilder('m').where('m.ticketId = :t', { t: s.ticketId }).orderBy('m.createdAt', 'ASC').addOrderBy('m.id', 'ASC');
    if (!opts.forAgent) qb.andWhere('m.internal = false');
    // `after` = message id (exact, microsecond safe) or ISO timestamp (compared at millisecond precision)
    if (opts.after && UUID.test(opts.after)) {
      qb.andWhere('(m.createdAt > (SELECT a."createdAt" FROM ticket_messages a WHERE a.id = :aid) OR (m.createdAt = (SELECT a."createdAt" FROM ticket_messages a WHERE a.id = :aid) AND m.id > :aid))', { aid: opts.after });
    } else if (opts.after && !Number.isNaN(new Date(opts.after).getTime())) {
      qb.andWhere(`date_trunc('milliseconds', m."createdAt") > :since`, { since: new Date(opts.after) });
    }
    const rows = await qb.getMany();
    const names = await this.userNames(rows.map((m) => m.senderId));
    return rows.map((m) => (opts.forAgent ? this.agentMsg(m, names.full) : this.reqMsg(m, names.first)));
  }

  agentMsg(m: TicketMessage, names: Map<string, string>) {
    return {
      id: m.id,
      senderType: m.senderType === 'STAFF' ? 'AGENT' : m.senderType,
      senderId: m.senderId,
      senderName: m.senderId ? names.get(m.senderId) ?? null : null,
      body: m.body,
      attachments: m.attachments,
      internal: m.internal,
      createdAt: m.createdAt,
      readAt: m.readAt,
    };
  }

  /** Console list item. */
  async agentItems(rows: ChatSession[], viewerId?: string) {
    if (!rows.length) return [];
    const ticketIds = rows.map((s) => s.ticketId);
    const orderIds = [...new Set(rows.map((s) => s.orderId).filter((x): x is string => !!x))];
    const [tickets, orders, names, unread, last] = await Promise.all([
      this.tickets.tickets.find({ where: { id: In(ticketIds) } }),
      orderIds.length ? this.orders.find({ where: { id: In(orderIds) }, select: ['id', 'code', 'status'] }) : Promise.resolve([] as Order[]),
      this.userNames([...rows.map((s) => s.requesterUserId), ...rows.map((s) => s.agentId)]),
      this.msgs.query(`SELECT "ticketId", COUNT(*)::int AS n FROM ticket_messages WHERE "ticketId" = ANY($1) AND internal = false AND "readAt" IS NULL AND "senderType" IN ('CUSTOMER','DRIVER') GROUP BY "ticketId"`, [ticketIds]),
      this.msgs.query(`SELECT DISTINCT ON ("ticketId") "ticketId", body, "senderType", "createdAt" FROM ticket_messages WHERE "ticketId" = ANY($1) AND internal = false ORDER BY "ticketId", "createdAt" DESC`, [ticketIds]),
    ]);
    const tm = new Map(tickets.map((t) => [t.id, t]));
    const om = new Map(orders.map((o) => [o.id, o]));
    const um = new Map<string, number>(unread.map((r: any) => [r.ticketId, r.n]));
    const lm = new Map<string, any>(last.map((r: any) => [r.ticketId, r]));
    const waiting = rows.some((r) => r.status === 'WAITING') ? await this.sessions.find({ where: { status: 'WAITING' }, order: { queuedAt: 'ASC', id: 'ASC' }, select: ['id'] }) : [];
    const now = Date.now();
    return rows.map((s) => {
      const t = tm.get(s.ticketId);
      const lastM = lm.get(s.ticketId);
      const wait = s.waitSec ?? Math.round(((s.status === 'WAITING' ? now : (s.endedAt ?? new Date()).getTime()) - s.queuedAt.getTime()) / 1000);
      return {
        id: s.id,
        ticketId: s.ticketId,
        ticketNumber: t?.number ?? null,
        status: s.status,
        mine: !!viewerId && s.agentId === viewerId,
        requesterType: s.requesterType,
        requesterId: s.requesterUserId,
        requesterName: names.full.get(s.requesterUserId) ?? 'User',
        topic: s.topic,
        category: t?.category ?? s.topic,
        priority: t?.priority ?? 'NORMAL',
        tier: t?.tier ?? null,
        slaBreached: !!t?.slaBreached,
        orderId: s.orderId,
        orderCode: s.orderId ? om.get(s.orderId)?.code ?? null : null,
        orderStatus: s.orderId ? om.get(s.orderId)?.status ?? null : null,
        agentId: s.agentId,
        agentName: s.agentId ? names.full.get(s.agentId) ?? null : null,
        queuedAt: s.queuedAt,
        acceptedAt: s.acceptedAt,
        endedAt: s.endedAt,
        endedBy: s.endedBy,
        endReason: s.endReason,
        waitSec: wait,
        firstResponseSec: s.firstResponseSec,
        lastActivityAt: s.lastActivityAt,
        position: s.status === 'WAITING' ? waiting.findIndex((w) => w.id === s.id) + 1 : null,
        unread: um.get(s.ticketId) ?? 0,
        lastMessage: lastM ? { body: String(lastM.body).slice(0, 140), senderType: lastM.senderType === 'STAFF' ? 'AGENT' : lastM.senderType, at: lastM.createdAt } : null,
        rating: s.rating,
        transferCount: s.transferCount,
      };
    });
  }

  async emitUpdated(s: ChatSession, extra: Record<string, any> = {}) {
    const [item] = await this.agentItems([s]);
    this.toAgents('chat.updated', { ...item, ...extra });
    return item;
  }

  // ------------------------------------------------------------------ requester: start / lookup
  private async assertOrder(req: ChatRequester, orderId: string) {
    const o = await this.orders.findOne({ where: { id: orderId }, select: ['id', 'customerId', 'driverId'] });
    const ok = !!o && (req.type === 'CUSTOMER' ? o.customerId === req.userId : !!req.driverId && o.driverId === req.driverId);
    if (!ok) throw new NotFoundException('Order not found');
  }

  async findOpen(userId: string) {
    return this.sessions.findOne({ where: { requesterUserId: userId, status: In(OPEN) } });
  }

  async own(req: ChatRequester, id: string): Promise<ChatSession> {
    const s = UUID.test(id) ? await this.sessions.findOne({ where: { id, requesterUserId: req.userId, requesterType: req.type } }) : null;
    if (!s) throw new NotFoundException('Chat not found');
    if (s.status === 'WAITING') this.lastSeen.set(s.id, Date.now());
    return s;
  }

  async liveResponse(s: ChatSession, existing: boolean) {
    const view = await this.requesterView(s);
    return { mode: 'live' as const, existing, session: view, queue: view.queue, messages: await this.messagesFor(s, { forAgent: false }) };
  }

  async active(req: ChatRequester) {
    const s = await this.findOpen(req.userId);
    return s ? this.liveResponse(s, true) : { session: null };
  }

  /** Latest offline/converted conversation of this requester that is still an open ticket for the same order (<24h). */
  private async openOfflineConversation(req: ChatRequester, orderId: string | null) {
    const since = new Date(Date.now() - 24 * 3600_000);
    const rows = await this.sessions.find({ where: { requesterUserId: req.userId, status: 'MISSED' }, order: { queuedAt: 'DESC' }, take: 3 });
    for (const s of rows) {
      if (s.queuedAt < since || (s.orderId ?? null) !== orderId) continue;
      const t = await this.tickets.tickets.findOne({ where: { id: s.ticketId } });
      if (t && [TicketStatus.OPEN, TicketStatus.PENDING, TicketStatus.ESCALATED].includes(t.status)) return { session: s, ticket: t };
    }
    return null;
  }

  async start(req: ChatRequester, dto: StartChatDto) {
    const open = await this.findOpen(req.userId);
    if (open) return this.liveResponse(open, true);
    const orderId = dto.orderId ?? null;
    if (orderId) await this.assertOrder(req, orderId);
    const { text, files } = prepareChatMessage(dto.message, dto.attachments, this.publicUrl);
    const reason = await this.unavailableReason();
    const label = CHAT_TOPICS.find((t) => t.code === dto.topic)?.label ?? 'Support';
    const now = new Date();
    const prior = await this.openOfflineConversation(req, orderId);

    // ---- reuse the open ticket of an earlier offline/converted chat: one ticket per conversation, nothing duplicated
    let ticket: Ticket;
    if (prior) {
      ticket = prior.ticket;
      const pm = await this.msgs.save(this.msgs.create({ ticketId: ticket.id, senderType: req.type, senderId: req.userId, body: text, attachments: files, internal: false }));
      void this.fanout(prior.session, pm, false);
      await this.tickets.tickets.update(ticket.id, { lastMessageAt: now, lastMessageBy: req.type, ...(ticket.status === TicketStatus.PENDING ? { status: TicketStatus.OPEN } : {}), ...(files.length ? { attachments: [...new Set([...(ticket.attachments ?? []), ...files])] } : {}) });
    } else {
      ticket = await this.tickets.create({
        requesterType: req.type,
        requesterId: req.userId,
        driverId: req.type === 'DRIVER' ? req.driverId ?? null : null,
        subject: `Live chat: ${label}`,
        category: dto.topic as TicketCategory,
        orderId,
        source: 'CHAT',
        tags: ['live-chat'],
        meta: { chat: true, mode: reason ? 'ticket' : 'live', unavailableReason: reason },
      });
      await this.msgs.save(this.msgs.create({ ticketId: ticket.id, senderType: req.type, senderId: req.userId, body: text, attachments: files, internal: false }));
      await this.tickets.tickets.update(ticket.id, { lastMessageAt: now, lastMessageBy: req.type, attachments: files });
    }

    // ---- offline: the very same submission becomes (or extends) a ticket; a MISSED session keeps it visible in the console
    if (reason) {
      const note = 'Our team is offline right now. We created a support ticket with your message and will reply by notification and email.';
      let session = prior?.session ?? null;
      if (!prior) {
        await this.tickets.sysNote(ticket.id, note, false);
        session = await this.sessions.save(
          this.sessions.create({ ticketId: ticket.id, requesterUserId: req.userId, requesterType: req.type, status: 'MISSED', topic: dto.topic, orderId, queuedAt: now, lastActivityAt: now, endedAt: now, endedBy: 'SYSTEM', endReason: reason, meta: { offline: true, convertedToTicket: true } }),
        );
      } else {
        await this.sessions.update(prior.session.id, { lastActivityAt: now });
      }
      const fresh = (await this.sessions.findOne({ where: { id: session!.id } }))!;
      const [item] = await this.agentItems([fresh]);
      this.toAgents(prior ? 'chat.updated' : 'chat.new', { ...item, event: 'offline_ticket' });
      return {
        mode: 'ticket' as const,
        reason,
        appended: !!prior,
        ticketId: ticket.id,
        ticketNumber: ticket.number,
        ticket: { id: ticket.id, number: ticket.number, status: ticket.status },
        session: await this.requesterView(fresh),
        message: note,
      };
    }

    let session: ChatSession;
    try {
      session = await this.sessions.save(
        this.sessions.create({ ticketId: ticket.id, requesterUserId: req.userId, requesterType: req.type, status: 'WAITING', topic: dto.topic, orderId, queuedAt: now, lastActivityAt: now }),
      );
    } catch (e: any) {
      if (e?.code === '23505') {
        // lost a double-start race: drop the orphan ticket and return the winner
        if (!prior) {
          await this.msgs.delete({ ticketId: ticket.id });
          await this.tickets.tickets.delete({ id: ticket.id });
        }
        const winner = await this.findOpen(req.userId);
        if (winner) return this.liveResponse(winner, true);
      }
      throw e;
    }
    this.lastSeen.set(session.id, Date.now());
    const view = await this.requesterView(session);
    this.toRequester(session, 'chat.queued', { sessionId: session.id, session: view, queue: view.queue });
    const [item] = await this.agentItems([session]);
    this.toAgents('chat.new', item);
    await this.dispatchWaiting();
    const fresh = (await this.sessions.findOne({ where: { id: session.id } })) ?? session;
    // nobody picked it up yet: staff with support access get a (push) notification even when the console is closed
    if (fresh.status === 'WAITING') this.notifications.notifyStaff('chat.waiting', { who: req.type === 'CUSTOMER' ? 'A customer' : req.type === 'DRIVER' ? 'A driver' : 'A restaurant' }, { sessionId: fresh.id }).catch(() => undefined);
    return this.liveResponse(fresh, false);
  }

  /** own sessions, newest first (lets an app reopen a converted/ended chat and read its messages) */
  async mine(req: ChatRequester, limit = 10) {
    const rows = await this.sessions.find({ where: { requesterUserId: req.userId, requesterType: req.type }, order: { queuedAt: 'DESC' }, take: Math.min(Math.max(limit, 1), 30) });
    return { data: await Promise.all(rows.map((s) => this.requesterView(s))) };
  }

  // ------------------------------------------------------------------ messages
  /** Persist + fan out one message. `internal` notes only reach the agents room. */
  async post(s: ChatSession, sender: Sender, input: { body?: string; attachments?: string[]; internal?: boolean }) {
    const { text, files } = prepareChatMessage(input.body, input.attachments, this.publicUrl);
    const internal = !!input.internal && sender.type === 'STAFF';
    const msg = await this.msgs.save(this.msgs.create({ ticketId: s.ticketId, senderType: sender.type, senderId: sender.id ?? null, body: text, attachments: files, internal }));
    const now = new Date();
    if (!internal) {
      await this.tickets.tickets.update(s.ticketId, { lastMessageAt: now, lastMessageBy: sender.type });
      if (sender.type === 'STAFF') {
        await this.tickets.tickets.createQueryBuilder().update(Ticket).set({ firstResponseAt: () => 'COALESCE("firstResponseAt", now())' }).where('id = :id', { id: s.ticketId }).execute();
      }
      const sp: Partial<ChatSession> = { lastActivityAt: now };
      if (sender.type === 'STAFF' && s.firstResponseSec == null && s.acceptedAt) {
        sp.firstResponseSec = Math.max(0, Math.round((now.getTime() - s.acceptedAt.getTime()) / 1000));
        s.firstResponseSec = sp.firstResponseSec;
      }
      await this.sessions.update(s.id, sp);
      s.lastActivityAt = now;
    }
    if (!internal && sender.type !== 'STAFF' && sender.type !== 'SYSTEM') {
      await this.tickets.tickets.createQueryBuilder().update(Ticket).set({ status: TicketStatus.OPEN }).where('id = :id AND status = :p', { id: s.ticketId, p: TicketStatus.PENDING }).execute();
    }
    return { msg, ...(await this.fanout(s, msg, internal)) };
  }

  /** emit one stored message to the agents room (always) and to the requester (never for internal notes) */
  async fanout(s: ChatSession, msg: TicketMessage, internal: boolean) {
    const names = await this.userNames([msg.senderId]);
    const agentView = this.agentMsg(msg, names.full);
    const requesterView = this.reqMsg(msg, names.first);
    this.toAgents('chat.message', { sessionId: s.id, message: agentView });
    if (!internal) {
      this.toRequester(s, 'chat.message', { sessionId: s.id, message: requesterView });
      if (msg.senderType === 'STAFF') void this.pushIfOffline(s, msg.body || 'Sent you an attachment').catch(() => undefined);
    }
    return { requesterView, agentView };
  }

  /** push/in-app notification when the requester has no live socket (rate limited per chat) */
  private async pushIfOffline(s: ChatSession, text: string) {
    if ((await this.rt.countInRoom(`user:${s.requesterUserId}`)) > 0) return;
    const last = this.lastPush.get(s.id) ?? 0;
    if (Date.now() - last < 60_000) return;
    this.lastPush.set(s.id, Date.now());
    await this.notifications.notify({
      userId: s.requesterUserId,
      audience: s.requesterType,
      event: 'chat.message',
      title: `${s.agentFirstName ?? 'FORKY Support'} replied`,
      body: text.length > 120 ? `${text.slice(0, 117)}...` : text,
      data: { chatSessionId: s.id, ticketId: s.ticketId },
      channels: [NotificationChannel.PUSH, NotificationChannel.IN_APP],
    });
  }

  async sendFromRequester(req: ChatRequester, id: string, input: { body?: string; attachments?: string[] }) {
    const s = await this.own(req, id);
    if (s.status === 'MISSED') {
      // converted/offline chat: the message joins the same support ticket (no duplicate tickets)
      const t = await this.tickets.get(s.ticketId);
      if (![TicketStatus.OPEN, TicketStatus.PENDING, TicketStatus.ESCALATED].includes(t.status)) throw new ConflictException('This conversation was resolved. Start a new chat to continue.');
      const r = await this.post(s, { type: req.type, id: req.userId }, input);
      await this.emitUpdated(s, { event: 'offline_message' });
      return r.requesterView;
    }
    if (!OPEN.includes(s.status)) throw new ConflictException('This chat has ended. Start a new chat to continue.');
    const r = await this.post(s, { type: req.type, id: req.userId }, input);
    return r.requesterView;
  }

  async typingFromRequester(req: ChatRequester, id: string, typing: boolean) {
    const s = await this.own(req, id);
    if (!OPEN.includes(s.status)) return { ok: true };
    this.toAgents('chat.typing', { sessionId: s.id, by: 'REQUESTER', typing, agentId: s.agentId });
    return { ok: true };
  }

  async markRead(s: ChatSession, by: 'REQUESTER' | 'AGENT') {
    const now = new Date();
    const senders = by === 'REQUESTER' ? ['STAFF', 'SYSTEM'] : ['CUSTOMER', 'DRIVER'];
    const r = await this.msgs
      .createQueryBuilder()
      .update(TicketMessage)
      .set({ readAt: now })
      .where('"ticketId" = :t AND internal = false AND "readAt" IS NULL AND "senderType" IN (:...s)', { t: s.ticketId, s: senders })
      .execute();
    if (r.affected) {
      const payload = { sessionId: s.id, by, at: now, count: r.affected };
      if (by === 'AGENT') this.toRequester(s, 'chat.read', payload);
      this.toAgents('chat.read', payload);
    }
    return { readAt: now, count: r.affected ?? 0 };
  }

  async readFromRequester(req: ChatRequester, id: string) {
    return this.markRead(await this.own(req, id), 'REQUESTER');
  }

  async endFromRequester(req: ChatRequester, id: string) {
    const s = await this.own(req, id);
    if (!OPEN.includes(s.status)) return this.requesterView(s);
    const done = await this.finish(s, {
      by: 'REQUESTER',
      reason: 'REQUESTER_ENDED',
      message: s.status === 'WAITING' ? 'Chat cancelled before an agent joined. Your message stays on the support ticket.' : 'The chat was ended.',
    });
    return this.requesterView(done ?? (await this.own(req, id)));
  }

  async rate(req: ChatRequester, id: string, rating: number, feedback?: string) {
    const s = await this.own(req, id);
    if (s.status !== 'ENDED' || !s.acceptedAt) throw new BadRequestException('You can rate a chat after it has ended with an agent');
    if (s.rating != null) throw new ConflictException('This chat was already rated');
    const comment = feedback?.replace(/<\/?[a-z!][^>]*>/gi, '').trim() || null;
    await this.sessions.update(s.id, { rating, feedback: comment });
    await this.tickets.tickets.update(s.ticketId, { csat: rating, csatComment: comment });
    s.rating = rating;
    s.feedback = comment;
    await this.emitUpdated(s, { event: 'rated' });
    return this.requesterView(s);
  }

  // ------------------------------------------------------------------ state changes
  /** Atomically WAITING -> ACTIVE for one agent. Returns false when someone else got it first. */
  async claim(sessionId: string, agent: ChatAgent, via: 'accept' | 'auto' = 'accept'): Promise<boolean> {
    const now = new Date();
    const r = await this.sessions
      .createQueryBuilder()
      .update(ChatSession)
      .set({ status: 'ACTIVE', agentId: agent.id, agentFirstName: agent.firstName, acceptedAt: now, lastActivityAt: now })
      .where(`id = :id AND status = 'WAITING'`, { id: sessionId })
      .execute();
    if (!r.affected) return false;
    const s = (await this.sessions.findOne({ where: { id: sessionId } }))!;
    s.waitSec = Math.max(0, Math.round((now.getTime() - s.queuedAt.getTime()) / 1000));
    await this.sessions.update(s.id, { waitSec: s.waitSec });
    const t = await this.tickets.get(s.ticketId);
    await this.tickets.tickets.update(t.id, { assignedToId: agent.id, ...(t.status === TicketStatus.ESCALATED ? { status: TicketStatus.OPEN } : {}) });
    await this.tickets.sysNote(t.id, `Live chat ${via === 'auto' ? 'auto-assigned' : 'accepted'}: ${agent.name} (waited ${s.waitSec}s)`);
    const text = `${agent.firstName} from FORKY Support joined the chat.`;
    const sys = await this.msgs.save(this.msgs.create({ ticketId: t.id, senderType: 'SYSTEM', senderId: null, body: text, attachments: [], internal: false }));
    this.toRequester(s, 'chat.accepted', { sessionId: s.id, agent: { firstName: agent.firstName }, acceptedAt: s.acceptedAt, waitSec: s.waitSec });
    this.toRequester(s, 'chat.message', { sessionId: s.id, message: this.reqMsg(sys, new Map()) });
    this.toAgents('chat.message', { sessionId: s.id, message: this.agentMsg(sys, new Map()) });
    await this.emitUpdated(s, { event: via === 'auto' ? 'auto_assigned' : 'accepted' });
    void this.audit.log({ actor: { id: agent.id } as any, action: `support.chat.${via === 'auto' ? 'auto_assign' : 'accept'}`, entity: 'chat_session', entityId: s.id, after: { agentId: agent.id, waitSec: s.waitSec } });
    await this.broadcastQueue();
    return true;
  }

  /** End (or time out) an open session exactly once. Returns null when it was already closed. */
  async finish(
    s: ChatSession,
    o: { by: 'REQUESTER' | 'AGENT' | 'SYSTEM'; reason: string; message: string; status?: 'ENDED' | 'MISSED'; converted?: boolean },
  ): Promise<ChatSession | null> {
    const now = new Date();
    const status = o.status ?? 'ENDED';
    const r = await this.sessions
      .createQueryBuilder()
      .update(ChatSession)
      .set({ status, endedAt: now, endedBy: o.by, endReason: o.reason })
      .where(`id = :id AND status IN ('WAITING','ACTIVE')`, { id: s.id })
      .execute();
    if (!r.affected) return null;
    const fresh = (await this.sessions.findOne({ where: { id: s.id } }))!;
    if (o.converted) {
      fresh.meta = { ...(fresh.meta ?? {}), convertedToTicket: true };
      await this.sessions.update(s.id, { meta: fresh.meta });
    }
    const sys = await this.msgs.save(this.msgs.create({ ticketId: s.ticketId, senderType: 'SYSTEM', senderId: null, body: o.message, attachments: [], internal: false }));
    await this.tickets.tickets.update(s.ticketId, { lastMessageAt: now, lastMessageBy: 'SYSTEM' });
    await this.tickets.sysNote(s.ticketId, `Live chat ${status.toLowerCase()} (${o.reason}) - the transcript stays on this ticket`);
    const ticket = await this.tickets.get(s.ticketId);
    this.toAgents('chat.message', { sessionId: s.id, message: this.agentMsg(sys, new Map()) });
    this.toRequester(fresh, 'chat.ended', {
      sessionId: s.id,
      status,
      endedBy: o.by,
      reason: o.reason,
      message: o.message,
      endedAt: now,
      canRate: status === 'ENDED' && !!fresh.acceptedAt && fresh.rating == null,
      convertedToTicket: status === 'MISSED' || !!o.converted,
      ticketId: ticket.id,
      ticketNumber: ticket.number,
    });
    if (status === 'MISSED' || o.converted) {
      this.toRequester(fresh, 'chat.converted', { sessionId: s.id, ticketId: ticket.id, ticketNumber: ticket.number, reason: o.reason, message: o.message });
    }
    await this.emitUpdated(fresh, { event: status === 'MISSED' || o.converted ? 'converted' : 'ended' });
    this.tickets.publish(ticket, 'chat_ended');
    this.lastSeen.delete(s.id);
    await this.broadcastQueue();
    void this.dispatchWaiting().catch(() => undefined);
    return fresh;
  }

  // ------------------------------------------------------------------ automation
  /** Auto-assign waiting chats to the least-loaded ONLINE agent (support.chat.autoAssign). */
  async dispatchWaiting() {
    if (this.settings.get<boolean>('support.chat.autoAssign', true) === false || this.dispatching) return;
    this.dispatching = true;
    try {
      const waiting = await this.sessions.find({ where: { status: 'WAITING' }, order: { queuedAt: 'ASC' } });
      if (!waiting.length) return;
      const agents = (await this.presence.eligibleAgents()).filter((a) => a.live);
      for (const s of waiting) {
        const t = await this.tickets.tickets.findOne({ where: { id: s.ticketId }, select: ['id', 'tier'] });
        const cands = agents.filter((a) => this.presence.hasCapacity(a) && this.presence.canHandle(a, t?.tier ?? 'TIER1')).sort((x, y) => x.load / x.max - y.load / y.max || x.load - y.load);
        if (!cands.length) continue;
        if (await this.claim(s.id, cands[0], 'auto')) cands[0].load++;
      }
    } catch (e: any) {
      this.logger.error(`dispatchWaiting failed: ${e.message}`);
    } finally {
      this.dispatching = false;
    }
  }

  async sweepIdle() {
    const mins = Number(this.settings.get('support.chat.autoCloseIdleMinutes', 15));
    if (!(mins > 0)) return 0;
    const cutoff = new Date(Date.now() - mins * 60_000);
    const rows = await this.sessions.createQueryBuilder('s').where(`s.status = 'ACTIVE' AND s."lastActivityAt" < :c`, { c: cutoff }).getMany();
    let n = 0;
    for (const s of rows) {
      if (await this.finish(s, { by: 'SYSTEM', reason: 'IDLE', message: 'This chat was closed because there was no activity. You can start a new chat any time.' })) n++;
    }
    return n;
  }

  /** WAITING -> MISSED: keep everything as a normal ticket, tell the requester (push + email + in-app). */
  async convertToTicket(s: ChatSession, reason: string, message: string): Promise<boolean> {
    const done = await this.finish(s, { by: 'SYSTEM', reason, status: 'MISSED', converted: true, message });
    if (!done) return false;
    const t = await this.tickets.get(s.ticketId);
    void this.notifications
      .notify({
        userId: s.requesterUserId,
        audience: s.requesterType,
        event: 'ticket.update',
        title: 'We could not connect you to an agent',
        body: `Your chat is now support ticket ${t.number}. We will reply here and by email.`,
        data: { ticketId: t.id, number: t.number, chatSessionId: s.id },
        channels: [NotificationChannel.PUSH, NotificationChannel.EMAIL, NotificationChannel.IN_APP],
      })
      .catch(() => undefined);
    return true;
  }

  async sweepQueueTimeouts() {
    const mins = Number(this.settings.get('support.chat.queueTimeoutMinutes', 10));
    if (!(mins > 0)) return 0;
    const cutoff = new Date(Date.now() - mins * 60_000);
    const rows = await this.sessions.createQueryBuilder('s').where(`s.status = 'WAITING' AND s."queuedAt" < :c`, { c: cutoff }).getMany();
    let n = 0;
    for (const s of rows) {
      if (await this.convertToTicket(s, 'QUEUE_TIMEOUT', 'All of our agents are busy. We kept your message as a support ticket and will reply by notification and email.')) n++;
    }
    return n;
  }

  /** Waiting chats while nobody can take them (all agents offline / outside hours / chat disabled) for longer than the grace period. */
  async sweepNoAgents() {
    const waiting = await this.sessions.find({ where: { status: 'WAITING' } });
    const reason = waiting.length ? await this.unavailableReason() : null;
    if (!reason) {
      this.unavailableSince = null;
      return 0;
    }
    this.unavailableSince ??= Date.now();
    const grace = Math.max(0, Number(this.settings.get('support.chat.noAgentGraceSec', 30))) * 1000;
    if (Date.now() - this.unavailableSince < grace) return 0;
    let n = 0;
    for (const s of waiting) {
      if (await this.convertToTicket(s, reason, 'Our team just went offline. We kept your message as a support ticket and will reply by notification and email.')) n++;
    }
    return n;
  }

  /** Requester left (no socket and no API call for support.chat.waitingDisconnectSec) while still queued. */
  async sweepAbandoned() {
    const sec = Number(this.settings.get('support.chat.waitingDisconnectSec', 90));
    if (!(sec > 0)) return 0;
    const waiting = await this.sessions.find({ where: { status: 'WAITING' } });
    let n = 0;
    for (const s of waiting) {
      const seen = this.lastSeen.get(s.id) ?? s.lastActivityAt.getTime();
      if (Date.now() - seen < sec * 1000) continue;
      if ((await this.rt.countInRoom(`user:${s.requesterUserId}`)) > 0) {
        this.lastSeen.set(s.id, Date.now());
        continue;
      }
      if (await this.convertToTicket(s, 'REQUESTER_LEFT', 'You left the chat before an agent joined. We kept your message as a support ticket and will reply by notification and email.')) n++;
    }
    return n;
  }

  /** Agents that vanished (no heartbeat): put their active chats back in the queue. */
  async requeueAgentChats(agentIds: string[]) {
    if (!agentIds.length) return 0;
    const rows = await this.sessions.find({ where: { status: 'ACTIVE', agentId: In(agentIds) } });
    for (const s of rows) {
      await this.sessions.update(s.id, { status: 'WAITING', agentId: null, agentFirstName: null, acceptedAt: null, waitSec: null });
      await this.msgs.save(this.msgs.create({ ticketId: s.ticketId, senderType: 'SYSTEM', senderId: null, body: 'Your agent was disconnected. We are connecting you to another agent.', attachments: [], internal: false }));
      await this.tickets.tickets.update(s.ticketId, { assignedToId: null });
      const fresh = (await this.sessions.findOne({ where: { id: s.id } }))!;
      const view = await this.requesterView(fresh);
      this.toRequester(fresh, 'chat.queued', { sessionId: s.id, session: view, queue: view.queue, requeued: true });
      await this.emitUpdated(fresh, { event: 'requeued' });
    }
    if (rows.length) await this.broadcastQueue();
    return rows.length;
  }
}
