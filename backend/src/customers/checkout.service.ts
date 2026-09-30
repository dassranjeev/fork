import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';
import { Address, Order, Review } from '../database/entities';
import { ActorType, OrderStatus, OrderType } from '../common/enums';
import { Events, PlaceOrderInput, QuoteInput } from '../common/contracts';
import { PageQueryDto, paginateQb } from '../common/pagination';
import { CartService } from './cart.service';
import { ExternalServices } from './lazy';
import { CheckoutQuoteDto, PlaceOrderDto, ReviewDto } from './dto';

/**
 * Glue between the customer app and the shared order-lifecycle services (OrdersService / PricingService).
 * No order/pricing logic lives here - only building their inputs from the customer's cart & saved addresses,
 * and scoping reads/writes to the calling customer.
 */
@Injectable()
export class CheckoutService {
  constructor(
    @InjectDataSource() private ds: DataSource,
    private cart: CartService,
    private ext: ExternalServices,
    private emitter: EventEmitter2,
  ) {}

  private orders() {
    return this.ds.getRepository(Order);
  }

  // ------------------------------------------------------------------ checkout
  private async resolveDeliveryAddress(customerId: string, dto: { addressId?: string; lat?: number; lng?: number }) {
    if (dto.addressId) {
      const a = await this.ds.getRepository(Address).findOne({ where: { id: dto.addressId, customerId } });
      if (!a) throw new NotFoundException('Address not found');
      if (a.lat == null || a.lng == null) throw new BadRequestException('This address has no coordinates - please edit it');
      return { lat: a.lat, lng: a.lng, line1: a.line1, line2: a.line2 ?? undefined, city: a.city, province: a.province, postalCode: a.postalCode, dropoffNotes: a.dropoffNotes ?? undefined, label: a.label };
    }
    if (dto.lat != null && dto.lng != null) return { lat: dto.lat, lng: dto.lng };
    return undefined;
  }

  private async buildQuoteInput(customerId: string, dto: CheckoutQuoteDto): Promise<QuoteInput> {
    const cart = await this.cart.getOrCreate(customerId);
    if (!cart.restaurantId || !cart.items.length) throw new BadRequestException('Your cart is empty');
    const deliveryAddress = dto.type === OrderType.PICKUP ? undefined : await this.resolveDeliveryAddress(customerId, dto);
    if (dto.type !== OrderType.PICKUP && !deliveryAddress) throw new BadRequestException('A delivery address is required');
    return {
      customerId,
      restaurantId: cart.restaurantId,
      type: dto.type,
      fulfilment: dto.fulfilment,
      items: cart.items.map((i) => ({ menuItemId: i.menuItemId, quantity: i.quantity, modifierOptionIds: i.modifierOptionIds, notes: i.notes })),
      deliveryAddress,
      promoCode: dto.promoCode ?? cart.promoCode ?? undefined,
      tip: dto.tip,
      useWallet: dto.useWallet,
      scheduledFor: dto.scheduledFor ? new Date(dto.scheduledFor) : null,
    };
  }

  async quote(customerId: string, dto: CheckoutQuoteDto) {
    const input = await this.buildQuoteInput(customerId, dto);
    return this.ext.pricing.quote(input);
  }

  async placeOrder(customerId: string, dto: PlaceOrderDto) {
    const input = (await this.buildQuoteInput(customerId, dto)) as PlaceOrderInput;
    input.paymentMethod = dto.paymentMethod;
    input.paymentToken = dto.paymentToken;
    input.contactless = dto.contactless;
    input.customerNotes = dto.customerNotes;
    input.source = 'app';
    if (dto.addressId) input.addressId = dto.addressId;

    // Redeem the gift card into the wallet up front so PricingService applies it via useWallet.
    if (dto.giftCardCode) {
      await this.ext.giftCards.redeem(customerId, dto.giftCardCode.trim().toUpperCase());
      input.useWallet = true;
    }

    const order = await this.ext.orders.placeOrder(customerId, input);
    await this.cart.clear(customerId);
    return order;
  }

  // ------------------------------------------------------------------ reads
  async list(customerId: string, q: PageQueryDto & { status?: string }) {
    const qb = this.orders().createQueryBuilder('o').where('o.customerId = :customerId', { customerId });
    if (q.status) qb.andWhere('o.status = :status', { status: q.status });
    return paginateQb(qb, q, { sortable: { createdAt: 'o.createdAt', total: 'o.total' }, defaultSort: ['o.createdAt', 'DESC'] });
  }

  async detail(customerId: string, id: string): Promise<Order> {
    const order = await this.orders().findOne({ where: { id, customerId }, relations: { items: true } });
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  // ------------------------------------------------------------------ actions (delegate to OrdersService)
  async cancel(customerId: string, id: string, reason: string) {
    await this.detail(customerId, id); // ownership + existence
    return this.ext.orders.cancel(id, { type: ActorType.CUSTOMER, id: customerId }, reason);
  }

  updateTip(customerId: string, id: string, tip: number) {
    return this.ext.orders.updateTip(id, customerId, tip);
  }

  respondToItemRemoval(customerId: string, id: string, approve: boolean) {
    return this.ext.orders.respondToItemRemoval(id, customerId, approve);
  }

  /** Best-effort: re-adds every non-removed line to the cart, skipping items that vanished or went unavailable. */
  async reorder(customerId: string, id: string) {
    const order = await this.detail(customerId, id);
    await this.cart.clear(customerId);
    const skipped: { name: string; reason: string }[] = [];
    let first = true;
    for (const item of order.items.filter((i) => !i.removed && i.menuItemId)) {
      try {
        await this.cart.addItem(customerId, {
          menuItemId: item.menuItemId!,
          quantity: item.quantity,
          modifierOptionIds: (item.modifiers ?? []).map((m) => m.optionId),
          notes: item.notes ?? undefined,
          replaceCart: first,
        });
      } catch (e: any) {
        skipped.push({ name: item.name, reason: e?.message ?? 'No longer available' });
      }
      first = false;
    }
    return { cart: await this.cart.view(customerId), skipped };
  }

  // ------------------------------------------------------------------ reviews (spec §6, Events.REVIEW_CREATED)
  async review(customerId: string, id: string, dto: ReviewDto) {
    const order = await this.detail(customerId, id);
    if (![OrderStatus.DELIVERED, OrderStatus.COLLECTED].includes(order.status)) throw new BadRequestException('You can only review a completed order');
    if (dto.restaurantRating === undefined && dto.driverRating === undefined) throw new BadRequestException('Provide at least a restaurant or driver rating');
    const repo = this.ds.getRepository(Review);
    const existing = await repo.findOne({ where: { orderId: id } });
    const saved = await repo.save(
      repo.create({
        id: existing?.id,
        orderId: id,
        customerId,
        restaurantId: order.restaurantId,
        driverId: order.driverId,
        restaurantRating: dto.restaurantRating ?? existing?.restaurantRating ?? null,
        driverRating: dto.driverRating ?? existing?.driverRating ?? null,
        restaurantTags: dto.restaurantTags ?? existing?.restaurantTags ?? [],
        driverTags: dto.driverTags ?? existing?.driverTags ?? [],
        comment: dto.comment ?? existing?.comment ?? null,
        driverComment: dto.driverComment ?? existing?.driverComment ?? null,
      }),
    );
    this.emitter.emit(Events.REVIEW_CREATED, {
      reviewId: saved.id,
      orderId: id,
      restaurantId: order.restaurantId,
      driverId: order.driverId,
      restaurantRating: saved.restaurantRating,
      driverRating: saved.driverRating,
    });
    return saved;
  }
}
