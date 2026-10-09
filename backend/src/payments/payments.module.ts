import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DriverProfile, Merchant, Order, Payment, Payout, StripeEvent, StripeIntent, User } from '../database/entities';
import { FinanceModule } from '../finance/finance.module';
import { AbandonedIntentsService } from './abandoned-intents.service';
import { ConnectService } from './connect.service';
import {
  AdminOrderPaymentsController,
  AdminPayoutAccountsController,
  AdminStripeEventsController,
  CustomerGiftCardPurchaseController,
  CustomerTopUpController,
  DriverPayoutAccountController,
  RestaurantPayoutAccountController,
  StripeWebhookController,
} from './payments.controllers';
import { StripeWebhookService } from './stripe-webhook.service';
import { TopUpService } from './topup.service';

/**
 * Stripe beyond the order flow: webhooks (signature verified, idempotent), Connect onboarding / status for drivers and restaurants,
 * wallet top-ups and gift-card purchases, and the abandoned-hold clean-up. PaymentsService itself (order holds / capture / refunds)
 * lives in the @Global OrdersModule; credentials and the Stripe client live in the @Global IntegrationsModule.
 */
@Module({
  imports: [TypeOrmModule.forFeature([StripeEvent, StripeIntent, Order, Payment, Payout, Merchant, DriverProfile, User]), FinanceModule],
  providers: [StripeWebhookService, ConnectService, TopUpService, AbandonedIntentsService],
  controllers: [StripeWebhookController, AdminOrderPaymentsController, AdminStripeEventsController, CustomerTopUpController, CustomerGiftCardPurchaseController, DriverPayoutAccountController, RestaurantPayoutAccountController, AdminPayoutAccountsController],
  exports: [ConnectService, TopUpService, StripeWebhookService, AbandonedIntentsService],
})
export class PaymentsModule {}
