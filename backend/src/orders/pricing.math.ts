import { FulfilmentMode } from '../common/enums';
import { ModuleRef } from '@nestjs/core';

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
export const cents = (n: number) => Math.round(n * 100);

export interface MoneyInputs {
  subtotal: number;
  /** sum of item-level tax (food) */
  foodTax: number;
  deliveryFee: number;
  serviceFee: number;
  smallOrderFee: number;
  tip: number;
  discountTotal: number;
  platformPromoAmount: number;
  restaurantPromoAmount: number;
  fulfilment: FulfilmentMode;
  /** tax rate applied to fees (percent, default HST 13) */
  feeTaxRatePct: number;
  taxOnDeliveryFee: boolean;
  taxOnFees: boolean;
  commissionPct: number;
}

export interface MoneyResult {
  feeTax: number;
  taxAmount: number;
  total: number;
  commissionAmount: number;
  restaurantPayout: number;
}

/**
 * The single money formula shared by PricingService.quote, item removal and the seed data.
 *  - HST on fees: delivery fee (platform-driver only) + service + small-order fee per settings taxes.*
 *  - commission = % of the FOOD subtotal
 *  - restaurant payout = food + food tax - commission - restaurant-funded promo (+ own-driver delivery fee)
 */
export function computeMoney(i: MoneyInputs): MoneyResult {
  const own = i.fulfilment === FulfilmentMode.OWN_DRIVER;
  const taxableFees =
    (i.taxOnDeliveryFee && !own ? i.deliveryFee : 0) + (i.taxOnFees ? i.serviceFee + i.smallOrderFee : 0);
  const feeTax = round2((taxableFees * i.feeTaxRatePct) / 100);
  const taxAmount = round2(i.foodTax + feeTax);
  const total = Math.max(
    0,
    round2(i.subtotal + i.deliveryFee + i.serviceFee + i.smallOrderFee + taxAmount + i.tip - i.discountTotal),
  );
  const commissionAmount = round2((i.subtotal * i.commissionPct) / 100);
  const restaurantPayout = Math.max(
    0,
    round2(i.subtotal + i.foodTax - commissionAmount - i.restaurantPromoAmount + (own ? i.deliveryFee : 0)),
  );
  return { feeTax, taxAmount, total, commissionAmount, restaurantPayout };
}

/** Resolve an optional provider that another module may not have registered (yet). */
export function lazyProvider<T>(moduleRef: ModuleRef, modulePath: string, className: string): T | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(modulePath);
    const token = mod?.[className];
    if (!token) return null;
    return moduleRef.get(token, { strict: false }) as T;
  } catch {
    return null;
  }
}
