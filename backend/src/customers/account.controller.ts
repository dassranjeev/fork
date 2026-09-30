import { Body, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { CustomerController, CurrentUser } from '../common/decorators';
import { AuthUser } from '../common/auth.types';
import { CustomerAccountService } from './customer-account.service';
import {
  AddressDto,
  DataRequestDto,
  DeletionRequestDto,
  GuestUpgradeDto,
  SetConsentsDto,
  SetDietaryDto,
  SetNotificationPrefsDto,
  UpdateAddressDto,
  UpdateProfileDto,
} from './dto';

const ctx = (req: any) => ({
  ip: (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip,
  userAgent: req.headers['user-agent'] as string,
});

/** GET/PATCH /customer/profile/* - account, dietary/allergen prefs, CASL consents, notification prefs, sessions. */
@CustomerController('profile')
export class CustomerProfileController {
  constructor(private account: CustomerAccountService) {}

  @Get()
  me(@CurrentUser() user: AuthUser) {
    return this.account.getProfile(user.id);
  }

  @Patch()
  update(@CurrentUser() user: AuthUser, @Body() dto: UpdateProfileDto) {
    return this.account.updateProfile(user.id, dto);
  }

  @Patch('dietary')
  dietary(@CurrentUser() user: AuthUser, @Body() dto: SetDietaryDto) {
    return this.account.setDietary(user.id, dto);
  }

  @Patch('consents')
  consents(@CurrentUser() user: AuthUser, @Body() dto: SetConsentsDto, @Req() req: any) {
    return this.account.setConsents(user.id, dto, ctx(req));
  }

  @Patch('notifications')
  notificationPrefs(@CurrentUser() user: AuthUser, @Body() dto: SetNotificationPrefsDto) {
    return this.account.setNotificationPrefs(user.id, dto);
  }

  @Post('guest-upgrade')
  guestUpgrade(@CurrentUser() user: AuthUser, @Body() dto: GuestUpgradeDto) {
    return this.account.upgradeGuest(user.id, dto);
  }

  @Post('logout-everywhere')
  logoutEverywhere(@CurrentUser() user: AuthUser) {
    return this.account.logoutEverywhere(user.id);
  }
}

/** /customer/addresses - saved delivery addresses (up to 20). */
@CustomerController('addresses')
export class CustomerAddressesController {
  constructor(private account: CustomerAccountService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.account.listAddresses(user.id);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: AddressDto) {
    return this.account.createAddress(user.id, dto);
  }

  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateAddressDto) {
    return this.account.updateAddress(user.id, id, dto);
  }

  @Post(':id/default')
  setDefault(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.account.setDefaultAddress(user.id, id);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.account.deleteAddress(user.id, id);
  }
}

/** /customer/favorites - saved restaurants (returned as home-feed style restaurant cards). */
@CustomerController('favorites')
export class CustomerFavoritesController {
  constructor(private account: CustomerAccountService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query('lat') lat?: string, @Query('lng') lng?: string) {
    return this.account.listFavorites(user.id, lat ? +lat : undefined, lng ? +lng : undefined);
  }

  @Post(':restaurantId')
  add(@CurrentUser() user: AuthUser, @Param('restaurantId') restaurantId: string) {
    return this.account.addFavorite(user.id, restaurantId);
  }

  @Delete(':restaurantId')
  remove(@CurrentUser() user: AuthUser, @Param('restaurantId') restaurantId: string) {
    return this.account.removeFavorite(user.id, restaurantId);
  }
}

/** /customer/cards - saved payment methods (Stripe, via the @Global PaymentsService). */
@CustomerController('cards')
export class CustomerCardsController {
  constructor(private account: CustomerAccountService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.account.listCards(user.id);
  }

  @Post('setup-intent')
  setup(@CurrentUser() user: AuthUser) {
    return this.account.setupCard(user.id);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.account.removeCard(user.id, id);
  }
}

/** /customer/wallet - FORKSY wallet/credits balance + ledger, and gift card redemption. */
@CustomerController('wallet')
export class CustomerWalletController {
  constructor(private account: CustomerAccountService) {}

  @Get()
  wallet(@CurrentUser() user: AuthUser, @Query('page') page?: string, @Query('limit') limit?: string) {
    return this.account.wallet(user.id, page ? +page : 1, limit ? +limit : 20);
  }

  @Post('redeem-gift-card')
  redeem(@CurrentUser() user: AuthUser, @Body('code') code: string) {
    return this.account.redeemGiftCard(user.id, code);
  }
}

/** /customer/referrals - referral code, share text, rewards, and invitee status. */
@CustomerController('referrals')
export class CustomerReferralsController {
  constructor(private account: CustomerAccountService) {}

  @Get()
  referrals(@CurrentUser() user: AuthUser) {
    return this.account.referrals(user.id);
  }
}

/** /customer/privacy - PIPEDA data access / deletion / correction / consent-withdrawal requests. */
@CustomerController('privacy')
export class CustomerPrivacyController {
  constructor(private account: CustomerAccountService) {}

  @Get('requests')
  myRequests(@CurrentUser() user: AuthUser) {
    return this.account.myDataRequests(user.id);
  }

  @Post('requests')
  createRequest(@CurrentUser() user: AuthUser, @Body() dto: DataRequestDto) {
    return this.account.requestData(user.id, dto.type, dto.notes);
  }

  @Get('requests/:id/export')
  exportRequest(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.account.myDataExport(user.id, id);
  }

  @Post('deletion')
  requestDeletion(@CurrentUser() user: AuthUser, @Body() dto: DeletionRequestDto) {
    return this.account.requestDeletion(user.id, dto.reason);
  }

  @Post('deletion/cancel')
  cancelDeletion(@CurrentUser() user: AuthUser) {
    return this.account.cancelDeletionRequest(user.id);
  }
}
