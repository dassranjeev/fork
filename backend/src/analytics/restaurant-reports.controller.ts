import { Get, Query, UseInterceptors } from '@nestjs/common';
import { ShortCacheInterceptor } from '../common/short-cache.interceptor';
import { RestaurantController, CurrentUser, RestaurantRoles } from '../common/decorators';
import { RestaurantRole } from '../common/enums';
import { AuthUser } from '../common/auth.types';
import { AnalyticsFilterDto } from './analytics.dto';
import { RestaurantReportsService } from './restaurant-reports.service';

/**
 * Restaurant self-serve reports (spec §4/§12): `/restaurant/reports/*`, scoped to the caller's
 * `restaurantIds` (all of the merchant's locations for OWNER, else their assigned location).
 * Item / hour / rating reports: any role. Sales, payouts and promotion reports expose money and commission figures: OWNER + LOCATION_MANAGER
 * (payouts: OWNER only).
 */
@RestaurantController('reports')
@UseInterceptors(ShortCacheInterceptor)
export class RestaurantReportsController {
  constructor(private readonly reports: RestaurantReportsService) {}

  @Get('sales')
  @RestaurantRoles(RestaurantRole.OWNER, RestaurantRole.LOCATION_MANAGER)
  sales(@Query() f: AnalyticsFilterDto, @CurrentUser() user: AuthUser) {
    return this.reports.salesFor(f, user);
  }

  @Get('top-items')
  topItems(@Query() f: AnalyticsFilterDto, @CurrentUser() user: AuthUser) {
    return this.reports.topItemsFor(f, user);
  }

  @Get('peak-hours')
  peakHours(@Query() f: AnalyticsFilterDto, @CurrentUser() user: AuthUser) {
    return this.reports.peakHoursFor(f, user);
  }

  @Get('ratings')
  ratings(@Query() f: AnalyticsFilterDto, @CurrentUser() user: AuthUser) {
    return this.reports.ratingsFor(f, user);
  }

  @Get('payouts')
  @RestaurantRoles(RestaurantRole.OWNER)
  payouts(@Query() f: AnalyticsFilterDto, @CurrentUser() user: AuthUser) {
    return this.reports.payoutsFor(f, user);
  }

  @Get('promotions')
  @RestaurantRoles(RestaurantRole.OWNER, RestaurantRole.LOCATION_MANAGER)
  promotions(@Query() f: AnalyticsFilterDto, @CurrentUser() user: AuthUser) {
    return this.reports.promotionsFor(f, user);
  }
}
