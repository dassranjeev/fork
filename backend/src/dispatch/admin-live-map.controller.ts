import { BadRequestException, Body, Get, Param, Post, Query } from '@nestjs/common';
import { IsIn, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { clampPaging } from '../common/pagination';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AdminController, CurrentUser, Permission } from '../common/decorators';
import { Action, ActorType, FulfilmentMode, Module, OrderStatus, RefundChargedTo, RefundType, RestaurantStatus } from '../common/enums';
import { AuthUser } from '../common/auth.types';
import { ActorRef } from '../common/contracts';
import { DriverProfile, Order, Restaurant } from '../database/entities';
import { AuditService } from '../audit/audit.service';
import { OrdersService } from '../orders/orders.service';
import { RefundsService } from '../orders/refunds.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SettingsService } from '../settings/settings.service';
import { DispatchService } from './dispatch.service';
import { computeOrderFlag } from './order-flags';
import { OrderFlagConfig } from './dispatch.types';

const LIVE_STATUSES = [OrderStatus.PLACED, OrderStatus.ACCEPTED, OrderStatus.DRIVER_ASSIGNED, OrderStatus.PREPARING, OrderStatus.READY, OrderStatus.PICKED_UP, OrderStatus.ON_THE_WAY];

class AssignBodyDto {
  @IsUUID() driverId: string;
  @IsOptional() @IsNumber({ allowNaN: false, allowInfinity: false }) @Min(0) @Max(50) boost?: number;
}
class ReassignBodyDto {
  @IsUUID() driverId: string;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}
class UnassignBodyDto {
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}
class OfferAltBodyDto {
  @IsIn(['CREDIT', 'PICKUP_OFFER']) type: 'CREDIT' | 'PICKUP_OFFER';
  @IsOptional() @IsNumber({ allowNaN: false, allowInfinity: false }) @Min(0.01) @Max(100) amount?: number;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

function actorFor(user: AuthUser): ActorRef & { staff: boolean; refundLimit: number | null; supportApproved: boolean } {
  return { type: ActorType.STAFF, id: user.id, name: user.name, staff: true, refundLimit: (user.type as string) === 'SUPER_ADMIN' ? null : user.refundLimit ?? null, supportApproved: true };
}

/** SOP: dispatcher live operations map (spec 5.4 / admin console) - snapshot + manual dispatch tools. */
@AdminController('live-map')
export class AdminLiveMapController {
  constructor(
    @InjectRepository(Order) private orders: Repository<Order>,
    @InjectRepository(DriverProfile) private drivers: Repository<DriverProfile>,
    @InjectRepository(Restaurant) private restaurants: Repository<Restaurant>,
    private dispatch: DispatchService,
    private ordersSvc: OrdersService,
    private refunds: RefundsService,
    private notifications: NotificationsService,
    private settings: SettingsService,
    private audit: AuditService,
  ) {}

  @Get()
  @Permission(Module.LIVE_MAP, Action.VIEW)
  async snapshot(@Query('cityId') cityId?: string) {
    const now = new Date();
    const cfg: OrderFlagConfig = {
      autoRejectSec: this.settings.get<number>('orders.autoRejectSeconds', 180),
      pickupOverdueMin: 10,
      lateGraceMin: 10,
      veryLateMin: this.settings.get<number>('support.veryLateMinutes', 30),
    };
    const oqb = this.orders.createQueryBuilder('o').leftJoinAndSelect('o.restaurant', 'r').where('o.status IN (:...st)', { st: LIVE_STATUSES });
    if (cityId) oqb.andWhere('o.cityId = :cityId', { cityId });
    const orders = await oqb.orderBy('o.createdAt', 'ASC').limit(500).getMany();

    const dqb = this.drivers.createQueryBuilder('d').leftJoinAndSelect('d.user', 'u').where('d.isOnline = true');
    if (cityId) dqb.andWhere('d.cityId = :cityId', { cityId });
    const drivers = await dqb.getMany();

    const rqb = this.restaurants.createQueryBuilder('r').where('r.status = :st', { st: RestaurantStatus.LIVE }).andWhere('r.lat IS NOT NULL');
    if (cityId) rqb.andWhere('r.cityId = :cityId', { cityId });
    const restaurants = await rqb.getMany();

    return {
      generatedAt: now.toISOString(),
      orders: orders.map((o) => {
        const flag = computeOrderFlag(o, now, cfg);
        return {
          id: o.id,
          code: o.code,
          status: o.status,
          fulfilment: o.fulfilment,
          restaurantId: o.restaurantId,
          restaurantName: o.restaurant?.name,
          restaurantLat: o.restaurant?.lat,
          restaurantLng: o.restaurant?.lng,
          driverId: o.driverId,
          dropLat: o.deliveryAddress?.lat,
          dropLng: o.deliveryAddress?.lng,
          estimatedReadyAt: o.estimatedReadyAt,
          estimatedDeliveryAt: o.estimatedDeliveryAt,
          flag: flag.flag,
          flagReasons: flag.reasons,
          minutesLate: flag.minutesLate,
          dispatch: o.meta?.dispatch ? { state: o.meta.dispatch.state, widenings: o.meta.dispatch.widenings, radiusKm: o.meta.dispatch.radiusKm, sequence: o.meta.dispatch.sequence } : null,
        };
      }),
      drivers: drivers.map((d) => ({
        id: d.id,
        name: `${d.user?.firstName ?? ''} ${d.user?.lastName ?? ''}`.trim() || 'Driver',
        status: d.status,
        vehicleType: d.vehicleType,
        lat: d.lat,
        lng: d.lng,
        heading: d.heading,
        onTrip: d.onTrip,
        rating: d.rating,
        lastLocationAt: d.lastLocationAt,
      })),
      restaurants: restaurants.map((r) => ({ id: r.id, name: r.name, lat: r.lat, lng: r.lng, status: r.status, cityId: r.cityId, zoneId: r.zoneId })),
      counts: {
        orders: orders.length,
        onlineDrivers: drivers.length,
        driversOnTrip: drivers.filter((d) => d.onTrip).length,
        unassigned: orders.filter((o) => o.fulfilment === FulfilmentMode.PLATFORM_DRIVER && !o.driverId).length,
        redFlags: orders.filter((o) => computeOrderFlag(o, now, cfg).flag === 'RED').length,
      },
    };
  }

  @Get('orders/:id/candidates')
  @Permission(Module.LIVE_MAP, Action.VIEW)
  candidates(@Param('id') id: string, @Query('limit') limit?: string) {
    return this.dispatch.candidates(id, clampPaging(1, limit, 50, 10).limit);
  }

  @Post('orders/:id/assign')
  @Permission(Module.OPERATIONS, Action.EDIT)
  async assign(@Param('id') id: string, @CurrentUser() user: AuthUser, @Body() dto: AssignBodyDto) {
    const { driverId, boost } = dto;
    const order = await this.dispatch.assignManually(id, driverId, actorFor(user), { boost });
    await this.audit.log({ actor: user, action: 'dispatch.manual_assign', entity: 'Order', entityId: id, after: { driverId, boost } });
    return order;
  }

  @Post('orders/:id/reassign')
  @Permission(Module.OPERATIONS, Action.EDIT)
  async reassign(@Param('id') id: string, @CurrentUser() user: AuthUser, @Body() dto: ReassignBodyDto) {
    const { driverId, reason } = dto;
    await this.ordersSvc.unassignDriver(id, actorFor(user), reason ?? 'Reassigned by dispatcher');
    const order = await this.dispatch.assignManually(id, driverId, actorFor(user));
    await this.audit.log({ actor: user, action: 'dispatch.reassign', entity: 'Order', entityId: id, after: { driverId, reason } });
    return order;
  }

  /** Take the driver off the order and put it back into automatic dispatch (the removed driver is not re-offered). READY orders keep status READY. */
  @Post('orders/:id/unassign')
  @Permission(Module.OPERATIONS, Action.EDIT)
  async unassign(@Param('id') id: string, @CurrentUser() user: AuthUser, @Body() dto: UnassignBodyDto) {
    const reason = dto.reason;
    const order = await this.ordersSvc.unassignDriver(id, actorFor(user), reason ?? 'Unassigned by dispatcher', { redispatch: true });
    await this.audit.log({ actor: user, action: 'dispatch.unassign', entity: 'Order', entityId: id, after: { reason } });
    return order;
  }

  @Post('orders/:id/start-dispatch')
  @Permission(Module.OPERATIONS, Action.EDIT)
  async restart(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    await this.dispatch.startDispatch(id);
    await this.audit.log({ actor: user, action: 'dispatch.restart', entity: 'Order', entityId: id });
    return { ok: true };
  }

  /** Unassigned order relief: offer the customer a credit, or nudge them towards self-pickup, while dispatch keeps retrying. */
  @Post('orders/:id/offer-alternative')
  @Permission(Module.OPERATIONS, Action.EDIT)
  async offerAlternative(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: OfferAltBodyDto,
  ) {
    const { type, amount, reason } = dto;
    const order = await this.ordersSvc.getById(id);
    if (order.driverId) throw new BadRequestException('Order already has a driver assigned');
    if (type === 'CREDIT') {
      if (!amount || amount <= 0) throw new BadRequestException('amount is required');
      const refund = await this.refunds.issue({
        orderId: id,
        amount,
        type: RefundType.CREDIT,
        chargedTo: RefundChargedTo.PLATFORM,
        reasonCode: 'NO_DRIVER_AVAILABLE',
        notes: reason,
        actor: actorFor(user),
        auto: false,
      });
      await this.audit.log({ actor: user, action: 'dispatch.offer_credit', entity: 'Order', entityId: id, after: { amount, reason } });
      return refund;
    }
    if (type === 'PICKUP_OFFER') {
      await this.notifications.notify({ userId: order.customerId, audience: 'CUSTOMER', event: 'order.no_driver', vars: { code: order.code } });
      await this.audit.log({ actor: user, action: 'dispatch.offer_pickup', entity: 'Order', entityId: id, after: { reason } });
      return { ok: true };
    }
    throw new BadRequestException('type must be CREDIT or PICKUP_OFFER');
  }
}
