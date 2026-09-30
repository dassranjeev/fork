import { Body, Get, Param, Post, Query } from '@nestjs/common';
import { CurrentUser, RestaurantController } from '../common/decorators';
import { AuthUser } from '../common/auth.types';
import { KdsService } from './kds.service';
import { resolveRestaurantId } from './restaurants.util';
import { BumpDto, ItemStatusDto, KdsSyncDto } from './dto';

/**
 * Kitchen Display System (spec §4.6): columns New -> Preparing -> Ready -> Picked up, station routing/bump,
 * colour-timer data and a kitchen load indicator. All portal roles may use it; KITCHEN needs only this + order-status.
 */
@RestaurantController('kds')
export class RestaurantKdsController {
  constructor(private kds: KdsService) {}

  private rid(user: AuthUser, restaurantId?: string) {
    return resolveRestaurantId(user, restaurantId);
  }

  @Get('board')
  board(@CurrentUser() user: AuthUser, @Query('restaurantId') restaurantId?: string, @Query('stationId') stationId?: string) {
    return this.kds.board(this.rid(user, restaurantId), stationId);
  }

  @Post(':id/start')
  start(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query('restaurantId') restaurantId?: string) {
    return this.kds.start(this.rid(user, restaurantId), id, user);
  }

  @Post('bump')
  bump(@CurrentUser() user: AuthUser, @Body() dto: BumpDto, @Query('restaurantId') restaurantId?: string) {
    return this.kds.bump(this.rid(user, restaurantId), dto.stationId, user);
  }

  @Post(':id/ready')
  ready(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query('restaurantId') restaurantId?: string) {
    return this.kds.ready(this.rid(user, restaurantId), id, user);
  }

  @Post('items/:itemId/status')
  itemStatus(@CurrentUser() user: AuthUser, @Param('itemId') itemId: string, @Body() dto: ItemStatusDto, @Query('restaurantId') restaurantId?: string) {
    return this.kds.setItemStatus(this.rid(user, restaurantId), itemId, dto.status, user);
  }

  @Post('sync')
  sync(@CurrentUser() user: AuthUser, @Body() dto: KdsSyncDto, @Query('restaurantId') restaurantId?: string) {
    return this.kds.sync(this.rid(user, restaurantId), dto.ops, user);
  }
}
