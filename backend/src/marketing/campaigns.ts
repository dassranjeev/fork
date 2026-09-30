import { BadRequestException, Body, Delete, Get, Injectable, Logger, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { createHmac } from 'crypto';
import { Repository } from 'typeorm';
import { IsDateString, IsEnum, IsIn, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import { Campaign, CustomerProfile, DriverProfile, RestaurantMember } from '../database/entities';
import { AdminController, CurrentUser, Permission, PublicController } from '../common/decorators';
import { AuthUser } from '../common/auth.types';
import { Action, Module, NotificationChannel } from '../common/enums';
import { PageQueryDto, paginateQb, like } from '../common/pagination';
import { AuditService } from '../audit/audit.service';
import { NotificationsService, Audience } from '../notifications/notifications.service';

const AUDIENCES = ['CUSTOMERS', 'DRIVERS', 'RESTAURANTS'] as const;

// ------------------------------------------------------------------ DTOs
class CampaignDto {
  @IsString() @MaxLength(120) name: string;
  @IsEnum(NotificationChannel) channel: NotificationChannel;
  @IsOptional() @IsString() @MaxLength(150) subject?: string | null;
  @IsString() body: string;
  @IsOptional() @IsIn(AUDIENCES as unknown as string[]) audience?: Campaign['audience'];
  /** { cityId?, zoneId?, minOrders?, inactiveDays? } */
  @IsOptional() @IsObject() filters?: Campaign['filters'];
  @IsOptional() @IsDateString() scheduledAt?: string | null;
}
class UpdateCampaignDto {
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsEnum(NotificationChannel) channel?: NotificationChannel;
  @IsOptional() @IsString() @MaxLength(150) subject?: string | null;
  @IsOptional() @IsString() body?: string;
  @IsOptional() @IsIn(AUDIENCES as unknown as string[]) audience?: Campaign['audience'];
  @IsOptional() @IsObject() filters?: Campaign['filters'];
  @IsOptional() @IsDateString() scheduledAt?: string | null;
}
class CampaignQuery extends PageQueryDto {
  /** DRAFT | SCHEDULED | SENDING | SENT | CANCELLED */
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsEnum(NotificationChannel) channel?: NotificationChannel;
  @IsOptional() @IsIn(AUDIENCES as unknown as string[]) audience?: string;
}
class UnsubscribeQuery {
  @IsString() u: string;
  @IsString() t: string;
  /** EMAIL | SMS | ALL (default ALL) */
  @IsOptional() @IsIn(['EMAIL', 'SMS', 'ALL']) c?: string;
}

// ------------------------------------------------------------------ service
@Injectable()
export class CampaignsService {
  private readonly logger = new Logger(CampaignsService.name);

  constructor(
    @InjectRepository(Campaign) private repo: Repository<Campaign>,
    @InjectRepository(CustomerProfile) private customerProfiles: Repository<CustomerProfile>,
    @InjectRepository(DriverProfile) private driverProfiles: Repository<DriverProfile>,
    @InjectRepository(RestaurantMember) private members: Repository<RestaurantMember>,
    private notifications: NotificationsService,
    private config: ConfigService,
  ) {}

  list(q: CampaignQuery) {
    const qb = this.repo.createQueryBuilder('c');
    if (q.search) qb.andWhere('c.name ILIKE :s', { s: like(q.search) });
    if (q.status) qb.andWhere('c.status = :st', { st: q.status.toUpperCase() });
    if (q.channel) qb.andWhere('c.channel = :ch', { ch: q.channel });
    if (q.audience) qb.andWhere('c.audience = :a', { a: q.audience });
    return paginateQb(qb, q, { sortable: { createdAt: 'c.createdAt', name: 'c.name', scheduledAt: 'c.scheduledAt' }, defaultSort: ['c.createdAt', 'DESC'] });
  }

  async get(id: string) {
    const c = await this.repo.findOne({ where: { id } });
    if (!c) throw new NotFoundException('Campaign not found');
    return c;
  }

  async create(dto: CampaignDto, user: AuthUser) {
    if (dto.scheduledAt && new Date(dto.scheduledAt) <= new Date()) throw new BadRequestException('scheduledAt must be in the future');
    const c = this.repo.create({
      name: dto.name,
      channel: dto.channel,
      subject: dto.subject ?? null,
      body: dto.body,
      audience: dto.audience ?? 'CUSTOMERS',
      filters: dto.filters ?? {},
      status: dto.scheduledAt ? 'SCHEDULED' : 'DRAFT',
      scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : null,
      createdById: user.id,
    });
    return this.repo.save(c);
  }

  async update(id: string, dto: UpdateCampaignDto) {
    const c = await this.get(id);
    if (c.status === 'SENT' || c.status === 'SENDING') throw new BadRequestException('A sent campaign cannot be edited');
    const before = { ...c };
    const { scheduledAt, ...rest } = dto;
    Object.assign(c, Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)));
    if (scheduledAt !== undefined) {
      c.scheduledAt = scheduledAt ? new Date(scheduledAt) : null;
      if (c.scheduledAt && c.status !== 'CANCELLED') c.status = 'SCHEDULED';
      if (!c.scheduledAt && c.status === 'SCHEDULED') c.status = 'DRAFT';
    }
    await this.repo.save(c);
    return { before, after: c };
  }

  async remove(id: string) {
    const c = await this.get(id);
    if (c.status === 'SENT' || c.status === 'SENDING') throw new BadRequestException('A sent campaign cannot be deleted');
    await this.repo.delete({ id });
    return c;
  }

  async cancel(id: string) {
    const c = await this.get(id);
    if (c.status !== 'SCHEDULED') throw new BadRequestException('Only a scheduled campaign can be cancelled');
    c.status = 'CANCELLED';
    await this.repo.save(c);
    return c;
  }

  // ------------------------------------------------------------------ recipients
  private async recipientIds(c: Pick<Campaign, 'audience' | 'filters'>): Promise<string[]> {
    const f = c.filters ?? {};
    if (c.audience === 'DRIVERS') {
      const qb = this.driverProfiles
        .createQueryBuilder('d')
        .innerJoin('users', 'u', 'u.id = d."userId"')
        .where(`u.type = 'DRIVER' AND u.status = 'ACTIVE'`);
      if (f.cityId) qb.andWhere('d."cityId" = :c', { c: f.cityId });
      if (f.zoneId) qb.andWhere(`d."zoneIds" @> :z::jsonb`, { z: JSON.stringify([f.zoneId]) });
      const rows = await qb.select('d.userId', 'userId').getRawMany();
      return [...new Set(rows.map((r) => r.userId))];
    }
    if (c.audience === 'RESTAURANTS') {
      const qb = this.members.createQueryBuilder('m').innerJoin('users', 'u', 'u.id = m."userId"').where(`m.active = true AND u.status = 'ACTIVE'`);
      if (f.cityId) qb.andWhere(`EXISTS (SELECT 1 FROM restaurants r WHERE r.id = m."restaurantId" AND r."cityId" = :c)`, { c: f.cityId });
      const rows = await qb.select('m.userId', 'userId').getRawMany();
      return [...new Set(rows.map((r) => r.userId))];
    }
    // CUSTOMERS (default). cityId/zoneId are not directly modelled on CustomerProfile - best-effort filters only.
    const qb = this.customerProfiles.createQueryBuilder('p').innerJoin('users', 'u', 'u.id = p."userId"').where(`u.type = 'CUSTOMER' AND u.status = 'ACTIVE'`);
    if (f.minOrders != null) qb.andWhere('p."totalOrders" >= :mo', { mo: f.minOrders });
    if (f.inactiveDays != null) qb.andWhere(`(p."lastOrderAt" IS NULL OR p."lastOrderAt" <= now() - (:d || ' days')::interval)`, { d: f.inactiveDays });
    const rows = await qb.select('p.userId', 'userId').getRawMany();
    return [...new Set(rows.map((r) => r.userId))];
  }

  async preview(audience: Campaign['audience'], filters: Campaign['filters']) {
    const ids = await this.recipientIds({ audience: audience ?? 'CUSTOMERS', filters: filters ?? {} });
    return { estimatedRecipients: ids.length };
  }

  async send(id: string) {
    const c = await this.get(id);
    if (c.status === 'SENT' || c.status === 'SENDING') throw new BadRequestException('Campaign already sent');
    c.status = 'SENDING';
    await this.repo.save(c);

    const audience: Audience = c.audience === 'DRIVERS' ? 'DRIVER' : c.audience === 'RESTAURANTS' ? 'RESTAURANT' : 'CUSTOMER';
    let ids: string[] = [];
    try {
      ids = await this.recipientIds(c);
    } catch (e: any) {
      this.logger.error(`recipient lookup failed for campaign ${id}: ${e.message}`);
    }

    let delivered = 0;
    for (const userId of ids) {
      try {
        let body = c.body;
        // CASL: append an unsubscribe link on marketing email/SMS to customers.
        if (audience === 'CUSTOMER' && (c.channel === NotificationChannel.EMAIL || c.channel === NotificationChannel.SMS)) {
          body = `${body}\n\n${this.unsubscribeText(userId)}`;
        }
        await this.notifications.notify({
          userId,
          audience,
          event: 'campaign.message',
          vars: { title: c.subject ?? c.name, body },
          data: { campaignId: c.id },
          channels: [c.channel],
          marketing: true,
        });
        delivered++;
      } catch (e: any) {
        this.logger.warn(`campaign ${id} send to ${userId} failed: ${e.message}`);
      }
    }

    c.status = 'SENT';
    c.sentAt = new Date();
    c.recipientCount = ids.length;
    c.deliveredCount = delivered;
    await this.repo.save(c);
    return c;
  }

  /** Fires SCHEDULED campaigns whose time has come. */
  @Cron(CronExpression.EVERY_MINUTE)
  async runScheduled() {
    const due = await this.repo.find({ where: { status: 'SCHEDULED' } });
    const now = Date.now();
    for (const c of due) {
      if (c.scheduledAt && new Date(c.scheduledAt).getTime() <= now) {
        try {
          await this.send(c.id);
        } catch (e: any) {
          this.logger.error(`scheduled campaign ${c.id} failed: ${e.message}`);
        }
      }
    }
  }

  // ------------------------------------------------------------------ unsubscribe (CASL)
  private token(userId: string) {
    const secret = this.config.get<string>('jwt.secret') || 'change-me';
    return createHmac('sha256', secret).update(userId).digest('hex').slice(0, 32);
  }

  unsubscribeLink(userId: string) {
    const base = this.config.get<string>('publicUrl') || '';
    return `${base}/api/v1/public/unsubscribe?u=${userId}&t=${this.token(userId)}`;
  }

  private unsubscribeText(userId: string) {
    return `Don't want these messages? Unsubscribe: ${this.unsubscribeLink(userId)}`;
  }

  verifyToken(userId: string, token: string) {
    return !!userId && !!token && this.token(userId) === token;
  }
}

// ------------------------------------------------------------------ admin controller
@AdminController('campaigns')
export class CampaignsAdminController {
  constructor(private svc: CampaignsService, private audit: AuditService) {}

  @Get()
  @Permission(Module.NOTIFICATIONS, Action.VIEW)
  list(@Query() q: CampaignQuery) {
    return this.svc.list(q);
  }

  @Post('preview')
  @Permission(Module.NOTIFICATIONS, Action.VIEW)
  preview(@Body() dto: CampaignDto) {
    return this.svc.preview(dto.audience ?? 'CUSTOMERS', dto.filters ?? {});
  }

  @Get(':id')
  @Permission(Module.NOTIFICATIONS, Action.VIEW)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.get(id);
  }

  @Post()
  @Permission(Module.NOTIFICATIONS, Action.CREATE)
  async create(@Body() dto: CampaignDto, @CurrentUser() u: AuthUser, @Req() req: any) {
    const c = await this.svc.create(dto, u);
    await this.audit.logReq(req, 'campaign.create', 'campaign', c.id, null, c);
    return c;
  }

  @Patch(':id')
  @Permission(Module.NOTIFICATIONS, Action.EDIT)
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCampaignDto, @Req() req: any) {
    const { before, after } = await this.svc.update(id, dto);
    await this.audit.logReq(req, 'campaign.update', 'campaign', id, before, after);
    return after;
  }

  @Delete(':id')
  @Permission(Module.NOTIFICATIONS, Action.DELETE)
  async remove(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    const c = await this.svc.remove(id);
    await this.audit.logReq(req, 'campaign.delete', 'campaign', id, c, null);
    return { ok: true };
  }

  @Post(':id/send')
  @Permission(Module.NOTIFICATIONS, Action.EDIT)
  async send(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    const c = await this.svc.send(id);
    await this.audit.logReq(req, 'campaign.send', 'campaign', id, null, { recipientCount: c.recipientCount, deliveredCount: c.deliveredCount });
    return c;
  }

  @Post(':id/cancel')
  @Permission(Module.NOTIFICATIONS, Action.EDIT)
  async cancel(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    const c = await this.svc.cancel(id);
    await this.audit.logReq(req, 'campaign.cancel', 'campaign', id, null, { status: c.status });
    return c;
  }
}

/** CASL: one-click unsubscribe link sent with every marketing email/SMS. */
@PublicController('unsubscribe')
export class UnsubscribeController {
  constructor(private svc: CampaignsService, @InjectRepository(CustomerProfile) private customerProfiles: Repository<CustomerProfile>) {}

  @Get()
  async unsubscribe(@Query() q: UnsubscribeQuery) {
    if (!this.svc.verifyToken(q.u, q.t)) throw new BadRequestException('Invalid or expired unsubscribe link');
    const p = await this.customerProfiles.findOne({ where: { userId: q.u } });
    if (!p) throw new NotFoundException('Account not found');
    if (!q.c || q.c === 'ALL') {
      p.marketingEmailConsent = false;
      p.marketingSmsConsent = false;
    } else if (q.c === 'EMAIL') p.marketingEmailConsent = false;
    else if (q.c === 'SMS') p.marketingSmsConsent = false;
    await this.customerProfiles.save(p);
    return { ok: true, message: 'You have been unsubscribed from FORKSY marketing messages.' };
  }
}
