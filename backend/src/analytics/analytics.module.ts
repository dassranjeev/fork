import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduledReport } from '../database/entities';
import { AnalyticsBase } from './analytics.base';
import { DashboardService } from './dashboard.service';
import { GrowthService } from './growth.service';
import { RestaurantReportsService } from './restaurant-reports.service';
import { RestaurantPerformanceService } from './restaurant-performance.service';
import { DriverPerformanceService } from './driver-performance.service';
import { FinanceAnalyticsService } from './finance-analytics.service';
import { SupportAnalyticsService } from './support-analytics.service';
import { PilotKpisService } from './pilot-kpis.service';
import { ExportService } from './export.service';
import { ScheduledReportsService } from './scheduled-reports.service';
import { AdminDashboardController } from './dashboard.controller';
import { AdminAnalyticsController } from './admin-analytics.controller';
import { AdminReportsController } from './admin-reports.controller';
import { RestaurantReportsController } from './restaurant-reports.controller';

/** Read-only, raw-SQL reporting over shared tables; only ScheduledReport is written. */
@Module({
  imports: [TypeOrmModule.forFeature([ScheduledReport])],
  providers: [
    AnalyticsBase,
    DashboardService,
    GrowthService,
    RestaurantReportsService,
    RestaurantPerformanceService,
    DriverPerformanceService,
    FinanceAnalyticsService,
    SupportAnalyticsService,
    PilotKpisService,
    ExportService,
    ScheduledReportsService,
  ],
  controllers: [AdminDashboardController, AdminAnalyticsController, AdminReportsController, RestaurantReportsController],
  exports: [AnalyticsBase, DashboardService, GrowthService, ExportService],
})
export class AnalyticsModule {}
