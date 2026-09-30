import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Brackets, DataSource, In } from 'typeorm';
import { Address, CustomerProfile, DataRequest, Order, Refund, RefreshToken, User, WalletTransaction } from '../database/entities';
import { Action, Module, RefundStatus, UserStatus, UserType } from '../common/enums';
import { AuthUser } from '../common/auth.types';
import { hasPermission } from '../common/guards';
import { PageQueryDto, like, paginateQb } from '../common/pagination';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { DataRequestsService } from './data-requests.service';
import { ExternalServices } from './lazy';
import { fullName, round2 } from './util';
import { BlockCustomerDto, SetFlagsDto } from './dto';

/**
 * Admin surface for CustomersModule (spec §12 / ARCHITECTURE.md CustomersModule row): list/detail, orders, wallet
 * view + manual adjustment, block/unblock, fraud flags, notes, refund stats, and the PIPEDA deletion/access queue.
 */
@Injectable()
export class AdminCustomersService {
  constructor(
    @InjectDataSource() private ds: DataSource,
    private ext: ExternalServices,
    private dataRequests: DataRequestsService,
    private audit: AuditService,
    private settings: SettingsService,
  ) {}

  private profileOrThrow(userId: string) {
    return this.ds
      .getRepository(CustomerProfile)
      .findOne({ where: { userId } })
      .then((p) => {
        if (!p) throw new NotFoundException('Customer not found');
        return p;
      });
  }

  // ------------------------------------------------------------------ list / detail
  async list(q: PageQueryDto & { blocked?: string; fraudFlag?: string }) {
    const qb = this.ds.getRepository(CustomerProfile).createQueryBuilder('p').innerJoin(User, 'u', 'u.id = p."userId"');
    if (q.search) {
      qb.andWhere(
        new Brackets((b) =>
          b
            .where('u.email ILIKE :s', { s: like(q.search!) })
            .orWhere('u.phone ILIKE :s', { s: like(q.search!) })
            .orWhere(`(u."firstName" || ' ' || u."lastName") ILIKE :s`, { s: like(q.search!) }),
        ),
      );
    }
    if (q.blocked !== undefined) qb.andWhere('p."isBlocked" = :b', { b: q.blocked === 'true' });
    if (q.fraudFlag !== undefined) qb.andWhere('p."fraudFlag" = :f', { f: q.fraudFlag === 'true' });
    const { data, meta } = await paginateQb(qb, q, {
      sortable: { createdAt: 'p.createdAt', totalOrders: 'p.totalOrders', lifetimeSpend: 'p.lifetimeSpend', lastOrderAt: 'p.lastOrderAt' },
      defaultSort: ['p.createdAt', 'DESC'],
    });
    const users = data.length ? await this.ds.getRepository(User).find({ where: { id: In(data.map((p) => p.userId)) } }) : [];
    const um = new Map(users.map((u) => [u.id, u]));
    return {
      data: data.map((p) => {
        const u = um.get(p.userId);
        return {
          id: p.userId,
          name: fullName(u),
          email: u?.email ?? null,
          phone: u?.phone ?? null,
          status: u?.status ?? null,
          totalOrders: p.totalOrders,
          lifetimeSpend: p.lifetimeSpend,
          walletBalance: p.walletBalance,
          isBlocked: p.isBlocked,
          fraudFlag: p.fraudFlag,
          flags: p.flags,
          lastOrderAt: p.lastOrderAt,
          createdAt: p.createdAt,
        };
      }),
      meta,
    };
  }

  async detail(userId: string) {
    const [user, profile, addressCount, recentOrders] = await Promise.all([
      this.ds.getRepository(User).findOne({ where: { id: userId, type: UserType.CUSTOMER } }),
      this.ds.getRepository(CustomerProfile).findOne({ where: { userId } }),
      this.ds.getRepository(Address).count({ where: { customerId: userId } }),
      this.ds.getRepository(Order).find({ where: { customerId: userId }, order: { createdAt: 'DESC' }, take: 5 }),
    ]);
    if (!user || !profile) throw new NotFoundException('Customer not found');
    return {
      id: user.id,
      email: user.email,
      phone: user.phone,
      firstName: user.firstName,
      lastName: user.lastName,
      status: user.status,
      emailVerified: user.emailVerified,
      phoneVerified: user.phoneVerified,
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt,
      profile: {
        dietaryPreferences: profile.dietaryPreferences,
        allergens: profile.allergens,
        walletBalance: profile.walletBalance,
        referralCode: profile.referralCode,
        marketingEmailConsent: profile.marketingEmailConsent,
        marketingSmsConsent: profile.marketingSmsConsent,
        isBlocked: profile.isBlocked,
        blockReason: profile.blockReason,
        fraudFlag: profile.fraudFlag,
        flags: profile.flags,
        totalOrders: profile.totalOrders,
        lifetimeSpend: profile.lifetimeSpend,
        lastOrderAt: profile.lastOrderAt,
        internalNotes: profile.internalNotes,
        deletionRequestedAt: profile.deletionRequestedAt,
      },
      addressCount,
      recentOrders: recentOrders.map((o) => ({ id: o.id, code: o.code, status: o.status, total: o.total, createdAt: o.createdAt })),
      refundStats: await this.refundStats(userId),
    };
  }

  async ordersOf(userId: string, q: PageQueryDto & { status?: string }) {
    await this.profileOrThrow(userId);
    const qb = this.ds.getRepository(Order).createQueryBuilder('o').where('o."customerId" = :userId', { userId });
    if (q.status) qb.andWhere('o.status = :status', { status: q.status });
    return paginateQb(qb, q, { sortable: { createdAt: 'o.createdAt', total: 'o.total', status: 'o.status' }, defaultSort: ['o.createdAt', 'DESC'] });
  }

  async walletOf(userId: string, page = 1, limit = 20) {
    const profile = await this.profileOrThrow(userId);
    const [rows, total] = await this.ds
      .getRepository(WalletTransaction)
      .findAndCount({ where: { customerId: userId }, order: { createdAt: 'DESC' }, skip: (page - 1) * limit, take: limit });
    return { balance: profile.walletBalance, transactions: { data: rows, meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } } };
  }

  // ------------------------------------------------------------------ wallet adjustment
  async adjustWallet(actor: AuthUser, userId: string, amount: number, reason: string) {
    await this.profileOrThrow(userId);
    if (!amount) throw new BadRequestException('Amount must not be zero');
    const threshold = this.settings.get<number>('customers.walletAdjustApprovalThreshold', 100);
    if (Math.abs(amount) > threshold && !hasPermission(actor, Module.CUSTOMERS, Action.APPROVE)) {
      throw new ForbiddenException(`Wallet adjustments above $${threshold} need the customers:approve permission`);
    }
    const before = await this.ext.wallet.balance(userId);
    const after =
      amount > 0
        ? await this.ext.wallet.credit(userId, amount, 'ADJUSTMENT', { note: reason, actorId: actor.id })
        : await this.ext.wallet.debit(userId, Math.abs(amount), 'ADJUSTMENT', { note: reason, actorId: actor.id });
    await this.audit.log({ actor, action: 'customer.wallet_adjust', entity: 'CustomerProfile', entityId: userId, before: { balance: before }, after: { balance: after, amount, reason } });
    return { balance: after };
  }

  // ------------------------------------------------------------------ block / fraud / notes
  async block(actor: AuthUser, userId: string, dto: BlockCustomerDto) {
    const profile = await this.profileOrThrow(userId);
    await this.ds.getRepository(CustomerProfile).update({ userId }, { isBlocked: true, blockReason: dto.reason });
    await this.audit.log({ actor, action: 'customer.block', entity: 'CustomerProfile', entityId: userId, before: { isBlocked: profile.isBlocked }, after: { isBlocked: true, reason: dto.reason } });
    return { ok: true };
  }

  async unblock(actor: AuthUser, userId: string) {
    await this.profileOrThrow(userId);
    await this.ds.getRepository(CustomerProfile).update({ userId }, { isBlocked: false, blockReason: null });
    await this.audit.log({ actor, action: 'customer.unblock', entity: 'CustomerProfile', entityId: userId });
    return { ok: true };
  }

  async setFlags(actor: AuthUser, userId: string, dto: SetFlagsDto) {
    const profile = await this.profileOrThrow(userId);
    const patch: Partial<CustomerProfile> = {};
    let flags = [...profile.flags];
    if (dto.addFlag && !flags.includes(dto.addFlag)) flags = [...flags, dto.addFlag];
    if (dto.removeFlag) flags = flags.filter((f) => f !== dto.removeFlag);
    if (dto.addFlag !== undefined || dto.removeFlag !== undefined) patch.flags = flags;
    if (dto.fraudFlag !== undefined) patch.fraudFlag = dto.fraudFlag;
    if (Object.keys(patch).length) {
      await this.ds.getRepository(CustomerProfile).update({ userId }, patch);
      await this.audit.log({ actor, action: 'customer.flags_update', entity: 'CustomerProfile', entityId: userId, before: { flags: profile.flags, fraudFlag: profile.fraudFlag }, after: patch });
    }
    return this.profileOrThrow(userId);
  }

  async setNotes(actor: AuthUser, userId: string, note: string) {
    const profile = await this.profileOrThrow(userId);
    const stamp = `[${new Date().toISOString().slice(0, 16).replace('T', ' ')} ${actor.name || actor.email || actor.id}] ${note}`;
    const combined = (profile.internalNotes ? `${profile.internalNotes}\n${stamp}` : stamp).slice(-8000);
    await this.ds.getRepository(CustomerProfile).update({ userId }, { internalNotes: combined });
    await this.audit.log({ actor, action: 'customer.note_added', entity: 'CustomerProfile', entityId: userId, after: { note } });
    return { internalNotes: combined };
  }

  // ------------------------------------------------------------------ refund stats
  async refundStats(userId: string) {
    const since = new Date(Date.now() - 30 * 86400_000);
    const refunds = this.ds.getRepository(Refund).createQueryBuilder('r').innerJoin(Order, 'o', 'o.id = r."orderId"');
    const row30 = await refunds
      .clone()
      .select('COUNT(*)', 'n')
      .addSelect('COALESCE(SUM(r.amount),0)', 'total')
      .where('o."customerId" = :userId AND r.status <> :rej AND r."createdAt" >= :since', { userId, rej: RefundStatus.REJECTED, since })
      .getRawOne<{ n: string; total: string }>();
    const rowAll = await refunds
      .clone()
      .select('COUNT(*)', 'n')
      .addSelect('COALESCE(SUM(r.amount),0)', 'total')
      .where('o."customerId" = :userId AND r.status <> :rej', { userId, rej: RefundStatus.REJECTED })
      .getRawOne<{ n: string; total: string }>();
    const limit = this.settings.get<number>('security.refundFrequencyLimit30d', 4);
    const count30d = Number(row30?.n ?? 0);
    return {
      refundCount30d: count30d,
      refundTotal30d: round2(Number(row30?.total ?? 0)),
      refundCountLifetime: Number(rowAll?.n ?? 0),
      refundTotalLifetime: round2(Number(rowAll?.total ?? 0)),
      refundFrequencyLimit: limit,
      overLimit: count30d >= limit,
    };
  }

  // ------------------------------------------------------------------ PIPEDA deletion / access requests
  async dataRequestsList(q: PageQueryDto & { status?: string; type?: string }) {
    const qb = this.ds.getRepository(DataRequest).createQueryBuilder('r');
    if (q.status) qb.andWhere('r.status = :status', { status: q.status });
    if (q.type) qb.andWhere('r.type = :type', { type: q.type });
    const { data, meta } = await paginateQb(qb, q, { sortable: { createdAt: 'r.createdAt', dueAt: 'r."dueAt"' }, defaultSort: ['r.createdAt', 'DESC'] });
    const users = data.length ? await this.ds.getRepository(User).find({ where: { id: In(data.map((d) => d.userId)) } }) : [];
    const um = new Map(users.map((u) => [u.id, u]));
    return {
      data: data.map((d) => ({ ...d, customer: um.has(d.userId) ? { id: d.userId, name: fullName(um.get(d.userId)), email: um.get(d.userId)!.email } : null })),
      meta,
    };
  }

  async approveDataRequest(actor: AuthUser, id: string, notes?: string) {
    const repo = this.ds.getRepository(DataRequest);
    const req = await repo.findOne({ where: { id } });
    if (!req) throw new NotFoundException('Request not found');
    if (req.status !== 'PENDING' && req.status !== 'IN_PROGRESS') throw new BadRequestException('Request already resolved');
    if (req.type === 'DELETION') await this.anonymise(req.userId);
    req.status = 'COMPLETED';
    req.completedAt = new Date();
    req.handledById = actor.id;
    if (notes) req.notes = `${req.notes ?? ''}\n${notes}`.trim();
    await repo.save(req);
    await this.audit.log({ actor, action: 'customer.data_request_approve', entity: 'DataRequest', entityId: id, after: { type: req.type } });
    return req;
  }

  async rejectDataRequest(actor: AuthUser, id: string, reason: string) {
    const repo = this.ds.getRepository(DataRequest);
    const req = await repo.findOne({ where: { id } });
    if (!req) throw new NotFoundException('Request not found');
    if (req.status !== 'PENDING' && req.status !== 'IN_PROGRESS') throw new BadRequestException('Request already resolved');
    req.status = 'REJECTED';
    req.completedAt = new Date();
    req.handledById = actor.id;
    req.notes = `${req.notes ?? ''}\n[Rejected] ${reason}`.trim();
    await repo.save(req);
    await this.audit.log({ actor, action: 'customer.data_request_reject', entity: 'DataRequest', entityId: id, after: { reason } });
    return req;
  }

  async exportDataRequest(id: string) {
    const req = await this.ds.getRepository(DataRequest).findOne({ where: { id } });
    if (!req) throw new NotFoundException('Request not found');
    if (req.type !== 'ACCESS') throw new BadRequestException('Only ACCESS requests produce an export');
    return this.dataRequests.exportForOwner(req.userId, id);
  }

  /** PIPEDA deletion: scrub PII, keep financial/order history (legal retention) intact. */
  private async anonymise(userId: string) {
    const user = await this.ds.getRepository(User).findOne({ where: { id: userId } });
    if (!user) return;
    const anonEmail = `deleted+${userId}@forksy.invalid`;
    await this.ds.transaction(async (em) => {
      await em.update(
        User,
        userId,
        {
          email: anonEmail,
          phone: null,
          firstName: 'Deleted',
          lastName: 'Customer',
          avatarUrl: null,
          status: UserStatus.DELETED,
          passwordHash: null,
          googleId: null,
          appleId: null,
          twoFactorSecret: null,
          twoFactorEnabled: false,
        } as any,
      );
      await em.update(CustomerProfile, { userId }, { dietaryPreferences: [], allergens: [], marketingEmailConsent: false, marketingSmsConsent: false, pushEnabled: false, stripeCustomerId: null, internalNotes: null, meta: {} } as any);
      await em.delete(Address, { customerId: userId });
      await em.delete(RefreshToken, { userId });
    });
  }
}
