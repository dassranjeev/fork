import { Body, Get, Param, Post } from '@nestjs/common';
import { DriverController, CurrentUser } from '../common/decorators';
import { DispatchService } from './dispatch.service';

/**
 * Minimal driver-facing offer endpoints so the offer loop is usable even before DriversModule wires its own
 * `/driver/*` portal (per docs/ARCHITECTURE.md: "current offer / accept / decline via DispatchService"). These
 * primitives just forward to DispatchService; DriversModule may add richer trip endpoints alongside these.
 */
@DriverController('offer')
export class DriverOfferController {
  constructor(private dispatch: DispatchService) {}

  @Get('current')
  current(@CurrentUser('driverId') driverId: string) {
    return this.dispatch.currentOffer(driverId);
  }

  @Post(':id/accept')
  accept(@Param('id') id: string, @CurrentUser('driverId') driverId: string) {
    return this.dispatch.acceptOffer(id, driverId);
  }

  @Post(':id/decline')
  decline(@Param('id') id: string, @CurrentUser('driverId') driverId: string, @Body('reason') reason?: string) {
    return this.dispatch.declineOffer(id, driverId, reason);
  }
}
