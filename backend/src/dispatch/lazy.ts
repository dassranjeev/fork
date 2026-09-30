import { ModuleRef } from '@nestjs/core';
import { IOrdersService, IPricingService, IRefundsService, IWalletService } from '../common/contracts';

/**
 * Resolve a provider owned by another module without a compile-time dependency (the owner may be a stub or
 * still be under construction). Returns null when the class file or provider does not exist.
 */
function resolve<T>(ref: ModuleRef, file: string, exportName: string): T | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const cls = require(file)?.[exportName];
    if (!cls) return null;
    return ref.get<T>(cls, { strict: false }) ?? null;
  } catch {
    return null;
  }
}

/** Cached lazy getters; a successful lookup is remembered, failures are retried on the next call. */
export class LazyServices {
  private cache: Record<string, any> = {};
  constructor(private ref: ModuleRef) {}

  private get<T>(key: string, file: string, name: string): T | null {
    if (this.cache[key]) return this.cache[key];
    const svc = resolve<T>(this.ref, file, name);
    if (svc) this.cache[key] = svc;
    return svc;
  }

  get orders(): IOrdersService | null {
    return this.get<IOrdersService>('orders', '../orders/orders.service', 'OrdersService');
  }
  get pricing(): IPricingService | null {
    return this.get<IPricingService>('pricing', '../orders/pricing.service', 'PricingService');
  }
  get refunds(): IRefundsService | null {
    return this.get<IRefundsService>('refunds', '../orders/refunds.service', 'RefundsService');
  }
  get wallet(): IWalletService | null {
    return this.get<IWalletService>('wallet', '../orders/wallet.service', 'WalletService');
  }
}
