import { Body, Delete, Get, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { IsDateString, IsEmail, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { AdminController, CurrentUser, Permission } from '../common/decorators';
import { AuthUser } from '../common/auth.types';
import { Action, Module } from '../common/enums';
import { PageQueryDto } from '../common/pagination';
import { AuditService } from '../audit/audit.service';
import { GiftCardsService } from './gift-cards.service';

class IssueGiftCardDto {
  @IsNumber() @Min(1) amount: number;
  /** how many cards to create at once (default 1). recipientEmail only allowed when count = 1. */
  @IsOptional() @IsInt() @Min(1) @Max(500) count?: number;
  @IsOptional() @IsDateString() expiresAt?: string | null;
  @IsOptional() @IsEmail() recipientEmail?: string | null;
  @IsOptional() @IsString() @MaxLength(500) message?: string;
}

class GiftCardQuery extends PageQueryDto {
  /** ACTIVE | REDEEMED | VOID | EXPIRED */
  @IsOptional() @IsString() status?: string;
}

/** Admin: gift cards issue / void / list (spec: Marketing owns gift cards). Customer redemption lives on GiftCardsService.redeem, called by CustomersModule. */
@AdminController('gift-cards')
export class GiftCardsAdminController {
  constructor(private svc: GiftCardsService, private audit: AuditService) {}

  @Get()
  @Permission(Module.PROMOTIONS, Action.VIEW)
  list(@Query() q: GiftCardQuery) {
    return this.svc.list(q);
  }

  @Get('stats')
  @Permission(Module.PROMOTIONS, Action.VIEW)
  stats() {
    return this.svc.stats();
  }

  @Post()
  @Permission(Module.PROMOTIONS, Action.CREATE)
  async issue(@Body() dto: IssueGiftCardDto, @CurrentUser() u: AuthUser, @Req() req: any) {
    const cards = await this.svc.issue({
      amount: dto.amount,
      count: dto.count,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
      recipientEmail: dto.recipientEmail ?? null,
      message: dto.message,
      issuedById: u.id,
    });
    await this.audit.logReq(req, 'gift_card.issue', 'gift_card', cards[0]?.id, null, { count: cards.length, amount: dto.amount });
    return { count: cards.length, cards };
  }

  @Post(':id/void')
  @Permission(Module.PROMOTIONS, Action.EDIT)
  async void(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    const { before, after } = await this.svc.void(id);
    await this.audit.logReq(req, 'gift_card.void', 'gift_card', id, { active: before.active }, { active: after.active });
    return after;
  }
}
