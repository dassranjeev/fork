import { BadRequestException, Injectable } from '@nestjs/common';
import { AuthUser } from '../common/auth.types';
import { AnalyticsFilterDto } from './analytics.dto';
import { DashboardService } from './dashboard.service';
import { GrowthService } from './growth.service';
import { RestaurantPerformanceService } from './restaurant-performance.service';
import { DriverPerformanceService } from './driver-performance.service';
import { FinanceAnalyticsService } from './finance-analytics.service';
import { SupportAnalyticsService } from './support-analytics.service';
import { PilotKpisService } from './pilot-kpis.service';
import { buildCsv, buildXlsx } from './xlsx.util';

export const EXPORTABLE_DASHBOARDS = ['dashboard', 'live_ops', 'executive', 'restaurant_performance', 'driver_performance', 'customer_growth', 'finance', 'support', 'pilot_exit_kpis'] as const;
export type ExportableDashboard = (typeof EXPORTABLE_DASHBOARDS)[number];

interface TabularResult {
  headers: string[];
  rows: any[][];
}

/** Flatten a `{ metric: { value, previous, changePct } }` KPI bag into CSV/XLSX rows. */
function flattenKpis(kpis: Record<string, any>): TabularResult {
  const rows = Object.entries(kpis).map(([metric, k]) => [metric, k?.value ?? k, k?.previous ?? null, k?.changePct ?? null]);
  return { headers: ['metric', 'value', 'previous', 'changePct'], rows };
}

function objectsToTable(objs: any[]): TabularResult {
  if (!objs.length) return { headers: [], rows: [] };
  const headers = Object.keys(objs[0]).filter((k) => typeof objs[0][k] !== 'object' || objs[0][k] === null);
  return { headers, rows: objs.map((o) => headers.map((h) => o[h])) };
}

/**
 * Generic export for every admin dashboard (spec §12): `GET /admin/reports/:dashboard/export?format=csv|xlsx`.
 * Ranking-table dashboards export their table; KPI-only dashboards export a flattened metric list
 * (or their time series, when one exists) - the React admin builds richer downloads client-side if needed.
 */
@Injectable()
export class ExportService {
  constructor(
    private readonly dashboard: DashboardService,
    private readonly growth: GrowthService,
    private readonly restaurantPerf: RestaurantPerformanceService,
    private readonly driverPerf: DriverPerformanceService,
    private readonly financeSvc: FinanceAnalyticsService,
    private readonly supportSvc: SupportAnalyticsService,
    private readonly pilot: PilotKpisService,
  ) {}

  private async table(dashboard: string, f: AnalyticsFilterDto, user: AuthUser): Promise<{ filename: string; table: TabularResult }> {
    switch (dashboard) {
      case 'dashboard': {
        const d = await this.dashboard.home(f, user);
        return { filename: 'dashboard', table: flattenKpis({ ...d.today, gmvVsYesterdayPct: d.gmvComparison.vsYesterdayPct, driversOnline: d.drivers.online, openTickets: d.openTickets.total }) };
      }
      case 'live_ops': {
        const d = await this.dashboard.liveOps(f, user);
        return { filename: 'live-ops-attention', table: objectsToTable(d.needsAttention) };
      }
      case 'executive': {
        const d = await this.growth.executive(f, user);
        return { filename: 'executive-series', table: objectsToTable(d.series) };
      }
      case 'restaurant_performance': {
        const d = await this.restaurantPerf.list({ ...f, limit: f.limit ?? 1000, page: 1 }, user);
        return { filename: 'restaurant-performance', table: objectsToTable(d.data) };
      }
      case 'driver_performance': {
        const d = await this.driverPerf.list({ ...f, limit: f.limit ?? 1000, page: 1 }, user);
        return { filename: 'driver-performance', table: objectsToTable(d.data) };
      }
      case 'customer_growth': {
        const d = await this.growth.customerGrowth(f, user);
        return { filename: 'customer-growth-series', table: objectsToTable(d.series) };
      }
      case 'finance': {
        const d = await this.financeSvc.finance(f, user);
        return { filename: 'finance', table: flattenKpis(d.kpis) };
      }
      case 'support': {
        const d = await this.supportSvc.support(f, user);
        return { filename: 'support', table: flattenKpis(d.kpis) };
      }
      case 'pilot_exit_kpis': {
        const d = await this.pilot.kpis(f, user);
        return { filename: 'pilot-exit-kpis', table: objectsToTable(d.kpis) };
      }
      default:
        throw new BadRequestException(`Unknown dashboard "${dashboard}". Valid values: ${EXPORTABLE_DASHBOARDS.join(', ')}`);
    }
  }

  /** Returns a JSON-friendly payload the controller sends back (CSV text or a base64 XLSX buffer). */
  async build(dashboard: string, format: string | undefined, f: AnalyticsFilterDto, user: AuthUser) {
    const { filename, table } = await this.table(dashboard, f, user);
    const fmt = (format ?? 'csv').toLowerCase();
    if (fmt === 'xlsx') {
      const buf = buildXlsx(dashboard.slice(0, 31), table.headers, table.rows);
      return { filename: `${filename}.xlsx`, format: 'xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', base64: buf.toString('base64') };
    }
    if (fmt !== 'csv') throw new BadRequestException('format must be csv or xlsx');
    return { filename: `${filename}.csv`, format: 'csv', contentType: 'text/csv', csv: buildCsv(table.headers, table.rows) };
  }
}
