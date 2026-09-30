import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Ticket } from '../database/entities';
import { NotificationsService } from '../notifications/notifications.service';
import { TicketsService } from './tickets.service';
import { ReviewCasesService } from './review-cases.service';
import { OPEN_STATUSES } from './support.constants';

/** SLA breach flagging (spec: "SLA timers + scheduler flagging breaches") and the SOP-08 auto-detector. */
@Injectable()
export class SupportSchedulerService {
  private readonly logger = new Logger(SupportSchedulerService.name);

  constructor(
    @InjectRepository(Ticket) private ticketRepo: Repository<Ticket>,
    private tickets: TicketsService,
    private reviewCases: ReviewCasesService,
    private notifications: NotificationsService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async flagSlaBreaches() {
    try {
      const now = new Date();
      const rows = await this.ticketRepo
        .createQueryBuilder('t')
        .where('t.status IN (:...open)', { open: OPEN_STATUSES })
        .andWhere('t."slaBreached" = false')
        .andWhere('((t."firstResponseAt" IS NULL AND t."slaFirstResponseDueAt" < :now) OR (t."slaResolutionDueAt" IS NOT NULL AND t."slaResolutionDueAt" < :now))', { now })
        .getMany();
      for (const t of rows) {
        const type = !t.firstResponseAt && t.slaFirstResponseDueAt && t.slaFirstResponseDueAt < now ? 'FIRST_RESPONSE' : 'RESOLUTION';
        t.slaBreached = true;
        t.slaBreachType = type;
        t.slaBreachNotifiedAt = now;
        await this.ticketRepo.save(t);
        this.tickets.publish(t, 'sla_breach');
        void this.notifications.notifyOps('ticket.update', { number: t.number, subject: `SLA breached (${type}): ${t.subject}` }, { ticketId: t.id, event: 'sla_breach' }).catch(() => undefined);
      }
      if (rows.length) this.logger.log(`Flagged ${rows.length} ticket(s) as SLA-breached`);
    } catch (e: any) {
      this.logger.error(`flagSlaBreaches failed: ${e.message}`);
    }
  }

  /** SOP-08: propose review cases for low rating / repeated cancellations (idempotent - skips subjects with an open case). */
  @Cron(CronExpression.EVERY_HOUR)
  async proposeReviewCases() {
    try {
      const n = await this.reviewCases.runDetector();
      if (n) this.logger.log(`SOP-08 detector proposed ${n} review case(s)`);
    } catch (e: any) {
      this.logger.error(`proposeReviewCases failed: ${e.message}`);
    }
  }
}
