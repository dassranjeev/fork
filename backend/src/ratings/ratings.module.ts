import { Global, Module } from '@nestjs/common';
import { RatingAggregatesService } from './rating-aggregates.service';
import { RatingFraudService } from './rating-fraud.service';
import { RatingsService } from './ratings.service';
import { CustomerRatingsService } from './customer-ratings.service';
import { RatingsAdminService } from './ratings-admin.service';
import { RatingsSchedulerService } from './ratings-scheduler.service';
import {
  AdminRatingsController,
  CustomerRatingsController,
  CustomerReviewController,
  DriverRateCustomerController,
  PublicRatingOptionsController,
  RestaurantRateCustomerController,
  RestaurantRatingsController,
} from './ratings.controllers';

/**
 * Ratings (docs/ratings.md): customer reviews of restaurants and drivers, private partner feedback about customers,
 * smoothed rolling aggregates, fraud flagging, moderation, prompts and threshold consequences.
 * @Global so Restaurants/Drivers/Analytics can use the services without importing this module.
 */
@Global()
@Module({
  providers: [RatingAggregatesService, RatingFraudService, RatingsService, CustomerRatingsService, RatingsAdminService, RatingsSchedulerService],
  controllers: [PublicRatingOptionsController, CustomerReviewController, CustomerRatingsController, DriverRateCustomerController, RestaurantRateCustomerController, RestaurantRatingsController, AdminRatingsController],
  exports: [RatingAggregatesService, RatingsService, CustomerRatingsService, RatingsAdminService],
})
export class RatingsModule {}
