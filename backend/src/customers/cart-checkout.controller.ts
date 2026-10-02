import { Body, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CustomerController, CurrentUser } from '../common/decorators';
import { AuthUser } from '../common/auth.types';
import { CartService } from './cart.service';
import { CheckoutService } from './checkout.service';
import { AddCartItemDto, CheckoutQuoteDto, ReplaceCartDto, SetPromoDto, UpdateCartItemDto } from './dto';

/** /customer/cart - single-restaurant cart with server-side availability validation (spec §6). */
@CustomerController('cart')
export class CustomerCartController {
  constructor(private cart: CartService) {}

  @Get()
  view(@CurrentUser() user: AuthUser) {
    return this.cart.view(user.id);
  }

  @Post('replace')
  replace(@CurrentUser() user: AuthUser, @Body() dto: ReplaceCartDto) {
    return this.cart.replace(user.id, dto);
  }

  @Post('items')
  addItem(@CurrentUser() user: AuthUser, @Body() dto: AddCartItemDto) {
    return this.cart.addItem(user.id, dto);
  }

  @Patch('items/:lineId')
  updateItem(@CurrentUser() user: AuthUser, @Param('lineId') lineId: string, @Body() dto: UpdateCartItemDto) {
    return this.cart.updateItem(user.id, lineId, dto);
  }

  @Delete('items/:lineId')
  removeItem(@CurrentUser() user: AuthUser, @Param('lineId') lineId: string) {
    return this.cart.removeItem(user.id, lineId);
  }

  @Post('promo')
  @Throttle({ default: { limit: 15, ttl: 60_000 } }) // promo code guessing
  setPromo(@CurrentUser() user: AuthUser, @Body() dto: SetPromoDto) {
    return this.cart.setPromo(user.id, dto.code ?? null);
  }

  @Delete()
  clear(@CurrentUser() user: AuthUser) {
    return this.cart.clear(user.id);
  }
}

/** /customer/checkout/quote - priced preview of the current cart (calls the @Global PricingService). */
@CustomerController('checkout')
export class CustomerCheckoutController {
  constructor(private checkout: CheckoutService) {}

  @Post('quote')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  quote(@CurrentUser() user: AuthUser, @Body() dto: CheckoutQuoteDto) {
    return this.checkout.quote(user.id, dto);
  }
}
