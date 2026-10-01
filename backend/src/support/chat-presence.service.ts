import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThan, Repository } from 'typeorm';
import { AgentPresence, ChatSession, User } from '../database/entities';
import { Action, Module as Mod, TicketTier, UserType } from '../common/enums';
import { SettingsService } from '../settings/settings.service';
import { RealtimeService } from '../realtime/realtime.module';
import { fullName } from './chat.util';

export interface ChatAgent {
  id: string;
  name: string;
  firstName: string;
  role: string | null;
  status: 'ONLINE' | 'AWAY' | 'OFFLINE';
  /** ONLINE with a fresh heartbeat */
  live: boolean;
  max: number;
  load: number;
  canTier2: boolean;
  canFinance: boolean;
  lastHeartbeatAt: Date | null;
}

export const AGENTS_ROOM = 'support:agents';

/** Agent availability (ONLINE / AWAY / OFFLINE) for live chat + capacity bookkeeping. */
@Injectable()
export class ChatPresenceService {
  private readonly logger = new Logger(ChatPresenceService.name);

  constructor(
    private settings: SettingsService,
    private rt: RealtimeService,
    @InjectRepository(AgentPresence) private repo: Repository<AgentPresence>,
    @InjectRepository(User) private users: Repository<User>,
    @InjectRepository(ChatSession) private sessions: Repository<ChatSession>,
  ) {}

  get defaultMax() {
    return Math.max(1, Number(this.settings.get('support.chat.maxConcurrentPerAgent', 4)) || 4);
  }
  private get staleMs() {
    return Math.max(10, Number(this.settings.get('support.chat.presenceTimeoutSec', 120)) || 120) * 1000;
  }

  /** Staff who may work chats: SUPPORT:edit (or super admin). */
  async eligibleAgents(): Promise<ChatAgent[]> {
    const staff = await this.users.find({ where: { type: In([UserType.STAFF, UserType.SUPER_ADMIN]) }, relations: { role: true } });
    const eligible = staff.filter((u) => u.status === 'ACTIVE' && (u.type === UserType.SUPER_ADMIN || u.role?.permissions?.[Mod.SUPPORT]?.includes(Action.EDIT)));
    if (!eligible.length) return [];
    const ids = eligible.map((u) => u.id);
    const [pres, loads] = await Promise.all([
      this.repo.find({ where: { userId: In(ids) } }),
      this.sessions.createQueryBuilder('s').select('s.agentId', 'id').addSelect('COUNT(*)', 'n').where("s.status = 'ACTIVE' AND s.agentId IN (:...ids)", { ids }).groupBy('s.agentId').getRawMany<{ id: string; n: string }>(),
    ]);
    const pm = new Map(pres.map((p) => [p.userId, p]));
    const lm = new Map(loads.map((l) => [l.id, Number(l.n)]));
    const cutoff = Date.now() - this.staleMs;
    return eligible.map((u) => {
      const p = pm.get(u.id);
      const fresh = !!p?.lastHeartbeatAt && p.lastHeartbeatAt.getTime() >= cutoff;
      const status = p && p.status !== 'OFFLINE' && fresh ? p.status : 'OFFLINE';
      const perms = u.role?.permissions ?? {};
      return {
        id: u.id,
        name: fullName(u),
        firstName: u.firstName || fullName(u),
        role: u.type === UserType.SUPER_ADMIN ? 'Super Admin' : u.role?.name ?? null,
        status,
        live: status === 'ONLINE',
        max: p?.maxConcurrentChats ?? this.defaultMax,
        load: lm.get(u.id) ?? 0,
        canTier2: u.type === UserType.SUPER_ADMIN || !!perms[Mod.SUPPORT]?.includes(Action.APPROVE),
        canFinance: u.type === UserType.SUPER_ADMIN || !!perms[Mod.FINANCE]?.includes(Action.VIEW),
        lastHeartbeatAt: p?.lastHeartbeatAt ?? null,
      } as ChatAgent;
    });
  }

  async agent(userId: string): Promise<ChatAgent | undefined> {
    return (await this.eligibleAgents()).find((a) => a.id === userId);
  }

  canHandle(a: ChatAgent, tier: TicketTier | string) {
    if (tier === TicketTier.TIER2) return a.canTier2;
    if (tier === TicketTier.FINANCE) return a.canFinance;
    return true;
  }

  hasCapacity(a: ChatAgent) {
    return a.load < a.max;
  }

  async mine(userId: string) {
    const a = await this.agent(userId);
    return a ? { status: a.status, maxConcurrentChats: a.max, activeChats: a.load, lastHeartbeatAt: a.lastHeartbeatAt } : { status: 'OFFLINE', maxConcurrentChats: this.defaultMax, activeChats: 0, lastHeartbeatAt: null };
  }

  async set(userId: string, status: 'ONLINE' | 'AWAY' | 'OFFLINE', maxConcurrentChats?: number) {
    let p = await this.repo.findOne({ where: { userId } });
    if (!p) p = this.repo.create({ userId, status: 'OFFLINE', maxConcurrentChats: null });
    const changed = p.status !== status;
    p.status = status;
    p.lastHeartbeatAt = new Date();
    if (changed || !p.statusChangedAt) p.statusChangedAt = new Date();
    if (maxConcurrentChats) p.maxConcurrentChats = maxConcurrentChats;
    await this.repo.save(p);
    await this.broadcast(userId);
    return this.mine(userId);
  }

  async heartbeat(userId: string) {
    await this.repo.update({ userId }, { lastHeartbeatAt: new Date() });
  }

  async broadcast(userId: string) {
    const a = await this.agent(userId);
    if (a) this.rt.emitToRoom(AGENTS_ROOM, 'agent.presence', { userId: a.id, name: a.name, status: a.status, activeChats: a.load, max: a.max });
  }

  /** No heartbeat for presenceTimeoutSec -> OFFLINE. Returns the user ids that were flipped. */
  async cleanupStale(): Promise<string[]> {
    const cutoff = new Date(Date.now() - this.staleMs);
    const stale = await this.repo.find({ where: [{ status: 'ONLINE', lastHeartbeatAt: LessThan(cutoff) }, { status: 'AWAY', lastHeartbeatAt: LessThan(cutoff) }] });
    for (const p of stale) {
      p.status = 'OFFLINE';
      p.statusChangedAt = new Date();
      await this.repo.save(p);
      this.rt.emitToRoom(AGENTS_ROOM, 'agent.presence', { userId: p.userId, status: 'OFFLINE', stale: true });
    }
    if (stale.length) this.logger.log(`${stale.length} agent(s) set OFFLINE (no heartbeat)`);
    return stale.map((p) => p.userId);
  }
}
