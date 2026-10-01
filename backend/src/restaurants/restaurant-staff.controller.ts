import { Body, Delete, ForbiddenException, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { CurrentUser, NoImpersonation, RestaurantController, RestaurantRoles } from '../common/decorators';
import { RestaurantRole } from '../common/enums';
import { AuthUser } from '../common/auth.types';
import { RestaurantStoreService } from './restaurant-store.service';
import { MemberDto, UpdateMemberDto } from './dto';

/** Restaurant portal staff management (spec §4.7): OWNER manages every location; LOCATION_MANAGER is scoped to their own. */
@RestaurantController('staff')
@RestaurantRoles(RestaurantRole.OWNER, RestaurantRole.LOCATION_MANAGER)
export class RestaurantStaffController {
  constructor(private store: RestaurantStoreService) {}

  private scope(user: AuthUser) {
    return user.restaurantRole === RestaurantRole.OWNER ? undefined : { locations: user.restaurantIds ?? [], role: user.restaurantRole! };
  }

  private scopedRestaurantId(user: AuthUser, restaurantId?: string): string | null {
    if (user.restaurantRole === RestaurantRole.OWNER) return restaurantId ?? null;
    if (restaurantId && !(user.restaurantIds ?? []).includes(restaurantId)) throw new ForbiddenException('You do not manage this location');
    return restaurantId ?? user.restaurantIds?.[0] ?? null;
  }

  @Get()
  list(@CurrentUser() user: AuthUser, @Query('restaurantId') restaurantId?: string) {
    return this.store.listMembers(user.merchantId!, this.scopedRestaurantId(user, restaurantId));
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: MemberDto, @Query('restaurantId') restaurantId?: string, @Req() req?: any) {
    const defaultRestaurantId = user.restaurantRole === RestaurantRole.OWNER ? null : this.scopedRestaurantId(user, restaurantId);
    return this.store.createMember(user.merchantId!, dto, defaultRestaurantId, user, this.scope(user), req);
  }

  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateMemberDto, @Req() req?: any) {
    return this.store.updateMember(user.merchantId!, id, dto, user, this.scope(user), req);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string, @Req() req?: any) {
    return this.store.removeMember(user.merchantId!, id, user, this.scope(user), req);
  }

  @NoImpersonation()
  @Post(':id/reset-password')
  resetPassword(@CurrentUser() user: AuthUser, @Param('id') id: string, @Req() req?: any) {
    return this.store.resetMemberPassword(user.merchantId!, id, user, this.scope(user), req);
  }
}
