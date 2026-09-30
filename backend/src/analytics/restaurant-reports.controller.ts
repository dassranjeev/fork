import { Get, Query } from '@nestjs/common';
import { RestaurantController, CurrentUser } from '../common/decorators';
import { AuthUser } from '../common/auth.types';
import { AnalyticsFilterDto } from './analytics.dto';
import { RestaurantReportsService } from './restaurant-reports.service';

/**
 * Restaurant self-serve reports (spec §4/§12): `/restaurant/reports/*`, scoped to the caller's
 * `restaurantIds` (all of the merchant's locations for OWNER, else their assigned location).
 * Any RestaurantRole may view reports (no @RestaurantRoles restriction).
 */
@RestaurantController('reports')
export class RestaurantReportsController {
  constructor(private readonly reports: RestaurantReportsService) {}

  @Get('sales')
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
  payouts(@Query() f: AnalyticsFilterDto, @CurrentUser() user: AuthUser) {
    return this.reports.payoutsFor(f, user);
  }

  @Get('promotions')
  promotions(@Query() f: AnalyticsFilterDto, @CurrentUser() user: AuthUser) {
    return this.reports.promotionsFor(f, user);
  }
}
