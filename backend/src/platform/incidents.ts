import { BadRequestException, Body, Get, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';
import { Incident } from '../database/entities';
import { AdminController, Permission, PublicController } from '../common/decorators';
import { Action, Module as Mod } from '../common/enums';
import { AuthUser } from '../common/auth.types';
import { paginateQb, like } from '../common/pagination';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RealtimeService } from '../realtime/realtime.module';
import { SettingsService } from '../settings/settings.service';
import { BannerDto, CreateIncidentDto, IncidentQuery, PauseOrdersDto, ReportDto, ResolveIncidentDto, TimelineDto, UpdateIncidentDto } from './dto';

const REPORT_DUE_HOURS = 48; // SOP-10 step 4
const STAKEHOLDER_UPDATE_MIN = 30; // SOP-10 step 3

@Injectable()
export class IncidentsService {
  constructor(
    @InjectRepository(Incident) private repo: Repository<Incident>,
    private audit: AuditService,
    private rt: RealtimeService,
    private settings: SettingsService,
    private notifications: NotificationsService,
  ) {}

  /** Decorate with computed SOP-10 fields. */
  private view(i: Incident) {
    const now = Date.now();
    const open = i.status !== 'RESOLVED';
    const last = i.timeline?.length ? new Date(i.timeline[i.timeline.length - 1].at).getTime() : i.createdAt.getTime();
    return {
      ...i,
      stakeholderUpdateDueAt: open ? new Date(last + STAKEHOLDER_UPDATE_MIN * 60_000) : null,
      stakeholderUpdateOverdue: open && i.severity !== 'P3' && now > last + STAKEHOLDER_UPDATE_MIN * 60_000,
      reportOverdue: !!i.reportDueAt && !i.postIncidentReport && now > i.reportDueAt.getTime(),
    };
  }

  private who(u?: AuthUser) {
    return u?.email || u?.name || u?.id;
  }

  private entry(u: AuthUser | undefined, note: string) {
    return { at: new Date().toISOString(), by: this.who(u), note };
  }

  /** Mirror incident state into public settings (banner text + pause flag) so all apps and OrdersModule can read it cheaply. */
  async syncPublicState() {
    const active = await this.repo.find({ where: [{ status: 'OPEN' }, { status: 'MITIGATED' }], order: { createdAt: 'DESC' } });
    const pausing = active.find((i) => i.pauseNewOrders);
    const banner = active.find((i) => i.bannerActive && i.bannerMessage);
    await this.settings.set('orders.newOrdersPaused', !!pausing);
    await this.settings.set('orders.newOrdersPausedMessage', pausing ? pausing.bannerMessage || 'New orders are temporarily paused. Please try again shortly.' : '');
    const state = { ordersPaused: !!pausing, banner: banner?.bannerMessage ?? null, incidentId: banner?.id ?? pausing?.id ?? null };
    this.rt.emitToRoom('admin:ops', 'incident.state', state);
    return state;
  }

  /** For other modules: are new orders currently paused by an incident? */
  isOrderingPaused(): boolean {
    return !!this.settings.get('orders.newOrdersPaused', false);
  }

  async publicStatus() {
    const active = await this.repo.find({ where: [{ status: 'OPEN' }, { status: 'MITIGATED' }], order: { createdAt: 'DESC' } });
    const pausing = active.find((i) => i.pauseNewOrders);
    const banner = active.find((i) => i.bannerActive && i.bannerMessage);
    return {
      ordersPaused: !!pausing,
      ordersPausedMessage: pausing ? pausing.bannerMessage || 'New orders are temporarily paused. Please try again shortly.' : null,
      banner: banner ? { message: banner.bannerMessage, severity: banner.severity, since: banner.createdAt } : null,
      maintenance: !!this.settings.get('general.maintenanceMode', false),
    };
  }

  async list(q: IncidentQuery) {
    const qb = this.repo.createQueryBuilder('i');
    if (q.status === 'ACTIVE') qb.andWhere(`i.status <> 'RESOLVED'`);
    else if (q.status) qb.andWhere('i.status = :st', { st: q.status });
    if (q.severity) qb.andWhere('i.severity = :sv', { sv: q.severity });
    if (q.reportOverdue === 'true') qb.andWhere('i.reportDueAt < now() AND i.postIncidentReport IS NULL');
    if (q.search) qb.andWhere(new Brackets((w) => w.where('i.title ILIKE :s', { s: like(q.search!) }).orWhere('i.description ILIKE :s', { s: like(q.search!) })));
    const page = await paginateQb(qb, q, { sortable: { createdAt: 'i.createdAt', severity: 'i.severity', status: 'i.status' }, defaultSort: ['i.createdAt', 'DESC'] });
    return { ...page, data: page.data.map((i) => this.view(i)) };
  }

  async get(id: string) {
    const i = await this.repo.findOne({ where: { id } });
    if (!i) throw new NotFoundException('Incident not found');
    return i;
  }

  async getView(id: string) {
    return this.view(await this.get(id));
  }

  /** Open (unresolved) incidents + current banner/pause state, for the ops header. */
  async active() {
    const items = await this.repo.find({ where: [{ status: 'OPEN' }, { status: 'MITIGATED' }], order: { createdAt: 'DESC' } });
    return { incidents: items.map((i) => this.view(i)), state: await this.publicStatus() };
  }

  async create(dto: CreateIncidentDto, user: AuthUser, req: any) {
    const inc = this.repo.create({
      title: dto.title,
      severity: dto.severity,
      status: 'OPEN',
      description: dto.description ?? null,
      bannerMessage: dto.bannerMessage ?? null,
      bannerActive: !!(dto.bannerActive && dto.bannerMessage),
      pauseNewOrders: !!dto.pauseNewOrders,
      ownerId: dto.ownerId ?? user?.id ?? null,
      timeline: [this.entry(user, `Incident opened as ${dto.severity}: ${dto.title}`)],
    });
    if (dto.bannerActive && !dto.bannerMessage) throw new BadRequestException('bannerMessage is required to activate the banner');
    if (dto.pauseNewOrders) inc.timeline.push(this.entry(user, 'New orders paused'));
    const saved = await this.repo.save(inc);
    await this.audit.logReq(req, 'incident.create', 'incident', saved.id, undefined, saved);
    await this.syncPublicState();
    this.rt.emitToOps('incident.updated', { id: saved.id, status: saved.status, severity: saved.severity });
    // SOP-10 step 2: P1 => page on-call within 5 min (notify all ops staff immediately)
    if (saved.severity === 'P1' || saved.severity === 'P2') this.notifications.notifyOps('incident.opened', { severity: saved.severity, title: saved.title }, { incidentId: saved.id }).catch(() => undefined);
    return this.view(saved);
  }

  async update(id: string, dto: UpdateIncidentDto, user: AuthUser, req: any) {
    const inc = await this.get(id);
    const before = { title: inc.title, severity: inc.severity, description: inc.description, ownerId: inc.ownerId };
    const notes: string[] = [];
    if (dto.severity && dto.severity !== inc.severity) notes.push(`Severity changed ${inc.severity} -> ${dto.severity}`);
    Object.assign(inc, dto);
    for (const n of notes) inc.timeline = [...inc.timeline, this.entry(user, n)];
    await this.repo.save(inc);
    await this.audit.logReq(req, 'incident.update', 'incident', id, before, dto);
    this.rt.emitToOps('incident.updated', { id, status: inc.status, severity: inc.severity });
    return this.view(inc);
  }

  async addTimeline(id: string, dto: TimelineDto, user: AuthUser, req: any) {
    const inc = await this.get(id);
    inc.timeline = [...inc.timeline, this.entry(user, dto.note)];
    await this.repo.save(inc);
    await this.audit.logReq(req, 'incident.timeline', 'incident', id, undefined, { note: dto.note });
    this.rt.emitToOps('incident.updated', { id, status: inc.status, severity: inc.severity });
    return this.view(inc);
  }

  async setBanner(id: string, dto: BannerDto, user: AuthUser, req: any) {
    const inc = await this.get(id);
    if (dto.active && !(dto.message || inc.bannerMessage)) throw new BadRequestException('message is required to activate the banner');
    if (inc.status === 'RESOLVED' && dto.active) throw new BadRequestException('Incident is resolved');
    if (dto.message !== undefined) inc.bannerMessage = dto.message;
    const before = inc.bannerActive;
    inc.bannerActive = dto.active;
    inc.timeline = [...inc.timeline, this.entry(user, dto.active ? `Status banner shown: "${inc.bannerMessage}"` : 'Status banner removed')];
    await this.repo.save(inc);
    await this.audit.logReq(req, 'incident.banner', 'incident', id, { bannerActive: before }, { bannerActive: dto.active, message: inc.bannerMessage });
    await this.syncPublicState();
    return this.view(inc);
  }

  async setPause(id: string, dto: PauseOrdersDto, user: AuthUser, req: any) {
    const inc = await this.get(id);
    if (inc.status === 'RESOLVED' && dto.paused) throw new BadRequestException('Incident is resolved');
    const before = inc.pauseNewOrders;
    inc.pauseNewOrders = dto.paused;
    inc.timeline = [...inc.timeline, this.entry(user, dto.paused ? `New orders PAUSED${dto.reason ? `: ${dto.reason}` : ''}` : `New orders RESUMED${dto.reason ? `: ${dto.reason}` : ''}`)];
    await this.repo.save(inc);
    await this.audit.logReq(req, dto.paused ? 'incident.pause_orders' : 'incident.resume_orders', 'incident', id, { pauseNewOrders: before }, { pauseNewOrders: dto.paused, reason: dto.reason });
    await this.syncPublicState();
    return this.view(inc);
  }

  async mitigate(id: string, dto: ResolveIncidentDto, user: AuthUser, req: any) {
    const inc = await this.get(id);
    if (inc.status === 'RESOLVED') throw new BadRequestException('Incident is already resolved');
    inc.status = 'MITIGATED';
    inc.timeline = [...inc.timeline, this.entry(user, dto.note ? `Mitigated: ${dto.note}` : 'Mitigated')];
    await this.repo.save(inc);
    await this.audit.logReq(req, 'incident.mitigate', 'incident', id, undefined, { status: inc.status });
    this.rt.emitToOps('incident.updated', { id, status: inc.status, severity: inc.severity });
    return this.view(inc);
  }

  /** Resolve: clears banner + order pause, starts the 48 h post-incident report clock. */
  async resolve(id: string, dto: ResolveIncidentDto, user: AuthUser, req: any) {
    const inc = await this.get(id);
    if (inc.status === 'RESOLVED') throw new BadRequestException('Incident is already resolved');
    inc.status = 'RESOLVED';
    inc.resolvedAt = new Date();
    inc.reportDueAt = new Date(inc.resolvedAt.getTime() + REPORT_DUE_HOURS * 3600_000);
    inc.bannerActive = false;
    inc.pauseNewOrders = false;
    inc.timeline = [...inc.timeline, this.entry(user, dto.note ? `Resolved: ${dto.note}` : 'Resolved'), this.entry(user, `Post-incident report due by ${inc.reportDueAt.toISOString()}`)];
    await this.repo.save(inc);
    await this.audit.logReq(req, 'incident.resolve', 'incident', id, undefined, { status: inc.status, reportDueAt: inc.reportDueAt });
    await this.syncPublicState();
    this.rt.emitToOps('incident.updated', { id, status: inc.status, severity: inc.severity });
    this.notifications.notifyOps('incident.resolved', { title: inc.title, reportDueAt: inc.reportDueAt.toISOString() }, { incidentId: id }).catch(() => undefined);
    return this.view(inc);
  }

  async setReport(id: string, dto: ReportDto, user: AuthUser, req: any) {
    const inc = await this.get(id);
    if (inc.status !== 'RESOLVED') throw new BadRequestException('The post-incident report can be filed once the incident is resolved');
    const first = !inc.postIncidentReport;
    inc.postIncidentReport = dto.report;
    inc.timeline = [...inc.timeline, this.entry(user, first ? 'Post-incident report filed' : 'Post-incident report updated')];
    await this.repo.save(inc);
    await this.audit.logReq(req, 'incident.report', 'incident', id, undefined, { length: dto.report.length, late: !!inc.reportDueAt && Date.now() > inc.reportDueAt.getTime() });
    return this.view(inc);
  }
}

@AdminController('incidents')
export class IncidentsController {
  constructor(private svc: IncidentsService) {}
  @Get() @Permission(Mod.OPERATIONS, Action.VIEW) list(@Query() q: IncidentQuery) {
    return this.svc.list(q);
  }
  @Get('active') @Permission(Mod.OPERATIONS, Action.VIEW) active() {
    return this.svc.active();
  }
  @Get(':id') @Permission(Mod.OPERATIONS, Action.VIEW) get(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.getView(id);
  }
  @Post() @Permission(Mod.OPERATIONS, Action.CREATE) create(@Body() dto: CreateIncidentDto, @Req() req: any) {
    return this.svc.create(dto, req.user, req);
  }
  @Patch(':id') @Permission(Mod.OPERATIONS, Action.EDIT) update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateIncidentDto, @Req() req: any) {
    return this.svc.update(id, dto, req.user, req);
  }
  @Post(':id/timeline') @Permission(Mod.OPERATIONS, Action.EDIT) timeline(@Param('id', ParseUUIDPipe) id: string, @Body() dto: TimelineDto, @Req() req: any) {
    return this.svc.addTimeline(id, dto, req.user, req);
  }
  @Post(':id/banner') @Permission(Mod.OPERATIONS, Action.EDIT) banner(@Param('id', ParseUUIDPipe) id: string, @Body() dto: BannerDto, @Req() req: any) {
    return this.svc.setBanner(id, dto, req.user, req);
  }
  @Post(':id/pause-orders') @Permission(Mod.OPERATIONS, Action.APPROVE) pause(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PauseOrdersDto, @Req() req: any) {
    return this.svc.setPause(id, dto, req.user, req);
  }
  @Post(':id/mitigate') @Permission(Mod.OPERATIONS, Action.EDIT) mitigate(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ResolveIncidentDto, @Req() req: any) {
    return this.svc.mitigate(id, dto, req.user, req);
  }
  @Post(':id/resolve') @Permission(Mod.OPERATIONS, Action.EDIT) resolve(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ResolveIncidentDto, @Req() req: any) {
    return this.svc.resolve(id, dto, req.user, req);
  }
  @Put(':id/report') @Permission(Mod.OPERATIONS, Action.EDIT) report(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReportDto, @Req() req: any) {
    return this.svc.setReport(id, dto, req.user, req);
  }
}

@PublicController('status')
export class PublicStatusController {
  constructor(private svc: IncidentsService) {}
  @Get() status() {
    return this.svc.publicStatus();
  }
}
