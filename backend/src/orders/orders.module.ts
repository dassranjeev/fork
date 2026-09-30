import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  City,
  CommissionTier,
  CustomerProfile,
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
  TaxClass,
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
import { RatingAggregatesService } from './rating-aggregates.service';
import { OrdersController } from './orders.controller';
import { AdminOrdersController } from './admin-orders.controller';

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
    ]),
  ],
  providers: [PricingService, OrdersService, PaymentsService, LedgerService, WalletService, RefundsService, OrderChatService, RatingAggregatesService],
  controllers: [OrdersController, AdminOrdersController],
  exports: [PricingService, OrdersService, PaymentsService, LedgerService, WalletService, RefundsService, OrderChatService],
})
export class OrdersModule {}
