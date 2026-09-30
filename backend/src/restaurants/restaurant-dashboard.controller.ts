import { Get, Query } from '@nestjs/common';
import { CurrentUser, RestaurantController } from '../common/decorators';
import { AuthUser } from '../common/auth.types';
import { RestaurantStoreService } from './restaurant-store.service';
import { resolveRestaurantId } from './restaurants.util';

/** Portal home screen for every role (OWNER/LOCATION_MANAGER/CASHIER/KITCHEN): today's snapshot + open status. */
@RestaurantController('dashboard')
export class RestaurantDashboardController {
  constructor(private store: RestaurantStoreService) {}

  @Get()
  dashboard(@CurrentUser() user: AuthUser, @Query('restaurantId') restaurantId?: string) {
    return this.store.dashboard(resolveRestaurantId(user, restaurantId));
  }
}
