import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Order, OrderMessage } from '../database/entities';
import { ActorType } from '../common/enums';
import { RealtimeService } from '../realtime/realtime.module';
import { NotificationsService } from '../notifications/notifications.service';
import { SettingsService } from '../settings/settings.service';

/** Masked in-app chat scoped to an order - real phone numbers are never exposed (section 5.2/6.4). */
@Injectable()
export class OrderChatService {
  constructor(
    @InjectRepository(OrderMessage) private messages: Repository<OrderMessage>,
    @InjectRepository(Order) private orders: Repository<Order>,
    private realtime: RealtimeService,
    private notifications: NotificationsService,
    private settings: SettingsService,
  ) {}

  private async assertOpen(orderId: string) {
    const order = await this.orders.findOne({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Order not found');
    if (order.deliveredAt || order.cancelledAt) {
      const closedAt = order.deliveredAt ?? order.cancelledAt!;
      const windowMin = this.settings.get<number>('orders.chatWindowMinutes', 60);
      if (Date.now() - closedAt.getTime() > windowMin * 60_000) {
        throw new ForbiddenException('Chat for this order has closed');
      }
    }
    return order;
  }

  async send(orderId: string, senderType: ActorType, senderId: string | null, recipientType: ActorType, body: string) {
    await this.assertOpen(orderId);
    const trimmed = body.trim().slice(0, 1000);
    if (!trimmed) throw new ForbiddenException('Message cannot be empty');
    const msg = await this.messages.save(this.messages.create({ orderId, senderType, senderId, recipientType, body: trimmed }));
    this.realtime.emitToOrder(orderId, 'order.message', msg);
    return msg;
  }

  /** Messages relevant to a given viewer: sent by them, or addressed to them. */
  async list(orderId: string, viewerType: ActorType) {
    return this.messages.find({
      where: [
        { orderId, senderType: viewerType },
        { orderId, recipientType: viewerType },
      ],
      order: { createdAt: 'ASC' },
    });
  }

  async markRead(orderId: string, viewerType: ActorType) {
    await this.messages.createQueryBuilder().update().set({ readAt: () => 'now()' }).where('orderId = :orderId AND recipientType = :viewerType AND readAt IS NULL', { orderId, viewerType }).execute();
    return { ok: true };
  }
}
