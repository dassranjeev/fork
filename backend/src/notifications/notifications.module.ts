import { Body, Delete, Get, Global, Module, Param, Post, Query, Req } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { CustomerProfile, DeviceToken, Notification, NotificationTemplate, RestaurantMember, User } from '../database/entities';
import { NotificationsService } from './notifications.service';
import { CurrentUser } from '../common/decorators';
import { AuthUser } from '../common/auth.types';
import { Controller } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

class RegisterDeviceDto {
  @IsString() token: string;
  @IsOptional() @IsIn(['ios', 'android', 'web']) platform?: 'ios' | 'android' | 'web';
  @IsOptional() @IsIn(['customer', 'driver', 'restaurant', 'admin']) app?: 'customer' | 'driver' | 'restaurant' | 'admin';
  @IsOptional() @IsString() appVersion?: string;
  @IsOptional() @IsString() fingerprint?: string;
}

/**
 * Shared inbox + device registration for EVERY app (customer / driver / restaurant / admin).
 * GET /api/v1/notifications, GET /notifications/unread-count, POST /notifications/read, POST /notifications/devices
 */
@ApiTags('Notifications (all apps)')
@ApiBearerAuth()
@Controller('notifications')
class NotificationsInboxController {
  constructor(private svc: NotificationsService) {}

  @Get()
  async list(@CurrentUser() u: AuthUser, @Query('page') page = '1', @Query('limit') limit = '30') {
    const [data, total] = await this.svc.inbox(u.id, +page, +limit);
    return { data, meta: { page: +page, limit: +limit, total, totalPages: Math.max(1, Math.ceil(total / +limit)) } };
  }

  @Get('unread-count')
  async unread(@CurrentUser() u: AuthUser) {
    return { count: await this.svc.unreadCount(u.id) };
  }

  @Post('read')
  async readAll(@CurrentUser() u: AuthUser, @Body() body: { id?: string }) {
    await this.svc.markRead(u.id, body?.id);
    return { ok: true };
  }

  @Post('devices')
  registerDevice(@CurrentUser() u: AuthUser, @Body() dto: RegisterDeviceDto) {
    return this.svc.registerDevice(u.id, dto);
  }

  @Delete('devices/:token')
  async unregister(@Param('token') token: string) {
    await this.svc.unregisterDevice(token);
    return { ok: true };
  }
}

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([Notification, NotificationTemplate, DeviceToken, User, CustomerProfile, RestaurantMember])],
  providers: [NotificationsService],
  controllers: [NotificationsInboxController],
  exports: [NotificationsService],
})
export class NotificationsModule {}
