import { applyDecorators } from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';

/** Optional boolean that must really be a JSON boolean (the global implicit conversion would turn "false" into true). */
export const StrictBool = () => applyDecorators(IsOptional(), Transform(({ obj, key }) => obj[key]), IsBoolean());

const APPS = ['customer', 'driver', 'restaurant', 'admin'] as const;
export type AppName = (typeof APPS)[number];

export class InboxQueryDto {
  @IsOptional() @IsString() @MaxLength(200) cursor?: string;
  @IsOptional() @IsString() @MaxLength(6) limit?: string;
  @IsOptional() @IsString() @MaxLength(6) page?: string;
  /** "true" | "1" = unread only */
  @IsOptional() @IsString() @MaxLength(5) unread?: string;
  @IsOptional() @IsString() @MaxLength(20) category?: string;
}

export class ReadBodyDto {
  @IsOptional() @IsUUID() id?: string;
}

class PushKeysDto {
  @IsString() @MaxLength(200) p256dh: string;
  @IsString() @MaxLength(100) auth: string;
}

class PushSubscriptionDto {
  @IsString() @MaxLength(2048) endpoint: string;
  @IsOptional() @IsNumber() expirationTime?: number | null;
  @ValidateNested() @Type(() => PushKeysDto) keys: PushKeysDto;
}

export class SubscribeDto {
  @ValidateNested() @Type(() => PushSubscriptionDto) subscription: PushSubscriptionDto;
  @IsIn(APPS as unknown as string[]) app: AppName;
}

export class UnsubscribeDto {
  @IsString() @MaxLength(2048) endpoint: string;
}

export class EndpointQueryDto {
  @IsOptional() @IsString() @MaxLength(2048) endpoint?: string;
}

export class RegisterDeviceDto {
  @IsString() @MaxLength(4096) token: string;
  @IsIn(['ios', 'android']) platform: 'ios' | 'android';
  @IsIn(APPS as unknown as string[]) app: AppName;
  @IsOptional() @IsString() @MaxLength(40) appVersion?: string;
  @IsOptional() @IsString() @MaxLength(200) fingerprint?: string;
}

export class ChannelTogglesDto {
  @StrictBool() inApp?: boolean;
  @StrictBool() push?: boolean;
  @StrictBool() email?: boolean;
  @StrictBool() sms?: boolean;
}

export class CategoriesDto {
  @IsOptional() @ValidateNested() @Type(() => ChannelTogglesDto) orders?: ChannelTogglesDto;
  @IsOptional() @ValidateNested() @Type(() => ChannelTogglesDto) delivery?: ChannelTogglesDto;
  @IsOptional() @ValidateNested() @Type(() => ChannelTogglesDto) payments?: ChannelTogglesDto;
  @IsOptional() @ValidateNested() @Type(() => ChannelTogglesDto) support?: ChannelTogglesDto;
  @IsOptional() @ValidateNested() @Type(() => ChannelTogglesDto) promotions?: ChannelTogglesDto;
  @IsOptional() @ValidateNested() @Type(() => ChannelTogglesDto) system?: ChannelTogglesDto;
}

export class QuietHoursDto {
  @StrictBool() enabled?: boolean;
  @IsOptional() @IsString() @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'start must be HH:mm' }) start?: string;
  @IsOptional() @IsString() @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'end must be HH:mm' }) end?: string;
  @IsOptional() @IsString() @MaxLength(64) timezone?: string;
}

export class PreferencesDto {
  @StrictBool() pushEnabled?: boolean;
  @StrictBool() criticalBypassQuietHours?: boolean;
  @StrictBool() soundEnabled?: boolean;
  @IsOptional() @Transform(({ obj }) => obj.soundVolume) @IsInt() @Min(0) @Max(100) soundVolume?: number;
  @IsOptional() @ValidateNested() @Type(() => CategoriesDto) categories?: CategoriesDto;
  @IsOptional() @ValidateNested() @Type(() => QuietHoursDto) quietHours?: QuietHoursDto;
}

// ------------------------------------------------------------------ admin
export class DeliveryLogQueryDto {
  @IsOptional() @IsString() @MaxLength(6) page?: string;
  @IsOptional() @IsString() @MaxLength(6) limit?: string;
  @IsOptional() @IsIn(['PUSH', 'SMS', 'EMAIL']) channel?: string;
  @IsOptional() @IsIn(['SENT', 'FAILED', 'SKIPPED', 'QUEUED']) status?: string;
  @IsOptional() @IsString() @MaxLength(80) event?: string;
  @IsOptional() @IsString() @MaxLength(80) q?: string;
  @IsOptional() @IsUUID() userId?: string;
  @IsOptional() @IsString() @MaxLength(30) from?: string;
  @IsOptional() @IsString() @MaxLength(30) to?: string;
}

export class AdminTestDto {
  @IsOptional() @IsUUID() userId?: string;
  @IsOptional() @IsUUID() roleId?: string;
  @IsOptional() @IsIn(APPS as unknown as string[]) app?: AppName;
  @IsOptional() @IsString() @MaxLength(120) message?: string;
}

export class SwitchesDto {
  @StrictBool() enabled?: boolean;
  @StrictBool() webEnabled?: boolean;
  @StrictBool() fcmEnabled?: boolean;
}
