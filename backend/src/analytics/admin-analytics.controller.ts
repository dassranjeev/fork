import { Get, Param, Query, UseInterceptors } from '@nestjs/common';
import { ShortCacheInterceptor } from '../common/short-cache.interceptor';
import { AdminController, CurrentUser, Permission } from '../common/decorators';
import { Action, Module } from '../common/enums';
import { AuthUser } from '../common/auth.types';
import { AnalyticsFilterDto } from './analytics.dto';
import { DashboardService } from './dashboard.service';
import { GrowthService } from './growth.service';
import { RestaurantPerformanceService } from './restaurant-performance.service';
import { DriverPerformanceService } from './driver-performance.service';
import { FinanceAnalyticsService } from './finance-analytics.service';
import { SupportAnalyticsService } from './support-analytics.service';
import { PilotKpisService } from './pilot-kpis.service';
import { RatingsAnalyticsService } from './ratings-analytics.service';

/**
 * Every other admin dashboard from spec §12 (Live Ops, Executive, Restaurant/Driver Performance,
 * Customer & Growth, Finance, Support, Pilot exit KPIs). One SQL source of truth per dashboard,
 * all built on `AnalyticsBase` - see analytics.base.ts / analytics.util.ts.
 */
@AdminController('analytics')
@UseInterceptors(ShortCacheInterceptor)
export class AdminAnalyticsController {
  constructor(
    private readonly dashboard: DashboardService,
    private readonly growth: GrowthService,
    private readonly restaurantPerf: RestaurantPerformanceService,
    private readonly driverPerf: DriverPerformanceService,
    private readonly financeSvc: FinanceAnalyticsService,
    private readonly supportSvc: SupportAnalyticsService,
    private readonly pilot: PilotKpisService,
    private readonly ratingsSvc: RatingsAnalyticsService,
  ) {}

  @Get('ratings')
  @Permission(Module.REPORTS, Action.VIEW)
  ratings(@Query() f: AnalyticsFilterDto, @CurrentUser() user: AuthUser) {
    return this.ratingsSvc.ratings(f, user);
  }

  @Get('live-ops')
  @Permission(Module.REPORTS, Action.VIEW)
  liveOps(@Query() f: AnalyticsFilterDto, @CurrentUser() user: AuthUser) {
    return this.dashboard.liveOps(f, user);
  }

  @Get('executive')
  @Permission(Module.REPORTS, Action.VIEW)
  executive(@Query() f: AnalyticsFilterDto, @CurrentUser() user: AuthUser) {
    return this.growth.executive(f, user);
  }

  @Get('restaurant-performance')
  @Permission(Module.REPORTS, Action.VIEW)
  restaurantPerformance(@Query() f: AnalyticsFilterDto, @CurrentUser() user: AuthUser) {
    return this.restaurantPerf.list(f, user);
  }

  @Get('restaurant-performance/:id')
  @Permission(Module.REPORTS, Action.VIEW)
  restaurantPerformanceDetail(@Param('id') id: string, @Query() f: AnalyticsFilterDto, @CurrentUser() user: AuthUser) {
    return this.restaurantPerf.detail(id, f, user);
  }

  @Get('driver-performance')
  @Permission(Module.REPORTS, Action.VIEW)
  driverPerformance(@Query() f: AnalyticsFilterDto, @CurrentUser() user: AuthUser) {
    return this.driverPerf.list(f, user);
  }

  @Get('customer-growth')
  @Permission(Module.REPORTS, Action.VIEW)
  customerGrowth(@Query() f: AnalyticsFilterDto, @CurrentUser() user: AuthUser) {
    return this.growth.customerGrowth(f, user);
  }

  @Get('finance')
  @Permission(Module.REPORTS, Action.VIEW)
  finance(@Query() f: AnalyticsFilterDto, @CurrentUser() user: AuthUser) {
    return this.financeSvc.finance(f, user);
  }

  @Get('support')
  @Permission(Module.REPORTS, Action.VIEW)
  support(@Query() f: AnalyticsFilterDto, @CurrentUser() user: AuthUser) {
    return this.supportSvc.support(f, user);
  }

  @Get('pilot-exit-kpis')
  @Permission(Module.REPORTS, Action.VIEW)
  pilotExitKpis(@Query() f: AnalyticsFilterDto, @CurrentUser() user: AuthUser) {
    return this.pilot.kpis(f, user);
  }
}
