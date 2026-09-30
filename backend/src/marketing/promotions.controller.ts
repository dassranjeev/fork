import { Body, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { AdminController, CurrentUser, Permission, PublicController, RestaurantController, RestaurantRoles } from '../common/decorators';
import { AuthUser } from '../common/auth.types';
import { Action, Module, RestaurantRole } from '../common/enums';
import { AuditService } from '../audit/audit.service';
import { PromotionsAdminService } from './promotions.admin';
import { PromotionsService } from './promotions.service';
import {
  BatchPromotionDto,
  PromotionDto,
  PromotionQuery,
  RedemptionQuery,
  RejectDto,
  RestaurantPromotionDto,
  RestaurantPromotionQuery,
  UpdatePromotionDto,
} from './promotions.dto';

@AdminController('promotions')
export class PromotionsAdminController {
  constructor(private admin: PromotionsAdminService, private promos: PromotionsService, private audit: AuditService) {}

  @Get()
  @Permission(Module.PROMOTIONS, Action.VIEW)
  list(@Query() q: PromotionQuery) {
    return this.admin.list(q);
  }

  @Get('overview')
  @Permission(Module.PROMOTIONS, Action.VIEW)
  overview() {
    return this.promos.overview();
  }

  @Get('approvals')
  @Permission(Module.PROMOTIONS, Action.VIEW)
  approvals(@Query() q: PromotionQuery) {
    return this.admin.approvals(q);
  }

  @Get('redemptions')
  @Permission(Module.PROMOTIONS, Action.VIEW)
  redemptions(@Query() q: RedemptionQuery) {
    return this.promos.listRedemptions(q.promotionId, q.page, q.limit);
  }

  @Post('batch')
  @Permission(Module.PROMOTIONS, Action.CREATE)
  async batch(@Body() dto: BatchPromotionDto, @CurrentUser() u: AuthUser, @Req() req: any) {
    const res = await this.admin.createBatch(dto, u);
    await this.audit.logReq(req, 'promotion.batch_create', 'promotion', res.batchId, null, { count: res.count });
    return res;
  }

  @Post()
  @Permission(Module.PROMOTIONS, Action.CREATE)
  async create(@Body() dto: PromotionDto, @CurrentUser() u: AuthUser, @Req() req: any) {
    const p = await this.admin.create(dto, u);
    await this.audit.logReq(req, 'promotion.create', 'promotion', p.id, null, p);
    return p;
  }

  @Get(':id')
  @Permission(Module.PROMOTIONS, Action.VIEW)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.admin.get(id);
  }

  @Patch(':id')
  @Permission(Module.PROMOTIONS, Action.EDIT)
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePromotionDto, @Req() req: any) {
    const { before, after } = await this.admin.update(id, dto);
    await this.audit.logReq(req, 'promotion.update', 'promotion', id, before, after);
    return after;
  }

  @Delete(':id')
  @Permission(Module.PROMOTIONS, Action.DELETE)
  async remove(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    const res = await this.admin.remove(id);
    await this.audit.logReq(req, res.deleted ? 'promotion.delete' : 'promotion.deactivate', 'promotion', id, res.promotion, null);
    return { deleted: res.deleted, deactivated: res.deactivated };
  }

  @Post(':id/duplicate')
  @Permission(Module.PROMOTIONS, Action.CREATE)
  async duplicate(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Req() req: any) {
    const p = await this.admin.duplicate(id, u);
    await this.audit.logReq(req, 'promotion.duplicate', 'promotion', p.id, { from: id }, p);
    return p;
  }

  @Post(':id/activate')
  @Permission(Module.PROMOTIONS, Action.EDIT)
  async activate(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    const { before, after } = await this.admin.setActive(id, true);
    await this.audit.logReq(req, 'promotion.activate', 'promotion', id, { active: before.active }, { active: true });
    return after;
  }

  @Post(':id/deactivate')
  @Permission(Module.PROMOTIONS, Action.EDIT)
  async deactivate(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    const { before, after } = await this.admin.setActive(id, false);
    await this.audit.logReq(req, 'promotion.deactivate', 'promotion', id, { active: before.active }, { active: false });
    return after;
  }

  @Get(':id/stats')
  @Permission(Module.PROMOTIONS, Action.VIEW)
  stats(@Param('id', ParseUUIDPipe) id: string) {
    return this.promos.stats(id);
  }

  @Get(':id/redemptions')
  @Permission(Module.PROMOTIONS, Action.VIEW)
  promoRedemptions(@Param('id', ParseUUIDPipe) id: string, @Query() q: RedemptionQuery) {
    return this.promos.listRedemptions(id, q.page, q.limit);
  }

  @Post(':id/approve')
  @Permission(Module.PROMOTIONS, Action.APPROVE)
  async approve(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    const p = await this.admin.approve(id);
    await this.audit.logReq(req, 'promotion.approve', 'promotion', id, { pendingApproval: true }, { active: true });
    return p;
  }

  @Post(':id/reject')
  @Permission(Module.PROMOTIONS, Action.APPROVE)
  async reject(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RejectDto, @Req() req: any) {
    const p = await this.admin.reject(id, dto.reason);
    await this.audit.logReq(req, 'promotion.reject', 'promotion', id, { pendingApproval: true }, { reason: dto.reason });
    return p;
  }
}

/** Restaurant portal: self-serve promotions (spec 4.7). Restaurant-funded only. */
@RestaurantController('promotions')
@RestaurantRoles(RestaurantRole.OWNER, RestaurantRole.LOCATION_MANAGER)
export class RestaurantPromotionsController {
  constructor(private admin: PromotionsAdminService) {}

  @Get()
  list(@CurrentUser() u: AuthUser, @Query() q: RestaurantPromotionQuery) {
    return this.admin.restaurantList(u, q);
  }

  @Post()
  create(@CurrentUser() u: AuthUser, @Body() dto: RestaurantPromotionDto) {
    return this.admin.restaurantCreate(u, dto);
  }

  @Get(':id/stats')
  stats(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.admin.restaurantStats(u, id);
  }

  @Post(':id/pause')
  pause(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.admin.restaurantSetActive(u, id, false);
  }

  @Post(':id/resume')
  resume(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.admin.restaurantSetActive(u, id, true);
  }

  @Delete(':id')
  remove(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.admin.restaurantRemove(u, id);
  }
}

/** Public deals (customer home 'deals' + restaurant page promos). */
@PublicController('deals')
export class PublicDealsController {
  constructor(private promos: PromotionsService) {}

  @Get()
  feed(@Query('cityId') cityId?: string, @Query('zoneId') zoneId?: string, @Query('limit') limit?: string) {
    return this.promos.dealsFeed({ cityId, zoneId, limit: limit ? +limit : 20 });
  }

  @Get('restaurant/:restaurantId')
  forRestaurant(@Param('restaurantId', ParseUUIDPipe) restaurantId: string, @Query('cityId') cityId?: string, @Query('zoneId') zoneId?: string) {
    return this.promos.listActiveForRestaurant(restaurantId, { cityId, zoneId });
  }
}
