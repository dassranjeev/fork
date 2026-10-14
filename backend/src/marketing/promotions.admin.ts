import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'crypto';
import { Brackets, Repository } from 'typeorm';
import { MenuItem, Promotion, Restaurant } from '../database/entities';
import { FundedBy, PromoType } from '../common/enums';
import { AuthUser } from '../common/auth.types';
import { paginateQb, like } from '../common/pagination';
import { NotificationsService } from '../notifications/notifications.service';
import { SettingsService } from '../settings/settings.service';
import { PromotionsService } from './promotions.service';
import {
  BatchPromotionDto,
  normCode,
  PromotionDto,
  PromotionQuery,
  RestaurantPromotionDto,
  RestaurantPromotionQuery,
  toDate,
  UpdatePromotionDto,
  validatePromotionFields,
} from './promotions.dto';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const randCode = (n: number) => Array.from(randomBytes(n), (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');

@Injectable()
export class PromotionsAdminService {
  constructor(
    @InjectRepository(Promotion) private repo: Repository<Promotion>,
    @InjectRepository(Restaurant) private restaurants: Repository<Restaurant>,
    @InjectRepository(MenuItem) private menuItems: Repository<MenuItem>,
    private promos: PromotionsService,
    private notifications: NotificationsService,
    private settings: SettingsService,
  ) {}

  private applyStatus(qb: ReturnType<Repository<Promotion>['createQueryBuilder']>, status?: string) {
    switch ((status ?? '').toUpperCase()) {
      case 'ACTIVE':
        qb.andWhere('p.active = true AND p.pendingApproval = false AND (p.startsAt IS NULL OR p.startsAt <= now()) AND (p.endsAt IS NULL OR p.endsAt >= now())');
        break;
      case 'INACTIVE':
        qb.andWhere('p.active = false AND p.pendingApproval = false');
        break;
      case 'SCHEDULED':
        qb.andWhere('p.active = true AND p.startsAt > now()');
        break;
      case 'EXPIRED':
        qb.andWhere('p.endsAt < now()');
        break;
      case 'PENDING_APPROVAL':
        qb.andWhere('p.pendingApproval = true');
        break;
    }
  }

  private withStatus<T extends Promotion>(p: T) {
    const now = new Date();
    let status = 'ACTIVE';
    if (p.pendingApproval) status = 'PENDING_APPROVAL';
    else if (!p.active) status = 'INACTIVE';
    else if (p.endsAt && p.endsAt < now) status = 'EXPIRED';
    else if (p.startsAt && p.startsAt > now) status = 'SCHEDULED';
    else if (p.usageLimit != null && p.usedCount >= p.usageLimit) status = 'EXHAUSTED';
    else if (p.budget > 0 && p.spent >= p.budget) status = 'EXHAUSTED';
    return { ...p, status };
  }

  // ------------------------------------------------------------------ admin CRUD
  async list(q: PromotionQuery) {
    const qb = this.repo.createQueryBuilder('p');
    if (q.search) qb.andWhere(new Brackets((w) => w.where('p.name ILIKE :s OR p.code ILIKE :s', { s: like(q.search!) })));
    if (q.type) qb.andWhere('p.type = :type', { type: q.type });
    if (q.fundedBy) qb.andWhere('p.fundedBy = :fb', { fb: q.fundedBy });
    if (q.restaurantId) qb.andWhere('p.restaurantId = :rid', { rid: q.restaurantId });
    if (q.batchId) qb.andWhere('p.batchId = :bid', { bid: q.batchId });
    if (q.hasCode === 'true') qb.andWhere('p.code IS NOT NULL');
    if (q.hasCode === 'false') qb.andWhere('p.code IS NULL');
    this.applyStatus(qb, q.status);
    const res = await paginateQb(qb, q, {
      sortable: { createdAt: 'p.createdAt', name: 'p.name', usedCount: 'p.usedCount', spent: 'p.spent', endsAt: 'p.endsAt', startsAt: 'p.startsAt' },
      defaultSort: ['p.createdAt', 'DESC'],
    });
    const names = await this.restaurantNames(res.data.map((p) => p.restaurantId));
    return { ...res, data: res.data.map((p) => ({ ...this.withStatus(p), restaurantName: p.restaurantId ? names.get(p.restaurantId) ?? null : null })) };
  }

  private async restaurantNames(ids: (string | null)[]) {
    const uniq = [...new Set(ids.filter(Boolean) as string[])];
    const map = new Map<string, string>();
    if (uniq.length) for (const r of await this.restaurants.createQueryBuilder('r').select(['r.id', 'r.name']).where('r.id IN (:...uniq)', { uniq }).getMany()) map.set(r.id, r.name);
    return map;
  }

  async get(id: string) {
    const p = await this.repo.findOne({ where: { id } });
    if (!p) throw new NotFoundException('Promotion not found');
    const names = await this.restaurantNames([p.restaurantId]);
    return { ...this.withStatus(p), restaurantName: p.restaurantId ? names.get(p.restaurantId) ?? null : null };
  }

  private async assertCodeFree(code: string | null, exceptId?: string) {
    if (!code) return;
    const existing = await this.promos.findByCode(code);
    if (existing && existing.id !== exceptId) throw new ConflictException(`Promo code ${code} already exists`);
  }

  async create(dto: PromotionDto, user: AuthUser) {
    const code = normCode(dto.code);
    await this.assertCodeFree(code);
    const fundedBy = dto.fundedBy ?? (dto.restaurantId ? FundedBy.RESTAURANT : FundedBy.PLATFORM);
    const entity = this.repo.create({
      code,
      name: dto.name,
      description: dto.description ?? null,
      type: dto.type,
      value: dto.value ?? 0,
      maxDiscount: dto.maxDiscount ?? null,
      minSubtotal: dto.minSubtotal ?? 0,
      fundedBy,
      restaurantId: dto.restaurantId ?? null,
      cityId: dto.cityId ?? null,
      zoneIds: dto.zoneIds ?? [],
      menuItemId: dto.menuItemId ?? null,
      orderTypes: dto.orderTypes ?? [],
      startsAt: toDate(dto.startsAt),
      endsAt: toDate(dto.endsAt),
      usageLimit: dto.usageLimit ?? null,
      perUserLimit: dto.perUserLimit ?? 1,
      firstOrderOnly: dto.firstOrderOnly ?? false,
      autoApply: dto.autoApply ?? false,
      active: dto.active ?? true,
      pendingApproval: false,
      createdById: user.id,
      budget: dto.budget ?? 0,
      spent: 0,
      usedCount: 0,
    });
    if (!entity.code && !entity.autoApply) throw new BadRequestException('A promotion needs a code or must be auto-apply');
    validatePromotionFields(entity);
    return this.repo.save(entity);
  }

  async update(id: string, dto: UpdatePromotionDto) {
    const p = await this.repo.findOne({ where: { id } });
    if (!p) throw new NotFoundException('Promotion not found');
    const before = { ...p };
    if (dto.code !== undefined) {
      const code = normCode(dto.code);
      await this.assertCodeFree(code, id);
      p.code = code;
    }
    const { code: _c, startsAt, endsAt, ...rest } = dto;
    Object.assign(p, Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)));
    if (startsAt !== undefined) p.startsAt = toDate(startsAt);
    if (endsAt !== undefined) p.endsAt = toDate(endsAt);
    if (!p.code && !p.autoApply) throw new BadRequestException('A promotion needs a code or must be auto-apply');
    validatePromotionFields(p);
    await this.repo.save(p);
    return { before, after: p };
  }

  async setActive(id: string, active: boolean) {
    const p = await this.repo.findOne({ where: { id } });
    if (!p) throw new NotFoundException('Promotion not found');
    if (active && p.pendingApproval) throw new BadRequestException('Approve this promotion before activating it');
    const before = { ...p };
    p.active = active;
    await this.repo.save(p);
    return { before, after: p };
  }

  async duplicate(id: string, user: AuthUser) {
    const p = await this.repo.findOne({ where: { id } });
    if (!p) throw new NotFoundException('Promotion not found');
    const copy = this.repo.create({
      ...p,
      id: undefined,
      createdAt: undefined,
      updatedAt: undefined,
      code: p.code ? await this.uniqueCopyCode(p.code) : null,
      name: `${p.name} (copy)`,
      usedCount: 0,
      spent: 0,
      active: false,
      pendingApproval: false,
      rejectionReason: null,
      batchId: null,
      createdById: user.id,
    } as Partial<Promotion>);
    return this.repo.save(copy);
  }

  private async uniqueCopyCode(code: string) {
    for (let i = 0; i < 10; i++) {
      const c = `${code}-${randCode(3)}`;
      if (!(await this.promos.findByCode(c))) return c;
    }
    return `${code}-${randCode(6)}`;
  }

  async remove(id: string) {
    const p = await this.repo.findOne({ where: { id } });
    if (!p) throw new NotFoundException('Promotion not found');
    if (p.usedCount > 0) {
      // keep history: deactivate instead of deleting
      p.active = false;
      await this.repo.save(p);
      return { deleted: false, deactivated: true, promotion: p };
    }
    await this.repo.delete({ id });
    return { deleted: true, deactivated: false, promotion: p };
  }

  /** Bulk create single-use (by default) code batches, e.g. for partners / events. */
  async createBatch(dto: BatchPromotionDto, user: AuthUser) {
    const prefix = normCode(dto.prefix)!.replace(/[^A-Z0-9]/g, '');
    if (!prefix) throw new BadRequestException('prefix is required');
    const batchId = `${prefix}-${Date.now().toString(36).toUpperCase()}`;
    const { prefix: _p, count, code: _c, ...base } = dto;
    const created: Promotion[] = [];
    for (let i = 0; i < count; i++) {
      let saved: Promotion | null = null;
      for (let attempt = 0; attempt < 6 && !saved; attempt++) {
        const code = `${prefix}-${randCode(6)}`;
        try {
          const tpl = await this.create({ ...base, code, usageLimit: base.usageLimit ?? 1, perUserLimit: base.perUserLimit ?? 1, autoApply: false, name: `${dto.name}` }, user);
          tpl.batchId = batchId;
          saved = await this.repo.save(tpl);
        } catch (e: any) {
          if (!(e instanceof ConflictException) && e.code !== '23505') throw e;
        }
      }
      if (!saved) throw new ConflictException('Could not generate unique codes, try a different prefix');
      created.push(saved);
    }
    return { batchId, count: created.length, codes: created.map((c) => c.code) };
  }

  // ------------------------------------------------------------------ approval queue
  async approvals(q: PromotionQuery) {
    const qb = this.repo.createQueryBuilder('p').where('p.pendingApproval = true');
    if (q.search) qb.andWhere('(p.name ILIKE :s OR p.code ILIKE :s)', { s: like(q.search) });
    const res = await paginateQb(qb, q, { sortable: { createdAt: 'p.createdAt' }, defaultSort: ['p.createdAt', 'ASC'] });
    const names = await this.restaurantNames(res.data.map((p) => p.restaurantId));
    return { ...res, data: res.data.map((p) => ({ ...p, restaurantName: p.restaurantId ? names.get(p.restaurantId) ?? null : null })) };
  }

  async approve(id: string) {
    const p = await this.repo.findOne({ where: { id } });
    if (!p) throw new NotFoundException('Promotion not found');
    if (!p.pendingApproval) throw new BadRequestException('Promotion is not awaiting approval');
    p.pendingApproval = false;
    p.active = true;
    p.rejectionReason = null;
    await this.repo.save(p);
    if (p.restaurantId) await this.notifications.notifyRestaurant(p.restaurantId, 'promo.approved', { name: p.name }, { promotionId: p.id });
    return p;
  }

  async reject(id: string, reason: string) {
    const p = await this.repo.findOne({ where: { id } });
    if (!p) throw new NotFoundException('Promotion not found');
    if (!p.pendingApproval) throw new BadRequestException('Promotion is not awaiting approval');
    p.pendingApproval = false;
    p.active = false;
    p.rejectionReason = reason;
    await this.repo.save(p);
    if (p.restaurantId) await this.notifications.notifyRestaurant(p.restaurantId, 'promo.rejected', { name: p.name, reason }, { promotionId: p.id });
    return p;
  }

  // ------------------------------------------------------------------ restaurant self-serve
  private locationIds(user: AuthUser, requested?: string): string[] {
    const mine = user.restaurantIds ?? [];
    if (requested) {
      if (!mine.includes(requested)) throw new ForbiddenException('You do not have access to that restaurant');
      return [requested];
    }
    return mine;
  }

  async restaurantList(user: AuthUser, q: RestaurantPromotionQuery) {
    const ids = this.locationIds(user, q.restaurantId);
    if (!ids.length) return { data: [], meta: { page: 1, limit: q.limit ?? 20, total: 0, totalPages: 1 } };
    const qb = this.repo.createQueryBuilder('p').where('p.restaurantId IN (:...ids)', { ids });
    if (q.search) qb.andWhere('(p.name ILIKE :s OR p.code ILIKE :s)', { s: like(q.search) });
    this.applyStatus(qb, q.status);
    const res = await paginateQb(qb, q, { sortable: { createdAt: 'p.createdAt', usedCount: 'p.usedCount' }, defaultSort: ['p.createdAt', 'DESC'] });
    return { ...res, data: res.data.map((p) => this.withStatus(p)) };
  }

  private async ownPromo(user: AuthUser, id: string) {
    const p = await this.repo.findOne({ where: { id } });
    if (!p || !p.restaurantId || !(user.restaurantIds ?? []).includes(p.restaurantId)) throw new NotFoundException('Promotion not found');
    return p;
  }

  async restaurantCreate(user: AuthUser, dto: RestaurantPromotionDto) {
    const ids = this.locationIds(user, dto.restaurantId);
    if (!ids.length) throw new ForbiddenException('No restaurant access');
    if (ids.length > 1) throw new BadRequestException('restaurantId is required for multi-location accounts');
    const restaurantId = ids[0];
    if (dto.menuItemId) {
      const item = await this.menuItems.findOne({ where: { id: dto.menuItemId, restaurantId } });
      if (!item) throw new BadRequestException('That menu item does not belong to this restaurant');
    }
    const code = normCode(dto.code);
    await this.assertCodeFree(code);
    const needsApproval = !!this.settings.get<boolean>('restaurant.selfServePromosNeedApproval', false);
    const entity = this.repo.create({
      code,
      name: dto.name,
      description: dto.description ?? null,
      type: dto.type,
      value: dto.type === PromoType.PERCENT ? dto.value ?? 0 : 0,
      maxDiscount: dto.maxDiscount ?? null,
      minSubtotal: dto.minSubtotal ?? 0,
      fundedBy: FundedBy.RESTAURANT,
      restaurantId,
      cityId: null,
      zoneIds: [],
      menuItemId: dto.menuItemId ?? null,
      orderTypes: dto.type === PromoType.FREE_DELIVERY ? ['DELIVERY'] : dto.orderTypes ?? [],
      startsAt: toDate(dto.startsAt),
      endsAt: toDate(dto.endsAt),
      usageLimit: dto.usageLimit ?? null,
      perUserLimit: dto.perUserLimit ?? 0,
      firstOrderOnly: false,
      autoApply: !code,
      active: !needsApproval,
      pendingApproval: needsApproval,
      createdById: user.id,
      budget: dto.budget ?? 0,
      spent: 0,
      usedCount: 0,
    });
    validatePromotionFields(entity);
    const saved = await this.repo.save(entity);
    if (needsApproval) {
      const r = await this.restaurants.findOne({ where: { id: restaurantId }, select: ['id', 'name'] });
      await this.notifications.notifyOps('promo.pending', { restaurant: r?.name ?? '', name: saved.name }, { promotionId: saved.id, restaurantId });
    }
    return this.withStatus(saved);
  }

  async restaurantSetActive(user: AuthUser, id: string, active: boolean) {
    const p = await this.ownPromo(user, id);
    if (p.pendingApproval) throw new BadRequestException('This promotion is awaiting approval');
    if (active && p.rejectionReason) throw new BadRequestException('This promotion was rejected by FORKY and cannot be activated');
    p.active = active;
    await this.repo.save(p);
    return this.withStatus(p);
  }

  async restaurantStats(user: AuthUser, id: string) {
    await this.ownPromo(user, id);
    return this.promos.stats(id);
  }

  async restaurantRemove(user: AuthUser, id: string) {
    const p = await this.ownPromo(user, id);
    if (p.usedCount > 0) {
      p.active = false;
      await this.repo.save(p);
      return { deleted: false, deactivated: true };
    }
    await this.repo.delete({ id });
    return { deleted: true, deactivated: false };
  }
}
