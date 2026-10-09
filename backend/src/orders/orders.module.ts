import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  City,
  CommissionTier,
  CustomerProfile,
  DeliveryProof,
  DriverLocationLog,
  DriverProfile,
  Incentive,
  LedgerEntry,
  MenuCategory,
  MenuItem,
  MenuItemModifierGroup,
  ModifierGroup,
  ModifierOption,
  Order,
  OrderEvent,
  OrderItem,
  OrderMessage,
  Payment,
  Refund,
  Restaurant,
  StripeIntent,
  TaxClass,
  Ticket,
  UploadedFile,
  WalletTransaction,
  Zone,
} from '../database/entities';
import { PricingService } from './pricing.service';
import { OrdersService } from './orders.service';
import { PaymentsService } from './payments.service';
import { LedgerService } from './ledger.service';
import { WalletService } from './wallet.service';
import { RefundsService } from './refunds.service';
import { OrderChatService } from './order-chat.service';
import { ProofService } from './proof.service';
import { OrderAutomationService } from './order-automation.service';
import { AdminAutomationController, RestaurantAutomationController } from './order-automation.controller';
import { OrdersController } from './orders.controller';
import { AdminOrdersController } from './admin-orders.controller';
import { DeliveryOptionsController } from './delivery-options.controller';

/**
 * @Global (ARCHITECTURE.md): every other module consumes Orders' services directly rather than
 * re-declaring them as imports, since the order lifecycle is the hub nearly everything reacts to.
 */
@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Order,
      OrderItem,
      OrderEvent,
      OrderMessage,
      Payment,
      StripeIntent,
      Refund,
      LedgerEntry,
      WalletTransaction,
      Restaurant,
      DriverProfile,
      CustomerProfile,
      MenuItem,
      MenuCategory,
      MenuItemModifierGroup,
      ModifierGroup,
      ModifierOption,
      TaxClass,
      City,
      Zone,
      CommissionTier,
      Incentive,
      DeliveryProof,
      DriverLocationLog,
      Ticket,
      UploadedFile,
    ]),
  ],
  providers: [PricingService, OrdersService, PaymentsService, LedgerService, WalletService, RefundsService, OrderChatService, ProofService, OrderAutomationService],
  controllers: [OrdersController, AdminOrdersController, DeliveryOptionsController, RestaurantAutomationController, AdminAutomationController],
  exports: [PricingService, OrdersService, PaymentsService, LedgerService, WalletService, RefundsService, OrderChatService, ProofService, OrderAutomationService],
})
export class OrdersModule {}
