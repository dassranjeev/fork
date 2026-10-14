import { DataSource, In } from 'typeorm';
import { randomUUID } from 'crypto';
import { SeedOptions } from '../database/seed-types';
import { DriverProfile, Invoice, LedgerEntry, Merchant, Order, Payout, PayoutBatch, TaxClass, User } from '../database/entities';
import { BatchStatus, LedgerType, PartyType, PayoutStatus, UserType } from '../common/enums';
import { CodesService } from '../core/core.module';
import { addDays, periodLabel, r2, torontoDate, torontoMidnight, weekday } from './finance.util';

function totalsOf(rows: { amount: number | string; type: string; orderId: string | null }[]) {
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

/**
 * Directly builds and pays a historical payout batch from whatever unpaid ledger activity exists before
 * `periodEnd` (no Nest DI context is available to a seed script, so this mirrors PayoutsService.generateBatch
 * + releaseBatch + execute at the SQL/repository level instead of calling the service).
 */
async function seedHistoricalBatch(ds: DataSource, periodStart: string, periodEnd: string, financeUserId: string | null, superAdminId: string | null) {
  const batches = ds.getRepository(PayoutBatch);
  if (await batches.findOne({ where: { periodStart, periodEnd } })) return;

  const ledger = ds.getRepository(LedgerEntry);
  const untilExclusive = torontoMidnight(addDays(periodEnd, 1));
  const rows = await ledger
    .createQueryBuilder('l')
    .where('l.partyType IN (:...pt) AND l.payoutId IS NULL AND l.createdAt < :until', { pt: [PartyType.RESTAURANT, PartyType.DRIVER], until: untilExclusive })
    .getMany();
  if (!rows.length) return;

  const groups = new Map<string, LedgerEntry[]>();
  for (const r of rows) {
    const k = `${r.partyType}:${r.partyId}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }

  const merchants = ds.getRepository(Merchant);
  const drivers = ds.getRepository(DriverProfile);
  const users = ds.getRepository(User);
  const orders = ds.getRepository(Order);
  const taxClasses = ds.getRepository(TaxClass);
  const invoices = ds.getRepository(Invoice);
  const codes = new CodesService(ds as any);

  const batchId = randomUUID();
  const payoutRows: Partial<Payout>[] = [];
  let totalRestaurants = 0;
  let totalDrivers = 0;
  let restaurantCount = 0;
  let driverCount = 0;

  for (const [key, groupRows] of groups) {
    const [partyType, partyId] = key.split(':') as [PartyType, string];
    const t = totalsOf(groupRows);
    if (t.net <= 0) continue; // carried forward - left untagged

    let partyName: string | null = null;
    if (partyType === PartyType.RESTAURANT) {
      const m = await merchants.findOne({ where: { id: partyId } });
      partyName = m?.businessName ?? null;
    } else {
      const d = await drivers.findOne({ where: { id: partyId } });
      const u = d ? await users.findOne({ where: { id: d.userId } }) : null;
      partyName = u ? `${u.firstName} ${u.lastName}`.trim() : null;
    }

    const id = randomUUID();
    payoutRows.push({
      id,
      batchId,
      partyType,
      partyId,
      partyName,
      periodStart,
      periodEnd,
      gross: t.gross,
      deductions: t.deductions,
      fee: 0,
      net: t.net,
      orderCount: t.orderCount,
      status: PayoutStatus.PAID,
      instant: false,
      method: 'EFT',
      externalRef: `mock_tr_${id.slice(0, 12)}`,
      approvedById: financeUserId,
      paidAt: torontoMidnight(addDays(periodEnd, 2)),
      statementSentAt: torontoMidnight(addDays(periodEnd, 2)),
    });
    await ledger.update({ id: In(groupRows.map((r) => r.id)) }, { payoutId: id });
    if (partyType === PartyType.RESTAURANT) {
      totalRestaurants = r2(totalRestaurants + t.net);
      restaurantCount++;
    } else {
      totalDrivers = r2(totalDrivers + t.net);
      driverCount++;
    }
  }
  if (!payoutRows.length) return;
  await ds.getRepository(Payout).insert(payoutRows as Payout[]);

  // payout ledger rows (money leaving the party) - mirrors PayoutsService.finalizePaid
  const payoutLedgerRows = payoutRows.map((p) => ({
    partyType: p.partyType,
    partyId: p.partyId,
    type: LedgerType.PAYOUT,
    amount: -Number(p.net),
    payoutId: p.id,
    description: `Payout ${periodLabel(periodStart, periodEnd)}`,
    meta: { externalRef: p.externalRef, seeded: true },
  }));
  if (payoutLedgerRows.length) await ledger.insert(payoutLedgerRows as any[]);

  const total = r2(totalRestaurants + totalDrivers);
  const batch = batches.create({
    id: batchId,
    periodStart,
    periodEnd,
    status: BatchStatus.COMPLETED,
    restaurantCount,
    driverCount,
    totalRestaurants,
    totalDrivers,
    total,
    requiresSuperAdmin: total > 250,
    reconciliation: { captured: total, stripeBalance: total, gap: 0, resolved: true, source: 'mock', checkedAt: new Date().toISOString() },
    createdById: financeUserId,
    approvedById: financeUserId,
    approvedAt: torontoMidnight(addDays(periodEnd, 1)),
    releasedById: superAdminId,
    releasedAt: torontoMidnight(addDays(periodEnd, 1)),
    summary: { seeded: true },
  });
  await batches.save(batch);

  // commission invoices for the restaurant payouts in this batch (mirrors InvoicesService.createForPayout)
  const hst = (await taxClasses.findOne({ where: { code: 'HST_ON' } }))?.ratePct ?? 13;
  const restaurantPayouts = payoutRows.filter((p) => p.partyType === PartyType.RESTAURANT);
  for (const p of restaurantPayouts) {
    const payoutRows2 = await ledger.find({ where: { payoutId: p.id } });
    const commission = r2(Math.abs(payoutRows2.filter((r) => r.type === LedgerType.COMMISSION).reduce((a, r) => a + Number(r.amount), 0)));
    if (commission <= 0) continue;
    const hstAmount = r2((commission * hst) / 100);
    const orderIds = [...new Set(payoutRows2.filter((r) => r.type === LedgerType.COMMISSION && r.orderId).map((r) => r.orderId!))];
    const os = orderIds.length ? await orders.createQueryBuilder('o').select(['o.id', 'o.code', 'o.subtotal']).where('o.id IN (:...ids)', { ids: orderIds }).getMany() : [];
    const byId = new Map(os.map((o) => [o.id, o]));
    const lines = payoutRows2
      .filter((r) => r.type === LedgerType.COMMISSION && r.orderId)
      .map((r) => ({ orderId: r.orderId!, code: byId.get(r.orderId!)?.code ?? '', subtotal: Number(byId.get(r.orderId!)?.subtotal ?? 0), commission: r2(Math.abs(Number(r.amount))) }));
    await invoices.save(
      invoices.create({
        number: await codes.invoiceNumber('INV'),
        merchantId: p.partyId!,
        payoutId: p.id!,
        periodStart,
        periodEnd,
        commissionAmount: commission,
        feeAmount: 0,
        hstAmount,
        total: r2(commission + hstAmount),
        forksyHstNumber: null,
        status: 'PAID',
        lines,
      }),
    );
  }
}

/** 1-2 paid historical payout batches + commission invoices, built from whatever seeded orders left in the ledger. Idempotent. */
export async function seedFinance(ds: DataSource, opts: SeedOptions): Promise<void> {
  if (!opts.demo) return;
  const users = ds.getRepository(User);
  const finance = await users.findOne({ where: { email: 'finance@forky.ca' } });
  const superAdmin = await users.findOne({ where: { type: UserType.SUPER_ADMIN } });

  const today = torontoDate();
  const thisMonday = addDays(today, -((weekday(today) + 6) % 7));
  // leave "last week" ungenerated so the live admin/cron flow has something to do; seed the two weeks before that.
  const weeks: [string, string][] = [
    [addDays(thisMonday, -21), addDays(thisMonday, -15)],
    [addDays(thisMonday, -14), addDays(thisMonday, -8)],
  ];
  for (const [periodStart, periodEnd] of weeks) {
    await seedHistoricalBatch(ds, periodStart, periodEnd, finance?.id ?? null, superAdmin?.id ?? null);
  }
}
