import { Body, Get, Param, Post, Query, Req } from '@nestjs/common';
import { CustomerController, CurrentUser, PublicController } from '../common/decorators';
import { AuthUser } from '../common/auth.types';
import { CustomerAccountService } from './customer-account.service';
import { DiscoveryService } from './discovery.service';
import { GuestSessionDto } from './dto';

const num = (v?: string) => (v === undefined || v === '' ? undefined : Number(v));

/** Home feed: nearby / popular / new / deals / fastest, cuisine tiles, banners (spec §6). Logged-in: personalised (favorites). */
@CustomerController('home')
export class CustomerHomeController {
  constructor(private discovery: DiscoveryService) {}

  @Get()
  home(@CurrentUser() user: AuthUser, @Query('lat') lat?: string, @Query('lng') lng?: string) {
    return this.discovery.home(num(lat), num(lng), user.id);
  }
}

/** Search: restaurants/dishes/cuisines with filters (price/rating/fee/ETA/dietary/pickup-only). */
@CustomerController('search')
export class CustomerSearchController {
  constructor(private discovery: DiscoveryService) {}

  @Get()
  search(@CurrentUser() user: AuthUser, @Query() q: Record<string, string>) {
    return this.discovery.search(q, user.id);
  }
}

/** Restaurant page: menu, availability/status/next-opening, hours, schedule slots, recent reviews. */
@CustomerController('restaurants')
export class CustomerRestaurantsController {
  constructor(private discovery: DiscoveryService) {}

  @Get(':slug')
  page(@CurrentUser() user: AuthUser, @Param('slug') slug: string, @Query('lat') lat?: string, @Query('lng') lng?: string) {
    return this.discovery.restaurantPage(slug, num(lat), num(lng), user.id);
  }

  @Get(':slug/reviews')
  reviews(@Param('slug') slug: string, @Query('page') page?: string, @Query('limit') limit?: string) {
    return this.discovery.reviewsPage(slug, page ? +page : 1, limit ? +limit : 20);
  }

  @Get(':slug/slots')
  slots(@Param('slug') slug: string, @Query('date') date: string) {
    return this.discovery.slots(slug, date);
  }
}

/** Same discovery surface, unauthenticated, for the public website / guest browsing before sign-in. */
@PublicController('home')
export class PublicHomeController {
  constructor(private discovery: DiscoveryService) {}

  @Get()
  home(@Query('lat') lat?: string, @Query('lng') lng?: string) {
    return this.discovery.home(num(lat), num(lng));
  }
}

@PublicController('search')
export class PublicSearchController {
  constructor(private discovery: DiscoveryService) {}

  @Get()
  search(@Query() q: Record<string, string>) {
    return this.discovery.search(q);
  }
}

@PublicController('restaurants')
export class PublicRestaurantsController {
  constructor(private discovery: DiscoveryService) {}

  @Get(':slug')
  page(@Param('slug') slug: string, @Query('lat') lat?: string, @Query('lng') lng?: string) {
    return this.discovery.restaurantPage(slug, num(lat), num(lng));
  }

  @Get(':slug/reviews')
  reviews(@Param('slug') slug: string, @Query('page') page?: string, @Query('limit') limit?: string) {
    return this.discovery.reviewsPage(slug, page ? +page : 1, limit ? +limit : 20);
  }

  @Get(':slug/slots')
  slots(@Param('slug') slug: string, @Query('date') date: string) {
    return this.discovery.slots(slug, date);
  }
}

/** POST /public/guest/session - passwordless CUSTOMER token for web guest checkout (spec §6). */
@PublicController('guest')
export class PublicGuestController {
  constructor(private account: CustomerAccountService) {}

  @Post('session')
  session(@Body() dto: GuestSessionDto, @Req() req: any) {
    return this.account.guestSession(dto, {
      ip: (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip,
      userAgent: req.headers['user-agent'] as string,
    });
  }
}
