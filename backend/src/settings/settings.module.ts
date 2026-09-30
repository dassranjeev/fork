import { Body, Delete, Get, Global, Module, NotFoundException, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { InjectRepository, TypeOrmModule } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { IsArray, IsBoolean, IsInt, IsObject, IsOptional, IsString, Max, Min } from 'class-validator';
import { AppVersion, FeatureFlag, Incident, Setting } from '../database/entities';
import { SettingsService } from './settings.service';
import { AdminController, Permission, PublicController } from '../common/decorators';
import { Action, Module as Mod } from '../common/enums';
import { AuditService } from '../audit/audit.service';

class UpdateSettingsDto {
  /** { "key": value, ... } - secrets sent as '********' are ignored (unchanged) */
  @IsObject() values: Record<string, any>;
}

class FlagDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsInt() @Min(0) @Max(100) rolloutPct?: number;
  @IsOptional() @IsArray() cityIds?: string[];
  @IsOptional() @IsString() key?: string;
}

class AppVersionDto {
  @IsString() app: 'customer' | 'driver' | 'restaurant';
  @IsString() platform: 'ios' | 'android';
  @IsString() minVersion: string;
  @IsString() latestVersion: string;
  @IsOptional() @IsBoolean() forceUpdate?: boolean;
  @IsOptional() @IsString() storeUrl?: string;
  @IsOptional() @IsString() releaseNotes?: string;
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
    for (const [key, value] of Object.entries(dto.values)) {
      const row = await this.repo.findOne({ where: { key } });
      if (!row) continue;
      if (row.isSecret && (value === '********' || value === undefined)) continue;
      changed[key] = { before: row.isSecret ? '[secret]' : row.value, after: row.isSecret ? '[secret]' : value };
      row.value = value;
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
  async updateFlag(@Param('id') id: string, @Body() dto: FlagDto, @Req() req: any) {
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
  async deleteFlag(@Param('id') id: string, @Req() req: any) {
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
