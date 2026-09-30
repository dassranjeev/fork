import { ForbiddenException, Post } from '@nestjs/common';
import { DriverController, CurrentUser } from '../common/decorators';
import { ActorType } from '../common/enums';
import { AuthUser } from '../common/auth.types';
import { PayoutsService } from './payouts.service';

/**
 * Minimal driver-facing route for instant cash-out so the capability exists end-to-end even before the
 * Drivers module wires its own earnings screen. All the business logic lives in PayoutsService.instantCashOut
 * (implements IPayoutsService per contracts.ts) - this controller only adapts the HTTP call.
 */
@DriverController('earnings')
export class DriverEarningsController {
  constructor(private payouts: PayoutsService) {}

  @Post('instant-cashout')
  instantCashOut(@CurrentUser() user: AuthUser) {
    if (!user.driverId) throw new ForbiddenException('No driver profile on this account');
    return this.payouts.instantCashOut(user.driverId, { type: ActorType.DRIVER, id: user.id, name: user.name });
  }
}
