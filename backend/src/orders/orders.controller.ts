import { Body, Controller, ForbiddenException, Get, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { createReadStream } from 'fs';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CurrentUser, UserTypes } from '../common/decorators';
import { Action, ActorType, Module, UserType } from '../common/enums';
import { hasPermission } from '../common/guards';
import { ActorRef } from '../common/contracts';
import { AuthUser } from '../common/auth.types';
import { Order } from '../database/entities';
import { OrdersService } from './orders.service';
import { OrderChatService } from './order-chat.service';
import { ProofService } from './proof.service';

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

class ChatMessageDto {
  @IsString() @MinLength(1) @MaxLength(1000) body: string;
  /** recipient side; a party can only address the other parties of the same order */
  @IsOptional() @IsIn([ActorType.CUSTOMER, ActorType.RESTAURANT, ActorType.DRIVER, ActorType.STAFF]) to?: ActorType;
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
    private proof: ProofService,
    @InjectRepository(Order) private orderRepo: Repository<Order>,
  ) {}

  private async assertParty(orderId: string, user: AuthUser, write = false): Promise<Order> {
    const order = await this.orders.getById(orderId, ['items']);
    // staff need the Orders permission (view to read, edit to post); city/zone scoped roles only see their scope
    if (user.type === UserType.STAFF && !hasPermission(user, Module.ORDERS, write ? Action.EDIT : Action.VIEW)) throw new ForbiddenException('Missing permission: orders:' + (write ? 'edit' : 'view'));
    if (user.type === UserType.STAFF) {
      if (user.scopeCityIds?.length && !(order.cityId && user.scopeCityIds.includes(order.cityId))) throw new ForbiddenException('Outside your city scope');
      if (user.scopeZoneIds?.length && !(order.zoneId && user.scopeZoneIds.includes(order.zoneId))) throw new ForbiddenException('Outside your zone scope');
    }
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
  async tracking(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    await this.assertParty(id, user);
    return this.orders.trackingView(id, this.viewerLabel(user));
  }

  /**
   * Delivery proof photo. NOT under /uploads: only the order's customer, its assigned driver, the restaurant staff of that order and
   * staff with orders:view get it (assertParty), bearer token required, never cached.
   */
  @Get(':id/proof/photo')
  async proofPhoto(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser, @Res() res: Response) {
    await this.assertParty(id, user);
    const f = await this.proof.photoFileFor(id);
    res.set({ 'Content-Type': f.mime, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline', 'Cross-Origin-Resource-Policy': 'same-site', 'Content-Security-Policy': "default-src 'none'; sandbox" });
    createReadStream(f.path).pipe(res);
  }

  @Get(':id/messages')
  async messages(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    await this.assertParty(id, user);
    return this.chat.list(id, ACTOR_TYPE[user.type]);
  }

  @Post(':id/messages')
  async sendMessage(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser, @Body() dto: ChatMessageDto) {
    await this.assertParty(id, user, true);
    const sender = ACTOR_TYPE[user.type];
    const recipient = dto.to ?? (sender === ActorType.CUSTOMER ? ActorType.RESTAURANT : ActorType.CUSTOMER);
    if (recipient === sender) throw new ForbiddenException('Invalid recipient');
    return this.chat.send(id, sender, user.id, recipient, dto.body);
  }

  @Post(':id/messages/read')
  async markRead(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    await this.assertParty(id, user, true);
    return this.chat.markRead(id, ACTOR_TYPE[user.type]);
  }
}

export { actorFor };
