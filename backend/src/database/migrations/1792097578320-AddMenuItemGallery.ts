import { MigrationInterface, QueryRunner } from "typeorm";

export class AddMenuItemGallery1792097578320 implements MigrationInterface {
    name = 'AddMenuItemGallery1792097578320'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "menu_items"
            ADD "galleryUrls" jsonb NOT NULL DEFAULT '[]'
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "menu_items" DROP COLUMN "galleryUrls"
        `);
    }

}
