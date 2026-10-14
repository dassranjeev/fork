import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Cron } from '@nestjs/schedule';
import { Repository } from 'typeorm';
import { ScheduledReport } from '../database/entities';
import { AuthUser } from '../common/auth.types';
import { UserType } from '../common/enums';
import { PageQueryDto, like, paginateQb } from '../common/pagination';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AnalyticsFilterDto, ScheduledReportDto, UpdateScheduledReportDto } from './analytics.dto';
import { ExportService } from './export.service';

/** Runs analytics.ctx()/every dashboard query unrestricted (no city/zone/restaurant scope). */
const SYSTEM_USER: AuthUser = { id: 'system', type: UserType.SUPER_ADMIN, email: null, phone: null, name: 'Scheduled Reports', status: 'ACTIVE' };

/**
 * CRUD + delivery for `ScheduledReport` (spec §12: "scheduled email reports"). Sends the same
 * CSV/XLSX payload as `GET /admin/reports/:dashboard/export` via NotificationsService.sendEmail.
 *
 * NotificationsService.sendEmail() only carries a plain-text body (no attachment API on this
 * project's mock/SendGrid adapter) - CSV reports are inlined as text; XLSX reports are noted as
 * "generated, download from the admin console" since a base64 blob is not email-friendly inline.
 * See docs/api/analytics.md for the tracked follow-up (attachment support belongs in NotificationsService).
 */
@Injectable()
export class ScheduledReportsService {
  private readonly logger = new Logger(ScheduledReportsService.name);

  constructor(
    @InjectRepository(ScheduledReport) private repo: Repository<ScheduledReport>,
    private readonly exportSvc: ExportService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  list(q: PageQueryDto) {
    const qb = this.repo.createQueryBuilder('s');
    if (q.search) qb.andWhere('(s.name ILIKE :s OR s.dashboard ILIKE :s)', { s: like(q.search) });
    return paginateQb(qb, q, { sortable: { name: 's.name', dashboard: 's.dashboard', createdAt: 's.createdAt' }, defaultSort: ['s.createdAt', 'DESC'] });
  }

  async get(id: string) {
    const r = await this.repo.findOne({ where: { id } });
    if (!r) throw new NotFoundException('Scheduled report not found');
    return r;
  }

  async create(dto: ScheduledReportDto, user: AuthUser) {
    const r = await this.repo.save(this.repo.create({ ...dto, format: dto.format ?? 'CSV', filters: dto.filters ?? {}, active: dto.active ?? true }));
    await this.audit.log({ actor: user, action: 'analytics.scheduled_report.create', entity: 'ScheduledReport', entityId: r.id, after: r });
    return r;
  }

  async update(id: string, dto: UpdateScheduledReportDto, user: AuthUser) {
    const r = await this.get(id);
    const before = { ...r };
    Object.assign(r, dto);
    await this.repo.save(r);
    await this.audit.log({ actor: user, action: 'analytics.scheduled_report.update', entity: 'ScheduledReport', entityId: id, before, after: r });
    return r;
  }

  async remove(id: string, user: AuthUser) {
    const r = await this.get(id);
    await this.repo.remove(r);
    await this.audit.log({ actor: user, action: 'analytics.scheduled_report.delete', entity: 'ScheduledReport', entityId: id, before: r });
    return { deleted: true };
  }

  /** POST /admin/reports/scheduled/:id/run - send immediately (testing / "send now"). */
  async runNow(id: string, user: AuthUser) {
    const r = await this.get(id);
    await this.send(r);
    await this.audit.log({ actor: user, action: 'analytics.scheduled_report.run', entity: 'ScheduledReport', entityId: id });
    return { sent: true };
  }

  private computeRange(rangeKey: string | undefined, frequency: ScheduledReport['frequency']): { from: string; to: string } {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400_000);
    const key = rangeKey ?? (frequency === 'DAILY' ? 'yesterday' : frequency === 'WEEKLY' ? 'last7d' : 'lastMonth');
    switch (key) {
      case 'yesterday':
        return { from: iso(addDays(today, -1)), to: iso(today) };
      case 'last7d':
        return { from: iso(addDays(today, -7)), to: iso(today) };
      case 'last30d':
        return { from: iso(addDays(today, -30)), to: iso(today) };
      case 'mtd':
        return { from: iso(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))), to: iso(today) };
      case 'lastMonth':
      default: {
        const firstThis = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
        const firstLast = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
        return { from: iso(firstLast), to: iso(firstThis) };
      }
    }
  }

  private async send(report: ScheduledReport) {
    if (!report.recipients?.length) return;
    const range = this.computeRange(report.filters?.range, report.frequency);
    const f: AnalyticsFilterDto = {
      from: range.from,
      to: range.to,
      cityId: report.filters?.cityId,
      zoneId: report.filters?.zoneId,
      restaurantId: report.filters?.restaurantId,
      groupBy: report.filters?.groupBy,
    };
    const result = await this.exportSvc.build(report.dashboard, report.format, f, SYSTEM_USER);
    const subject = `FORKY ${report.name} - ${range.from} to ${range.to}`;
    const body =
      result.format === 'csv'
        ? `Scheduled report: ${report.name}\nDashboard: ${report.dashboard}\nPeriod: ${range.from} to ${range.to}\n\n${result.csv}`
        : `Scheduled report: ${report.name}\nDashboard: ${report.dashboard}\nPeriod: ${range.from} to ${range.to}\n\nThe ${result.filename} workbook was generated. Open it from the admin console (Reports > ${report.dashboard} > Export) - XLSX cannot be inlined in this plain-text email channel.`;
    for (const to of report.recipients) {
      await this.notifications.sendEmail(to, subject, body).catch((e: any) => this.logger.warn(`scheduled report "${report.name}" -> ${to} failed: ${e.message}`));
    }
  }

  private async runFrequency(frequency: ScheduledReport['frequency']) {
    const reports = await this.repo.find({ where: { frequency, active: true } });
    for (const r of reports) {
      await this.send(r).catch((e: any) => this.logger.warn(`scheduled report "${r.name}" failed: ${e.message}`));
    }
  }

  @Cron('0 7 * * *')
  sweepDaily() {
    return this.runFrequency('DAILY');
  }

  /** Monday 07:00 - covers the previous Mon-Sun week alongside SOP-07's payout lock. */
  @Cron('0 7 * * 1')
  sweepWeekly() {
    return this.runFrequency('WEEKLY');
  }

  @Cron('0 7 1 * *')
  sweepMonthly() {
    return this.runFrequency('MONTHLY');
  }
}
