import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsEmail, IsEnum, IsIn, IsNumber, IsOptional, IsString, Length, MinLength, ValidateNested } from 'class-validator';
import { VehicleType } from '../common/enums';

export class LoginDto {
  @IsString() identifier: string; // email or phone
  @IsString() password: string;
  /** which app is logging in - used to reject wrong account types */
  @IsOptional() @IsIn(['admin', 'restaurant', 'driver', 'customer']) app?: 'admin' | 'restaurant' | 'driver' | 'customer';
  @IsOptional() @IsString() deviceInfo?: string;
}

export class TwoFactorVerifyDto {
  @IsString() tempToken: string;
  @IsString() @Length(6, 6) code: string;
}

export class TwoFactorEnableDto {
  @IsString() @Length(6, 6) code: string;
}

export class RefreshDto {
  @IsString() refreshToken: string;
}

export class ChangePasswordDto {
  @IsString() currentPassword: string;
  @IsString() @MinLength(8) newPassword: string;
}

export class ForgotPasswordDto {
  @IsString() identifier: string;
}

export class ResetPasswordDto {
  @IsString() identifier: string;
  @IsString() code: string;
  @IsString() @MinLength(8) newPassword: string;
}

export class OtpRequestDto {
  @IsString() phone: string;
  @IsOptional() @IsIn(['customer', 'driver', 'restaurant']) app?: 'customer' | 'driver' | 'restaurant';
}

export class OtpVerifyDto {
  @IsString() phone: string;
  @IsString() @Length(4, 8) code: string;
  @IsOptional() @IsIn(['customer', 'driver', 'restaurant']) app?: 'customer' | 'driver' | 'restaurant';
  /** when the phone is new, these create a customer account */
  @IsOptional() @IsString() firstName?: string;
  @IsOptional() @IsString() lastName?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() referralCode?: string;
  @IsOptional() @IsString() deviceInfo?: string;
}

export class CustomerRegisterDto {
  @IsString() firstName: string;
  @IsString() lastName: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() phone?: string;
  @IsString() @MinLength(8) password: string;
  @IsOptional() @IsString() referralCode?: string;
  @IsOptional() @IsBoolean() marketingEmailConsent?: boolean;
  @IsOptional() @IsBoolean() marketingSmsConsent?: boolean;
  @IsOptional() @IsString() language?: string;
}

export class SocialLoginDto {
  @IsIn(['google', 'apple']) provider: 'google' | 'apple';
  @IsString() idToken: string;
  @IsOptional() @IsString() firstName?: string;
  @IsOptional() @IsString() lastName?: string;
  @IsOptional() @IsString() referralCode?: string;
}

export class DriverRegisterDto {
  @IsString() firstName: string;
  @IsString() lastName: string;
  @IsString() phone: string;
  @IsEmail() email: string;
  @IsString() @MinLength(8) password: string;
  /** phone OTP obtained from /auth/otp/request (purpose SIGNUP) */
  @IsString() otpCode: string;
  @IsString() cityId: string;
  @IsEnum(VehicleType) vehicleType: VehicleType;
  @IsOptional() @IsString() vehicleMake?: string;
  @IsOptional() @IsString() vehicleModel?: string;
  @IsOptional() @IsString() vehicleColor?: string;
  @IsOptional() @IsString() licensePlate?: string;
  @IsOptional() @IsString() language?: string;
}

export class RestaurantApplyDto {
  // owner
  @IsString() ownerFirstName: string;
  @IsString() ownerLastName: string;
  @IsEmail() email: string;
  @IsString() phone: string;
  @IsString() @MinLength(8) password: string;
  // business
  @IsString() businessName: string;
  @IsOptional() @IsString() legalName?: string;
  @IsOptional() @IsString() hstNumber?: string;
  // location
  @IsString() restaurantName: string;
  @IsString() addressLine1: string;
  @IsOptional() @IsString() addressLine2?: string;
  @IsString() city: string;
  @IsOptional() @IsString() province?: string;
  @IsString() postalCode: string;
  @IsOptional() @IsNumber() lat?: number;
  @IsOptional() @IsNumber() lng?: number;
  @IsOptional() @IsArray() cuisineIds?: string[];
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() cityId?: string;
  @IsOptional() @IsBoolean() pickupEnabled?: boolean;
  @IsOptional() @IsBoolean() deliveryEnabled?: boolean;
}
