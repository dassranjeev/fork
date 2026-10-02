import { BadRequestException, Body, ConflictException, Get, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Repository } from 'typeorm';
import { City, DriverProfile, Incident, OpsChecklist, Zone } from '../database/entities';
import { AdminController, Permission } from '../common/decorators';
import { AuthUser } from '../common/auth.types';
import { Action, ACTIVE_ORDER_STATUSES, DriverStatus, Module as Mod } from '../common/enums';
import { paginateQb } from '../common/pagination';
import { zonedParts } from '../core/core.module';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { ChecklistItemDto, ChecklistNotesDto, ChecklistQuery, ChecklistTemplateDto, CompleteChecklistDto, CurrentChecklistQuery, SupplyQuery } from './dto';

type Kind = 'OPEN' | 'CLOSE';
type Template = { key: string; label: string }[];

const FALLBACK_TEMPLATES: Record<Kind, Template> = {
  OPEN: [
    { key: 'system_health', label: 'Check system health (API, database, realtime)' },
    { key: 'payment_gateway', label: 'Check payment gateway status' },
    { key: 'supply_forecast', label: 'Review driver supply forecast per zone' },
    { key: 'supply_alerts', label: 'Send supply alerts / boosts to zones predicted short' },
    { key: 'restaurant_tablets', label: 'Call restaurants whose tablets are not online at opening' },
  ],
  CLOSE: [
    { key: 'no_open_orders', label: 'Confirm there are no open orders' },
    { key: 'review_late_orders', label: 'Review late orders' },
    { key: 'review_cancelled_refunded', label: 'Review cancelled and refunded orders' },
    { key: 'log_incidents', label: 'Log incidents' },
    { key: 'handover_notes', label: 'Write handover notes for the next shift' },
  ],
};

const DEFAULT_TZ = 'America/Toronto';

// ============================================================ SOP-03 checklists
@Injectable()
export class ChecklistsService {
  constructor(
    @InjectRepository(OpsChecklist) private repo: Repository<OpsChecklist>,
    @InjectRepository(City) private cities: Repository<City>,
    @InjectRepository(Incident) private incidents: Repository<Incident>,
    @InjectDataSource() private ds: DataSource,
    private settings: SettingsService,
    private audit: AuditService,
  ) {}

  templates(): Record<Kind, Template> {
    const t = this.settings.get<Record<Kind, Template>>('operations.checklistTemplates', FALLBACK_TEMPLATES);
    return { OPEN: t?.OPEN ?? FALLBACK_TEMPLATES.OPEN, CLOSE: t?.CLOSE ?? FALLBACK_TEMPLATES.CLOSE };
  }

  async setTemplate(kind: Kind, dto: ChecklistTemplateDto, req: any) {
    const keys = dto.items.map((i) => i.key);
    if (new Set(keys).size !== keys.length) throw new BadRequestException('Item keys must be unique');
    const before = this.templates();
    const next = { ...before, [kind]: dto.items };
    await this.settings.set('operations.checklistTemplates', next);
    await this.audit.logReq(req, 'ops_checklist.template', 'setting', 'operations.checklistTemplates', before[kind], dto.items);
    return next;
  }

  private async tzFor(cityId?: string | null) {
    if (!cityId) return DEFAULT_TZ;
    const c = await this.cities.findOne({ where: { id: cityId } });
    if (!c) throw new BadRequestException('Unknown cityId');
    return c.timezone;
  }

  /** Idempotent get-or-create of one checklist from the template. */
  private async ensure(date: string, kind: Kind, cityId: string | null) {
    let cl = await this.repo.findOne({ where: { date, kind, cityId: cityId ?? IsNull() } });
    if (!cl) {
      cl = await this.repo.save(this.repo.create({ date, kind, cityId, items: this.templates()[kind].map((t) => ({ key: t.key, label: t.label, done: false })), notes: null }));
    }
    return cl;
  }

  /** Today's (or `date`'s) OPEN + CLOSE checklists for a city; creates them on first call. */
  async current(q: CurrentChecklistQuery) {
    const tz = await this.tzFor(q.cityId);
    const date = q.date ?? zonedParts(new Date(), tz).date;
    const cityId = q.cityId ?? null;
    const [open, close] = await Promise.all([this.ensure(date, 'OPEN', cityId), this.ensure(date, 'CLOSE', cityId)]);
    return { date, cityId, open: await this.view(open), close: await this.view(close) };
  }

  async list(q: ChecklistQuery) {
    const qb = this.repo.createQueryBuilder('c');
    if (q.cityId) qb.andWhere('c.cityId = :city', { city: q.cityId });
    if (q.kind) qb.andWhere('c.kind = :k', { k: q.kind });
    if (q.from) qb.andWhere('c.date >= :from', { from: q.from });
    if (q.to) qb.andWhere('c.date <= :to', { to: q.to });
    if (q.completed !== undefined) qb.andWhere(q.completed === 'true' ? 'c.completedAt IS NOT NULL' : 'c.completedAt IS NULL');
    const page = await paginateQb(qb, q, { sortable: { date: 'c.date', kind: 'c.kind' }, defaultSort: ['c.date', 'DESC'] });
    return { ...page, data: page.data.map((c) => this.summary(c)) };
  }

  private summary(c: OpsChecklist) {
    const done = c.items.filter((i) => i.done).length;
    return { ...c, progress: { done, total: c.items.length, pct: c.items.length ? Math.round((done / c.items.length) * 100) : 0 } };
  }

  private async view(c: OpsChecklist) {
    const base = this.summary(c);
    if (c.kind !== 'CLOSE') return base;
    return { ...base, closeSummary: await this.closeSummary(c) };
  }

  /** SOP-03 close step: open orders, late / cancelled / refunded orders and incidents for the day. */
  private async closeSummary(c: OpsChecklist) {
    const tz = await this.tzFor(c.cityId);
    const params: any[] = [c.date, tz];
    let cityFilter = '';
    if (c.cityId) {
      params.push(c.cityId);
      cityFilter = ` AND o."cityId" = $3`;
    }
    const active = ACTIVE_ORDER_STATUSES.map((s) => `'${s}'`).join(',');
    const [row] = await this.ds.query(
      `SELECT
         COUNT(*) FILTER (WHERE o.status IN (${active}))::int AS "openOrders",
         COUNT(*) FILTER (WHERE o."isLate")::int AS "lateOrders",
         COUNT(*) FILTER (WHERE o.status IN ('CANCELLED','REJECTED'))::int AS "cancelledOrders",
         COUNT(*) FILTER (WHERE o.status IN ('DELIVERED','COLLECTED'))::int AS "completedOrders",
         COUNT(*)::int AS "totalOrders",
         COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM payments p WHERE p."orderId" = o.id AND p.kind = 'REFUND'))::int AS "refundedOrders"
       FROM orders o
       WHERE (o."createdAt" AT TIME ZONE $2)::date = $1::date ${cityFilter}`,
      params,
    );
    const incidents = await this.incidents
      .createQueryBuilder('i')
      .where(`(i."createdAt" AT TIME ZONE :tz)::date = :d::date`, { tz, d: c.date })
      .getMany();
    return { ...row, incidents: incidents.map((i) => ({ id: i.id, title: i.title, severity: i.severity, status: i.status })) };
  }

  async get(id: string) {
    const c = await this.repo.findOne({ where: { id } });
    if (!c) throw new NotFoundException('Checklist not found');
    return this.view(c);
  }

  private async load(id: string) {
    const c = await this.repo.findOne({ where: { id } });
    if (!c) throw new NotFoundException('Checklist not found');
    return c;
  }

  async setItem(id: string, key: string, dto: ChecklistItemDto, user: AuthUser, req: any) {
    const c = await this.load(id);
    if (c.completedAt) throw new ConflictException('Checklist already completed');
    const item = c.items.find((i) => i.key === key);
    if (!item) throw new NotFoundException('Checklist item not found');
    item.done = dto.done;
    if (dto.done) {
      item.doneAt = new Date().toISOString();
      item.doneBy = user?.email || user?.name || user?.id;
    } else {
      delete item.doneAt;
      delete item.doneBy;
    }
    c.items = [...c.items];
    await this.repo.save(c);
    await this.audit.logReq(req, 'ops_checklist.item', 'ops_checklist', id, undefined, { key, done: dto.done });
    return this.view(c);
  }

  async setNotes(id: string, dto: ChecklistNotesDto, req: any) {
    const c = await this.load(id);
    c.notes = dto.notes;
    await this.repo.save(c);
    await this.audit.logReq(req, 'ops_checklist.notes', 'ops_checklist', id);
    return this.view(c);
  }

  async complete(id: string, dto: CompleteChecklistDto, user: AuthUser, req: any) {
    const c = await this.load(id);
    if (c.completedAt) throw new ConflictException('Checklist already completed');
    const pending = c.items.filter((i) => !i.done);
    if (pending.length && !dto.force) {
      throw new ConflictException({ message: `${pending.length} checklist items are still open. Tick them or complete with force=true.`, pending: pending.map((p) => p.key) } as any);
    }
    if (dto.notes !== undefined) c.notes = dto.notes;
    c.completedAt = new Date();
    c.completedById = user?.id ?? null;
    await this.repo.save(c);
    await this.audit.logReq(req, 'ops_checklist.complete', 'ops_checklist', id, undefined, { kind: c.kind, date: c.date, forced: pending.length > 0, pending: pending.map((p) => p.key) });
    return this.view(c);
  }

  async reopen(id: string, req: any) {
    const c = await this.load(id);
    c.completedAt = null;
    c.completedById = null;
    await this.repo.save(c);
    await this.audit.logReq(req, 'ops_checklist.reopen', 'ops_checklist', id);
    return this.view(c);
  }
}

// ============================================================ supply / demand
@Injectable()
export class SupplyService {
  constructor(
    @InjectRepository(Zone) private zones: Repository<Zone>,
    @InjectRepository(City) private cities: Repository<City>,
    @InjectRepository(DriverProfile) private drivers: Repository<DriverProfile>,
    @InjectDataSource() private ds: DataSource,
    private settings: SettingsService,
  ) {}

  /**
   * Drivers online vs open orders per zone (+ 3 h demand forecast from the same weekday/hour over the last 4 weeks).
   * Flags: CRITICAL (demand, no drivers), SHORT, OK, SURPLUS.
   */
  async supply(q: SupplyQuery) {
    const cities = await this.cities.find({ where: q.cityId ? { id: q.cityId } : { active: true } });
    const perDriverHour = this.settings.get<number>('operations.supplyOrdersPerDriverHour', 2.5) || 2.5;
    const cityIds = cities.map((c) => c.id);
    if (!cityIds.length) return { generatedAt: new Date().toISOString(), zones: [], totals: { onlineDrivers: 0, openOrders: 0, unassignedOrders: 0 }, alerts: [] };
    const zones = await this.zones.createQueryBuilder('z').where('z.cityId IN (:...cityIds)', { cityIds }).andWhere('z.active = true').orderBy('z.name', 'ASC').getMany();
    const zoneIds = zones.map((z) => z.id);

    const activeList = ACTIVE_ORDER_STATUSES.map((s) => `'${s}'`).join(',');
    const drv: any[] = zoneIds.length
      ? await this.ds.query(
          `SELECT "activeZoneId" AS "zoneId",
              COUNT(*)::int AS online,
              COUNT(*) FILTER (WHERE "onTrip")::int AS "onTrip"
           FROM driver_profiles
           WHERE "isOnline" = true AND status = $1 AND "activeZoneId" = ANY($2::uuid[])
           GROUP BY "activeZoneId"`,
          [DriverStatus.ACTIVE, zoneIds],
        )
      : [];
    const ord: any[] = zoneIds.length
      ? await this.ds.query(
          `SELECT "zoneId",
              COUNT(*)::int AS open,
              COUNT(*) FILTER (WHERE "driverId" IS NULL AND type = 'DELIVERY' AND fulfilment = 'PLATFORM_DRIVER')::int AS unassigned,
              COUNT(*) FILTER (WHERE "isLate")::int AS late
           FROM orders
           WHERE status IN (${activeList}) AND "zoneId" = ANY($1::uuid[])
           GROUP BY "zoneId"`,
          [zoneIds],
        )
      : [];
    const hourly: any[] = zoneIds.length
      ? await this.ds.query(
          `SELECT "zoneId", COUNT(*)::int AS n FROM orders
           WHERE "zoneId" = ANY($1::uuid[]) AND "createdAt" > now() - interval '1 hour' AND status NOT IN ('CANCELLED','REJECTED')
           GROUP BY "zoneId"`,
          [zoneIds],
        )
      : [];
    const dm = new Map(drv.map((d) => [d.zoneId, d]));
    const om = new Map(ord.map((o) => [o.zoneId, o]));
    const hm = new Map(hourly.map((h) => [h.zoneId, h.n]));
    const forecasts = await this.forecast(cities, zoneIds);

    const rows = zones.map((z) => {
      const d = dm.get(z.id) ?? { online: 0, onTrip: 0 };
      const o = om.get(z.id) ?? { open: 0, unassigned: 0, late: 0 };
      const idle = d.online - d.onTrip;
      const ratio = d.online ? +(o.open / d.online).toFixed(2) : o.open ? null : 0;
      const fc = forecasts.get(z.id) ?? [];
      const peakNeed = fc.reduce((m, f) => Math.max(m, f.driversNeeded), 0);
      const target = Math.max(z.targetDrivers, 0);
      const alerts: string[] = [];
      let status: 'OK' | 'SHORT' | 'CRITICAL' | 'SURPLUS' = 'OK';
      if (d.online === 0 && (o.open > 0 || peakNeed > 0 || target > 0)) {
        status = 'CRITICAL';
        alerts.push('No drivers online');
      } else if (o.unassigned >= 2 && idle === 0) {
        status = 'CRITICAL';
        alerts.push(`${o.unassigned} unassigned orders and no idle drivers`);
      } else if ((target && d.online < Math.ceil(target * 0.7)) || (ratio !== null && ratio > 2) || d.online < peakNeed) {
        status = 'SHORT';
        if (target && d.online < Math.ceil(target * 0.7)) alerts.push(`Below 70% of target (${d.online}/${target})`);
        if (ratio !== null && ratio > 2) alerts.push(`${ratio} open orders per driver`);
        if (d.online < peakNeed) alerts.push(`Forecast needs ${peakNeed} drivers in the next 3 h`);
      } else if (target && d.online > target * 1.5 && o.open === 0) {
        status = 'SURPLUS';
      }
      if (o.late) alerts.push(`${o.late} late orders`);
      return {
        zoneId: z.id,
        zone: z.name,
        cityId: z.cityId,
        busyMode: z.busyMode,
        targetDrivers: target,
        onlineDrivers: d.online,
        idleDrivers: idle,
        onTripDrivers: d.onTrip,
        openOrders: o.open,
        unassignedOrders: o.unassigned,
        lateOrders: o.late,
        ordersLastHour: hm.get(z.id) ?? 0,
        ordersPerDriver: ratio,
        driverGap: Math.max(0, Math.max(target, peakNeed) - d.online),
        status,
        alerts,
        suggestBusyMode: status !== 'OK' && status !== 'SURPLUS' && !z.busyMode,
        forecast: fc,
      };
    });
    const flagged = rows.filter((r) => r.status === 'SHORT' || r.status === 'CRITICAL');
    return {
      generatedAt: new Date().toISOString(),
      ordersPerDriverHour: perDriverHour,
      zones: rows,
      totals: {
        onlineDrivers: rows.reduce((s, r) => s + r.onlineDrivers, 0),
        openOrders: rows.reduce((s, r) => s + r.openOrders, 0),
        unassignedOrders: rows.reduce((s, r) => s + r.unassignedOrders, 0),
      },
      alerts: flagged.map((r) => ({ zoneId: r.zoneId, zone: r.zone, status: r.status, messages: r.alerts })),
    };
  }

  /** zoneId -> next 3 hourly buckets: avg orders in the same weekday/hour of the past 4 weeks. */
  private async forecast(cities: City[], zoneIds: string[]) {
    const perDriverHour = this.settings.get<number>('operations.supplyOrdersPerDriverHour', 2.5) || 2.5;
    const out = new Map<string, { hourStart: string; expectedOrders: number; driversNeeded: number }[]>();
    for (const city of cities) {
      const now = new Date();
      const wanted = [0, 1, 2].map((k) => {
        const at = new Date(now.getTime() + k * 3600_000);
        const p = zonedParts(at, city.timezone);
        return { dow: p.dow, hour: Math.floor(p.minutes / 60), at };
      });
      const rows: any[] = await this.ds.query(
        `SELECT "zoneId",
            EXTRACT(DOW FROM ("createdAt" AT TIME ZONE $2))::int AS dow,
            EXTRACT(HOUR FROM ("createdAt" AT TIME ZONE $2))::int AS hour,
            COUNT(*)::int AS n
         FROM orders
         WHERE "cityId" = $1 AND "createdAt" > now() - interval '28 days' AND "createdAt" < now() - interval '1 hour'
           AND status NOT IN ('CANCELLED','REJECTED')
         GROUP BY 1,2,3`,
        [city.id, city.timezone],
      );
      for (const zid of zoneIds) {
        const list = wanted.map((w) => {
          const n = rows.filter((r) => r.zoneId === zid && r.dow === w.dow && r.hour === w.hour).reduce((s, r) => s + r.n, 0);
          const expected = +(n / 4).toFixed(1);
          const start = new Date(w.at);
          start.setMinutes(0, 0, 0);
          return { hourStart: start.toISOString(), expectedOrders: expected, driversNeeded: Math.ceil(expected / perDriverHour) };
        });
        if (!out.has(zid)) out.set(zid, list);
      }
    }
    return out;
  }
}

// ============================================================ controllers
@AdminController('operations/checklists')
export class ChecklistsController {
  constructor(private svc: ChecklistsService) {}

  @Get('templates') @Permission(Mod.OPERATIONS, Action.VIEW) templates() {
    return this.svc.templates();
  }
  @Put('templates/:kind') @Permission(Mod.OPERATIONS, Action.EDIT)
  setTemplate(@Param('kind') kind: string, @Body() dto: ChecklistTemplateDto, @Req() req: any) {
    const k = kind.toUpperCase();
    if (k !== 'OPEN' && k !== 'CLOSE') throw new BadRequestException('kind must be OPEN or CLOSE');
    return this.svc.setTemplate(k, dto, req);
  }
  @Get('current') @Permission(Mod.OPERATIONS, Action.VIEW) current(@Query() q: CurrentChecklistQuery) {
    return this.svc.current(q);
  }
  @Get() @Permission(Mod.OPERATIONS, Action.VIEW) list(@Query() q: ChecklistQuery) {
    return this.svc.list(q);
  }
  @Get(':id') @Permission(Mod.OPERATIONS, Action.VIEW) get(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.get(id);
  }
  @Patch(':id/items/:key') @Permission(Mod.OPERATIONS, Action.EDIT)
  item(@Param('id', ParseUUIDPipe) id: string, @Param('key') key: string, @Body() dto: ChecklistItemDto, @Req() req: any) {
    return this.svc.setItem(id, key, dto, req.user, req);
  }
  @Patch(':id/notes') @Permission(Mod.OPERATIONS, Action.EDIT) notes(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ChecklistNotesDto, @Req() req: any) {
    return this.svc.setNotes(id, dto, req);
  }
  @Post(':id/complete') @Permission(Mod.OPERATIONS, Action.EDIT) complete(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CompleteChecklistDto, @Req() req: any) {
    return this.svc.complete(id, dto, req.user, req);
  }
  @Post(':id/reopen') @Permission(Mod.OPERATIONS, Action.APPROVE) reopen(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    return this.svc.reopen(id, req);
  }
}

@AdminController('operations/supply')
export class SupplyController {
  constructor(private svc: SupplyService) {}
  @Get() @Permission(Mod.OPERATIONS, Action.VIEW) supply(@Query() q: SupplyQuery) {
    return this.svc.supply(q);
  }
}
