import { Body, Delete, Get, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { AdminController, CurrentUser, Permission } from '../common/decorators';
import { Action, Module as Mod, RefundStatus, TicketStatus, UserType } from '../common/enums';
import { AuthUser } from '../common/auth.types';
import { CannedReply, Refund, ReviewCase, Ticket } from '../database/entities';
import { PageQueryDto, paginateQb } from '../common/pagination';
import { AuditService } from '../audit/audit.service';
import { renderTemplate } from '../notifications/notifications.service';
import { TicketsService } from './tickets.service';
import { OrderContextService } from './order-context.service';
import { RefundGateway } from './refund-gateway.service';
import { ReviewCasesService } from './review-cases.service';
import { REASON_CODES } from './support.constants';
import {
  AddEvidenceDto,
  AppealDecisionDto,
  ApproveRefundDto,
  AssignTicketDto,
  CannedReplyDto,
  UpdateCannedReplyDto,
  CannedReplyQueryDto,
  CloseTicketDto,
  CreateTicketDto,
  DecideCaseDto,
  EscalateTicketDto,
  FinalPayoutDto,
  OpenReviewCaseDto,
  RefundFromTicketDto,
  RejectRefundDto,
  ReopenTicketDto,
  ResolveTicketDto,
  ReviewCaseQueryDto,
  SendNoticeDto,
  SetStatusDto,
  TicketMessageDto,
  TicketQueueDto,
  UpdateTicketDto,
} from './dto';

/** SOP-06 support desk + SOP-08 review cases + KPIs (spec §9). */
@AdminController('support')
export class AdminSupportController {
  constructor(
    private tickets: TicketsService,
    private orderContext: OrderContextService,
    private refundGateway: RefundGateway,
    private reviewCases: ReviewCasesService,
    private audit: AuditService,
    @InjectRepository(CannedReply) private canned: Repository<CannedReply>,
    @InjectRepository(Refund) private refunds: Repository<Refund>,
    @InjectRepository(ReviewCase) private cases: Repository<ReviewCase>,
    @InjectRepository(Ticket) private ticketRepo: Repository<Ticket>,
  ) {}

  private refundActor(user: AuthUser) {
    return { type: this.tickets.actorType('STAFF'), id: user.id, name: user.name, staff: true, refundLimit: user.type === UserType.SUPER_ADMIN ? null : user.refundLimit ?? null };
  }

  // ------------------------------------------------------------------ tickets
  @Get('tickets')
  @Permission(Mod.SUPPORT, Action.VIEW)
  queue(@Query() q: TicketQueueDto, @CurrentUser() user: AuthUser) {
    return this.tickets.queue(q, user);
  }

  @Get('tickets/counts')
  @Permission(Mod.SUPPORT, Action.VIEW)
  counts(@CurrentUser() user: AuthUser) {
    return this.tickets.counts(user);
  }

  @Get('tickets/agents')
  @Permission(Mod.SUPPORT, Action.VIEW)
  agents() {
    return this.tickets.agents();
  }

  @Get('reason-codes')
  @Permission(Mod.SUPPORT, Action.VIEW)
  reasonCodes() {
    return REASON_CODES;
  }

  @Get('tickets/:id')
  @Permission(Mod.SUPPORT, Action.VIEW)
  async detail(@Param('id') id: string) {
    const ticket = await this.tickets.get(id);
    const [messages, orderContext] = await Promise.all([
      this.tickets.listMessages(id, true),
      ticket.orderId ? this.orderContext.context(ticket.orderId) : null,
    ]);
    const suggestion = ticket.orderId ? await this.orderContext.suggest(ticket.orderId, ticket.category, (ticket.meta?.itemIds as string[]) ?? []) : null;
    const [decorated] = await this.tickets.decorate([ticket]);
    return { ticket: decorated, messages, orderContext, suggestion };
  }

  @Post('tickets')
  @Permission(Mod.SUPPORT, Action.CREATE)
  createTicket(@Body() dto: CreateTicketDto, @CurrentUser() user: AuthUser) {
    return this.tickets.create({ requesterType: 'STAFF', requesterId: user.id, ...dto, source: 'MANUAL' });
  }

  @Get('tickets/:id/messages')
  @Permission(Mod.SUPPORT, Action.VIEW)
  messages(@Param('id') id: string) {
    return this.tickets.listMessages(id, true);
  }

  @Post('tickets/:id/messages')
  @Permission(Mod.SUPPORT, Action.EDIT)
  reply(@Param('id') id: string, @Body() dto: TicketMessageDto, @CurrentUser() user: AuthUser) {
    return this.tickets.addMessage(id, this.tickets.actorFromStaff(user), dto);
  }

  @Post('tickets/:id/assign')
  @Permission(Mod.SUPPORT, Action.EDIT)
  assign(@Param('id') id: string, @Body() dto: AssignTicketDto, @CurrentUser() user: AuthUser) {
    return this.tickets.assign(id, dto.assigneeId ?? null, user);
  }

  @Post('tickets/:id/escalate')
  @Permission(Mod.SUPPORT, Action.EDIT)
  escalate(@Param('id') id: string, @Body() dto: EscalateTicketDto, @CurrentUser() user: AuthUser) {
    return this.tickets.escalate(id, this.tickets.actorFromStaff(user), dto);
  }

  @Patch('tickets/:id')
  @Permission(Mod.SUPPORT, Action.EDIT)
  update(@Param('id') id: string, @Body() dto: UpdateTicketDto, @CurrentUser() user: AuthUser) {
    return this.tickets.update(id, this.tickets.actorFromStaff(user), dto);
  }

  @Post('tickets/:id/resolve')
  @Permission(Mod.SUPPORT, Action.EDIT)
  async resolve(@Param('id') id: string, @Body() dto: ResolveTicketDto, @CurrentUser() user: AuthUser) {
    const before = await this.tickets.get(id);
    const t = await this.tickets.resolve(id, this.tickets.actorFromStaff(user), dto);
    await this.audit.log({ actor: user, action: 'support.ticket.resolve', entity: 'Ticket', entityId: id, before: { status: before.status }, after: { reasonCode: dto.reasonCode, chargedTo: dto.chargedTo } });
    return t;
  }

  @Post('tickets/:id/close')
  @Permission(Mod.SUPPORT, Action.EDIT)
  close(@Param('id') id: string, @Body() dto: CloseTicketDto, @CurrentUser() user: AuthUser) {
    return this.tickets.close(id, this.tickets.actorFromStaff(user), dto.note);
  }

  @Post('tickets/:id/reopen')
  @Permission(Mod.SUPPORT, Action.EDIT)
  reopen(@Param('id') id: string, @Body() dto: ReopenTicketDto, @CurrentUser() user: AuthUser) {
    return this.tickets.reopen(id, this.tickets.actorFromStaff(user), dto.reason);
  }

  @Post('tickets/:id/status')
  @Permission(Mod.SUPPORT, Action.EDIT)
  setStatus(@Param('id') id: string, @Body() dto: SetStatusDto, @CurrentUser() user: AuthUser) {
    return this.tickets.setStatus(id, this.tickets.actorFromStaff(user), dto.status as TicketStatus.OPEN | TicketStatus.PENDING);
  }

  @Post('tickets/:id/refund')
  @Permission(Mod.SUPPORT, Action.APPROVE)
  async refundFromTicket(@Param('id') id: string, @Body() dto: RefundFromTicketDto, @CurrentUser() user: AuthUser) {
    const ticket = await this.tickets.get(id);
    if (!ticket.orderId) throw new NotFoundException('This ticket is not linked to an order');
    const refund = await this.refundGateway.issue({ orderId: ticket.orderId, amount: dto.amount, type: dto.type as any, chargedTo: dto.chargedTo as any, reasonCode: dto.reasonCode, notes: dto.notes, ticketId: id, actor: this.refundActor(user) });
    if (refund.status !== RefundStatus.PENDING_APPROVAL) {
      await this.ticketRepo.update(id, { refundedTotal: Number(ticket.refundedTotal) + Number(refund.amount) });
      await this.tickets.sysNote(id, `${dto.type === 'CREDIT' ? 'Credit' : 'Refund'} of $${dto.amount.toFixed(2)} issued by ${user.name} (${dto.reasonCode}, charged to ${dto.chargedTo})`);
    } else {
      await this.tickets.sysNote(id, `${dto.type === 'CREDIT' ? 'Credit' : 'Refund'} of $${dto.amount.toFixed(2)} requested by ${user.name} - pending supervisor approval (over refund limit)`);
    }
    await this.audit.log({ actor: user, action: 'support.ticket.refund', entity: 'Ticket', entityId: id, after: { amount: dto.amount, chargedTo: dto.chargedTo, reasonCode: dto.reasonCode, status: refund.status } });
    return refund;
  }

  // ------------------------------------------------------------------ refund approval queue
  @Get('refunds/pending')
  @Permission(Mod.SUPPORT, Action.APPROVE)
  async pendingRefunds(@Query() q: PageQueryDto) {
    const qb = this.refunds.createQueryBuilder('r').where('r.status = :s AND r."ticketId" IS NOT NULL', { s: RefundStatus.PENDING_APPROVAL });
    return paginateQb(qb, q, { defaultSort: ['r.createdAt', 'ASC'] });
  }

  @Post('refunds/:id/approve')
  @Permission(Mod.SUPPORT, Action.APPROVE)
  async approveRefund(@Param('id') id: string, @Body() dto: ApproveRefundDto, @CurrentUser() user: AuthUser) {
    const refund = await this.refundGateway.approve(id, { type: this.tickets.actorType('STAFF'), id: user.id, name: user.name, refundLimit: user.type === UserType.SUPER_ADMIN ? null : user.refundLimit ?? null }, dto.notes);
    if (refund.ticketId) {
      const t = await this.tickets.get(refund.ticketId);
      await this.ticketRepo.update(refund.ticketId, { refundedTotal: Number(t.refundedTotal) + Number(refund.amount) });
      await this.tickets.sysNote(refund.ticketId, `Refund of $${Number(refund.amount).toFixed(2)} approved by ${user.name}`);
    }
    await this.audit.log({ actor: user, action: 'support.refund.approve', entity: 'Refund', entityId: id, after: { notes: dto.notes } });
    return refund;
  }

  @Post('refunds/:id/reject')
  @Permission(Mod.SUPPORT, Action.APPROVE)
  async rejectRefund(@Param('id') id: string, @Body() dto: RejectRefundDto, @CurrentUser() user: AuthUser) {
    const refund = await this.refundGateway.reject(id, { type: this.tickets.actorType('STAFF'), id: user.id, name: user.name, refundLimit: user.refundLimit ?? null }, dto.reason);
    if (refund.ticketId) await this.tickets.sysNote(refund.ticketId, `Refund of $${Number(refund.amount).toFixed(2)} rejected by ${user.name}${dto.reason ? `: ${dto.reason}` : ''}`);
    await this.audit.log({ actor: user, action: 'support.refund.reject', entity: 'Refund', entityId: id, after: { reason: dto.reason } });
    return refund;
  }

  // ------------------------------------------------------------------ order context / rule engine
  @Get('order-context/:orderId')
  @Permission(Mod.SUPPORT, Action.VIEW)
  orderCtx(@Param('orderId') orderId: string) {
    return this.orderContext.context(orderId);
  }

  @Get('order-context/:orderId/suggest')
  @Permission(Mod.SUPPORT, Action.VIEW)
  suggest(@Param('orderId') orderId: string, @Query('category') category: any, @Query('itemIds') itemIds?: string) {
    return this.orderContext.suggest(orderId, category, itemIds ? itemIds.split(',').filter(Boolean) : []);
  }

  // ------------------------------------------------------------------ canned replies
  @Get('canned-replies')
  @Permission(Mod.SUPPORT, Action.VIEW)
  async cannedList(@Query() q: CannedReplyQueryDto) {
    const qb = this.canned.createQueryBuilder('c').where('1=1');
    if (q.category) qb.andWhere('c.category = :cat', { cat: q.category });
    if (q.audience) qb.andWhere('(c.audience = :aud OR c.audience = :any)', { aud: q.audience, any: 'ANY' });
    if (q.search) qb.andWhere('(c.title ILIKE :s OR c.body ILIKE :s OR c.shortcut ILIKE :s)', { s: `%${q.search}%` });
    return paginateQb(qb, q, { sortable: { title: 'c.title', usageCount: 'c.usageCount' }, defaultSort: ['c.title', 'ASC'] });
  }

  @Post('canned-replies')
  @Permission(Mod.SUPPORT, Action.CREATE)
  createCanned(@Body() dto: CannedReplyDto, @CurrentUser() user: AuthUser) {
    return this.canned.save(this.canned.create({ ...dto, createdById: user.id }));
  }

  @Patch('canned-replies/:id')
  @Permission(Mod.SUPPORT, Action.EDIT)
  async updateCanned(@Param('id') id: string, @Body() dto: UpdateCannedReplyDto) {
    const row = await this.canned.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Canned reply not found');
    Object.assign(row, dto);
    return this.canned.save(row);
  }

  @Delete('canned-replies/:id')
  @Permission(Mod.SUPPORT, Action.DELETE)
  async deleteCanned(@Param('id') id: string) {
    await this.canned.delete(id);
    return { ok: true };
  }

  @Post('canned-replies/:id/render')
  @Permission(Mod.SUPPORT, Action.VIEW)
  async renderCanned(@Param('id') id: string, @Body('vars') vars: Record<string, any> = {}) {
    const row = await this.canned.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Canned reply not found');
    await this.canned.update(id, { usageCount: row.usageCount + 1 });
    return { body: renderTemplate(row.body, vars) };
  }

  // ------------------------------------------------------------------ SOP-08 review cases
  @Get('review-cases')
  @Permission(Mod.SUPPORT, Action.VIEW)
  caseList(@Query() q: ReviewCaseQueryDto) {
    return this.reviewCases.list(q);
  }

  @Get('review-cases/candidates')
  @Permission(Mod.SUPPORT, Action.VIEW)
  caseCandidates() {
    return this.reviewCases.detectCandidates();
  }

  @Post('review-cases')
  @Permission(Mod.SUPPORT, Action.CREATE)
  async openCase(@Body() dto: OpenReviewCaseDto, @CurrentUser() user: AuthUser) {
    const c = await this.reviewCases.open(dto);
    await this.audit.log({ actor: user, action: 'support.case.open', entity: 'ReviewCase', entityId: c.id, after: dto });
    return c;
  }

  @Get('review-cases/:id')
  @Permission(Mod.SUPPORT, Action.VIEW)
  caseDetail(@Param('id') id: string) {
    return this.reviewCases.get(id);
  }

  @Post('review-cases/:id/notice')
  @Permission(Mod.SUPPORT, Action.EDIT)
  async sendNotice(@Param('id') id: string, @Body() dto: SendNoticeDto, @CurrentUser() user: AuthUser) {
    const c = await this.reviewCases.sendNotice(id, user, dto);
    await this.audit.log({ actor: user, action: 'support.case.notice', entity: 'ReviewCase', entityId: id, after: { respondBy: c.respondBy } });
    return c;
  }

  @Post('review-cases/:id/evidence')
  @Permission(Mod.SUPPORT, Action.EDIT)
  addEvidence(@Param('id') id: string, @Body() dto: AddEvidenceDto, @CurrentUser() user: AuthUser) {
    return this.reviewCases.addEvidence(id, user, dto);
  }

  @Post('review-cases/:id/dismiss')
  @Permission(Mod.SUPPORT, Action.EDIT)
  dismissCase(@Param('id') id: string, @Body('notes') notes: string | undefined, @CurrentUser() user: AuthUser) {
    return this.reviewCases.dismiss(id, notes);
  }

  @Post('review-cases/:id/decide')
  @Permission(Mod.SUPPORT, Action.APPROVE)
  async decideCase(@Param('id') id: string, @Body() dto: DecideCaseDto, @CurrentUser() user: AuthUser) {
    const c = await this.reviewCases.decide(id, user, dto);
    await this.audit.log({ actor: user, action: 'support.case.decide', entity: 'ReviewCase', entityId: id, after: dto });
    return c;
  }

  @Post('review-cases/:id/appeal-decision')
  @Permission(Mod.SUPPORT, Action.APPROVE)
  async decideAppeal(@Param('id') id: string, @Body() dto: AppealDecisionDto, @CurrentUser() user: AuthUser) {
    const c = await this.reviewCases.decideAppeal(id, user, dto);
    await this.audit.log({ actor: user, action: 'support.case.appeal_decision', entity: 'ReviewCase', entityId: id, after: dto });
    return c;
  }

  @Post('review-cases/:id/final-payout')
  @Permission(Mod.SUPPORT, Action.APPROVE)
  async finalPayout(@Param('id') id: string, @Body() dto: FinalPayoutDto, @CurrentUser() user: AuthUser) {
    const c = await this.reviewCases.finalPayout(id, dto.amount);
    await this.audit.log({ actor: user, action: 'support.case.final_payout', entity: 'ReviewCase', entityId: id, after: dto });
    return c;
  }

  // ------------------------------------------------------------------ KPIs
  @Get('kpis')
  @Permission(Mod.SUPPORT, Action.VIEW)
  async kpis(@Query('from') from?: string, @Query('to') to?: string) {
    const since = from ? new Date(from) : new Date(Date.now() - 30 * 86400_000);
    const until = to ? new Date(to) : new Date();
    const base = () => this.ticketRepo.createQueryBuilder('t').where('t."createdAt" BETWEEN :since AND :until', { since, until });

    const [byStatus, byTier, byCategory, bySource, slaBreachedCount, totalCount, csat, firstResponse, resolution, refundTotals, openCases, decidedCases] = await Promise.all([
      base().select('t.status', 'k').addSelect('COUNT(*)', 'n').groupBy('t.status').getRawMany(),
      base().select('t.tier', 'k').addSelect('COUNT(*)', 'n').groupBy('t.tier').getRawMany(),
      base().select('t.category', 'k').addSelect('COUNT(*)', 'n').groupBy('t.category').orderBy('n', 'DESC').getRawMany(),
      base().select('t.source', 'k').addSelect('COUNT(*)', 'n').groupBy('t.source').getRawMany(),
      base().andWhere('t."slaBreached" = true').getCount(),
      base().getCount(),
      base().andWhere('t.csat IS NOT NULL').select('AVG(t.csat)', 'avg').addSelect('COUNT(*)', 'n').getRawOne(),
      base().andWhere('t."firstResponseAt" IS NOT NULL').select('AVG(EXTRACT(EPOCH FROM (t."firstResponseAt" - t."createdAt")) / 60)', 'avgMin').getRawOne(),
      base().andWhere('t."resolvedAt" IS NOT NULL').select('AVG(EXTRACT(EPOCH FROM (t."resolvedAt" - t."createdAt")) / 60)', 'avgMin').getRawOne(),
      this.refunds.createQueryBuilder('r').where('r."ticketId" IS NOT NULL AND r."createdAt" BETWEEN :since AND :until AND r.status <> :rej', { since, until, rej: RefundStatus.REJECTED }).select('r.chargedTo', 'k').addSelect('SUM(r.amount)', 'total').addSelect('COUNT(*)', 'n').groupBy('r.chargedTo').getRawMany(),
      this.cases.count({ where: { status: In(['OPEN', 'AWAITING_RESPONSE', 'PROPOSED']) } }),
      this.cases.createQueryBuilder('c').where('c."decidedAt" BETWEEN :since AND :until', { since, until }).select('c.decision', 'k').addSelect('COUNT(*)', 'n').groupBy('c.decision').getRawMany(),
    ]);
    const toMap = (rows: { k: string; n: string }[]) => Object.fromEntries(rows.map((r) => [r.k, Number(r.n)]));
    return {
      range: { from: since, to: until },
      tickets: { total: totalCount, byStatus: toMap(byStatus), byTier: toMap(byTier), byCategory: toMap(byCategory), bySource: toMap(bySource), slaBreached: slaBreachedCount, slaBreachRate: totalCount ? Math.round((slaBreachedCount / totalCount) * 1000) / 10 : 0 },
      csat: { average: csat?.avg ? Math.round(Number(csat.avg) * 100) / 100 : null, count: Number(csat?.n ?? 0) },
      avgFirstResponseMinutes: firstResponse?.avgMin ? Math.round(Number(firstResponse.avgMin)) : null,
      avgResolutionMinutes: resolution?.avgMin ? Math.round(Number(resolution.avgMin)) : null,
      refunds: refundTotals.map((r) => ({ chargedTo: r.k, total: Math.round(Number(r.total) * 100) / 100, count: Number(r.n) })),
      reviewCases: { open: openCases, decided: toMap(decidedCases) },
    };
  }
}
