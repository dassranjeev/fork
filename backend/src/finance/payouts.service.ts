import { BadGatewayException, BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DataSource, In, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { ActorRef, IPayoutsService, PayoutPaidEvent, Events } from '../common/contracts';
import { ActorType, BatchStatus, LedgerType, PartyType, PayoutStatus, RefundStatus } from '../common/enums';
import { City, DriverProfile, LedgerEntry, Merchant, Payment, Payout, PayoutBatch, Refund, Restaurant } from '../database/entities';
import { SettingsService } from '../settings/settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { LedgerService } from '../orders/ledger.service';
import { PageQueryDto, paginateQb } from '../common/pagination';
import { FinanceProviders } from './finance.providers';
import { InvoicesService } from './invoices.service';
import { PartiesService } from './parties.service';
import { addDays, assertDate, money, periodLabel, previousWeek, r2, returnedRows, toCsv, torontoDate, torontoMidnight, weekday } from './finance.util';

export interface PayoutQuery extends PageQueryDto {
  status?: string;
  partyType?: string;
  partyId?: string;
  batchId?: string;
  instant?: string;
  from?: string;
  to?: string;
}

export interface BatchQuery extends PageQueryDto {
  status?: string;
}

export interface LedgerQuery extends PageQueryDto {
  partyType?: string;
  partyId?: string;
  type?: string;
  orderId?: string;
  restaurantId?: string;
  payout?: 'paid' | 'unpaid';
  from?: string;
  to?: string;
}

interface Totals {
  gross: number;
  deductions: number;
  net: number;
  orderCount: number;
}

export function totalsOf(rows: { amount: number | string; type: string; orderId: string | null }[]): Totals {
  let gross = 0;
  let ded = 0;
  const orders = new Set<string>();
  for (const r of rows) {
    const a = Number(r.amount);
    if (a >= 0) gross += a;
    else ded += -a;
    if (r.orderId && (r.type === LedgerType.SALE || r.type === LedgerType.DELIVERY_PAY)) orders.add(r.orderId);
  }
  return { gross: r2(gross), deductions: r2(ded), net: r2(gross - ded), orderCount: orders.size };
}

@Injectable()
export class PayoutsService implements IPayoutsService {
  private readonly logger = new Logger(PayoutsService.name);
  private readonly inflight = new Set<string>();

  constructor(
    @InjectDataSource() private ds: DataSource,
    @InjectRepository(Payout) private payouts: Repository<Payout>,
    @InjectRepository(PayoutBatch) private batches: Repository<PayoutBatch>,
    @InjectRepository(LedgerEntry) private ledger: Repository<LedgerEntry>,
    @InjectRepository(Merchant) private merchants: Repository<Merchant>,
    @InjectRepository(DriverProfile) private drivers: Repository<DriverProfile>,
    @InjectRepository(Restaurant) private restaurants: Repository<Restaurant>,
    @InjectRepository(City) private cities: Repository<City>,
    @InjectRepository(Payment) private payments: Repository<Payment>,
    @InjectRepository(Refund) private refunds: Repository<Refund>,
    private settings: SettingsService,
    private notifications: NotificationsService,
    private events: EventEmitter2,
    private providers: FinanceProviders,
    private invoices: InvoicesService,
    private parties: PartiesService,
    private ledgerSvc: LedgerService,
  ) {}

  // ------------------------------------------------------------------ instant cash-out (drivers)
  async instantCashOut(driverId: string, actor: ActorRef): Promise<Payout> {
    if (!(await this.settings.isFeatureEnabled('instant_payouts'))) throw new ForbiddenException('Instant cash-out is currently unavailable');
    const driver = await this.drivers.findOne({ where: { id: driverId } });
    if (!driver) throw new NotFoundException('Driver not found');
    if (!driver.bank?.debitCardLast4 && !driver.bank?.accountLast4) throw new BadRequestException('Add a debit card or bank account before cashing out');
    if (driver.meta?.payoutHold) throw new ForbiddenException('Payouts are on hold for your account. Please contact support.');
    return this.createDirectPayout({ partyType: PartyType.DRIVER, partyId: driverId, instant: true, actor });
  }

  feeFor(amount: number): number {
    const pct = Number(this.settings.get('payments.instantPayoutFeePct', 1.5));
    const min = Number(this.settings.get('payments.instantPayoutFeeMin', 0.5));
    return r2(Math.max(min, (pct / 100) * amount));
  }

  /**
   * Pay a party's unpaid ledger balance right now (no batch): driver instant cash-out or a restaurant DAILY payout.
   * Rows are tagged with the new payout id inside a transaction (row locks prevent double spending).
   */
  async createDirectPayout(opts: { partyType: PartyType; partyId: string; instant?: boolean; untilExclusive?: Date; actor: ActorRef }): Promise<Payout> {
    const { partyType, partyId } = opts;
    const info = await this.parties.info(partyType, partyId);
    const pid = randomUUID();
    const today = torontoDate();
    const payout = await this.ds.transaction(async (em) => {
      const qb = em
        .getRepository(LedgerEntry)
        .createQueryBuilder('l')
        .setLock('pessimistic_write')
        .where('l.partyType = :pt AND l.partyId = :pid AND l.payoutId IS NULL', { pt: partyType, pid: partyId });
      if (opts.untilExclusive) qb.andWhere('l.createdAt < :until', { until: opts.untilExclusive });
      const rows = await qb.getMany();
      const t = totalsOf(rows);
      const fee = opts.instant ? this.feeFor(t.net) : 0;
      if (t.net <= 0 || t.net - fee < 0.01) throw new BadRequestException(opts.instant ? `Balance ${money(t.net)} is too low to cash out (fee ${money(fee)})` : 'Nothing to pay out');
      const p = em.getRepository(Payout).create({
        id: pid,
        partyType,
        partyId,
        partyName: info.name,
        periodStart: today,
        periodEnd: today,
        gross: t.gross,
        deductions: t.deductions,
        fee,
        net: r2(t.net - fee),
        orderCount: t.orderCount,
        status: PayoutStatus.RELEASED,
        instant: !!opts.instant,
        method: opts.instant ? 'DEBIT_CARD' : 'EFT',
        approvedById: opts.actor?.id ?? null,
        meta: { direct: true, actor: opts.actor?.type ?? 'SYSTEM', ledgerRows: rows.length },
      });
      await em.getRepository(Payout).insert(p as any);
      await em.getRepository(LedgerEntry).update({ id: In(rows.map((r) => r.id)) }, { payoutId: pid });
      return p;
    });
    return this.execute(payout.id, { untagOnFailure: true, throwOnFailure: true });
  }

  // ------------------------------------------------------------------ execute a released payout via the provider
  /**
   * Send the money (provider adapter), then book PAYOUT/INSTANT_FEE ledger rows, invoice, statement notification and event.
   * On failure: payout -> FAILED with reason (retryable for batch payouts; rows released back for direct payouts).
   */
  async execute(payoutId: string, opts: { untagOnFailure?: boolean; throwOnFailure?: boolean } = {}): Promise<Payout> {
    if (this.inflight.has(payoutId)) throw new ConflictException('Payout is already being processed');
    this.inflight.add(payoutId);
    try {
      const payout = await this.payouts.findOne({ where: { id: payoutId } });
      if (!payout) throw new NotFoundException('Payout not found');
      if (![PayoutStatus.RELEASED, PayoutStatus.FAILED].includes(payout.status)) throw new ConflictException(`Payout is ${payout.status}, only RELEASED or FAILED payouts can be sent`);
      const info = await this.parties.info(payout.partyType, payout.partyId);
      if (info.hold || !info.bankOk) {
        payout.status = PayoutStatus.ON_HOLD;
        payout.failureReason = info.hold ? `Payout hold: ${info.holdReason ?? 'manual hold'}` : 'Bank details are missing or not verified';
        await this.payouts.save(payout);
        if (opts.throwOnFailure) throw new BadRequestException(payout.failureReason);
        return payout;
      }
      try {
        const res = await this.providers.transfer(payout, info.stripeAccountId);
        return await this.finalizePaid(payout, res.ref);
      } catch (e: any) {
        const reason = String(e?.message ?? e).slice(0, 300);
        this.logger.warn(`Payout ${payout.id} failed: ${reason}`);
        payout.status = PayoutStatus.FAILED;
        payout.failureReason = reason;
        payout.meta = { ...(payout.meta ?? {}), failures: [...((payout.meta?.failures as any[]) ?? []), { at: new Date().toISOString(), reason }] };
        await this.payouts.save(payout);
        if (opts.untagOnFailure) await this.ledger.update({ payoutId: payout.id }, { payoutId: null });
        await this.notifications.notifyOps('finance.payout_failed', { party: payout.partyName ?? payout.partyId, amount: money(payout.net), reason }, { payoutId: payout.id });
        if (opts.throwOnFailure) throw new BadGatewayException(`Payout failed: ${reason}`);
        return payout;
      }
    } finally {
      this.inflight.delete(payoutId);
    }
  }

  private async finalizePaid(payout: Payout, ref: string): Promise<Payout> {
    await this.ds.transaction(async (em) => {
      const L = em.getRepository(LedgerEntry);
      const period = periodLabel(payout.periodStart, payout.periodEnd);
      const rows: Partial<LedgerEntry>[] = [
        { partyType: payout.partyType, partyId: payout.partyId, type: LedgerType.PAYOUT, amount: -payout.net, payoutId: payout.id, description: `Payout ${period}`, meta: { externalRef: ref } },
      ];
      if (payout.fee > 0) {
        rows.push({ partyType: payout.partyType, partyId: payout.partyId, type: LedgerType.INSTANT_FEE, amount: -payout.fee, payoutId: payout.id, description: 'Instant cash-out fee' });
        rows.push({ partyType: PartyType.PLATFORM, partyId: null, type: LedgerType.INSTANT_FEE, amount: payout.fee, payoutId: payout.id, description: `Instant cash-out fee (${payout.partyName ?? payout.partyId})` });
      }
      await L.insert(rows as any[]);
      payout.status = PayoutStatus.PAID;
      payout.paidAt = new Date();
      payout.externalRef = ref;
      payout.failureReason = null;
      await em.getRepository(Payout).save(payout);
    });
    // side effects never break the payout
    try {
      if (payout.partyType === PartyType.RESTAURANT) await this.invoices.createForPayout(payout);
      await this.sendStatement(payout);
    } catch (e: any) {
      this.logger.error(`post-payout tasks failed for ${payout.id}: ${e.message}`);
    }
    const ev: PayoutPaidEvent = { payoutId: payout.id, partyType: payout.partyType, partyId: payout.partyId, net: payout.net, fee: payout.fee, instant: payout.instant, batchId: payout.batchId };
    this.events.emit(Events.PAYOUT_PAID, ev);
    if (payout.partyType === PartyType.DRIVER) {
      await this.drivers.createQueryBuilder().update().set({ pendingBalance: () => 'GREATEST(0, "pendingBalance" - ' + Number(payout.gross - payout.deductions) + ')' }).where('id = :id', { id: payout.partyId }).execute().catch(() => undefined);
    }
    return payout;
  }

  /** Statement notification 'payout.sent' (order-level report + commission invoice are downloadable from the data link). */
  async sendStatement(payout: Payout) {
    const invoice = payout.partyType === PartyType.RESTAURANT ? await this.invoices['repo'].findOne({ where: { payoutId: payout.id } }) : null;
    await this.parties.notifyParty(
      payout.partyType,
      payout.partyId,
      'payout.sent',
      {
        amount: money(payout.net),
        period: periodLabel(payout.periodStart, payout.periodEnd),
        gross: money(payout.gross),
        deductions: money(payout.deductions),
        fee: money(payout.fee),
        orderCount: payout.orderCount,
        invoiceNumber: invoice?.number ?? '',
        invoiceTotal: invoice ? money(invoice.total) : '',
        hst: invoice ? money(invoice.hstAmount) : '',
        instant: payout.instant,
      },
      { payoutId: payout.id, invoiceId: invoice?.id ?? null, invoiceNumber: invoice?.number ?? null, statementPath: payout.partyType === PartyType.RESTAURANT ? `/restaurant/finance/statements/${payout.id}` : null },
    );
    payout.statementSentAt = new Date();
    await this.payouts.update(payout.id, { statementSentAt: payout.statementSentAt });
  }

  // ------------------------------------------------------------------ queries
  async list(q: PayoutQuery, scope?: { partyType?: PartyType; partyId?: string }) {
    const qb = this.payouts.createQueryBuilder('p');
    const pt = scope?.partyType ?? q.partyType;
    const pid = scope?.partyId ?? q.partyId;
    if (pt) qb.andWhere('p.partyType = :pt', { pt });
    if (pid) qb.andWhere('p.partyId = :pid', { pid });
    if (q.status) qb.andWhere('p.status = :st', { st: q.status });
    if (q.batchId) qb.andWhere('p.batchId = :b', { b: q.batchId });
    if (q.instant === 'true' || q.instant === '1') qb.andWhere('p.instant = true');
    if (q.instant === 'false' || q.instant === '0') qb.andWhere('p.instant = false');
    if (q.from) qb.andWhere('p.periodEnd >= :f', { f: q.from });
    if (q.to) qb.andWhere('p.periodStart <= :t', { t: q.to });
    if (q.search) qb.andWhere('p.partyName ILIKE :s', { s: `%${q.search}%` });
    return paginateQb(qb, q, {
      sortable: { createdAt: 'p.createdAt', net: 'p.net', gross: 'p.gross', periodStart: 'p.periodStart', partyName: 'p.partyName', status: 'p.status', paidAt: 'p.paidAt' },
      defaultSort: ['p.createdAt', 'DESC'],
    });
  }

  async detail(id: string, scope?: { partyType?: PartyType; partyId?: string }) {
    const p = await this.payouts.findOne({ where: { id } });
    if (!p || (scope?.partyId && (p.partyId !== scope.partyId || p.partyType !== scope.partyType))) throw new NotFoundException('Payout not found');
    const batch = p.batchId ? await this.batches.findOne({ where: { id: p.batchId } }) : null;
    const party = await this.parties.info(p.partyType, p.partyId).catch(() => null);
    const invoice = p.partyType === PartyType.RESTAURANT ? await this.invoices['repo'].findOne({ where: { payoutId: p.id } }) : null;
    return { ...p, batch: batch ? { id: batch.id, status: batch.status, periodStart: batch.periodStart, periodEnd: batch.periodEnd } : null, party, invoice };
  }

  // ------------------------------------------------------------------ admin payout actions
  /** Put a payout on hold (removes it from the release flow; ledger rows stay reserved). */
  async holdPayout(id: string, reason: string) {
    const p = await this.payouts.findOne({ where: { id } });
    if (!p) throw new NotFoundException('Payout not found');
    if ([PayoutStatus.PAID, PayoutStatus.ON_HOLD].includes(p.status)) throw new ConflictException(`Payout is ${p.status}`);
    const before = p.status;
    p.meta = { ...(p.meta ?? {}), heldFrom: before };
    p.status = PayoutStatus.ON_HOLD;
    p.failureReason = `Payout hold: ${reason}`;
    await this.payouts.save(p);
    await this.refreshBatch(p.batchId);
    return { before, payout: p };
  }

  /** Release a held payout back into the flow according to its batch stage. Does not clear a party-level hold. */
  async releaseHold(id: string) {
    const p = await this.payouts.findOne({ where: { id } });
    if (!p) throw new NotFoundException('Payout not found');
    if (p.status !== PayoutStatus.ON_HOLD) throw new ConflictException('Payout is not on hold');
    const info = await this.parties.info(p.partyType, p.partyId);
    if (info.hold) throw new ConflictException('The party is on a payout hold - release the party hold first');
    if (!info.bankOk) throw new ConflictException('Bank details are still missing / unverified');
    const batch = p.batchId ? await this.batches.findOne({ where: { id: p.batchId } }) : null;
    const before = p.status;
    if (!batch || [BatchStatus.RELEASED, BatchStatus.COMPLETED].includes(batch.status)) p.status = PayoutStatus.RELEASED;
    else if (batch.status === BatchStatus.APPROVED) p.status = PayoutStatus.APPROVED;
    else p.status = PayoutStatus.PENDING;
    p.failureReason = null;
    await this.payouts.save(p);
    await this.refreshBatch(p.batchId);
    return { before, payout: p };
  }

  /** Release every held payout of a party (used after clearing a party hold / verifying the bank). */
  async releaseHeldForParty(partyType: PartyType, partyId: string) {
    const held = await this.payouts.find({ where: { partyType, partyId, status: PayoutStatus.ON_HOLD } });
    const released: string[] = [];
    for (const p of held) {
      try {
        await this.releaseHold(p.id);
        released.push(p.id);
      } catch {
        /* still blocked */
      }
    }
    return released;
  }

  /** Pay one payout (retry after FAILED, or pay a payout released after being held). */
  async payOne(id: string) {
    const p = await this.payouts.findOne({ where: { id } });
    if (!p) throw new NotFoundException('Payout not found');
    if (!p.batchId && p.status === PayoutStatus.FAILED) throw new ConflictException('Direct payouts cannot be retried - request a new payout');
    if (p.batchId) {
      const b = await this.batches.findOne({ where: { id: p.batchId } });
      if (!b || ![BatchStatus.RELEASED, BatchStatus.COMPLETED].includes(b.status)) throw new ConflictException('The batch has not been released yet');
    }
    const res = await this.execute(id);
    await this.refreshBatch(p.batchId);
    return res;
  }

  /** Complete a released batch once nothing is waiting to be sent. */
  async refreshBatch(batchId: string | null) {
    if (!batchId) return;
    const b = await this.batches.findOne({ where: { id: batchId } });
    if (!b || ![BatchStatus.RELEASED, BatchStatus.COMPLETED].includes(b.status)) return;
    const waiting = await this.payouts.count({ where: { batchId, status: In([PayoutStatus.RELEASED, PayoutStatus.FAILED]) } });
    const target = waiting === 0 ? BatchStatus.COMPLETED : BatchStatus.RELEASED;
    if (b.status !== target) await this.batches.update(b.id, { status: target });
  }

  // ==================================================================== SOP-07 weekly payout cycle
  /**
   * Lock the unpaid ledger up to (periodEnd + 1 day) into a payout batch: one Payout per merchant / driver
   * with a positive balance (parties with a zero/negative balance are simply carried forward - their rows
   * stay untagged and are picked up by the next cycle). Idempotent per period: a batch already generated
   * for the same Mon..Sun range is returned unchanged.
   */
  async generateBatch(opts: { periodStart?: string; periodEnd?: string; actor?: ActorRef } = {}): Promise<PayoutBatch> {
    const period = opts.periodStart && opts.periodEnd ? { periodStart: opts.periodStart, periodEnd: opts.periodEnd } : previousWeek();
    assertDate(period.periodStart, 'periodStart');
    assertDate(period.periodEnd, 'periodEnd');
    const existing = await this.batches.findOne({ where: { periodStart: period.periodStart, periodEnd: period.periodEnd } });
    if (existing) return existing;

    const batchId = randomUUID();
    const untilExclusive = torontoMidnight(addDays(period.periodEnd, 1));
    const summary = await this.ds.transaction(async (em) => {
      const rows = await em
        .getRepository(LedgerEntry)
        .createQueryBuilder('l')
        .setLock('pessimistic_write')
        .where('l.partyType IN (:...pt) AND l.payoutId IS NULL AND l.createdAt < :until', { pt: [PartyType.RESTAURANT, PartyType.DRIVER], until: untilExclusive })
        .getMany();
      if (!rows.length) throw new BadRequestException('No unpaid ledger activity before this period - nothing to batch');

      const groups = new Map<string, LedgerEntry[]>();
      for (const r of rows) {
        const k = `${r.partyType}:${r.partyId}`;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k)!.push(r);
      }

      let totalRestaurants = 0;
      let totalDrivers = 0;
      let restaurantCount = 0;
      let driverCount = 0;
      let carriedForward = 0;
      const payoutRows: Partial<Payout>[] = [];
      const partyRefs: { type: PartyType; id: string }[] = [];
      for (const [key, groupRows] of groups) {
        const [partyType, partyId] = key.split(':') as [PartyType, string];
        const t = totalsOf(groupRows);
        if (t.net <= 0) {
          carriedForward++;
          continue; // owes the platform or nets to zero - left untagged for the next cycle
        }
        const info = await this.parties.info(partyType, partyId).catch(() => null);
        const id = randomUUID();
        payoutRows.push({
          id,
          batchId,
          partyType,
          partyId,
          partyName: info?.name ?? null,
          periodStart: period.periodStart,
          periodEnd: period.periodEnd,
          gross: t.gross,
          deductions: t.deductions,
          fee: 0,
          net: t.net,
          orderCount: t.orderCount,
          status: PayoutStatus.PENDING,
          instant: false,
          method: 'EFT',
        });
        await em.getRepository(LedgerEntry).update({ id: In(groupRows.map((r) => r.id)) }, { payoutId: id });
        if (partyType === PartyType.RESTAURANT) {
          totalRestaurants = r2(totalRestaurants + t.net);
          restaurantCount++;
        } else {
          totalDrivers = r2(totalDrivers + t.net);
          driverCount++;
        }
        partyRefs.push({ type: partyType, id: partyId });
      }
      if (!payoutRows.length) throw new BadRequestException('Every party in this period has a zero or negative balance - nothing to pay out');
      await em.getRepository(Payout).insert(payoutRows as Payout[]);
      return { totalRestaurants, totalDrivers, restaurantCount, driverCount, carriedForward, partyRefs };
    });

    const total = r2(summary.totalRestaurants + summary.totalDrivers);
    const threshold = await this.releaseThresholdFor(summary.partyRefs);
    const batch = this.batches.create({
      id: batchId,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      status: BatchStatus.LOCKED,
      restaurantCount: summary.restaurantCount,
      driverCount: summary.driverCount,
      totalRestaurants: summary.totalRestaurants,
      totalDrivers: summary.totalDrivers,
      total,
      requiresSuperAdmin: total > threshold,
      createdById: opts.actor?.id ?? null,
      summary: { carriedForwardParties: summary.carriedForward, releaseThreshold: threshold },
    });
    await this.batches.save(batch);
    await this.reconcileBatch(batch.id, period.periodStart, period.periodEnd);
    await this.notifications.notifyOps('finance.batch_ready', { period: periodLabel(period.periodStart, period.periodEnd), total: money(total) }, { batchId: batch.id });
    return this.batches.findOneOrFail({ where: { id: batch.id } });
  }

  /** Most conservative (lowest) release threshold among the cities the batch's parties operate in. */
  private async releaseThresholdFor(partyRefs: { type: PartyType; id: string }[]): Promise<number> {
    const merchantIds = partyRefs.filter((p) => p.type === PartyType.RESTAURANT).map((p) => p.id);
    const driverIds = partyRefs.filter((p) => p.type === PartyType.DRIVER).map((p) => p.id);
    const cityIds = new Set<string>();
    if (merchantIds.length) {
      const rows = await this.restaurants.createQueryBuilder('r').select('DISTINCT r.cityId', 'cityId').where('r.merchantId IN (:...ids)', { ids: merchantIds }).getRawMany<{ cityId: string | null }>();
      rows.forEach((r) => r.cityId && cityIds.add(r.cityId));
    }
    if (driverIds.length) {
      const rows = await this.drivers.createQueryBuilder('d').select('DISTINCT d.cityId', 'cityId').where('d.id IN (:...ids)', { ids: driverIds }).getRawMany<{ cityId: string | null }>();
      rows.forEach((r) => r.cityId && cityIds.add(r.cityId));
    }
    if (!cityIds.size) return 250;
    const cities = await this.cities.find({ where: { id: In([...cityIds]) } });
    if (!cities.length) return 250;
    return Math.min(...cities.map((c) => Number(c.payoutReleaseThreshold)));
  }

  /**
   * Stripe reconciliation: compares captured payments (net of refunds) against the provider's own balance
   * for the period. `payments.reconciliationToleranceCad` is the acceptable gap before it needs sign-off.
   */
  async reconcileBatch(batchId: string, periodStart?: string, periodEnd?: string): Promise<PayoutBatch> {
    const b = await this.batches.findOne({ where: { id: batchId } });
    if (!b) throw new NotFoundException('Batch not found');
    const ps = periodStart ?? b.periodStart;
    const pe = periodEnd ?? b.periodEnd;
    const from = torontoMidnight(ps);
    const to = torontoMidnight(addDays(pe, 1));
    const row = await this.payments
      .createQueryBuilder('p')
      .select(`COALESCE(SUM(CASE WHEN p.kind = 'CAPTURE' THEN p.amount WHEN p.kind = 'REFUND' THEN -p.amount ELSE 0 END), 0)`, 'net')
      .where('p.status = :st AND p.createdAt >= :from AND p.createdAt < :to', { st: 'SUCCEEDED', from, to })
      .getRawOne<{ net: string }>();
    const captured = r2(Number(row?.net ?? 0));
    const res = await this.providers.balanceFor(from, to, captured);
    const tolerance = Number(this.settings.get('payments.reconciliationToleranceCad', 1));
    const gap = r2(captured - res.net);
    b.reconciliation = { captured, stripeBalance: res.net, gap, resolved: Math.abs(gap) <= tolerance, source: res.source, checkedAt: new Date().toISOString(), error: res.error };
    await this.batches.save(b);
    if (!b.reconciliation.resolved) {
      await this.notifications.notifyOps('finance.reconciliation_gap', { period: periodLabel(ps, pe), gap: money(gap) }, { batchId });
    }
    return b;
  }

  /** Finance sign-off that an unresolved reconciliation gap is understood/accepted (small provider timing gaps etc). */
  async resolveReconciliationGap(batchId: string, notes: string, actor: ActorRef) {
    const b = await this.batches.findOne({ where: { id: batchId } });
    if (!b) throw new NotFoundException('Batch not found');
    if (!b.reconciliation) throw new BadRequestException('No reconciliation has been run for this batch');
    if (!notes?.trim()) throw new BadRequestException('Notes are required to resolve a reconciliation gap');
    b.reconciliation = { ...b.reconciliation, resolved: true, notes, resolvedById: actor.id ?? null };
    await this.batches.save(b);
    return b;
  }

  /** Manual adjustment to a single payout while its batch is still in draft (before Finance Manager approval). */
  /** Manual money movements above finance.maxManualAdjustment need a Super Admin; NaN / absurd values are refused outright. */
  private assertAdjustmentAllowed(amount: number, actor: ActorRef & { superAdmin?: boolean }) {
    if (!Number.isFinite(amount) || Math.abs(amount) > 1_000_000) throw new BadRequestException('Invalid adjustment amount');
    const max = Number(this.settings.get<number>('finance.maxManualAdjustment', 500));
    if (Math.abs(amount) > max && !(actor as any).superAdmin) throw new ForbiddenException(`Adjustments above $${max.toFixed(2)} need a Super Admin`);
  }

  async adjustPayout(payoutId: string, amount: number, reason: string, actor: ActorRef): Promise<Payout> {
    if (!reason?.trim()) throw new BadRequestException('A reason is required');
    const delta = r2(amount);
    if (!delta) throw new BadRequestException('Amount must not be zero');
    this.assertAdjustmentAllowed(delta, actor);
    const p = await this.payouts.findOne({ where: { id: payoutId } });
    if (!p) throw new NotFoundException('Payout not found');
    if (!p.batchId) throw new BadRequestException('Direct payouts cannot be adjusted - use a manual ledger adjustment instead');
    const batch = await this.batches.findOne({ where: { id: p.batchId } });
    if (!batch || ![BatchStatus.DRAFT, BatchStatus.LOCKED].includes(batch.status)) throw new ConflictException('The batch has already been approved - adjustments are no longer allowed');
    await this.ledger.insert({ partyType: p.partyType, partyId: p.partyId, orderId: null, type: LedgerType.ADJUSTMENT, amount: delta, description: reason, payoutId: p.id, meta: { manual: true, actorId: actor.id ?? null } } as any);
    if (delta >= 0) p.gross = r2(p.gross + delta);
    else p.deductions = r2(p.deductions - delta);
    p.net = r2(p.net + delta);
    await this.payouts.save(p);
    await this.refreshBatchTotals(batch.id);
    return p;
  }

  private async refreshBatchTotals(batchId: string) {
    const b = await this.batches.findOne({ where: { id: batchId } });
    if (!b) return;
    const rows = await this.payouts.find({ where: { batchId } });
    const totalRestaurants = r2(rows.filter((r) => r.partyType === PartyType.RESTAURANT).reduce((a, r) => a + Number(r.net), 0));
    const totalDrivers = r2(rows.filter((r) => r.partyType === PartyType.DRIVER).reduce((a, r) => a + Number(r.net), 0));
    b.totalRestaurants = totalRestaurants;
    b.totalDrivers = totalDrivers;
    b.total = r2(totalRestaurants + totalDrivers);
    const threshold = await this.releaseThresholdFor(rows.map((r) => ({ type: r.partyType, id: r.partyId })));
    b.requiresSuperAdmin = b.total > threshold;
    await this.batches.save(b);
  }

  /** Finance Manager approve: batch must be LOCKED and any reconciliation gap resolved. */
  async approveBatch(batchId: string, actor: ActorRef): Promise<PayoutBatch> {
    const b = await this.batches.findOne({ where: { id: batchId } });
    if (!b) throw new NotFoundException('Batch not found');
    if (b.status !== BatchStatus.LOCKED) throw new ConflictException(`Batch is ${b.status} - only a LOCKED batch can be approved`);
    if (b.reconciliation && b.reconciliation.resolved === false) throw new BadRequestException('Resolve the Stripe reconciliation gap before approving this batch');
    // atomic claim: concurrent approvals cannot both pass the status check
    const claim = await this.batches.createQueryBuilder().update(PayoutBatch).set({ status: BatchStatus.APPROVED, approvedById: actor.id ?? null, approvedAt: new Date() }).where('id = :id AND status = :s', { id: batchId, s: BatchStatus.LOCKED }).execute();
    if (!claim.affected) throw new ConflictException('This batch was just approved by someone else');
    b.status = BatchStatus.APPROVED;
    b.approvedById = actor.id ?? null;
    b.approvedAt = new Date();
    await this.payouts.update({ batchId, status: PayoutStatus.PENDING }, { status: PayoutStatus.APPROVED, approvedById: actor.id ?? null });
    return b;
  }

  /**
   * Super-Admin release above `City.payoutReleaseThreshold` (Finance Manager may release smaller batches).
   * Kicks off provider payment for every released payout (best-effort; failures stay retryable via `payOne`).
   */
  async releaseBatch(batchId: string, actor: ActorRef, isSuperAdmin: boolean): Promise<PayoutBatch> {
    const b = await this.batches.findOne({ where: { id: batchId } });
    if (!b) throw new NotFoundException('Batch not found');
    if (b.status !== BatchStatus.APPROVED) throw new ConflictException(`Batch is ${b.status} - only an APPROVED batch can be released`);
    if (b.requiresSuperAdmin && !isSuperAdmin) throw new ForbiddenException(`This batch's total (${money(b.total)}) is above the release threshold - only a Super Admin can release it`);
    // dual control (four eyes): whoever approved the batch may not also release it, unless they are a Super Admin
    if (this.settings.get<boolean>('finance.requireDualControl', false) && !isSuperAdmin && b.approvedById && actor.id && b.approvedById === actor.id) {
      throw new ForbiddenException('Dual control: a different person must release a batch you approved');
    }
    const claim = await this.batches.createQueryBuilder().update(PayoutBatch).set({ status: BatchStatus.RELEASED, releasedById: actor.id ?? null, releasedAt: new Date() }).where('id = :id AND status = :s', { id: batchId, s: BatchStatus.APPROVED }).execute();
    if (!claim.affected) throw new ConflictException('This batch was just released by someone else');
    b.status = BatchStatus.RELEASED;
    b.releasedById = actor.id ?? null;
    b.releasedAt = new Date();
    await this.payouts.update({ batchId, status: PayoutStatus.APPROVED }, { status: PayoutStatus.RELEASED });
    const toSend = await this.payouts.find({ where: { batchId, status: PayoutStatus.RELEASED } });
    for (const p of toSend) {
      await this.execute(p.id).catch((e) => this.logger.warn(`release payout ${p.id} failed: ${(e as Error).message}`));
    }
    await this.refreshBatch(batchId);
    return this.batches.findOneOrFail({ where: { id: batchId } });
  }

  async listBatches(q: BatchQuery) {
    const qb = this.batches.createQueryBuilder('b');
    if (q.status) qb.andWhere('b.status = :st', { st: q.status });
    return paginateQb(qb, q, { sortable: { periodStart: 'b.periodStart', total: 'b.total', createdAt: 'b.createdAt', status: 'b.status' }, defaultSort: ['b.periodStart', 'DESC'] });
  }

  async batchDetail(id: string) {
    const b = await this.batches.findOne({ where: { id } });
    if (!b) throw new NotFoundException('Batch not found');
    const payouts = await this.payouts.find({ where: { batchId: id }, order: { net: 'DESC' } });
    return { ...b, payouts };
  }

  // ==================================================================== scheduled jobs
  /** Weekly draft-batch cron: fires every day but only acts on the configured `payments.payoutWeekday`. */
  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async weeklyBatchCron() {
    try {
      const targetWeekday = Number(this.settings.get('payments.payoutWeekday', 3));
      if (weekday(torontoDate()) !== targetWeekday) return;
      const period = previousWeek();
      const existing = await this.batches.findOne({ where: period });
      if (existing) return;
      await this.generateBatch({ periodStart: period.periodStart, periodEnd: period.periodEnd, actor: { type: ActorType.SYSTEM } });
    } catch (e: any) {
      this.logger.error(`weekly batch cron failed: ${e.message}`);
    }
  }

  /** Daily instant payouts: restaurants on a DAILY payout schedule are paid out every day rather than waiting for the weekly batch. */
  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async dailyRestaurantPayoutsCron() {
    if (!this.settings.get<boolean>('payments.dailyPayoutsEnabled', true)) return;
    try {
      const rows = await this.restaurants.createQueryBuilder('r').select('DISTINCT r.merchantId', 'merchantId').where(`r.payoutSchedule = 'DAILY'`).getRawMany<{ merchantId: string }>();
      for (const { merchantId } of rows) {
        await this.createDirectPayout({ partyType: PartyType.RESTAURANT, partyId: merchantId, actor: { type: ActorType.SYSTEM } }).catch(() => undefined);
      }
    } catch (e: any) {
      this.logger.error(`daily restaurant payouts cron failed: ${e.message}`);
    }
  }

  // ==================================================================== ledger explorer / manual adjustments / dashboard
  async ledgerList(q: LedgerQuery) {
    const qb = this.ledger.createQueryBuilder('l');
    if (q.partyType) qb.andWhere('l.partyType = :pt', { pt: q.partyType });
    if (q.partyId) qb.andWhere('l.partyId = :pid', { pid: q.partyId });
    if (q.type) qb.andWhere('l.type = :ty', { ty: q.type });
    if (q.orderId) qb.andWhere('l.orderId = :oid', { oid: q.orderId });
    if (q.restaurantId) qb.andWhere('l.restaurantId = :rid', { rid: q.restaurantId });
    if (q.payout === 'paid') qb.andWhere('l.payoutId IS NOT NULL');
    if (q.payout === 'unpaid') qb.andWhere('l.payoutId IS NULL');
    if (q.from) qb.andWhere('l.createdAt >= :f', { f: q.from });
    if (q.to) qb.andWhere('l.createdAt <= :t', { t: q.to });
    if (q.search) qb.andWhere('l.description ILIKE :s', { s: `%${q.search}%` });
    const res = await paginateQb(qb, q, { sortable: { createdAt: 'l.createdAt', amount: 'l.amount' }, defaultSort: ['l.createdAt', 'DESC'] });
    const rNames = await this.parties.names(PartyType.RESTAURANT, res.data.filter((r) => r.partyType === PartyType.RESTAURANT).map((r) => r.partyId!));
    const dNames = await this.parties.names(PartyType.DRIVER, res.data.filter((r) => r.partyType === PartyType.DRIVER).map((r) => r.partyId!));
    return { ...res, data: res.data.map((r) => ({ ...r, partyName: r.partyType === PartyType.RESTAURANT ? rNames[r.partyId!] ?? null : r.partyType === PartyType.DRIVER ? dNames[r.partyId!] ?? null : null })) };
  }

  async ledgerExportCsv(q: LedgerQuery): Promise<string> {
    const { data } = await this.ledgerList({ ...q, page: 1, limit: 5000 });
    const rows = data.map((r: any) => [r.createdAt, r.partyType, r.partyName ?? '', r.type, r.amount, r.description ?? '', r.orderId ?? '', r.payoutId ?? '']);
    return toCsv(['Date', 'Party type', 'Party', 'Type', 'Amount', 'Description', 'Order', 'Payout'], rows);
  }

  /** Ad-hoc ledger adjustment outside the payout cycle (e.g. correcting a mistaken charge). Picked up by the next payout. */
  async addAdjustment(input: { partyType: PartyType; partyId: string; amount: number; reason: string; restaurantId?: string }, actor: ActorRef) {
    if (!input.reason?.trim()) throw new BadRequestException('A reason is required');
    const amount = r2(input.amount);
    if (!amount) throw new BadRequestException('Amount must not be zero');
    this.assertAdjustmentAllowed(amount, actor);
    await this.parties.info(input.partyType, input.partyId);
    await this.ledger.insert({ partyType: input.partyType, partyId: input.partyId, restaurantId: input.restaurantId ?? null, orderId: null, type: LedgerType.ADJUSTMENT, amount, description: input.reason, meta: { manual: true, actorId: actor.id ?? null } } as any);
    return { balance: await this.ledgerSvc.balance(input.partyType, input.partyId) };
  }

  async dashboard() {
    const [draftBatches, awaitingRelease, onHoldPayouts, failedPayouts, pendingRefunds] = await Promise.all([
      this.batches.count({ where: { status: In([BatchStatus.DRAFT, BatchStatus.LOCKED]) } }),
      this.batches.count({ where: { status: BatchStatus.APPROVED } }),
      this.payouts.count({ where: { status: PayoutStatus.ON_HOLD } }),
      this.payouts.count({ where: { status: PayoutStatus.FAILED } }),
      this.refunds.count({ where: { status: RefundStatus.PENDING_APPROVAL } }),
    ]);
    const unresolvedGaps = await this.batches.createQueryBuilder('b').where(`b.reconciliation ->> 'resolved' = 'false'`).getCount();
    const [platformBalance, unpaidRestaurants, unpaidDrivers] = await Promise.all([
      this.ledgerSvc.balance(PartyType.PLATFORM, null),
      this.ledger.createQueryBuilder('l').select('COALESCE(SUM(l.amount),0)', 'sum').where('l.partyType = :pt AND l.payoutId IS NULL', { pt: PartyType.RESTAURANT }).getRawOne<{ sum: string }>(),
      this.ledger.createQueryBuilder('l').select('COALESCE(SUM(l.amount),0)', 'sum').where('l.partyType = :pt AND l.payoutId IS NULL', { pt: PartyType.DRIVER }).getRawOne<{ sum: string }>(),
    ]);
    const monthStart = `${torontoDate().slice(0, 7)}-01`;
    const hstRow = await this.invoices['repo']
      .createQueryBuilder('i')
      .select('COALESCE(SUM(i.hstAmount),0)', 'hst')
      .where(`i.status != 'VOID' AND i.periodStart >= :m`, { m: monthStart })
      .getRawOne<{ hst: string }>();
    return {
      draftBatches,
      awaitingRelease,
      onHoldPayouts,
      failedPayouts,
      pendingRefundApprovals: pendingRefunds,
      unresolvedReconciliationGaps: unresolvedGaps,
      platformBalance,
      unpaidRestaurantBalance: r2(Number((unpaidRestaurants as any)?.sum ?? 0)),
      unpaidDriverBalance: r2(Number((unpaidDrivers as any)?.sum ?? 0)),
      hstCollectedThisMonth: r2(Number(hstRow?.hst ?? 0)),
    };
  }
}
