import { Get } from '@nestjs/common';
import { PublicController } from '../common/decorators';
import { SettingsService } from '../settings/settings.service';
import { DELIVERY_OPTIONS } from './delivery-instructions';

/** GET /public/delivery-options - quick-pick metadata for the app UI (methods, what proof each implies, suggested instruction chips). */
@PublicController('delivery-options')
export class DeliveryOptionsController {
  constructor(private settings: SettingsService) {}

  @Get()
  options() {
    const photo = this.settings.get<boolean>('delivery.proof.leaveAtDoorPhotoRequired', true);
    const geofenceMeters = this.settings.get<number>('delivery.proof.geofenceMeters', 100);
    return {
      ...DELIVERY_OPTIONS,
      geofenceMeters,
      methods: DELIVERY_OPTIONS.methods.map((m) => ({
        ...m,
        // reflect the live settings
        proof: m.value === 'LEAVE_AT_DOOR' ? { ...m.proof, required: photo } : { ...m.proof, required: true, optional: 'The customer can turn the PIN off (usePin=false); the driver then uploads a photo instead.' },
      })),
    };
  }
}
