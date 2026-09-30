import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Address, CustomerProfile, DataRequest, Order, Review, User } from '../database/entities';
import { CartService } from './cart.service';
import { CustomerAccountService } from './customer-account.service';
import { DiscoveryService } from './discovery.service';
import { DataRequestsService } from './data-requests.service';
import { CheckoutService } from './checkout.service';
import { AdminCustomersService } from './admin-customers.service';
import { ExternalServices } from './lazy';
import { AdminCustomersController } from './admin-customers.controller';
import {
  CustomerAddressesController,
  CustomerCardsController,
  CustomerFavoritesController,
  CustomerPrivacyController,
  CustomerProfileController,
  CustomerReferralsController,
  CustomerWalletController,
} from './account.controller';
import { CustomerCartController, CustomerCheckoutController } from './cart-checkout.controller';
import { CustomerOrdersController } from './customer-orders.controller';
import {
  CustomerHomeController,
  CustomerRestaurantsController,
  CustomerSearchController,
  PublicGuestController,
  PublicHomeController,
  PublicRestaurantsController,
  PublicSearchController,
} from './discovery.controller';

@Module({
  // forFeature only for DataRequestsService (@InjectRepository); other services use DataSource.getRepository.
  imports: [TypeOrmModule.forFeature([DataRequest, User, CustomerProfile, Address, Order, Review])],
  providers: [ExternalServices, CartService, DiscoveryService, DataRequestsService, CustomerAccountService, CheckoutService, AdminCustomersService],
  controllers: [
    AdminCustomersController,
    CustomerProfileController,
    CustomerAddressesController,
    CustomerFavoritesController,
    CustomerCardsController,
    CustomerWalletController,
    CustomerReferralsController,
    CustomerPrivacyController,
    CustomerCartController,
    CustomerCheckoutController,
    CustomerOrdersController,
    CustomerHomeController,
    CustomerSearchController,
    CustomerRestaurantsController,
    PublicHomeController,
    PublicSearchController,
    PublicRestaurantsController,
    PublicGuestController,
  ],
  exports: [CartService, DiscoveryService, CustomerAccountService, DataRequestsService],
})
export class CustomersModule {}
