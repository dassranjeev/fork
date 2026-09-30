import { Body, Get, Param, Post, Query } from '@nestjs/common';
import { CurrentUser, DriverController } from '../common/decorators';
import { AuthUser } from '../common/auth.types';
import { TicketsService } from './tickets.service';
import { ReviewCasesService } from './review-cases.service';
import { AppealRequestDto, CreateTicketDto, RequesterTicketQueryDto, RespondCaseDto, TicketMessageDto } from './dto';
import { PageQueryDto } from '../common/pagination';

/** `/driver/support/*`: tickets raised from the driver app + their SOP-08 review cases. */
@DriverController('support')
export class DriverSupportController {
  constructor(
    private tickets: TicketsService,
    private reviewCases: ReviewCasesService,
  ) {}

  @Get('tickets')
  list(@Query() q: RequesterTicketQueryDto, @CurrentUser() user: AuthUser) {
    return this.tickets.listForRequester('DRIVER', { userId: user.id, driverId: user.driverId }, q);
  }

  @Post('tickets')
  async create(@Body() dto: CreateTicketDto, @CurrentUser() user: AuthUser) {
    const t = await this.tickets.create({ requesterType: 'DRIVER', requesterId: user.id, driverId: user.driverId, ...dto, source: 'MANUAL' });
    return this.tickets.requesterDetail(t);
  }

  @Get('tickets/:id')
  async detail(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    const t = await this.tickets.getFor(id, 'DRIVER', { userId: user.id, driverId: user.driverId });
    return this.tickets.requesterDetail(t);
  }

  @Get('tickets/:id/messages')
  async messages(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    await this.tickets.getFor(id, 'DRIVER', { userId: user.id, driverId: user.driverId });
    return this.tickets.listMessages(id, false);
  }

  @Post('tickets/:id/messages')
  async reply(@Param('id') id: string, @Body() dto: TicketMessageDto, @CurrentUser() user: AuthUser) {
    await this.tickets.getFor(id, 'DRIVER', { userId: user.id, driverId: user.driverId });
    return this.tickets.addMessage(id, { type: 'DRIVER', id: user.id, name: user.name }, { body: dto.body, attachments: dto.attachments });
  }

  // ------------------------------------------------------------------ SOP-08 review cases
  @Get('review-cases')
  cases(@Query() q: PageQueryDto, @CurrentUser() user: AuthUser) {
    return this.reviewCases.listForSubject('DRIVER', user.driverId ? [user.driverId] : [], q);
  }

  @Get('review-cases/:id')
  caseDetail(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.reviewCases.getForSubject(id, 'DRIVER', user.driverId ? [user.driverId] : []);
  }

  @Post('review-cases/:id/respond')
  respond(@Param('id') id: string, @Body() dto: RespondCaseDto, @CurrentUser() user: AuthUser) {
    return this.reviewCases.respond(id, 'DRIVER', user.driverId ? [user.driverId] : [], dto.response);
  }

  @Post('review-cases/:id/appeal')
  appeal(@Param('id') id: string, @Body() dto: AppealRequestDto, @CurrentUser() user: AuthUser) {
    return this.reviewCases.requestAppeal(id, 'DRIVER', user.driverId ? [user.driverId] : [], dto.notes);
  }
}
