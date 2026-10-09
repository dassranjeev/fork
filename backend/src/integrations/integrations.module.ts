import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Setting } from '../database/entities';
import { IntegrationsService } from './integrations.service';
import { MapboxService } from './mapbox.service';
import { StripeClientService } from './stripe-client.service';
import { AdminGeocodeController, AdminIntegrationsController, PublicGeocodeController, PublicPaymentsConfigController } from './integrations.controllers';

/**
 * External-service credentials and clients: Stripe (client, key resolution, mock gate), Mapbox (address search proxy) and the
 * Admin "Integrations" page API. @Global so the payments / finance / geocoding code can inject the clients without importing this module.
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([Setting])],
  providers: [StripeClientService, MapboxService, IntegrationsService],
  controllers: [AdminIntegrationsController, PublicGeocodeController, AdminGeocodeController, PublicPaymentsConfigController],
  exports: [StripeClientService, MapboxService, IntegrationsService],
})
export class IntegrationsModule {}
