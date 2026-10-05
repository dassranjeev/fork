import { Body, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { CurrentUser, DriverController } from '../common/decorators';
import { AuthUser } from '../common/auth.types';
import { DriverAppService } from './driver-app.service';
import { DriverOpsService } from './driver-ops.service';
import { RatingsAdminService } from '../ratings/ratings-admin.service';
import { AvailableShiftsQuery, SosDto, TripQuery } from './drivers.dto';

/** Earnings, trip history, instant cash-out, shifts, incentives, ratings, heat-map and SOS (spec §5.4-5.7). */
@DriverController('')
export class DriverEarningsController {
  constructor(
    private app: DriverAppService,
    private ops: DriverOpsService,
    private ratingsAdmin: RatingsAdminService,
  ) {}

  @Get('earnings')
  earnings(@CurrentUser() user: AuthUser) {
    return this.app.earnings(user.driverId!);
  }

  @Get('trips')
  trips(@CurrentUser() user: AuthUser, @Query() q: TripQuery) {
    return this.app.tripHistory(user.driverId!, q);
  }

  @Post('cash-out')
  cashOut(@CurrentUser() user: AuthUser) {
    return this.app.cashOut(user.driverId!);
  }

  @Get('shifts/available')
  availableShifts(@CurrentUser() user: AuthUser, @Query() q: AvailableShiftsQuery) {
    return this.app.availableShifts(user.driverId!, q);
  }

  @Post('shifts/:slotId/book')
  bookShift(@CurrentUser() user: AuthUser, @Param('slotId') slotId: string) {
    return this.app.bookShift(user.driverId!, slotId);
  }

  @Get('shifts')
  myShifts(@CurrentUser() user: AuthUser) {
    return this.app.myShifts(user.driverId!);
  }

  @Delete('shifts/:id')
  cancelShift(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.app.cancelMyShift(user.driverId!, id);
  }

  @Get('incentives')
  incentives(@CurrentUser() user: AuthUser) {
    return this.app.myIncentives(user.driverId!);
  }

  @Get('ratings')
  async ratings(@CurrentUser() user: AuthUser) {
    const [perf, summary] = await Promise.all([this.app.ratingsPerformance(user.driverId!), this.ratingsAdmin.driverSummary(user.driverId!, false)]);
    // rating/ratingCount follow the display rule (null + "New" until ratings.minCountToShow reviews); recentReviews keeps its legacy name
    return { ...perf, ...summary, recentReviews: summary.recent };
  }

  @Get('heat-map')
  heatMap(@CurrentUser() user: AuthUser) {
    return this.ops.heatMap();
  }

  @Post('sos')
  raiseSos(@CurrentUser() user: AuthUser, @Body() dto: SosDto) {
    return this.app.raiseSos(user.driverId!, dto);
  }

  @Get('sos')
  sosHistory(@CurrentUser() user: AuthUser) {
    return this.app.mySosHistory(user.driverId!);
  }
}
