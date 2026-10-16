import { BadRequestException, ForbiddenException, HttpException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Cron } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { AssistantSession, Restaurant } from '../database/entities';
import type { AssistantCartLine } from '../database/entities/assistant.entities';
import { JwtStrategy } from '../auth/jwt.strategy';
import { AuthUser } from '../common/auth.types';
import { RestaurantStatus, UserType } from '../common/enums';
import { CartService } from '../customers/cart.service';
import { SettingsService } from '../settings/settings.service';
import { AssistantConfigService, AssistantConfig } from './assistant-config.service';
import { AssistantKnowledgeService } from './assistant-knowledge.service';
import { AssistantChatDto } from './assistant.dto';
import { AssistantBrains } from './brain/brain.registry';
import { BotChip, BotResult, BrainContext, DirectoryEntry, Knowledge, SessionDraft } from './brain/brain.types';
import { CentralRun } from './brain/central.brain';
import { isValidQuick } from './brain/deterministic.brain';
import { chip, MAX_CARDS, MAX_CHIPS } from './brain/reply';
import { DeterministicTools, summarizeCart } from './brain/tools';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const SWITCH_INTENT = /\b(switch|change|different|another|other|new) (restaurant|place|store|shop)\b|\b(order|get|eat|buy) (from|at) \S/;

export interface Scope {
  mode: 'embedded' | 'site';
  restaurant: Restaurant | null;
  cfg: AssistantConfig | null;
  /** the visitor may still switch restaurant (central site bot) */
  canScope: boolean;
  origin: string | null;
}

@Injectable()
export class AssistantService {
  private readonly logger = new Logger('Assistant');
  private sessionHits = new Map<string, number[]>();

  constructor(
    @InjectDataSource() private ds: DataSource,
    private config: ConfigService,
    private settings: SettingsService,
    private cfg: AssistantConfigService,
    private knowledge: AssistantKnowledgeService,
    private brains: AssistantBrains,
    private cart: CartService,
    private jwt: JwtService,
    private strategy: JwtStrategy,
    private events: EventEmitter2,
  ) {}

  // ================================================================== access control
  private originOf(req: any): string | null {
    const o = req?.headers?.origin;
    return typeof o === 'string' && o && o !== 'null' ? o.replace(/\/$/, '') : null;
  }

  /** a valid customer Bearer token on a public call marks the visitor as logged in (otherwise: guest) */
  async optionalCustomer(req: any): Promise<AuthUser | null> {
    const h = req?.headers?.authorization as string | undefined;
    if (!h || !/^Bearer /i.test(h) || h.length > 4096) return null;
    try {
      const payload: any = this.jwt.verify(h.slice(7), { secret: this.config.get('jwt.secret'), algorithms: ['HS256'], issuer: this.config.get('jwt.issuer'), audience: this.config.get('jwt.audience') });
      if (payload?.pending2fa) return null;
      const u = await this.strategy.validate(payload);
      return u.type === UserType.CUSTOMER ? u : null;
    } catch {
      return null;
    }
  }

  /**
   * Decide which bot a request talks to and whether the caller's Origin may use it.
   *  - botKey            -> embedded bot of ONE restaurant; Origin must be in THAT restaurant's allowedOrigins
   *                         (no Origin header is accepted only outside production, for curl / local tests)
   *  - restaurantSlug    -> the main website's bot scoped to a restaurant (Origin must be a FORKY web origin, or absent)
   *  - neither           -> the central FORKY bot (same origin rule)
   */
  async resolveScope(input: { botKey?: string; restaurantSlug?: string }, req: any): Promise<Scope> {
    const origin = this.originOf(req);
    const prod = this.config.get('env') === 'production';
    if (!this.cfg.platformEnabled()) throw new ForbiddenException('The ordering assistant is currently turned off.');
    if (input.botKey) {
      if (!this.cfg.embedEnabled()) throw new ForbiddenException('The embedded ordering assistant is currently turned off.');
      const r = await this.cfg.findByBotKey(input.botKey);
      if (!r) throw new NotFoundException('Unknown assistant key');
      const cfg = this.cfg.effective(r);
      if (!this.cfg.isActive(r)) throw new ForbiddenException('This assistant is turned off.');
      if (!origin) {
        if (prod) throw new ForbiddenException('This website is not allowed to use the assistant.');
      } else if (!this.cfg.originAllowedForRestaurant(cfg, origin)) {
        throw new ForbiddenException('This website is not allowed to use this assistant. Add it to the allowed websites in the restaurant portal.');
      }
      return { mode: 'embedded', restaurant: r, cfg, canScope: false, origin };
    }
    if (origin && !this.cfg.isSiteOrigin(origin)) throw new ForbiddenException('This website is not allowed to use this assistant.');
    if (input.restaurantSlug) {
      const r = await this.ds.getRepository(Restaurant).findOne({ where: { slug: input.restaurantSlug } });
      if (!r || ![RestaurantStatus.LIVE, RestaurantStatus.PAUSED].includes(r.status)) throw new NotFoundException('Restaurant not found');
      if (!this.cfg.isActive(r)) throw new ForbiddenException('This assistant is turned off.');
      return { mode: 'site', restaurant: r, cfg: this.cfg.effective(r), canScope: false, origin };
    }
    if (!this.cfg.centralConfig().enabled) throw new ForbiddenException('The FORKY assistant is currently turned off.');
    return { mode: 'site', restaurant: null, cfg: null, canScope: true, origin };
  }

  async publicConfig(input: { botKey?: string; restaurantSlug?: string }, req: any) {
    const s = await this.resolveScope(input, req);
    if (!s.restaurant) {
      const c = this.cfg.centralConfig();
      return { enabled: true, name: c.name, greeting: c.greeting, color: c.color, logoUrl: this.cfg.absLogo(c.logoUrl) ?? this.cfg.defaultAvatar(), restaurant: null, mode: s.mode, chips: this.cfg.centralStarterChips() };
    }
    return {
      enabled: true,
      name: s.cfg!.name,
      greeting: s.cfg!.greeting,
      color: s.cfg!.color,
      /** the logo FORKY set for this assistant, else the restaurant's own logo, else null */
      logoUrl: this.cfg.absLogo(s.cfg!.logoUrl) ?? this.knowledge.absUrl(s.restaurant.logoUrl) ?? this.cfg.defaultAvatar(),
      restaurant: { id: s.restaurant.id, slug: s.restaurant.slug, name: s.restaurant.name, logoUrl: this.knowledge.absUrl(s.restaurant.logoUrl) },
      mode: s.mode,
    };
  }

  // ================================================================== sessions
  private ttlMs() {
    return Math.max(1, this.settings.get<number>('assistant.sessionTtlHours', 24)) * 3_600_000;
  }

  /** per-session limit: 12 messages / minute (the per-IP limit of 30 / minute is a @Throttle on the route) */
  private checkSessionRate(sessionId: string) {
    const now = Date.now();
    const hits = (this.sessionHits.get(sessionId) ?? []).filter((t) => now - t < 60_000);
    if (hits.length >= 12) throw new HttpException({ statusCode: 429, message: 'You are sending messages too fast. Please wait a few seconds.', code: 'SESSION_RATE_LIMIT', retryAfterSeconds: 10 }, 429);
    hits.push(now);
    this.sessionHits.set(sessionId, hits);
    if (this.sessionHits.size > 5000) for (const [k, v] of this.sessionHits) if (!v.some((t) => now - t < 60_000)) this.sessionHits.delete(k);
  }

  private async loadSession(id: string | undefined, scope: Scope, customerId: string | null): Promise<AssistantSession | null> {
    if (!id) return null;
    const s = await this.ds.getRepository(AssistantSession).findOne({ where: { id } });
    if (!s || s.expiresAt.getTime() < Date.now()) return null;
    if (s.mode !== scope.mode) return null;
    if (scope.restaurant && s.restaurantId !== scope.restaurant.id) return null; // embedded / slug-scoped bots are locked to their restaurant
    if (s.customerId && s.customerId !== customerId) return null;
    return s;
  }

  private newSession(scope: Scope, customerId: string | null): AssistantSession {
    const now = new Date();
    return this.ds.getRepository(AssistantSession).create({
      restaurantId: scope.restaurant?.id ?? null,
      customerId,
      mode: scope.mode,
      origin: scope.mode === 'embedded' ? scope.origin : null,
      cart: [],
      orderNote: null,
      pending: null,
      transcript: [],
      messageCount: 0,
      cartTouched: false,
      handoffCount: 0,
      lastActiveAt: now,
      expiresAt: new Date(now.getTime() + this.ttlMs()),
    });
  }

  // ================================================================== chat
  async chat(dto: AssistantChatDto, req: any) {
    const message = (dto.message ?? '').replace(/\s+/g, ' ').trim();
    const quick = dto.quick?.trim() || null;
    if (!message && !quick) throw new BadRequestException('message must not be empty');
    if (quick && !isValidQuick(quick)) throw new BadRequestException('quick is not a valid reply payload');

    const customer = await this.optionalCustomer(req);
    const scope = await this.resolveScope({ botKey: dto.botKey, restaurantSlug: dto.restaurantSlug }, req);
    const repo = this.ds.getRepository(AssistantSession);
    let session = await this.loadSession(dto.sessionId, scope, customer?.id ?? null);
    const isNew = !session;
    if (!session) session = this.newSession(scope, customer?.id ?? null);
    if (session.id) this.checkSessionRate(session.id);
    const max = this.settings.get<number>('assistant.maxMessagesPerSession', 200);
    if (session.messageCount >= max) {
      throw new HttpException({ statusCode: 429, message: 'This chat has reached its message limit. Please start a new chat.', code: 'SESSION_LIMIT' }, 429);
    }
    if (customer && !session.customerId) session.customerId = customer.id;
    if (isNew) {
      session = await repo.save(session);
      this.checkSessionRate(session.id);
    }
    const canScope = scope.canScope;

    // ---- the restaurant (if any) and what the bot may say about it
    let kb: Knowledge | null = null;
    let unavailable = false;
    if (session.restaurantId) {
      const row = await this.ds.getRepository(Restaurant).findOne({ where: { id: session.restaurantId } });
      if (row && !this.cfg.forcedOff(row)) kb = await this.knowledge.forRestaurant(session.restaurantId);
      if (!kb) {
        unavailable = true;
        if (canScope) {
          // a central chat whose restaurant went away: back to the central bot
          session.restaurantId = null;
          session.cart = [];
          session.pending = null;
          unavailable = false;
        }
      }
    }
    const directory: DirectoryEntry[] | null = !kb && canScope ? await this.knowledge.directory() : null;

    // ---- logged-in customers: the FORKY server cart is the source of truth for this restaurant
    const loggedIn = !!customer;
    let realSig = '';
    let replaced: string | null = null;
    if (customer && kb && session.restaurantId) {
      const real = await this.cart.getOrCreate(customer.id);
      if (real.restaurantId === session.restaurantId && real.items.length) {
        session.cart = real.items.map((l) => ({ lineId: l.lineId ?? randomUUID(), menuItemId: l.menuItemId, quantity: l.quantity, modifierOptionIds: l.modifierOptionIds ?? [], ...(l.notes ? { notes: l.notes } : {}) }));
      }
      realSig = this.signature(real.restaurantId === session.restaurantId ? real.items : []);
      if (real.restaurantId && real.restaurantId !== session.restaurantId && real.items.length) {
        const other = await this.ds.getRepository(Restaurant).findOne({ where: { id: real.restaurantId }, select: ['id', 'name'] });
        replaced = other?.name ?? 'another restaurant';
      }
    }

    // ---- run the brain on a draft copy of the state
    const draft: SessionDraft = {
      restaurantId: session.restaurantId,
      cart: JSON.parse(JSON.stringify(session.cart ?? [])),
      orderNote: session.orderNote,
      pending: session.pending ? JSON.parse(JSON.stringify(session.pending)) : null,
      messageCount: session.messageCount,
    };
    const before = JSON.stringify([draft.cart, draft.orderNote]);
    const geo = typeof dto.lat === 'number' && typeof dto.lng === 'number' ? { lat: dto.lat, lng: dto.lng } : null;
    const tools = kb ? new DeterministicTools(kb, draft) : null;
    const ctx: BrainContext = {
      sessionId: session.id,
      // the central bot's FAQs live in its trained knowledge base now (Admin > Assistant > Training); only the starter chips come from the configuration
      ...(canScope ? { starterChips: this.cfg.centralStarterChips() } : {}),
      message,
      quick,
      now: new Date(),
      scope: kb ? 'restaurant' : 'central',
      mode: scope.mode,
      canScope,
      loggedIn,
      kb,
      directory,
      geo,
      draft,
      tools,
      cart: () => summarizeCart(kb, draft.cart),
    };

    let result: BotResult;
    let activeKb = kb;
    if (unavailable) {
      result = { text: 'This restaurant is not available for ordering right now. Please try again later.', chips: [] };
    } else if (draft.pending?.kind === 'switch' && canScope) {
      // the visitor is answering "switch restaurant? this clears your cart"
      const yes = quick === 'confirm' || (!quick && /^(yes|yeah|yep|sure|ok|okay|confirm|switch|do it|go ahead)\b/i.test(message));
      const target = draft.pending.slug;
      draft.pending = null;
      if (yes) {
        const sw = await this.scopeTo(session, draft, target, true);
        result = sw.result;
        activeKb = sw.kb;
      } else {
        result = { text: `Okay, staying with ${kb?.restaurant.name ?? 'your current restaurant'}.`, chips: [chip('Menu', 'menu'), chip('View cart', 'cart')] };
      }
    } else {
      result = await this.runBrain(ctx, session, draft, canScope);
      if (result.scopeTo && canScope) {
        const sw = await this.scopeTo(session, draft, result.scopeTo, false, result);
        result = sw.result;
        activeKb = sw.kb;
      }
    }

    // ---- logged-in: mirror cart changes into the customer's real FORKY cart (same effect as POST /customer/cart/replace)
    const after = JSON.stringify([draft.cart, draft.orderNote]);
    if (customer && draft.restaurantId && activeKb && (before !== after || this.signature(draft.cart) !== realSig)) {
      try {
        if (!draft.cart.length) {
          const real = await this.cart.getOrCreate(customer.id);
          if (real.restaurantId === draft.restaurantId && real.items.length) await this.cart.clear(customer.id);
        } else if (this.signature(draft.cart) !== realSig) {
          await this.cart.replace(customer.id, { restaurantId: draft.restaurantId, items: draft.cart.map((l) => ({ menuItemId: l.menuItemId, quantity: l.quantity, modifierOptionIds: l.modifierOptionIds, notes: l.notes })) });
          if (replaced) result = { ...result, text: `${result.text}\n(Your earlier FORKY cart from ${replaced} was replaced, because a cart holds one restaurant at a time.)` };
        }
      } catch (e) {
        const msg = e instanceof HttpException ? ((e.getResponse() as any)?.message ?? e.message) : 'unknown error';
        this.logger.warn(`could not mirror assistant cart to customer cart: ${msg}`);
        result = { ...result, text: `${result.text}\n(I couldn't update your FORKY cart: ${Array.isArray(msg) ? msg.join(', ') : msg}.)` };
      }
    }

    // ---- persist
    const now = new Date();
    const reply = this.shape(result);
    const messageId = randomBytes(6).toString('hex');
    (reply as any).messageId = messageId;
    if (result.feedback) (reply as any).feedback = true;
    session.restaurantId = draft.restaurantId;
    session.cart = draft.cart;
    session.orderNote = draft.orderNote;
    session.pending = draft.pending;
    session.messageCount += 1;
    if (draft.cart.length) session.cartTouched = true;
    session.lastActiveAt = now;
    session.expiresAt = new Date(now.getTime() + this.ttlMs());
    const t = (s: string) => s.slice(0, 500);
    session.transcript = [...(session.transcript ?? []), { role: 'user' as const, text: t(quick ? `[${quick.split(':')[0]}] ${message}` : message), at: now.toISOString() }, { role: 'bot' as const, text: t(reply.text), at: now.toISOString(), id: messageId, entry: result.entryId ?? null }].slice(-30);
    await repo.save(session);

    return this.response(session, activeKb, reply, loggedIn);
  }

  /** run the brain; a central-site visitor who already chose a restaurant can still say "switch to X" */
  private async runBrain(ctx: BrainContext, session: AssistantSession, draft: SessionDraft, canScope: boolean): Promise<BotResult> {
    if (canScope && ctx.kb && !ctx.quick && SWITCH_INTENT.test(ctx.message.toLowerCase())) {
      const directory = await this.knowledge.directory();
      const probe = new CentralRun({ ...ctx, kb: null, scope: 'central', directory, draft: { ...draft, restaurantId: null } }).run();
      if (probe.scopeTo || probe.restaurants?.length) {
        if (probe.scopeTo === ctx.kb.restaurant.slug) return { text: `You're already ordering from ${ctx.kb.restaurant.name}.`, chips: [chip('Menu', 'menu'), chip('View cart', 'cart')] };
        return probe;
      }
    }
    return this.brains.respond(ctx);
  }

  /** scope a central session to a restaurant (asks first when a cart with items would be thrown away) */
  private async scopeTo(session: AssistantSession, draft: SessionDraft, slug: string, confirmed: boolean, via?: BotResult): Promise<{ result: BotResult; kb: Knowledge | null }> {
    const dir = await this.knowledge.directory();
    const entry = dir.find((e) => e.slug === slug);
    if (!entry) return { result: { text: "I couldn't find that restaurant. What are you craving?", chips: [] }, kb: null };
    if (entry.id !== draft.restaurantId && draft.cart.length && !confirmed) {
      const cur = await this.ds.getRepository(Restaurant).findOne({ where: { id: draft.restaurantId! }, select: ['id', 'name'] });
      const n = draft.cart.reduce((s, l) => s + l.quantity, 0);
      draft.pending = { kind: 'switch', slug };
      return { result: { text: `Switching to ${entry.name} will clear your current cart (${n} item${n > 1 ? 's' : ''} from ${cur?.name ?? 'the current restaurant'}). Continue?`, chips: [chip('Yes, switch', 'confirm'), chip('No, stay', 'cancel')] }, kb: await this.knowledge.forRestaurant(draft.restaurantId!) };
    }
    if (entry.id !== draft.restaurantId) {
      draft.restaurantId = entry.id;
      draft.cart = [];
      draft.orderNote = null;
      draft.pending = null;
      session.restaurantId = entry.id;
    }
    const kb = await this.knowledge.forRestaurant(entry.id);
    if (!kb) return { result: { text: `${entry.name} is not available for ordering right now.`, chips: [] }, kb: null };
    const text = `${via?.text ? `${via.text} ` : ''}${kb.greeting ?? ''}`.trim();
    return { result: { text, chips: [chip('Menu', 'menu'), chip('Popular', 'popular'), chip('Hours', 'hours')], restaurants: undefined }, kb };
  }

  /** BotResult -> contract reply (limits applied, no empty arrays) */
  private shape(r: BotResult) {
    const reply: { text: string; cards?: any[]; restaurants?: any[]; chips?: BotChip[] } = { text: String(r.text ?? '').slice(0, 1800) };
    const cards = (r.cards ?? []).slice(0, MAX_CARDS).map((c) => ({ ...c, imageUrl: c.imageUrl ? this.knowledge.absUrl(c.imageUrl) ?? undefined : undefined }));
    if (cards.length) reply.cards = cards;
    const rs = (r.restaurants ?? []).slice(0, MAX_CARDS).map((x) => ({ ...x, logoUrl: x.logoUrl ? this.knowledge.absUrl(x.logoUrl) ?? undefined : undefined }));
    if (rs.length) reply.restaurants = rs;
    const chips = (r.chips ?? []).slice(0, MAX_CHIPS);
    if (chips.length) reply.chips = chips;
    return reply;
  }

  private response(session: AssistantSession, kb: Knowledge | null, reply: ReturnType<AssistantService['shape']>, loggedIn: boolean) {
    const s = summarizeCart(kb, session.cart);
    const min = kb?.restaurant.minimumOrder ?? 0;
    return {
      sessionId: session.id,
      restaurant: kb ? { id: kb.restaurant.id, slug: kb.restaurant.slug, name: kb.restaurant.name, logoUrl: kb.restaurant.logoUrl } : null,
      reply,
      cart: {
        items: s.lines.map((l) => ({ lineId: l.lineId, menuItemId: l.menuItemId, name: l.name, quantity: l.quantity, unitPrice: l.unitPrice, options: l.options, ...(l.notes ? { notes: l.notes } : {}), lineTotal: l.lineTotal })),
        count: s.count,
        subtotalEstimate: s.subtotal,
      },
      orderNote: session.orderNote,
      canCheckout: !!kb && kb.restaurant.orderable && s.lines.length > 0 && s.subtotal >= min,
      loggedIn,
    };
  }

  private signature(lines: { menuItemId: string; quantity: number; modifierOptionIds?: string[]; notes?: string | null }[]): string {
    return JSON.stringify(
      lines
        .map((l) => [l.menuItemId, l.quantity, [...(l.modifierOptionIds ?? [])].sort(), l.notes ?? ''])
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    );
  }

  /** thumbs up / down on an answer. Nothing is stored here: it is emitted as the in-process event 'assistant.feedback' for a training tool. */
  async feedback(dto: { sessionId: string; messageId?: string; rating: 'up' | 'down'; comment?: string }) {
    const s = await this.ds.getRepository(AssistantSession).findOne({ where: { id: dto.sessionId }, select: ['id', 'restaurantId', 'expiresAt', 'transcript'] });
    if (!s || s.expiresAt.getTime() < Date.now()) throw new NotFoundException('Chat session not found or expired.');
    // which taught answer was rated, and what the customer had asked (the session itself is never stored with the rating)
    const tr = s.transcript ?? [];
    const at = dto.messageId ? tr.findIndex((m) => m.role === 'bot' && m.id === dto.messageId) : -1;
    const entryId = at >= 0 ? tr[at].entry ?? null : null;
    const question = at > 0 && tr[at - 1].role === 'user' ? tr[at - 1].text : null;
    this.events.emit('assistant.feedback', { restaurantId: s.restaurantId, entryId, question, sessionId: s.id, messageId: dto.messageId, rating: dto.rating, comment: dto.comment?.slice(0, 500), at: new Date().toISOString() });
    return { ok: true };
  }

  // ================================================================== hand-off to the FORKY website
  async handoff(dto: { sessionId: string; botKey?: string }, req: any) {
    const customer = await this.optionalCustomer(req);
    const scope = await this.resolveScope({ botKey: dto.botKey }, req);
    const s = await this.loadSession(dto.sessionId, scope, customer?.id ?? null);
    if (!s) throw new NotFoundException('Chat session not found or expired. Start a new chat.');
    if (!s.restaurantId) throw new BadRequestException('Choose a restaurant and add something to your cart first.');
    const kb = await this.knowledge.forRestaurant(s.restaurantId);
    if (!kb) throw new BadRequestException('This restaurant is not available for ordering right now.');
    const valid = s.cart.filter((l) => kb.items.some((i) => i.id === l.menuItemId));
    if (!valid.length) throw new BadRequestException('Your cart is empty. Add something first.');
    const token = randomBytes(32).toString('base64url');
    const ttl = Math.max(1, this.settings.get<number>('assistant.handoffTtlMinutes', 30));
    const expiresAt = new Date(Date.now() + ttl * 60_000);
    await this.ds.getRepository(AssistantSession).update(s.id, { handoffTokenHash: sha256(token), handoffExpiresAt: expiresAt, handoffUsedAt: null, handoffCount: s.handoffCount + 1, lastActiveAt: new Date() });
    const web = this.config.get<string>('webUrl');
    return { token, url: `${web}/order/handoff?token=${token}`, expiresAt: expiresAt.toISOString() };
  }

  /**
   * The visitor arrived on FORKY with a hand-off token and is logged in: load the session cart into their REAL cart.
   * The token is single use (claimed with one atomic UPDATE) and every line is re-validated against the live menu.
   */
  async importHandoff(user: AuthUser, token: string) {
    const bad = () => new BadRequestException('This checkout link is not valid any more. Go back to the chat and tap Checkout again.');
    if (!/^[A-Za-z0-9_-]{20,128}$/.test(token)) throw bad();
    const hash = sha256(token);
    const claimed: any = await this.ds.query(
      `UPDATE assistant_sessions SET "handoffUsedAt" = now(), "updatedAt" = now() WHERE "handoffTokenHash" = $1 AND "handoffUsedAt" IS NULL AND "handoffExpiresAt" > now() AND "expiresAt" > now() - interval '7 days' RETURNING id`,
      [hash],
    );
    const rows: { id: string }[] = Array.isArray(claimed?.[0]) ? claimed[0] : claimed;
    if (!rows?.length) throw bad();
    const release = () => this.ds.query(`UPDATE assistant_sessions SET "handoffUsedAt" = NULL WHERE id = $1`, [rows[0].id]).catch(() => undefined);
    try {
      const s = await this.ds.getRepository(AssistantSession).findOne({ where: { id: rows[0].id } });
      if (!s || !s.restaurantId) throw bad();
      const restaurant = await this.ds.getRepository(Restaurant).findOne({ where: { id: s.restaurantId } });
      if (!restaurant) throw bad();
      const kb = await this.knowledge.forRestaurant(s.restaurantId);
      const bundles = await this.cart.bundles([...new Set(s.cart.map((l) => l.menuItemId))]);
      const skipped: { name: string; reason: string }[] = [];
      const items: { menuItemId: string; quantity: number; modifierOptionIds: string[]; notes?: string }[] = [];
      for (const l of s.cart) {
        const b = bundles.get(l.menuItemId);
        const name = b?.item.name ?? kb?.items.find((i) => i.id === l.menuItemId)?.name ?? 'Unknown item';
        if (!b || b.item.restaurantId !== s.restaurantId || !b.item.active) {
          skipped.push({ name, reason: 'No longer on the menu' });
          continue;
        }
        if (!b.item.available || kb?.items.find((i) => i.id === l.menuItemId)?.available === false) {
          skipped.push({ name, reason: 'Not available right now' });
          continue;
        }
        const known = new Map<string, { gid: string; ok: boolean }>();
        for (const g of b.groups) for (const o of g.options) known.set(o.id, { gid: g.group.id, ok: o.available });
        const chosen = [...new Set(l.modifierOptionIds ?? [])];
        if (chosen.some((id) => !known.has(id))) {
          skipped.push({ name, reason: 'An option is no longer offered' });
          continue;
        }
        if (chosen.some((id) => !known.get(id)!.ok)) {
          skipped.push({ name, reason: 'An option is out of stock' });
          continue;
        }
        let groupsOk = true;
        for (const g of b.groups) {
          const n = chosen.filter((id) => known.get(id)!.gid === g.group.id).length;
          const min = g.group.required ? Math.max(1, g.group.minSelect) : g.group.minSelect;
          if (n < min || (g.group.maxSelect > 0 && n > g.group.maxSelect)) groupsOk = false;
        }
        if (!groupsOk) {
          skipped.push({ name, reason: 'Its required choices changed' });
          continue;
        }
        items.push({ menuItemId: l.menuItemId, quantity: Math.min(50, Math.max(1, l.quantity)), modifierOptionIds: chosen, notes: l.notes });
      }
      if (!items.length) {
        throw new BadRequestException({ statusCode: 400, message: 'None of the items in your chat cart can be ordered right now.', details: skipped });
      }
      const view = await this.cart.replace(user.id, { restaurantId: s.restaurantId, items });
      await this.ds.getRepository(AssistantSession).update(s.id, { importedAt: new Date() });
      return { restaurant: { id: restaurant.id, slug: restaurant.slug, name: restaurant.name }, cartCount: view.itemCount, orderNote: s.orderNote ?? null, skipped };
    } catch (e) {
      await release();
      throw e;
    }
  }

  // ================================================================== housekeeping
  /**
   * Daily. Sessions are unusable after assistant.sessionTtlHours of inactivity. Their chat content (transcript, cart, note) is wiped at once,
   * and the empty row is kept 35 more days only so the portal's 7-day statistics stay accurate (7 and 30 day windows); then it is deleted.
   */
  @Cron('17 4 * * *')
  async cleanup() {
    try {
      await this.ds.query(`UPDATE assistant_sessions SET transcript = '[]'::jsonb, cart = '[]'::jsonb, "orderNote" = NULL, pending = NULL, "handoffTokenHash" = NULL WHERE "expiresAt" < now() AND (transcript <> '[]'::jsonb OR cart <> '[]'::jsonb OR "orderNote" IS NOT NULL OR "handoffTokenHash" IS NOT NULL)`);
      const del: any = await this.ds.query(`DELETE FROM assistant_sessions WHERE "expiresAt" < now() - interval '35 days'`);
      this.logger.log(`assistant cleanup done (${Array.isArray(del) ? del[1] ?? 0 : 0} deleted)`);
    } catch (e) {
      this.logger.warn(`assistant cleanup failed: ${(e as Error).message}`);
    }
  }
}

