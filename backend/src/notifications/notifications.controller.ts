import { BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthUser } from '../common/auth.types';
import { CurrentUser, Public } from '../common/decorators';
import { UserType } from '../common/enums';
import { InboxQueryDto, PreferencesDto, ReadBodyDto, RegisterDeviceDto, SubscribeDto, UnsubscribeDto, EndpointQueryDto } from './notifications.dto';
import { NotificationsService } from './notifications.service';
import { PreferencesService, audienceOfUser } from './preferences.service';
import { WebPushService } from './web-push.service';
import { SettingsService } from '../settings/settings.service';

const APP_OF: Record<string, 'customer' | 'driver' | 'restaurant' | 'admin'> = {
  [UserType.CUSTOMER]: 'customer',
  [UserType.DRIVER]: 'driver',
  [UserType.RESTAURANT]: 'restaurant',
  [UserType.STAFF]: 'admin',
  [UserType.SUPER_ADMIN]: 'admin',
};

/**
 * ONE notification API for every app (customer website / app, driver, restaurant portal, admin console):
 * the notification center (list, unread count, read, delete), preferences, browser push (W3C Web Push + VAPID) and native devices (FCM).
 * Every route works on the CALLER's own data only; ids of other users are indistinguishable from unknown ids (404).
 */
@ApiTags('Notifications (all apps)')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(
    private svc: NotificationsService,
    private prefs: PreferencesService,
    private push: WebPushService,
    private settings: SettingsService,
  ) {}

  // ---------------------------------------------------------------- center
  /** Cursor pagination: ?cursor=<nextCursor>&limit=30&unread=true&category=orders. (?page=N still works for older clients.) */
  @Get()
  list(@CurrentUser() u: AuthUser, @Query() q: InboxQueryDto) {
    return this.svc.list(u.id, u.type, {
      cursor: q.cursor,
      limit: q.limit ? Number(q.limit) : undefined,
      page: q.page ? Number(q.page) : undefined,
      unread: q.unread === 'true' || q.unread === '1',
      category: q.category,
    });
  }

  @Get('unread-count')
  async unread(@CurrentUser() u: AuthUser) {
    return { count: await this.svc.unreadCount(u.id) };
  }

  @Post('read-all')
  @HttpCode(200)
  async readAll(@CurrentUser() u: AuthUser) {
    const changed = await this.svc.markRead(u.id);
    return { ok: true, changed, unread: 0 };
  }

  /** legacy: POST /notifications/read { id? } (no id = all) */
  @Post('read')
  @HttpCode(200)
  async readLegacy(@CurrentUser() u: AuthUser, @Body() body: ReadBodyDto) {
    const changed = await this.svc.markRead(u.id, body?.id);
    return { ok: true, changed };
  }

  // ---------------------------------------------------------------- preferences
  @Get('preferences')
  getPreferences(@CurrentUser() u: AuthUser) {
    return this.prefs.view(u.id, u.type);
  }

  @Put('preferences')
  updatePreferences(@CurrentUser() u: AuthUser, @Body() dto: PreferencesDto) {
    return this.prefs.update(u.id, u.type, dto as any);
  }

  // ---------------------------------------------------------------- browser push (Web Push + VAPID)
  /** Public: is browser push available and which VAPID public key to subscribe with. */
  @Public()
  @Get('push/config')
  async pushConfig() {
    const on = this.settings.get<boolean>('notifications.push.enabled', true) !== false;
    const web = this.settings.get<boolean>('notifications.push.webEnabled', true) !== false;
    const publicKey = on && web ? await this.push.publicKey() : null;
    return { enabled: !!publicKey, publicKey };
  }

  @Post('push/subscribe')
  @HttpCode(200)
  async subscribe(@CurrentUser() u: AuthUser, @Body() dto: SubscribeDto, @Req() req: any) {
    if (dto.app !== APP_OF[u.type]) throw new BadRequestException(`A ${u.type.toLowerCase()} account subscribes as app "${APP_OF[u.type]}"`);
    const s = await this.push.subscribe(u.id, dto.app, { endpoint: dto.subscription.endpoint, keys: dto.subscription.keys }, String(req.headers['user-agent'] ?? ''));
    return { ok: true, id: s.id };
  }

  @Post('push/unsubscribe')
  @HttpCode(200)
  async unsubscribe(@CurrentUser() u: AuthUser, @Body() dto: UnsubscribeDto) {
    return { ok: true, ...(await this.push.unsubscribe(u.id, dto.endpoint)) };
  }

  /** Is THIS browser (?endpoint=) / is the user subscribed anywhere. Also refreshes the browser's lastSeenAt. */
  @Get('push/status')
  async status(@CurrentUser() u: AuthUser, @Query() q: EndpointQueryDto) {
    if (q.endpoint) await this.push.touch(u.id, q.endpoint);
    const s = await this.push.status(u.id, q.endpoint);
    const prefs = await this.prefs.get(u.id, u.type);
    return { ...s, pushEnabled: prefs.pushEnabled, platformEnabled: this.settings.get<boolean>('notifications.push.enabled', true) !== false };
  }

  /** This user's browsers and native devices (no endpoints / tokens are returned). */
  @Get('push/devices')
  async devices(@CurrentUser() u: AuthUser, @Query() q: EndpointQueryDto) {
    return { data: await this.svc.devices(u.id, q.endpoint) };
  }

  @Delete('push/devices/:id')
  async removeDevice(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    if (!(await this.svc.removeDevice(u.id, id))) throw new NotFoundException('Device not found');
    return { ok: true };
  }

  /** Send a test notification (in-app + push) to the caller. */
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('push/test')
  @HttpCode(200)
  async test(@CurrentUser() u: AuthUser) {
    const results = await this.svc.notifyDetailed({
      userId: u.id,
      audience: audienceOfUser(u.type),
      event: 'notification.test',
      vars: { message: 'Push notifications work on this device.' },
      channels: ['PUSH', 'IN_APP'] as any,
      critical: true,
    });
    return { ok: results.some((r) => r.channel === 'PUSH' && r.status === 'SENT'), results };
  }

  // ---------------------------------------------------------------- native devices (FCM; for the future mobile apps)
  @Post('devices')
  @HttpCode(200)
  async registerDevice(@CurrentUser() u: AuthUser, @Body() dto: RegisterDeviceDto) {
    if (dto.app !== APP_OF[u.type]) throw new BadRequestException(`A ${u.type.toLowerCase()} account registers as app "${APP_OF[u.type]}"`);
    const d = await this.svc.registerDevice(u.id, dto);
    return { ok: true, id: d.id };
  }

  @Delete('devices/:token')
  async unregister(@CurrentUser() u: AuthUser, @Param('token') token: string) {
    await this.svc.unregisterDevice(u.id, token);
    return { ok: true };
  }

  // ---------------------------------------------------------------- one notification (keep AFTER the static routes above)
  @Post(':id/read')
  @HttpCode(200)
  async read(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    if (!(await this.svc.ownsInApp(u.id, id))) throw new NotFoundException('Notification not found');
    await this.svc.markRead(u.id, id);
    return { ok: true, unread: await this.svc.unreadCount(u.id) };
  }

  @Delete(':id')
  async remove(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    if (!(await this.svc.remove(u.id, id))) throw new NotFoundException('Notification not found');
    return { ok: true, unread: await this.svc.unreadCount(u.id) };
  }
}
