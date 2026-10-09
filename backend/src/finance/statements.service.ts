import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Invoice, LedgerEntry, Order, Payout } from '../database/entities';
import { LedgerType, PartyType } from '../common/enums';
import { PartiesService } from './parties.service';
import { periodLabel, r2, toCsv } from './finance.util';

const RESTAURANT_COLS: { key: string; label: string; types: LedgerType[] }[] = [
  { key: 'sale', label: 'Food sales + HST', types: [LedgerType.SALE] },
  { key: 'commission', label: 'Commission', types: [LedgerType.COMMISSION] },
  { key: 'promo', label: 'Restaurant promos', types: [LedgerType.RESTAURANT_PROMO] },
  { key: 'waitFee', label: 'Driver wait-time charges', types: [LedgerType.WAIT_FEE] },
  { key: 'refund', label: 'Refunds charged', types: [LedgerType.REFUND] },
  { key: 'adjustment', label: 'Adjustments', types: [LedgerType.ADJUSTMENT] },
];
const DRIVER_COLS: { key: string; label: string; types: LedgerType[] }[] = [
  { key: 'deliveryPay', label: 'Delivery pay', types: [LedgerType.DELIVERY_PAY] },
  { key: 'tip', label: 'Tips', types: [LedgerType.TIP] },
  { key: 'boost', label: 'Boosts / bonuses', types: [LedgerType.BOOST] },
  { key: 'waitFee', label: 'Wait-time pay', types: [LedgerType.WAIT_FEE] },
  { key: 'refund', label: 'Refunds charged', types: [LedgerType.REFUND] },
  { key: 'adjustment', label: 'Adjustments', types: [LedgerType.ADJUSTMENT] },
];

export interface StatementLine {
  orderId: string | null;
  orderCode: string | null;
  date: string;
  restaurantId: string | null;
  amounts: Record<string, number>;
  other: number;
  net: number;
  notes: string[];
}

@Injectable()
export class StatementsService {
  constructor(
    @InjectRepository(LedgerEntry) private ledger: Repository<LedgerEntry>,
    @InjectRepository(Order) private orders: Repository<Order>,
    @InjectRepository(Invoice) private invoices: Repository<Invoice>,
    private parties: PartiesService,
  ) {}

  columnsFor(partyType: PartyType) {
    return partyType === PartyType.DRIVER ? DRIVER_COLS : RESTAURANT_COLS;
  }

  /** Group ledger rows per order. */
  async linesFor(partyType: PartyType, rows: LedgerEntry[]): Promise<StatementLine[]> {
    const cols = this.columnsFor(partyType);
    const known = new Set(cols.flatMap((c) => c.types));
    const orderIds = [...new Set(rows.map((r) => r.orderId).filter(Boolean))];
    const codes: Record<string, string> = {};
    if (orderIds.length) {
      const os = await this.orders.createQueryBuilder('o').select(['o.id', 'o.code']).where('o.id IN (:...ids)', { ids: orderIds }).getMany();
      os.forEach((o) => (codes[o.id] = o.code));
    }
    const map = new Map<string, StatementLine>();
    for (const r of rows) {
      if (r.type === LedgerType.PAYOUT || r.type === LedgerType.INSTANT_FEE) continue;
      const k = r.orderId ?? `row:${r.id}`;
      let l = map.get(k);
      if (!l) {
        l = { orderId: r.orderId, orderCode: r.orderId ? codes[r.orderId] ?? null : null, date: r.createdAt.toISOString().slice(0, 10), restaurantId: r.restaurantId, amounts: Object.fromEntries(cols.map((c) => [c.key, 0])), other: 0, net: 0, notes: [] };
        map.set(k, l);
      }
      const col = cols.find((c) => c.types.includes(r.type));
      if (col && known.has(r.type)) l.amounts[col.key] = r2(l.amounts[col.key] + r.amount);
      else l.other = r2(l.other + r.amount);
      l.net = r2(l.net + r.amount);
      if (r.type === LedgerType.ADJUSTMENT && r.description) l.notes.push(r.description);
    }
    return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
  }

  private summarize(rows: LedgerEntry[]) {
    const byType: Record<string, number> = {};
    for (const r of rows) byType[r.type] = r2((byType[r.type] ?? 0) + r.amount);
    return byType;
  }

  async payoutStatement(payoutId: string, scope?: { partyId?: string }) {
    const payout = await this.payoutRepo().findOne({ where: { id: payoutId } });
    if (!payout || (scope?.partyId && payout.partyId !== scope.partyId)) throw new NotFoundException('Statement not found');
    const rows = await this.ledger.find({ where: { payoutId }, order: { createdAt: 'ASC' } });
    const info = await this.parties.info(payout.partyType, payout.partyId).catch(() => null);
    const invoice = await this.invoices.findOne({ where: { payoutId } });
    const lines = await this.linesFor(payout.partyType, rows);
    return {
      payout,
      party: { type: payout.partyType, id: payout.partyId, name: payout.partyName ?? info?.name ?? null },
      period: { start: payout.periodStart, end: payout.periodEnd, label: periodLabel(payout.periodStart, payout.periodEnd) },
      summary: {
        gross: payout.gross,
        deductions: payout.deductions,
        instantFee: payout.fee,
        net: payout.net,
        orderCount: payout.orderCount,
        byType: this.summarize(rows.filter((r) => r.type !== LedgerType.PAYOUT && r.type !== LedgerType.INSTANT_FEE)),
      },
      columns: this.columnsFor(payout.partyType).map((c) => ({ key: c.key, label: c.label })),
      lines,
      invoice: invoice ? { id: invoice.id, number: invoice.number, total: invoice.total, hstAmount: invoice.hstAmount, status: invoice.status } : null,
    };
  }

  payoutRepo(): Repository<Payout> {
    return this.ledger.manager.getRepository(Payout);
  }

  async payoutStatementCsv(payoutId: string, scope?: { partyId?: string }) {
    const s = await this.payoutStatement(payoutId, scope);
    const cols = s.columns;
    const rows = s.lines.map((l) => [l.date, l.orderCode ?? '', ...cols.map((c) => l.amounts[c.key]), l.other, l.net, l.notes.join('; ')]);
    rows.push(['TOTAL', '', ...cols.map((c) => r2(s.lines.reduce((a, l) => a + l.amounts[c.key], 0))), r2(s.lines.reduce((a, l) => a + l.other, 0)), s.summary.net + s.summary.instantFee, '']);
    if (s.summary.instantFee) rows.push(['INSTANT CASH-OUT FEE', '', ...cols.map(() => ''), '', -s.summary.instantFee, '']);
    return { filename: `statement-${s.party.type.toLowerCase()}-${s.period.start}_${s.period.end}.csv`, csv: toCsv(['Date', 'Order', ...cols.map((c) => c.label), 'Other', 'Net', 'Notes'], rows) };
  }

  /** Order-level ledger breakdown for a party in a date range (any payout status). */
  async orderBreakdown(partyType: PartyType, partyId: string, fromInstant: Date, toInstant: Date) {
    const rows = await this.ledger
      .createQueryBuilder('l')
      .where('l.partyType = :pt AND l.partyId = :pid AND l.createdAt >= :f AND l.createdAt < :t', { pt: partyType, pid: partyId, f: fromInstant, t: toInstant })
      .andWhere('l.type NOT IN (:...skip)', { skip: [LedgerType.PAYOUT, LedgerType.INSTANT_FEE] })
      .orderBy('l.createdAt', 'ASC')
      .getMany();
    const lines = await this.linesFor(partyType, rows);
    // attach payout status per order via first row
    const pay: Record<string, string> = {};
    const pids = [...new Set(rows.map((r) => r.payoutId).filter(Boolean))];
    if (pids.length) {
      const ps = await this.payoutRepo().createQueryBuilder('p').select(['p.id', 'p.status']).where('p.id IN (:...ids)', { ids: pids }).getMany();
      ps.forEach((p) => (pay[p.id] = p.status));
    }
    const status: Record<string, string> = {};
    for (const r of rows) status[r.orderId ?? `row:${r.id}`] = r.payoutId ? pay[r.payoutId] ?? 'IN_PAYOUT' : 'UNPAID';
    return { columns: this.columnsFor(partyType).map((c) => ({ key: c.key, label: c.label })), lines: lines.map((l) => ({ ...l, payoutStatus: status[l.orderId ?? ''] ?? 'UNPAID' })) };
  }

  breakdownCsv(b: Awaited<ReturnType<StatementsService['orderBreakdown']>>) {
    return toCsv(
      ['Date', 'Order', ...b.columns.map((c) => c.label), 'Other', 'Net', 'Payout status'],
      b.lines.map((l) => [l.date, l.orderCode ?? '', ...b.columns.map((c) => l.amounts[c.key]), l.other, l.net, l.payoutStatus]),
    );
  }
}
