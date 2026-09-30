import { Body, Controller, ForbiddenException, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CurrentUser, UserTypes } from '../common/decorators';
import { ActorType, UserType } from '../common/enums';
import { ActorRef } from '../common/contracts';
import { AuthUser } from '../common/auth.types';
import { Order } from '../database/entities';
import { OrdersService } from './orders.service';
import { OrderChatService } from './order-chat.service';

const ACTOR_TYPE: Record<UserType, ActorType> = {
  [UserType.SUPER_ADMIN]: ActorType.STAFF,
  [UserType.STAFF]: ActorType.STAFF,
  [UserType.RESTAURANT]: ActorType.RESTAURANT,
  [UserType.DRIVER]: ActorType.DRIVER,
  [UserType.CUSTOMER]: ActorType.CUSTOMER,
};

function actorFor(user: AuthUser): ActorRef & { staff: boolean; refundLimit: number | null } {
  return { type: ACTOR_TYPE[user.type], id: user.id, staff: user.type === UserType.STAFF || user.type === UserType.SUPER_ADMIN, refundLimit: user.refundLimit ?? null };
}

/** Shared surface used by all four apps (spec §7 tracking/chat): everyone party to an order, masked appropriately. */
@Controller('orders')
@UserTypes(UserType.CUSTOMER, UserType.DRIVER, UserType.RESTAURANT, UserType.STAFF, UserType.SUPER_ADMIN)
@ApiTags('Orders')
@ApiBearerAuth()
export class OrdersController {
  constructor(
    private orders: OrdersService,
    private chat: OrderChatService,
    @InjectRepository(Order) private orderRepo: Repository<Order>,
  ) {}

  private async assertParty(orderId: string, user: AuthUser): Promise<Order> {
    const order = await this.orders.getById(orderId, ['items']);
    const allowed =
      user.type === UserType.STAFF ||
      user.type === UserType.SUPER_ADMIN ||
      (user.type === UserType.CUSTOMER && order.customerId === user.id) ||
      (user.type === UserType.DRIVER && order.driverId === user.driverId) ||
      (user.type === UserType.RESTAURANT && user.restaurantIds?.includes(order.restaurantId));
    if (!allowed) throw new ForbiddenException('Not part of this order');
    return order;
  }

  private viewerLabel(user: AuthUser): 'CUSTOMER' | 'DRIVER' | 'RESTAURANT' | 'STAFF' {
    if (user.type === UserType.CUSTOMER) return 'CUSTOMER';
    if (user.type === UserType.DRIVER) return 'DRIVER';
    if (user.type === UserType.RESTAURANT) return 'RESTAURANT';
    return 'STAFF';
  }

  @Get(':id/tracking')
  async tracking(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    await this.assertParty(id, user);
    return this.orders.trackingView(id, this.viewerLabel(user));
  }

  @Get(':id/messages')
  async messages(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    await this.assertParty(id, user);
    return this.chat.list(id, ACTOR_TYPE[user.type]);
  }

  @Post(':id/messages')
  async sendMessage(@Param('id') id: string, @CurrentUser() user: AuthUser, @Body('body') body: string, @Body('to') to?: ActorType) {
    await this.assertParty(id, user);
    const recipient = to ?? (ACTOR_TYPE[user.type] === ActorType.CUSTOMER ? ActorType.RESTAURANT : ActorType.CUSTOMER);
    return this.chat.send(id, ACTOR_TYPE[user.type], user.id, recipient, body);
  }

  @Post(':id/messages/read')
  async markRead(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    await this.assertParty(id, user);
    return this.chat.markRead(id, ACTOR_TYPE[user.type]);
  }
}

export { actorFor };
