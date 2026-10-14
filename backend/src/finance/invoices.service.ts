import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Invoice, LedgerEntry, Merchant, Order, OrderItem, Payout, TaxClass } from '../database/entities';
import { LedgerType, OrderStatus } from '../common/enums';
import { CodesService } from '../core/core.module';
import { SettingsService } from '../settings/settings.service';
import { PageQueryDto, paginateQb } from '../common/pagination';
import { periodLabel, r2, toCsv } from './finance.util';

export interface InvoiceQuery extends PageQueryDto {
  merchantId?: string;
  status?: string;
  from?: string;
  to?: string;
}

@Injectable()
export class InvoicesService {
  constructor(
    @InjectRepository(Invoice) private repo: Repository<Invoice>,
    @InjectRepository(LedgerEntry) private ledger: Repository<LedgerEntry>,
    @InjectRepository(Order) private orders: Repository<Order>,
    @InjectRepository(Merchant) private merchants: Repository<Merchant>,
    @InjectRepository(TaxClass) private taxClasses: Repository<TaxClass>,
    private codes: CodesService,
    private settings: SettingsService,
  ) {}

  async hstRate(): Promise<number> {
    const t = await this.taxClasses.findOne({ where: { code: 'HST_ON' } });
    return t?.ratePct ?? 13;
  }

  /** Commission invoice (with FORKY's HST) for a restaurant payout. Idempotent per payout. */
  async createForPayout(payout: Payout, status: Invoice['status'] = 'PAID'): Promise<Invoice | null> {
    const existing = await this.repo.findOne({ where: { payoutId: payout.id } });
    if (existing) return existing;
    const rows = await this.ledger.find({ where: { payoutId: payout.id } });
    const commission = r2(Math.abs(rows.filter((r) => r.type === LedgerType.COMMISSION).reduce((a, r) => a + r.amount, 0)));
    const fees = r2(Math.abs(rows.filter((r) => r.type === LedgerType.INSTANT_FEE).reduce((a, r) => a + r.amount, 0)));
    if (commission + fees <= 0) return null;
    const rate = await this.hstRate();
    const hst = r2(((commission + fees) * rate) / 100);
    const orderIds = [...new Set(rows.filter((r) => r.type === LedgerType.COMMISSION && r.orderId).map((r) => r.orderId!))];
    const orders = orderIds.length ? await this.orders.createQueryBuilder('o').select(['o.id', 'o.code', 'o.subtotal']).where('o.id IN (:...ids)', { ids: orderIds }).getMany() : [];
    const byId = new Map(orders.map((o) => [o.id, o]));
    const lines = rows
      .filter((r) => r.type === LedgerType.COMMISSION && r.orderId)
      .map((r) => ({ orderId: r.orderId!, code: byId.get(r.orderId!)?.code ?? '', subtotal: byId.get(r.orderId!)?.subtotal ?? 0, commission: r2(Math.abs(r.amount)) }));
    const inv = this.repo.create({
      number: await this.codes.invoiceNumber('INV'),
      merchantId: payout.partyId,
      payoutId: payout.id,
      periodStart: payout.periodStart,
      periodEnd: payout.periodEnd,
      commissionAmount: commission,
      feeAmount: fees,
      hstAmount: hst,
      total: r2(commission + fees + hst),
      forksyHstNumber: this.settings.get<string>('general.forksyHstNumber', '') || null,
      status,
      lines,
    });
    return this.repo.save(inv);
  }

  async list(q: InvoiceQuery, scope?: { merchantId?: string }) {
    const qb = this.repo.createQueryBuilder('i');
    const mid = scope?.merchantId ?? q.merchantId;
    if (mid) qb.andWhere('i.merchantId = :mid', { mid });
    if (q.status) qb.andWhere('i.status = :st', { st: q.status });
    if (q.from) qb.andWhere('i.periodStart >= :f', { f: q.from });
    if (q.to) qb.andWhere('i.periodEnd <= :t', { t: q.to });
    if (q.search) qb.andWhere('i.number ILIKE :s', { s: `%${q.search}%` });
    const res = await paginateQb(qb, q, { sortable: { createdAt: 'i.createdAt', number: 'i.number', total: 'i.total', periodStart: 'i.periodStart' }, defaultSort: ['i.createdAt', 'DESC'] });
    const ids = [...new Set(res.data.map((i) => i.merchantId))];
    const names: Record<string, string> = {};
    if (ids.length) (await this.merchants.createQueryBuilder('m').select(['m.id', 'm.businessName']).where('m.id IN (:...ids)', { ids }).getMany()).forEach((m) => (names[m.id] = m.businessName));
    return { ...res, data: res.data.map((i) => ({ ...i, merchantName: names[i.merchantId] ?? null })) };
  }

  async get(id: string, scope?: { merchantId?: string }) {
    const inv = await this.repo.findOne({ where: { id } });
    if (!inv || (scope?.merchantId && inv.merchantId !== scope.merchantId)) throw new NotFoundException('Invoice not found');
    const m = await this.merchants.findOne({ where: { id: inv.merchantId } });
    return {
      ...inv,
      merchant: m ? { id: m.id, businessName: m.businessName, legalName: m.legalName, hstNumber: m.hstNumber } : null,
      issuer: { name: this.settings.get<string>('general.legalName', 'FORKY Inc.'), hstNumber: inv.forksyHstNumber },
      period: periodLabel(inv.periodStart, inv.periodEnd),
      hstRatePct: inv.commissionAmount + inv.feeAmount > 0 ? r2((inv.hstAmount / (inv.commissionAmount + inv.feeAmount)) * 100) : 0,
    };
  }

  async download(id: string, format: 'json' | 'csv' | 'html', scope?: { merchantId?: string }) {
    const inv = await this.get(id, scope);
    if (format === 'csv') {
      const rows = [
        ...inv.lines.map((l) => [l.code, l.subtotal, l.commission]),
        [],
        ['Commission', '', inv.commissionAmount],
        ['Fees', '', inv.feeAmount],
        [`HST (${inv.hstRatePct}%) #${inv.forksyHstNumber ?? ''}`, '', inv.hstAmount],
        ['TOTAL', '', inv.total],
      ];
      return { type: 'text/csv', filename: `${inv.number}.csv`, body: toCsv(['Order', 'Food subtotal', 'Commission'], rows) };
    }
    if (format === 'html') {
      const esc = (s: any) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
      const body = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(inv.number)}</title><style>body{font-family:Arial;margin:32px}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:6px;text-align:left}.r{text-align:right}</style></head><body>
<h2>${esc(inv.issuer.name)} - Tax invoice ${esc(inv.number)}</h2><p>HST registration #: ${esc(inv.forksyHstNumber ?? 'pending')}<br>Billed to: ${esc(inv.merchant?.legalName ?? inv.merchant?.businessName)} (HST # ${esc(inv.merchant?.hstNumber ?? '-')})<br>Period: ${esc(inv.period)} &middot; Status: ${esc(inv.status)}</p>
<table><tr><th>Order</th><th class="r">Food subtotal</th><th class="r">Commission</th></tr>${inv.lines.map((l) => `<tr><td>${esc(l.code)}</td><td class="r">${l.subtotal.toFixed(2)}</td><td class="r">${l.commission.toFixed(2)}</td></tr>`).join('')}</table>
<p class="r">Commission: $${inv.commissionAmount.toFixed(2)}<br>Fees: $${inv.feeAmount.toFixed(2)}<br>HST (${inv.hstRatePct}%): $${inv.hstAmount.toFixed(2)}<br><b>Total: $${inv.total.toFixed(2)} CAD</b></p></body></html>`;
      return { type: 'text/html', filename: `${inv.number}.html`, body };
    }
    return { type: 'application/json', filename: `${inv.number}.json`, body: JSON.stringify(inv, null, 2) };
  }

  /** HST reports (spec: collected / by tax class / month). "Customer" HST is what shoppers paid on orders;
   *  "FORKY" HST is what FORKY itself charges restaurants on its commission/fee invoices. */
  async hstReport(from?: string, to?: string) {
    const settled = [OrderStatus.DELIVERED, OrderStatus.COLLECTED];

    const byMonthQb = this.orders.createQueryBuilder('o').where('o.status IN (:...st)', { st: settled });
    if (from) byMonthQb.andWhere('o.createdAt >= :f', { f: from });
    if (to) byMonthQb.andWhere('o.createdAt <= :t', { t: to });
    const byMonth = await byMonthQb
      .select(`to_char(o.createdAt, 'YYYY-MM')`, 'month')
      .addSelect('COALESCE(SUM(o.taxAmount),0)', 'tax')
      .addSelect('COALESCE(SUM(o.subtotal),0)', 'subtotal')
      .groupBy(`to_char(o.createdAt, 'YYYY-MM')`)
      .orderBy(`to_char(o.createdAt, 'YYYY-MM')`, 'ASC')
      .getRawMany<{ month: string; tax: string; subtotal: string }>();

    const byClassQb = this.orders.manager
      .createQueryBuilder()
      .from(OrderItem, 'oi')
      .innerJoin(Order, 'o', 'o.id = oi.orderId')
      .where('o.status IN (:...st)', { st: settled });
    if (from) byClassQb.andWhere('o.createdAt >= :f', { f: from });
    if (to) byClassQb.andWhere('o.createdAt <= :t', { t: to });
    const byClass = await byClassQb
      .select('oi.taxClassCode', 'taxClass')
      .addSelect('COALESCE(SUM(oi.taxAmount),0)', 'tax')
      .addSelect('COALESCE(SUM(oi.lineTotal),0)', 'base')
      .groupBy('oi.taxClassCode')
      .getRawMany<{ taxClass: string | null; tax: string; base: string }>();

    const forksyQb = this.repo.createQueryBuilder('i').where(`i.status != 'VOID'`);
    if (from) forksyQb.andWhere('i.periodStart >= :f', { f: from });
    if (to) forksyQb.andWhere('i.periodEnd <= :t', { t: to });
    const forksyByMonth = await forksyQb
      .select(`to_char(i.periodStart, 'YYYY-MM')`, 'month')
      .addSelect('COALESCE(SUM(i.hstAmount),0)', 'hst')
      .addSelect('COALESCE(SUM(i.commissionAmount + i.feeAmount),0)', 'base')
      .groupBy(`to_char(i.periodStart, 'YYYY-MM')`)
      .orderBy(`to_char(i.periodStart, 'YYYY-MM')`, 'ASC')
      .getRawMany<{ month: string; hst: string; base: string }>();

    return {
      customerHstByMonth: byMonth.map((r) => ({ month: r.month, tax: r2(Number(r.tax)), subtotal: r2(Number(r.subtotal)) })),
      customerHstByTaxClass: byClass.map((r) => ({ taxClass: r.taxClass ?? 'UNSPECIFIED', tax: r2(Number(r.tax)), base: r2(Number(r.base)) })),
      forksyHstByMonth: forksyByMonth.map((r) => ({ month: r.month, hst: r2(Number(r.hst)), base: r2(Number(r.base)) })),
    };
  }

  async void(id: string, reason: string) {
    if (!reason || reason.trim().length < 3) throw new BadRequestException('A void reason is required');
    const inv = await this.repo.findOne({ where: { id } });
    if (!inv) throw new NotFoundException('Invoice not found');
    if (inv.status === 'VOID') throw new ConflictException('Invoice is already void');
    const before = { status: inv.status };
    inv.status = 'VOID';
    inv.voidReason = reason.trim();
    inv.voidedAt = new Date();
    await this.repo.save(inv);
    return { before, invoice: inv };
  }
}
