import { Body, Controller, ForbiddenException, Get, Headers, HttpCode, Param, Post, Query, Req, BadRequestException, ParseUUIDPipe } from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { IsEmail, IsInt, IsNumber, IsOptional, IsString, Matches, MaxLength, Max, Min } from 'class-validator';
import { AdminController, CurrentUser, CustomerController, DriverController, NoImpersonation, Permission, Public, RestaurantController, RestaurantRoles } from '../common/decorators';
import { Action, Module as Mod, PartyType, RestaurantRole } from '../common/enums';
import { AuthUser } from '../common/auth.types';
import { AuditService } from '../audit/audit.service';
import { StripeClientService } from '../integrations/stripe-client.service';
import { ConnectService } from './connect.service';
import { StripeWebhookService } from './stripe-webhook.service';
import { AbandonedIntentsService } from './abandoned-intents.service';
import { TopUpService } from './topup.service';
import { PartiesService } from '../finance/parties.service';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Order, Payment, StripeIntent } from '../database/entities';

// ------------------------------------------------------------------ webhook
/**
 * Stripe -> FORKY. Public (no JWT): authenticity is the Stripe signature over the RAW body (main.ts mounts express.raw for this path only).
 * Not throttled (Stripe retries / bursts must never be rejected) and the body is never parsed or sanitised before verification.
 */
@Controller('webhooks/stripe')
@Public()
@SkipThrottle({ default: true, write: true, global: true, ip: true })
export class StripeWebhookController {
  constructor(private stripeClient: StripeClientService, private svc: StripeWebhookService) {}

  @Post()
  @HttpCode(200)
  async receive(@Req() req: any, @Headers('stripe-signature') signature?: string) {
    const raw = req.body;
    if (!Buffer.isBuffer(raw)) throw new BadRequestException('Webhook payload must be the raw request body');
    if (!signature) throw new BadRequestException('Missing Stripe-Signature header');
    if (!this.stripeClient.config().webhookSecret) throw new BadRequestException('Webhook signing secret is not configured');
    let event: any;
    try {
      event = this.stripeClient.constructEvent(raw, signature, 300);
    } catch {
      throw new BadRequestException('Invalid signature'); // never says why (wrong secret / tampered body / replayed too late)
    }
    return this.svc.receive(event);
  }
}

// ------------------------------------------------------------------ admin: events
export class SweepDto {
  @IsOptional() @IsInt() @Min(0) @Max(1440) olderThanMinutes?: number;
}

@AdminController('integrations/stripe')
export class AdminStripeEventsController {
  constructor(private svc: StripeWebhookService, private audit: AuditService, private sweeper: AbandonedIntentsService) {}

  /** Cancel card holds that never became an order (the cron does this every 10 minutes; this button does it now). */
  @Post('sweep-intents')
  @Permission(Mod.SETTINGS, Action.EDIT)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async sweep(@Body() dto: SweepDto, @Req() req: any) {
    if (req.user?.type !== 'SUPER_ADMIN') throw new ForbiddenException('Only a Super Admin can run the clean-up');
    const r = await this.sweeper.sweep(dto.olderThanMinutes);
    await this.audit.logReq(req, 'integrations.stripe.sweep_intents', 'stripe_intent', undefined, undefined, r);
    return r;
  }

  @Get('events')
  @Permission(Mod.SETTINGS, Action.VIEW)
  list(@Query('status') status?: string, @Query('type') type?: string, @Query('limit') limit?: string) {
    return this.svc.list({ status, type, limit: Math.min(100, Math.max(1, Number(limit) || 25)) });
  }

  @Post('events/:id/replay')
  @Permission(Mod.SETTINGS, Action.EDIT)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async replay(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    if (req.user?.type !== 'SUPER_ADMIN') throw new ForbiddenException('Only a Super Admin can replay a Stripe event');
    const r = await this.svc.replay(id);
    await this.audit.logReq(req, 'integrations.stripe.event_replay', 'stripe_event', id, undefined, { status: r.status });
    return r;
  }
}

// ------------------------------------------------------------------ admin: payment records of an order
/** Gateway view of an order: the Stripe PaymentIntent, every authorise / capture / release / refund / tip / dispute row with its provider id. */
@AdminController('orders')
export class AdminOrderPaymentsController {
  constructor(
    @InjectRepository(Order) private orders: Repository<Order>,
    @InjectRepository(Payment) private payments: Repository<Payment>,
    @InjectRepository(StripeIntent) private intents: Repository<StripeIntent>,
    private stripeClient: StripeClientService,
  ) {}

  @Get(':id/payments')
  @Permission(Mod.FINANCE, Action.VIEW)
  async list(@Param('id', ParseUUIDPipe) id: string) {
    const order = await this.orders.findOne({ where: { id } });
    if (!order) throw new BadRequestException('Order not found');
    const rows = await this.payments.find({ where: { orderId: id }, order: { createdAt: 'ASC' } });
    const intent = order.paymentIntentId ? await this.intents.findOne({ where: { intentId: order.paymentIntentId } }) : null;
    const cfg = this.stripeClient.config();
    const real = !!order.paymentIntentId && !order.paymentIntentId.includes('_mock_');
    const dash = (path: string) => (real ? `https://dashboard.stripe.com/${cfg.mode === 'live' ? '' : 'test/'}${path}` : null);
    return {
      paymentIntentId: order.paymentIntentId,
      provider: real ? 'stripe' : order.paymentIntentId ? 'mock' : null,
      intent: intent ? { status: intent.status, amount: Number(intent.amount), currency: intent.currency, createdAt: intent.createdAt } : null,
      dashboardUrl: order.paymentIntentId ? dash(`payments/${order.paymentIntentId}`) : null,
      dispute: order.meta?.dispute ?? null,
      paymentAlert: order.meta?.paymentAlert ?? null,
      payments: rows.map((p) => ({ id: p.id, kind: p.kind, provider: p.provider, amount: Number(p.amount), currency: p.currency, status: p.status, externalId: p.externalId, createdAt: p.createdAt, meta: p.meta })),
    };
  }
}

// ------------------------------------------------------------------ customers: wallet top-up, gift cards
export class TopUpDto {
  @IsNumber({ allowNaN: false, allowInfinity: false }) @Min(1) @Max(5000) amount: number;
}
export class ConfirmIntentDto {
  @IsString() @Matches(/^pi_[A-Za-z0-9_]{6,100}$/, { message: 'paymentIntentId is not valid' }) paymentIntentId: string;
}
export class GiftCardPurchaseDto {
  @IsNumber({ allowNaN: false, allowInfinity: false }) @Min(1) @Max(5000) amount: number;
  @IsOptional() @IsEmail() @MaxLength(200) recipientEmail?: string;
  @IsOptional() @IsString() @MaxLength(300) message?: string;
}

/** /customer/wallet/top-up-intent + /top-up/confirm - adding money to the FORKY wallet is a Stripe payment. */
@CustomerController('wallet')
export class CustomerTopUpController {
  constructor(private svc: TopUpService) {}

  @Post('top-up-intent')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  create(@CurrentUser() user: AuthUser, @Body() dto: TopUpDto) {
    return this.svc.createTopUpIntent(user.id, dto.amount);
  }

  /** Credits the wallet once Stripe says the payment succeeded. Safe to call repeatedly (and the webhook does the same). */
  @Post('top-up/confirm')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  confirm(@CurrentUser() user: AuthUser, @Body() dto: ConfirmIntentDto) {
    return this.svc.confirm(user.id, dto.paymentIntentId);
  }
}

/** /customer/gift-cards - buying a gift card is a Stripe payment; the card is issued once it succeeded. */
@CustomerController('gift-cards')
export class CustomerGiftCardPurchaseController {
  constructor(private svc: TopUpService) {}

  @Post('purchase-intent')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  create(@CurrentUser() user: AuthUser, @Body() dto: GiftCardPurchaseDto) {
    return this.svc.createGiftCardIntent(user.id, dto);
  }

  @Post('purchase/confirm')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  confirm(@CurrentUser() user: AuthUser, @Body() dto: ConfirmIntentDto) {
    return this.svc.confirm(user.id, dto.paymentIntentId);
  }
}

// ------------------------------------------------------------------ Connect: drivers
/** /driver/payouts - the driver's Stripe payout account (identity + bank / debit card live at Stripe). */
@DriverController('payouts')
export class DriverPayoutAccountController {
  constructor(private connect: ConnectService) {}

  private driverId(u: AuthUser) {
    if (!u.driverId) throw new ForbiddenException('No driver profile on this account');
    return u.driverId;
  }

  @Post('onboarding')
  @NoImpersonation()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  onboarding(@CurrentUser() u: AuthUser) {
    return this.connect.onboardingLink(PartyType.DRIVER, this.driverId(u), 'driver');
  }

  @Get('account')
  account(@CurrentUser() u: AuthUser, @Query('refresh') refresh?: string) {
    return this.connect.view(PartyType.DRIVER, this.driverId(u), { sync: refresh === 'true' || refresh === '1' });
  }

  @Post('dashboard-link')
  @NoImpersonation()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  dashboard(@CurrentUser() u: AuthUser) {
    return this.connect.dashboardLink(PartyType.DRIVER, this.driverId(u));
  }
}

// ------------------------------------------------------------------ Connect: restaurants (owner only)
@RestaurantController('payouts')
@RestaurantRoles(RestaurantRole.OWNER)
export class RestaurantPayoutAccountController {
  constructor(private connect: ConnectService) {}

  private merchantId(u: AuthUser) {
    if (!u.merchantId) throw new ForbiddenException('No merchant on this account');
    return u.merchantId;
  }

  @Post('onboarding')
  @NoImpersonation()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  onboarding(@CurrentUser() u: AuthUser) {
    return this.connect.onboardingLink(PartyType.RESTAURANT, this.merchantId(u), 'restaurant');
  }

  @Get('account')
  account(@CurrentUser() u: AuthUser, @Query('refresh') refresh?: string) {
    return this.connect.view(PartyType.RESTAURANT, this.merchantId(u), { sync: refresh === 'true' || refresh === '1' });
  }

  @Post('dashboard-link')
  @NoImpersonation()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  dashboard(@CurrentUser() u: AuthUser) {
    return this.connect.dashboardLink(PartyType.RESTAURANT, this.merchantId(u));
  }
}

// ------------------------------------------------------------------ Connect: admin
/** Finance > payout accounts: who can be paid, "Payout accounts" filter, manual sync from Stripe. */
@AdminController('finance/payout-accounts')
export class AdminPayoutAccountsController {
  constructor(private connect: ConnectService, private audit: AuditService, private parties: PartiesService) {}

  @Get()
  @Permission(Mod.FINANCE, Action.VIEW)
  list(@Query('partyType') partyType?: string, @Query('status') status?: string, @Query('search') search?: string, @Query('page') page?: string, @Query('limit') limit?: string) {
    return this.connect.list({ partyType, status, search, page: Number(page), limit: Number(limit) });
  }

  @Get(':partyType/:partyId')
  @Permission(Mod.FINANCE, Action.VIEW)
  one(@Param('partyType') partyType: string, @Param('partyId', ParseUUIDPipe) partyId: string) {
    return this.connect.view(this.type(partyType), partyId);
  }

  @Post('sync')
  @Permission(Mod.FINANCE, Action.EDIT)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async syncAll(@Req() req: any) {
    const r = await this.connect.syncAll();
    await this.audit.logReq(req, 'finance.payout_accounts.sync_all', 'payout_account', undefined, undefined, r);
    return r;
  }

  @Post(':partyType/:partyId/sync')
  @Permission(Mod.FINANCE, Action.EDIT)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async sync(@Param('partyType') partyType: string, @Param('partyId', ParseUUIDPipe) partyId: string, @Req() req: any) {
    const v = await this.connect.syncFromStripe(this.type(partyType), partyId);
    await this.audit.logReq(req, 'finance.payout_account.sync', 'payout_account', partyId, undefined, { status: v.status });
    return v;
  }

  private type(t: string): PartyType {
    const u = String(t).toUpperCase();
    if (u === 'DRIVER') return PartyType.DRIVER;
    if (u === 'RESTAURANT' || u === 'MERCHANT') return PartyType.RESTAURANT;
    throw new BadRequestException('partyType must be DRIVER or RESTAURANT');
  }
}
