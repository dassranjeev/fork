import { Body, ForbiddenException, Get, Injectable, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Throttle } from '@nestjs/throttler';
import { DataSource } from 'typeorm';
import { AdminController, CurrentUser, Permission } from '../common/decorators';
import { AuthUser } from '../common/auth.types';
import { hasPermission } from '../common/guards';
import { Action, Module as Mod } from '../common/enums';
import { pageMeta } from '../common/pagination';
import { SettingsService } from '../settings/settings.service';
import { AssistantConfigService } from './assistant-config.service';
import { AssistantRestaurantsQuery, CentralUpdateDto } from './assistant.dto';

const jsonLen = (expr: string) => `CASE WHEN jsonb_typeof(${expr}) = 'array' THEN jsonb_array_length(${expr}) ELSE 0 END`;

/** Data behind the Admin Console "Assistant" sidebar group (overview, restaurant bot list, central bot). */
@Injectable()
export class AssistantAdminService {
  constructor(
    @InjectDataSource() private ds: DataSource,
    private settings: SettingsService,
    private cfg: AssistantConfigService,
  ) {}

  /** platform switches + platform-wide counters. Only what is really stored is reported: unanswered questions are NOT stored. */
  async overview() {
    const win = (d: number) => `
      COUNT(*) FILTER (WHERE "createdAt" > now() - interval '${d} days')::int AS "chats${d}",
      COUNT(*) FILTER (WHERE "createdAt" > now() - interval '${d} days' AND mode = 'embedded')::int AS "embedded${d}",
      COUNT(*) FILTER (WHERE "createdAt" > now() - interval '${d} days' AND mode = 'site')::int AS "site${d}",
      COALESCE(SUM("messageCount") FILTER (WHERE "lastActiveAt" > now() - interval '${d} days'), 0)::int AS "messages${d}",
      COUNT(*) FILTER (WHERE "cartTouched" AND "lastActiveAt" > now() - interval '${d} days')::int AS "carts${d}",
      COALESCE(SUM("handoffCount") FILTER (WHERE "lastActiveAt" > now() - interval '${d} days'), 0)::int AS "handoffs${d}",
      COUNT(*) FILTER (WHERE "importedAt" > now() - interval '${d} days')::int AS "imported${d}"`;
    const [s] = await this.ds.query(`SELECT ${win(7)}, ${win(30)} FROM assistant_sessions`);
    const [r] = await this.ds.query(`
      SELECT COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE COALESCE((meta->'assistant'->>'forcedOff')::boolean, false))::int AS "forcedOff",
        COUNT(*) FILTER (WHERE NOT COALESCE((meta->'assistant'->>'forcedOff')::boolean, false) AND NOT COALESCE((meta->'assistant'->>'enabled')::boolean, true))::int AS disabled,
        COUNT(*) FILTER (WHERE ${jsonLen(`meta->'assistant'->'allowedOrigins'`)} > 0)::int AS "withOrigins"
      FROM restaurants`);
    const pick = (d: number) => ({ chats: s[`chats${d}`], embeddedChats: s[`embedded${d}`], siteChats: s[`site${d}`], messages: s[`messages${d}`], carts: s[`carts${d}`], handoffs: s[`handoffs${d}`], imported: s[`imported${d}`] });
    const sv = (k: string, d: any) => this.settings.get(k, d);
    return {
      platform: {
        enabled: sv('assistant.enabled', true) !== false,
        embedEnabled: sv('assistant.embed.enabled', true) !== false,
        sessionTtlHours: sv('assistant.sessionTtlHours', 24),
        maxMessagesPerSession: sv('assistant.maxMessagesPerSession', 200),
        handoffTtlMinutes: sv('assistant.handoffTtlMinutes', 30),
        centralEnabled: this.cfg.centralConfig().enabled,
      },
      stats: { d7: pick(7), d30: pick(30) },
      restaurants: { total: r.total, active: r.total - r.forcedOff - r.disabled, disabled: r.disabled, forcedOff: r.forcedOff, withOrigins: r.withOrigins },
      // not recorded: the 'assistant.unanswered' event is emitted for a future training tool but nothing stores it yet
      unanswered: { tracked: false, note: 'Unanswered questions are not stored yet. They are emitted as an in-process event for the training tool.' },
      retentionNote: 'Counters are kept for 35 days after a chat expires (the chat content itself is wiped when it expires).',
    };
  }

  /** every restaurant with its bot in ONE query (no N+1): sessions are aggregated once and joined */
  async restaurants(q: AssistantRestaurantsQuery) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 20;
    const params: unknown[] = [];
    const where: string[] = [];
    if (q.search?.trim()) {
      params.push(`%${q.search.trim().replace(/[\\%_]/g, (c) => '\\' + c)}%`);
      where.push(`(r.name ILIKE $${params.length} OR r.slug ILIKE $${params.length})`);
    }
    const forced = `COALESCE((r.meta->'assistant'->>'forcedOff')::boolean, false)`;
    const enabled = `COALESCE((r.meta->'assistant'->>'enabled')::boolean, true)`;
    if (q.status === 'forced_off') where.push(forced);
    else if (q.status === 'disabled') where.push(`NOT ${forced} AND NOT ${enabled}`);
    else if (q.status === 'active') where.push(`NOT ${forced} AND ${enabled}`);
    const sort = ({ name: 'r.name', chats7d: 'COALESCE(s."chats7d", 0)', handoffs7d: 'COALESCE(s."handoffs7d", 0)', lastActivityAt: 's."lastActivityAt"' } as Record<string, string>)[q.sortBy ?? 'chats7d'] ?? 'COALESCE(s."chats7d", 0)';
    const dir = String(q.sortDir ?? (q.sortBy === 'name' ? 'ASC' : 'DESC')).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    params.push(limit, (page - 1) * limit);
    const rows: any[] = await this.ds.query(
      `SELECT r.id, r.name, r.slug, r.status,
         r.meta->'assistant'->>'name' AS "botName",
         ${enabled} AS enabled, ${forced} AS "forcedOff",
         ${jsonLen(`r.meta->'assistant'->'allowedOrigins'`)}::int AS origins,
         (CASE WHEN EXISTS (SELECT 1 FROM assistant_kb_versions WHERE "scopeKey" = 'r:' || r.id)
               THEN (SELECT COUNT(*) FROM assistant_kb_versions kv, jsonb_array_elements(kv.content->'entries') ke
                     WHERE kv."scopeKey" = 'r:' || r.id AND kv.version = (SELECT MAX(version) FROM assistant_kb_versions WHERE "scopeKey" = 'r:' || r.id)
                       AND ke->>'legacyFaq' = 'true' AND jsonb_typeof(ke->'held') IS DISTINCT FROM 'object')
               ELSE ${jsonLen(`r.meta->'assistant'->'faqs'`)} END)::int AS faqs,
         COALESCE(s."chats7d", 0)::int AS "chats7d", COALESCE(s."handoffs7d", 0)::int AS "handoffs7d", s."lastActivityAt",
         COUNT(*) OVER()::int AS "_total"
       FROM restaurants r
       LEFT JOIN (
         SELECT "restaurantId",
           COUNT(*) FILTER (WHERE "createdAt" > now() - interval '7 days') AS "chats7d",
           COALESCE(SUM("handoffCount") FILTER (WHERE "lastActiveAt" > now() - interval '7 days'), 0) AS "handoffs7d",
           MAX("lastActiveAt") AS "lastActivityAt"
         FROM assistant_sessions WHERE "restaurantId" IS NOT NULL GROUP BY "restaurantId"
       ) s ON s."restaurantId" = r.id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY ${sort} ${dir} NULLS LAST, r.name ASC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    const total = rows[0]?._total ?? 0;
    return {
      data: rows.map(({ _total, ...r }) => ({ ...r, botStatus: r.forcedOff ? 'forced_off' : r.enabled ? 'active' : 'disabled' })),
      meta: pageMeta(total, page, limit),
    };
  }
}

@AdminController('assistant')
export class AssistantAdminController {
  constructor(private svc: AssistantAdminService, private cfg: AssistantConfigService) {}

  /** visible to staff with restaurants:view OR settings:view (the platform switches live in settings) */
  @Get('overview')
  overview(@CurrentUser() user: AuthUser) {
    if (!hasPermission(user, Mod.RESTAURANTS, Action.VIEW) && !hasPermission(user, Mod.SETTINGS, Action.VIEW)) throw new ForbiddenException('Missing permission: restaurants:view or settings:view');
    return this.svc.overview();
  }

  @Get('restaurants')
  @Permission(Mod.RESTAURANTS, Action.VIEW)
  restaurants(@Query() q: AssistantRestaurantsQuery) {
    return this.svc.restaurants(q);
  }

  @Get('central')
  @Permission(Mod.SETTINGS, Action.VIEW)
  central() {
    return this.cfg.centralView();
  }

  @Patch('central')
  @Permission(Mod.SETTINGS, Action.EDIT)
  updateCentral(@Body() dto: CentralUpdateDto, @Req() req: any) {
    return this.cfg.updateCentral(dto, req);
  }

  /** same as the portal's rotate-key, for staff (the old key stops working immediately) */
  @Post('restaurants/:id/rotate-key')
  @Permission(Mod.RESTAURANTS, Action.EDIT)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  rotate(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    return this.cfg.rotateKey(id, req);
  }
}
