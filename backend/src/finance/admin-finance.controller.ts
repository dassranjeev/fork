import { Body, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AdminController, CurrentUser, Permission } from '../common/decorators';
import { Action, ActorType, Module, PartyType, RefundStatus, UserType } from '../common/enums';
import { AuthUser } from '../common/auth.types';
import { Order, Refund } from '../database/entities';
import { PageQueryDto, like, paginateQb } from '../common/pagination';
import { AuditService } from '../audit/audit.service';
import { RefundsService } from '../orders/refunds.service';
import { PayoutsService, BatchQuery, LedgerQuery, PayoutQuery } from './payouts.service';
import { InvoicesService, InvoiceQuery } from './invoices.service';
import { PartiesService } from './parties.service';
import { StatementsService } from './statements.service';
import {
  BankDetailsDto,
  BankVerifyConfirmDto,
  GenerateBatchDto,
  HoldDto,
  ManualAdjustmentDto,
  PayoutAdjustDto,
  RefundDecisionDto,
  ResolveGapDto,
  VoidInvoiceDto,
} from './finance.dto';

function actorFor(user: AuthUser) {
  return { type: ActorType.STAFF, id: user.id, name: user.name };
}

/** SOP-07 weekly payout cycle, ledger explorer, HST reports, invoices, refunds approval queue (spec §8). */
@AdminController('finance')
export class AdminFinanceController {
  constructor(
    private payouts: PayoutsService,
    private invoicesSvc: InvoicesService,
    private parties: PartiesService,
    private statements: StatementsService,
    private refundsSvc: RefundsService,
    private audit: AuditService,
    @InjectRepository(Refund) private refunds: Repository<Refund>,
    @InjectRepository(Order) private orders: Repository<Order>,
  ) {}

  // ------------------------------------------------------------ dashboard
  @Get('dashboard')
  @Permission(Module.FINANCE, Action.VIEW)
  dashboard() {
    return this.payouts.dashboard();
  }

  // ------------------------------------------------------------ ledger explorer + manual adjustments
  @Get('ledger')
  @Permission(Module.FINANCE, Action.VIEW)
  ledger(@Query() q: LedgerQuery) {
    return this.payouts.ledgerList(q);
  }

  @Get('ledger/export/csv')
  @Permission(Module.FINANCE, Action.EXPORT)
  async ledgerExport(@Query() q: LedgerQuery) {
    return { filename: 'ledger.csv', csv: await this.payouts.ledgerExportCsv(q) };
  }

  @Post('adjustments')
  @Permission(Module.FINANCE, Action.EDIT)
  async addAdjustment(@Body() dto: ManualAdjustmentDto, @CurrentUser() user: AuthUser) {
    const res = await this.payouts.addAdjustment(dto, actorFor(user));
    await this.audit.log({ actor: user, action: 'finance.adjustment', entity: 'LedgerEntry', entityId: `${dto.partyType}:${dto.partyId}`, after: dto });
    return res;
  }

  // ------------------------------------------------------------ HST reports
  @Get('reports/hst')
  @Permission(Module.FINANCE, Action.VIEW)
  hst(@Query('from') from?: string, @Query('to') to?: string) {
    return this.invoicesSvc.hstReport(from, to);
  }

  // ------------------------------------------------------------ parties (bank details, holds)
  @Get('parties/:partyType/:partyId')
  @Permission(Module.FINANCE, Action.VIEW)
  partyInfo(@Param('partyType') partyType: PartyType, @Param('partyId') partyId: string) {
    return this.parties.info(partyType, partyId);
  }

  @Get('parties/:partyType/:partyId/bank')
  @Permission(Module.FINANCE, Action.VIEW)
  partyBank(@Param('partyType') partyType: PartyType, @Param('partyId') partyId: string) {
    return this.parties.bankView(partyType, partyId);
  }

  @Post('parties/:partyType/:partyId/bank')
  @Permission(Module.FINANCE, Action.EDIT)
  async updateBank(@Param('partyType') partyType: PartyType, @Param('partyId') partyId: string, @Body() dto: BankDetailsDto, @CurrentUser() user: AuthUser) {
    const res = await this.parties.updateBank(partyType, partyId, dto);
    await this.audit.log({ actor: user, action: 'finance.bank_update', entity: 'Party', entityId: `${partyType}:${partyId}` });
    return res;
  }

  @Patch('parties/:partyType/:partyId/hold')
  @Permission(Module.FINANCE, Action.EDIT)
  async setHold(@Param('partyType') partyType: PartyType, @Param('partyId') partyId: string, @Body('hold') hold: boolean, @Body() dto: HoldDto, @CurrentUser() user: AuthUser) {
    const res = await this.parties.setHold(partyType, partyId, !!hold, dto.reason);
    if (!hold) await this.payouts.releaseHeldForParty(partyType, partyId);
    await this.audit.log({ actor: user, action: hold ? 'finance.party_hold' : 'finance.party_unhold', entity: 'Party', entityId: `${partyType}:${partyId}`, after: { reason: dto.reason } });
    return res;
  }

  @Post('parties/:partyType/:partyId/bank/verify/initiate')
  @Permission(Module.FINANCE, Action.EDIT)
  initiateBankVerification(@Param('partyType') partyType: PartyType, @Param('partyId') partyId: string) {
    return this.parties.initiateVerification(partyType, partyId);
  }

  @Post('parties/:partyType/:partyId/bank/verify/confirm')
  @Permission(Module.FINANCE, Action.EDIT)
  confirmBankVerification(@Param('partyType') partyType: PartyType, @Param('partyId') partyId: string, @Body() dto: BankVerifyConfirmDto) {
    return this.parties.confirmVerification(partyType, partyId, dto.amounts);
  }

  // ------------------------------------------------------------ payout batches (SOP-07)
  @Get('batches')
  @Permission(Module.FINANCE, Action.VIEW)
  listBatches(@Query() q: BatchQuery) {
    return this.payouts.listBatches(q);
  }

  @Get('batches/:id')
  @Permission(Module.FINANCE, Action.VIEW)
  batchDetail(@Param('id') id: string) {
    return this.payouts.batchDetail(id);
  }

  @Post('batches/generate')
  @Permission(Module.FINANCE, Action.CREATE)
  async generateBatch(@Body() dto: GenerateBatchDto, @CurrentUser() user: AuthUser) {
    const batch = await this.payouts.generateBatch({ periodStart: dto.periodStart, periodEnd: dto.periodEnd, actor: actorFor(user) });
    await this.audit.log({ actor: user, action: 'finance.batch_generate', entity: 'PayoutBatch', entityId: batch.id, after: { periodStart: batch.periodStart, periodEnd: batch.periodEnd, total: batch.total } });
    return batch;
  }

  @Post('batches/:id/reconcile')
  @Permission(Module.FINANCE, Action.EDIT)
  reconcile(@Param('id') id: string) {
    return this.payouts.reconcileBatch(id);
  }

  @Post('batches/:id/resolve-gap')
  @Permission(Module.FINANCE, Action.APPROVE)
  async resolveGap(@Param('id') id: string, @Body() dto: ResolveGapDto, @CurrentUser() user: AuthUser) {
    const res = await this.payouts.resolveReconciliationGap(id, dto.notes, actorFor(user));
    await this.audit.log({ actor: user, action: 'finance.batch_resolve_gap', entity: 'PayoutBatch', entityId: id, after: { notes: dto.notes } });
    return res;
  }

  @Post('batches/:id/approve')
  @Permission(Module.FINANCE, Action.APPROVE)
  async approveBatch(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    const res = await this.payouts.approveBatch(id, actorFor(user));
    await this.audit.log({ actor: user, action: 'finance.batch_approve', entity: 'PayoutBatch', entityId: id, after: { total: res.total } });
    return res;
  }

  @Post('batches/:id/release')
  @Permission(Module.FINANCE, Action.APPROVE)
  async releaseBatch(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    const isSuperAdmin = user.type === UserType.SUPER_ADMIN;
    const res = await this.payouts.releaseBatch(id, actorFor(user), isSuperAdmin);
    await this.audit.log({ actor: user, action: 'finance.batch_release', entity: 'PayoutBatch', entityId: id, after: { total: res.total } });
    return res;
  }

  // ------------------------------------------------------------ payouts
  @Get('payouts')
  @Permission(Module.FINANCE, Action.VIEW)
  listPayouts(@Query() q: PayoutQuery) {
    return this.payouts.list(q);
  }

  @Get('payouts/export/csv')
  @Permission(Module.FINANCE, Action.EXPORT)
  async exportPayouts(@Query() q: PayoutQuery) {
    const { data } = await this.payouts.list({ ...q, page: 1, limit: 5000 });
    const header = 'partyType,partyName,periodStart,periodEnd,gross,deductions,fee,net,status,instant,paidAt\n';
    const body = data
      .map((p) => [p.partyType, p.partyName ?? '', p.periodStart, p.periodEnd, p.gross, p.deductions, p.fee, p.net, p.status, p.instant, p.paidAt ? new Date(p.paidAt).toISOString() : ''].join(','))
      .join('\n');
    return { csv: header + body };
  }

  @Get('payouts/:id')
  @Permission(Module.FINANCE, Action.VIEW)
  payoutDetail(@Param('id') id: string) {
    return this.payouts.detail(id);
  }

  @Post('payouts/:id/adjust')
  @Permission(Module.FINANCE, Action.EDIT)
  async adjustPayout(@Param('id') id: string, @Body() dto: PayoutAdjustDto, @CurrentUser() user: AuthUser) {
    const res = await this.payouts.adjustPayout(id, dto.amount, dto.reason, actorFor(user));
    await this.audit.log({ actor: user, action: 'finance.payout_adjust', entity: 'Payout', entityId: id, after: dto });
    return res;
  }

  @Post('payouts/:id/hold')
  @Permission(Module.FINANCE, Action.EDIT)
  async holdPayout(@Param('id') id: string, @Body() dto: HoldDto, @CurrentUser() user: AuthUser) {
    const res = await this.payouts.holdPayout(id, dto.reason ?? 'Manual hold');
    await this.audit.log({ actor: user, action: 'finance.payout_hold', entity: 'Payout', entityId: id, before: { status: res.before } });
    return res;
  }

  @Post('payouts/:id/release-hold')
  @Permission(Module.FINANCE, Action.EDIT)
  async releasePayoutHold(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    const res = await this.payouts.releaseHold(id);
    await this.audit.log({ actor: user, action: 'finance.payout_release_hold', entity: 'Payout', entityId: id, before: { status: res.before } });
    return res;
  }

  @Post('payouts/:id/retry')
  @Permission(Module.FINANCE, Action.EDIT)
  async retryPayout(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    const res = await this.payouts.payOne(id);
    await this.audit.log({ actor: user, action: 'finance.payout_retry', entity: 'Payout', entityId: id, after: { status: res.status } });
    return res;
  }

  // ------------------------------------------------------------ statements
  @Get('statements/:payoutId')
  @Permission(Module.FINANCE, Action.VIEW)
  statement(@Param('payoutId') payoutId: string) {
    return this.statements.payoutStatement(payoutId);
  }

  @Get('statements/:payoutId/csv')
  @Permission(Module.FINANCE, Action.EXPORT)
  statementCsv(@Param('payoutId') payoutId: string) {
    return this.statements.payoutStatementCsv(payoutId);
  }

  // ------------------------------------------------------------ invoices
  @Get('invoices')
  @Permission(Module.FINANCE, Action.VIEW)
  listInvoices(@Query() q: InvoiceQuery) {
    return this.invoicesSvc.list(q);
  }

  @Get('invoices/:id')
  @Permission(Module.FINANCE, Action.VIEW)
  invoiceDetail(@Param('id') id: string) {
    return this.invoicesSvc.get(id);
  }

  @Get('invoices/:id/download')
  @Permission(Module.FINANCE, Action.EXPORT)
  downloadInvoice(@Param('id') id: string, @Query('format') format: 'json' | 'csv' | 'html' = 'json') {
    return this.invoicesSvc.download(id, format);
  }

  @Post('invoices/:id/void')
  @Permission(Module.FINANCE, Action.EDIT)
  async voidInvoice(@Param('id') id: string, @Body() dto: VoidInvoiceDto, @CurrentUser() user: AuthUser) {
    const res = await this.invoicesSvc.void(id, dto.reason);
    await this.audit.log({ actor: user, action: 'finance.invoice_void', entity: 'Invoice', entityId: id, before: res.before, after: { reason: dto.reason } });
    return res.invoice;
  }

  // ------------------------------------------------------------ refunds approval queue (over-limit refunds; logic owned by RefundsService)
  @Get('refunds')
  @Permission(Module.FINANCE, Action.VIEW)
  async listRefunds(@Query() q: PageQueryDto & { status?: RefundStatus }) {
    const qb = this.refunds.createQueryBuilder('r');
    if (q.status) qb.andWhere('r.status = :st', { st: q.status });
    else qb.andWhere('r.status = :st', { st: RefundStatus.PENDING_APPROVAL });
    if (q.search) qb.andWhere('r.reasonCode ILIKE :s', { s: like(q.search) });
    const res = await paginateQb(qb, q, { sortable: { createdAt: 'r.createdAt', amount: 'r.amount' }, defaultSort: ['r.createdAt', 'DESC'] });
    const orderIds = [...new Set(res.data.map((r) => r.orderId))];
    const orders = orderIds.length ? await this.orders.createQueryBuilder('o').select(['o.id', 'o.code', 'o.restaurantId', 'o.customerId']).where('o.id IN (:...ids)', { ids: orderIds }).getMany() : [];
    const byId = new Map(orders.map((o) => [o.id, o]));
    return { ...res, data: res.data.map((r) => ({ ...r, order: byId.get(r.orderId) ? { code: byId.get(r.orderId)!.code } : null })) };
  }

  @Post('refunds/:id/approve')
  @Permission(Module.FINANCE, Action.APPROVE)
  async approveRefund(@Param('id') id: string, @Body() dto: RefundDecisionDto, @CurrentUser() user: AuthUser) {
    const refund = await this.refundsSvc.approve(id, { type: ActorType.STAFF, id: user.id, refundLimit: user.roleName === 'SUPER_ADMIN' ? null : user.refundLimit }, dto.notes);
    await this.audit.log({ actor: user, action: 'finance.refund_approve', entity: 'Refund', entityId: id, after: { amount: refund.amount } });
    return refund;
  }

  @Post('refunds/:id/reject')
  @Permission(Module.FINANCE, Action.APPROVE)
  async rejectRefund(@Param('id') id: string, @Body() dto: RefundDecisionDto, @CurrentUser() user: AuthUser) {
    const refund = await this.refundsSvc.reject(id, { type: ActorType.STAFF, id: user.id, refundLimit: user.roleName === 'SUPER_ADMIN' ? null : user.refundLimit }, dto.notes);
    await this.audit.log({ actor: user, action: 'finance.refund_reject', entity: 'Refund', entityId: id, after: { reason: dto.notes } });
    return refund;
  }
}
