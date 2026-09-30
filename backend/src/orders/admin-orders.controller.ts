import { Body, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AdminController, CurrentUser, Permission } from '../common/decorators';
import { Action, Module, OrderStatus, RefundChargedTo } from '../common/enums';
import { AuthUser } from '../common/auth.types';
import { Order, OrderEvent } from '../database/entities';
import { PageQueryDto, like, paginateQb } from '../common/pagination';
import { AuditService } from '../audit/audit.service';
import { OrdersService } from './orders.service';
import { RefundsService } from './refunds.service';
import { actorFor } from './orders.controller';

/** SOP: Admin order desk - search/filter/detail/timeline/edit/cancel/refund/reassign/force-status/export (spec §7, §9). */
@AdminController('orders')
export class AdminOrdersController {
  constructor(
    @InjectRepository(Order) private orders: Repository<Order>,
    @InjectRepository(OrderEvent) private events: Repository<OrderEvent>,
    private ordersService: OrdersService,
    private refunds: RefundsService,
    private audit: AuditService,
  ) {}

  @Get()
  @Permission(Module.ORDERS, Action.VIEW)
  async list(@Query() q: PageQueryDto, @Query('status') status?: OrderStatus, @Query('restaurantId') restaurantId?: string, @Query('cityId') cityId?: string, @Query('isLate') isLate?: string) {
    const qb = this.orders.createQueryBuilder('o');
    if (q.search) qb.andWhere('(o.code ILIKE :s)', { s: like(q.search) });
    if (status) qb.andWhere('o.status = :status', { status });
    if (restaurantId) qb.andWhere('o.restaurantId = :restaurantId', { restaurantId });
    if (cityId) qb.andWhere('o.cityId = :cityId', { cityId });
    if (isLate !== undefined) qb.andWhere('o.isLate = :isLate', { isLate: isLate === 'true' });
    return paginateQb(qb, q, { sortable: { createdAt: 'o.createdAt', total: 'o.total', status: 'o.status' }, defaultSort: ['o.createdAt', 'DESC'] });
  }

  @Get(':id')
  @Permission(Module.ORDERS, Action.VIEW)
  async detail(@Param('id') id: string) {
    const order = await this.ordersService.getById(id, ['items']);
    const timeline = await this.events.find({ where: { orderId: id }, order: { createdAt: 'ASC' } });
    return { order, timeline };
  }

  @Patch(':id/status')
  @Permission(Module.ORDERS, Action.EDIT)
  async forceStatus(@Param('id') id: string, @CurrentUser() user: AuthUser, @Body('status') status: OrderStatus, @Body('reason') reason?: string) {
    const before = await this.ordersService.getById(id);
    const order = await this.ordersService.transition(id, status, { ...actorFor(user), supportApproved: true }, { reason, force: true, note: 'Forced by staff' });
    await this.audit.log({ actor: user, action: 'order.force_status', entity: 'Order', entityId: id, before: { status: before.status }, after: { status } });
    return order;
  }

  @Post(':id/cancel')
  @Permission(Module.ORDERS, Action.EDIT)
  async cancel(@Param('id') id: string, @CurrentUser() user: AuthUser, @Body('reason') reason: string) {
    const order = await this.ordersService.cancel(id, { ...actorFor(user), supportApproved: true }, reason);
    await this.audit.log({ actor: user, action: 'order.cancel', entity: 'Order', entityId: id, after: { reason } });
    return order;
  }

  @Post(':id/refund')
  @Permission(Module.ORDERS, Action.APPROVE)
  async refund(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Body('amount') amount: number,
    @Body('chargedTo') chargedTo: RefundChargedTo,
    @Body('reasonCode') reasonCode: string,
    @Body('notes') notes?: string,
  ) {
    const refund = await this.refunds.issue({ orderId: id, amount, chargedTo, reasonCode, notes, actor: { ...actorFor(user), refundLimit: user.roleName === 'SUPER_ADMIN' ? null : user.refundLimit } });
    await this.audit.log({ actor: user, action: 'order.refund', entity: 'Order', entityId: id, after: { amount, chargedTo, reasonCode } });
    return refund;
  }

  @Post(':id/reassign-driver')
  @Permission(Module.ORDERS, Action.EDIT)
  async reassignDriver(@Param('id') id: string, @CurrentUser() user: AuthUser, @Body('driverId') driverId: string, @Body('reason') reason?: string) {
    await this.ordersService.unassignDriver(id, { ...actorFor(user), supportApproved: true }, reason ?? 'Reassigned by staff');
    const order = await this.ordersService.assignDriver(id, driverId, { ...actorFor(user), supportApproved: true });
    await this.audit.log({ actor: user, action: 'order.reassign_driver', entity: 'Order', entityId: id, after: { driverId } });
    return order;
  }

  @Get('export/csv')
  @Permission(Module.ORDERS, Action.EXPORT)
  async export(@Query('from') from?: string, @Query('to') to?: string) {
    const qb = this.orders.createQueryBuilder('o').orderBy('o.createdAt', 'DESC').limit(5000);
    if (from) qb.andWhere('o.createdAt >= :from', { from });
    if (to) qb.andWhere('o.createdAt <= :to', { to });
    const rows = await qb.getMany();
    const header = 'code,status,fulfilment,subtotal,deliveryFee,total,createdAt\n';
    const body = rows.map((o) => [o.code, o.status, o.fulfilment, o.subtotal, o.deliveryFee, o.total, o.createdAt.toISOString()].join(',')).join('\n');
    return { csv: header + body };
  }
}
