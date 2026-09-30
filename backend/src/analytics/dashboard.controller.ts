import { Get, Query } from '@nestjs/common';
import { AdminController, CurrentUser, Permission } from '../common/decorators';
import { Action, Module } from '../common/enums';
import { AuthUser } from '../common/auth.types';
import { AnalyticsFilterDto } from './analytics.dto';
import { DashboardService } from './dashboard.service';

/** Admin console landing dashboard (spec §12): `/admin/dashboard`. */
@AdminController('dashboard')
export class AdminDashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get()
  @Permission(Module.DASHBOARD, Action.VIEW)
  home(@Query() f: AnalyticsFilterDto, @CurrentUser() user: AuthUser) {
    return this.dashboard.home(f, user);
  }
}
