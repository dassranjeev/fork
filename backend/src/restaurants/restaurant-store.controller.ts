import { Body, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser, RestaurantController, RestaurantRoles } from '../common/decorators';
import { RestaurantRole } from '../common/enums';
import { AuthUser } from '../common/auth.types';
import { RestaurantStoreService } from './restaurant-store.service';
import { resolveRestaurantId } from './restaurants.util';
import {
  AcceptingDto,
  BusyModeDto,
  ClosureDto,
  DocumentUploadDto,
  FulfilmentDto,
  HoursDto,
  IntegrationDto,
  KdsSettingsDto,
  NotificationSettingsDto,
  PrinterSettingsDto,
  ServiceModeDto,
  StationDto,
  TabletActivateDto,
  TabletHeartbeatDto,
  UpdateIntegrationDto,
  UpdateStoreDto,
} from './dto';

const MANAGERS = [RestaurantRole.OWNER, RestaurantRole.LOCATION_MANAGER];
const FRONT_OF_HOUSE = [RestaurantRole.OWNER, RestaurantRole.LOCATION_MANAGER, RestaurantRole.CASHIER];

/**
 * Restaurant portal: store profile, fulfilment modes, hours/closures, kitchen stations, busy mode,
 * printers/notification/KDS settings, tablet activation and POS integration config (spec §4).
 */
@RestaurantController('store')
export class RestaurantStoreController {
  constructor(private store: RestaurantStoreService) {}

  private rid(user: AuthUser, restaurantId?: string) {
    return resolveRestaurantId(user, restaurantId);
  }

  @Get()
  view(@CurrentUser() user: AuthUser, @Query('restaurantId') restaurantId?: string) {
    return this.store.view(this.rid(user, restaurantId));
  }

  @Patch()
  @RestaurantRoles(...MANAGERS)
  updateProfile(@CurrentUser() user: AuthUser, @Body() dto: UpdateStoreDto, @Query('restaurantId') restaurantId?: string) {
    return this.store.updateProfile(this.rid(user, restaurantId), dto);
  }

  @Patch('fulfilment')
  @RestaurantRoles(...MANAGERS)
  fulfilment(@CurrentUser() user: AuthUser, @Body() dto: FulfilmentDto, @Query('restaurantId') restaurantId?: string) {
    return this.store.updateFulfilment(this.rid(user, restaurantId), dto);
  }

  // ---- hours / closures ----
  @Get('hours')
  hours(@CurrentUser() user: AuthUser, @Query('restaurantId') restaurantId?: string) {
    return this.store.listHours(this.rid(user, restaurantId));
  }

  @Patch('hours')
  @RestaurantRoles(...MANAGERS)
  setHours(@CurrentUser() user: AuthUser, @Body() dto: HoursDto, @Query('restaurantId') restaurantId?: string) {
    return this.store.setHours(this.rid(user, restaurantId), dto);
  }

  @Get('closures')
  closures(@CurrentUser() user: AuthUser, @Query('restaurantId') restaurantId?: string) {
    return this.store.listClosures(this.rid(user, restaurantId));
  }

  @Post('closures')
  @RestaurantRoles(...MANAGERS)
  addClosure(@CurrentUser() user: AuthUser, @Body() dto: ClosureDto, @Query('restaurantId') restaurantId?: string) {
    return this.store.addClosure(this.rid(user, restaurantId), dto);
  }

  @Delete('closures/:closureId')
  @RestaurantRoles(...MANAGERS)
  removeClosure(@CurrentUser() user: AuthUser, @Param('closureId') closureId: string, @Query('restaurantId') restaurantId?: string) {
    return this.store.removeClosure(this.rid(user, restaurantId), closureId);
  }

  // ---- kitchen stations ----
  @Get('stations')
  stations(@CurrentUser() user: AuthUser, @Query('restaurantId') restaurantId?: string) {
    return this.store.listStations(this.rid(user, restaurantId));
  }

  @Post('stations')
  @RestaurantRoles(...MANAGERS)
  addStation(@CurrentUser() user: AuthUser, @Body() dto: StationDto, @Query('restaurantId') restaurantId?: string) {
    return this.store.addStation(this.rid(user, restaurantId), dto);
  }

  @Patch('stations/:stationId')
  @RestaurantRoles(...MANAGERS)
  updateStation(@CurrentUser() user: AuthUser, @Param('stationId') stationId: string, @Body() dto: Partial<StationDto>, @Query('restaurantId') restaurantId?: string) {
    return this.store.updateStation(this.rid(user, restaurantId), stationId, dto);
  }

  @Delete('stations/:stationId')
  @RestaurantRoles(...MANAGERS)
  removeStation(@CurrentUser() user: AuthUser, @Param('stationId') stationId: string, @Query('restaurantId') restaurantId?: string) {
    return this.store.removeStation(this.rid(user, restaurantId), stationId);
  }

  // ---- busy mode / accepting orders ----
  @Post('busy')
  @RestaurantRoles(...FRONT_OF_HOUSE)
  setBusy(@CurrentUser() user: AuthUser, @Body() dto: BusyModeDto, @Query('restaurantId') restaurantId?: string) {
    return this.store.setBusy(this.rid(user, restaurantId), dto, user);
  }

  @Post('busy/clear')
  @RestaurantRoles(...FRONT_OF_HOUSE)
  clearBusy(@CurrentUser() user: AuthUser, @Query('restaurantId') restaurantId?: string) {
    return this.store.clearBusy(this.rid(user, restaurantId), user);
  }

  @Patch('accepting')
  @RestaurantRoles(...FRONT_OF_HOUSE)
  setAccepting(@CurrentUser() user: AuthUser, @Body() dto: AcceptingDto, @Query('restaurantId') restaurantId?: string) {
    return this.store.setAccepting(this.rid(user, restaurantId), dto.accepting, user);
  }

  /** Switch service mode: CLOSED | PICKUP_ONLY | PICKUP_AND_DELIVERY (KITCHEN may not). */
  @Patch('service-mode')
  @RestaurantRoles(...FRONT_OF_HOUSE)
  setServiceMode(@CurrentUser() user: AuthUser, @Body() dto: ServiceModeDto, @Query('restaurantId') restaurantId?: string) {
    return this.store.setServiceMode(this.rid(user, restaurantId), dto, user);
  }

  // ---- printers / notifications / kds settings ----
  @Patch('printers')
  @RestaurantRoles(...MANAGERS)
  printers(@CurrentUser() user: AuthUser, @Body() dto: PrinterSettingsDto, @Query('restaurantId') restaurantId?: string) {
    return this.store.setPrinters(this.rid(user, restaurantId), dto);
  }

  @Patch('notifications')
  @RestaurantRoles(...MANAGERS)
  notificationSettings(@CurrentUser() user: AuthUser, @Body() dto: NotificationSettingsDto, @Query('restaurantId') restaurantId?: string) {
    return this.store.setNotificationSettings(this.rid(user, restaurantId), dto.settings);
  }

  @Patch('kds')
  @RestaurantRoles(...MANAGERS)
  kdsSettings(@CurrentUser() user: AuthUser, @Body() dto: KdsSettingsDto, @Query('restaurantId') restaurantId?: string) {
    return this.store.setKdsSettings(this.rid(user, restaurantId), dto as Record<string, any>);
  }

  // ---- tablet (device itself calls activate/heartbeat; any portal login works, usually a cashier account) ----
  @Post('tablet/issue-code')
  @RestaurantRoles(...MANAGERS)
  issueTabletCode(@CurrentUser() user: AuthUser, @Query('restaurantId') restaurantId?: string) {
    return this.store.issueTabletCode(this.rid(user, restaurantId), user);
  }

  @Post('tablet/activate')
  activateTablet(@CurrentUser() user: AuthUser, @Body() dto: TabletActivateDto, @Query('restaurantId') restaurantId?: string) {
    return this.store.activateTablet(this.rid(user, restaurantId), dto.code, dto.deviceId, user);
  }

  @Post('tablet/heartbeat')
  heartbeat(@CurrentUser() user: AuthUser, @Body() dto: TabletHeartbeatDto, @Query('restaurantId') restaurantId?: string) {
    return this.store.heartbeat(this.rid(user, restaurantId), dto);
  }

  // ---- POS integrations ----
  @Get('integrations')
  @RestaurantRoles(...MANAGERS)
  integrations(@CurrentUser() user: AuthUser, @Query('restaurantId') restaurantId?: string) {
    return this.store.listIntegrations(this.rid(user, restaurantId));
  }

  @Post('integrations')
  @RestaurantRoles(...MANAGERS)
  addIntegration(@CurrentUser() user: AuthUser, @Body() dto: IntegrationDto, @Query('restaurantId') restaurantId?: string) {
    return this.store.addIntegration(this.rid(user, restaurantId), dto);
  }

  @Patch('integrations/:integrationId')
  @RestaurantRoles(...MANAGERS)
  updateIntegration(@CurrentUser() user: AuthUser, @Param('integrationId') integrationId: string, @Body() dto: UpdateIntegrationDto, @Query('restaurantId') restaurantId?: string) {
    return this.store.updateIntegration(this.rid(user, restaurantId), integrationId, dto);
  }

  @Delete('integrations/:integrationId')
  @RestaurantRoles(...MANAGERS)
  removeIntegration(@CurrentUser() user: AuthUser, @Param('integrationId') integrationId: string, @Query('restaurantId') restaurantId?: string) {
    return this.store.removeIntegration(this.rid(user, restaurantId), integrationId);
  }

  // ---- documents ----
  @Get('documents')
  @RestaurantRoles(...MANAGERS)
  documents(@CurrentUser() user: AuthUser, @Query('restaurantId') restaurantId?: string) {
    return this.store.listDocuments(this.rid(user, restaurantId));
  }

  @Post('documents')
  @RestaurantRoles(...MANAGERS)
  uploadDocument(@CurrentUser() user: AuthUser, @Body() dto: DocumentUploadDto, @Query('restaurantId') restaurantId?: string) {
    return this.store.uploadDocument(this.rid(user, restaurantId), dto, user);
  }

  @Get('documents/checklist')
  @RestaurantRoles(...MANAGERS)
  documentChecklist(@CurrentUser() user: AuthUser, @Query('restaurantId') restaurantId?: string) {
    return this.store.documentChecklist(this.rid(user, restaurantId));
  }
}
