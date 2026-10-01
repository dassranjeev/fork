import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DriverOffer, DriverProfile } from '../database/entities';
import { SettingsService } from '../settings/settings.service';

export interface AcceptanceStats {
  rate: number;
  accepted: number;
  declined: number;
  expired: number;
  total: number;
  windowDays: number;
  since: string;
  lastUpdatedAt: string | null;
}

export interface AcceptanceConfig {
  windowDays: number;
  countExpired: boolean;
  minOffers: number;
  prior: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Pure formula. counted = accepted + declined + (expired when countExpired). Rate is 0..100.
 *   counted >= minOffers : rate = 100 * accepted / counted
 *   counted <  minOffers : w = counted / minOffers ; rate = w * (100 * accepted / counted) + (1 - w) * prior   (counted = 0 -> prior)
 */
export function acceptanceScore(accepted: number, declined: number, expired: number, cfg: Pick<AcceptanceConfig, 'countExpired' | 'minOffers' | 'prior'>): { rate: number; counted: number } {
  const counted = accepted + declined + (cfg.countExpired ? expired : 0);
  if (counted <= 0) return { rate: round2(cfg.prior), counted };
  const raw = (accepted / counted) * 100;
  if (counted >= cfg.minOffers) return { rate: round2(raw), counted };
  const w = counted / Math.max(1, cfg.minOffers);
  return { rate: round2(w * raw + (1 - w) * cfg.prior), counted };
}

/**
 * Rolling-window driver acceptance score. Single source of truth for `DriverProfile.acceptanceRate`:
 * recomputed live on every accept / decline / expiry and hourly for all drivers (so offers older than the window drop out).
 * Raw history stays in `driver_offers`; CANCELLED offers (system/ops withdrew them) and PENDING ones are ignored.
 */
@Injectable()
export class AcceptanceService {
  private readonly logger = new Logger('Acceptance');

  constructor(
    @InjectRepository(DriverProfile) private drivers: Repository<DriverProfile>,
    @InjectRepository(DriverOffer) private offers: Repository<DriverOffer>,
    private settings: SettingsService,
  ) {}

  config(): AcceptanceConfig {
    return {
      windowDays: Math.max(1, Number(this.settings.get('dispatch.acceptance.windowDays', 14)) || 14),
      countExpired: this.settings.get<boolean>('dispatch.acceptance.countExpiredAsDecline', true) !== false,
      minOffers: Math.max(1, Number(this.settings.get('dispatch.acceptance.minOffers', 5)) || 5),
      prior: Number(this.settings.get('dispatch.acceptance.priorRate', 90)),
    };
  }

  windowStart(days?: number): Date {
    return new Date(Date.now() - (days ?? this.config().windowDays) * 86_400_000);
  }

  /** Recompute one driver (or all when omitted) from `driver_offers` and persist on the profile. */
  async recompute(driverId?: string): Promise<number> {
    const cfg = this.config();
    const since = this.windowStart(cfg.windowDays);
    const qb = this.offers
      .createQueryBuilder('o')
      .select('o.driverId', 'driverId')
      .addSelect(`COUNT(*) FILTER (WHERE o.status = 'ACCEPTED')`, 'accepted')
      .addSelect(`COUNT(*) FILTER (WHERE o.status = 'DECLINED')`, 'declined')
      .addSelect(`COUNT(*) FILTER (WHERE o.status = 'EXPIRED')`, 'expired')
      .where(`o.status IN ('ACCEPTED','DECLINED','EXPIRED')`)
      .andWhere('COALESCE(o."respondedAt", o."expiresAt") >= :since', { since })
      .groupBy('o.driverId');
    if (driverId) qb.andWhere('o.driverId = :driverId', { driverId });
    const rows: { driverId: string; accepted: string; declined: string; expired: string }[] = await qb.getRawMany();
    const byDriver = new Map(rows.map((r) => [r.driverId, r]));
    const targets = driverId ? [driverId] : (await this.drivers.createQueryBuilder('d').select('d.id', 'id').getRawMany()).map((r: any) => r.id as string);
    const now = new Date();
    for (const id of targets) {
      const r = byDriver.get(id);
      const accepted = Number(r?.accepted ?? 0);
      const declined = Number(r?.declined ?? 0);
      const expired = Number(r?.expired ?? 0);
      const { rate } = acceptanceScore(accepted, declined, expired, cfg);
      await this.drivers.update(id, {
        acceptanceRate: rate,
        offersAccepted14d: accepted,
        offersDeclined14d: declined,
        offersExpired14d: expired,
        offersTotal14d: accepted + declined + expired,
        acceptanceUpdatedAt: now,
      });
    }
    return targets.length;
  }

  async recomputeSafe(driverId: string) {
    try {
      await this.recompute(driverId);
    } catch (e: any) {
      this.logger.warn(`acceptance recompute(${driverId}) failed: ${e.message}`);
    }
  }

  /** Hourly: lets offers older than the window drop out of every profile. */
  @Cron(CronExpression.EVERY_HOUR)
  async hourly() {
    try {
      const n = await this.recompute();
      this.logger.log(`acceptance recomputed for ${n} drivers`);
    } catch (e: any) {
      this.logger.warn(`hourly acceptance recompute failed: ${e.message}`);
    }
  }

  /** Shape exposed to the driver app and the admin console. */
  summary(p: DriverProfile): AcceptanceStats {
    const cfg = this.config();
    return {
      rate: Number(p.acceptanceRate),
      accepted: p.offersAccepted14d ?? 0,
      declined: p.offersDeclined14d ?? 0,
      expired: p.offersExpired14d ?? 0,
      total: p.offersTotal14d ?? 0,
      windowDays: cfg.windowDays,
      since: this.windowStart(cfg.windowDays).toISOString(),
      lastUpdatedAt: p.acceptanceUpdatedAt ? new Date(p.acceptanceUpdatedAt).toISOString() : null,
    };
  }

  /** Offer history inside the window (newest first). */
  async history(driverId: string, days?: number) {
    const since = this.windowStart(days && days > 0 ? Math.min(days, 365) : undefined);
    const countExpired = this.config().countExpired;
    const rows = await this.offers
      .createQueryBuilder('o')
      .leftJoin('orders', 'ord', 'ord.id = o.orderId')
      .select(['o.id AS id', 'o.orderId AS "orderId"', 'ord.code AS "orderCode"', 'o.status AS status', 'o.sentAt AS "sentAt"', 'o.expiresAt AS "expiresAt"', 'o.respondedAt AS "respondedAt"', 'o.declineReason AS "declineReason"', 'o.sequence AS sequence', 'o.pickupDistanceKm AS "pickupKm"', 'o.estimatedPay AS "estimatedPay"', 'o.score AS score'])
      .where('o.driverId = :driverId', { driverId })
      .andWhere(`o.status <> 'PENDING'`)
      .andWhere('COALESCE(o."respondedAt", o."expiresAt") >= :since', { since })
      .orderBy('o.sentAt', 'DESC')
      .limit(500)
      .getRawMany();
    return rows.map((r) => ({
      ...r,
      outcome: r.status,
      responseSec: r.respondedAt && r.status !== 'EXPIRED' ? Math.max(0, Math.round((new Date(r.respondedAt).getTime() - new Date(r.sentAt).getTime()) / 1000)) : null,
      countedInScore: r.status === 'ACCEPTED' || r.status === 'DECLINED' || (r.status === 'EXPIRED' && countExpired),
    }));
  }
}
