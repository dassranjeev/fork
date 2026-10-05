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
    const pin = this.settings.get<boolean>('delivery.proof.pinAlways', true);
    return {
      ...DELIVERY_OPTIONS,
      methods: DELIVERY_OPTIONS.methods.map((m) => ({
        ...m,
        // reflect the live settings
        proof: m.value === 'LEAVE_AT_DOOR' ? { ...m.proof, required: photo } : { ...m.proof, required: pin, note: pin ? undefined : 'Only for higher-value orders' },
      })),
    };
  }
}
