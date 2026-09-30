import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  City,
  DriverProfile,
  Invoice,
  LedgerEntry,
  Merchant,
  Order,
  OrderItem,
  Payment,
  Payout,
  PayoutBatch,
  Refund,
  Restaurant,
  RestaurantMember,
  ScheduledReport,
  TaxClass,
  User,
} from '../database/entities';
import { PayoutsService } from './payouts.service';
import { InvoicesService } from './invoices.service';
import { PartiesService } from './parties.service';
import { StatementsService } from './statements.service';
import { FinanceProviders } from './finance.providers';
import { AdminFinanceController } from './admin-finance.controller';
import { RestaurantFinanceController } from './restaurant-finance.controller';
import { DriverEarningsController } from './driver-earnings.controller';

/**
 * SOP-07 weekly payout cycle, ledger/statements/invoices, HST reports, refunds approval queue, driver instant
 * cash-out (`PayoutsService` implements `IPayoutsService` - contracts.ts). `PayoutsService` is exported so
 * DriversModule (and anything else) can inject it directly per docs/ARCHITECTURE.md.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      LedgerEntry,
      PayoutBatch,
      Payout,
      Refund,
      Invoice,
      ScheduledReport,
      Merchant,
      Restaurant,
      RestaurantMember,
      DriverProfile,
      User,
      City,
      TaxClass,
      Order,
      OrderItem,
      Payment,
    ]),
  ],
  providers: [PayoutsService, InvoicesService, PartiesService, StatementsService, FinanceProviders],
  controllers: [AdminFinanceController, RestaurantFinanceController, DriverEarningsController],
  exports: [PayoutsService, InvoicesService, PartiesService, StatementsService],
})
export class FinanceModule {}
