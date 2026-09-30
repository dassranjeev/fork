import { Body, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { AdminController, CurrentUser, Permission } from '../common/decorators';
import { Action, Module } from '../common/enums';
import { AuthUser } from '../common/auth.types';
import { RestaurantStoreService } from './restaurant-store.service';
import { RestaurantAdminService } from './restaurant-admin.service';
import { MenuService } from './menu.service';
import {
  AgreementDto,
  ApproveDocDto,
  AdminUpdateRestaurantDto,
  BulkDto,
  ClosureDto,
  CommissionDto,
  CreateRestaurantDto,
  IntegrationDto,
  LocationDto,
  MemberDto,
  MenuReviewDto,
  MerchantDto,
  MerchantsQuery,
  ModerateReviewDto,
  OptionalReasonDto,
  ReasonDto,
  RejectDocDto,
  ReviewsQuery,
  StationDto,
  HoursDto,
  RestaurantsQuery,
  TestOrderDto,
  UpdateIntegrationDto,
  UpdateMemberDto,
  UpdateMerchantDto,
} from './dto';

/**
 * Admin surface for RestaurantsModule (ARCHITECTURE.md): merchants & restaurants CRUD, SOP-01 onboarding
 * pipeline, members, hours/closures, kitchen stations, tablet activation, POS integration config,
 * ratings/reviews moderation and per-restaurant performance stats.
 */
@AdminController('restaurants')
export class AdminRestaurantsController {
  constructor(
    private store: RestaurantStoreService,
    private admin: RestaurantAdminService,
    private menu: MenuService,
  ) {}

  // ------------------------------------------------------------------ merchants
  @Get('merchants')
  @Permission(Module.RESTAURANTS, Action.VIEW)
  listMerchants(@Query() q: MerchantsQuery) {
    return this.admin.listMerchants(q);
  }

  @Get('merchants/:id')
  @Permission(Module.RESTAURANTS, Action.VIEW)
  getMerchant(@Param('id') id: string) {
    return this.admin.getMerchant(id);
  }

  @Post('merchants')
  @Permission(Module.RESTAURANTS, Action.CREATE)
  createMerchant(@Body() dto: MerchantDto, @Req() req: any) {
    return this.admin.createMerchant(dto, req);
  }

  @Patch('merchants/:id')
  @Permission(Module.RESTAURANTS, Action.EDIT)
  updateMerchant(@Param('id') id: string, @Body() dto: UpdateMerchantDto, @Req() req: any) {
    return this.admin.updateMerchant(id, dto, req);
  }

  // ------------------------------------------------------------------ restaurants CRUD
  @Get()
  @Permission(Module.RESTAURANTS, Action.VIEW)
  list(@Query() q: RestaurantsQuery) {
    return this.admin.list(q);
  }

  @Post()
  @Permission(Module.RESTAURANTS, Action.CREATE)
  create(@Body() dto: CreateRestaurantDto, @CurrentUser() user: AuthUser, @Req() req: any) {
    return this.admin.create(dto, user, req);
  }

  @Get(':id')
  @Permission(Module.RESTAURANTS, Action.VIEW)
  detail(@Param('id') id: string) {
    return this.store.view(id);
  }

  @Patch(':id')
  @Permission(Module.RESTAURANTS, Action.EDIT)
  update(@Param('id') id: string, @Body() dto: AdminUpdateRestaurantDto, @Req() req: any) {
    return this.store.updateProfile(id, dto, req);
  }

  @Get(':id/stats')
  @Permission(Module.RESTAURANTS, Action.VIEW)
  stats(@Param('id') id: string, @Query('from') from?: string, @Query('to') to?: string, @Query('days') days?: string) {
    return this.store.stats(id, { from, to, days: days ? +days : undefined });
  }

  @Get(':id/menu')
  @Permission(Module.RESTAURANTS, Action.VIEW)
  menuTree(@Param('id') id: string) {
    return this.menu.tree(id, true);
  }

  // ------------------------------------------------------------------ onboarding: documents
  @Get(':id/documents')
  @Permission(Module.RESTAURANTS, Action.VIEW)
  documents(@Param('id') id: string) {
    return this.store.listDocuments(id);
  }

  @Get(':id/documents/checklist')
  @Permission(Module.RESTAURANTS, Action.VIEW)
  documentChecklist(@Param('id') id: string) {
    return this.store.documentChecklist(id);
  }

  @Post(':id/documents/:docId/approve')
  @Permission(Module.RESTAURANTS, Action.APPROVE)
  approveDocument(@Param('id') id: string, @Param('docId') docId: string, @Body() dto: ApproveDocDto, @Req() req: any) {
    return this.admin.approveDocument(id, docId, dto, req);
  }

  @Post(':id/documents/:docId/reject')
  @Permission(Module.RESTAURANTS, Action.APPROVE)
  rejectDocument(@Param('id') id: string, @Param('docId') docId: string, @Body() dto: RejectDocDto, @Req() req: any) {
    return this.admin.rejectDocument(id, docId, dto, req);
  }

  @Post(':id/docs-review/approve')
  @Permission(Module.RESTAURANTS, Action.APPROVE)
  docsApprove(@Param('id') id: string, @Req() req: any) {
    return this.admin.docsApprove(id, req);
  }

  // ------------------------------------------------------------------ onboarding: commission / location / agreement
  @Patch(':id/commission')
  @Permission(Module.RESTAURANTS, Action.EDIT)
  commission(@Param('id') id: string, @Body() dto: CommissionDto, @Req() req: any) {
    return this.admin.updateCommission(id, dto, req);
  }

  @Patch(':id/location')
  @Permission(Module.RESTAURANTS, Action.EDIT)
  location(@Param('id') id: string, @Body() dto: LocationDto, @Req() req: any) {
    return this.admin.updateLocation(id, dto, req);
  }

  @Post(':id/agreement')
  @Permission(Module.RESTAURANTS, Action.EDIT)
  agreement(@Param('id') id: string, @Body() dto: AgreementDto, @Req() req: any) {
    return this.admin.signAgreement(id, dto, req);
  }

  // ------------------------------------------------------------------ onboarding: menu review / test order / go-live / lifecycle
  @Post(':id/menu-review')
  @Permission(Module.RESTAURANTS, Action.APPROVE)
  menuReview(@Param('id') id: string, @Body() dto: MenuReviewDto, @Req() req: any) {
    return this.admin.menuReview(id, dto, req);
  }

  @Post(':id/test-order')
  @Permission(Module.RESTAURANTS, Action.EDIT)
  testOrder(@Param('id') id: string, @Body() dto: TestOrderDto, @Req() req: any) {
    return this.admin.testOrder(id, dto, req);
  }

  @Post(':id/go-live')
  @Permission(Module.RESTAURANTS, Action.APPROVE)
  goLive(@Param('id') id: string, @Body() dto: OptionalReasonDto, @Req() req: any) {
    return this.admin.goLive(id, dto, req);
  }

  @Post(':id/pause')
  @Permission(Module.RESTAURANTS, Action.EDIT)
  pause(@Param('id') id: string, @Body() dto: ReasonDto, @Req() req: any) {
    return this.admin.pause(id, dto, req);
  }

  @Post(':id/suspend')
  @Permission(Module.RESTAURANTS, Action.EDIT)
  suspend(@Param('id') id: string, @Body() dto: ReasonDto, @Req() req: any) {
    return this.admin.suspend(id, dto, req);
  }

  @Post(':id/reactivate')
  @Permission(Module.RESTAURANTS, Action.EDIT)
  reactivate(@Param('id') id: string, @Body() dto: OptionalReasonDto, @Req() req: any) {
    return this.admin.reactivate(id, dto, req);
  }

  @Post(':id/reject')
  @Permission(Module.RESTAURANTS, Action.APPROVE)
  reject(@Param('id') id: string, @Body() dto: ReasonDto, @Req() req: any) {
    return this.admin.reject(id, dto, req);
  }

  @Post('bulk')
  @Permission(Module.RESTAURANTS, Action.EDIT)
  bulk(@Body() dto: BulkDto, @Req() req: any) {
    return this.admin.bulk(dto, req);
  }

  // ------------------------------------------------------------------ members
  @Get(':id/members')
  @Permission(Module.RESTAURANTS, Action.VIEW)
  async members(@Param('id') id: string) {
    const r = await this.store.get(id);
    return this.store.listMembers(r.merchantId, id);
  }

  @Post(':id/members')
  @Permission(Module.RESTAURANTS, Action.CREATE)
  async addMember(@Param('id') id: string, @Body() dto: MemberDto, @CurrentUser() user: AuthUser, @Req() req: any) {
    const r = await this.store.get(id);
    return this.store.createMember(r.merchantId, dto, id, user, undefined, req);
  }

  @Patch(':id/members/:memberId')
  @Permission(Module.RESTAURANTS, Action.EDIT)
  async updateMember(@Param('id') id: string, @Param('memberId') memberId: string, @Body() dto: UpdateMemberDto, @CurrentUser() user: AuthUser, @Req() req: any) {
    const r = await this.store.get(id);
    return this.store.updateMember(r.merchantId, memberId, dto, user, undefined, req);
  }

  @Delete(':id/members/:memberId')
  @Permission(Module.RESTAURANTS, Action.EDIT)
  async removeMember(@Param('id') id: string, @Param('memberId') memberId: string, @CurrentUser() user: AuthUser, @Req() req: any) {
    const r = await this.store.get(id);
    return this.store.removeMember(r.merchantId, memberId, user, undefined, req);
  }

  @Post(':id/members/:memberId/reset-password')
  @Permission(Module.RESTAURANTS, Action.EDIT)
  async resetMemberPassword(@Param('id') id: string, @Param('memberId') memberId: string, @CurrentUser() user: AuthUser, @Req() req: any) {
    const r = await this.store.get(id);
    return this.store.resetMemberPassword(r.merchantId, memberId, user, undefined, req);
  }

  // ------------------------------------------------------------------ hours / closures / stations
  @Get(':id/hours')
  @Permission(Module.RESTAURANTS, Action.VIEW)
  hours(@Param('id') id: string) {
    return this.store.listHours(id);
  }

  @Patch(':id/hours')
  @Permission(Module.RESTAURANTS, Action.EDIT)
  setHours(@Param('id') id: string, @Body() dto: HoursDto, @Req() req: any) {
    return this.store.setHours(id, dto, req);
  }

  @Get(':id/closures')
  @Permission(Module.RESTAURANTS, Action.VIEW)
  closures(@Param('id') id: string) {
    return this.store.listClosures(id);
  }

  @Post(':id/closures')
  @Permission(Module.RESTAURANTS, Action.EDIT)
  addClosure(@Param('id') id: string, @Body() dto: ClosureDto, @Req() req: any) {
    return this.store.addClosure(id, dto, req);
  }

  @Delete(':id/closures/:closureId')
  @Permission(Module.RESTAURANTS, Action.EDIT)
  removeClosure(@Param('id') id: string, @Param('closureId') closureId: string, @Req() req: any) {
    return this.store.removeClosure(id, closureId, req);
  }

  @Get(':id/stations')
  @Permission(Module.RESTAURANTS, Action.VIEW)
  stations(@Param('id') id: string) {
    return this.store.listStations(id);
  }

  @Post(':id/stations')
  @Permission(Module.RESTAURANTS, Action.EDIT)
  addStation(@Param('id') id: string, @Body() dto: StationDto) {
    return this.store.addStation(id, dto);
  }

  @Patch(':id/stations/:stationId')
  @Permission(Module.RESTAURANTS, Action.EDIT)
  updateStation(@Param('id') id: string, @Param('stationId') stationId: string, @Body() dto: Partial<StationDto>) {
    return this.store.updateStation(id, stationId, dto);
  }

  @Delete(':id/stations/:stationId')
  @Permission(Module.RESTAURANTS, Action.EDIT)
  removeStation(@Param('id') id: string, @Param('stationId') stationId: string) {
    return this.store.removeStation(id, stationId);
  }

  // ------------------------------------------------------------------ tablet
  @Post(':id/tablet/issue-code')
  @Permission(Module.RESTAURANTS, Action.EDIT)
  issueTabletCode(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.store.issueTabletCode(id, user);
  }

  // ------------------------------------------------------------------ POS integrations
  @Get(':id/integrations')
  @Permission(Module.RESTAURANTS, Action.VIEW)
  integrations(@Param('id') id: string) {
    return this.store.listIntegrations(id);
  }

  @Post(':id/integrations')
  @Permission(Module.RESTAURANTS, Action.EDIT)
  addIntegration(@Param('id') id: string, @Body() dto: IntegrationDto) {
    return this.store.addIntegration(id, dto);
  }

  @Patch(':id/integrations/:integrationId')
  @Permission(Module.RESTAURANTS, Action.EDIT)
  updateIntegration(@Param('id') id: string, @Param('integrationId') integrationId: string, @Body() dto: UpdateIntegrationDto) {
    return this.store.updateIntegration(id, integrationId, dto);
  }

  @Delete(':id/integrations/:integrationId')
  @Permission(Module.RESTAURANTS, Action.EDIT)
  removeIntegration(@Param('id') id: string, @Param('integrationId') integrationId: string) {
    return this.store.removeIntegration(id, integrationId);
  }

  // ------------------------------------------------------------------ reviews moderation
  @Get('reviews')
  @Permission(Module.RESTAURANTS, Action.VIEW)
  reviews(@Query() q: ReviewsQuery) {
    return this.store.listReviews(null, q);
  }

  @Post('reviews/:reviewId/moderate')
  @Permission(Module.RESTAURANTS, Action.APPROVE)
  moderateReview(@Param('reviewId') reviewId: string, @Body() dto: ModerateReviewDto, @Req() req: any) {
    return this.store.moderate(reviewId, dto.status, dto.reason, req);
  }
}
