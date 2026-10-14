import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { SettingsService } from '../settings/settings.service';
import { BACKFILL_KEY } from './verification-policy';

/**
 * Once, at the first start after this feature arrives: accounts that already went through the manual onboarding pipeline are recorded
 * as verified (method MANUAL), so "Force verification" only ever touches accounts admitted later without verification.
 *
 * The AddVerification migration does the same for databases that are migrated (production). This is the safety net for databases whose
 * schema is created by synchronize (local development: DB_SYNC=true), where the new columns appear with their default PENDING and the
 * migration never runs. Every statement only touches rows that still have the untouched defaults (PENDING, no method), so it can never
 * overwrite a decision made by the new flows, and it is a no-op after a migration.
 */
@Injectable()
export class VerificationBackfill implements OnModuleInit {
  private readonly logger = new Logger('VerificationBackfill');

  constructor(
    @InjectDataSource() private ds: DataSource,
    private settings: SettingsService,
  ) {}

  async onModuleInit() {
    try {
      if (this.settings.get<boolean>(BACKFILL_KEY, false)) return;
      const counts = await this.run();
      await this.settings.set(BACKFILL_KEY, true);
      if (counts.some((n) => n > 0)) this.logger.log(`recorded existing accounts as manually verified: ${counts[0]} drivers, ${counts[2]} businesses (${counts[1]} drivers and ${counts[3]} businesses as rejected)`);
    } catch (e) {
      this.logger.warn(`verification backfill skipped: ${(e as Error).message}`);
    }
  }

  /** returns the rows changed by each of the four statements: drivers verified, drivers rejected, businesses verified, businesses rejected */
  async run(): Promise<number[]> {
    const affected = async (sql: string) => {
      const res: any = await this.ds.query(sql);
      // pg returns [rows, rowCount] for UPDATE through TypeORM's query()
      return Array.isArray(res) ? (typeof res[1] === 'number' ? res[1] : res.length) : 0;
    };
    return [
      await affected(`
        UPDATE "driver_profiles"
        SET "verificationStatus" = 'VERIFIED', "verificationMethod" = 'MANUAL', "verifiedAt" = COALESCE("approvedAt", "updatedAt")
        WHERE "verificationStatus" = 'PENDING' AND "verificationMethod" IS NULL
          AND ("status" IN ('APPROVED', 'ACTIVE') OR ("status" IN ('SUSPENDED', 'DEACTIVATED') AND "approvedAt" IS NOT NULL))`),
      await affected(`
        UPDATE "driver_profiles" SET "verificationStatus" = 'REJECTED'
        WHERE "verificationStatus" = 'PENDING' AND "verificationMethod" IS NULL AND "status" = 'REJECTED'`),
      await affected(`
        UPDATE "merchants" m
        SET "verificationStatus" = 'VERIFIED', "verificationMethod" = 'MANUAL',
            "verifiedAt" = COALESCE((SELECT MIN(r."wentLiveAt") FROM "restaurants" r WHERE r."merchantId" = m."id"), m."updatedAt")
        WHERE m."verificationStatus" = 'PENDING' AND m."verificationMethod" IS NULL
          AND EXISTS (SELECT 1 FROM "restaurants" r WHERE r."merchantId" = m."id" AND (r."status" IN ('LIVE', 'PAUSED', 'SUSPENDED') OR r."wentLiveAt" IS NOT NULL))`),
      await affected(`
        UPDATE "merchants" m SET "verificationStatus" = 'REJECTED'
        WHERE m."verificationStatus" = 'PENDING' AND m."verificationMethod" IS NULL
          AND EXISTS (SELECT 1 FROM "restaurants" r WHERE r."merchantId" = m."id")
          AND NOT EXISTS (SELECT 1 FROM "restaurants" r WHERE r."merchantId" = m."id" AND r."status" <> 'REJECTED')`),
    ];
  }
}
