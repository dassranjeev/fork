import { Body, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { AdminController, CurrentUser, Permission } from '../common/decorators';
import { Action, Module } from '../common/enums';
import { AuthUser } from '../common/auth.types';
import { PageQueryDto } from '../common/pagination';
import { AdminCustomersService } from './admin-customers.service';
import { ApproveDataRequestDto, BlockCustomerDto, RejectDataRequestDto, SetFlagsDto, SetNotesDto, WalletAdjustDto } from './dto';

/**
 * Admin console "Customers" section (ARCHITECTURE.md CustomersModule row): list/detail, orders, wallet + manual
 * adjustment, block/unblock, fraud flags, notes, refund stats, and the PIPEDA deletion/access request queue.
 */
@AdminController('customers')
export class AdminCustomersController {
  constructor(private admin: AdminCustomersService) {}

  @Get()
  @Permission(Module.CUSTOMERS, Action.VIEW)
  list(@Query() q: PageQueryDto & { blocked?: string; fraudFlag?: string }) {
    return this.admin.list(q);
  }

  // NOTE: static sub-routes must be declared before the ':id' wildcard routes below.
  @Get('data-requests')
  @Permission(Module.CUSTOMERS, Action.VIEW)
  dataRequests(@Query() q: PageQueryDto & { status?: string; type?: string }) {
    return this.admin.dataRequestsList(q);
  }

  @Post('data-requests/:id/approve')
  @Permission(Module.CUSTOMERS, Action.APPROVE)
  approveDataRequest(@Param('id') id: string, @CurrentUser() user: AuthUser, @Body() dto: ApproveDataRequestDto) {
    return this.admin.approveDataRequest(user, id, dto.notes);
  }

  @Post('data-requests/:id/reject')
  @Permission(Module.CUSTOMERS, Action.APPROVE)
  rejectDataRequest(@Param('id') id: string, @CurrentUser() user: AuthUser, @Body() dto: RejectDataRequestDto) {
    return this.admin.rejectDataRequest(user, id, dto.reason);
  }

  @Get('data-requests/:id/export')
  @Permission(Module.CUSTOMERS, Action.VIEW)
  exportDataRequest(@Param('id') id: string) {
    return this.admin.exportDataRequest(id);
  }

  @Get(':id')
  @Permission(Module.CUSTOMERS, Action.VIEW)
  detail(@Param('id') id: string) {
    return this.admin.detail(id);
  }

  @Get(':id/orders')
  @Permission(Module.CUSTOMERS, Action.VIEW)
  orders(@Param('id') id: string, @Query() q: PageQueryDto & { status?: string }) {
    return this.admin.ordersOf(id, q);
  }

  @Get(':id/wallet')
  @Permission(Module.CUSTOMERS, Action.VIEW)
  wallet(@Param('id') id: string, @Query('page') page?: string, @Query('limit') limit?: string) {
    return this.admin.walletOf(id, page ? +page : 1, limit ? +limit : 20);
  }

  @Post(':id/wallet/adjust')
  @Permission(Module.CUSTOMERS, Action.EDIT)
  adjustWallet(@Param('id') id: string, @CurrentUser() user: AuthUser, @Body() dto: WalletAdjustDto) {
    return this.admin.adjustWallet(user, id, dto.amount, dto.reason);
  }

  @Get(':id/refund-stats')
  @Permission(Module.CUSTOMERS, Action.VIEW)
  refundStats(@Param('id') id: string) {
    return this.admin.refundStats(id);
  }

  @Post(':id/block')
  @Permission(Module.CUSTOMERS, Action.EDIT)
  block(@Param('id') id: string, @CurrentUser() user: AuthUser, @Body() dto: BlockCustomerDto) {
    return this.admin.block(user, id, dto);
  }

  @Post(':id/unblock')
  @Permission(Module.CUSTOMERS, Action.EDIT)
  unblock(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.admin.unblock(user, id);
  }

  @Patch(':id/flags')
  @Permission(Module.CUSTOMERS, Action.EDIT)
  setFlags(@Param('id') id: string, @CurrentUser() user: AuthUser, @Body() dto: SetFlagsDto) {
    return this.admin.setFlags(user, id, dto);
  }

  @Patch(':id/notes')
  @Permission(Module.CUSTOMERS, Action.EDIT)
  setNotes(@Param('id') id: string, @CurrentUser() user: AuthUser, @Body() dto: SetNotesDto) {
    return this.admin.setNotes(user, id, dto.note);
  }
}
