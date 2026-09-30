import { BadRequestException, Body, ConflictException, Delete, Get, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsArray, IsBoolean, IsEnum, IsIn, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import { Repository } from 'typeorm';
import { NotificationTemplate } from '../database/entities';
import { AdminController, Permission } from '../common/decorators';
import { Action, Module, NotificationChannel } from '../common/enums';
import { PageQueryDto, paginateQb, like } from '../common/pagination';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { DEFAULT_MESSAGES, NotificationsService, renderTemplate } from '../notifications/notifications.service';

const AUDIENCES = ['CUSTOMER', 'RESTAURANT', 'DRIVER', 'ADMIN'] as const;

export const SAMPLE_VARS: Record<string, any> = {
  code: 'FK-483920',
  restaurant: 'Sample Kitchen',
  total: '$32.50',
  type: 'delivery',
  itemCount: 3,
  acceptMinutes: 3,
  prepMinutes: 20,
  reason: 'Item unavailable',
  pickupHint: 'Show code 4821 at the counter.',
  pickupCode: '4821',
  driverName: 'Alex',
  vehicle: 'Car',
  etaMinutes: 8,
  eta: '6:45 PM',
  pay: '$8.50',
  pickupKm: '1.2',
  dropKm: '3.4',
  seconds: 30,
  earnings: '$9.75',
  amount: '$25.00',
  period: 'Sep 1 - Sep 7',
  docType: 'Driver licence',
  expiresAt: '2026-10-31',
  name: 'Sample Kitchen',
  subject: 'Sample Kitchen',
  refundNote: 'Your refund will arrive in 3-5 business days.',
  number: 'TCK-1001',
  zone: 'City Centre',
  boost: '$2.00',
  minutes: 10,
  respondBy: '2026-10-07',
  title: 'Weekend deal',
  body: '20% off your next order',
  firstName: 'Sam',
};

class TemplateQuery extends PageQueryDto {
  @IsOptional() @IsString() key?: string;
  @IsOptional() @IsString() channel?: string;
  @IsOptional() @IsString() language?: string;
  @IsOptional() @IsString() audience?: string;
  @IsOptional() @IsString() active?: string;
}
class TemplateDto {
  @IsString() @MaxLength(80) key: string;
  @IsEnum(NotificationChannel) channel: NotificationChannel;
  @IsOptional() @IsString() @MaxLength(10) language?: string;
  @IsOptional() @IsIn(AUDIENCES as unknown as string[]) audience?: NotificationTemplate['audience'];
  @IsOptional() @IsString() subject?: string | null;
  @IsString() body: string;
  @IsOptional() @IsBoolean() active?: boolean;
}
class UpdateTemplateDto {
  @IsOptional() @IsString() subject?: string | null;
  @IsOptional() @IsString() body?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}
class PreviewDto {
  @IsOptional() @IsString() subject?: string;
  @IsOptional() @IsString() body?: string;
  @IsOptional() @IsObject() vars?: Record<string, any>;
}
class TestSendDto {
  /** EMAIL: address, SMS: phone (E.164), PUSH: user id */
  @IsString() to: string;
  @IsOptional() @IsEnum(NotificationChannel) channel?: NotificationChannel;
  @IsOptional() @IsObject() vars?: Record<string, any>;
}
class MatrixDto {
  /** { "<event>": { "<AUDIENCE>": ["PUSH","EMAIL","SMS","IN_APP"] } } */
  @IsObject() matrix: Record<string, Record<string, string[]>>;
}
class MatrixCellDto {
  @IsString() event: string;
  @IsIn(AUDIENCES as unknown as string[]) audience: string;
  @IsArray() @IsEnum(NotificationChannel, { each: true }) channels: NotificationChannel[];
}

const varsIn = (text: string) => [...new Set([...text.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]))];

@Injectable()
class TemplatesService {
  constructor(@InjectRepository(NotificationTemplate) public repo: Repository<NotificationTemplate>, private settings: SettingsService) {}

  async events() {
    const map = new Map<string, { event: string; audiences: Set<string>; variables: Set<string> }>();
    const add = (event: string, aud: string, text: string) => {
      const e = map.get(event) ?? { event, audiences: new Set<string>(), variables: new Set<string>() };
      e.audiences.add(aud);
      varsIn(text).forEach((v) => e.variables.add(v));
      map.set(event, e);
    };
    for (const [event, byAud] of Object.entries(DEFAULT_MESSAGES)) {
      for (const [aud, m] of Object.entries(byAud)) add(event, aud, `${m!.title} ${m!.body}`);
    }
    for (const t of await this.repo.find({ select: ['key', 'audience', 'subject', 'body'] })) add(t.key, t.audience, `${t.subject ?? ''} ${t.body}`);
    const matrix = this.settings.get<Record<string, Record<string, string[]>>>('notifications.matrix', {});
    for (const [event, byAud] of Object.entries(matrix)) for (const aud of Object.keys(byAud)) add(event, aud, '');
    return [...map.values()]
      .map((e) => ({ event: e.event, audiences: [...e.audiences], variables: [...e.variables] }))
      .sort((a, b) => a.event.localeCompare(b.event));
  }

  sampleFor(vars?: Record<string, any>) {
    return { ...SAMPLE_VARS, ...(vars ?? {}) };
  }
}

@AdminController('notification-templates')
export class NotificationTemplatesController {
  constructor(
    private svc: TemplatesService,
    private notifications: NotificationsService,
    private audit: AuditService,
  ) {}

  @Get()
  @Permission(Module.CONTENT, Action.VIEW)
  list(@Query() q: TemplateQuery) {
    const qb = this.svc.repo.createQueryBuilder('t');
    if (q.search) qb.andWhere('(t.key ILIKE :s OR t.subject ILIKE :s OR t.body ILIKE :s)', { s: like(q.search) });
    if (q.key) qb.andWhere('t.key = :key', { key: q.key });
    if (q.channel) qb.andWhere('t.channel = :ch', { ch: q.channel });
    if (q.language) qb.andWhere('t.language = :lang', { lang: q.language });
    if (q.audience) qb.andWhere('t.audience = :aud', { aud: q.audience });
    if (q.active === 'true' || q.active === 'false') qb.andWhere('t.active = :act', { act: q.active === 'true' });
    return paginateQb(qb, q, { sortable: { key: 't.key', channel: 't.channel', updatedAt: 't.updatedAt' }, defaultSort: ['t.key', 'ASC'] });
  }

  /** Event catalogue with audiences + variables (drives the editor's variable chips). */
  @Get('events')
  @Permission(Module.CONTENT, Action.VIEW)
  events() {
    return this.svc.events().then((events) => ({ events, sampleVars: SAMPLE_VARS, channels: Object.values(NotificationChannel), audiences: AUDIENCES, languages: ['en', 'fr'] }));
  }

  /** Render arbitrary subject/body with sample variables (live editor preview). */
  @Post('preview')
  @Permission(Module.CONTENT, Action.VIEW)
  previewAdHoc(@Body() dto: PreviewDto) {
    const vars = this.svc.sampleFor(dto.vars);
    return { subject: renderTemplate(dto.subject ?? '', vars), body: renderTemplate(dto.body ?? '', vars), vars };
  }

  @Get(':id')
  @Permission(Module.CONTENT, Action.VIEW)
  async get(@Param('id', ParseUUIDPipe) id: string) {
    const t = await this.svc.repo.findOne({ where: { id } });
    if (!t) throw new NotFoundException('Template not found');
    return { ...t, variables: varsIn(`${t.subject ?? ''} ${t.body}`) };
  }

  @Post()
  @Permission(Module.CONTENT, Action.CREATE)
  async create(@Body() dto: TemplateDto, @Req() req: any) {
    const language = dto.language ?? 'en';
    const audience = dto.audience ?? 'CUSTOMER';
    if (await this.svc.repo.findOne({ where: { key: dto.key, channel: dto.channel, language, audience } })) {
      throw new ConflictException('A template for this event / channel / language / audience already exists');
    }
    const t = await this.svc.repo.save(this.svc.repo.create({ ...dto, language, audience, subject: dto.subject ?? null, active: dto.active ?? true }));
    await this.audit.logReq(req, 'notification_template.create', 'notification_template', t.id, null, t);
    return t;
  }

  @Patch(':id')
  @Permission(Module.CONTENT, Action.EDIT)
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTemplateDto, @Req() req: any) {
    const t = await this.svc.repo.findOne({ where: { id } });
    if (!t) throw new NotFoundException('Template not found');
    const before = { ...t };
    Object.assign(t, Object.fromEntries(Object.entries(dto).filter(([, v]) => v !== undefined)));
    await this.svc.repo.save(t);
    await this.audit.logReq(req, 'notification_template.update', 'notification_template', id, before, t);
    return t;
  }

  @Delete(':id')
  @Permission(Module.CONTENT, Action.DELETE)
  async remove(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    const t = await this.svc.repo.findOne({ where: { id } });
    if (!t) throw new NotFoundException('Template not found');
    await this.svc.repo.delete({ id });
    await this.audit.logReq(req, 'notification_template.delete', 'notification_template', id, t, null);
    return { ok: true };
  }

  /** Render a stored template with sample (or supplied) variables. */
  @Post(':id/preview')
  @Permission(Module.CONTENT, Action.VIEW)
  async preview(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PreviewDto) {
    const t = await this.svc.repo.findOne({ where: { id } });
    if (!t) throw new NotFoundException('Template not found');
    const vars = this.svc.sampleFor(dto?.vars);
    return { channel: t.channel, subject: renderTemplate(dto?.subject ?? t.subject ?? '', vars), body: renderTemplate(dto?.body ?? t.body, vars), vars };
  }

  /** Send the rendered template (with sample vars) to an address / phone / user. */
  @Post(':id/test-send')
  @Permission(Module.CONTENT, Action.EDIT)
  async testSend(@Param('id', ParseUUIDPipe) id: string, @Body() dto: TestSendDto, @Req() req: any) {
    const t = await this.svc.repo.findOne({ where: { id } });
    if (!t) throw new NotFoundException('Template not found');
    const channel = dto.channel ?? t.channel;
    const vars = this.svc.sampleFor(dto.vars);
    const subject = `[TEST] ${renderTemplate(t.subject ?? t.key, vars)}`;
    const body = renderTemplate(t.body, vars);
    try {
      if (channel === NotificationChannel.EMAIL) {
        if (!/^\S+@\S+\.\S+$/.test(dto.to)) throw new BadRequestException('`to` must be an email address for EMAIL');
        await this.notifications.sendEmail(dto.to, subject, body);
      } else if (channel === NotificationChannel.SMS) {
        if (!/^\+?[0-9 ()-]{7,20}$/.test(dto.to)) throw new BadRequestException('`to` must be a phone number for SMS');
        await this.notifications.sendSms(dto.to, `[TEST] ${body}`);
      } else if (channel === NotificationChannel.PUSH) {
        await this.notifications.sendPush(dto.to, subject, body, { test: true });
      } else {
        throw new BadRequestException('Test send supports EMAIL, SMS and PUSH');
      }
    } catch (e: any) {
      if (e instanceof BadRequestException) throw e;
      throw new BadRequestException(`Test send failed: ${e.message}`);
    }
    await this.audit.logReq(req, 'notification_template.test_send', 'notification_template', id, null, { channel, to: dto.to });
    return { ok: true, channel, to: dto.to, subject, body };
  }
}

/** Admin edit of the notification channel matrix (setting `notifications.matrix`, spec 9.1). */
@AdminController('notification-matrix')
export class NotificationMatrixController {
  constructor(private svc: TemplatesService, private settings: SettingsService, private audit: AuditService) {}

  @Get()
  @Permission(Module.NOTIFICATIONS, Action.VIEW)
  async get() {
    return {
      matrix: this.settings.get('notifications.matrix', {}),
      events: await this.svc.events(),
      channels: Object.values(NotificationChannel),
      audiences: AUDIENCES,
    };
  }

  @Put()
  @Permission(Module.NOTIFICATIONS, Action.EDIT)
  async put(@Body() dto: MatrixDto, @Req() req: any) {
    const clean = this.validate(dto.matrix);
    const before = this.settings.get('notifications.matrix', {});
    await this.settings.set('notifications.matrix', clean);
    await this.audit.logReq(req, 'notification_matrix.update', 'setting', 'notifications.matrix', before, clean);
    return { matrix: clean };
  }

  /** Change one cell: which channels an event uses for one audience. */
  @Patch()
  @Permission(Module.NOTIFICATIONS, Action.EDIT)
  async cell(@Body() dto: MatrixCellDto, @Req() req: any) {
    const before = this.settings.get<Record<string, Record<string, string[]>>>('notifications.matrix', {});
    const next = { ...before, [dto.event]: { ...(before[dto.event] ?? {}), [dto.audience]: [...new Set(dto.channels)] } };
    await this.settings.set('notifications.matrix', next);
    await this.audit.logReq(req, 'notification_matrix.update', 'setting', 'notifications.matrix', before[dto.event] ?? null, next[dto.event]);
    return { matrix: next };
  }

  private validate(m: Record<string, Record<string, string[]>>) {
    const channels = new Set<string>(Object.values(NotificationChannel));
    const out: Record<string, Record<string, string[]>> = {};
    for (const [event, byAud] of Object.entries(m)) {
      if (!/^[\w.]+$/.test(event)) throw new BadRequestException(`Invalid event key: ${event}`);
      if (typeof byAud !== 'object' || byAud === null) throw new BadRequestException(`Invalid entry for ${event}`);
      out[event] = {};
      for (const [aud, list] of Object.entries(byAud)) {
        if (!(AUDIENCES as readonly string[]).includes(aud)) throw new BadRequestException(`Unknown audience ${aud} for ${event}`);
        if (!Array.isArray(list) || list.some((c) => !channels.has(c))) throw new BadRequestException(`Invalid channels for ${event}/${aud}`);
        out[event][aud] = [...new Set(list)];
      }
    }
    return out;
  }
}

export { TemplatesService };
