import { BadRequestException, Body, Delete, ForbiddenException, Get, Global, Module, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { InjectRepository, TypeOrmModule } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';
import { AppVersion, FeatureFlag, Incident, Setting } from '../database/entities';
import { SettingsService, sealSecret } from './settings.service';
import { AdminController, Permission, PublicController } from '../common/decorators';
import { Action, Module as Mod } from '../common/enums';
import { AuditService } from '../audit/audit.service';

class UpdateSettingsDto {
  /** { "key": value, ... } - secrets sent as '********' are ignored (unchanged) */
  @IsObject() values: Record<string, any>;
}

class FlagDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsInt() @Min(0) @Max(100) rolloutPct?: number;
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsUUID('all', { each: true }) cityIds?: string[];
  @IsOptional() @IsString() @MaxLength(100) @Matches(/^[a-z0-9_.-]+$/i) key?: string;
}

class AppVersionDto {
  @IsIn(['customer', 'driver', 'restaurant']) app: 'customer' | 'driver' | 'restaurant';
  @IsIn(['ios', 'android']) platform: 'ios' | 'android';
  @IsString() @MaxLength(20) @Matches(/^\d+(\.\d+){0,3}$/) minVersion: string;
  @IsString() @MaxLength(20) @Matches(/^\d+(\.\d+){0,3}$/) latestVersion: string;
  @IsOptional() @IsBoolean() forceUpdate?: boolean;
  @IsOptional() @IsString() @MaxLength(2048) storeUrl?: string;
  @IsOptional() @IsString() @MaxLength(2000) releaseNotes?: string;
}

/** Settings that change the security posture or move money: only a Super Admin may write them (a staff role with settings:edit may not). */
const PRIVILEGED_KEY = /^(security\.|payments\.|integrations\.|customers\.walletAdjustApprovalThreshold|support\..*[Ll]imit|finance\.|payouts\.)/;

/** The new value must have the same JSON type as the current one (a threshold cannot become the string "unlimited"). */
function sameKind(oldV: any, newV: any): boolean {
  if (oldV === null || oldV === undefined || oldV === '') return typeof newV === 'string' || typeof newV === 'number' || typeof newV === 'boolean' || newV === null || typeof newV === 'object';
  if (typeof oldV === 'number') return typeof newV === 'number' && Number.isFinite(newV) && Math.abs(newV) < 1e9;
  if (typeof oldV === 'boolean') return typeof newV === 'boolean';
  if (typeof oldV === 'string') return typeof newV === 'string' && newV.length <= 5000;
  if (Array.isArray(oldV)) return Array.isArray(newV) && newV.length <= 1000;
  return typeof newV === 'object' && newV !== null && !Array.isArray(newV);
}

@AdminController('settings')
class SettingsController {
  constructor(
    private svc: SettingsService,
    private audit: AuditService,
    @InjectRepository(Setting) private repo: Repository<Setting>,
    @InjectRepository(FeatureFlag) private flags: Repository<FeatureFlag>,
    @InjectRepository(AppVersion) private versions: Repository<AppVersion>,
  ) {}

  @Get()
  @Permission(Mod.SETTINGS, Action.VIEW)
  async list(@Query('group') group?: string) {
    const rows = await this.svc.list(group);
    const groups = [...new Set(rows.map((r) => r.group))];
    return { groups, data: rows };
  }

  @Put()
  @Permission(Mod.SETTINGS, Action.EDIT)
  async update(@Body() dto: UpdateSettingsDto, @Req() req: any) {
    const changed: Record<string, { before: any; after: any }> = {};
    const isSuper = req.user?.type === 'SUPER_ADMIN';
    for (const [key, value] of Object.entries(dto.values)) {
      const row = await this.repo.findOne({ where: { key } });
      if (!row) continue;
      if (row.group === 'integrations') throw new BadRequestException('Integration keys are edited on System > Integrations');
      if (row.isSecret && (value === '********' || value === undefined)) continue;
      if (!isSuper && (row.isSecret || PRIVILEGED_KEY.test(key))) {
        await this.audit.logReq(req, 'security.settings_denied', 'settings', undefined, undefined, { key });
        throw new ForbiddenException(`Only a Super Admin can change "${key}"`);
      }
      if (!sameKind(row.value, value)) throw new BadRequestException(`Invalid value for "${key}" (expected the same type as the current value)`);
      changed[key] = { before: row.isSecret ? '[secret]' : row.value, after: row.isSecret ? '[secret]' : value };
      row.value = row.isSecret ? sealSecret(value) : value;
      await this.repo.save(row);
    }
    await this.svc.reload();
    await this.audit.logReq(req, 'settings.update', 'settings', undefined, undefined, changed);
    return { updated: Object.keys(changed) };
  }

  // ---- feature flags ----
  @Get('feature-flags')
  @Permission(Mod.SETTINGS, Action.VIEW)
  async listFlags() {
    return { data: await this.flags.find({ order: { key: 'ASC' } }) };
  }

  @Post('feature-flags')
  @Permission(Mod.SETTINGS, Action.CREATE)
  async createFlag(@Body() dto: FlagDto, @Req() req: any) {
    const f = await this.flags.save(this.flags.create({ ...dto, enabled: dto.enabled ?? false }));
    await this.audit.logReq(req, 'feature_flag.create', 'feature_flag', f.id, undefined, f);
    return f;
  }

  @Patch('feature-flags/:id')
  @Permission(Mod.SETTINGS, Action.EDIT)
  async updateFlag(@Param('id', ParseUUIDPipe) id: string, @Body() dto: FlagDto, @Req() req: any) {
    const f = await this.flags.findOne({ where: { id } });
    if (!f) throw new NotFoundException();
    const before = { ...f };
    Object.assign(f, dto);
    await this.flags.save(f);
    await this.audit.logReq(req, 'feature_flag.update', 'feature_flag', id, before, f);
    return f;
  }

  @Delete('feature-flags/:id')
  @Permission(Mod.SETTINGS, Action.DELETE)
  async deleteFlag(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    await this.flags.delete(id);
    await this.audit.logReq(req, 'feature_flag.delete', 'feature_flag', id);
    return { ok: true };
  }

  // ---- app versions (force update) ----
  @Get('app-versions')
  @Permission(Mod.SETTINGS, Action.VIEW)
  async listVersions() {
    return { data: await this.versions.find({ order: { app: 'ASC', platform: 'ASC' } }) };
  }

  @Put('app-versions')
  @Permission(Mod.SETTINGS, Action.EDIT)
  async upsertVersion(@Body() dto: AppVersionDto, @Req() req: any) {
    let v = await this.versions.findOne({ where: { app: dto.app, platform: dto.platform } });
    const before = v ? { ...v } : undefined;
    if (!v) v = this.versions.create({ app: dto.app, platform: dto.platform });
    Object.assign(v, dto);
    await this.versions.save(v);
    await this.audit.logReq(req, 'app_version.upsert', 'app_version', v.id, before, v);
    return v;
  }
}

/** Mobile apps call this on launch: settings, feature flags, min-version check, maintenance & banner. */
@PublicController('config')
class PublicConfigController {
  constructor(
    private svc: SettingsService,
    @InjectRepository(AppVersion) private versions: Repository<AppVersion>,
    @InjectRepository(Incident) private incidents: Repository<Incident>,
  ) {}

  @Get()
  async config(@Query('app') app?: string, @Query('platform') platform?: string, @Query('version') version?: string) {
    const cfg = await this.svc.publicConfig();
    let update: any = null;
    if (app && platform) {
      const v = await this.versions.findOne({ where: { app: app as any, platform: platform as any } });
      if (v) {
        const outdated = version ? cmpVersion(version, v.minVersion) < 0 : false;
        update = {
          minVersion: v.minVersion,
          latestVersion: v.latestVersion,
          storeUrl: v.storeUrl,
          releaseNotes: v.releaseNotes,
          forceUpdate: v.forceUpdate || outdated,
          updateAvailable: version ? cmpVersion(version, v.latestVersion) < 0 : false,
        };
      }
    }
    const banner = await this.incidents.findOne({ where: { bannerActive: true }, order: { createdAt: 'DESC' } });
    return {
      ...cfg,
      update,
      maintenance: {
        enabled: !!cfg.settings['general.maintenanceMode'],
        message: cfg.settings['general.maintenanceMessage'],
      },
      statusBanner: banner?.bannerMessage || cfg.settings['general.statusBanner'] || null,
      serverTime: new Date().toISOString(),
    };
  }
}

export function cmpVersion(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([Setting, FeatureFlag, AppVersion, Incident])],
  providers: [SettingsService],
  controllers: [SettingsController, PublicConfigController],
  exports: [SettingsService],
})
export class SettingsModule {}
