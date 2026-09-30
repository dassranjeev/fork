import { BadRequestException, Body, ConflictException, Delete, Get, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, Repository } from 'typeorm';
import { CommissionTier, Cuisine, MenuItem, Restaurant, TaxClass } from '../database/entities';
import { AdminController, Permission, PublicController } from '../common/decorators';
import { Action, Module as Mod } from '../common/enums';
import { paginateQb, like } from '../common/pagination';
import { AuditService } from '../audit/audit.service';
import {
  ApplyTierDto,
  CreateCuisineDto,
  CreateTaxClassDto,
  CreateTierDto,
  CuisineQuery,
  ReorderDto,
  UpdateCuisineDto,
  UpdateTaxClassDto,
  UpdateTierDto,
} from './dto';
import { PageQueryDto } from '../common/pagination';

export const slugify = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

// ============================================================ tax classes
@Injectable()
export class TaxClassesService {
  constructor(
    @InjectRepository(TaxClass) private repo: Repository<TaxClass>,
    @InjectRepository(MenuItem) private items: Repository<MenuItem>,
    private audit: AuditService,
  ) {}

  async list(q: PageQueryDto) {
    const qb = this.repo.createQueryBuilder('t');
    if (q.search) qb.andWhere(new Brackets((w) => w.where('t.code ILIKE :s', { s: like(q.search!) }).orWhere('t.name ILIKE :s', { s: like(q.search!) })));
    const page = await paginateQb(qb, q, { sortable: { code: 't.code', name: 't.name', ratePct: 't.ratePct' }, defaultSort: ['t.code', 'ASC'] });
    const counts: { code: string; n: string }[] = await this.items.createQueryBuilder('m').select('m.taxClassCode', 'code').addSelect('COUNT(*)', 'n').groupBy('m.taxClassCode').getRawMany();
    const cm = new Map(counts.map((c) => [c.code, +c.n]));
    return { ...page, data: page.data.map((t) => ({ ...t, menuItemCount: cm.get(t.code) ?? 0 })) };
  }

  async get(id: string) {
    const t = await this.repo.findOne({ where: { id } });
    if (!t) throw new NotFoundException('Tax class not found');
    return t;
  }

  private async makeDefault(id: string) {
    await this.repo.createQueryBuilder().update().set({ isDefault: false }).where('id <> :id AND "isDefault" = true', { id }).execute();
  }

  async create(dto: CreateTaxClassDto, req: any) {
    if (await this.repo.findOne({ where: { code: dto.code } })) throw new ConflictException('Tax class code exists');
    const t = await this.repo.save(this.repo.create(dto));
    if (t.isDefault) await this.makeDefault(t.id);
    await this.audit.logReq(req, 'tax_class.create', 'tax_class', t.id, undefined, t);
    return t;
  }

  async update(id: string, dto: UpdateTaxClassDto, req: any) {
    const t = await this.get(id);
    const before = { ...t };
    if (dto.isDefault === false && t.isDefault) throw new BadRequestException('Set another class as default instead');
    if (dto.active === false && t.isDefault) throw new BadRequestException('The default tax class cannot be deactivated');
    Object.assign(t, dto);
    await this.repo.save(t);
    if (t.isDefault) await this.makeDefault(id);
    await this.audit.logReq(req, 'tax_class.update', 'tax_class', id, before, t);
    return t;
  }

  async remove(id: string, req: any) {
    const t = await this.get(id);
    if (t.isDefault) throw new ConflictException('The default tax class cannot be deleted');
    const used = await this.items.count({ where: { taxClassCode: t.code } });
    if (used) throw new ConflictException(`${used} menu items use this tax class. Deactivate it instead.`);
    await this.repo.delete(id);
    await this.audit.logReq(req, 'tax_class.delete', 'tax_class', id, t);
    return { deleted: true };
  }
}

@AdminController('tax-classes')
export class TaxClassesController {
  constructor(private svc: TaxClassesService) {}
  @Get() @Permission(Mod.PRICING, Action.VIEW) list(@Query() q: PageQueryDto) {
    return this.svc.list(q);
  }
  @Get(':id') @Permission(Mod.PRICING, Action.VIEW) get(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.get(id);
  }
  @Post() @Permission(Mod.PRICING, Action.CREATE) create(@Body() dto: CreateTaxClassDto, @Req() req: any) {
    return this.svc.create(dto, req);
  }
  @Patch(':id') @Permission(Mod.PRICING, Action.EDIT) update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTaxClassDto, @Req() req: any) {
    return this.svc.update(id, dto, req);
  }
  @Delete(':id') @Permission(Mod.PRICING, Action.DELETE) remove(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    return this.svc.remove(id, req);
  }
}

// ============================================================ commission tiers
@Injectable()
export class CommissionTiersService {
  constructor(
    @InjectRepository(CommissionTier) private repo: Repository<CommissionTier>,
    @InjectRepository(Restaurant) private restaurants: Repository<Restaurant>,
    private audit: AuditService,
  ) {}

  async list(q: PageQueryDto) {
    const qb = this.repo.createQueryBuilder('t');
    if (q.search) qb.andWhere('t.name ILIKE :s', { s: like(q.search) });
    const page = await paginateQb(qb, q, { sortable: { name: 't.name', deliveryPct: 't.deliveryPct', createdAt: 't.createdAt' }, defaultSort: ['t.deliveryPct', 'ASC'] });
    const counts: { id: string; n: string }[] = await this.restaurants.createQueryBuilder('r').select('r.commissionTierId', 'id').addSelect('COUNT(*)', 'n').where('r.commissionTierId IS NOT NULL').groupBy('r.commissionTierId').getRawMany();
    const cm = new Map(counts.map((c) => [c.id, +c.n]));
    return { ...page, data: page.data.map((t) => ({ ...t, restaurantCount: cm.get(t.id) ?? 0 })) };
  }

  async get(id: string) {
    const t = await this.repo.findOne({ where: { id } });
    if (!t) throw new NotFoundException('Commission tier not found');
    return { ...t, restaurantCount: await this.restaurants.count({ where: { commissionTierId: id } }) };
  }

  private async makeDefault(id: string) {
    await this.repo.createQueryBuilder().update().set({ isDefault: false }).where('id <> :id AND "isDefault" = true', { id }).execute();
  }

  async create(dto: CreateTierDto, req: any) {
    if (await this.repo.findOne({ where: { name: dto.name } })) throw new ConflictException('A tier with this name exists');
    const t = await this.repo.save(this.repo.create(dto));
    if (t.isDefault) await this.makeDefault(t.id);
    await this.audit.logReq(req, 'commission_tier.create', 'commission_tier', t.id, undefined, t);
    return t;
  }

  async update(id: string, dto: UpdateTierDto, req: any) {
    const t = await this.repo.findOne({ where: { id } });
    if (!t) throw new NotFoundException('Commission tier not found');
    if (dto.name && dto.name !== t.name && (await this.repo.findOne({ where: { name: dto.name } }))) throw new ConflictException('A tier with this name exists');
    if (dto.isDefault === false && t.isDefault) throw new BadRequestException('Set another tier as default instead');
    const before = { ...t };
    Object.assign(t, dto);
    await this.repo.save(t);
    if (t.isDefault) await this.makeDefault(id);
    // rate changes affect every restaurant on the tier: always audit with before/after
    await this.audit.logReq(req, 'commission_tier.update', 'commission_tier', id, before, t);
    return t;
  }

  async remove(id: string, req: any) {
    const t = await this.repo.findOne({ where: { id } });
    if (!t) throw new NotFoundException('Commission tier not found');
    if (t.isDefault) throw new ConflictException('The default tier cannot be deleted');
    const used = await this.restaurants.count({ where: { commissionTierId: id } });
    if (used) throw new ConflictException(`${used} restaurants are on this tier. Bulk-apply another tier first or deactivate it.`);
    await this.repo.delete(id);
    await this.audit.logReq(req, 'commission_tier.delete', 'commission_tier', id, t);
    return { deleted: true };
  }

  /** Bulk-apply a tier to restaurants selected by id list and/or city/zone/current tier. */
  async apply(id: string, dto: ApplyTierDto, req: any) {
    const tier = await this.repo.findOne({ where: { id } });
    if (!tier) throw new NotFoundException('Commission tier not found');
    if (!tier.active) throw new BadRequestException('Tier is inactive');
    if (!dto.restaurantIds?.length && !dto.cityId && !dto.zoneId && !dto.fromTierId) {
      throw new BadRequestException('Provide restaurantIds or at least one of cityId / zoneId / fromTierId');
    }
    const qb = this.restaurants.createQueryBuilder('r').select(['r.id', 'r.name', 'r.commissionTierId']);
    if (dto.restaurantIds?.length) qb.andWhere({ id: In(dto.restaurantIds) });
    if (dto.cityId) qb.andWhere('r.cityId = :c', { c: dto.cityId });
    if (dto.zoneId) qb.andWhere('r.zoneId = :z', { z: dto.zoneId });
    if (dto.fromTierId) qb.andWhere('r.commissionTierId = :f', { f: dto.fromTierId });
    const rows = await qb.getMany();
    const ids = rows.map((r) => r.id);
    if (dto.dryRun || !ids.length) return { matched: ids.length, updated: 0, dryRun: !!dto.dryRun, restaurants: rows.map((r) => ({ id: r.id, name: r.name, currentTierId: r.commissionTierId })) };
    const set: Partial<Restaurant> = { commissionTierId: id };
    if (dto.clearOverrides) Object.assign(set, { deliveryCommissionPct: null, pickupCommissionPct: null, ownDriverCommissionPct: null });
    await this.restaurants.update({ id: In(ids) }, set);
    await this.audit.logReq(req, 'commission_tier.bulk_apply', 'commission_tier', id, { restaurants: rows.map((r) => ({ id: r.id, tierId: r.commissionTierId })) }, { tier: tier.name, count: ids.length, clearOverrides: !!dto.clearOverrides });
    return { matched: ids.length, updated: ids.length, dryRun: false, tier: { id: tier.id, name: tier.name } };
  }
}

@AdminController('commission-tiers')
export class CommissionTiersController {
  constructor(private svc: CommissionTiersService) {}
  @Get() @Permission(Mod.PRICING, Action.VIEW) list(@Query() q: PageQueryDto) {
    return this.svc.list(q);
  }
  @Get(':id') @Permission(Mod.PRICING, Action.VIEW) get(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.get(id);
  }
  @Post() @Permission(Mod.PRICING, Action.CREATE) create(@Body() dto: CreateTierDto, @Req() req: any) {
    return this.svc.create(dto, req);
  }
  @Patch(':id') @Permission(Mod.PRICING, Action.EDIT) update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTierDto, @Req() req: any) {
    return this.svc.update(id, dto, req);
  }
  @Post(':id/apply') @Permission(Mod.PRICING, Action.EDIT) apply(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ApplyTierDto, @Req() req: any) {
    return this.svc.apply(id, dto, req);
  }
  @Delete(':id') @Permission(Mod.PRICING, Action.DELETE) remove(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    return this.svc.remove(id, req);
  }
}

// ============================================================ cuisines
@Injectable()
export class CuisinesService {
  constructor(
    @InjectRepository(Cuisine) private repo: Repository<Cuisine>,
    private audit: AuditService,
  ) {}

  async list(q: CuisineQuery) {
    const qb = this.repo.createQueryBuilder('c');
    if (q.search) qb.andWhere(new Brackets((w) => w.where('c.name ILIKE :s', { s: like(q.search!) }).orWhere('c.slug ILIKE :s', { s: like(q.search!) })));
    if (q.active !== undefined) qb.andWhere('c.active = :a', { a: q.active === 'true' });
    const page = await paginateQb(qb, q, { sortable: { name: 'c.name', sortOrder: 'c.sortOrder', createdAt: 'c.createdAt' }, defaultSort: ['c.sortOrder', 'ASC'] });
    const counts: { id: string; n: string }[] = await this.repo.query(`SELECT "cuisinesId" AS id, COUNT(*) n FROM restaurant_cuisines GROUP BY "cuisinesId"`).catch(() => []);
    const cm = new Map(counts.map((c) => [c.id, +c.n]));
    return { ...page, data: page.data.map((c) => ({ ...c, restaurantCount: cm.get(c.id) ?? 0 })) };
  }

  async get(id: string) {
    const c = await this.repo.findOne({ where: { id } });
    if (!c) throw new NotFoundException('Cuisine not found');
    return c;
  }

  private async uniqueSlug(base: string, ignoreId?: string) {
    let slug = base || 'cuisine';
    for (let i = 2; ; i++) {
      const hit = await this.repo.findOne({ where: { slug } });
      if (!hit || hit.id === ignoreId) return slug;
      slug = `${base}-${i}`;
    }
  }

  async create(dto: CreateCuisineDto, req: any) {
    if (dto.slug && (await this.repo.findOne({ where: { slug: dto.slug } }))) throw new ConflictException('Slug exists');
    const slug = dto.slug ?? (await this.uniqueSlug(slugify(dto.name)));
    let sortOrder = dto.sortOrder;
    if (sortOrder === undefined) sortOrder = ((await this.repo.createQueryBuilder('c').select('MAX(c.sortOrder)', 'm').getRawOne())?.m ?? 0) + 1;
    const c = await this.repo.save(this.repo.create({ ...dto, slug, sortOrder }));
    await this.audit.logReq(req, 'cuisine.create', 'cuisine', c.id, undefined, c);
    return c;
  }

  async update(id: string, dto: UpdateCuisineDto, req: any) {
    const c = await this.get(id);
    if (dto.slug && dto.slug !== c.slug && (await this.repo.findOne({ where: { slug: dto.slug } }))) throw new ConflictException('Slug exists');
    const before = { ...c };
    Object.assign(c, dto);
    await this.repo.save(c);
    await this.audit.logReq(req, 'cuisine.update', 'cuisine', id, before, c);
    return c;
  }

  async reorder(dto: ReorderDto, req: any) {
    const found = await this.repo.find({ where: { id: In(dto.ids) }, select: ['id'] });
    if (found.length !== new Set(dto.ids).size) throw new BadRequestException('Unknown cuisine id in list');
    await Promise.all(dto.ids.map((id, i) => this.repo.update(id, { sortOrder: i + 1 })));
    await this.audit.logReq(req, 'cuisine.reorder', 'cuisine', undefined, undefined, { ids: dto.ids });
    return { ok: true };
  }

  async remove(id: string, req: any) {
    const c = await this.get(id);
    const used: { n: string }[] = await this.repo.query(`SELECT COUNT(*) n FROM restaurant_cuisines WHERE "cuisinesId" = $1`, [id]).catch(() => [{ n: '0' }]);
    if (+used[0].n) throw new ConflictException(`${used[0].n} restaurants use this cuisine. Deactivate it instead.`);
    await this.repo.delete(id);
    await this.audit.logReq(req, 'cuisine.delete', 'cuisine', id, c);
    return { deleted: true };
  }

  publicList() {
    return this.repo.find({ where: { active: true }, order: { sortOrder: 'ASC', name: 'ASC' } }).then((rows) => rows.map((c) => ({ id: c.id, name: c.name, slug: c.slug, iconUrl: c.iconUrl, sortOrder: c.sortOrder })));
  }
}

@AdminController('cuisines')
export class CuisinesController {
  constructor(private svc: CuisinesService) {}
  @Get() @Permission(Mod.CONTENT, Action.VIEW) list(@Query() q: CuisineQuery) {
    return this.svc.list(q);
  }
  @Put('reorder') @Permission(Mod.CONTENT, Action.EDIT) reorder(@Body() dto: ReorderDto, @Req() req: any) {
    return this.svc.reorder(dto, req);
  }
  @Get(':id') @Permission(Mod.CONTENT, Action.VIEW) get(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.get(id);
  }
  @Post() @Permission(Mod.CONTENT, Action.CREATE) create(@Body() dto: CreateCuisineDto, @Req() req: any) {
    return this.svc.create(dto, req);
  }
  @Patch(':id') @Permission(Mod.CONTENT, Action.EDIT) update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCuisineDto, @Req() req: any) {
    return this.svc.update(id, dto, req);
  }
  @Delete(':id') @Permission(Mod.CONTENT, Action.DELETE) remove(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    return this.svc.remove(id, req);
  }
}

@PublicController()
export class PublicCuisinesController {
  constructor(private svc: CuisinesService) {}
  @Get('cuisines') list() {
    return this.svc.publicList();
  }
}
