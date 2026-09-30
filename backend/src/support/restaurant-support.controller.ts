import { BadRequestException, Body, Get, Param, Post, Query } from '@nestjs/common';
import { CurrentUser, RestaurantController } from '../common/decorators';
import { AuthUser } from '../common/auth.types';
import { TicketsService } from './tickets.service';
import { ReviewCasesService } from './review-cases.service';
import { AppealRequestDto, CreateTicketDto, RequesterTicketQueryDto, RespondCaseDto, TicketMessageDto } from './dto';
import { PageQueryDto } from '../common/pagination';

/** `/restaurant/support/*`: tickets raised by the restaurant portal + their SOP-08 review cases. */
@RestaurantController('support')
export class RestaurantSupportController {
  constructor(
    private tickets: TicketsService,
    private reviewCases: ReviewCasesService,
  ) {}

  private restaurantIds(user: AuthUser): string[] {
    return user.restaurantIds ?? [];
  }

  private defaultRestaurantId(user: AuthUser, requested?: string): string {
    if (requested) {
      if (!this.restaurantIds(user).includes(requested)) throw new BadRequestException('Not one of your restaurant locations');
      return requested;
    }
    const [first] = this.restaurantIds(user);
    if (!first) throw new BadRequestException('No restaurant location on this account');
    return first;
  }

  // ------------------------------------------------------------------ tickets
  @Get('tickets')
  list(@Query() q: RequesterTicketQueryDto, @CurrentUser() user: AuthUser) {
    return this.tickets.listForRequester('RESTAURANT', { userId: user.id, restaurantIds: this.restaurantIds(user) }, q);
  }

  @Post('tickets')
  async create(@Body() dto: CreateTicketDto, @CurrentUser() user: AuthUser) {
    const restaurantId = this.defaultRestaurantId(user, dto.restaurantId);
    const t = await this.tickets.create({ requesterType: 'RESTAURANT', requesterId: user.id, ...dto, restaurantId, source: 'MANUAL' });
    return this.tickets.requesterDetail(t);
  }

  @Get('tickets/:id')
  async detail(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    const t = await this.tickets.getFor(id, 'RESTAURANT', { userId: user.id, restaurantIds: this.restaurantIds(user) });
    return this.tickets.requesterDetail(t);
  }

  @Get('tickets/:id/messages')
  async messages(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    await this.tickets.getFor(id, 'RESTAURANT', { userId: user.id, restaurantIds: this.restaurantIds(user) });
    return this.tickets.listMessages(id, false);
  }

  @Post('tickets/:id/messages')
  async reply(@Param('id') id: string, @Body() dto: TicketMessageDto, @CurrentUser() user: AuthUser) {
    await this.tickets.getFor(id, 'RESTAURANT', { userId: user.id, restaurantIds: this.restaurantIds(user) });
    return this.tickets.addMessage(id, { type: 'RESTAURANT', id: user.id, name: user.name }, { body: dto.body, attachments: dto.attachments });
  }

  // ------------------------------------------------------------------ SOP-08 review cases
  @Get('review-cases')
  cases(@Query() q: PageQueryDto, @CurrentUser() user: AuthUser) {
    return this.reviewCases.listForSubject('RESTAURANT', this.restaurantIds(user), q);
  }

  @Get('review-cases/:id')
  caseDetail(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.reviewCases.getForSubject(id, 'RESTAURANT', this.restaurantIds(user));
  }

  @Post('review-cases/:id/respond')
  respond(@Param('id') id: string, @Body() dto: RespondCaseDto, @CurrentUser() user: AuthUser) {
    return this.reviewCases.respond(id, 'RESTAURANT', this.restaurantIds(user), dto.response);
  }

  @Post('review-cases/:id/appeal')
  appeal(@Param('id') id: string, @Body() dto: AppealRequestDto, @CurrentUser() user: AuthUser) {
    return this.reviewCases.requestAppeal(id, 'RESTAURANT', this.restaurantIds(user), dto.notes);
  }
}
