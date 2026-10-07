import { Body, Get, Param, ParseUUIDPipe, Patch, Query, Req } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, ValidateIf } from 'class-validator';
import { AdminController, CurrentUser, Permission, RestaurantController, RestaurantRoles } from '../common/decorators';
import { Action, Module, RestaurantRole } from '../common/enums';
import { AuthUser } from '../common/auth.types';
import { resolveRestaurantId } from '../restaurants/restaurants.util';
import { OrderAutomationService } from './order-automation.service';

/** true / false = this restaurant's own choice, null = follow the platform default. Strict: the string "false" is rejected. */
export class AutomationDto {
  @IsOptional() @ValidateIf((_o, v) => v !== null) @Transform(({ obj }) => obj.autoAccept) @IsBoolean() autoAccept?: boolean | null;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @Transform(({ obj }) => obj.autoStartPrep) @IsBoolean() autoStartPrep?: boolean | null;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @Transform(({ obj }) => obj.autoReady) @IsBoolean() autoReady?: boolean | null;
}

/** Restaurant portal: how much of the order flow the system drives (accept -> start prep -> ready). */
@RestaurantController('automation')
export class RestaurantAutomationController {
  constructor(private automation: OrderAutomationService) {}

  @Get()
  get(@CurrentUser() user: AuthUser, @Query('restaurantId') restaurantId?: string) {
    return this.automation.view(resolveRestaurantId(user, restaurantId));
  }

  @Patch()
  @RestaurantRoles(RestaurantRole.OWNER, RestaurantRole.LOCATION_MANAGER)
  update(@CurrentUser() user: AuthUser, @Body() dto: AutomationDto, @Query('restaurantId') restaurantId?: string) {
    return this.automation.update(resolveRestaurantId(user, restaurantId), dto, user);
  }
}

/** Admin console: the same switches for any restaurant. */
@AdminController('restaurants')
export class AdminAutomationController {
  constructor(private automation: OrderAutomationService) {}

  @Get(':id/automation')
  @Permission(Module.RESTAURANTS, Action.VIEW)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.automation.view(id);
  }

  @Patch(':id/automation')
  @Permission(Module.RESTAURANTS, Action.EDIT)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AutomationDto, @CurrentUser() user: AuthUser, @Req() req: any) {
    return this.automation.update(id, dto, user, req);
  }
}
