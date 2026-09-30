import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Order, Refund, Restaurant } from '../database/entities';
import { LedgerType, PartyType, PaymentStatus, RefundStatus, RefundType } from '../common/enums';
import { IRefundsService, Events } from '../common/contracts';
import { PaymentsService } from './payments.service';
import { LedgerService } from './ledger.service';
import { WalletService } from './wallet.service';
import { NotificationsService } from '../notifications/notifications.service';
import { round2 } from './pricing.math';

/** Refund and dispute rules (section 9.2/9.3): agents are capped at their role's refundLimit, escalate above that. */
@Injectable()
export class RefundsService implements IRefundsService {
  constructor(
    @InjectRepository(Refund) private refunds: Repository<Refund>,
    @InjectRepository(Order) private orders: Repository<Order>,
    @InjectRepository(Restaurant) private restaurants: Repository<Restaurant>,
    private payments: PaymentsService,
    private ledger: LedgerService,
    private wallet: WalletService,
    private notifications: NotificationsService,
    private events: EventEmitter2,
  ) {}

  async issue(input: Parameters<IRefundsService['issue']>[0]): Promise<Refund> {
    const order = await this.orders.findOne({ where: { id: input.orderId } });
    if (!order) throw new NotFoundException('Order not found');
    const amount = round2(input.amount);
    if (amount <= 0) throw new BadRequestException('Refund amount must be positive');
    const alreadyRefunded = await this.refunds
      .createQueryBuilder('r')
      .select('COALESCE(SUM(r.amount), 0)', 'sum')
      .where('r.orderId = :orderId AND r.status = :status', { orderId: order.id, status: RefundStatus.PROCESSED })
      .getRawOne<{ sum: string }>();
    const already = round2(Number(alreadyRefunded?.sum ?? 0));
    if (already + amount > round2(Number(order.total)) + 0.01) {
      throw new BadRequestException(`Refund would exceed the order total (already refunded $${already.toFixed(2)} of $${Number(order.total).toFixed(2)})`);
    }

    const type = input.type ?? RefundType.REFUND;
    const overLimit = !input.auto && input.actor.staff && input.actor.refundLimit != null && amount > input.actor.refundLimit;

    const refund = this.refunds.create({
      orderId: order.id,
      ticketId: input.ticketId ?? null,
      amount,
      type,
      chargedTo: input.chargedTo,
      reasonCode: input.reasonCode,
      notes: input.notes ?? null,
      status: overLimit ? RefundStatus.PENDING_APPROVAL : RefundStatus.PROCESSED,
      createdById: input.actor.id ?? null,
      createdByType: input.actor.staff ? 'STAFF' : input.auto ? 'SYSTEM' : 'CUSTOMER',
      auto: !!input.auto,
      processedAt: overLimit ? null : new Date(),
    });
    await this.refunds.save(refund);

    if (overLimit) {
      await this.notifications.notifyOps('order.stuck', { code: order.code, reason: `Refund of $${amount.toFixed(2)} needs supervisor approval` });
      return refund;
    }

    await this.settle(refund, order);
    return refund;
  }

  async approve(refundId: string, actor: Parameters<IRefundsService['approve']>[1], notes?: string): Promise<Refund> {
    const refund = await this.refunds.findOne({ where: { id: refundId } });
    if (!refund) throw new NotFoundException('Refund not found');
    if (refund.status !== RefundStatus.PENDING_APPROVAL) throw new BadRequestException('This refund is not pending approval');
    if (actor.refundLimit != null && refund.amount > actor.refundLimit) {
      throw new ForbiddenException(`Your refund limit is $${actor.refundLimit.toFixed(2)}; escalate this $${Number(refund.amount).toFixed(2)} refund further`);
    }
    const order = await this.orders.findOne({ where: { id: refund.orderId } });
    if (!order) throw new NotFoundException('Order not found');
    refund.approvedById = actor.id ?? null;
    refund.status = RefundStatus.PROCESSED;
    refund.processedAt = new Date();
    if (notes) refund.notes = [refund.notes, notes].filter(Boolean).join('\n');
    await this.refunds.save(refund);
    await this.settle(refund, order);
    return refund;
  }

  async reject(refundId: string, actor: Parameters<IRefundsService['reject']>[1], reason?: string): Promise<Refund> {
    const refund = await this.refunds.findOne({ where: { id: refundId } });
    if (!refund) throw new NotFoundException('Refund not found');
    if (refund.status !== RefundStatus.PENDING_APPROVAL) throw new BadRequestException('This refund is not pending approval');
    refund.status = RefundStatus.REJECTED;
    refund.approvedById = actor.id ?? null;
    if (reason) refund.notes = [refund.notes, `Rejected: ${reason}`].filter(Boolean).join('\n');
    await this.refunds.save(refund);
    return refund;
  }

  /** Applies the money movement for a PROCESSED refund: pay the customer back (or credit wallet), charge the responsible party. */
  private async settle(refund: Refund, order: Order) {
    if (refund.type === RefundType.CREDIT) {
      await this.wallet.credit(order.customerId, refund.amount, 'REFUND', { orderId: order.id, note: refund.reasonCode });
    } else {
      await this.payments.refund(order, refund.amount, refund.reasonCode);
      const totalRefunded = round2(refund.amount + (await this.processedTotal(order.id, refund.id)));
      order.paymentStatus = totalRefunded >= round2(Number(order.total)) - 0.01 ? PaymentStatus.REFUNDED : PaymentStatus.PARTIALLY_REFUNDED;
      await this.orders.save(order);
    }

    const restaurant = order.restaurantId ? await this.restaurants.findOne({ where: { id: order.restaurantId } }) : null;
    if (refund.chargedTo === 'RESTAURANT' && restaurant?.merchantId) {
      await this.ledger.add({ partyType: PartyType.RESTAURANT, partyId: restaurant.merchantId, restaurantId: order.restaurantId, orderId: order.id, type: LedgerType.REFUND, amount: -refund.amount, description: `Refund: ${refund.reasonCode}` });
    } else if (refund.chargedTo === 'DRIVER' && order.driverId) {
      await this.ledger.add({ partyType: PartyType.DRIVER, partyId: order.driverId, orderId: order.id, type: LedgerType.REFUND, amount: -refund.amount, description: `Refund: ${refund.reasonCode}` });
    } else {
      await this.ledger.add({ partyType: PartyType.PLATFORM, partyId: null, orderId: order.id, type: LedgerType.REFUND, amount: -refund.amount, description: `Refund: ${refund.reasonCode}` });
    }

    await this.notifications.notify({
      userId: order.customerId,
      audience: 'CUSTOMER',
      event: refund.type === RefundType.CREDIT ? 'order.partial_refund' : 'order.partial_refund',
      vars: { code: order.code, amount: `$${refund.amount.toFixed(2)}` },
    });
    this.events.emit(Events.REFUND_ISSUED, { refundId: refund.id, orderId: order.id, amount: refund.amount, chargedTo: refund.chargedTo });
  }

  private async processedTotal(orderId: string, excludeId: string) {
    const row = await this.refunds
      .createQueryBuilder('r')
      .select('COALESCE(SUM(r.amount), 0)', 'sum')
      .where('r.orderId = :orderId AND r.status = :status AND r.id <> :id', { orderId, status: RefundStatus.PROCESSED, id: excludeId })
      .getRawOne<{ sum: string }>();
    return round2(Number(row?.sum ?? 0));
  }
}
