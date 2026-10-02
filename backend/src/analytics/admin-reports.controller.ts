import { Body, Get, Param, Patch, Post, Delete, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AdminController, CurrentUser, Permission } from '../common/decorators';
import { Action, Module } from '../common/enums';
import { AuthUser } from '../common/auth.types';
import { PageQueryDto } from '../common/pagination';
import { AuditService } from '../audit/audit.service';
import { AnalyticsFilterDto, ScheduledReportDto, UpdateScheduledReportDto } from './analytics.dto';
import { ExportService } from './export.service';
import { ScheduledReportsService } from './scheduled-reports.service';

/** Generic CSV/XLSX export + scheduled email reports CRUD (spec §12). */
@AdminController('reports')
export class AdminReportsController {
  constructor(
    private readonly exportSvc: ExportService,
    private readonly scheduled: ScheduledReportsService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------- scheduled reports CRUD
  @Get('scheduled')
  @Permission(Module.REPORTS, Action.VIEW)
  listScheduled(@Query() q: PageQueryDto) {
    return this.scheduled.list(q);
  }

  @Get('scheduled/:id')
  @Permission(Module.REPORTS, Action.VIEW)
  getScheduled(@Param('id') id: string) {
    return this.scheduled.get(id);
  }

  @Post('scheduled')
  @Permission(Module.REPORTS, Action.CREATE)
  createScheduled(@Body() dto: ScheduledReportDto, @CurrentUser() user: AuthUser) {
    return this.scheduled.create(dto, user);
  }

  @Patch('scheduled/:id')
  @Permission(Module.REPORTS, Action.EDIT)
  updateScheduled(@Param('id') id: string, @Body() dto: UpdateScheduledReportDto, @CurrentUser() user: AuthUser) {
    return this.scheduled.update(id, dto, user);
  }

  @Delete('scheduled/:id')
  @Permission(Module.REPORTS, Action.DELETE)
  removeScheduled(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.scheduled.remove(id, user);
  }

  @Post('scheduled/:id/run')
  @Permission(Module.REPORTS, Action.EXPORT)
  runScheduled(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.scheduled.runNow(id, user);
  }

  // ---------------------------------------------------------------- generic export
  /**
   * GET /admin/reports/:dashboard/export?format=csv|xlsx
   * dashboard in dashboard|live_ops|executive|restaurant_performance|driver_performance|customer_growth|finance|support|pilot_exit_kpis
   * Returns { filename, format, contentType, csv } for csv or { filename, format, contentType, base64 } for xlsx
   * (base64-encoded workbook - matches this codebase's existing export convention, see admin-orders.controller.ts).
   */
  @Get(':dashboard/export')
  @Throttle({ default: { limit: 10, ttl: 60_000 } }) // exports are heavy: 10 per minute per user
  @Permission(Module.REPORTS, Action.EXPORT)
  async export(@Param('dashboard') dashboard: string, @Query() f: AnalyticsFilterDto, @CurrentUser() user: AuthUser) {
    const result = await this.exportSvc.build(dashboard, f.format, f, user);
    await this.audit.log({ actor: user, action: 'analytics.export', entity: 'Report', entityId: dashboard, after: { format: result.format, filename: result.filename, from: f.from, to: f.to } });
    return result;
  }
}
