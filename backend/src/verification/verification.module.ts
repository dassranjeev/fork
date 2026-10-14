import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CommissionTier, Merchant, Order, Restaurant, RestaurantMember, User, Zone } from '../database/entities';
import { DriversModule } from '../drivers/drivers.module';
import { RestaurantsModule } from '../restaurants/restaurants.module';
import { BusinessVerification } from './business-verification';
import { CertnWebhookController } from './certn-webhook.controller';
import { DriverVerification } from './driver-verification';
import { VerificationBackfill } from './verification-backfill';
import { VerificationController } from './verification.controller';
import { VerificationService } from './verification.service';

/**
 * Registration and verification of drivers and businesses: the Super Admin policy (instant / manual / automatic), Force verification,
 * the Certn result webhook and the sweeper. See docs/verification.md.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Merchant, Restaurant, RestaurantMember, User, Zone, CommissionTier, Order]), DriversModule, RestaurantsModule],
  controllers: [VerificationController, CertnWebhookController],
  providers: [VerificationService, DriverVerification, BusinessVerification, VerificationBackfill],
  exports: [VerificationService],
})
export class VerificationModule {}
