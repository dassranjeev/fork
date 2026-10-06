import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  CommissionTier,
  Cuisine,
  KitchenStation,
  Merchant,
  MenuCategory,
  MenuItem,
  MenuItemModifierGroup,
  ModifierGroup,
  ModifierOption,
  Order,
  OrderEvent,
  OrderItem,
  Restaurant,
  RestaurantClosure,
  RestaurantDocument,
  RestaurantHours,
  RestaurantIntegration,
  RestaurantMember,
  Review,
  TaxClass,
  User,
  Zone,
} from '../database/entities';
import { MenuService } from './menu.service';
import { MenuAccessService } from './menu-access.service';
import { RestaurantStoreService } from './restaurant-store.service';
import { RestaurantAdminService } from './restaurant-admin.service';
import { KdsService } from './kds.service';
import { AdminRestaurantsController } from './admin-restaurants.controller';
import { RestaurantDashboardController } from './restaurant-dashboard.controller';
import { RestaurantStoreController } from './restaurant-store.controller';
import { RestaurantMenuController } from './restaurant-menu.controller';
import { RestaurantOrdersController } from './restaurant-orders.controller';
import { RestaurantKdsController } from './restaurant-kds.controller';
import { RestaurantStaffController } from './restaurant-staff.controller';
import { RestaurantReviewsController } from './restaurant-reviews.controller';

/**
 * RestaurantsModule (ARCHITECTURE.md): admin merchants/restaurants CRUD + SOP-01 onboarding pipeline,
 * members, hours/closures, kitchen stations, tablet activation, POS integration config, ratings/reviews
 * moderation, per-restaurant performance stats, document-expiry reminders; restaurant portal for
 * OWNER/LOCATION_MANAGER/CASHIER/KITCHEN (dashboard, live orders, KDS, menu, hours, staff, reviews, documents).
 *
 * Not @Global() per the module-ownership table, but services are exported in case another module needs them.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Merchant,
      Restaurant,
      RestaurantMember,
      RestaurantHours,
      RestaurantClosure,
      RestaurantDocument,
      RestaurantIntegration,
      KitchenStation,
      Cuisine,
      CommissionTier,
      Zone,
      User,
      Review,
      MenuCategory,
      MenuItem,
      ModifierGroup,
      ModifierOption,
      MenuItemModifierGroup,
      TaxClass,
      Order,
      OrderItem,
      OrderEvent,
    ]),
  ],
  providers: [MenuService, MenuAccessService, RestaurantStoreService, RestaurantAdminService, KdsService],
  controllers: [
    AdminRestaurantsController,
    RestaurantDashboardController,
    RestaurantStoreController,
    RestaurantMenuController,
    RestaurantOrdersController,
    RestaurantKdsController,
    RestaurantStaffController,
    RestaurantReviewsController,
  ],
  exports: [MenuService, RestaurantStoreService, RestaurantAdminService, KdsService],
})
export class RestaurantsModule {}
