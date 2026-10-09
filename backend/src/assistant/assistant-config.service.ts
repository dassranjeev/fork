import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { randomBytes } from 'crypto';
import { Restaurant } from '../database/entities';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { AuthUser } from '../common/auth.types';
import { corsAllowlist } from '../common/security';

export interface AssistantConfig {
  enabled: boolean;
  name: string;
  greeting: string;
  color: string | null;
  /** logo set by FORKSY staff (own-origin upload) or null: the widget then shows the restaurant's own logo */
  logoUrl: string | null;
  faqs: { q: string; a: string }[];
  allowedOrigins: string[];
  botKey: string;
}

/** raw shape stored in Restaurant.meta.assistant (all optional; defaults are applied when reading) */
interface StoredAssistant {
  enabled?: boolean;
  name?: string;
  greeting?: string;
  color?: string | null;
  logoUrl?: string | null;
  faqs?: { q: string; a: string }[];
  allowedOrigins?: string[];
  botKey?: string;
  forcedOff?: boolean;
  forcedOffAt?: string;
  forcedOffBy?: string;
}

export interface CentralConfig {
  enabled: boolean;
  name: string;
  greeting: string;
  color: string | null;
  logoUrl: string | null;
  faqs: { q: string; a: string }[];
  chips: { label: string; query: string }[];
}
export const CENTRAL_NAME = 'FORKSY Assistant';
export const CENTRAL_GREETING = "Hi! I'm the FORKSY assistant. Tell me what you're craving and I'll find a restaurant, or say \"order from <restaurant>\".";
export const DEFAULT_CENTRAL_CHIPS = [
  { label: 'Open now', query: 'open now' },
  { label: 'Pizza', query: 'pizza' },
  { label: 'Vegetarian', query: 'vegetarian' },
  { label: 'Burgers', query: 'burgers' },
  { label: 'Indian', query: 'indian' },
  { label: 'Delivery', query: 'delivery' },
];
/** a chip's search text becomes the payload "find:<query>", so it must stay inside the quick-reply grammar */
export const CHIP_QUERY = /^[A-Za-z0-9 ,.'-]{1,60}$/;

export const LOCAL_WILDCARD = 'http://localhost:*';
const isProd = () => process.env.NODE_ENV === 'production';

/**
 * Canonical origin ("https://www.mybistro.ca") or null when `raw` is not a plain origin.
 * Strict: https only (plain http only for localhost / 127.0.0.1 outside production), no path / query / hash / credentials, no wildcards
 * (except the development-only literal "http://localhost:*").
 */
export function normalizeOrigin(raw: string): string | null {
  const s = String(raw ?? '').trim();
  if (!s || s.length > 200) return null;
  if (s === LOCAL_WILDCARD) return isProd() ? null : LOCAL_WILDCARD;
  if (/[\s*]/.test(s)) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.username || u.password || u.search || u.hash) return null;
  if (u.pathname !== '/' && u.pathname !== '') return null;
  if (!/^[a-z0-9.-]+$/.test(u.hostname) && !/^\[[0-9a-f:]+\]$/.test(u.hostname)) return null;
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol === 'https:') {
    if (local && isProd()) return null;
  } else if (u.protocol === 'http:') {
    if (!local || isProd()) return null;
  } else return null;
  if (!local && !u.hostname.includes('.')) return null;
  // `URL.origin` drops default ports and lower-cases the host
  const origin = u.origin;
  // the input must not carry anything beyond the origin (a trailing slash is fine)
  if (s.replace(/\/$/, '').toLowerCase() !== origin.toLowerCase()) return null;
  return origin;
}

/** own-origin upload URL: <PUBLIC_URL>/uploads/<uuid>.(png|jpg|jpeg|webp); svg and everything else is refused */
export function isOwnLogoUrl(raw: string, publicUrl: string): boolean {
  const s = String(raw ?? '').trim();
  const m = /^(https?:\/\/[^/?#\s]+)?\/uploads\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpe?g|webp)$/i.exec(s);
  if (!m) return false;
  return !m[1] || m[1].toLowerCase() === publicUrl.replace(/\/+$/, '').toLowerCase();
}

export const maskKey = (k?: string | null) => (k ? `${k.slice(0, 7)}…` : null);

@Injectable()
export class AssistantConfigService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('AssistantConfig');
  private union = new Set<string>();
  private localWildcard = false;
  private timer?: NodeJS.Timeout;

  constructor(
    @InjectDataSource() private ds: DataSource,
    private config: ConfigService,
    private settings: SettingsService,
    private audit: AuditService,
    private moduleRef: ModuleRef,
  ) {}

  /** the training service (FAQs live in the trained knowledge base); resolved lazily because it needs the menu service, which needs this one */
  private training(): any {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return this.moduleRef.get(require('./training/training.service').TrainingService, { strict: false });
  }

  private scopeOf(r: Pick<Restaurant, 'id' | 'name'>) {
    return { key: `r:${r.id}`, restaurantId: r.id, central: false, label: r.name };
  }

  onModuleInit() {
    this.refreshOrigins().catch(() => undefined);
    this.timer = setInterval(() => this.refreshOrigins().catch((e) => this.logger.warn(`origin refresh failed: ${e.message}`)), 60_000);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  // ------------------------------------------------------------------ platform switches
  platformEnabled(): boolean {
    return this.settings.get<boolean>('assistant.enabled', true) !== false;
  }

  embedEnabled(): boolean {
    return this.settings.get<boolean>('assistant.embed.enabled', true) !== false;
  }

  // ------------------------------------------------------------------ read
  private stored(r: Pick<Restaurant, 'meta'>): StoredAssistant {
    const a = (r.meta ?? {}).assistant;
    return a && typeof a === 'object' ? (a as StoredAssistant) : {};
  }

  forcedOff(r: Pick<Restaurant, 'meta'>): boolean {
    return this.stored(r).forcedOff === true;
  }

  /** the effective configuration with defaults applied (botKey may be '' until it is generated) */
  effective(r: Pick<Restaurant, 'meta' | 'name'>): AssistantConfig {
    const s = this.stored(r);
    const name = typeof s.name === 'string' && s.name.trim() ? s.name.trim().slice(0, 40) : `${r.name} Assistant`.slice(0, 40);
    const greeting = typeof s.greeting === 'string' && s.greeting.trim() ? s.greeting.trim().slice(0, 200) : `Hi! I'm the ${r.name} assistant. Ask me about the menu, get suggestions, or tell me what you'd like to order.`.slice(0, 200);
    return {
      enabled: s.enabled !== false,
      name,
      greeting,
      color: typeof s.color === 'string' && /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/.test(s.color) ? s.color : null,
      logoUrl: typeof s.logoUrl === 'string' && isOwnLogoUrl(s.logoUrl, this.config.get<string>('publicUrl') ?? '') ? s.logoUrl : null,
      faqs: Array.isArray(s.faqs) ? s.faqs.filter((f) => f && typeof f.q === 'string' && typeof f.a === 'string').slice(0, 20) : [],
      allowedOrigins: Array.isArray(s.allowedOrigins) ? s.allowedOrigins.filter((o) => typeof o === 'string').slice(0, 10) : [],
      botKey: typeof s.botKey === 'string' ? s.botKey : '',
    };
  }

  /** is the restaurant's own bot allowed to run at all? (merchant switch, admin force-off, platform switch) */
  isActive(r: Pick<Restaurant, 'meta' | 'name'>): boolean {
    return this.platformEnabled() && !this.forcedOff(r) && this.effective(r).enabled;
  }

  private async load(restaurantId: string): Promise<Restaurant> {
    const r = await this.ds.getRepository(Restaurant).findOne({ where: { id: restaurantId } });
    if (!r) throw new NotFoundException('Restaurant not found');
    return r;
  }

  async findByBotKey(key: string): Promise<Restaurant | null> {
    if (!/^bk_[A-Za-z0-9_-]{24}$/.test(key)) return null;
    return this.ds.getRepository(Restaurant).createQueryBuilder('r').where(`r.meta -> 'assistant' ->> 'botKey' = :k`, { k: key }).getOne();
  }

  // ------------------------------------------------------------------ write helpers
  /** Merge keys into meta.assistant atomically (does not touch the rest of meta, so concurrent meta writers are not clobbered). */
  private async merge(restaurantId: string, patch: Record<string, unknown>) {
    await this.ds.query(
      `UPDATE restaurants SET meta = jsonb_set(COALESCE(meta, '{}'::jsonb), '{assistant}', COALESCE(meta -> 'assistant', '{}'::jsonb) || $1::jsonb, true), "updatedAt" = now() WHERE id = $2`,
      [JSON.stringify(patch), restaurantId],
    );
  }

  private newKey() {
    return `bk_${randomBytes(18).toString('base64url')}`; // 18 bytes -> exactly 24 url-safe chars
  }

  /** the bot key is generated on first read / enable (atomic: two requests cannot create two keys) */
  async ensureKey(r: Restaurant): Promise<string> {
    const cur = this.stored(r).botKey;
    if (cur) return cur;
    const key = this.newKey();
    await this.ds.query(
      `UPDATE restaurants SET meta = jsonb_set(COALESCE(meta, '{}'::jsonb), '{assistant}', COALESCE(meta -> 'assistant', '{}'::jsonb) || jsonb_build_object('botKey', $1::text), true) WHERE id = $2 AND (meta -> 'assistant' ->> 'botKey') IS NULL`,
      [key, r.id],
    );
    const fresh = await this.load(r.id);
    return this.stored(fresh).botKey ?? key;
  }

  embedSnippet(botKey: string): string {
    return `<script src="${this.config.get<string>('publicUrl')}/assistant/widget.js" data-key="${botKey}" async></script>`;
  }

  // ------------------------------------------------------------------ views
  async stats(restaurantId: string) {
    const [row] = await this.ds.query(
      `SELECT
         COUNT(*) FILTER (WHERE "createdAt" > now() - interval '7 days')::int AS "chats7d",
         COALESCE(SUM("messageCount") FILTER (WHERE "lastActiveAt" > now() - interval '7 days'), 0)::int AS "messages7d",
         COUNT(*) FILTER (WHERE "cartTouched" AND "lastActiveAt" > now() - interval '7 days')::int AS "carts7d",
         COALESCE(SUM("handoffCount") FILTER (WHERE "lastActiveAt" > now() - interval '7 days'), 0)::int AS "handoffs7d",
         COUNT(*) FILTER (WHERE "importedAt" > now() - interval '7 days')::int AS "imported7d",
         MAX("lastActiveAt") AS "lastActivityAt"
       FROM assistant_sessions WHERE "restaurantId" = $1`,
      [restaurantId],
    );
    return row ?? { chats7d: 0, messages7d: 0, carts7d: 0, handoffs7d: 0, imported7d: 0 };
  }

  async view(restaurantId: string) {
    let r = await this.load(restaurantId);
    const key = await this.ensureKey(r);
    r = await this.load(restaurantId);
    const config = this.effective(r);
    config.botKey = key;
    return {
      config: { enabled: config.enabled, name: config.name, greeting: config.greeting, color: config.color, logoUrl: config.logoUrl, faqs: await this.training().faqs(this.scopeOf(r)), allowedOrigins: config.allowedOrigins, botKey: config.botKey },
      /** what guests see in the chat header: the logo set by FORKSY, else the restaurant's own logo (absolute URL) or null */
      effectiveLogoUrl: this.absLogo(config.logoUrl) ?? this.absLogo(r.logoUrl) ?? this.defaultAvatar(),
      forcedOff: this.forcedOff(r),
      platformEnabled: this.platformEnabled(),
      embedEnabled: this.embedEnabled(),
      embedSnippet: this.embedSnippet(key),
      stats: await this.stats(restaurantId),
    };
  }

  // ------------------------------------------------------------------ writes
  /** strict validation of the editable fields; returns what to merge into meta.assistant */
  /** the FORKSY icon, served by the API: the default avatar when there is neither an admin logo nor a restaurant logo */
  defaultAvatar(): string {
    return `${this.config.get<string>('publicUrl')}/assistant/forksy-icon.png`;
  }

  /** make an upload path absolute; only http(s) / site-relative values survive */
  absLogo(u: string | null | undefined): string | null {
    if (!u) return null;
    if (/^https?:\/\//i.test(u)) return u;
    if (u.startsWith('/') && !u.startsWith('//')) return `${this.config.get<string>('publicUrl')}${u}`;
    return null;
  }

  validate(dto: { enabled?: boolean; name?: string; greeting?: string; color?: string | null; logoUrl?: string | null; faqs?: { q: string; a: string }[]; allowedOrigins?: string[] }): Record<string, unknown> {
    const patch: Record<string, unknown> = {};
    if (dto.enabled !== undefined) patch.enabled = dto.enabled;
    if (dto.name !== undefined) {
      const n = dto.name.trim();
      if (!n) throw new BadRequestException('name cannot be empty');
      patch.name = n.slice(0, 40);
    }
    if (dto.greeting !== undefined) patch.greeting = dto.greeting.trim().slice(0, 200);
    if (dto.color !== undefined) {
      patch.color = dto.color === null ? null : dto.color.length === 4 ? `#${dto.color[1]}${dto.color[1]}${dto.color[2]}${dto.color[2]}${dto.color[3]}${dto.color[3]}`.toUpperCase() : dto.color.toUpperCase();
    }
    if (dto.logoUrl !== undefined) {
      if (dto.logoUrl === null || dto.logoUrl === '') patch.logoUrl = null;
      else if (!isOwnLogoUrl(dto.logoUrl, this.config.get<string>('publicUrl') ?? '')) throw new BadRequestException('logoUrl must be an image uploaded to FORKSY (png, jpg or webp) through POST /uploads');
      else patch.logoUrl = dto.logoUrl.trim();
    }
    if (dto.allowedOrigins !== undefined) {
      const out: string[] = [];
      const bad: string[] = [];
      for (const raw of dto.allowedOrigins) {
        const o = normalizeOrigin(raw);
        if (!o) bad.push(String(raw).slice(0, 60));
        else if (!out.includes(o)) out.push(o);
      }
      if (bad.length) {
        throw new BadRequestException({
          statusCode: 400,
          message: `Not a valid website origin: ${bad.join(', ')}. Use only the origin, for example https://www.mybistro.ca (https, no path, no wildcard${isProd() ? '' : '; http://localhost:<port> is allowed in development'}).`,
        });
      }
      patch.allowedOrigins = out;
    }
    return patch;
  }

  /** restaurant owner / manager edit */
  async update(restaurantId: string, dto: { faqs?: { q: string; a: string }[]; allowedOrigins?: string[] }, user: AuthUser, req: any) {
    const before = await this.load(restaurantId);
    // defence in depth (the DTO already rejects everything else): a restaurant can only ever write these two keys
    const patch = this.validate({ allowedOrigins: dto.allowedOrigins });
    if (!Object.keys(patch).length && dto.faqs === undefined) throw new BadRequestException('Nothing to update');
    await this.ensureKey(before);
    // the FAQ list is the 'FAQ' entries of the trained knowledge base (guardrails apply; may need approval when the platform asks for it)
    let faq: { status: string } | null = null;
    if (dto.faqs !== undefined) faq = await this.training().setFaqs(this.scopeOf(before), { id: user.id, name: user.name || user.email || 'user', type: 'restaurant', req }, dto.faqs);
    if (Object.keys(patch).length) await this.merge(restaurantId, patch);
    await this.refreshOrigins().catch(() => undefined);
    const after = await this.load(restaurantId);
    await this.audit.logReq(req, 'assistant.update', 'restaurant', restaurantId, this.auditView(before), { ...this.auditView(after), faqs: dto.faqs?.length, faqStatus: faq?.status });
    return { ...(await this.view(restaurantId)), ...(faq?.status === 'REQUESTED' ? { faqApproval: 'REQUESTED' } : {}) };
  }

  /** admin edit (may force-disable) */
  async adminUpdate(restaurantId: string, dto: Parameters<AssistantConfigService['validate']>[0] & { forcedOff?: boolean }, user: AuthUser, req: any) {
    const before = await this.load(restaurantId);
    const { faqs: faqsIn, ...rest } = dto;
    const patch = this.validate(rest);
    if (dto.forcedOff !== undefined) {
      patch.forcedOff = dto.forcedOff;
      if (dto.forcedOff) {
        patch.forcedOffAt = new Date().toISOString();
        patch.forcedOffBy = user.id;
      }
    }
    if (!Object.keys(patch).length && faqsIn === undefined) throw new BadRequestException('Nothing to update');
    await this.ensureKey(before);
    if (faqsIn !== undefined) await this.training().setFaqs(this.scopeOf(before), { id: user.id, name: user.name || user.email || 'user', type: 'staff', req }, faqsIn);
    if (Object.keys(patch).length) await this.merge(restaurantId, patch);
    await this.refreshOrigins().catch(() => undefined);
    const after = await this.load(restaurantId);
    const branding = ['enabled', 'name', 'greeting', 'color', 'logoUrl'].filter((k) => k in patch);
    if (dto.forcedOff !== undefined) await this.audit.logReq(req, `assistant.${dto.forcedOff ? 'force-off' : 'force-off-lifted'}`, 'restaurant', restaurantId, this.auditView(before), this.auditView(after));
    if (branding.length) await this.audit.logReq(req, 'assistant.branding-update', 'restaurant', restaurantId, this.auditView(before), { ...this.auditView(after), changed: branding });
    if (!branding.length && dto.forcedOff === undefined) await this.audit.logReq(req, 'assistant.admin-update', 'restaurant', restaurantId, this.auditView(before), this.auditView(after));
    return this.view(restaurantId);
  }

  async rotateKey(restaurantId: string, req: any) {
    const before = await this.load(restaurantId);
    const key = this.newKey();
    await this.merge(restaurantId, { botKey: key });
    await this.audit.logReq(req, 'assistant.rotate-key', 'restaurant', restaurantId, { botKey: maskKey(this.stored(before).botKey) }, { botKey: maskKey(key) });
    return { botKey: key, embedSnippet: this.embedSnippet(key) };
  }

  /** never put a full bot key (or the FAQ text) in the audit log */
  private auditView(r: Restaurant) {
    const c = this.effective(r);
    return { enabled: c.enabled, name: c.name, greeting: c.greeting, color: c.color, logoUrl: c.logoUrl, allowedOrigins: c.allowedOrigins, forcedOff: this.forcedOff(r), botKey: maskKey(c.botKey) };
  }

  // ------------------------------------------------------------------ central bot (FORKSY website), stored as platform settings
  /** The central bot's configuration. Values come from settings (which the generic settings page can also edit), so they are re-validated on every read. */
  centralConfig(): CentralConfig {
    const g = <T>(k: string, d: T) => this.settings.get<T>(`assistant.central.${k}`, d);
    const str = (v: unknown, max: number, d: string) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : d);
    const color = g<string>('color', '');
    const logo = g<string>('logoUrl', '');
    const faqs = g<unknown>('faqs', []);
    const chips = g<unknown>('chips', []);
    return {
      enabled: g<boolean>('enabled', true) !== false,
      name: str(g('name', ''), 40, CENTRAL_NAME),
      greeting: str(g('greeting', ''), 200, CENTRAL_GREETING),
      color: typeof color === 'string' && /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/.test(color) ? color : null,
      logoUrl: typeof logo === 'string' && isOwnLogoUrl(logo, this.config.get<string>('publicUrl') ?? '') ? logo : null,
      faqs: (Array.isArray(faqs) ? faqs : []).filter((f: any) => f && typeof f.q === 'string' && typeof f.a === 'string' && f.q.trim() && f.a.trim()).slice(0, 20).map((f: any) => ({ q: f.q.trim().slice(0, 120), a: f.a.trim().slice(0, 500) })),
      chips: (Array.isArray(chips) ? chips : []).filter((c: any) => c && typeof c.label === 'string' && typeof c.query === 'string' && c.label.trim() && CHIP_QUERY.test(c.query.trim())).slice(0, 6).map((c: any) => ({ label: c.label.trim().slice(0, 30), query: c.query.trim() })),
    };
  }

  /** chips of the central bot as the chat contract wants them (built-in defaults when none were configured) */
  centralScope() {
    return { key: 'central', restaurantId: null, central: true, label: 'FORKSY website bot' };
  }

  centralStarterChips(): { label: string; payload: string }[] {
    const c = this.centralConfig().chips;
    if (!c.length) return DEFAULT_CENTRAL_CHIPS.map((x) => ({ label: x.label, payload: `find:${x.query}` }));
    return c.map((x) => ({ label: x.label, payload: `find:${x.query}` }));
  }

  async centralView() {
    const c = this.centralConfig();
    const [row] = await this.ds.query(
      `SELECT COUNT(*) FILTER (WHERE "createdAt" > now() - interval '7 days')::int AS "chats7d",
              COALESCE(SUM("messageCount") FILTER (WHERE "lastActiveAt" > now() - interval '7 days'), 0)::int AS "messages7d",
              COUNT(*) FILTER (WHERE "handoffCount" > 0 AND "lastActiveAt" > now() - interval '7 days')::int AS "handoffs7d"
       FROM assistant_sessions WHERE mode = 'site'`,
    );
    return {
      config: { ...c, faqs: await this.training().faqs(this.centralScope()) },
      defaults: { name: CENTRAL_NAME, greeting: CENTRAL_GREETING, chips: DEFAULT_CENTRAL_CHIPS },
      effectiveChips: this.centralStarterChips(),
      effectiveLogoUrl: this.absLogo(c.logoUrl) ?? this.defaultAvatar(),
      platformEnabled: this.platformEnabled(),
      stats: row ?? { chats7d: 0, messages7d: 0, handoffs7d: 0 },
    };
  }

  async updateCentral(dto: { enabled?: boolean; name?: string; greeting?: string; color?: string | null; logoUrl?: string | null; faqs?: { q: string; a: string }[]; chips?: { label: string; query: string }[] }, req: any) {
    const before = this.centralConfig();
    const set: Record<string, unknown> = {};
    if (dto.enabled !== undefined) set.enabled = dto.enabled;
    if (dto.name !== undefined) {
      if (!dto.name.trim()) throw new BadRequestException('name cannot be empty');
      set.name = dto.name.trim().slice(0, 40);
    }
    if (dto.greeting !== undefined) set.greeting = dto.greeting.trim().slice(0, 200) || CENTRAL_GREETING;
    if (dto.color !== undefined) set.color = dto.color === null ? '' : dto.color.length === 4 ? `#${dto.color[1]}${dto.color[1]}${dto.color[2]}${dto.color[2]}${dto.color[3]}${dto.color[3]}`.toUpperCase() : dto.color.toUpperCase();
    if (dto.logoUrl !== undefined) {
      if (dto.logoUrl === null || dto.logoUrl === '') set.logoUrl = '';
      else if (!isOwnLogoUrl(dto.logoUrl, this.config.get<string>('publicUrl') ?? '')) throw new BadRequestException('logoUrl must be an image uploaded to FORKSY (png, jpg or webp) through POST /uploads');
      else set.logoUrl = dto.logoUrl.trim();
    }
    if (dto.chips !== undefined) {
      const chips = dto.chips.map((c) => ({ label: c.label.trim(), query: c.query.trim() }));
      if (chips.some((c) => !c.label || !CHIP_QUERY.test(c.query))) throw new BadRequestException('Each chip needs a label and a search text (letters, digits, spaces and , . \' - only, max 60 characters)');
      set.chips = chips;
    }
    if (!Object.keys(set).length && dto.faqs === undefined) throw new BadRequestException('Nothing to update');
    if (dto.faqs !== undefined) await this.training().setFaqs(this.centralScope(), { id: req?.user?.id ?? 'staff', name: req?.user?.name || req?.user?.email || 'staff', type: 'staff', req }, dto.faqs);
    for (const [k, v] of Object.entries(set)) await this.settings.set(`assistant.central.${k}`, v);
    const after = this.centralConfig();
    const brief = (c: CentralConfig) => ({ enabled: c.enabled, name: c.name, greeting: c.greeting, color: c.color, logoUrl: c.logoUrl, chips: c.chips.map((x) => x.label) });
    await this.audit.logReq(req, 'assistant.central-update', 'settings', undefined, brief(before), { ...brief(after), changed: [...Object.keys(set), ...(dto.faqs !== undefined ? ['faqs'] : [])], faqs: dto.faqs?.length });
    return this.centralView();
  }

  // ------------------------------------------------------------------ origins (CORS)
  async refreshOrigins() {
    const rows: { a: StoredAssistant }[] = await this.ds.query(`SELECT meta -> 'assistant' AS a FROM restaurants WHERE status = 'LIVE' AND meta ? 'assistant'`);
    const next = new Set<string>();
    let wildcard = false;
    for (const row of rows) {
      const a = row.a;
      if (!a || a.enabled === false || a.forcedOff === true) continue;
      for (const o of a.allowedOrigins ?? []) {
        if (o === LOCAL_WILDCARD) wildcard = !isProd();
        else if (typeof o === 'string') next.add(o.toLowerCase());
      }
    }
    this.union = next;
    this.localWildcard = wildcard;
  }

  /** Is `origin` allowed to call the public assistant endpoints at all? (CORS layer; the handlers then check the exact restaurant) */
  originInUnion(origin: string): boolean {
    const o = origin.replace(/\/$/, '').toLowerCase();
    if (!this.platformEnabled()) return corsAllowlist().map((x) => x.toLowerCase()).includes(o);
    if (corsAllowlist().map((x) => x.toLowerCase()).includes(o)) return true;
    if (!this.embedEnabled()) return false;
    if (this.union.has(o)) return true;
    return this.localWildcard && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
  }

  originAllowedForRestaurant(cfg: AssistantConfig, origin: string): boolean {
    const o = origin.replace(/\/$/, '').toLowerCase();
    if (cfg.allowedOrigins.some((x) => x.toLowerCase() === o)) return true;
    return !isProd() && cfg.allowedOrigins.includes(LOCAL_WILDCARD) && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
  }

  /** origins of the FORKSY web apps (env CORS_ORIGINS): allowed for the "site" modes */
  isSiteOrigin(origin: string): boolean {
    return corsAllowlist().map((x) => x.toLowerCase()).includes(origin.replace(/\/$/, '').toLowerCase());
  }
}
