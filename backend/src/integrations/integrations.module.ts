import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Setting } from '../database/entities';
import { IntegrationsService } from './integrations.service';
import { GoogleMapsService } from './google-maps.service';
import { MapboxService } from './mapbox.service';
import { MapsService } from './maps.service';
import { StripeClientService } from './stripe-client.service';
import { AdminGeocodeController, AdminIntegrationsController, AdminMapsController, PublicGeocodeController, PublicPaymentsConfigController } from './integrations.controllers';

/**
 * External-service credentials and clients: Stripe (client, key resolution, mock gate), the maps providers (Mapbox and Google behind MapsService) and the
 * Admin "Integrations" page API. @Global so the payments / finance / geocoding code can inject the clients without importing this module.
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([Setting])],
  providers: [StripeClientService, MapboxService, GoogleMapsService, MapsService, IntegrationsService],
  controllers: [AdminIntegrationsController, PublicGeocodeController, AdminGeocodeController, AdminMapsController, PublicPaymentsConfigController],
  exports: [StripeClientService, MapboxService, GoogleMapsService, MapsService, IntegrationsService],
})
export class IntegrationsModule {}
