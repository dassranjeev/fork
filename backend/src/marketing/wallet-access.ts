import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CustomerProfile, WalletTransaction } from '../database/entities';
import { IWalletService } from '../common/contracts';

/**
 * Lazy access to WalletService (owned by OrdersModule). Falls back to a minimal repository-based
 * implementation when the real service is not available, so marketing flows never break.
 */
@Injectable()
export class WalletAccess {
  private readonly logger = new Logger(WalletAccess.name);
  private wallet: IWalletService | null | undefined;

  constructor(private moduleRef: ModuleRef, @InjectDataSource() private ds: DataSource) {}

  get(): IWalletService {
    if (this.wallet === undefined) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { WalletService } = require('../orders/wallet.service');
        this.wallet = this.moduleRef.get<IWalletService>(WalletService, { strict: false });
      } catch {
        this.wallet = null;
      }
    }
    return this.wallet ?? this.fallback();
  }

  private fallback(): IWalletService {
    const ds = this.ds;
    this.logger.debug('Using fallback wallet implementation');
    return {
      balance: async (customerId) => {
        const p = await ds.getRepository(CustomerProfile).findOne({ where: { userId: customerId } });
        return p?.walletBalance ?? 0;
      },
      credit: async (customerId, amount, type, opts) =>
        ds.transaction(async (m) => {
          const p = await m.findOne(CustomerProfile, { where: { userId: customerId }, lock: { mode: 'pessimistic_write' } });
          if (!p) throw new Error('Customer profile not found');
          const balance = Math.round((p.walletBalance + amount) * 100) / 100;
          await m.update(CustomerProfile, { id: p.id }, { walletBalance: balance });
          await m.insert(WalletTransaction, {
            customerId,
            amount,
            balanceAfter: balance,
            type,
            orderId: opts?.orderId ?? null,
            note: opts?.note ?? null,
            createdById: opts?.actorId ?? null,
          });
          return balance;
        }),
      debit: async () => {
        throw new Error('Not supported by fallback wallet');
      },
    };
  }
}
