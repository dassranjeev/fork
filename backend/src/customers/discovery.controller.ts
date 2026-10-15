import { Body, Get, Injectable, Param, Post, Query, Req } from '@nestjs/common';
import { ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { clampPaging } from '../common/pagination';
import { clientIp } from '../common/security';
import { CustomerController, CurrentUser, PublicController } from '../common/decorators';
import { AuthUser } from '../common/auth.types';
import { CustomerAccountService } from './customer-account.service';
import { DiscoveryService } from './discovery.service';
import { GuestSessionDto } from './dto';

const num = (v?: string) => (v === undefined || v === '' ? undefined : Number(v));

const HOME_DOC = 'storeType: one or more of RESTAURANT, CAFE, BAKERY, GROCERY, CONVENIENCE, SPECIALTY (comma separated); vertical: FOOD or RETAIL';

/** Home feed: nearby / popular / new / deals / fastest, cuisine tiles, store type tiles, banners (spec §6). Logged-in: personalised (favorites). `storeType` / `vertical` narrow it to groceries, restaurants... */
@CustomerController('home')
export class CustomerHomeController {
  constructor(private discovery: DiscoveryService) {}

  @Get()
  @ApiOperation({ summary: 'Home feed', description: HOME_DOC })
  home(@CurrentUser() user: AuthUser, @Query('lat') lat?: string, @Query('lng') lng?: string, @Query('storeType') storeType?: string, @Query('vertical') vertical?: string) {
    return this.discovery.home(num(lat), num(lng), user.id, { storeType, vertical });
  }
}

/** Search: stores / dishes / products / cuisines with filters (price/rating/fee/ETA/dietary/pickup-only, storeType / vertical, barcode). */
@CustomerController('search')
export class CustomerSearchController {
  constructor(private discovery: DiscoveryService) {}

  @Get()
  search(@CurrentUser() user: AuthUser, @Query() q: Record<string, string>) {
    return this.discovery.search(q, user.id);
  }
}

/** The kinds of store on the platform with how many are around the customer. */
@CustomerController('store-types')
export class CustomerStoreTypesController {
  constructor(private discovery: DiscoveryService) {}

  @Get()
  list(@Query('lat') lat?: string, @Query('lng') lng?: string) {
    return this.discovery.storeTypes(num(lat), num(lng));
  }
}

/** Store pages for signed-in customers: the page (menu or catalog summary), paged catalog, one product, reviews, schedule slots. */
// @Injectable(): makes TypeScript emit the constructor parameter types, which the concrete controllers inherit for dependency injection
@Injectable()
abstract class CustomerStoreRoutes {
  constructor(protected discovery: DiscoveryService) {}

  @Get()
  @ApiOperation({ summary: 'Browse stores (same filters as search: storeType, vertical, cuisine, openNow, sort...)' })
  list(@CurrentUser() user: AuthUser, @Query() q: Record<string, string>) {
    return this.discovery.stores(q, user.id);
  }

  @Get(':slug')
  @ApiOperation({ summary: 'Store page', description: 'menu=full returns every product (a grocery store otherwise returns a summary: perCategory products per department, default 8); menu=summary asks a restaurant for a summary too' })
  page(@CurrentUser() user: AuthUser, @Param('slug') slug: string, @Query('lat') lat?: string, @Query('lng') lng?: string, @Query('menu') menu?: string, @Query('perCategory') perCategory?: string) {
    return this.discovery.restaurantPage(slug, num(lat), num(lng), user.id, { menu, perCategory });
  }

  @Get(':slug/catalog')
  @ApiOperation({ summary: 'Paged catalog of one store (categoryId, q, dietary, inStock, restricted, sort, page, limit)' })
  catalog(@CurrentUser() user: AuthUser, @Param('slug') slug: string, @Query() q: Record<string, string>) {
    return this.discovery.catalog(slug, q, user.id);
  }

  @Get(':slug/products/:itemId')
  product(@CurrentUser() user: AuthUser, @Param('slug') slug: string, @Param('itemId') itemId: string) {
    return this.discovery.product(slug, itemId, user.id);
  }

  @Get(':slug/reviews')
  reviews(@Param('slug') slug: string, @Query('page') page?: string, @Query('limit') limit?: string) {
    const pg = clampPaging(page, limit, 50);
    return this.discovery.reviewsPage(slug, pg.page, pg.limit);
  }

  @Get(':slug/slots')
  slots(@Param('slug') slug: string, @Query('date') date: string) {
    return this.discovery.slots(slug, date);
  }
}

/** Restaurant page: menu, availability/status/next-opening, hours, schedule slots, recent reviews. */
@CustomerController('restaurants')
export class CustomerRestaurantsController extends CustomerStoreRoutes {}

/** Same routes under /stores: restaurants, cafes, bakeries, groceries, convenience and specialty stores are all stores. */
@CustomerController('stores')
export class CustomerStoresController extends CustomerStoreRoutes {}

/** Same discovery surface, unauthenticated, for the public website / guest browsing before sign-in. */
@PublicController('home')
export class PublicHomeController {
  constructor(private discovery: DiscoveryService) {}

  @Get()
  @ApiOperation({ summary: 'Home feed', description: HOME_DOC })
  home(@Query('lat') lat?: string, @Query('lng') lng?: string, @Query('storeType') storeType?: string, @Query('vertical') vertical?: string) {
    return this.discovery.home(num(lat), num(lng), undefined, { storeType, vertical });
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

@PublicController('store-types')
export class PublicStoreTypesController {
  constructor(private discovery: DiscoveryService) {}

  @Get()
  @ApiOperation({ summary: 'Kinds of store with how many are around the customer (tiles: Restaurants, Grocery, Convenience...)' })
  list(@Query('lat') lat?: string, @Query('lng') lng?: string) {
    return this.discovery.storeTypes(num(lat), num(lng));
  }
}

@Injectable()
abstract class PublicStoreRoutes {
  constructor(protected discovery: DiscoveryService) {}

  @Get()
  @ApiOperation({ summary: 'Browse stores (same filters as search: storeType, vertical, cuisine, openNow, sort...)' })
  list(@Query() q: Record<string, string>) {
    return this.discovery.stores(q);
  }

  @Get(':slug')
  @ApiOperation({ summary: 'Store page', description: 'menu=full returns every product (a grocery store otherwise returns a summary: perCategory products per department, default 8); menu=summary asks a restaurant for a summary too' })
  page(@Param('slug') slug: string, @Query('lat') lat?: string, @Query('lng') lng?: string, @Query('menu') menu?: string, @Query('perCategory') perCategory?: string) {
    return this.discovery.restaurantPage(slug, num(lat), num(lng), undefined, { menu, perCategory });
  }

  @Get(':slug/catalog')
  @ApiOperation({ summary: 'Paged catalog of one store (categoryId, q, dietary, inStock, restricted, sort, page, limit)' })
  catalog(@Param('slug') slug: string, @Query() q: Record<string, string>) {
    return this.discovery.catalog(slug, q);
  }

  @Get(':slug/products/:itemId')
  product(@Param('slug') slug: string, @Param('itemId') itemId: string) {
    return this.discovery.product(slug, itemId);
  }

  @Get(':slug/reviews')
  reviews(@Param('slug') slug: string, @Query('page') page?: string, @Query('limit') limit?: string) {
    const pg = clampPaging(page, limit, 50);
    return this.discovery.reviewsPage(slug, pg.page, pg.limit);
  }

  @Get(':slug/slots')
  slots(@Param('slug') slug: string, @Query('date') date: string) {
    return this.discovery.slots(slug, date);
  }
}

@PublicController('restaurants')
export class PublicRestaurantsController extends PublicStoreRoutes {}

/** Same routes under /stores. */
@PublicController('stores')
export class PublicStoresController extends PublicStoreRoutes {}

/** POST /public/guest/session - passwordless CUSTOMER token for web guest checkout (spec §6). */
@PublicController('guest')
export class PublicGuestController {
  constructor(private account: CustomerAccountService) {}

  @Post('session')
  @Throttle({ default: { limit: 10, ttl: 60_000 } }) // creates an account row: strictly limited per IP
  session(@Body() dto: GuestSessionDto, @Req() req: any) {
    return this.account.guestSession(dto, {
      ip: clientIp(req),
      userAgent: req.headers['user-agent'] as string,
    });
  }
}
