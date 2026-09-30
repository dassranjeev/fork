import { BadRequestException, Body, Get, Injectable, Logger, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { OnEvent } from '@nestjs/event-emitter';
import { DataSource, Repository } from 'typeorm';
import { IsBoolean, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { Referral, User } from '../database/entities';
import { AdminController, Permission } from '../common/decorators';
import { Action, Module } from '../common/enums';
import { PageQueryDto, paginateQb } from '../common/pagination';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { WalletService } from '../orders/wallet.service';
import { Events, OrderStatusEvent } from '../common/contracts';

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

class ReferralSettingsDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsNumber() @Min(0) referrerReward?: number;
  @IsOptional() @IsNumber() @Min(0) refereeReward?: number;
  @IsOptional() @IsNumber() @Min(0) minSubtotal?: number;
}

class ReferralQuery extends PageQueryDto {
  /** PENDING | REWARDED | VOID */
  @IsOptional() @IsString() status?: string;
}

// ------------------------------------------------------------------ service
@Injectable()
export class ReferralsAdminService {
  constructor(
    @InjectRepository(Referral) private repo: Repository<Referral>,
    @InjectRepository(User) private users: Repository<User>,
    private settings: SettingsService,
  ) {}

  settingsView() {
    return {
      enabled: this.settings.get<boolean>('marketing.referralEnabled', true),
      referrerReward: this.settings.get<number>('marketing.referralReferrerReward', 10),
      refereeReward: this.settings.get<number>('marketing.referralRefereeReward', 10),
      minSubtotal: this.settings.get<number>('marketing.referralMinSubtotal', 0),
    };
  }

  async updateSettings(dto: ReferralSettingsDto) {
    const before = this.settingsView();
    if (dto.enabled !== undefined) await this.settings.set('marketing.referralEnabled', dto.enabled);
    if (dto.referrerReward !== undefined) await this.settings.set('marketing.referralReferrerReward', dto.referrerReward);
    if (dto.refereeReward !== undefined) await this.settings.set('marketing.referralRefereeReward', dto.refereeReward);
    if (dto.minSubtotal !== undefined) await this.settings.set('marketing.referralMinSubtotal', dto.minSubtotal);
    return { before, after: this.settingsView() };
  }

  async list(q: ReferralQuery) {
    const qb = this.repo.createQueryBuilder('r');
    if (q.status) qb.andWhere('r.status = :s', { s: q.status.toUpperCase() });
    const res = await paginateQb(qb, q, { sortable: { createdAt: 'r.createdAt', status: 'r.status' }, defaultSort: ['r.createdAt', 'DESC'] });
    const ids = [...new Set(res.data.flatMap((r) => [r.referrerId, r.refereeId]))];
    const rows = ids.length
      ? await this.users.createQueryBuilder('u').select(['u.id', 'u.firstName', 'u.lastName', 'u.email']).where('u.id IN (:...ids)', { ids }).getMany()
      : [];
    const nm = new Map(rows.map((u) => [u.id, `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || u.email || u.id]));
    return { ...res, data: res.data.map((r) => ({ ...r, referrerName: nm.get(r.referrerId) ?? null, refereeName: nm.get(r.refereeId) ?? null })) };
  }

  async void(id: string) {
    const r = await this.repo.findOne({ where: { id } });
    if (!r) throw new NotFoundException('Referral not found');
    if (r.status === 'REWARDED') throw new BadRequestException('Cannot void a referral that has already been rewarded');
    const before = { ...r };
    r.status = 'VOID';
    await this.repo.save(r);
    return { before, after: r };
  }

  async stats() {
    const rows = await this.repo.find();
    return {
      total: rows.length,
      pending: rows.filter((r) => r.status === 'PENDING').length,
      rewarded: rows.filter((r) => r.status === 'REWARDED').length,
      void: rows.filter((r) => r.status === 'VOID').length,
      totalPaidOut: r2(rows.filter((r) => r.status === 'REWARDED').reduce((s, r) => s + r.referrerReward + r.refereeReward, 0)),
    };
  }
}

// ------------------------------------------------------------------ reward on first delivered order
/**
 * Spec: referral reward fires once the referred customer's FIRST order is delivered/collected.
 * Listens on Events.ORDER_DELIVERED (emitted by OrdersService.transition for DELIVERED/COLLECTED).
 */
@Injectable()
export class ReferralRewardListener {
  private readonly logger = new Logger(ReferralRewardListener.name);

  constructor(
    @InjectRepository(Referral) private repo: Repository<Referral>,
    @InjectDataSource() private ds: DataSource,
    private settings: SettingsService,
    private wallet: WalletService,
    private notifications: NotificationsService,
  ) {}

  @OnEvent(Events.ORDER_DELIVERED)
  async onOrderDelivered(payload: OrderStatusEvent) {
    try {
      if (!this.settings.get<boolean>('marketing.referralEnabled', true)) return;
      const order = payload?.order;
      if (!order?.customerId) return;

      const referral = await this.repo.findOne({ where: { refereeId: order.customerId, status: 'PENDING' } });
      if (!referral) return;

      const [{ n }] = await this.ds.query(
        `SELECT COUNT(*)::int n FROM orders WHERE "customerId" = $1 AND status IN ('DELIVERED','COLLECTED')`,
        [order.customerId],
      );
      if (+n > 1) return; // not the referee's first delivered order

      const minSubtotal = this.settings.get<number>('marketing.referralMinSubtotal', 0);
      if (minSubtotal > 0 && (order.subtotal ?? 0) < minSubtotal) return;

      referral.status = 'REWARDED';
      referral.rewardedAt = new Date();
      await this.repo.save(referral);

      await this.wallet.credit(referral.referrerId, referral.referrerReward, 'REFERRAL', { orderId: order.id, note: 'Referral reward' });
      await this.wallet.credit(referral.refereeId, referral.refereeReward, 'REFERRAL', { orderId: order.id, note: 'Referral welcome credit' });

      await this.notifications.notify({ userId: referral.referrerId, audience: 'CUSTOMER', event: 'credit.issued', vars: { amount: `$${referral.referrerReward.toFixed(2)}` } });
      await this.notifications.notify({ userId: referral.refereeId, audience: 'CUSTOMER', event: 'credit.issued', vars: { amount: `$${referral.refereeReward.toFixed(2)}` } });
    } catch (e: any) {
      this.logger.error(`referral reward failed: ${e.message}`);
    }
  }
}

// ------------------------------------------------------------------ admin controller
@AdminController('referrals')
export class ReferralsAdminController {
  constructor(private svc: ReferralsAdminService, private audit: AuditService) {}

  @Get()
  @Permission(Module.PROMOTIONS, Action.VIEW)
  list(@Query() q: ReferralQuery) {
    return this.svc.list(q);
  }

  @Get('stats')
  @Permission(Module.PROMOTIONS, Action.VIEW)
  stats() {
    return this.svc.stats();
  }

  @Get('settings')
  @Permission(Module.PROMOTIONS, Action.VIEW)
  settings() {
    return this.svc.settingsView();
  }

  @Patch('settings')
  @Permission(Module.PROMOTIONS, Action.EDIT)
  async updateSettings(@Body() dto: ReferralSettingsDto, @Req() req: any) {
    const { before, after } = await this.svc.updateSettings(dto);
    await this.audit.logReq(req, 'referral.settings_update', 'setting', 'marketing.referral', before, after);
    return after;
  }

  @Post(':id/void')
  @Permission(Module.PROMOTIONS, Action.EDIT)
  async void(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    const { before, after } = await this.svc.void(id);
    await this.audit.logReq(req, 'referral.void', 'referral', id, before, after);
    return after;
  }
}
