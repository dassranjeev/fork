import { Body, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { AdminController, CurrentUser, Permission } from '../common/decorators';
import { Action, Module } from '../common/enums';
import { AuthUser } from '../common/auth.types';
import { AuditService } from '../audit/audit.service';
import { DriversAdminService } from './drivers-admin.service';
import { DriverOpsService } from './driver-ops.service';
import {
  ActivateDto,
  AnalyticsQuery,
  ApproveDto,
  BackgroundOverrideDto,
  CreateDriverDto,
  DriverListQuery,
  ExpiringDocsQuery,
  IncentiveDto,
  IncentiveListQuery,
  InsuranceDto,
  ReasonDto,
  ReviewDocumentDto,
  ShiftListQuery,
  ShiftSlotDto,
  SosActionDto,
  SosListQuery,
  SupplyAlertDto,
  TrainingModuleDto,
  UpdateDriverDto,
  UpdateIncentiveDto,
  UpdateSlotDto,
  UpdateTrainingModuleDto,
  ZonesDto,
} from './drivers.dto';

/**
 * Admin drivers desk: application pipeline (SOP-02), CRUD, incentives/boosts, shifts, training
 * authoring, SOS handling, document-expiry queue, supply alerts and the ops heat-map (spec §5 / ARCHITECTURE.md).
 * Static single-segment GET routes (summary/export/analytics/...) are declared before `:id` so Nest's
 * first-match routing does not swallow them as a driver id.
 */
@AdminController('drivers')
export class AdminDriversController {
  constructor(
    private drivers: DriversAdminService,
    private ops: DriverOpsService,
    private audit: AuditService,
  ) {}

  // ------------------------------------------------------------------ list / static views
  @Get()
  @Permission(Module.DRIVERS, Action.VIEW)
  list(@Query() q: DriverListQuery) {
    return this.drivers.list(q);
  }

  @Get('summary')
  @Permission(Module.DRIVERS, Action.VIEW)
  summary(@Query('cityId') cityId?: string) {
    return this.drivers.summary(cityId);
  }

  @Get('export')
  @Permission(Module.DRIVERS, Action.EXPORT)
  async exportCsv(@Query() q: DriverListQuery) {
    return { csv: await this.drivers.exportCsv(q) };
  }

  @Get('expiring-documents')
  @Permission(Module.DRIVERS, Action.VIEW)
  expiringDocuments(@Query() q: ExpiringDocsQuery) {
    return this.ops.expiringDocuments(q);
  }

  @Get('analytics')
  @Permission(Module.DRIVERS, Action.VIEW)
  analytics(@Query() q: AnalyticsQuery) {
    return this.ops.analytics(q);
  }

  @Get('heat-map')
  @Permission(Module.DRIVERS, Action.VIEW)
  heatMap(@Query('cityId') cityId?: string) {
    return this.ops.heatMap(cityId);
  }

  // ------------------------------------------------------------------ incentives / boosts
  @Get('incentives')
  @Permission(Module.DRIVERS, Action.VIEW)
  listIncentives(@Query() q: IncentiveListQuery) {
    return this.ops.listIncentives(q);
  }

  @Post('incentives')
  @Permission(Module.DRIVERS, Action.CREATE)
  async createIncentive(@Body() dto: IncentiveDto, @CurrentUser() user: AuthUser) {
    const incentive = await this.ops.createIncentive(dto);
    await this.audit.log({ actor: user, action: 'driver.incentive.create', entity: 'Incentive', entityId: incentive.id, after: dto });
    return incentive;
  }

  @Patch('incentives/:id')
  @Permission(Module.DRIVERS, Action.EDIT)
  async updateIncentive(@Param('id') id: string, @Body() dto: UpdateIncentiveDto, @CurrentUser() user: AuthUser) {
    const incentive = await this.ops.updateIncentive(id, dto);
    await this.audit.log({ actor: user, action: 'driver.incentive.update', entity: 'Incentive', entityId: id, after: dto });
    return incentive;
  }

  @Delete('incentives/:id')
  @Permission(Module.DRIVERS, Action.DELETE)
  async deleteIncentive(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    const res = await this.ops.deleteIncentive(id);
    await this.audit.log({ actor: user, action: 'driver.incentive.delete', entity: 'Incentive', entityId: id });
    return res;
  }

  @Post('supply-alert')
  @Permission(Module.DRIVERS, Action.CREATE)
  async supplyAlert(@Body() dto: SupplyAlertDto, @CurrentUser() user: AuthUser) {
    const incentive = await this.ops.supplyAlert(dto, user);
    await this.audit.log({ actor: user, action: 'driver.supply_alert', entity: 'Incentive', entityId: incentive.id, after: dto });
    return incentive;
  }

  // ------------------------------------------------------------------ shifts
  @Get('shifts/slots')
  @Permission(Module.DRIVERS, Action.VIEW)
  listShiftSlots(@Query() q: ShiftListQuery) {
    return this.ops.listShiftSlots(q);
  }

  @Post('shifts/slots')
  @Permission(Module.DRIVERS, Action.CREATE)
  createShiftSlot(@Body() dto: ShiftSlotDto) {
    return this.ops.createShiftSlot(dto);
  }

  @Patch('shifts/slots/:id')
  @Permission(Module.DRIVERS, Action.EDIT)
  updateShiftSlot(@Param('id') id: string, @Body() dto: UpdateSlotDto) {
    return this.ops.updateShiftSlot(id, dto);
  }

  @Delete('shifts/slots/:id')
  @Permission(Module.DRIVERS, Action.DELETE)
  cancelShiftSlot(@Param('id') id: string) {
    return this.ops.cancelShiftSlot(id);
  }

  @Get('shifts')
  @Permission(Module.DRIVERS, Action.VIEW)
  listShifts(@Query() q: ShiftListQuery) {
    return this.ops.listShifts(q);
  }

  // ------------------------------------------------------------------ training modules
  @Get('training-modules')
  @Permission(Module.DRIVERS, Action.VIEW)
  listModules() {
    return this.ops.listModules();
  }

  @Post('training-modules')
  @Permission(Module.DRIVERS, Action.CREATE)
  createModule(@Body() dto: TrainingModuleDto) {
    return this.ops.createModule(dto);
  }

  @Patch('training-modules/:id')
  @Permission(Module.DRIVERS, Action.EDIT)
  updateModule(@Param('id') id: string, @Body() dto: UpdateTrainingModuleDto) {
    return this.ops.updateModule(id, dto);
  }

  @Delete('training-modules/:id')
  @Permission(Module.DRIVERS, Action.DELETE)
  deleteModule(@Param('id') id: string) {
    return this.ops.deleteModule(id);
  }

  // ------------------------------------------------------------------ SOS
  @Get('sos')
  @Permission(Module.DRIVERS, Action.VIEW)
  listSos(@Query() q: SosListQuery) {
    return this.ops.listSos(q);
  }

  @Post('sos/:id/acknowledge')
  @Permission(Module.DRIVERS, Action.EDIT)
  async acknowledgeSos(@Param('id') id: string, @Body() dto: SosActionDto, @CurrentUser() user: AuthUser) {
    const alert = await this.ops.acknowledgeSos(id, user, dto.note);
    await this.audit.log({ actor: user, action: 'driver.sos.acknowledge', entity: 'SosAlert', entityId: id });
    return alert;
  }

  @Post('sos/:id/resolve')
  @Permission(Module.DRIVERS, Action.EDIT)
  async resolveSos(@Param('id') id: string, @Body() dto: SosActionDto, @CurrentUser() user: AuthUser) {
    const alert = await this.ops.resolveSos(id, user, dto.note);
    await this.audit.log({ actor: user, action: 'driver.sos.resolve', entity: 'SosAlert', entityId: id });
    return alert;
  }

  // ------------------------------------------------------------------ driver detail / CRUD (":id" - keep below the static routes above)
  @Get(':id')
  @Permission(Module.DRIVERS, Action.VIEW)
  detail(@Param('id') id: string) {
    return this.drivers.detail(id);
  }

  @Post()
  @Permission(Module.DRIVERS, Action.CREATE)
  async create(@Body() dto: CreateDriverDto, @CurrentUser() user: AuthUser) {
    const res = await this.drivers.create(dto, user);
    await this.audit.log({ actor: user, action: 'driver.create', entity: 'DriverProfile', entityId: res.id, after: { email: dto.email } });
    return res;
  }

  @Patch(':id')
  @Permission(Module.DRIVERS, Action.EDIT)
  async update(@Param('id') id: string, @Body() dto: UpdateDriverDto, @CurrentUser() user: AuthUser) {
    const { before, after } = await this.drivers.update(id, dto);
    await this.audit.log({ actor: user, action: 'driver.update', entity: 'DriverProfile', entityId: id, before, after });
    return after;
  }

  @Delete(':id')
  @Permission(Module.DRIVERS, Action.DELETE)
  async remove(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    const res = await this.drivers.remove(id);
    await this.audit.log({ actor: user, action: 'driver.delete', entity: 'DriverProfile', entityId: id });
    return res;
  }

  // ------------------------------------------------------------------ SOP-02 pipeline
  @Post(':id/start-review')
  @Permission(Module.DRIVERS, Action.EDIT)
  async startReview(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    const res = await this.drivers.startReview(id, user);
    await this.audit.log({ actor: user, action: 'driver.start_review', entity: 'DriverProfile', entityId: id });
    return res;
  }

  @Patch(':id/documents/:docId')
  @Permission(Module.DRIVERS, Action.APPROVE)
  async reviewDocument(@Param('id') id: string, @Param('docId') docId: string, @Body() dto: ReviewDocumentDto, @CurrentUser() user: AuthUser) {
    const { before, after } = await this.drivers.reviewDocument(id, docId, dto, user);
    await this.audit.log({ actor: user, action: 'driver.document.review', entity: 'DriverDocument', entityId: docId, before, after: { status: after.status } });
    return after;
  }

  @Put(':id/insurance')
  @Permission(Module.DRIVERS, Action.EDIT)
  async setInsurance(@Param('id') id: string, @Body() dto: InsuranceDto, @CurrentUser() user: AuthUser) {
    const res = await this.drivers.setInsurance(id, dto);
    await this.audit.log({ actor: user, action: 'driver.insurance.set', entity: 'DriverProfile', entityId: id, after: dto });
    return res;
  }

  @Post(':id/background-check/start')
  @Permission(Module.DRIVERS, Action.EDIT)
  async startBackgroundCheck(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    const res = await this.drivers.startBackgroundCheck(id, user);
    await this.audit.log({ actor: user, action: 'driver.background_check.start', entity: 'DriverProfile', entityId: id, after: res });
    return res;
  }

  @Post(':id/background-check/override')
  @Permission(Module.DRIVERS, Action.APPROVE)
  async overrideBackground(@Param('id') id: string, @Body() dto: BackgroundOverrideDto, @CurrentUser() user: AuthUser) {
    const res = await this.drivers.overrideBackground(id, dto, user);
    await this.audit.log({ actor: user, action: 'driver.background_check.override', entity: 'DriverProfile', entityId: id, after: dto });
    return res;
  }

  @Post(':id/approve')
  @Permission(Module.DRIVERS, Action.APPROVE)
  async approve(@Param('id') id: string, @Body() dto: ApproveDto, @CurrentUser() user: AuthUser) {
    const res = await this.drivers.approve(id, dto, user);
    await this.audit.log({ actor: user, action: 'driver.approve', entity: 'DriverProfile', entityId: id, after: dto });
    return res;
  }

  @Post(':id/activate')
  @Permission(Module.DRIVERS, Action.APPROVE)
  async activate(@Param('id') id: string, @Body() dto: ActivateDto, @CurrentUser() user: AuthUser) {
    const res = await this.drivers.activate(id, dto, user);
    await this.audit.log({ actor: user, action: 'driver.activate', entity: 'DriverProfile', entityId: id, after: dto });
    return res;
  }

  @Post(':id/reject')
  @Permission(Module.DRIVERS, Action.APPROVE)
  async reject(@Param('id') id: string, @Body() dto: ReasonDto, @CurrentUser() user: AuthUser) {
    const res = await this.drivers.reject(id, dto, user);
    await this.audit.log({ actor: user, action: 'driver.reject', entity: 'DriverProfile', entityId: id, after: { reason: dto.reason } });
    return res;
  }

  // ------------------------------------------------------------------ SOP-08 status
  @Post(':id/suspend')
  @Permission(Module.DRIVERS, Action.APPROVE)
  async suspend(@Param('id') id: string, @Body() dto: ReasonDto, @CurrentUser() user: AuthUser) {
    const res = await this.drivers.suspend(id, dto, user);
    await this.audit.log({ actor: user, action: 'driver.suspend', entity: 'DriverProfile', entityId: id, after: { reason: dto.reason } });
    return res;
  }

  @Post(':id/deactivate')
  @Permission(Module.DRIVERS, Action.APPROVE)
  async deactivate(@Param('id') id: string, @Body() dto: ReasonDto, @CurrentUser() user: AuthUser) {
    const res = await this.drivers.deactivate(id, dto, user);
    await this.audit.log({ actor: user, action: 'driver.deactivate', entity: 'DriverProfile', entityId: id, after: { reason: dto.reason } });
    return res;
  }

  @Post(':id/reinstate')
  @Permission(Module.DRIVERS, Action.APPROVE)
  async reinstate(@Param('id') id: string, @Body('reason') reason: string | undefined, @CurrentUser() user: AuthUser) {
    const res = await this.drivers.reinstate(id, reason, user);
    await this.audit.log({ actor: user, action: 'driver.reinstate', entity: 'DriverProfile', entityId: id, after: { reason } });
    return res;
  }

  @Put(':id/zones')
  @Permission(Module.DRIVERS, Action.EDIT)
  async setZones(@Param('id') id: string, @Body() dto: ZonesDto, @CurrentUser() user: AuthUser) {
    const res = await this.drivers.setZones(id, dto.zoneIds);
    await this.audit.log({ actor: user, action: 'driver.zones.set', entity: 'DriverProfile', entityId: id, before: { zoneIds: res.before }, after: { zoneIds: res.after } });
    return res;
  }
}
