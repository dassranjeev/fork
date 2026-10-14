import { MigrationInterface, QueryRunner } from "typeorm";

export class AddSystemInstances1791987961978 implements MigrationInterface {
    name = 'AddSystemInstances1791987961978'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // UNLOGGED: rewritten every ~2 s by every API instance, so no write-ahead log; after a crash the rows simply reappear within seconds
        await queryRunner.query(`
            CREATE UNLOGGED TABLE "system_instances" (
                "id" character varying(100) NOT NULL,
                "hostname" character varying(120) NOT NULL,
                "pid" integer NOT NULL DEFAULT '0',
                "startedAt" TIMESTAMP WITH TIME ZONE NOT NULL,
                "lastSeenAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "version" character varying(60) NOT NULL DEFAULT '',
                "nodeVersion" character varying(30) NOT NULL DEFAULT '',
                "env" character varying(30) NOT NULL DEFAULT '',
                "drainRequested" boolean NOT NULL DEFAULT false,
                "metrics" jsonb NOT NULL DEFAULT '{}',
                "series" jsonb NOT NULL DEFAULT '{}',
                CONSTRAINT "PK_4304601926bab9c36544940e0f4" PRIMARY KEY ("id")
            )
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DROP TABLE "system_instances"
        `);
    }

}
