import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CustomerProfile, WalletTransaction } from '../database/entities';
import { IWalletService } from '../common/contracts';
import { round2 } from './pricing.math';

/**
 * FORKY wallet / credits. `CustomerProfile.walletBalance` is the cached balance;
 * `wallet_transactions` is the append-only audit trail (source of truth for history).
 * Every mutation runs inside a transaction with a row lock on the profile to avoid
 * lost updates from concurrent credits/debits (e.g. a refund landing mid-checkout).
 */
@Injectable()
export class WalletService implements IWalletService {
  constructor(@InjectDataSource() private ds: DataSource) {}

  async balance(customerId: string): Promise<number> {
    const profile = await this.ds.getRepository(CustomerProfile).findOne({ where: { userId: customerId } });
    return round2(Number(profile?.walletBalance ?? 0));
  }

  async credit(
    customerId: string,
    amount: number,
    type: 'CREDIT' | 'REFUND' | 'TOPUP' | 'GIFT_CARD' | 'REFERRAL' | 'ADJUSTMENT' | 'PROMO',
    opts?: { orderId?: string; note?: string; actorId?: string },
  ): Promise<number> {
    if (amount <= 0) throw new BadRequestException('Credit amount must be positive');
    return this.ds.transaction(async (mgr) => {
      const profiles = mgr.getRepository(CustomerProfile);
      const profile = await profiles
        .createQueryBuilder('p')
        .setLock('pessimistic_write')
        .where('p.userId = :customerId', { customerId })
        .getOne();
      if (!profile) throw new BadRequestException('Customer profile not found');
      const balanceAfter = round2(Number(profile.walletBalance) + round2(amount));
      await profiles.update(profile.id, { walletBalance: balanceAfter });
      await mgr.getRepository(WalletTransaction).insert({
        customerId,
        amount: round2(amount),
        balanceAfter,
        type,
        orderId: opts?.orderId ?? null,
        note: opts?.note ?? null,
        createdById: opts?.actorId ?? null,
      });
      return balanceAfter;
    });
  }

  async debit(
    customerId: string,
    amount: number,
    type: 'PURCHASE' | 'ADJUSTMENT',
    opts?: { orderId?: string; note?: string; actorId?: string },
  ): Promise<number> {
    if (amount <= 0) throw new BadRequestException('Debit amount must be positive');
    return this.ds.transaction(async (mgr) => {
      const profiles = mgr.getRepository(CustomerProfile);
      const profile = await profiles
        .createQueryBuilder('p')
        .setLock('pessimistic_write')
        .where('p.userId = :customerId', { customerId })
        .getOne();
      if (!profile) throw new BadRequestException('Customer profile not found');
      const current = round2(Number(profile.walletBalance));
      if (current < round2(amount)) throw new BadRequestException('Insufficient wallet balance');
      const balanceAfter = round2(current - round2(amount));
      await profiles.update(profile.id, { walletBalance: balanceAfter });
      await mgr.getRepository(WalletTransaction).insert({
        customerId,
        amount: -round2(amount),
        balanceAfter,
        type,
        orderId: opts?.orderId ?? null,
        note: opts?.note ?? null,
        createdById: opts?.actorId ?? null,
      });
      return balanceAfter;
    });
  }

  history(customerId: string, page = 1, limit = 30) {
    return this.ds
      .getRepository(WalletTransaction)
      .findAndCount({ where: { customerId }, order: { createdAt: 'DESC' }, skip: (page - 1) * limit, take: limit });
  }
}
