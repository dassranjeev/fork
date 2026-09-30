import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { LedgerEntry, Order, Restaurant } from '../database/entities';
import { FulfilmentMode, LedgerType, PartyType } from '../common/enums';
import { ILedgerService } from '../common/contracts';
import { round2 } from './pricing.math';

/**
 * Double-entry-ish ledger. Writes restaurant / driver / platform rows when an order
 * settles (DELIVERED / COLLECTED). Idempotent: a second call for the same order is a no-op.
 */
@Injectable()
export class LedgerService implements ILedgerService {
  private readonly logger = new Logger(LedgerService.name);

  constructor(
    @InjectDataSource() private ds: DataSource,
    @InjectRepository(LedgerEntry) private entries: Repository<LedgerEntry>,
    @InjectRepository(Restaurant) private restaurants: Repository<Restaurant>,
  ) {}

  async settleOrder(order: Order): Promise<void> {
    const already = await this.entries.count({ where: { orderId: order.id } });
    if (already > 0) return; // idempotent

    const restaurant = await this.restaurants.findOne({ where: { id: order.restaurantId } });
    const merchantId = restaurant?.merchantId ?? null;
    const rows: Partial<LedgerEntry>[] = [];

    // ---- restaurant: food + tax, minus commission and restaurant-funded promo
    if (merchantId) {
      rows.push({
        partyType: PartyType.RESTAURANT,
        partyId: merchantId,
        restaurantId: order.restaurantId,
        orderId: order.id,
        type: LedgerType.SALE,
        amount: round2(Number(order.subtotal) + Number(order.taxAmount)),
        description: `Order ${order.code}`,
      });
      if (Number(order.commissionAmount) > 0) {
        rows.push({
          partyType: PartyType.RESTAURANT,
          partyId: merchantId,
          restaurantId: order.restaurantId,
          orderId: order.id,
          type: LedgerType.COMMISSION,
          amount: -round2(Number(order.commissionAmount)),
          description: `Commission on ${order.code}`,
        });
      }
      if (Number(order.restaurantPromoAmount) > 0) {
        rows.push({
          partyType: PartyType.RESTAURANT,
          partyId: merchantId,
          restaurantId: order.restaurantId,
          orderId: order.id,
          type: LedgerType.RESTAURANT_PROMO,
          amount: -round2(Number(order.restaurantPromoAmount)),
          description: `Restaurant-funded promo on ${order.code}`,
        });
      }
      if (order.fulfilment === FulfilmentMode.OWN_DRIVER && Number(order.deliveryFee) > 0) {
        rows.push({
          partyType: PartyType.RESTAURANT,
          partyId: merchantId,
          restaurantId: order.restaurantId,
          orderId: order.id,
          type: LedgerType.SALE,
          amount: round2(Number(order.deliveryFee)),
          description: `Own-fleet delivery fee on ${order.code}`,
        });
      }
    }

    // ---- driver: delivery pay + 100% tip + any boost
    if (order.driverId && order.fulfilment === FulfilmentMode.PLATFORM_DRIVER) {
      if (Number(order.driverPay) > 0) {
        rows.push({
          partyType: PartyType.DRIVER,
          partyId: order.driverId,
          orderId: order.id,
          type: LedgerType.DELIVERY_PAY,
          amount: round2(Number(order.driverPay)),
          description: `Delivery pay for ${order.code}`,
        });
      }
      if (Number(order.tip) > 0) {
        rows.push({
          partyType: PartyType.DRIVER,
          partyId: order.driverId,
          orderId: order.id,
          type: LedgerType.TIP,
          amount: round2(Number(order.tip)),
          description: `Tip on ${order.code}`,
        });
      }
      if (Number(order.driverBoost) > 0) {
        rows.push({
          partyType: PartyType.DRIVER,
          partyId: order.driverId,
          orderId: order.id,
          type: LedgerType.BOOST,
          amount: round2(Number(order.driverBoost)),
          description: `Incentive boost on ${order.code}`,
        });
      }
    }

    // ---- platform: fees + commission revenue, minus platform-funded promo
    const feeRevenue = round2(Number(order.deliveryFee) * (order.fulfilment === FulfilmentMode.PLATFORM_DRIVER ? 1 : 0) + Number(order.serviceFee) + Number(order.smallOrderFee) - Number(order.platformPromoAmount));
    if (feeRevenue !== 0) {
      rows.push({
        partyType: PartyType.PLATFORM,
        partyId: null,
        orderId: order.id,
        type: LedgerType.FEE_REVENUE,
        amount: feeRevenue,
        description: `Fees on ${order.code}`,
      });
    }
    if (Number(order.commissionAmount) > 0) {
      rows.push({
        partyType: PartyType.PLATFORM,
        partyId: null,
        orderId: order.id,
        type: LedgerType.COMMISSION_REVENUE,
        amount: round2(Number(order.commissionAmount)),
        description: `Commission revenue on ${order.code}`,
      });
    }

    if (!rows.length) return;
    await this.entries.insert(rows as LedgerEntry[]);
    this.logger.debug(`Settled ledger for order ${order.code} (${rows.length} rows)`);
  }

  async balance(partyType: PartyType, partyId: string | null): Promise<number> {
    const qb = this.entries
      .createQueryBuilder('l')
      .select('COALESCE(SUM(l.amount), 0)', 'sum')
      .where('l.partyType = :partyType', { partyType })
      .andWhere('l.payoutId IS NULL');
    if (partyId == null) qb.andWhere('l.partyId IS NULL');
    else qb.andWhere('l.partyId = :partyId', { partyId });
    const row = await qb.getRawOne<{ sum: string }>();
    return round2(Number(row?.sum ?? 0));
  }

  async add(entry: {
    partyType: PartyType;
    partyId: string | null;
    restaurantId?: string | null;
    orderId?: string | null;
    type: LedgerType;
    amount: number;
    description?: string;
    meta?: Record<string, any>;
  }): Promise<void> {
    await this.entries.insert({
      partyType: entry.partyType,
      partyId: entry.partyId,
      restaurantId: entry.restaurantId ?? null,
      orderId: entry.orderId ?? null,
      type: entry.type,
      amount: round2(entry.amount),
      description: entry.description ?? null,
      meta: entry.meta ?? null,
    });
  }
}
