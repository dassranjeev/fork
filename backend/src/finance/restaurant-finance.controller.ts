import { BadRequestException, Body, ForbiddenException, Get, Param, Post, Query } from '@nestjs/common';
import { RestaurantController, CurrentUser, NoImpersonation, RestaurantRoles } from '../common/decorators';
import { PartyType, RestaurantRole } from '../common/enums';
import { AuthUser } from '../common/auth.types';
import { PayoutsService, PayoutQuery } from './payouts.service';
import { InvoicesService, InvoiceQuery } from './invoices.service';
import { PartiesService } from './parties.service';
import { StatementsService } from './statements.service';
import { BankDetailsDto, BankVerifyConfirmDto } from './finance.dto';
import { addDays, torontoMidnight } from './finance.util';

/** Restaurant portal: statements, payouts, invoices, bank details (spec §4, "Finance" tab). Scoped to the caller's merchant. */
@RestaurantController('finance')
@RestaurantRoles(RestaurantRole.OWNER) // money data is owner-only (managers / cashiers / kitchen get 403)
export class RestaurantFinanceController {
  constructor(
    private payouts: PayoutsService,
    private invoicesSvc: InvoicesService,
    private parties: PartiesService,
    private statements: StatementsService,
  ) {}

  private merchantId(user: AuthUser): string {
    if (!user.merchantId) throw new ForbiddenException('No merchant on this account');
    return user.merchantId;
  }

  @Get('dashboard')
  async dashboard(@CurrentUser() user: AuthUser) {
    const merchantId = this.merchantId(user);
    const [info, payouts] = await Promise.all([
      this.parties.info(PartyType.RESTAURANT, merchantId),
      this.payouts.list({ page: 1, limit: 5 } as PayoutQuery, { partyType: PartyType.RESTAURANT, partyId: merchantId }),
    ]);
    return { balance: info, recentPayouts: payouts.data };
  }

  @Get('payouts')
  listPayouts(@CurrentUser() user: AuthUser, @Query() q: PayoutQuery) {
    return this.payouts.list(q, { partyType: PartyType.RESTAURANT, partyId: this.merchantId(user) });
  }

  @Get('payouts/:id')
  payoutDetail(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.payouts.detail(id, { partyType: PartyType.RESTAURANT, partyId: this.merchantId(user) });
  }

  @Get('statements/:payoutId')
  statement(@CurrentUser() user: AuthUser, @Param('payoutId') payoutId: string) {
    return this.statements.payoutStatement(payoutId, { partyId: this.merchantId(user) });
  }

  @Get('statements/:payoutId/csv')
  statementCsv(@CurrentUser() user: AuthUser, @Param('payoutId') payoutId: string) {
    return this.statements.payoutStatementCsv(payoutId, { partyId: this.merchantId(user) });
  }

  @Get('ledger')
  async ledger(@CurrentUser() user: AuthUser, @Query('from') from?: string, @Query('to') to?: string) {
    const merchantId = this.merchantId(user);
    if (!from || !to) throw new BadRequestException('from and to (YYYY-MM-DD) are required');
    return this.statements.orderBreakdown(PartyType.RESTAURANT, merchantId, torontoMidnight(from), torontoMidnight(addDays(to, 1)));
  }

  @Get('invoices')
  listInvoices(@CurrentUser() user: AuthUser, @Query() q: InvoiceQuery) {
    return this.invoicesSvc.list(q, { merchantId: this.merchantId(user) });
  }

  @Get('invoices/:id')
  invoiceDetail(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.invoicesSvc.get(id, { merchantId: this.merchantId(user) });
  }

  @Get('invoices/:id/download')
  downloadInvoice(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query('format') format: 'json' | 'csv' | 'html' = 'json') {
    return this.invoicesSvc.download(id, format, { merchantId: this.merchantId(user) });
  }

  @Get('bank')
  @RestaurantRoles(RestaurantRole.OWNER)
  bank(@CurrentUser() user: AuthUser) {
    return this.parties.bankView(PartyType.RESTAURANT, this.merchantId(user));
  }

  @Post('bank')
  @NoImpersonation()
  @RestaurantRoles(RestaurantRole.OWNER)
  updateBank(@CurrentUser() user: AuthUser, @Body() dto: BankDetailsDto) {
    return this.parties.updateBank(PartyType.RESTAURANT, this.merchantId(user), dto);
  }

  @Post('bank/verify/initiate')
  @NoImpersonation()
  @RestaurantRoles(RestaurantRole.OWNER)
  initiateBankVerification(@CurrentUser() user: AuthUser) {
    return this.parties.initiateVerification(PartyType.RESTAURANT, this.merchantId(user));
  }

  @Post('bank/verify/confirm')
  @NoImpersonation()
  @RestaurantRoles(RestaurantRole.OWNER)
  confirmBankVerification(@CurrentUser() user: AuthUser, @Body() dto: BankVerifyConfirmDto) {
    return this.parties.confirmVerification(PartyType.RESTAURANT, this.merchantId(user), dto.amounts);
  }
}
