import { BadRequestException, Body, ConflictException, Delete, Get, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import { Brackets, Repository } from 'typeorm';
import { Banner, CmsPage, Faq } from '../database/entities';
import { AdminController, Permission, PublicController } from '../common/decorators';
import { Action, Module } from '../common/enums';
import { PageQueryDto, paginateQb, like } from '../common/pagination';
import { AuditService } from '../audit/audit.service';

const PLACEMENTS = ['HOME', 'RESTAURANT_LIST', 'CHECKOUT', 'DRIVER_APP', 'RESTAURANT_PORTAL'] as const;
const AUDIENCES = ['CUSTOMER', 'DRIVER', 'RESTAURANT'] as const;
const CATEGORIES = ['LEGAL', 'HELP', 'MARKETING'] as const;

// ------------------------------------------------------------------ DTOs
class BannerDto {
  @IsString() title: string;
  @IsOptional() @IsString() subtitle?: string | null;
  @IsString() imageUrl: string;
  /** restaurant:<id> | promo:<code> | url:https://... */
  @IsOptional() @IsString() link?: string | null;
  @IsOptional() @IsIn(PLACEMENTS as unknown as string[]) placement?: Banner['placement'];
  @IsOptional() @IsUUID() cityId?: string | null;
  @IsOptional() @IsInt() sortOrder?: number;
  @IsOptional() @IsDateString() startsAt?: string | null;
  @IsOptional() @IsDateString() endsAt?: string | null;
  @IsOptional() @IsBoolean() active?: boolean;
}
class UpdateBannerDto {
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsString() subtitle?: string | null;
  @IsOptional() @IsString() imageUrl?: string;
  @IsOptional() @IsString() link?: string | null;
  @IsOptional() @IsIn(PLACEMENTS as unknown as string[]) placement?: Banner['placement'];
  @IsOptional() @IsUUID() cityId?: string | null;
  @IsOptional() @IsInt() sortOrder?: number;
  @IsOptional() @IsDateString() startsAt?: string | null;
  @IsOptional() @IsDateString() endsAt?: string | null;
  @IsOptional() @IsBoolean() active?: boolean;
}
class BannerQuery extends PageQueryDto {
  @IsOptional() @IsString() placement?: string;
  @IsOptional() @IsString() cityId?: string;
  @IsOptional() @IsString() active?: string;
}

class CmsPageDto {
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/, { message: 'slug must be lower-case letters, digits and dashes' }) @MaxLength(80) slug: string;
  @IsOptional() @IsString() @MaxLength(10) language?: string;
  @IsString() title: string;
  @IsString() body: string;
  @IsOptional() @IsBoolean() published?: boolean;
  @IsOptional() @IsIn(CATEGORIES as unknown as string[]) category?: CmsPage['category'];
}
class UpdateCmsPageDto {
  @IsOptional() @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/) @MaxLength(80) slug?: string;
  @IsOptional() @IsString() @MaxLength(10) language?: string;
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsString() body?: string;
  @IsOptional() @IsBoolean() published?: boolean;
  @IsOptional() @IsIn(CATEGORIES as unknown as string[]) category?: CmsPage['category'];
}
class CmsQuery extends PageQueryDto {
  @IsOptional() @IsString() language?: string;
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsString() published?: string;
  @IsOptional() @IsString() slug?: string;
}

class FaqDto {
  @IsString() question: string;
  @IsString() answer: string;
  @IsOptional() @IsIn(AUDIENCES as unknown as string[]) audience?: Faq['audience'];
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsString() @MaxLength(10) language?: string;
  @IsOptional() @IsInt() sortOrder?: number;
  @IsOptional() @IsBoolean() active?: boolean;
}
class UpdateFaqDto {
  @IsOptional() @IsString() question?: string;
  @IsOptional() @IsString() answer?: string;
  @IsOptional() @IsIn(AUDIENCES as unknown as string[]) audience?: Faq['audience'];
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsString() @MaxLength(10) language?: string;
  @IsOptional() @IsInt() sortOrder?: number;
  @IsOptional() @IsBoolean() active?: boolean;
}
class FaqQuery extends PageQueryDto {
  @IsOptional() @IsString() audience?: string;
  @IsOptional() @IsString() language?: string;
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsString() active?: string;
}

const bool = (v?: string) => (v === undefined || v === '' ? undefined : v === 'true' || v === '1');
const date = (v?: string | null) => (v ? new Date(v) : null);

// ------------------------------------------------------------------ service
@Injectable()
export class ContentService {
  constructor(
    @InjectRepository(Banner) public banners: Repository<Banner>,
    @InjectRepository(CmsPage) public pages: Repository<CmsPage>,
    @InjectRepository(Faq) public faqs: Repository<Faq>,
  ) {}

  async activeBanners(placement?: string, cityId?: string) {
    const qb = this.banners
      .createQueryBuilder('b')
      .where('b.active = true')
      .andWhere('(b.startsAt IS NULL OR b.startsAt <= now()) AND (b.endsAt IS NULL OR b.endsAt >= now())');
    if (placement) qb.andWhere('b.placement = :placement', { placement });
    if (cityId) qb.andWhere('(b.cityId IS NULL OR b.cityId = :cityId)', { cityId });
    else qb.andWhere('b.cityId IS NULL');
    return qb.orderBy('b.sortOrder', 'ASC').addOrderBy('b.createdAt', 'DESC').getMany();
  }

  async publicPage(slug: string, lang = 'en') {
    const page =
      (await this.pages.findOne({ where: { slug, language: lang, published: true } })) ??
      (await this.pages.findOne({ where: { slug, language: 'en', published: true } }));
    if (!page) throw new NotFoundException('Page not found');
    const langs = (await this.pages.find({ where: { slug, published: true }, select: ['language'] })).map((p) => p.language);
    return { slug: page.slug, language: page.language, title: page.title, body: page.body, category: page.category, updatedAt: page.updatedAt, availableLanguages: langs };
  }

  async publicFaqs(audience?: string, lang = 'en') {
    const base = () => {
      const qb = this.faqs.createQueryBuilder('f').where('f.active = true');
      if (audience) qb.andWhere('f.audience = :audience', { audience: audience.toUpperCase() });
      return qb.orderBy('f.category', 'ASC').addOrderBy('f.sortOrder', 'ASC').addOrderBy('f.createdAt', 'ASC');
    };
    const rows = await base().andWhere('f.language = :lang', { lang }).getMany();
    if (rows.length || lang === 'en') return rows;
    return base().andWhere("f.language = 'en'").getMany();
  }
}

// ------------------------------------------------------------------ admin: banners
@AdminController('banners')
export class BannersAdminController {
  constructor(private content: ContentService, private audit: AuditService) {}

  @Get()
  @Permission(Module.CONTENT, Action.VIEW)
  list(@Query() q: BannerQuery) {
    const qb = this.content.banners.createQueryBuilder('b');
    if (q.search) qb.andWhere('(b.title ILIKE :s OR b.subtitle ILIKE :s)', { s: like(q.search) });
    if (q.placement) qb.andWhere('b.placement = :pl', { pl: q.placement });
    if (q.cityId) qb.andWhere('b.cityId = :cid', { cid: q.cityId });
    const a = bool(q.active);
    if (a !== undefined) qb.andWhere('b.active = :a', { a });
    return paginateQb(qb, q, { sortable: { sortOrder: 'b.sortOrder', createdAt: 'b.createdAt', title: 'b.title' }, defaultSort: ['b.sortOrder', 'ASC'] });
  }

  @Get(':id')
  @Permission(Module.CONTENT, Action.VIEW)
  async get(@Param('id', ParseUUIDPipe) id: string) {
    const b = await this.content.banners.findOne({ where: { id } });
    if (!b) throw new NotFoundException('Banner not found');
    return b;
  }

  @Post()
  @Permission(Module.CONTENT, Action.CREATE)
  async create(@Body() dto: BannerDto, @Req() req: any) {
    const b = await this.content.banners.save(
      this.content.banners.create({ ...dto, placement: dto.placement ?? 'HOME', startsAt: date(dto.startsAt), endsAt: date(dto.endsAt), subtitle: dto.subtitle ?? null, link: dto.link ?? null, cityId: dto.cityId ?? null }),
    );
    await this.audit.logReq(req, 'banner.create', 'banner', b.id, null, b);
    return b;
  }

  @Patch(':id')
  @Permission(Module.CONTENT, Action.EDIT)
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateBannerDto, @Req() req: any) {
    const b = await this.content.banners.findOne({ where: { id } });
    if (!b) throw new NotFoundException('Banner not found');
    const before = { ...b };
    const { startsAt, endsAt, ...rest } = dto;
    Object.assign(b, Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)));
    if (startsAt !== undefined) b.startsAt = date(startsAt);
    if (endsAt !== undefined) b.endsAt = date(endsAt);
    await this.content.banners.save(b);
    await this.audit.logReq(req, 'banner.update', 'banner', id, before, b);
    return b;
  }

  @Delete(':id')
  @Permission(Module.CONTENT, Action.DELETE)
  async remove(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    const b = await this.content.banners.findOne({ where: { id } });
    if (!b) throw new NotFoundException('Banner not found');
    await this.content.banners.delete({ id });
    await this.audit.logReq(req, 'banner.delete', 'banner', id, b, null);
    return { ok: true };
  }
}

// ------------------------------------------------------------------ admin: CMS pages
@AdminController('cms-pages')
export class CmsPagesAdminController {
  constructor(private content: ContentService, private audit: AuditService) {}

  @Get()
  @Permission(Module.CONTENT, Action.VIEW)
  list(@Query() q: CmsQuery) {
    const qb = this.content.pages.createQueryBuilder('c');
    if (q.search) qb.andWhere('(c.title ILIKE :s OR c.slug ILIKE :s)', { s: like(q.search) });
    if (q.language) qb.andWhere('c.language = :l', { l: q.language });
    if (q.category) qb.andWhere('c.category = :cat', { cat: q.category });
    if (q.slug) qb.andWhere('c.slug = :slug', { slug: q.slug });
    const p = bool(q.published);
    if (p !== undefined) qb.andWhere('c.published = :p', { p });
    // body omitted from lists to keep them light
    qb.select(['c.id', 'c.slug', 'c.language', 'c.title', 'c.published', 'c.category', 'c.createdAt', 'c.updatedAt']);
    return paginateQb(qb, q, { sortable: { slug: 'c.slug', title: 'c.title', updatedAt: 'c.updatedAt' }, defaultSort: ['c.slug', 'ASC'] });
  }

  @Get(':id')
  @Permission(Module.CONTENT, Action.VIEW)
  async get(@Param('id', ParseUUIDPipe) id: string) {
    const c = await this.content.pages.findOne({ where: { id } });
    if (!c) throw new NotFoundException('Page not found');
    const translations = await this.content.pages.find({ where: { slug: c.slug }, select: ['id', 'language', 'published'] });
    return { ...c, translations };
  }

  @Post()
  @Permission(Module.CONTENT, Action.CREATE)
  async create(@Body() dto: CmsPageDto, @Req() req: any) {
    const language = dto.language ?? 'en';
    if (await this.content.pages.findOne({ where: { slug: dto.slug, language } })) throw new ConflictException(`Page ${dto.slug} (${language}) already exists`);
    const c = await this.content.pages.save(this.content.pages.create({ ...dto, language, published: dto.published ?? false, category: dto.category ?? 'LEGAL' }));
    await this.audit.logReq(req, 'cms.create', 'cms_page', c.id, null, { slug: c.slug, language, published: c.published });
    return c;
  }

  @Patch(':id')
  @Permission(Module.CONTENT, Action.EDIT)
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCmsPageDto, @Req() req: any) {
    const c = await this.content.pages.findOne({ where: { id } });
    if (!c) throw new NotFoundException('Page not found');
    const before = { slug: c.slug, language: c.language, title: c.title, published: c.published };
    const slug = dto.slug ?? c.slug;
    const language = dto.language ?? c.language;
    if ((slug !== c.slug || language !== c.language) && (await this.content.pages.findOne({ where: { slug, language } }))) {
      throw new ConflictException(`Page ${slug} (${language}) already exists`);
    }
    Object.assign(c, Object.fromEntries(Object.entries(dto).filter(([, v]) => v !== undefined)));
    await this.content.pages.save(c);
    await this.audit.logReq(req, 'cms.update', 'cms_page', id, before, { slug: c.slug, language: c.language, title: c.title, published: c.published });
    return c;
  }

  @Post(':id/publish')
  @Permission(Module.CONTENT, Action.EDIT)
  async publish(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    return this.setPublished(id, true, req);
  }

  @Post(':id/unpublish')
  @Permission(Module.CONTENT, Action.EDIT)
  async unpublish(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    return this.setPublished(id, false, req);
  }

  private async setPublished(id: string, published: boolean, req: any) {
    const c = await this.content.pages.findOne({ where: { id } });
    if (!c) throw new NotFoundException('Page not found');
    c.published = published;
    await this.content.pages.save(c);
    await this.audit.logReq(req, published ? 'cms.publish' : 'cms.unpublish', 'cms_page', id, { published: !published }, { published });
    return c;
  }

  @Delete(':id')
  @Permission(Module.CONTENT, Action.DELETE)
  async remove(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    const c = await this.content.pages.findOne({ where: { id } });
    if (!c) throw new NotFoundException('Page not found');
    await this.content.pages.delete({ id });
    await this.audit.logReq(req, 'cms.delete', 'cms_page', id, { slug: c.slug, language: c.language }, null);
    return { ok: true };
  }
}

// ------------------------------------------------------------------ admin: FAQs
@AdminController('faqs')
export class FaqsAdminController {
  constructor(private content: ContentService, private audit: AuditService) {}

  @Get()
  @Permission(Module.CONTENT, Action.VIEW)
  list(@Query() q: FaqQuery) {
    const qb = this.content.faqs.createQueryBuilder('f');
    if (q.search) qb.andWhere(new Brackets((w) => w.where('f.question ILIKE :s OR f.answer ILIKE :s', { s: like(q.search!) })));
    if (q.audience) qb.andWhere('f.audience = :a', { a: q.audience });
    if (q.language) qb.andWhere('f.language = :l', { l: q.language });
    if (q.category) qb.andWhere('f.category = :c', { c: q.category });
    const act = bool(q.active);
    if (act !== undefined) qb.andWhere('f.active = :act', { act });
    return paginateQb(qb, q, { sortable: { sortOrder: 'f.sortOrder', createdAt: 'f.createdAt', category: 'f.category' }, defaultSort: ['f.sortOrder', 'ASC'] });
  }

  @Get(':id')
  @Permission(Module.CONTENT, Action.VIEW)
  async get(@Param('id', ParseUUIDPipe) id: string) {
    const f = await this.content.faqs.findOne({ where: { id } });
    if (!f) throw new NotFoundException('FAQ not found');
    return f;
  }

  @Post()
  @Permission(Module.CONTENT, Action.CREATE)
  async create(@Body() dto: FaqDto, @Req() req: any) {
    const f = await this.content.faqs.save(this.content.faqs.create({ ...dto, audience: dto.audience ?? 'CUSTOMER', category: dto.category ?? 'General', language: dto.language ?? 'en' }));
    await this.audit.logReq(req, 'faq.create', 'faq', f.id, null, f);
    return f;
  }

  @Patch(':id')
  @Permission(Module.CONTENT, Action.EDIT)
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateFaqDto, @Req() req: any) {
    const f = await this.content.faqs.findOne({ where: { id } });
    if (!f) throw new NotFoundException('FAQ not found');
    const before = { ...f };
    Object.assign(f, Object.fromEntries(Object.entries(dto).filter(([, v]) => v !== undefined)));
    await this.content.faqs.save(f);
    await this.audit.logReq(req, 'faq.update', 'faq', id, before, f);
    return f;
  }

  @Delete(':id')
  @Permission(Module.CONTENT, Action.DELETE)
  async remove(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    const f = await this.content.faqs.findOne({ where: { id } });
    if (!f) throw new NotFoundException('FAQ not found');
    await this.content.faqs.delete({ id });
    await this.audit.logReq(req, 'faq.delete', 'faq', id, f, null);
    return { ok: true };
  }
}

// ------------------------------------------------------------------ public
@PublicController('banners')
export class PublicBannersController {
  constructor(private content: ContentService) {}

  @Get()
  list(@Query('placement') placement?: string, @Query('cityId') cityId?: string) {
    if (placement && !(PLACEMENTS as readonly string[]).includes(placement)) throw new BadRequestException(`placement must be one of ${PLACEMENTS.join(', ')}`);
    return this.content.activeBanners(placement, cityId);
  }
}

@PublicController('cms')
export class PublicCmsController {
  constructor(private content: ContentService) {}

  /** List of published pages (footer links). */
  @Get()
  async list(@Query('lang') lang = 'en', @Query('category') category?: string) {
    const qb = this.content.pages.createQueryBuilder('c').select(['c.slug', 'c.language', 'c.title', 'c.category']).where('c.published = true').andWhere('c.language = :lang', { lang });
    if (category) qb.andWhere('c.category = :category', { category });
    return qb.orderBy('c.slug', 'ASC').getMany();
  }

  @Get(':slug')
  get(@Param('slug') slug: string, @Query('lang') lang = 'en') {
    return this.content.publicPage(slug, lang);
  }
}

@PublicController('faqs')
export class PublicFaqsController {
  constructor(private content: ContentService) {}

  @Get()
  list(@Query('audience') audience?: string, @Query('lang') lang = 'en') {
    return this.content.publicFaqs(audience, lang);
  }
}
