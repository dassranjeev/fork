import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  IGiftCardsService,
  IOrdersService,
  IPaymentsService,
  IPricingService,
  IWalletService,
} from '../common/contracts';
import { CustomerProfile, WalletTransaction } from '../database/entities';
import { round2 } from './util';

type WalletKind = Parameters<IWalletService['credit']>[2];

/** Fallback used until (or if) the OrdersModule WalletService is not available. Same semantics as IWalletService. */
class WalletFallback implements IWalletService {
  constructor(private ds: DataSource) {}

  async balance(customerId: string) {
    const p = await this.ds.getRepository(CustomerProfile).findOne({ where: { userId: customerId } });
    return p?.walletBalance ?? 0;
  }

  private move(customerId: string, delta: number, type: WalletTransaction['type'], opts: { orderId?: string; note?: string; actorId?: string } = {}) {
    return this.ds.transaction(async (em) => {
      const profile = await em.getRepository(CustomerProfile).findOne({ where: { userId: customerId }, lock: { mode: 'pessimistic_write' } });
      if (!profile) throw new BadRequestException('Customer not found');
      const next = round2(profile.walletBalance + delta);
      if (next < 0) throw new BadRequestException('Insufficient wallet balance');
      await em.update(CustomerProfile, profile.id, { walletBalance: next });
      await em.insert(WalletTransaction, {
        customerId,
        amount: round2(delta),
        balanceAfter: next,
        type,
        orderId: opts.orderId ?? null,
        note: opts.note ?? null,
        createdById: opts.actorId ?? null,
      });
      return next;
    });
  }

  credit(customerId: string, amount: number, type: WalletKind, opts?: { orderId?: string; note?: string; actorId?: string }) {
    if (!(amount > 0)) throw new BadRequestException('Amount must be positive');
    return this.move(customerId, amount, type, opts);
  }

  debit(customerId: string, amount: number, type: 'PURCHASE' | 'ADJUSTMENT', opts?: { orderId?: string; note?: string; actorId?: string }) {
    if (!(amount > 0)) throw new BadRequestException('Amount must be positive');
    return this.move(customerId, -amount, type, opts);
  }
}

/**
 * Services owned by other modules (OrdersModule, MarketingModule) are resolved lazily at call time so this module
 * boots even while those modules are still stubs. Files are loaded with require() for the same reason.
 */
@Injectable()
export class ExternalServices {
  private readonly logger = new Logger('ExternalServices');
  private fallbackWallet: WalletFallback;

  constructor(
    private moduleRef: ModuleRef,
    @InjectDataSource() ds: DataSource,
  ) {
    this.fallbackWallet = new WalletFallback(ds);
  }

  private load<T>(file: string, cls: string): T | null {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require(file);
      const token = mod?.[cls];
      if (!token) return null;
      return this.moduleRef.get<T>(token, { strict: false });
    } catch (e: any) {
      this.logger.debug(`${cls} unavailable: ${e.message}`);
      return null;
    }
  }

  private required<T>(what: string, loader: () => T | null): T {
    const s = loader();
    if (!s) throw new ServiceUnavailableException(`${what} is not available yet`);
    return s;
  }

  get wallet(): IWalletService {
    return this.load<IWalletService>('../orders/wallet.service', 'WalletService') ?? this.fallbackWallet;
  }
  get pricing(): IPricingService {
    return this.required('Pricing', () => this.load<IPricingService>('../orders/pricing.service', 'PricingService'));
  }
  get orders(): IOrdersService {
    return this.required('Orders', () => this.load<IOrdersService>('../orders/orders.service', 'OrdersService'));
  }
  get payments(): IPaymentsService {
    return this.required('Payments', () => this.load<IPaymentsService>('../orders/payments.service', 'PaymentsService'));
  }
  get giftCards(): IGiftCardsService {
    return this.required('Gift cards', () => this.load<IGiftCardsService>('../marketing/gift-cards.service', 'GiftCardsService'));
  }
}
