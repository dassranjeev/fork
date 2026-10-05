import { Body, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  AdminController,
  CurrentUser,
  CustomerController,
  DriverController,
  Permission,
  PublicController,
  RestaurantController,
  RestaurantRoles,
} from '../common/decorators';
import { Action, Module, RestaurantRole } from '../common/enums';
import { AuthUser } from '../common/auth.types';
import { resolveRestaurantId } from '../restaurants/restaurants.util';
import { RatingsService } from './ratings.service';
import { CustomerRatingsService } from './customer-ratings.service';
import { RatingsAdminService } from './ratings-admin.service';
import { RatingAggregatesService } from './rating-aggregates.service';
import { CreateReviewDto, EditReviewDto, ModerateReviewActionDto, RateCustomerDto, RatingWindowQuery, ReportReviewDto } from './ratings.dto';

const WRITE = { default: { limit: 10, ttl: 60_000 } };
const weeksOf = (q: RatingWindowQuery) => (q.weeks ? Math.min(52, Math.max(1, parseInt(q.weeks, 10) || 12)) : 12);

// ------------------------------------------------------------------ public
@PublicController('rating-options')
export class PublicRatingOptionsController {
  constructor(private ratings: RatingsService) {}

  /** Tag sets (positive + negative per target), stars, and the live rules (windows, comment length, reason threshold). */
  @Get()
  options() {
    return { ...this.ratings.options(), customerFeedback: this.ratings.customerOptions() };
  }
}

// ------------------------------------------------------------------ customer app
@CustomerController('orders')
export class CustomerReviewController {
  constructor(private ratings: RatingsService) {}

  @Get(':id/review')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.ratings.getReview(user.id, id);
  }

  @Post(':id/review')
  @Throttle(WRITE)
  create(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: CreateReviewDto) {
    return this.ratings.create(user.id, id, dto);
  }

  @Patch(':id/review')
  @Throttle(WRITE)
  edit(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: EditReviewDto) {
    return this.ratings.edit(user.id, id, dto);
  }
}

@CustomerController('ratings')
export class CustomerRatingsController {
  constructor(private ratings: RatingsService) {}

  @Get('pending')
  pending(@CurrentUser() user: AuthUser) {
    return this.ratings.pending(user.id);
  }
}

// ------------------------------------------------------------------ driver app
@DriverController('trip')
export class DriverRateCustomerController {
  constructor(private customerRatings: CustomerRatingsService) {}

  @Post(':orderId/rate-customer')
  @Throttle(WRITE)
  rate(@CurrentUser() user: AuthUser, @Param('orderId') orderId: string, @Body() dto: RateCustomerDto) {
    return this.customerRatings.rate('DRIVER', orderId, { userId: user.id, driverId: user.driverId }, dto);
  }
}

// ------------------------------------------------------------------ restaurant portal
@RestaurantController('orders')
@RestaurantRoles(RestaurantRole.OWNER, RestaurantRole.LOCATION_MANAGER, RestaurantRole.CASHIER)
export class RestaurantRateCustomerController {
  constructor(private customerRatings: CustomerRatingsService) {}

  @Post(':id/rate-customer')
  @Throttle(WRITE)
  rate(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: RateCustomerDto, @Query('restaurantId') restaurantId?: string) {
    resolveRestaurantId(user, restaurantId); // validates the caller's location access (404 below if the order is elsewhere)
    return this.customerRatings.rate('RESTAURANT', id, { userId: user.id, restaurantIds: [resolveRestaurantId(user, restaurantId)] }, dto);
  }
}

@RestaurantController('reviews')
@RestaurantRoles(RestaurantRole.OWNER, RestaurantRole.LOCATION_MANAGER)
export class RestaurantRatingsController {
  constructor(private admin: RatingsAdminService) {}

  /** Aggregate, distribution, top tags and weekly trend for one location. */
  @Get('summary')
  summary(@CurrentUser() user: AuthUser, @Query() q: RatingWindowQuery) {
    return this.admin.restaurantSummary(resolveRestaurantId(user, q.restaurantId), weeksOf(q));
  }

  @Post(':id/report')
  @Throttle(WRITE)
  report(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: ReportReviewDto) {
    return this.admin.report(id, user.restaurantIds ?? [], dto.reason, user);
  }
}

// ------------------------------------------------------------------ admin console
@AdminController('ratings')
export class AdminRatingsController {
  constructor(
    private admin: RatingsAdminService,
    private customerRatings: CustomerRatingsService,
    private aggregates: RatingAggregatesService,
    @InjectDataSource() private ds: DataSource,
  ) {}

  @Get('drivers/:driverId')
  @Permission(Module.DRIVERS, Action.VIEW)
  driver(@Param('driverId') driverId: string, @Query() q: RatingWindowQuery) {
    return this.admin.driverSummary(driverId, true, weeksOf(q));
  }

  @Get('restaurants/:id/summary')
  @Permission(Module.RESTAURANTS, Action.VIEW)
  restaurant(@Param('id') id: string, @Query() q: RatingWindowQuery) {
    return this.admin.restaurantSummary(id, weeksOf(q));
  }

  /** Driver-side reviews held back (flagged / hidden) across all drivers: the moderation queue. */
  @Get('driver-reviews')
  @Permission(Module.DRIVERS, Action.VIEW)
  driverQueue(@Query('status') status?: string) {
    const st = ['FLAGGED', 'HIDDEN'].includes(status ?? '') ? status : 'FLAGGED';
    return this.ds.query(
      `SELECT rv.id, rv."driverId", rv."driverRating" AS rating, rv."driverTags" AS tags, rv."driverComment" AS comment, rv."driverStatus" AS status, rv."flagReasons", rv.moderation, rv."createdAt", o.code AS "orderCode",
              TRIM(u."firstName" || ' ' || u."lastName") AS "driverName"
       FROM reviews rv JOIN orders o ON o.id = rv."orderId" JOIN driver_profiles d ON d.id = rv."driverId" JOIN users u ON u.id = d."userId"
       WHERE rv."driverRating" IS NOT NULL AND rv."driverStatus" = $1 ORDER BY rv."createdAt" DESC LIMIT 100`,
      [st],
    );
  }

  @Post('driver-reviews/:id/moderate')
  @Permission(Module.DRIVERS, Action.APPROVE)
  moderateDriver(@Param('id') id: string, @Body() dto: ModerateReviewActionDto, @Req() req: any) {
    return this.admin.moderate(id, 'DRIVER', dto.action, dto.reason, req);
  }

  @Post('restaurant-reviews/:id/moderate')
  @Permission(Module.RESTAURANTS, Action.APPROVE)
  moderateRestaurant(@Param('id') id: string, @Body() dto: ModerateReviewActionDto, @Req() req: any) {
    return this.admin.moderate(id, 'RESTAURANT', dto.action, dto.reason, req);
  }

  @Get('customers/:customerId')
  @Permission(Module.CUSTOMERS, Action.VIEW)
  customer(@Param('customerId') customerId: string) {
    return this.customerRatings.forStaff(customerId);
  }

  /** Feedback left about the customer on one order (for support disputes). */
  @Get('orders/:orderId/customer-feedback')
  @Permission(Module.SUPPORT, Action.VIEW)
  orderFeedback(@Param('orderId') orderId: string) {
    return this.customerRatings.forOrder(orderId);
  }

  @Post('recompute')
  @Permission(Module.SETTINGS, Action.EDIT)
  async recompute() {
    await this.aggregates.refresh();
    const customers = await this.customerRatings.recomputeCustomer();
    return { ok: true, customers };
  }
}
