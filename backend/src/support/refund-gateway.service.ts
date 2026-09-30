import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CustomerProfile, Order, Refund, WalletTransaction } from '../database/entities';
import { RefundChargedTo, RefundStatus, RefundType } from '../common/enums';
import { IRefundsService } from '../common/contracts';
import { NotificationsService } from '../notifications/notifications.service';
import { round2 } from './support.constants';

type IssueInput = Parameters<IRefundsService['issue']>[0];
type ApproveActor = Parameters<IRefundsService['approve']>[1];
type RejectActor = Parameters<IRefundsService['reject']>[1];

/**
 * Bridge to RefundsService (OrdersModule). Resolved lazily so the support module boots even while the orders
 * module is still a stub. When RefundsService is not available a minimal fallback writes the Refund row
 * (PROCESSED or PENDING_APPROVAL over the actor limit) and credits the wallet for CREDIT type.
 */
@Injectable()
export class RefundGateway {
  private readonly logger = new Logger(RefundGateway.name);
  private cached: IRefundsService | null = null;

  constructor(
    private moduleRef: ModuleRef,
    private notifications: NotificationsService,
    @InjectRepository(Refund) private refunds: Repository<Refund>,
    @InjectRepository(Order) private orders: Repository<Order>,
    @InjectRepository(CustomerProfile) private profiles: Repository<CustomerProfile>,
    @InjectRepository(WalletTransaction) private wallet: Repository<WalletTransaction>,
  ) {}

  private real(): IRefundsService | null {
    if (this.cached) return this.cached;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { RefundsService } = require('../orders/refunds.service');
      this.cached = this.moduleRef.get<IRefundsService>(RefundsService, { strict: false });
      return this.cached;
    } catch {
      return null;
    }
  }

  get usingFallback() {
    return !this.real();
  }

  async issue(input: IssueInput): Promise<Refund> {
    const real = this.real();
    input = { ...input, amount: round2(input.amount) };
    if (real) return real.issue(input);
    return this.fallback(input);
  }

  /** Approve a PENDING_APPROVAL refund (SOP-06: over-limit refunds escalate to a supervisor/finance). */
  async approve(refundId: string, actor: ApproveActor, notes?: string): Promise<Refund> {
    const real = this.real();
    if (real) return real.approve(refundId, actor, notes);
    const refund = await this.refunds.findOne({ where: { id: refundId } });
    if (!refund) throw new Error('Refund not found');
    if (refund.status !== RefundStatus.PENDING_APPROVAL) throw new Error('This refund is not pending approval');
    if (actor.refundLimit != null && refund.amount > actor.refundLimit) {
      throw new Error(`Your refund limit is $${actor.refundLimit.toFixed(2)}; escalate this $${Number(refund.amount).toFixed(2)} refund further`);
    }
    const order = await this.orders.findOne({ where: { id: refund.orderId } });
    if (!order) throw new Error('Order not found');
    refund.approvedById = actor.id ?? null;
    refund.status = RefundStatus.PROCESSED;
    refund.processedAt = new Date();
    if (notes) refund.notes = [refund.notes, notes].filter(Boolean).join('\n');
    await this.refunds.save(refund);
    if (refund.type === RefundType.CREDIT) {
      const profile = await this.profiles.findOne({ where: { userId: order.customerId } });
      if (profile) {
        const balance = round2(Number(profile.walletBalance) + refund.amount);
        await this.profiles.update(profile.id, { walletBalance: balance });
        await this.wallet.save(this.wallet.create({ customerId: order.customerId, amount: refund.amount, balanceAfter: balance, type: 'CREDIT', orderId: order.id, note: `Support credit (${refund.reasonCode})`, createdById: actor.id ?? null }));
      }
    }
    await this.notifications.notify({ userId: order.customerId, audience: 'CUSTOMER', event: refund.type === RefundType.CREDIT ? 'credit.issued' : 'refund.issued', vars: { amount: `$${Number(refund.amount).toFixed(2)}`, code: order.code }, data: { orderId: order.id } });
    return refund;
  }

  /** Reject a PENDING_APPROVAL refund. */
  async reject(refundId: string, actor: RejectActor, reason?: string): Promise<Refund> {
    const real = this.real();
    if (real) return real.reject(refundId, actor, reason);
    const refund = await this.refunds.findOne({ where: { id: refundId } });
    if (!refund) throw new Error('Refund not found');
    if (refund.status !== RefundStatus.PENDING_APPROVAL) throw new Error('This refund is not pending approval');
    refund.status = RefundStatus.REJECTED;
    refund.approvedById = actor.id ?? null;
    if (reason) refund.notes = [refund.notes, `Rejected: ${reason}`].filter(Boolean).join('\n');
    await this.refunds.save(refund);
    const order = await this.orders.findOne({ where: { id: refund.orderId } });
    if (order) await this.notifications.notify({ userId: order.customerId, audience: 'CUSTOMER', event: 'refund.rejected', vars: { code: order.code }, data: { orderId: order.id } }).catch(() => undefined);
    return refund;
  }

  private async fallback(input: IssueInput): Promise<Refund> {
    this.logger.warn('RefundsService not available - using minimal fallback refund writer');
    const order = await this.orders.findOne({ where: { id: input.orderId } });
    if (!order) throw new Error('Order not found');
    const limit = input.actor.refundLimit;
    const over = !!input.actor.staff && limit !== null && limit !== undefined && input.amount > limit;
    const type = input.type ?? RefundType.REFUND;
    const status = over ? RefundStatus.PENDING_APPROVAL : RefundStatus.PROCESSED;
    const row = await this.refunds.save(
      this.refunds.create({
        orderId: input.orderId,
        ticketId: input.ticketId ?? null,
        amount: input.amount,
        type,
        chargedTo: input.chargedTo as RefundChargedTo,
        reasonCode: input.reasonCode,
        notes: input.notes ?? null,
        status,
        createdById: input.actor.id ?? null,
        createdByType: input.auto ? 'SYSTEM' : input.actor.staff ? 'STAFF' : 'SYSTEM',
        processedAt: status === RefundStatus.PROCESSED ? new Date() : null,
        auto: !!input.auto,
      }),
    );
    if (status === RefundStatus.PROCESSED) {
      if (type === RefundType.CREDIT) {
        const profile = await this.profiles.findOne({ where: { userId: order.customerId } });
        if (profile) {
          const balance = round2(Number(profile.walletBalance) + input.amount);
          await this.profiles.update(profile.id, { walletBalance: balance });
          await this.wallet.save(
            this.wallet.create({ customerId: order.customerId, amount: input.amount, balanceAfter: balance, type: 'CREDIT', orderId: order.id, note: `Support credit (${input.reasonCode})`, createdById: input.actor.id ?? null }),
          );
        }
      }
      await this.notifications.notify({
        userId: order.customerId,
        audience: 'CUSTOMER',
        event: type === RefundType.CREDIT ? 'credit.issued' : 'refund.issued',
        vars: { amount: `$${input.amount.toFixed(2)}`, code: order.code },
        data: { orderId: order.id },
      });
    }
    return row;
  }
}
