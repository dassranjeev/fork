import { Order } from '../database/entities';
import { OrderStatus, FulfilmentMode } from '../common/enums';
import { DispatchMeta, OrderFlagConfig } from './dispatch.types';

export type FlagLevel = 'NONE' | 'AMBER' | 'RED';

export interface OrderFlag {
  flag: FlagLevel;
  reasons: string[];
  elapsedMin: number;
  /** minutes past the promised time (delivery ETA / ready time), null when not late */
  minutesLate: number | null;
}

const min = (a: Date | string | null | undefined, now: Date) => (a ? (now.getTime() - new Date(a).getTime()) / 60000 : null);

/**
 * Delay colour flags (spec 7 + SOP-04: act on every red flag within 2 minutes).
 *  PLACED     amber at 80% (max 2 min) of the accept window, red when exceeded
 *  kitchen    amber at 80% of the quoted prep time, red when past the ready time
 *  READY      amber at 80% of pickupOverdueMin, red beyond it
 *  on route   amber past the delivery ETA, red past ETA + grace (or very late)
 *  no driver  red when flagged unassigned or nobody assigned after food is due
 */
export function computeOrderFlag(o: Order, now: Date, cfg: OrderFlagConfig): OrderFlag {
  const reasons: string[] = [];
  let level: FlagLevel = 'NONE';
  const raise = (l: FlagLevel, reason: string) => {
    reasons.push(reason);
    if (l === 'RED') level = 'RED';
    else if (level === 'NONE') level = 'AMBER';
  };
  const elapsedMin = min(o.createdAt, now) ?? 0;
  let minutesLate: number | null = null;
  const d: DispatchMeta | undefined = o.meta?.dispatch;
  const platformDelivery = o.fulfilment === FulfilmentMode.PLATFORM_DRIVER;

  switch (o.status) {
    case OrderStatus.PLACED: {
      if (o.kitchenReleaseAt && !o.kitchenReleasedAt) break; // still held for the customer's cancellation window: nothing to flag
      const sec = (min(o.kitchenReleasedAt ?? o.createdAt, now) ?? 0) * 60;
      if (sec >= cfg.autoRejectSec) raise('RED', 'RESTAURANT_NOT_ACCEPTING');
      else if (sec >= Math.min(120, cfg.autoRejectSec * 0.8)) raise('AMBER', 'RESTAURANT_NOT_ACCEPTING');
      break;
    }
    case OrderStatus.ACCEPTED:
    case OrderStatus.DRIVER_ASSIGNED:
    case OrderStatus.PREPARING: {
      if (o.estimatedReadyAt) {
        const ready = new Date(o.estimatedReadyAt);
        const start = new Date(o.acceptedAt ?? o.createdAt);
        const total = (ready.getTime() - start.getTime()) / 60000;
        const used = (now.getTime() - start.getTime()) / 60000;
        if (now > ready) {
          raise('RED', 'KITCHEN_LATE');
          minutesLate = Math.round((now.getTime() - ready.getTime()) / 60000);
        } else if (total > 0 && used >= total * 0.8) raise('AMBER', 'KITCHEN_NEAR_DUE');
      }
      if (platformDelivery && !o.driverId) {
        if (o.estimatedReadyAt && now > new Date(o.estimatedReadyAt)) raise('RED', 'NO_DRIVER_AFTER_READY');
        else if (d && d.widenings >= 1 && d.state !== 'ESCALATED') raise('AMBER', 'WIDENED_SEARCH');
      }
      break;
    }
    case OrderStatus.READY: {
      const m = min(o.readyAt ?? o.updatedAt, now) ?? 0;
      if (m > cfg.pickupOverdueMin) {
        raise('RED', 'PICKUP_OVERDUE');
        minutesLate = Math.round(m);
      } else if (m >= cfg.pickupOverdueMin * 0.8) raise('AMBER', 'PICKUP_OVERDUE');
      if (platformDelivery && !o.driverId) raise(m > 2 ? 'RED' : 'AMBER', 'NO_DRIVER_AFTER_READY');
      break;
    }
    case OrderStatus.PICKED_UP:
    case OrderStatus.ON_THE_WAY: {
      const late = min(o.estimatedDeliveryAt, now);
      if (late !== null && late > 0) {
        minutesLate = Math.round(late);
        if (late >= cfg.veryLateMin) raise('RED', 'VERY_LATE');
        else if (late > cfg.lateGraceMin) raise('RED', 'DELIVERY_LATE');
        else raise('AMBER', 'DELIVERY_LATE');
      }
      break;
    }
    default:
      break;
  }
  if (o.unassignedFlag) raise('RED', 'NO_DRIVER');
  if (o.isLate && level === 'NONE') raise('AMBER', 'LATE');
  return { flag: level, reasons: [...new Set(reasons)], elapsedMin: Math.round(elapsedMin * 10) / 10, minutesLate };
}
