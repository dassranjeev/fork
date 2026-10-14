import { MigrationInterface, QueryRunner } from "typeorm";

export class AddVerification1791999273015 implements MigrationInterface {
    name = 'AddVerification1791999273015'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TYPE "public"."merchants_verificationstatus_enum" AS ENUM(
                'UNVERIFIED',
                'PENDING',
                'NEEDS_REVIEW',
                'VERIFIED',
                'REJECTED'
            )
        `);
        await queryRunner.query(`
            ALTER TABLE "merchants"
            ADD "verificationStatus" "public"."merchants_verificationstatus_enum" NOT NULL DEFAULT 'PENDING'
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."merchants_verificationmethod_enum" AS ENUM('INSTANT', 'MANUAL', 'AUTOMATIC')
        `);
        await queryRunner.query(`
            ALTER TABLE "merchants"
            ADD "verificationMethod" "public"."merchants_verificationmethod_enum"
        `);
        await queryRunner.query(`
            ALTER TABLE "merchants"
            ADD "verifiedAt" TIMESTAMP WITH TIME ZONE
        `);
        await queryRunner.query(`
            ALTER TABLE "merchants"
            ADD "verifiedBy" uuid
        `);
        await queryRunner.query(`
            ALTER TABLE "merchants"
            ADD "verificationForcedAt" TIMESTAMP WITH TIME ZONE
        `);
        await queryRunner.query(`
            ALTER TABLE "merchants"
            ADD "verificationDueAt" TIMESTAMP WITH TIME ZONE
        `);
        await queryRunner.query(`
            ALTER TABLE "merchants"
            ADD "backgroundCheckProvider" character varying
        `);
        await queryRunner.query(`
            ALTER TABLE "merchants"
            ADD "backgroundCheckStatus" character varying NOT NULL DEFAULT 'NOT_STARTED'
        `);
        await queryRunner.query(`
            ALTER TABLE "merchants"
            ADD "backgroundCheckRef" character varying
        `);
        await queryRunner.query(`
            ALTER TABLE "merchants"
            ADD "meta" jsonb NOT NULL DEFAULT '{}'
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."driver_profiles_verificationstatus_enum" AS ENUM(
                'UNVERIFIED',
                'PENDING',
                'NEEDS_REVIEW',
                'VERIFIED',
                'REJECTED'
            )
        `);
        await queryRunner.query(`
            ALTER TABLE "driver_profiles"
            ADD "verificationStatus" "public"."driver_profiles_verificationstatus_enum" NOT NULL DEFAULT 'PENDING'
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."driver_profiles_verificationmethod_enum" AS ENUM('INSTANT', 'MANUAL', 'AUTOMATIC')
        `);
        await queryRunner.query(`
            ALTER TABLE "driver_profiles"
            ADD "verificationMethod" "public"."driver_profiles_verificationmethod_enum"
        `);
        await queryRunner.query(`
            ALTER TABLE "driver_profiles"
            ADD "verifiedAt" TIMESTAMP WITH TIME ZONE
        `);
        await queryRunner.query(`
            ALTER TABLE "driver_profiles"
            ADD "verifiedBy" uuid
        `);
        await queryRunner.query(`
            ALTER TABLE "driver_profiles"
            ADD "verificationForcedAt" TIMESTAMP WITH TIME ZONE
        `);
        await queryRunner.query(`
            ALTER TABLE "driver_profiles"
            ADD "verificationDueAt" TIMESTAMP WITH TIME ZONE
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_7b6e9e58df2f3bfec5a9e3c550" ON "merchants" ("verificationStatus")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_c807197fb3fede39580e7d6830" ON "driver_profiles" ("verificationStatus")
        `);
        // Backfill (docs/verification.md): everyone who already went through the manual onboarding pipeline counts as verified (method MANUAL),
        // so "Force verification" only ever touches accounts admitted later without verification. Accounts still in the pipeline keep the
        // column default PENDING.
        await queryRunner.query(`
            UPDATE "driver_profiles"
            SET "verificationStatus" = 'VERIFIED', "verificationMethod" = 'MANUAL', "verifiedAt" = COALESCE("approvedAt", "updatedAt")
            WHERE "status" IN ('APPROVED', 'ACTIVE') OR ("status" IN ('SUSPENDED', 'DEACTIVATED') AND "approvedAt" IS NOT NULL)
        `);
        await queryRunner.query(`
            UPDATE "driver_profiles" SET "verificationStatus" = 'REJECTED' WHERE "status" = 'REJECTED'
        `);
        await queryRunner.query(`
            UPDATE "merchants" m
            SET "verificationStatus" = 'VERIFIED', "verificationMethod" = 'MANUAL',
                "verifiedAt" = COALESCE((SELECT MIN(r."wentLiveAt") FROM "restaurants" r WHERE r."merchantId" = m."id"), m."updatedAt")
            WHERE EXISTS (
                SELECT 1 FROM "restaurants" r
                WHERE r."merchantId" = m."id" AND (r."status" IN ('LIVE', 'PAUSED', 'SUSPENDED') OR r."wentLiveAt" IS NOT NULL)
            )
        `);
        await queryRunner.query(`
            UPDATE "merchants" m
            SET "verificationStatus" = 'REJECTED'
            WHERE m."verificationStatus" = 'PENDING'
              AND EXISTS (SELECT 1 FROM "restaurants" r WHERE r."merchantId" = m."id")
              AND NOT EXISTS (SELECT 1 FROM "restaurants" r WHERE r."merchantId" = m."id" AND r."status" <> 'REJECTED')
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DROP INDEX "public"."IDX_c807197fb3fede39580e7d6830"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_7b6e9e58df2f3bfec5a9e3c550"
        `);
        await queryRunner.query(`
            ALTER TABLE "driver_profiles" DROP COLUMN "verificationDueAt"
        `);
        await queryRunner.query(`
            ALTER TABLE "driver_profiles" DROP COLUMN "verificationForcedAt"
        `);
        await queryRunner.query(`
            ALTER TABLE "driver_profiles" DROP COLUMN "verifiedBy"
        `);
        await queryRunner.query(`
            ALTER TABLE "driver_profiles" DROP COLUMN "verifiedAt"
        `);
        await queryRunner.query(`
            ALTER TABLE "driver_profiles" DROP COLUMN "verificationMethod"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."driver_profiles_verificationmethod_enum"
        `);
        await queryRunner.query(`
            ALTER TABLE "driver_profiles" DROP COLUMN "verificationStatus"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."driver_profiles_verificationstatus_enum"
        `);
        await queryRunner.query(`
            ALTER TABLE "merchants" DROP COLUMN "meta"
        `);
        await queryRunner.query(`
            ALTER TABLE "merchants" DROP COLUMN "backgroundCheckRef"
        `);
        await queryRunner.query(`
            ALTER TABLE "merchants" DROP COLUMN "backgroundCheckStatus"
        `);
        await queryRunner.query(`
            ALTER TABLE "merchants" DROP COLUMN "backgroundCheckProvider"
        `);
        await queryRunner.query(`
            ALTER TABLE "merchants" DROP COLUMN "verificationDueAt"
        `);
        await queryRunner.query(`
            ALTER TABLE "merchants" DROP COLUMN "verificationForcedAt"
        `);
        await queryRunner.query(`
            ALTER TABLE "merchants" DROP COLUMN "verifiedBy"
        `);
        await queryRunner.query(`
            ALTER TABLE "merchants" DROP COLUMN "verifiedAt"
        `);
        await queryRunner.query(`
            ALTER TABLE "merchants" DROP COLUMN "verificationMethod"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."merchants_verificationmethod_enum"
        `);
        await queryRunner.query(`
            ALTER TABLE "merchants" DROP COLUMN "verificationStatus"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."merchants_verificationstatus_enum"
        `);
    }

}
