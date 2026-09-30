import { Body, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { CustomerController, CurrentUser } from '../common/decorators';
import { AuthUser } from '../common/auth.types';
import { PageQueryDto } from '../common/pagination';
import { CheckoutService } from './checkout.service';
import { CustomerOrdersQuery, ItemRemovalResponseDto, PlaceOrderDto, ReviewDto, TipDto } from './dto';

/**
 * /customer/orders - place / list / detail / cancel / reorder / tip-edit / review.
 * Live tracking + chat are shared across all four apps: GET/POST /orders/:id/tracking|messages (src/orders/orders.controller.ts).
 * All lifecycle logic lives in OrdersService/PricingService (@Global, OrdersModule) - this controller only builds
 * their inputs from the customer's cart/addresses and scopes reads to the calling customer.
 */
@CustomerController('orders')
export class CustomerOrdersController {
  constructor(private checkout: CheckoutService) {}

  @Post()
  place(@CurrentUser() user: AuthUser, @Body() dto: PlaceOrderDto) {
    return this.checkout.placeOrder(user.id, dto);
  }

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() q: CustomerOrdersQuery) {
    return this.checkout.list(user.id, q as PageQueryDto & { status?: string });
  }

  @Get(':id')
  detail(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.checkout.detail(user.id, id);
  }

  @Post(':id/cancel')
  cancel(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body('reason') reason: string) {
    return this.checkout.cancel(user.id, id, reason);
  }

  @Post(':id/reorder')
  reorder(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.checkout.reorder(user.id, id);
  }

  @Patch(':id/tip')
  tip(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: TipDto) {
    return this.checkout.updateTip(user.id, id, dto.tip);
  }

  @Post(':id/item-removal-response')
  itemRemovalResponse(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: ItemRemovalResponseDto) {
    return this.checkout.respondToItemRemoval(user.id, id, dto.approve);
  }

  @Post(':id/review')
  review(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: ReviewDto) {
    return this.checkout.review(user.id, id, dto);
  }
}
