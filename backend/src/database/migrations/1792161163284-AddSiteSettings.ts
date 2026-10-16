import { MigrationInterface, QueryRunner } from "typeorm";

export class AddSiteSettings1792161163284 implements MigrationInterface {
    name = 'AddSiteSettings1792161163284'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "site_settings" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "section" character varying(40) NOT NULL,
                "value" jsonb NOT NULL,
                "version" integer NOT NULL DEFAULT '1',
                "updatedBy" uuid,
                "updatedByName" character varying,
                CONSTRAINT "PK_e4290e8371a166d7e066d131f6e" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "IDX_315ad8b9ff829f9160110a7bd3" ON "site_settings" ("section")
        `);
        await queryRunner.query(`
            CREATE TABLE "site_setting_revisions" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "section" character varying(40) NOT NULL,
                "version" integer NOT NULL,
                "value" jsonb NOT NULL,
                "createdBy" uuid,
                "createdByName" character varying,
                "note" character varying,
                CONSTRAINT "PK_da83f787d9edd608528312b10f3" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "IDX_42caccb3e3c0ecbab60283d562" ON "site_setting_revisions" ("section", "version")
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DROP INDEX "public"."IDX_42caccb3e3c0ecbab60283d562"
        `);
        await queryRunner.query(`
            DROP TABLE "site_setting_revisions"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_315ad8b9ff829f9160110a7bd3"
        `);
        await queryRunner.query(`
            DROP TABLE "site_settings"
        `);
    }

}
