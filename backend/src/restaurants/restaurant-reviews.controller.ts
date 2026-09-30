import { Body, Get, Param, Post, Query } from '@nestjs/common';
import { CurrentUser, RestaurantController, RestaurantRoles } from '../common/decorators';
import { RestaurantRole } from '../common/enums';
import { AuthUser } from '../common/auth.types';
import { RestaurantStoreService } from './restaurant-store.service';
import { ReplyDto, ReviewsQuery } from './dto';

/** Restaurant portal ratings & reviews (spec §4.8): view + reply. Moderation stays admin-only. */
@RestaurantController('reviews')
@RestaurantRoles(RestaurantRole.OWNER, RestaurantRole.LOCATION_MANAGER)
export class RestaurantReviewsController {
  constructor(private store: RestaurantStoreService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() q: ReviewsQuery) {
    return this.store.listReviews(user.restaurantIds ?? [], q);
  }

  @Post(':id/reply')
  reply(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: ReplyDto) {
    return this.store.reply(id, user.restaurantIds ?? [], dto.reply, user);
  }
}
