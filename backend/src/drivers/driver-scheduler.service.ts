import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { LessThanOrEqual } from 'typeorm';
import { DocStatus } from '../common/enums';
import { DriverCoreService } from './driver-core.service';
import { daysUntil, todayStr } from './drivers.util';

/** SOP-02 document-expiry scheduler: flips APPROVED docs past their date to EXPIRED and sends reminders. */
@Injectable()
export class DriverExpiryScheduler {
  private readonly logger = new Logger('DriverExpiry');

  constructor(private core: DriverCoreService) {}

  @Cron(CronExpression.EVERY_DAY_AT_6AM)
  async sweep() {
    try {
      await this.expireOverdue();
    } catch (e: any) {
      this.logger.error(`expire sweep failed: ${e.message}`);
    }
    try {
      await this.sendReminders();
    } catch (e: any) {
      this.logger.error(`reminder sweep failed: ${e.message}`);
    }
  }

  private async expireOverdue() {
    const today = todayStr();
    const stale = await this.core.docs.find({ where: { status: DocStatus.APPROVED, expiresAt: LessThanOrEqual(today) } });
    for (const doc of stale) {
      doc.status = DocStatus.EXPIRED;
      await this.core.docs.save(doc);
      const driver = await this.core.profiles.findOne({ where: { id: doc.driverId }, relations: ['user'] });
      if (!driver) continue;
      await this.core.notifyDriver(driver, 'document.expired', { docType: doc.type }, { documentId: doc.id }, {
        title: 'Document expired',
        body: `Your ${doc.type} has expired. Upload a new copy to keep going online.`,
      });
      await this.core.opsNotify('document.expired', `Driver document expired`, `${this.core.driverName(driver)}: ${doc.type} expired.`, { driverId: driver.id, docType: doc.type });
      if (driver.isOnline) await this.core.forceOffline(driver, `${doc.type} expired`);
    }
  }

  private async sendReminders() {
    const thresholds = this.core.settings.get<number[]>('driver.docExpiryReminderDays', [30, 14, 7, 1]);
    const candidates = await this.core.docs.find({
      where: { status: DocStatus.APPROVED, expiresAt: LessThanOrEqual(new Date(Date.now() + Math.max(...thresholds) * 86400000).toISOString().slice(0, 10)) },
    });
    for (const doc of candidates) {
      if (!doc.expiresAt || doc.expiryReminderSentAt) continue;
      const remaining = daysUntil(doc.expiresAt);
      if (!thresholds.includes(remaining)) continue;
      const driver = await this.core.profiles.findOne({ where: { id: doc.driverId }, relations: ['user'] });
      if (!driver) continue;
      await this.core.notifyDriver(driver, 'document.expiring', { docType: doc.type, days: remaining }, { documentId: doc.id }, {
        title: 'Document expiring soon',
        body: `Your ${doc.type} expires in ${remaining} day${remaining === 1 ? '' : 's'}. Upload a renewed copy to avoid being taken offline.`,
      });
      doc.expiryReminderSentAt = new Date();
      await this.core.docs.save(doc);
    }
  }
}
