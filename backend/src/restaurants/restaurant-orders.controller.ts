import { Body, Get, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CurrentUser, RestaurantController } from '../common/decorators';
import { FulfilmentMode, OrderStatus } from '../common/enums';
import { AuthUser } from '../common/auth.types';
import { Order, OrderEvent } from '../database/entities';
import { like, paginateQb } from '../common/pagination';
import { OrdersService } from '../orders/orders.service';
import { resolveRestaurantId, restaurantActor } from './restaurants.util';
import { AcceptOrderDto, ExtendPrepDto, HandoffDto, OrdersQuery, RejectOrderDto, RemoveItemDto } from './dto';

const OPEN_STATUSES = [OrderStatus.PLACED, OrderStatus.ACCEPTED, OrderStatus.DRIVER_ASSIGNED, OrderStatus.PREPARING, OrderStatus.READY, OrderStatus.PICKED_UP, OrderStatus.ON_THE_WAY];

/** Restaurant portal live orders: accept (prep +5/+10/+15), reject, ready, handoff by code, partial fulfilment (spec §4.5). */
@RestaurantController('orders')
export class RestaurantOrdersController {
  constructor(
    @InjectRepository(Order) private orders: Repository<Order>,
    @InjectRepository(OrderEvent) private events: Repository<OrderEvent>,
    private ordersService: OrdersService,
  ) {}

  private rid(user: AuthUser, restaurantId?: string) {
    return resolveRestaurantId(user, restaurantId);
  }

  private async orderFor(restaurantId: string, orderId: string): Promise<Order> {
    const order = await this.orders.findOne({ where: { id: orderId, restaurantId }, relations: ['items'] });
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() q: OrdersQuery, @Query('restaurantId') restaurantId?: string) {
    const rid = this.rid(user, restaurantId);
    const qb = this.orders.createQueryBuilder('o').where('o.restaurantId = :rid', { rid });
    if (q.search) qb.andWhere('o.code ILIKE :s', { s: like(q.search) });
    if (q.status) qb.andWhere('o.status = :status', { status: q.status });
    else if (!q.from && !q.to) qb.andWhere('o.status IN (:...open)', { open: OPEN_STATUSES });
    if (q.type) qb.andWhere('o.fulfilment = :type', { type: q.type });
    if (q.from) qb.andWhere('o.createdAt >= :from', { from: q.from });
    if (q.to) qb.andWhere('o.createdAt <= :to', { to: q.to });
    return paginateQb(qb, q, { sortable: { createdAt: 'o.createdAt', total: 'o.total', status: 'o.status' }, defaultSort: ['o.createdAt', 'ASC'] });
  }

  @Get(':id')
  async detail(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query('restaurantId') restaurantId?: string) {
    const order = await this.orderFor(this.rid(user, restaurantId), id);
    const timeline = await this.events.find({ where: { orderId: id }, order: { createdAt: 'ASC' } });
    return { order, timeline };
  }

  @Post(':id/accept')
  async accept(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: AcceptOrderDto, @Query('restaurantId') restaurantId?: string) {
    const rid = this.rid(user, restaurantId);
    const order = await this.orderFor(rid, id);
    const prepTimeMin = dto.prepTimeMin ?? (order.prepTimeMin ?? 20) + (dto.addMinutes ?? 0);
    return this.ordersService.transition(id, OrderStatus.ACCEPTED, restaurantActor(user), { prepTimeMin });
  }

  @Post(':id/reject')
  async reject(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: RejectOrderDto, @Query('restaurantId') restaurantId?: string) {
    await this.orderFor(this.rid(user, restaurantId), id);
    const reason = dto.note ? `${dto.reason}: ${dto.note}` : dto.reason;
    return this.ordersService.transition(id, OrderStatus.REJECTED, restaurantActor(user), { reason });
  }

  @Post(':id/ready')
  async ready(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query('restaurantId') restaurantId?: string) {
    await this.orderFor(this.rid(user, restaurantId), id);
    return this.ordersService.transition(id, OrderStatus.READY, restaurantActor(user));
  }

  @Post(':id/handoff')
  async handoff(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: HandoffDto, @Query('restaurantId') restaurantId?: string) {
    const order = await this.orderFor(this.rid(user, restaurantId), id);
    const to = order.fulfilment === FulfilmentMode.PICKUP ? OrderStatus.COLLECTED : OrderStatus.PICKED_UP;
    return this.ordersService.transition(id, to, restaurantActor(user), { code: dto.code });
  }

  @Post(':id/items/:itemId/remove')
  async removeItem(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() dto: RemoveItemDto,
    @Query('restaurantId') restaurantId?: string,
  ) {
    await this.orderFor(this.rid(user, restaurantId), id);
    return this.ordersService.removeItem(id, itemId, restaurantActor(user), dto.reason ?? 'Item unavailable');
  }

  @Post(':id/extend-prep')
  async extendPrep(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: ExtendPrepDto, @Query('restaurantId') restaurantId?: string) {
    const order = await this.orderFor(this.rid(user, restaurantId), id);
    const addMs = dto.addMinutes * 60_000;
    const readyAt = order.estimatedReadyAt ? new Date(order.estimatedReadyAt.getTime() + addMs) : new Date(Date.now() + addMs);
    const deliveryAt = order.estimatedDeliveryAt ? new Date(order.estimatedDeliveryAt.getTime() + addMs) : undefined;
    await this.ordersService.setEta(id, readyAt, deliveryAt);
    return this.orderFor(this.rid(user, restaurantId), id);
  }
}
