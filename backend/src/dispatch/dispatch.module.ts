import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { City, DriverLocationLog, DriverOffer, DriverProfile, Order, OrderItem, Restaurant } from '../database/entities';
import { DispatchRankingService } from './dispatch-ranking.service';
import { DriverLocationService } from './driver-location.service';
import { DispatchService } from './dispatch.service';
import { AdminLiveMapController } from './admin-live-map.controller';
import { DriverOfferController } from './driver-offer.controller';

/**
 * @Global (ARCHITECTURE.md): the offer loop / DispatchService is consumed by OrdersModule's neighbours
 * (drivers app, admin live map) without them importing this module.
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([Order, OrderItem, DriverOffer, DriverProfile, DriverLocationLog, City, Restaurant])],
  providers: [DispatchRankingService, DriverLocationService, DispatchService],
  controllers: [AdminLiveMapController, DriverOfferController],
  exports: [DispatchService, DispatchRankingService, DriverLocationService],
})
export class DispatchModule {}
