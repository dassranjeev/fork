import { Body, Get, ParseUUIDPipe, Post, Put, Query, Param, Req } from '@nestjs/common';
import { AdminController, CurrentUser, NoImpersonation, Permission, UserTypes } from '../common/decorators';
import { Action, Module, UserType, VerificationAudience } from '../common/enums';
import { AuthUser } from '../common/auth.types';
import { AuditService } from '../audit/audit.service';
import { VerificationService } from './verification.service';
import { ForceVerificationDto, RejectVerificationDto, SubjectsQuery, UpdatePolicyDto, VerifyDto } from './verification.dto';

/**
 * Registration and verification of drivers and businesses (docs/verification.md).
 *
 *  - Super Admin ONLY: the policy (instant registration on/off, manual or automatic verification, per audience), the overview, the list of
 *    accounts, Force verification and the manual "run the sweep now". Not even a staff role with every permission can call these.
 *  - Staff with drivers / restaurants permissions: look at one account's verification, verify it (checklist enforced), reject it, start its Certn check.
 */
@AdminController('verification')
export class VerificationController {
  constructor(
    private svc: VerificationService,
    private audit: AuditService,
  ) {}

  // ------------------------------------------------------------------ Super Admin only
  @Get()
  @UserTypes(UserType.SUPER_ADMIN)
  @NoImpersonation()
  overview() {
    return this.svc.overview();
  }

  @Put('policy')
  @UserTypes(UserType.SUPER_ADMIN)
  @NoImpersonation()
  updatePolicy(@Body() dto: UpdatePolicyDto, @CurrentUser() user: AuthUser, @Req() req: any) {
    return this.svc.updatePolicy(dto, user, req);
  }

  /** Accounts of one audience with their verification state (the Verification page table). */
  @Get('subjects')
  @UserTypes(UserType.SUPER_ADMIN)
  @NoImpersonation()
  subjects(@Query() q: SubjectsQuery) {
    return this.svc.listSubjects(q);
  }

  @Post('force')
  @UserTypes(UserType.SUPER_ADMIN)
  @NoImpersonation()
  force(@Body() dto: ForceVerificationDto, @CurrentUser() user: AuthUser, @Req() req: any) {
    return this.svc.force(dto, user, req);
  }

  /** Runs the checks the server also runs every minute: deadlines, Certn retries and reminders. */
  @Post('sweep')
  @UserTypes(UserType.SUPER_ADMIN)
  @NoImpersonation()
  async sweep(@Req() req: any) {
    const r = await this.svc.sweep();
    void this.audit.logReq(req, 'verification.sweep', 'verification', undefined, undefined, r);
    return r;
  }

  // ------------------------------------------------------------------ drivers (staff with the drivers permissions)
  @Get('drivers/:id')
  @Permission(Module.DRIVERS, Action.VIEW)
  driver(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.details(VerificationAudience.DRIVER, id);
  }

  @Post('drivers/:id/verify')
  @Permission(Module.DRIVERS, Action.APPROVE)
  verifyDriver(@Param('id', ParseUUIDPipe) id: string, @Body() dto: VerifyDto, @CurrentUser() user: AuthUser) {
    return this.svc.verify(VerificationAudience.DRIVER, id, user, dto);
  }

  @Post('drivers/:id/reject')
  @Permission(Module.DRIVERS, Action.APPROVE)
  rejectDriver(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RejectVerificationDto, @CurrentUser() user: AuthUser) {
    return this.svc.reject(VerificationAudience.DRIVER, id, user, dto.reason);
  }

  @Post('drivers/:id/start-check')
  @Permission(Module.DRIVERS, Action.APPROVE)
  startDriverCheck(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.svc.startCheck(VerificationAudience.DRIVER, id, user);
  }

  // ------------------------------------------------------------------ businesses (staff with the restaurants permissions); :id is the MERCHANT id
  @Get('businesses/:id')
  @Permission(Module.RESTAURANTS, Action.VIEW)
  business(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.details(VerificationAudience.BUSINESS, id);
  }

  @Post('businesses/:id/verify')
  @Permission(Module.RESTAURANTS, Action.APPROVE)
  verifyBusiness(@Param('id', ParseUUIDPipe) id: string, @Body() dto: VerifyDto, @CurrentUser() user: AuthUser) {
    return this.svc.verify(VerificationAudience.BUSINESS, id, user, dto);
  }

  @Post('businesses/:id/reject')
  @Permission(Module.RESTAURANTS, Action.APPROVE)
  rejectBusiness(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RejectVerificationDto, @CurrentUser() user: AuthUser) {
    return this.svc.reject(VerificationAudience.BUSINESS, id, user, dto.reason);
  }

  @Post('businesses/:id/start-check')
  @Permission(Module.RESTAURANTS, Action.APPROVE)
  startBusinessCheck(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.svc.startCheck(VerificationAudience.BUSINESS, id, user);
  }
}
