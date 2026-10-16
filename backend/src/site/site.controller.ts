import { BadRequestException, Body, Delete, Get, Header, NotFoundException, Param, ParseIntPipe, Patch, Post, Put, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiOperation, ApiParam, ApiQuery } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { memoryStorage } from 'multer';
import { AuthUser } from '../common/auth.types';
import { AdminController, CurrentUser, Permission, PublicController } from '../common/decorators';
import { Action, Module } from '../common/enums';
import { BRANDING_SLOTS, SiteService } from './site.service';
import { SECTION_NAMES } from './site.schema';

class HeadQueryDto {
  /** the page of the customer website: a path with an optional query, e.g. /order/r/fresh-basket-supermarket or /order?t=GROCERY */
  @IsString() @MaxLength(300) path: string;
  /** language of the page, e.g. en-CA or fr (default: the site's default language) */
  @IsOptional() @Matches(/^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})*$/) @MaxLength(12) lang?: string;
}

const BODY = { schema: { type: 'object', additionalProperties: true, description: 'The fields of the section: see GET /admin/site/schema for the fields, their limits and their defaults' } } as const;
const SECTION_PARAM = { name: 'section', enum: [...SECTION_NAMES], description: 'general | branding | seo | geo | aeo | aio | footer | integrations | scripts' } as const;
const SLOT_PARAM = { name: 'slot', enum: Object.keys(BRANDING_SLOTS), description: 'Which picture: logo, logo-dark, logo-square, favicon, apple-touch-icon, pwa-icon-192, pwa-icon-512, og-image, twitter-image' } as const;

/**
 * General settings of the website (docs/site-settings.md): logo and icons, title, footer, meta tags and descriptions, SEO, GEO, AEO, AIO, analytics ids and custom CSS / JavaScript.
 * Reading needs site:view, changing needs site:edit; the custom CSS / JavaScript section (scripts) can only be changed by a Super Admin.
 */
@AdminController('site')
export class SiteAdminController {
  constructor(private site: SiteService) {}

  @Get()
  @Permission(Module.SITE, Action.VIEW)
  @ApiOperation({ summary: 'Every section with its saved values (or the defaults), version and who changed it last' })
  async all() {
    const sections = await this.site.all();
    return { version: await this.site.version(), sections: Object.fromEntries(sections.map((s) => [s.section, { value: s.value, version: s.version, updatedAt: s.updatedAt, updatedByName: s.updatedByName, isDefault: s.isDefault }])) };
  }

  @Get('schema')
  @Permission(Module.SITE, Action.VIEW)
  @ApiOperation({ summary: 'The fields of every section (type, limits, allowed values, defaults, help text): build the forms from this' })
  schema() {
    return this.site.schema();
  }

  @Get('options')
  @Permission(Module.SITE, Action.VIEW)
  @ApiOperation({ summary: 'Lists for dropdowns: social networks, AI crawlers, placeholders, the picture slots with their size rules' })
  options() {
    return this.site.options();
  }

  @Get('checks')
  @Permission(Module.SITE, Action.VIEW)
  @ApiOperation({ summary: 'What is missing or wrong (SEO, branding, GEO, AEO, AIO), in plain words, errors first' })
  checks() {
    return this.site.checks();
  }

  @Post('branding/:slot')
  @Permission(Module.SITE, Action.EDIT)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Upload a logo or icon: checks the picture (type, size, square), stores it and puts its address in the branding section' })
  @ApiParam(SLOT_PARAM)
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' } } } })
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 6 * 1024 * 1024, files: 1, fields: 2, parts: 4, fieldSize: 256, headerPairs: 30 } }))
  uploadBranding(@Param('slot') slot: string, @UploadedFile() file: Express.Multer.File, @CurrentUser() user: AuthUser) {
    return this.site.uploadBranding(slot, file, user);
  }

  @Delete('branding/:slot')
  @Permission(Module.SITE, Action.EDIT)
  @ApiOperation({ summary: 'Remove a logo or icon (the uploaded file is kept on the server)' })
  @ApiParam(SLOT_PARAM)
  clearBranding(@Param('slot') slot: string, @CurrentUser() user: AuthUser) {
    return this.site.clearBranding(slot, user);
  }

  @Get(':section')
  @Permission(Module.SITE, Action.VIEW)
  @ApiOperation({ summary: 'One section' })
  @ApiParam(SECTION_PARAM)
  async one(@Param('section') section: string) {
    const s = await this.site.section(this.site.assertSection(section));
    return { ...s, version: s.version };
  }

  @Put(':section')
  @Permission(Module.SITE, Action.EDIT)
  @ApiOperation({ summary: 'Replace a section: the body is the whole section, fields left out go back to their defaults. Nothing is saved when any field is wrong (400 with every problem listed)' })
  @ApiParam(SECTION_PARAM)
  @ApiBody(BODY)
  replace(@Param('section') section: string, @Body() body: Record<string, unknown>, @CurrentUser() user: AuthUser) {
    return this.site.save(this.site.assertSection(section), 'replace', body, user);
  }

  @Patch(':section')
  @Permission(Module.SITE, Action.EDIT)
  @ApiOperation({ summary: 'Change some fields of a section: send only the top-level fields that change (a field that holds an object or a list is replaced as a whole)' })
  @ApiParam(SECTION_PARAM)
  @ApiBody(BODY)
  merge(@Param('section') section: string, @Body() body: Record<string, unknown>, @CurrentUser() user: AuthUser) {
    return this.site.save(this.site.assertSection(section), 'merge', body, user);
  }

  @Post(':section/reset')
  @Permission(Module.SITE, Action.EDIT)
  @ApiOperation({ summary: 'Put a section back to its defaults' })
  @ApiParam(SECTION_PARAM)
  reset(@Param('section') section: string, @CurrentUser() user: AuthUser) {
    return this.site.reset(this.site.assertSection(section), user);
  }

  @Get(':section/revisions')
  @Permission(Module.SITE, Action.VIEW)
  @ApiOperation({ summary: 'The last saved versions of a section (newest first, 50 are kept)' })
  @ApiParam(SECTION_PARAM)
  @ApiQuery({ name: 'limit', required: false })
  revisions(@Param('section') section: string, @Query('limit') limit?: string) {
    return this.site.revisions(this.site.assertSection(section), limit && /^\d{1,2}$/.test(limit) ? Number(limit) : 20);
  }

  @Get(':section/revisions/:version')
  @Permission(Module.SITE, Action.VIEW)
  @ApiOperation({ summary: 'One saved version with its values' })
  @ApiParam(SECTION_PARAM)
  revision(@Param('section') section: string, @Param('version', ParseIntPipe) version: number) {
    return this.site.revision(this.site.assertSection(section), version);
  }

  @Post(':section/revisions/:version/restore')
  @Permission(Module.SITE, Action.EDIT)
  @ApiOperation({ summary: 'Put an earlier version back (saved as a new version)' })
  @ApiParam(SECTION_PARAM)
  restore(@Param('section') section: string, @Param('version', ParseIntPipe) version: number, @CurrentUser() user: AuthUser) {
    return this.site.restore(this.site.assertSection(section), version, user);
  }
}

/**
 * What the website reads (no sign-in). JSON answers are cached for a minute; robots.txt, sitemap.xml, llms.txt and the manifest are plain files
 * (serve them from the website's own address: see docs/site-settings.md "Serving the files").
 */
@PublicController('site')
export class SitePublicController {
  constructor(private site: SiteService) {}

  @Get()
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Header('Cache-Control', 'public, max-age=60, stale-while-revalidate=300')
  @ApiOperation({ summary: 'The website settings, ready to use: pictures as full addresses, the footer, SEO defaults, structured data facts, analytics ids and the custom code addresses with their hashes' })
  @ApiQuery({ name: 'sections', required: false, description: 'Only some parts, comma separated: site, contact, social, appLinks, branding, seo, footer, geo, aeo, aio, integrations, scripts' })
  config(@Query('sections') sections?: string) {
    const only = sections ? sections.split(',').map((s) => s.trim()).filter((s) => /^[a-zA-Z]{2,20}$/.test(s)) : undefined;
    return this.site.publicConfig(only);
  }

  @Get('head')
  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  @Header('Cache-Control', 'public, max-age=60, stale-while-revalidate=300')
  @ApiOperation({ summary: 'Everything for the <head> of one page: title, description, canonical, robots, meta tags, links, JSON-LD structured data, and the same as ready-made HTML' })
  head(@Query() q: HeadQueryDto) {
    if (!q.path.startsWith('/')) throw new BadRequestException('path must start with /');
    return this.site.head(q.path, q.lang);
  }

  @Get('faq')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Header('Cache-Control', 'public, max-age=60, stale-while-revalidate=300')
  @ApiOperation({ summary: 'The questions and answers (own entries and the customer FAQ of the content section)' })
  @ApiQuery({ name: 'lang', required: false })
  faq(@Query('lang') lang?: string) {
    return this.site.faqList(lang && /^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})*$/.test(lang) ? lang : undefined);
  }

  @Get('robots.txt')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @ApiOperation({ summary: 'robots.txt: crawler rules, AI crawler policies and the sitemap address (404 when switched off)' })
  async robots(@Res() res: any) {
    return this.text(res, await this.site.robotsTxt(), 'text/plain; charset=utf-8');
  }

  @Get('sitemap.xml')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'sitemap.xml: the home page, the kinds of store and every live store (404 when switched off)' })
  async sitemap(@Res() res: any) {
    return this.text(res, await this.site.sitemapXml(), 'application/xml; charset=utf-8');
  }

  @Get('llms.txt')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'llms.txt: a short Markdown summary of the site for AI assistants (404 when switched off)' })
  async llms(@Res() res: any) {
    return this.text(res, await this.site.llmsTxt(false), 'text/markdown; charset=utf-8');
  }

  @Get('llms-full.txt')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'llms-full.txt: the same with the full FAQ, terms and store descriptions' })
  async llmsFull(@Res() res: any) {
    return this.text(res, await this.site.llmsTxt(true), 'text/markdown; charset=utf-8');
  }

  @Get('manifest.webmanifest')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @ApiOperation({ summary: 'The web app manifest: name, colours and the icons of the branding section' })
  async manifest(@Res() res: any) {
    res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(JSON.stringify(await this.site.manifest()));
  }

  @Get('custom.css')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @ApiOperation({ summary: 'The custom CSS (empty 404 when switched off)' })
  async css(@Res() res: any) {
    return this.code(res, await this.site.code('customCss'), 'text/css; charset=utf-8');
  }

  @Get('head.js')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @ApiOperation({ summary: 'The custom JavaScript for <head> (404 when switched off)' })
  async headJs(@Res() res: any) {
    return this.code(res, await this.site.code('headJs'), 'application/javascript; charset=utf-8');
  }

  @Get('body.js')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @ApiOperation({ summary: 'The custom JavaScript for the end of <body> (404 when switched off)' })
  async bodyJs(@Res() res: any) {
    return this.code(res, await this.site.code('bodyJs'), 'application/javascript; charset=utf-8');
  }

  private text(res: any, body: string | null, type: string) {
    if (body === null) throw new NotFoundException('Switched off in the site settings');
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(body);
  }

  /** custom code can be loaded by the website from another address: it may be read by any origin (needed for integrity checks) */
  private code(res: any, body: string | null, type: string) {
    if (body === null) throw new NotFoundException('Switched off in the site settings');
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.send(body);
  }
}
