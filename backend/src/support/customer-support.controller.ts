import { Body, Get, Param, Post, Query } from '@nestjs/common';
import { CurrentUser, CustomerController } from '../common/decorators';
import { AuthUser } from '../common/auth.types';
import { TicketsService } from './tickets.service';
import { SelfServeService } from './self-serve.service';
import { CUSTOMER_ISSUE_TYPES } from './support.constants';
import { ConfirmTicketDto, CreateTicketDto, CsatDto, ReopenTicketDto, ReportIssueDto, RequesterTicketQueryDto, TicketMessageDto } from './dto';

/**
 * `/customer/support/*` (spec §9): self-serve issue reporting with automatic rules, tickets, ticket-thread
 * messages (photos included via `attachments` URLs uploaded through `POST /uploads`). Live order-level chat with
 * a restaurant/driver already exists at `/orders/:id/messages` (`OrderChatService`) - not duplicated here.
 */
@CustomerController('support')
export class CustomerSupportController {
  constructor(
    private tickets: TicketsService,
    private selfServe: SelfServeService,
  ) {}

  @Get('issue-types')
  issueTypes() {
    return CUSTOMER_ISSUE_TYPES;
  }

  @Post('issues')
  reportIssue(@Body() dto: ReportIssueDto, @CurrentUser() user: AuthUser) {
    return this.selfServe.reportIssue(user.id, dto);
  }

  @Get('tickets')
  list(@Query() q: RequesterTicketQueryDto, @CurrentUser() user: AuthUser) {
    return this.tickets.listForRequester('CUSTOMER', { userId: user.id }, q);
  }

  @Post('tickets')
  async create(@Body() dto: CreateTicketDto, @CurrentUser() user: AuthUser) {
    const t = await this.tickets.create({ requesterType: 'CUSTOMER', requesterId: user.id, ...dto, source: 'MANUAL' });
    return this.tickets.requesterDetail(t);
  }

  @Get('tickets/:id')
  async detail(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    const t = await this.tickets.getFor(id, 'CUSTOMER', { userId: user.id });
    return this.tickets.requesterDetail(t);
  }

  @Get('tickets/:id/messages')
  async messages(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    await this.tickets.getFor(id, 'CUSTOMER', { userId: user.id });
    return this.tickets.listMessages(id, false);
  }

  @Post('tickets/:id/messages')
  async reply(@Param('id') id: string, @Body() dto: TicketMessageDto, @CurrentUser() user: AuthUser) {
    await this.tickets.getFor(id, 'CUSTOMER', { userId: user.id });
    return this.tickets.addMessage(id, { type: 'CUSTOMER', id: user.id, name: user.name }, { body: dto.body, attachments: dto.attachments });
  }

  @Post('tickets/:id/confirm')
  async confirm(@Param('id') id: string, @Body() dto: ConfirmTicketDto, @CurrentUser() user: AuthUser) {
    await this.tickets.getFor(id, 'CUSTOMER', { userId: user.id });
    return this.tickets.confirm(id, user.id, dto.csat, dto.comment);
  }

  @Post('tickets/:id/reopen')
  async reopen(@Param('id') id: string, @Body() dto: ReopenTicketDto, @CurrentUser() user: AuthUser) {
    const t = await this.tickets.getFor(id, 'CUSTOMER', { userId: user.id });
    return this.tickets.reopen(t.id, { type: 'CUSTOMER', id: user.id, name: user.name }, dto.reason);
  }

  @Post('tickets/:id/rate')
  async rate(@Param('id') id: string, @Body() dto: CsatDto, @CurrentUser() user: AuthUser) {
    await this.tickets.getFor(id, 'CUSTOMER', { userId: user.id });
    return this.tickets.rate(id, user.id, dto.csat, dto.comment);
  }
}
