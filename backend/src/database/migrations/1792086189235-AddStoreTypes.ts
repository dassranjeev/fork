import { MigrationInterface, QueryRunner } from "typeorm";

export class AddStoreTypes1792086189235 implements MigrationInterface {
    name = 'AddStoreTypes1792086189235'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TYPE "public"."restaurants_storetype_enum" AS ENUM(
                'RESTAURANT',
                'CAFE',
                'BAKERY',
                'GROCERY',
                'CONVENIENCE',
                'SPECIALTY'
            )
        `);
        await queryRunner.query(`
            ALTER TABLE "restaurants"
            ADD "storeType" "public"."restaurants_storetype_enum" NOT NULL DEFAULT 'RESTAURANT'
        `);
        await queryRunner.query(`
            ALTER TABLE "commission_tiers"
            ADD "defaultForStoreTypes" jsonb NOT NULL DEFAULT '[]'
        `);
        await queryRunner.query(`
            ALTER TABLE "menu_items"
            ADD "sku" character varying(64)
        `);
        await queryRunner.query(`
            ALTER TABLE "menu_items"
            ADD "barcode" character varying(32)
        `);
        await queryRunner.query(`
            ALTER TABLE "menu_items"
            ADD "brand" character varying(80)
        `);
        await queryRunner.query(`
            ALTER TABLE "menu_items"
            ADD "packSize" character varying(60)
        `);
        await queryRunner.query(`
            ALTER TABLE "menu_items"
            ADD "sellBy" character varying(10) NOT NULL DEFAULT 'UNIT'
        `);
        await queryRunner.query(`
            ALTER TABLE "menu_items"
            ADD "weightUnit" character varying(4) NOT NULL DEFAULT 'KG'
        `);
        await queryRunner.query(`
            ALTER TABLE "menu_items"
            ADD "stepSize" numeric(12, 3) NOT NULL DEFAULT '1'
        `);
        await queryRunner.query(`
            ALTER TABLE "menu_items"
            ADD "trackStock" boolean NOT NULL DEFAULT false
        `);
        await queryRunner.query(`
            ALTER TABLE "menu_items"
            ADD "stockQty" numeric(12, 3)
        `);
        await queryRunner.query(`
            ALTER TABLE "menu_items"
            ADD "lowStockThreshold" numeric(12, 3)
        `);
        await queryRunner.query(`
            ALTER TABLE "menu_items"
            ADD "maxPerOrder" integer
        `);
        await queryRunner.query(`
            ALTER TABLE "menu_items"
            ADD "minAge" integer NOT NULL DEFAULT '0'
        `);
        await queryRunner.query(`
            ALTER TABLE "menu_items"
            ADD "temperature" character varying(10) NOT NULL DEFAULT 'AMBIENT'
        `);
        await queryRunner.query(`
            ALTER TABLE "orders"
            ADD "requiresIdCheck" boolean NOT NULL DEFAULT false
        `);
        await queryRunner.query(`
            ALTER TABLE "orders"
            ADD "minAge" integer NOT NULL DEFAULT '0'
        `);
        await queryRunner.query(`
            ALTER TABLE "orders"
            ADD "ageConfirmed" boolean NOT NULL DEFAULT false
        `);
        await queryRunner.query(`
            ALTER TABLE "orders"
            ADD "basket" jsonb
        `);
        await queryRunner.query(`
            ALTER TABLE "order_items"
            ADD "sku" character varying(64)
        `);
        await queryRunner.query(`
            ALTER TABLE "order_items"
            ADD "barcode" character varying(32)
        `);
        await queryRunner.query(`
            ALTER TABLE "order_items"
            ADD "packSize" character varying(60)
        `);
        await queryRunner.query(`
            ALTER TABLE "order_items"
            ADD "sellBy" character varying(10) NOT NULL DEFAULT 'UNIT'
        `);
        await queryRunner.query(`
            ALTER TABLE "order_items"
            ADD "weightUnit" character varying(4) NOT NULL DEFAULT 'KG'
        `);
        await queryRunner.query(`
            ALTER TABLE "order_items"
            ADD "stepSize" numeric(12, 3) NOT NULL DEFAULT '1'
        `);
        await queryRunner.query(`
            ALTER TABLE "order_items"
            ADD "estimatedWeight" numeric(12, 3)
        `);
        await queryRunner.query(`
            ALTER TABLE "order_items"
            ADD "actualWeight" numeric(12, 3)
        `);
        await queryRunner.query(`
            ALTER TABLE "order_items"
            ADD "minAge" integer NOT NULL DEFAULT '0'
        `);
        await queryRunner.query(`
            ALTER TABLE "order_items"
            ADD "temperature" character varying(10) NOT NULL DEFAULT 'AMBIENT'
        `);
        await queryRunner.query(`
            ALTER TABLE "order_items"
            ADD "substitution" character varying(10) NOT NULL DEFAULT 'ALLOW'
        `);
        await queryRunner.query(`
            ALTER TABLE "order_items"
            ADD "pickStatus" character varying(14) NOT NULL DEFAULT 'PENDING'
        `);
        await queryRunner.query(`
            ALTER TABLE "order_items"
            ADD "replacement" jsonb
        `);
        await queryRunner.query(`
            ALTER TABLE "order_items"
            ADD "adjustmentRefund" numeric(12, 2) NOT NULL DEFAULT '0'
        `);
        await queryRunner.query(`
            ALTER TABLE "order_items"
            ADD "idRefused" boolean NOT NULL DEFAULT false
        `);
        await queryRunner.query(`
            ALTER TYPE "public"."restaurant_documents_type_enum"
            RENAME TO "restaurant_documents_type_enum_old"
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."restaurant_documents_type_enum" AS ENUM(
                'BUSINESS_LICENCE',
                'HEALTH_CERTIFICATE',
                'VOID_CHEQUE',
                'HST_CERTIFICATE',
                'AGREEMENT',
                'MENU',
                'PHOTOS',
                'LIQUOR_LICENCE',
                'TOBACCO_LICENCE',
                'FOOD_PREMISES_PERMIT',
                'OTHER'
            )
        `);
        await queryRunner.query(`
            ALTER TABLE "restaurant_documents"
            ALTER COLUMN "type" TYPE "public"."restaurant_documents_type_enum" USING "type"::"text"::"public"."restaurant_documents_type_enum"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."restaurant_documents_type_enum_old"
        `);
        // locations that were already on the platform as "Convenience" stores become CONVENIENCE stores (everything else stays a restaurant)
        await queryRunner.query(`
            UPDATE "restaurants" r SET "storeType" = 'CONVENIENCE'
            WHERE r."storeType" = 'RESTAURANT'
              AND EXISTS (SELECT 1 FROM "restaurant_cuisines" rc JOIN "cuisines" c ON c."id" = rc."cuisinesId" WHERE rc."restaurantsId" = r."id" AND c."slug" = 'convenience')
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_28bd1ee006db1155dcd805cfd0" ON "restaurants" ("storeType")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_menu_items_barcode" ON "menu_items" ("barcode")
            WHERE "barcode" IS NOT NULL
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_menu_items_restaurant_barcode" ON "menu_items" ("restaurantId", "barcode")
            WHERE "barcode" IS NOT NULL
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "UQ_menu_items_restaurant_sku" ON "menu_items" ("restaurantId", "sku")
            WHERE "sku" IS NOT NULL
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DROP INDEX "public"."UQ_menu_items_restaurant_sku"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_menu_items_restaurant_barcode"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_menu_items_barcode"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_28bd1ee006db1155dcd805cfd0"
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."restaurant_documents_type_enum_old" AS ENUM(
                'BUSINESS_LICENCE',
                'HEALTH_CERTIFICATE',
                'VOID_CHEQUE',
                'HST_CERTIFICATE',
                'AGREEMENT',
                'MENU',
                'PHOTOS',
                'OTHER'
            )
        `);
        await queryRunner.query(`
            ALTER TABLE "restaurant_documents"
            ALTER COLUMN "type" TYPE "public"."restaurant_documents_type_enum_old" USING "type"::"text"::"public"."restaurant_documents_type_enum_old"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."restaurant_documents_type_enum"
        `);
        await queryRunner.query(`
            ALTER TYPE "public"."restaurant_documents_type_enum_old"
            RENAME TO "restaurant_documents_type_enum"
        `);
        await queryRunner.query(`
            ALTER TABLE "order_items" DROP COLUMN "idRefused"
        `);
        await queryRunner.query(`
            ALTER TABLE "order_items" DROP COLUMN "adjustmentRefund"
        `);
        await queryRunner.query(`
            ALTER TABLE "order_items" DROP COLUMN "replacement"
        `);
        await queryRunner.query(`
            ALTER TABLE "order_items" DROP COLUMN "pickStatus"
        `);
        await queryRunner.query(`
            ALTER TABLE "order_items" DROP COLUMN "substitution"
        `);
        await queryRunner.query(`
            ALTER TABLE "order_items" DROP COLUMN "temperature"
        `);
        await queryRunner.query(`
            ALTER TABLE "order_items" DROP COLUMN "minAge"
        `);
        await queryRunner.query(`
            ALTER TABLE "order_items" DROP COLUMN "actualWeight"
        `);
        await queryRunner.query(`
            ALTER TABLE "order_items" DROP COLUMN "estimatedWeight"
        `);
        await queryRunner.query(`
            ALTER TABLE "order_items" DROP COLUMN "stepSize"
        `);
        await queryRunner.query(`
            ALTER TABLE "order_items" DROP COLUMN "weightUnit"
        `);
        await queryRunner.query(`
            ALTER TABLE "order_items" DROP COLUMN "sellBy"
        `);
        await queryRunner.query(`
            ALTER TABLE "order_items" DROP COLUMN "packSize"
        `);
        await queryRunner.query(`
            ALTER TABLE "order_items" DROP COLUMN "barcode"
        `);
        await queryRunner.query(`
            ALTER TABLE "order_items" DROP COLUMN "sku"
        `);
        await queryRunner.query(`
            ALTER TABLE "orders" DROP COLUMN "basket"
        `);
        await queryRunner.query(`
            ALTER TABLE "orders" DROP COLUMN "ageConfirmed"
        `);
        await queryRunner.query(`
            ALTER TABLE "orders" DROP COLUMN "minAge"
        `);
        await queryRunner.query(`
            ALTER TABLE "orders" DROP COLUMN "requiresIdCheck"
        `);
        await queryRunner.query(`
            ALTER TABLE "menu_items" DROP COLUMN "temperature"
        `);
        await queryRunner.query(`
            ALTER TABLE "menu_items" DROP COLUMN "minAge"
        `);
        await queryRunner.query(`
            ALTER TABLE "menu_items" DROP COLUMN "maxPerOrder"
        `);
        await queryRunner.query(`
            ALTER TABLE "menu_items" DROP COLUMN "lowStockThreshold"
        `);
        await queryRunner.query(`
            ALTER TABLE "menu_items" DROP COLUMN "stockQty"
        `);
        await queryRunner.query(`
            ALTER TABLE "menu_items" DROP COLUMN "trackStock"
        `);
        await queryRunner.query(`
            ALTER TABLE "menu_items" DROP COLUMN "stepSize"
        `);
        await queryRunner.query(`
            ALTER TABLE "menu_items" DROP COLUMN "weightUnit"
        `);
        await queryRunner.query(`
            ALTER TABLE "menu_items" DROP COLUMN "sellBy"
        `);
        await queryRunner.query(`
            ALTER TABLE "menu_items" DROP COLUMN "packSize"
        `);
        await queryRunner.query(`
            ALTER TABLE "menu_items" DROP COLUMN "brand"
        `);
        await queryRunner.query(`
            ALTER TABLE "menu_items" DROP COLUMN "barcode"
        `);
        await queryRunner.query(`
            ALTER TABLE "menu_items" DROP COLUMN "sku"
        `);
        await queryRunner.query(`
            ALTER TABLE "commission_tiers" DROP COLUMN "defaultForStoreTypes"
        `);
        await queryRunner.query(`
            ALTER TABLE "restaurants" DROP COLUMN "storeType"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."restaurants_storetype_enum"
        `);
    }

}
