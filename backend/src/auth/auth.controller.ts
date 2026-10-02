import { Body, Controller, Get, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { AuthService } from './auth.service';
import {
  ChangePasswordDto,
  CustomerRegisterDto,
  DriverRegisterDto,
  ForgotPasswordDto,
  LoginDto,
  OtpRequestDto,
  OtpVerifyDto,
  RefreshDto,
  ResetPasswordDto,
  RestaurantApplyDto,
  SocialLoginDto,
  TwoFactorEnableDto,
  TwoFactorVerifyDto,
} from './dto';
import { Allow2faPending, CurrentUser, NoImpersonation, Public } from '../common/decorators';
import { AuthUser } from '../common/auth.types';
import { clientIp } from '../common/security';

class UpdateProfileDto {
  @IsOptional() @IsString() @MaxLength(80) firstName?: string;
  @IsOptional() @IsString() @MaxLength(80) lastName?: string;
  @IsOptional() @IsString() @MaxLength(2048) avatarUrl?: string;
  @IsOptional() @IsString() @MaxLength(10) language?: string;
}

class PasswordDto {
  @IsString() @MaxLength(128) password: string;
}

const ctx = (req: any) => ({
  ip: clientIp(req),
  userAgent: req.headers['user-agent'] as string,
  deviceInfo: req.headers['x-device-info'] as string,
});

/**
 * Authentication for ALL apps.
 *   POST /auth/login                  email|phone + password (admin, restaurant, driver, customer)
 *   POST /auth/2fa/verify             second step when login returned { requires2fa }
 *   POST /auth/2fa/setup + /enable    enrolment (mandatory for staff & restaurant owners when ENFORCE_2FA=true)
 *   POST /auth/otp/request + verify   phone OTP sign-in / sign-up (mobile apps)
 *   POST /auth/customer/register      customer sign-up (email/phone + password)
 *   POST /auth/social                 Google / Apple sign-in for customers
 *   POST /auth/driver/register        driver sign-up (needs phone OTP with purpose SIGNUP)
 *   POST /auth/restaurant/apply       restaurant application (creates owner + merchant + location)
 *   POST /auth/refresh | logout | logout-all | forgot-password | reset-password | change-password
 *   GET/PATCH /auth/me
 */
@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  login(@Body() dto: LoginDto, @Req() req: any) {
    return this.auth.login(dto, ctx(req));
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('2fa/verify')
  verify2fa(@Body() dto: TwoFactorVerifyDto, @Req() req: any) {
    return this.auth.verify2fa(dto.tempToken, dto.code, ctx(req));
  }

  @ApiBearerAuth()
  @Allow2faPending()
  @NoImpersonation()
  @Post('2fa/setup')
  setup2fa(@CurrentUser() u: AuthUser) {
    return this.auth.setup2fa(u.id);
  }

  @ApiBearerAuth()
  @Allow2faPending()
  @NoImpersonation()
  @Post('2fa/enable')
  enable2fa(@CurrentUser() u: AuthUser & { pending2fa?: boolean }, @Body() dto: TwoFactorEnableDto, @Req() req: any) {
    return this.auth.enable2fa(u.id, dto.code, ctx(req), !!u.pending2fa);
  }

  @ApiBearerAuth()
  @NoImpersonation()
  @Post('2fa/disable')
  disable2fa(@CurrentUser() u: AuthUser, @Body() dto: PasswordDto) {
    return this.auth.disable2fa(u.id, dto.password);
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('refresh')
  refresh(@Body() dto: RefreshDto, @Req() req: any) {
    return this.auth.refresh(dto.refreshToken, ctx(req));
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('logout')
  logout(@Body() dto: RefreshDto) {
    return this.auth.logout(dto.refreshToken);
  }

  @ApiBearerAuth()
  @NoImpersonation()
  @Post('logout-all')
  logoutAll(@CurrentUser() u: AuthUser) {
    return this.auth.logoutAll(u.id);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('forgot-password')
  forgot(@Body() dto: ForgotPasswordDto) {
    return this.auth.forgotPassword(dto.identifier);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('reset-password')
  reset(@Body() dto: ResetPasswordDto, @Req() req: any) {
    return this.auth.resetPassword(dto.identifier, dto.code, dto.newPassword, clientIp(req));
  }

  @ApiBearerAuth()
  @NoImpersonation()
  @Post('change-password')
  change(@CurrentUser() u: AuthUser, @Body() dto: ChangePasswordDto) {
    return this.auth.changePassword(u.id, dto);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('otp/request')
  otpRequest(@Body() dto: OtpRequestDto) {
    return this.auth.requestLoginOtp(dto.phone, dto.app);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('otp/verify')
  otpVerify(@Body() dto: OtpVerifyDto, @Req() req: any) {
    return this.auth.verifyLoginOtp(dto, { ...ctx(req), deviceInfo: dto.deviceInfo ?? ctx(req).deviceInfo });
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('customer/register')
  registerCustomer(@Body() dto: CustomerRegisterDto, @Req() req: any) {
    return this.auth.registerCustomer(dto, ctx(req));
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('social')
  social(@Body() dto: SocialLoginDto, @Req() req: any) {
    return this.auth.socialLogin(dto, ctx(req));
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('driver/otp')
  driverOtp(@Body() dto: OtpRequestDto) {
    return this.auth.sendOtp(dto.phone, 'SIGNUP');
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('driver/register')
  registerDriver(@Body() dto: DriverRegisterDto, @Req() req: any) {
    return this.auth.registerDriver(dto, ctx(req));
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('restaurant/apply')
  applyRestaurant(@Body() dto: RestaurantApplyDto, @Req() req: any) {
    return this.auth.applyRestaurant(dto, ctx(req));
  }

  @ApiBearerAuth()
  @Get('me')
  me(@CurrentUser() u: AuthUser) {
    return this.auth.me(u);
  }

  @ApiBearerAuth()
  @NoImpersonation()
  @Patch('me')
  updateMe(@CurrentUser() u: AuthUser, @Body() dto: UpdateProfileDto) {
    return this.auth.updateProfile(u.id, dto);
  }
}
