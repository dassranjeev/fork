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
    // strict numeric validation: NaN / Infinity / numeric strings must never reach the cap arithmetic (NaN > x is false => silent bypass)
    const rawAmount = typeof input.amount === 'number' ? input.amount : NaN;
    const amount = round2(rawAmount);
    if (!Number.isFinite(amount) || amount <= 0) throw new BadRequestException('Refund amount must be a positive number');
    if (amount > 10_000) throw new BadRequestException('Refund amount is too large');
    const type = input.type ?? RefundType.REFUND;
    const overLimit = !input.auto && input.actor.staff && input.actor.refundLimit != null && amount > input.actor.refundLimit;

    // The cap check and the insert happen under a row lock on the order, so concurrent refunds are serialised and cannot
    // exceed the order total. Pending-approval refunds count against the cap too.
    const { order, refund } = await this.refunds.manager.transaction(async (em) => {
      const order = await em.getRepository(Order).createQueryBuilder('o').setLock('pessimistic_write').where('o.id = :id', { id: input.orderId }).getOne();
      if (!order) throw new NotFoundException('Order not found');
      const rows: { sum: string }[] = await em.query(
        `SELECT COALESCE(SUM(amount), 0) AS sum FROM refunds WHERE "orderId" = $1 AND status IN ('PROCESSED','PENDING_APPROVAL') AND amount <> 'NaN'`,
        [order.id],
      );
      const already = round2(Number(rows[0]?.sum ?? 0));
      if (already + amount > round2(Number(order.total)) + 0.01) {
        throw new BadRequestException(`Refund would exceed the order total (already refunded or pending $${already.toFixed(2)} of $${Number(order.total).toFixed(2)})`);
      }
      const refund = await em.save(
        em.create(Refund, {
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
        }),
      );
      return { order, refund };
    });

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
    if (refund.createdById && actor.id && refund.createdById === actor.id) throw new ForbiddenException('A different person must approve this refund (four-eyes rule)');
    const order = await this.orders.findOne({ where: { id: refund.orderId } });
    if (!order) throw new NotFoundException('Order not found');
    // atomic claim: when several approvals race, exactly one wins and settles the money once
    const claim = await this.refunds
      .createQueryBuilder()
      .update(Refund)
      .set({ status: RefundStatus.PROCESSED, approvedById: actor.id ?? null, processedAt: new Date(), ...(notes ? { notes: [refund.notes, notes].filter(Boolean).join('\n') } : {}) })
      .where('id = :id AND status = :st', { id: refundId, st: RefundStatus.PENDING_APPROVAL })
      .execute();
    if (!claim.affected) throw new BadRequestException('This refund is not pending approval');
    refund.status = RefundStatus.PROCESSED;
    refund.approvedById = actor.id ?? null;
    refund.processedAt = new Date();
    await this.settle(refund, order);
    return refund;
  }

  async reject(refundId: string, actor: Parameters<IRefundsService['reject']>[1], reason?: string): Promise<Refund> {
    const refund = await this.refunds.findOne({ where: { id: refundId } });
    if (!refund) throw new NotFoundException('Refund not found');
    if (refund.status !== RefundStatus.PENDING_APPROVAL) throw new BadRequestException('This refund is not pending approval');
    const notes = reason ? [refund.notes, `Rejected: ${reason}`].filter(Boolean).join('\n') : refund.notes;
    const claim = await this.refunds.createQueryBuilder().update(Refund).set({ status: RefundStatus.REJECTED, approvedById: actor.id ?? null, notes }).where('id = :id AND status = :st', { id: refundId, st: RefundStatus.PENDING_APPROVAL }).execute();
    if (!claim.affected) throw new BadRequestException('This refund is not pending approval');
    refund.status = RefundStatus.REJECTED;
    refund.approvedById = actor.id ?? null;
    refund.notes = notes;
    return refund;
  }

  /** Applies the money movement for a PROCESSED refund: pay the customer back (or credit wallet), charge the responsible party. */
  private async settle(refund: Refund, order: Order) {
    if (refund.type === RefundType.CREDIT) {
      await this.wallet.credit(order.customerId, refund.amount, 'REFUND', { orderId: order.id, note: refund.reasonCode });
    } else {
      // to the card through Stripe (idempotent per refund id); whatever the card cannot take (paid with wallet credit, hold not captured yet) goes to the wallet
      const paid = await this.payments.refund(order, refund.amount, refund.reasonCode, refund.id);
      if (paid.walletCredit > 0) await this.wallet.credit(order.customerId, paid.walletCredit, 'REFUND', { orderId: order.id, note: `${refund.reasonCode} (returned as wallet credit)` });
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
