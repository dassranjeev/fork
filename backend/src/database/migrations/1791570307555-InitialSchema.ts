import { MigrationInterface, QueryRunner } from "typeorm";

export class InitialSchema1791570307555 implements MigrationInterface {
    name = 'InitialSchema1791570307555'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "roles" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "name" character varying NOT NULL,
                "description" text,
                "isSystem" boolean NOT NULL DEFAULT false,
                "permissions" jsonb NOT NULL DEFAULT '{}',
                "refundLimit" numeric(12, 2),
                "cityIds" jsonb NOT NULL DEFAULT '[]',
                "zoneIds" jsonb NOT NULL DEFAULT '[]',
                CONSTRAINT "PK_c1433d71a4838793a49dcad46ab" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "IDX_648e3f5447f725579d7d4ffdfb" ON "roles" ("name")
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."users_type_enum" AS ENUM(
                'SUPER_ADMIN',
                'STAFF',
                'RESTAURANT',
                'DRIVER',
                'CUSTOMER'
            )
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."users_status_enum" AS ENUM(
                'PENDING',
                'ACTIVE',
                'SUSPENDED',
                'BLOCKED',
                'DELETED'
            )
        `);
        await queryRunner.query(`
            CREATE TABLE "users" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "email" character varying,
                "phone" character varying,
                "passwordHash" character varying,
                "type" "public"."users_type_enum" NOT NULL,
                "status" "public"."users_status_enum" NOT NULL DEFAULT 'ACTIVE',
                "firstName" character varying NOT NULL DEFAULT '',
                "lastName" character varying NOT NULL DEFAULT '',
                "avatarUrl" character varying,
                "language" character varying NOT NULL DEFAULT 'en',
                "emailVerified" boolean NOT NULL DEFAULT false,
                "phoneVerified" boolean NOT NULL DEFAULT false,
                "roleId" uuid,
                "googleId" character varying,
                "appleId" character varying,
                "twoFactorEnabled" boolean NOT NULL DEFAULT false,
                "twoFactorSecret" character varying,
                "lastLoginAt" TIMESTAMP WITH TIME ZONE,
                "lastLoginIp" character varying,
                "failedLoginCount" integer NOT NULL DEFAULT '0',
                "lockedUntil" TIMESTAMP WITH TIME ZONE,
                "passwordChangedAt" TIMESTAMP WITH TIME ZONE,
                "tokensValidAfter" TIMESTAMP WITH TIME ZONE,
                "tokenVersion" integer NOT NULL DEFAULT '0',
                "deletedAt" TIMESTAMP WITH TIME ZONE,
                CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "IDX_e2dd77cb8a46c78d8ea34de039" ON "users" ("email")
            WHERE "email" IS NOT NULL
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "IDX_875541f7dbe1b8565414f9f80b" ON "users" ("phone")
            WHERE "phone" IS NOT NULL
        `);
        await queryRunner.query(`
            CREATE TABLE "refresh_tokens" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "userId" uuid NOT NULL,
                "tokenHash" character varying NOT NULL,
                "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL,
                "revokedAt" TIMESTAMP WITH TIME ZONE,
                "deviceInfo" character varying,
                "ip" character varying,
                CONSTRAINT "PK_7d8bee0204106019488c4c50ffa" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_610102b60fea1455310ccd299d" ON "refresh_tokens" ("userId")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_c25bc63d248ca90e8dcc1d92d0" ON "refresh_tokens" ("tokenHash")
        `);
        await queryRunner.query(`
            CREATE TABLE "otp_codes" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "target" character varying NOT NULL,
                "codeHash" character varying NOT NULL,
                "purpose" character varying NOT NULL,
                "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL,
                "attempts" integer NOT NULL DEFAULT '0',
                "consumedAt" TIMESTAMP WITH TIME ZONE,
                CONSTRAINT "PK_9d0487965ac1837d57fec4d6a26" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_24051aebfe891219eaca0c1b76" ON "otp_codes" ("target")
        `);
        await queryRunner.query(`
            CREATE TABLE "device_tokens" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "userId" uuid NOT NULL,
                "token" character varying NOT NULL,
                "platform" character varying NOT NULL DEFAULT 'android',
                "app" character varying NOT NULL DEFAULT 'customer',
                "appVersion" character varying,
                "fingerprint" character varying,
                "lastSeenAt" TIMESTAMP WITH TIME ZONE,
                "failures" integer NOT NULL DEFAULT '0',
                CONSTRAINT "PK_84700be257607cfb1f9dc2e52c3" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_511957e3e8443429dc3fb00120" ON "device_tokens" ("userId")
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "IDX_977e24c520c49436d08e5eeea8" ON "device_tokens" ("token")
        `);
        await queryRunner.query(`
            CREATE TABLE "cities" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "name" character varying NOT NULL,
                "province" character varying NOT NULL DEFAULT 'ON',
                "country" character varying NOT NULL DEFAULT 'Canada',
                "timezone" character varying NOT NULL DEFAULT 'America/Toronto',
                "currency" character varying NOT NULL DEFAULT 'CAD',
                "active" boolean NOT NULL DEFAULT true,
                "centerLat" double precision,
                "centerLng" double precision,
                "baseDeliveryFee" numeric(12, 2) NOT NULL DEFAULT 1.99,
                "perKmFee" numeric(12, 2) NOT NULL DEFAULT 0.5,
                "serviceFeePct" numeric(6, 3) NOT NULL DEFAULT '10',
                "serviceFeeCap" numeric(12, 2) NOT NULL DEFAULT '5',
                "smallOrderThreshold" numeric(12, 2) NOT NULL DEFAULT '15',
                "smallOrderFee" numeric(12, 2) NOT NULL DEFAULT '2',
                "busyMultiplier" numeric(6, 3) NOT NULL DEFAULT '1',
                "driverBaseFare" numeric(12, 2) NOT NULL DEFAULT '3',
                "driverPerKm" numeric(12, 2) NOT NULL DEFAULT 0.6,
                "driverPerWaitMin" numeric(12, 2) NOT NULL DEFAULT 0.25,
                "driverFreeWaitMin" integer NOT NULL DEFAULT '5',
                "driverMinPerTrip" numeric(12, 2) NOT NULL DEFAULT 4.5,
                "offerTimeoutSec" integer NOT NULL DEFAULT '30',
                "offersBeforeWiden" integer NOT NULL DEFAULT '3',
                "maxRadiusWidenings" integer NOT NULL DEFAULT '2',
                "radiusWidenStepKm" integer NOT NULL DEFAULT '2',
                "widenBoostAmount" numeric(12, 2) NOT NULL DEFAULT '2',
                "batchMaxOrders" integer NOT NULL DEFAULT '2',
                "batchMaxDropDistanceKm" numeric(6, 3) NOT NULL DEFAULT 1.5,
                "batchMaxExtraMinutes" integer NOT NULL DEFAULT '10',
                "autoRejectSeconds" integer NOT NULL DEFAULT '180',
                "pickupOverdueMin" integer NOT NULL DEFAULT '10',
                "lateOnTheWayGraceMin" integer NOT NULL DEFAULT '10',
                "veryLateMin" integer NOT NULL DEFAULT '30',
                "payoutReleaseThreshold" numeric(12, 2) NOT NULL DEFAULT '250',
                CONSTRAINT "PK_4762ffb6e5d198cfec5606bc11e" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE TABLE "zones" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "cityId" uuid NOT NULL,
                "name" character varying NOT NULL,
                "active" boolean NOT NULL DEFAULT true,
                "polygon" jsonb NOT NULL DEFAULT '[]',
                "centerLat" double precision,
                "centerLng" double precision,
                "deliveryRadiusKm" numeric(6, 3),
                "maxDeliveryRadiusKm" numeric(6, 3),
                "baseFee" numeric(12, 2),
                "perKmFee" numeric(12, 2),
                "minimumOrder" numeric(12, 2),
                "serviceHours" jsonb NOT NULL DEFAULT '{}',
                "busyMode" boolean NOT NULL DEFAULT false,
                "busyMultiplier" numeric(6, 3) NOT NULL DEFAULT '1',
                "busyRadiusKm" numeric(6, 3),
                "targetDrivers" integer NOT NULL DEFAULT '0',
                CONSTRAINT "PK_880484a43ca311707b05895bd4a" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_51a2d07892da307f5b0865e18b" ON "zones" ("cityId")
        `);
        await queryRunner.query(`
            CREATE TABLE "tax_classes" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "code" character varying NOT NULL,
                "name" character varying NOT NULL,
                "ratePct" numeric(6, 3) NOT NULL DEFAULT '13',
                "active" boolean NOT NULL DEFAULT true,
                "isDefault" boolean NOT NULL DEFAULT false,
                CONSTRAINT "PK_ade7a0e59106fbcc440177f5a58" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "IDX_df84a504ff248483d8d32fc0cb" ON "tax_classes" ("code")
        `);
        await queryRunner.query(`
            CREATE TABLE "commission_tiers" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "name" character varying NOT NULL,
                "description" text,
                "deliveryPct" numeric(6, 3) NOT NULL DEFAULT '20',
                "pickupPct" numeric(6, 3) NOT NULL DEFAULT '8',
                "ownDriverPct" numeric(6, 3) NOT NULL DEFAULT '12',
                "active" boolean NOT NULL DEFAULT true,
                "isDefault" boolean NOT NULL DEFAULT false,
                CONSTRAINT "PK_4a4e90399d2199e02d9d72cdd8b" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "IDX_dd529a8ebea30f953e24a2dbea" ON "commission_tiers" ("name")
        `);
        await queryRunner.query(`
            CREATE TABLE "cuisines" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "name" character varying NOT NULL,
                "slug" character varying NOT NULL,
                "iconUrl" character varying,
                "sortOrder" integer NOT NULL DEFAULT '0',
                "active" boolean NOT NULL DEFAULT true,
                CONSTRAINT "PK_22b98d435f9359f707c764953a5" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "IDX_454d7d111836fd30f49a7a9ebb" ON "cuisines" ("slug")
        `);
        await queryRunner.query(`
            CREATE TABLE "merchants" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "businessName" character varying NOT NULL,
                "legalName" character varying,
                "hstNumber" character varying,
                "contactEmail" character varying,
                "contactPhone" character varying,
                "stripeAccountId" character varying,
                "stripeAccountStatus" character varying NOT NULL DEFAULT 'NOT_STARTED',
                "stripeAccountInfo" jsonb,
                "bank" jsonb,
                "agreementSignedAt" TIMESTAMP WITH TIME ZONE,
                "agreementSignedBy" character varying,
                "payoutHold" boolean NOT NULL DEFAULT false,
                "payoutHoldReason" character varying,
                "bankVerification" jsonb,
                CONSTRAINT "PK_4fd312ef25f8e05ad47bfe7ed25" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."restaurants_status_enum" AS ENUM(
                'APPLIED',
                'DOCS_REVIEW',
                'MENU_SETUP',
                'TEST_ORDER',
                'LIVE',
                'PAUSED',
                'SUSPENDED',
                'REJECTED'
            )
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."restaurants_servicemode_enum" AS ENUM('CLOSED', 'PICKUP_ONLY', 'PICKUP_AND_DELIVERY')
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."restaurants_menueditstatus_enum" AS ENUM('NOT_ALLOWED', 'REQUESTED', 'ALLOWED')
        `);
        await queryRunner.query(`
            CREATE TABLE "restaurants" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "merchantId" uuid NOT NULL,
                "name" character varying NOT NULL,
                "slug" character varying NOT NULL,
                "description" text,
                "logoUrl" character varying,
                "coverUrl" character varying,
                "photos" jsonb NOT NULL DEFAULT '[]',
                "phone" character varying,
                "email" character varying,
                "website" character varying,
                "addressLine1" character varying NOT NULL DEFAULT '',
                "addressLine2" character varying,
                "city" character varying NOT NULL DEFAULT '',
                "province" character varying NOT NULL DEFAULT 'ON',
                "postalCode" character varying NOT NULL DEFAULT '',
                "lat" double precision,
                "lng" double precision,
                "cityId" uuid,
                "zoneId" uuid,
                "priceLevel" integer NOT NULL DEFAULT '2',
                "hstNumber" character varying,
                "status" "public"."restaurants_status_enum" NOT NULL DEFAULT 'APPLIED',
                "statusReason" text,
                "wentLiveAt" TIMESTAMP WITH TIME ZONE,
                "acceptingOrders" boolean NOT NULL DEFAULT false,
                "pausedUntil" TIMESTAMP WITH TIME ZONE,
                "serviceMode" "public"."restaurants_servicemode_enum" NOT NULL DEFAULT 'PICKUP_AND_DELIVERY',
                "serviceModeUpdatedAt" TIMESTAMP WITH TIME ZONE,
                "serviceModeResumeAt" TIMESTAMP WITH TIME ZONE,
                "menuEditStatus" "public"."restaurants_menueditstatus_enum" NOT NULL DEFAULT 'NOT_ALLOWED',
                "menuEditRequestedAt" TIMESTAMP WITH TIME ZONE,
                "menuEditRequestNote" character varying(500),
                "menuEditDecidedAt" TIMESTAMP WITH TIME ZONE,
                "menuEditDecidedById" uuid,
                "menuEditDecisionNote" character varying(500),
                "busyExtraPrepMin" integer NOT NULL DEFAULT '0',
                "commissionTierId" uuid,
                "deliveryCommissionPct" numeric(6, 3),
                "pickupCommissionPct" numeric(6, 3),
                "ownDriverCommissionPct" numeric(6, 3),
                "deliveryEnabled" boolean NOT NULL DEFAULT true,
                "ownDeliveryEnabled" boolean NOT NULL DEFAULT false,
                "ownDeliveryFee" numeric(12, 2) NOT NULL DEFAULT '0',
                "pickupEnabled" boolean NOT NULL DEFAULT true,
                "scheduledEnabled" boolean NOT NULL DEFAULT true,
                "dineInEnabled" boolean NOT NULL DEFAULT false,
                "prepTimeMin" integer NOT NULL DEFAULT '20',
                "pickupPrepTimeMin" integer NOT NULL DEFAULT '15',
                "deliveryRadiusKm" numeric(6, 3) NOT NULL DEFAULT '5',
                "minimumOrder" numeric(12, 2) NOT NULL DEFAULT '0',
                "pickupInstructions" text,
                "parkingNotes" text,
                "slotMinutes" integer NOT NULL DEFAULT '15',
                "maxOrdersPerSlot" integer NOT NULL DEFAULT '5',
                "scheduleLeadMin" integer NOT NULL DEFAULT '45',
                "autoRejectSeconds" integer NOT NULL DEFAULT '180',
                "kdsEnabled" boolean NOT NULL DEFAULT true,
                "tabletActivated" boolean NOT NULL DEFAULT false,
                "tabletCode" character varying,
                "receiptPrinterEnabled" boolean NOT NULL DEFAULT false,
                "kitchenPrinterEnabled" boolean NOT NULL DEFAULT false,
                "rating" numeric(6, 3) NOT NULL DEFAULT '0',
                "ratingCount" integer NOT NULL DEFAULT '0',
                "ratingAllTime" numeric(6, 3),
                "rating90d" numeric(6, 3),
                "ratingCount90d" integer NOT NULL DEFAULT '0',
                "rating30d" numeric(6, 3),
                "ratingCount30d" integer NOT NULL DEFAULT '0',
                "ratingStats" jsonb NOT NULL DEFAULT '{}',
                "ratingAlert" character varying,
                "reliabilityScore" numeric(6, 3) NOT NULL DEFAULT '100',
                "isFeatured" boolean NOT NULL DEFAULT false,
                "isNew" boolean NOT NULL DEFAULT false,
                "payoutSchedule" character varying NOT NULL DEFAULT 'WEEKLY',
                "meta" jsonb NOT NULL DEFAULT '{}',
                CONSTRAINT "PK_e2133a72eb1cc8f588f7b503e68" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_8267a5494d204d5ba53f11668c" ON "restaurants" ("merchantId")
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "IDX_afb6330c019768b4c3f9a65303" ON "restaurants" ("slug")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_4264fec2a186dd2fcf82e00ff1" ON "restaurants" ("cityId")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_67bad0e5996d57c897df5ac9f7" ON "restaurants" ("zoneId")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_79fb2df949956d6e2ad6799826" ON "restaurants" ("status")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_0ae63bc456668270cddcfa784b" ON "restaurants" ("serviceMode")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_0ee92bd5cca5ed5aee8832f19f" ON "restaurants" ("menuEditStatus")
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."restaurant_members_role_enum" AS ENUM(
                'OWNER',
                'LOCATION_MANAGER',
                'CASHIER',
                'KITCHEN'
            )
        `);
        await queryRunner.query(`
            CREATE TABLE "restaurant_members" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "userId" uuid NOT NULL,
                "merchantId" uuid NOT NULL,
                "restaurantId" uuid,
                "role" "public"."restaurant_members_role_enum" NOT NULL,
                "active" boolean NOT NULL DEFAULT true,
                CONSTRAINT "PK_f89808992317ab1d40d79739fc0" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_bcae69add63ad3f9b7e05fdf8f" ON "restaurant_members" ("userId", "merchantId")
        `);
        await queryRunner.query(`
            CREATE TABLE "restaurant_hours" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "restaurantId" uuid NOT NULL,
                "dayOfWeek" integer NOT NULL,
                "openTime" character varying NOT NULL DEFAULT '09:00',
                "closeTime" character varying NOT NULL DEFAULT '21:00',
                "closed" boolean NOT NULL DEFAULT false,
                CONSTRAINT "PK_d0ecd0325bfc70180bf301900ee" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_c0235acc6124ed8f0c324569f7" ON "restaurant_hours" ("restaurantId", "dayOfWeek")
        `);
        await queryRunner.query(`
            CREATE TABLE "restaurant_closures" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "restaurantId" uuid NOT NULL,
                "startDate" date NOT NULL,
                "endDate" date NOT NULL,
                "closed" boolean NOT NULL DEFAULT true,
                "openTime" character varying,
                "closeTime" character varying,
                "reason" character varying,
                CONSTRAINT "PK_ba98a58754f548a22410c82aa7b" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_5e5c1bef58091022ca76719dea" ON "restaurant_closures" ("restaurantId")
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
                'OTHER'
            )
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."restaurant_documents_status_enum" AS ENUM('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED')
        `);
        await queryRunner.query(`
            CREATE TABLE "restaurant_documents" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "restaurantId" uuid NOT NULL,
                "type" "public"."restaurant_documents_type_enum" NOT NULL,
                "fileUrl" character varying NOT NULL,
                "fileName" character varying,
                "status" "public"."restaurant_documents_status_enum" NOT NULL DEFAULT 'PENDING',
                "rejectReason" character varying,
                "expiresAt" date,
                "reviewedById" uuid,
                "reviewedAt" TIMESTAMP WITH TIME ZONE,
                CONSTRAINT "PK_828a116e7dc38999ea8e6f517df" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_afc3e02fca3327c05ab731b609" ON "restaurant_documents" ("restaurantId")
        `);
        await queryRunner.query(`
            CREATE TABLE "kitchen_stations" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "restaurantId" uuid NOT NULL,
                "name" character varying NOT NULL,
                "sortOrder" integer NOT NULL DEFAULT '0',
                CONSTRAINT "PK_8157ddec935aa73aef0b111c16c" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_bfbd6a02c83f3bc258ce83fcf6" ON "kitchen_stations" ("restaurantId")
        `);
        await queryRunner.query(`
            CREATE TABLE "menu_categories" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "restaurantId" uuid NOT NULL,
                "name" character varying NOT NULL,
                "description" text,
                "sortOrder" integer NOT NULL DEFAULT '0',
                "active" boolean NOT NULL DEFAULT true,
                "dayparts" jsonb NOT NULL DEFAULT '[]',
                CONSTRAINT "PK_124ae987900336f983881cb04e6" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_99fac3bd8f4554721f954244df" ON "menu_categories" ("restaurantId")
        `);
        await queryRunner.query(`
            CREATE TABLE "menu_items" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "restaurantId" uuid NOT NULL,
                "categoryId" uuid,
                "name" character varying NOT NULL,
                "description" text,
                "imageUrl" character varying,
                "price" numeric(12, 2) NOT NULL DEFAULT '0',
                "pickupPrice" numeric(12, 2),
                "taxClassCode" character varying,
                "calories" integer,
                "allergens" jsonb NOT NULL DEFAULT '[]',
                "dietaryTags" jsonb NOT NULL DEFAULT '[]',
                "sortOrder" integer NOT NULL DEFAULT '0',
                "available" boolean NOT NULL DEFAULT true,
                "restockAt" TIMESTAMP WITH TIME ZONE,
                "dayparts" jsonb NOT NULL DEFAULT '[]',
                "isCombo" boolean NOT NULL DEFAULT false,
                "comboItems" jsonb NOT NULL DEFAULT '[]',
                "stationId" uuid,
                "prepTimeMin" integer,
                "isPopular" boolean NOT NULL DEFAULT false,
                "active" boolean NOT NULL DEFAULT true,
                CONSTRAINT "PK_57e6188f929e5dc6919168620c8" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_a8ff5699334d3ca7b07421af0a" ON "menu_items" ("restaurantId")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_d56e5ccc298e8bf721f75a7eb9" ON "menu_items" ("categoryId")
        `);
        await queryRunner.query(`
            CREATE TABLE "modifier_groups" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "restaurantId" uuid NOT NULL,
                "name" character varying NOT NULL,
                "required" boolean NOT NULL DEFAULT false,
                "minSelect" integer NOT NULL DEFAULT '0',
                "maxSelect" integer NOT NULL DEFAULT '1',
                "sortOrder" integer NOT NULL DEFAULT '0',
                CONSTRAINT "PK_b3cea1c985339de5ea73d77101d" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_c4d238ed740e076e30a4bec14e" ON "modifier_groups" ("restaurantId")
        `);
        await queryRunner.query(`
            CREATE TABLE "modifier_options" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "groupId" uuid NOT NULL,
                "name" character varying NOT NULL,
                "priceDelta" numeric(12, 2) NOT NULL DEFAULT '0',
                "isDefault" boolean NOT NULL DEFAULT false,
                "available" boolean NOT NULL DEFAULT true,
                "restockAt" TIMESTAMP WITH TIME ZONE,
                "sortOrder" integer NOT NULL DEFAULT '0',
                CONSTRAINT "PK_55e07bad7529e62c4d0f2b5fdc8" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_78598c3b139d67ed077badb37f" ON "modifier_options" ("groupId")
        `);
        await queryRunner.query(`
            CREATE TABLE "menu_item_modifier_groups" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "menuItemId" uuid NOT NULL,
                "groupId" uuid NOT NULL,
                "sortOrder" integer NOT NULL DEFAULT '0',
                CONSTRAINT "PK_21bee6967c8a22c8b7aa4bd34ad" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "IDX_055f71de33ee3bd95c38e17f23" ON "menu_item_modifier_groups" ("menuItemId", "groupId")
        `);
        await queryRunner.query(`
            CREATE TABLE "restaurant_integrations" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "restaurantId" uuid NOT NULL,
                "provider" character varying NOT NULL,
                "status" character varying NOT NULL DEFAULT 'DISCONNECTED',
                "config" jsonb NOT NULL DEFAULT '{}',
                "lastSyncAt" TIMESTAMP WITH TIME ZONE,
                CONSTRAINT "PK_e03445940050843287fc1cc6c0c" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_f4a4256540d9d3512f2dfe9b16" ON "restaurant_integrations" ("restaurantId")
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."driver_profiles_status_enum" AS ENUM(
                'APPLIED',
                'DOCS_REVIEW',
                'BACKGROUND_CHECK',
                'TRAINING',
                'APPROVED',
                'ACTIVE',
                'SUSPENDED',
                'DEACTIVATED',
                'REJECTED'
            )
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."driver_profiles_vehicletype_enum" AS ENUM('CAR', 'BIKE', 'E_BIKE', 'SCOOTER', 'ON_FOOT')
        `);
        await queryRunner.query(`
            CREATE TABLE "driver_profiles" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "userId" uuid NOT NULL,
                "cityId" uuid,
                "status" "public"."driver_profiles_status_enum" NOT NULL DEFAULT 'APPLIED',
                "statusReason" text,
                "vehicleType" "public"."driver_profiles_vehicletype_enum" NOT NULL DEFAULT 'CAR',
                "vehicleMake" character varying,
                "vehicleModel" character varying,
                "vehicleColor" character varying,
                "licensePlate" character varying,
                "zoneIds" jsonb NOT NULL DEFAULT '[]',
                "activeZoneId" uuid,
                "isOnline" boolean NOT NULL DEFAULT false,
                "onTrip" boolean NOT NULL DEFAULT false,
                "lat" double precision,
                "lng" double precision,
                "heading" double precision,
                "lastLocationAt" TIMESTAMP WITH TIME ZONE,
                "lastOfferAt" TIMESTAMP WITH TIME ZONE,
                "wentOnlineAt" TIMESTAMP WITH TIME ZONE,
                "backgroundCheckProvider" character varying,
                "backgroundCheckStatus" character varying NOT NULL DEFAULT 'NOT_STARTED',
                "backgroundCheckRef" character varying,
                "trainingCompleted" boolean NOT NULL DEFAULT false,
                "trainingScore" numeric(6, 3),
                "insulatedBagConfirmed" boolean NOT NULL DEFAULT false,
                "welcomeBoostSent" boolean NOT NULL DEFAULT false,
                "approvedAt" TIMESTAMP WITH TIME ZONE,
                "bank" jsonb,
                "stripeAccountId" character varying,
                "stripeAccountStatus" character varying NOT NULL DEFAULT 'NOT_STARTED',
                "stripeAccountInfo" jsonb,
                "taxInfo" jsonb,
                "payoutSchedule" character varying NOT NULL DEFAULT 'WEEKLY',
                "rating" numeric(6, 3) NOT NULL DEFAULT '5',
                "ratingCount" integer NOT NULL DEFAULT '0',
                "ratingAllTime" numeric(6, 3),
                "rating90d" numeric(6, 3),
                "ratingCount90d" integer NOT NULL DEFAULT '0',
                "rating30d" numeric(6, 3),
                "ratingCount30d" integer NOT NULL DEFAULT '0',
                "ratingStats" jsonb NOT NULL DEFAULT '{}',
                "ratingAlert" character varying,
                "acceptanceRate" numeric(6, 3) NOT NULL DEFAULT '100',
                "completionRate" numeric(6, 3) NOT NULL DEFAULT '100',
                "onTimeRate" numeric(6, 3) NOT NULL DEFAULT '100',
                "totalTrips" integer NOT NULL DEFAULT '0',
                "offersReceived" integer NOT NULL DEFAULT '0',
                "offersAccepted" integer NOT NULL DEFAULT '0',
                "offersAccepted14d" integer NOT NULL DEFAULT '0',
                "offersDeclined14d" integer NOT NULL DEFAULT '0',
                "offersExpired14d" integer NOT NULL DEFAULT '0',
                "offersTotal14d" integer NOT NULL DEFAULT '0',
                "acceptanceUpdatedAt" TIMESTAMP WITH TIME ZONE,
                "cancellations" integer NOT NULL DEFAULT '0',
                "deliveryDisputes30d" integer NOT NULL DEFAULT '0',
                "deliveryDisputesTotal" integer NOT NULL DEFAULT '0',
                "lifetimeEarnings" numeric(12, 2) NOT NULL DEFAULT '0',
                "pendingBalance" numeric(12, 2) NOT NULL DEFAULT '0',
                "ontarioPlatformWorkerNoticeAcked" boolean NOT NULL DEFAULT false,
                "meta" jsonb NOT NULL DEFAULT '{}',
                CONSTRAINT "REL_c22d0ffc4bff60e9a39c003759" UNIQUE ("userId"),
                CONSTRAINT "PK_6e002fc8a835351e070978fcad4" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "IDX_c22d0ffc4bff60e9a39c003759" ON "driver_profiles" ("userId")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_3fdfaff969910456f61c6b695b" ON "driver_profiles" ("cityId")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_9a37cbd5b6c4512452914e525b" ON "driver_profiles" ("status")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_e9e229fb8477dc71422d56af12" ON "driver_profiles" ("isOnline")
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."driver_documents_type_enum" AS ENUM(
                'LICENCE',
                'VEHICLE_REGISTRATION',
                'INSURANCE',
                'PHOTO',
                'WORK_ELIGIBILITY',
                'BACKGROUND_CHECK',
                'OTHER'
            )
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."driver_documents_status_enum" AS ENUM('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED')
        `);
        await queryRunner.query(`
            CREATE TABLE "driver_documents" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "driverId" uuid NOT NULL,
                "type" "public"."driver_documents_type_enum" NOT NULL,
                "fileUrl" character varying NOT NULL,
                "fileName" character varying,
                "status" "public"."driver_documents_status_enum" NOT NULL DEFAULT 'PENDING',
                "rejectReason" character varying,
                "expiresAt" date,
                "expiryReminderSentAt" TIMESTAMP WITH TIME ZONE,
                "reviewedById" uuid,
                "reviewedAt" TIMESTAMP WITH TIME ZONE,
                CONSTRAINT "PK_31c28b4e8f55a5d411597d45ab2" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_22eb4a151d293e1bdff7a4dcc5" ON "driver_documents" ("driverId")
        `);
        await queryRunner.query(`
            CREATE TABLE "driver_shifts" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "driverId" uuid,
                "zoneId" uuid NOT NULL,
                "startsAt" TIMESTAMP WITH TIME ZONE NOT NULL,
                "endsAt" TIMESTAMP WITH TIME ZONE NOT NULL,
                "status" character varying NOT NULL DEFAULT 'BOOKED',
                "slotCapacity" integer,
                CONSTRAINT "PK_026dc3b73ae9a4a9779fa3a680c" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_b1d190a92e066211da894674c2" ON "driver_shifts" ("driverId")
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."driver_offers_status_enum" AS ENUM(
                'PENDING',
                'ACCEPTED',
                'DECLINED',
                'EXPIRED',
                'CANCELLED'
            )
        `);
        await queryRunner.query(`
            CREATE TABLE "driver_offers" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "orderId" uuid NOT NULL,
                "driverId" uuid NOT NULL,
                "status" "public"."driver_offers_status_enum" NOT NULL DEFAULT 'PENDING',
                "sequence" integer NOT NULL DEFAULT '1',
                "round" integer NOT NULL DEFAULT '0',
                "sentAt" TIMESTAMP WITH TIME ZONE NOT NULL,
                "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL,
                "respondedAt" TIMESTAMP WITH TIME ZONE,
                "pickupDistanceKm" numeric(6, 3),
                "dropoffDistanceKm" numeric(6, 3),
                "estimatedPay" numeric(12, 2) NOT NULL DEFAULT '0',
                "boostAmount" numeric(12, 2) NOT NULL DEFAULT '0',
                "score" numeric(6, 3),
                "scoreBreakdown" jsonb,
                "declineReason" character varying,
                CONSTRAINT "PK_c0dcc29d68fd72391d9add29634" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_75f978faa763d6ae20771abe30" ON "driver_offers" ("orderId")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_cb009002da0449998d68c8bd7a" ON "driver_offers" ("driverId")
        `);
        await queryRunner.query(`
            CREATE TABLE "incentives" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "name" character varying NOT NULL,
                "description" text,
                "type" character varying NOT NULL DEFAULT 'PEAK_BOOST',
                "zoneId" uuid,
                "cityId" uuid,
                "amountPerTrip" numeric(12, 2) NOT NULL DEFAULT '0',
                "percentBoost" numeric(6, 3) NOT NULL DEFAULT '0',
                "questTrips" integer,
                "bonusAmount" numeric(12, 2) NOT NULL DEFAULT '0',
                "startsAt" TIMESTAMP WITH TIME ZONE NOT NULL,
                "endsAt" TIMESTAMP WITH TIME ZONE NOT NULL,
                "daysOfWeek" jsonb NOT NULL DEFAULT '[]',
                "startTime" character varying,
                "endTime" character varying,
                "active" boolean NOT NULL DEFAULT true,
                "driverId" uuid,
                CONSTRAINT "PK_d32a03056b7ceaa502e2b814561" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_e4f6633e72fdb2f24007b9b310" ON "incentives" ("zoneId")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_5ad15cf44434a0fc04909a6879" ON "incentives" ("cityId")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_fcb139d895f967a80373f9c6c0" ON "incentives" ("driverId")
        `);
        await queryRunner.query(`
            CREATE TABLE "training_modules" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "title" character varying NOT NULL,
                "content" text NOT NULL,
                "sortOrder" integer NOT NULL DEFAULT '0',
                "quiz" jsonb NOT NULL DEFAULT '[]',
                "passMark" numeric(6, 3) NOT NULL DEFAULT '80',
                "active" boolean NOT NULL DEFAULT true,
                CONSTRAINT "PK_eb8283e63be7f65abc59c5d96a3" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE TABLE "training_attempts" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "driverId" uuid NOT NULL,
                "moduleId" uuid NOT NULL,
                "score" numeric(6, 3) NOT NULL DEFAULT '0',
                "passed" boolean NOT NULL DEFAULT false,
                "answers" jsonb NOT NULL DEFAULT '[]',
                CONSTRAINT "PK_becd54bf0556d4db97cc5f63405" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_02f8ee2400ef662d0d73722157" ON "training_attempts" ("driverId")
        `);
        await queryRunner.query(`
            CREATE TABLE "sos_alerts" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "driverId" uuid NOT NULL,
                "orderId" uuid,
                "lat" double precision,
                "lng" double precision,
                "message" text,
                "status" character varying NOT NULL DEFAULT 'OPEN',
                "handledById" uuid,
                "handledAt" TIMESTAMP WITH TIME ZONE,
                CONSTRAINT "PK_5c6f2f5f40ab2224315e007b9c4" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_ff582ba952d8d3f19a4f64244a" ON "sos_alerts" ("driverId")
        `);
        await queryRunner.query(`
            CREATE TABLE "driver_location_logs" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "driverId" uuid NOT NULL,
                "orderId" uuid,
                "lat" double precision NOT NULL,
                "lng" double precision NOT NULL,
                "speed" double precision,
                CONSTRAINT "PK_3fbb219d7389d23bc3e11ae1f98" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_4dfd62cb5a1ad0eac16a85e372" ON "driver_location_logs" ("driverId")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_76a267aa3f73683aff12a2b11d" ON "driver_location_logs" ("orderId", "createdAt")
        `);
        await queryRunner.query(`
            CREATE TABLE "customer_profiles" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "userId" uuid NOT NULL,
                "dietaryPreferences" jsonb NOT NULL DEFAULT '[]',
                "allergens" jsonb NOT NULL DEFAULT '[]',
                "walletBalance" numeric(12, 2) NOT NULL DEFAULT '0',
                "stripeCustomerId" character varying,
                "referralCode" character varying,
                "referredById" uuid,
                "marketingEmailConsent" boolean NOT NULL DEFAULT false,
                "marketingSmsConsent" boolean NOT NULL DEFAULT false,
                "pushEnabled" boolean NOT NULL DEFAULT true,
                "marketingConsentAt" TIMESTAMP WITH TIME ZONE,
                "isBlocked" boolean NOT NULL DEFAULT false,
                "blockReason" character varying,
                "fraudFlag" boolean NOT NULL DEFAULT false,
                "flags" jsonb NOT NULL DEFAULT '[]',
                "refundCount30d" integer NOT NULL DEFAULT '0',
                "falseDeliveryClaims" integer NOT NULL DEFAULT '0',
                "ratingAvg" numeric(6, 3),
                "ratingCount" integer NOT NULL DEFAULT '0',
                "lowRatingCount30d" integer NOT NULL DEFAULT '0',
                "ratingUpdatedAt" TIMESTAMP WITH TIME ZONE,
                "totalOrders" integer NOT NULL DEFAULT '0',
                "lifetimeSpend" numeric(12, 2) NOT NULL DEFAULT '0',
                "lastOrderAt" TIMESTAMP WITH TIME ZONE,
                "deletionRequestedAt" TIMESTAMP WITH TIME ZONE,
                "internalNotes" text,
                "meta" jsonb NOT NULL DEFAULT '{}',
                CONSTRAINT "REL_5b534069c56790acd59665798c" UNIQUE ("userId"),
                CONSTRAINT "PK_ece08ee55cbe707d9f870907727" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "IDX_5b534069c56790acd59665798c" ON "customer_profiles" ("userId")
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "IDX_1cb59133db0e45c6f80c0949f7" ON "customer_profiles" ("referralCode")
            WHERE "referralCode" IS NOT NULL
        `);
        await queryRunner.query(`
            CREATE TABLE "addresses" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "customerId" uuid NOT NULL,
                "label" character varying NOT NULL DEFAULT 'Home',
                "line1" character varying NOT NULL,
                "line2" character varying,
                "city" character varying NOT NULL,
                "province" character varying NOT NULL DEFAULT 'ON',
                "postalCode" character varying NOT NULL,
                "lat" double precision,
                "lng" double precision,
                "dropoffNotes" text,
                "dropoffMethod" character varying NOT NULL DEFAULT 'HAND_TO_ME',
                "usePin" boolean NOT NULL DEFAULT true,
                "accessCode" text,
                "isDefault" boolean NOT NULL DEFAULT false,
                CONSTRAINT "PK_745d8f43d3af10ab8247465e450" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_b5976584943ec93aa5394a5532" ON "addresses" ("customerId")
        `);
        await queryRunner.query(`
            CREATE TABLE "carts" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "customerId" uuid NOT NULL,
                "restaurantId" uuid,
                "items" jsonb NOT NULL DEFAULT '[]',
                "promoCode" character varying,
                CONSTRAINT "PK_b5f695a59f5ebb50af3c8160816" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "IDX_a4393093f31aabad6de1f54b0e" ON "carts" ("customerId")
        `);
        await queryRunner.query(`
            CREATE TABLE "favorites" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "customerId" uuid NOT NULL,
                "restaurantId" uuid NOT NULL,
                CONSTRAINT "PK_890818d27523748dd36a4d1bdc8" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "IDX_d3aad4322cc23106421309385a" ON "favorites" ("customerId", "restaurantId")
        `);
        await queryRunner.query(`
            CREATE TABLE "wallet_transactions" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "customerId" uuid NOT NULL,
                "amount" numeric(12, 2) NOT NULL DEFAULT '0',
                "balanceAfter" numeric(12, 2) NOT NULL DEFAULT '0',
                "type" character varying NOT NULL,
                "orderId" uuid,
                "note" character varying,
                "createdById" uuid,
                CONSTRAINT "PK_5120f131bde2cda940ec1a621db" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_d7778acb6fb681d43f6528dec4" ON "wallet_transactions" ("customerId")
        `);
        await queryRunner.query(`
            CREATE TABLE "gift_cards" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "code" character varying NOT NULL,
                "initialAmount" numeric(12, 2) NOT NULL DEFAULT '0',
                "balance" numeric(12, 2) NOT NULL DEFAULT '0',
                "expiresAt" TIMESTAMP WITH TIME ZONE,
                "purchasedById" uuid,
                "redeemedById" uuid,
                "recipientEmail" character varying,
                "active" boolean NOT NULL DEFAULT true,
                CONSTRAINT "PK_66a0b66755efd01b1749861b4aa" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "IDX_08ff997110a4e3842076964f0e" ON "gift_cards" ("code")
        `);
        await queryRunner.query(`
            CREATE TABLE "referrals" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "referrerId" uuid NOT NULL,
                "refereeId" uuid NOT NULL,
                "status" character varying NOT NULL DEFAULT 'PENDING',
                "referrerReward" numeric(12, 2) NOT NULL DEFAULT '0',
                "refereeReward" numeric(12, 2) NOT NULL DEFAULT '0',
                "rewardedAt" TIMESTAMP WITH TIME ZONE,
                CONSTRAINT "PK_ea9980e34f738b6252817326c08" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_59de462f9ce130da142e3b5a9f" ON "referrals" ("referrerId")
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "IDX_70ff19adfe86eac7f48e152497" ON "referrals" ("refereeId")
        `);
        await queryRunner.query(`
            CREATE TABLE "data_requests" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "userId" uuid NOT NULL,
                "type" character varying NOT NULL,
                "status" character varying NOT NULL DEFAULT 'PENDING',
                "notes" text,
                "handledById" uuid,
                "completedAt" TIMESTAMP WITH TIME ZONE,
                "dueAt" TIMESTAMP WITH TIME ZONE,
                "resultData" jsonb,
                CONSTRAINT "PK_43e3a8617ed406edce308696264" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_21073df658b41b9a47271d4dd7" ON "data_requests" ("userId")
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."orders_type_enum" AS ENUM('DELIVERY', 'PICKUP')
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."orders_fulfilment_enum" AS ENUM('PLATFORM_DRIVER', 'OWN_DRIVER', 'PICKUP')
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."orders_status_enum" AS ENUM(
                'PLACED',
                'ACCEPTED',
                'DRIVER_ASSIGNED',
                'PREPARING',
                'READY',
                'PICKED_UP',
                'ON_THE_WAY',
                'DELIVERED',
                'COLLECTED',
                'CANCELLED',
                'REJECTED'
            )
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."orders_paymentmethod_enum" AS ENUM(
                'CARD',
                'APPLE_PAY',
                'GOOGLE_PAY',
                'WALLET',
                'GIFT_CARD',
                'CASH'
            )
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."orders_paymentstatus_enum" AS ENUM(
                'PENDING',
                'AUTHORIZED',
                'CAPTURED',
                'RELEASED',
                'PARTIALLY_REFUNDED',
                'REFUNDED',
                'FAILED'
            )
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."orders_dropoffmethod_enum" AS ENUM('HAND_TO_ME', 'LEAVE_AT_DOOR', 'MEET_OUTSIDE')
        `);
        await queryRunner.query(`
            CREATE TABLE "orders" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "code" character varying NOT NULL,
                "customerId" uuid NOT NULL,
                "restaurantId" uuid NOT NULL,
                "driverId" uuid,
                "zoneId" uuid,
                "cityId" uuid,
                "type" "public"."orders_type_enum" NOT NULL,
                "fulfilment" "public"."orders_fulfilment_enum" NOT NULL,
                "status" "public"."orders_status_enum" NOT NULL DEFAULT 'PLACED',
                "deliveryAddress" jsonb,
                "isScheduled" boolean NOT NULL DEFAULT false,
                "scheduledFor" TIMESTAMP WITH TIME ZONE,
                "prepTimeMin" integer,
                "estimatedReadyAt" TIMESTAMP WITH TIME ZONE,
                "estimatedDeliveryAt" TIMESTAMP WITH TIME ZONE,
                "acceptDeadlineAt" TIMESTAMP WITH TIME ZONE,
                "kitchenReleaseAt" TIMESTAMP WITH TIME ZONE,
                "kitchenReleasedAt" TIMESTAMP WITH TIME ZONE,
                "acceptedAt" TIMESTAMP WITH TIME ZONE,
                "driverAssignedAt" TIMESTAMP WITH TIME ZONE,
                "preparingAt" TIMESTAMP WITH TIME ZONE,
                "readyAt" TIMESTAMP WITH TIME ZONE,
                "pickedUpAt" TIMESTAMP WITH TIME ZONE,
                "onTheWayAt" TIMESTAMP WITH TIME ZONE,
                "deliveredAt" TIMESTAMP WITH TIME ZONE,
                "cancelledAt" TIMESTAMP WITH TIME ZONE,
                "driverArrivedRestaurantAt" TIMESTAMP WITH TIME ZONE,
                "driverArrivedCustomerAt" TIMESTAMP WITH TIME ZONE,
                "subtotal" numeric(12, 2) NOT NULL DEFAULT '0',
                "deliveryFee" numeric(12, 2) NOT NULL DEFAULT '0',
                "serviceFee" numeric(12, 2) NOT NULL DEFAULT '0',
                "smallOrderFee" numeric(12, 2) NOT NULL DEFAULT '0',
                "taxAmount" numeric(12, 2) NOT NULL DEFAULT '0',
                "tip" numeric(12, 2) NOT NULL DEFAULT '0',
                "discountTotal" numeric(12, 2) NOT NULL DEFAULT '0',
                "platformPromoAmount" numeric(12, 2) NOT NULL DEFAULT '0',
                "restaurantPromoAmount" numeric(12, 2) NOT NULL DEFAULT '0',
                "walletUsed" numeric(12, 2) NOT NULL DEFAULT '0',
                "total" numeric(12, 2) NOT NULL DEFAULT '0',
                "promotionId" uuid,
                "promoCode" character varying,
                "commissionPct" numeric(6, 3) NOT NULL DEFAULT '0',
                "commissionAmount" numeric(12, 2) NOT NULL DEFAULT '0',
                "restaurantPayout" numeric(12, 2) NOT NULL DEFAULT '0',
                "driverPay" numeric(12, 2) NOT NULL DEFAULT '0',
                "driverBoost" numeric(12, 2) NOT NULL DEFAULT '0',
                "driverWaitMinutes" integer NOT NULL DEFAULT '0',
                "driverWaitFee" numeric(12, 2) NOT NULL DEFAULT '0',
                "platformRevenue" numeric(12, 2) NOT NULL DEFAULT '0',
                "distanceKm" numeric(8, 3),
                "paymentMethod" "public"."orders_paymentmethod_enum" NOT NULL DEFAULT 'CARD',
                "paymentStatus" "public"."orders_paymentstatus_enum" NOT NULL DEFAULT 'PENDING',
                "paymentIntentId" character varying,
                "tipEditableUntil" TIMESTAMP WITH TIME ZONE,
                "pickupCode" character varying,
                "deliveryPin" character varying,
                "requiresPin" boolean NOT NULL DEFAULT false,
                "usePin" boolean NOT NULL DEFAULT true,
                "contactless" boolean NOT NULL DEFAULT false,
                "dropoffMethod" "public"."orders_dropoffmethod_enum" NOT NULL DEFAULT 'HAND_TO_ME',
                "dropoffNotes" character varying(300),
                "accessCode" text,
                "accessCodePurgedAt" TIMESTAMP WITH TIME ZONE,
                "proofPhotoUrl" character varying,
                "customerNotes" text,
                "hasAllergyFlag" boolean NOT NULL DEFAULT false,
                "isLate" boolean NOT NULL DEFAULT false,
                "escalationLevel" integer NOT NULL DEFAULT '0',
                "unassignedFlag" boolean NOT NULL DEFAULT false,
                "cancelReason" character varying,
                "cancelledBy" character varying,
                "cancellationFee" numeric(12, 2) NOT NULL DEFAULT '0',
                "rejectReason" character varying,
                "source" character varying NOT NULL DEFAULT 'app',
                "meta" jsonb NOT NULL DEFAULT '{}',
                CONSTRAINT "PK_710e2d4957aa5878dfe94e4ac2f" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "IDX_3e413c10c595c04c6c70e58a4d" ON "orders" ("code")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_e5de51ca888d8b1f5ac25799dd" ON "orders" ("customerId")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_2312cd07a04f50ba29d76c9564" ON "orders" ("restaurantId")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_18dc786cf29d6ef99980ba6ae6" ON "orders" ("driverId")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_76c47d954887f2da9672bc24c4" ON "orders" ("zoneId")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_775c9f06fc27ae3ff8fb26f2c4" ON "orders" ("status")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_01b20118a3f640214e7a8a6b29" ON "orders" ("paymentStatus")
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "IDX_b4f8b74bdead6794a2252f56c9" ON "orders" ("paymentIntentId")
            WHERE "paymentIntentId" IS NOT NULL
        `);
        await queryRunner.query(`
            CREATE TABLE "order_items" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "orderId" uuid NOT NULL,
                "menuItemId" uuid,
                "name" character varying NOT NULL,
                "quantity" integer NOT NULL DEFAULT '1',
                "unitPrice" numeric(12, 2) NOT NULL DEFAULT '0',
                "lineTotal" numeric(12, 2) NOT NULL DEFAULT '0',
                "taxAmount" numeric(12, 2) NOT NULL DEFAULT '0',
                "taxClassCode" character varying,
                "modifiers" jsonb NOT NULL DEFAULT '[]',
                "notes" text,
                "stationId" uuid,
                "allergens" jsonb NOT NULL DEFAULT '[]',
                "kitchenStatus" character varying NOT NULL DEFAULT 'NEW',
                "removed" boolean NOT NULL DEFAULT false,
                "removedReason" character varying,
                CONSTRAINT "PK_005269d8574e6fac0493715c308" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_f1d359a55923bb45b057fbdab0" ON "order_items" ("orderId")
        `);
        await queryRunner.query(`
            CREATE TABLE "order_events" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "orderId" uuid NOT NULL,
                "type" character varying NOT NULL,
                "fromStatus" character varying,
                "toStatus" character varying,
                "actorType" character varying NOT NULL DEFAULT 'SYSTEM',
                "actorId" uuid,
                "note" text,
                "data" jsonb,
                CONSTRAINT "PK_cc1b82b0fcf1be577d9d7ecbf8b" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_74f8a596c01980f8e99f503c27" ON "order_events" ("orderId")
        `);
        await queryRunner.query(`
            CREATE TABLE "order_messages" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "orderId" uuid NOT NULL,
                "senderType" character varying NOT NULL,
                "senderId" uuid,
                "recipientType" character varying NOT NULL,
                "body" text NOT NULL,
                "readAt" TIMESTAMP WITH TIME ZONE,
                CONSTRAINT "PK_25d8eb6fb6e1ccb6b33e034ee28" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_cc8ace314be4d8e541ca2e6b73" ON "order_messages" ("orderId")
        `);
        await queryRunner.query(`
            CREATE TABLE "payments" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "orderId" uuid NOT NULL,
                "provider" character varying NOT NULL DEFAULT 'stripe',
                "kind" character varying NOT NULL,
                "amount" numeric(12, 2) NOT NULL DEFAULT '0',
                "currency" character varying NOT NULL DEFAULT 'CAD',
                "status" character varying NOT NULL DEFAULT 'SUCCEEDED',
                "externalId" character varying,
                "meta" jsonb,
                CONSTRAINT "PK_197ab7af18c93fbb0c9b28b4a59" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_af929a5f2a400fdb6913b4967e" ON "payments" ("orderId")
        `);
        await queryRunner.query(`
            CREATE TABLE "reviews" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "orderId" uuid NOT NULL,
                "customerId" uuid NOT NULL,
                "restaurantId" uuid NOT NULL,
                "driverId" uuid,
                "restaurantRating" integer,
                "driverRating" integer,
                "restaurantTags" jsonb NOT NULL DEFAULT '[]',
                "driverTags" jsonb NOT NULL DEFAULT '[]',
                "comment" text,
                "driverComment" text,
                "reply" text,
                "repliedAt" TIMESTAMP WITH TIME ZONE,
                "status" character varying NOT NULL DEFAULT 'VISIBLE',
                "driverStatus" character varying NOT NULL DEFAULT 'VISIBLE',
                "editCount" integer NOT NULL DEFAULT '0',
                "editedAt" TIMESTAMP WITH TIME ZONE,
                "history" jsonb NOT NULL DEFAULT '[]',
                "flagReasons" jsonb NOT NULL DEFAULT '[]',
                "moderation" jsonb NOT NULL DEFAULT '[]',
                "reportedAt" TIMESTAMP WITH TIME ZONE,
                "reportedById" uuid,
                "reportReason" text,
                "commentHash" character varying(32),
                CONSTRAINT "PK_231ae565c273ee700b283f15c1d" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "IDX_53a68dc905777554b7f702791f" ON "reviews" ("orderId")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_6d99bdfa69280ede313699fab9" ON "reviews" ("customerId")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_92ad8cd051c76d10e284bbc328" ON "reviews" ("restaurantId")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_36c89b9ec806368271497c0dcb" ON "reviews" ("commentHash")
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."ledger_entries_partytype_enum" AS ENUM('RESTAURANT', 'DRIVER', 'PLATFORM', 'CUSTOMER')
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."ledger_entries_type_enum" AS ENUM(
                'SALE',
                'COMMISSION',
                'RESTAURANT_PROMO',
                'PLATFORM_PROMO',
                'DELIVERY_PAY',
                'TIP',
                'BOOST',
                'FEE_REVENUE',
                'COMMISSION_REVENUE',
                'REFUND',
                'ADJUSTMENT',
                'PAYOUT',
                'INSTANT_FEE',
                'WAIT_FEE'
            )
        `);
        await queryRunner.query(`
            CREATE TABLE "ledger_entries" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "partyType" "public"."ledger_entries_partytype_enum" NOT NULL,
                "partyId" uuid,
                "restaurantId" uuid,
                "orderId" uuid,
                "type" "public"."ledger_entries_type_enum" NOT NULL,
                "amount" numeric(12, 2) NOT NULL DEFAULT '0',
                "currency" character varying NOT NULL DEFAULT 'CAD',
                "description" character varying,
                "payoutId" uuid,
                "meta" jsonb,
                CONSTRAINT "PK_6efcb84411d3f08b08450ae75d5" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_9e7de3a34bddde11c651eba1a0" ON "ledger_entries" ("restaurantId")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_6304897a90f01527b951762569" ON "ledger_entries" ("orderId")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_cc00eb6ee56c358434e15d94ee" ON "ledger_entries" ("payoutId")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_c97d9f66d1e3a6e62802d741cd" ON "ledger_entries" ("partyType", "partyId", "createdAt")
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."payout_batches_status_enum" AS ENUM(
                'DRAFT',
                'LOCKED',
                'APPROVED',
                'RELEASED',
                'COMPLETED'
            )
        `);
        await queryRunner.query(`
            CREATE TABLE "payout_batches" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "periodStart" date NOT NULL,
                "periodEnd" date NOT NULL,
                "status" "public"."payout_batches_status_enum" NOT NULL DEFAULT 'DRAFT',
                "restaurantCount" integer NOT NULL DEFAULT '0',
                "driverCount" integer NOT NULL DEFAULT '0',
                "totalRestaurants" numeric(12, 2) NOT NULL DEFAULT '0',
                "totalDrivers" numeric(12, 2) NOT NULL DEFAULT '0',
                "total" numeric(12, 2) NOT NULL DEFAULT '0',
                "requiresSuperAdmin" boolean NOT NULL DEFAULT false,
                "reconciliation" jsonb,
                "createdById" uuid,
                "approvedById" uuid,
                "approvedAt" TIMESTAMP WITH TIME ZONE,
                "releasedById" uuid,
                "releasedAt" TIMESTAMP WITH TIME ZONE,
                "notes" text,
                "summary" jsonb,
                CONSTRAINT "PK_aa57cb1e16d39cc0d41083145e4" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."payouts_partytype_enum" AS ENUM('RESTAURANT', 'DRIVER', 'PLATFORM', 'CUSTOMER')
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."payouts_status_enum" AS ENUM(
                'PENDING',
                'APPROVED',
                'RELEASED',
                'PAID',
                'FAILED',
                'ON_HOLD'
            )
        `);
        await queryRunner.query(`
            CREATE TABLE "payouts" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "batchId" uuid,
                "partyType" "public"."payouts_partytype_enum" NOT NULL,
                "partyId" uuid NOT NULL,
                "partyName" character varying,
                "periodStart" date NOT NULL,
                "periodEnd" date NOT NULL,
                "gross" numeric(12, 2) NOT NULL DEFAULT '0',
                "deductions" numeric(12, 2) NOT NULL DEFAULT '0',
                "fee" numeric(12, 2) NOT NULL DEFAULT '0',
                "net" numeric(12, 2) NOT NULL DEFAULT '0',
                "orderCount" integer NOT NULL DEFAULT '0',
                "status" "public"."payouts_status_enum" NOT NULL DEFAULT 'PENDING',
                "instant" boolean NOT NULL DEFAULT false,
                "method" character varying NOT NULL DEFAULT 'EFT',
                "externalRef" character varying,
                "failureReason" text,
                "paidAt" TIMESTAMP WITH TIME ZONE,
                "statementSentAt" TIMESTAMP WITH TIME ZONE,
                "approvedById" uuid,
                "meta" jsonb,
                CONSTRAINT "PK_76855dc4f0a6c18c72eea302e87" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_331debf728128971fb4018cbe4" ON "payouts" ("batchId")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_2d83ecbc94e15d9e05de7928cc" ON "payouts" ("partyId")
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."refunds_type_enum" AS ENUM('REFUND', 'CREDIT')
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."refunds_chargedto_enum" AS ENUM('RESTAURANT', 'PLATFORM', 'DRIVER')
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."refunds_status_enum" AS ENUM(
                'PENDING_APPROVAL',
                'APPROVED',
                'REJECTED',
                'PROCESSED'
            )
        `);
        await queryRunner.query(`
            CREATE TABLE "refunds" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "orderId" uuid NOT NULL,
                "ticketId" uuid,
                "amount" numeric(12, 2) NOT NULL DEFAULT '0',
                "type" "public"."refunds_type_enum" NOT NULL DEFAULT 'REFUND',
                "chargedTo" "public"."refunds_chargedto_enum" NOT NULL,
                "reasonCode" character varying NOT NULL,
                "notes" text,
                "status" "public"."refunds_status_enum" NOT NULL DEFAULT 'PROCESSED',
                "createdById" uuid,
                "createdByType" character varying NOT NULL DEFAULT 'STAFF',
                "approvedById" uuid,
                "processedAt" TIMESTAMP WITH TIME ZONE,
                "auto" boolean NOT NULL DEFAULT false,
                CONSTRAINT "PK_5106efb01eeda7e49a78b869738" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_605cf4d367799f3e5cfb9f6822" ON "refunds" ("orderId")
        `);
        await queryRunner.query(`
            CREATE TABLE "invoices" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "number" character varying NOT NULL,
                "merchantId" uuid NOT NULL,
                "payoutId" uuid,
                "periodStart" date NOT NULL,
                "periodEnd" date NOT NULL,
                "commissionAmount" numeric(12, 2) NOT NULL DEFAULT '0',
                "feeAmount" numeric(12, 2) NOT NULL DEFAULT '0',
                "hstAmount" numeric(12, 2) NOT NULL DEFAULT '0',
                "total" numeric(12, 2) NOT NULL DEFAULT '0',
                "forksyHstNumber" character varying,
                "status" character varying NOT NULL DEFAULT 'ISSUED',
                "lines" jsonb NOT NULL DEFAULT '[]',
                "voidReason" character varying,
                "voidedAt" TIMESTAMP WITH TIME ZONE,
                CONSTRAINT "PK_668cef7c22a427fd822cc1be3ce" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "IDX_6b20aa66f2a835a4f2fbde4872" ON "invoices" ("number")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_064ffba3c2b1f6ba2fd098d13e" ON "invoices" ("merchantId")
        `);
        await queryRunner.query(`
            CREATE TABLE "scheduled_reports" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "name" character varying NOT NULL,
                "dashboard" character varying NOT NULL,
                "frequency" character varying NOT NULL DEFAULT 'WEEKLY',
                "recipients" jsonb NOT NULL DEFAULT '[]',
                "format" character varying NOT NULL DEFAULT 'CSV',
                "filters" jsonb NOT NULL DEFAULT '{}',
                "active" boolean NOT NULL DEFAULT true,
                "lastRunAt" TIMESTAMP WITH TIME ZONE,
                "createdById" uuid,
                CONSTRAINT "PK_4e9443d4280f94e84c7349300a6" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."promotions_type_enum" AS ENUM(
                'PERCENT',
                'FIXED',
                'FREE_DELIVERY',
                'BOGO',
                'FREE_ITEM'
            )
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."promotions_fundedby_enum" AS ENUM('PLATFORM', 'RESTAURANT')
        `);
        await queryRunner.query(`
            CREATE TABLE "promotions" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "code" character varying,
                "name" character varying NOT NULL,
                "description" text,
                "type" "public"."promotions_type_enum" NOT NULL,
                "value" numeric(12, 2) NOT NULL DEFAULT '0',
                "maxDiscount" numeric(12, 2),
                "minSubtotal" numeric(12, 2) NOT NULL DEFAULT '0',
                "fundedBy" "public"."promotions_fundedby_enum" NOT NULL DEFAULT 'PLATFORM',
                "restaurantId" uuid,
                "cityId" uuid,
                "zoneIds" jsonb NOT NULL DEFAULT '[]',
                "menuItemId" uuid,
                "orderTypes" jsonb NOT NULL DEFAULT '[]',
                "startsAt" TIMESTAMP WITH TIME ZONE,
                "endsAt" TIMESTAMP WITH TIME ZONE,
                "usageLimit" integer,
                "usedCount" integer NOT NULL DEFAULT '0',
                "perUserLimit" integer NOT NULL DEFAULT '1',
                "firstOrderOnly" boolean NOT NULL DEFAULT false,
                "autoApply" boolean NOT NULL DEFAULT false,
                "active" boolean NOT NULL DEFAULT true,
                "pendingApproval" boolean NOT NULL DEFAULT false,
                "createdById" uuid,
                "budget" numeric(12, 2) NOT NULL DEFAULT '0',
                "spent" numeric(12, 2) NOT NULL DEFAULT '0',
                "rejectionReason" text,
                "batchId" character varying,
                CONSTRAINT "PK_380cecbbe3ac11f0e5a7c452c34" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "IDX_430ff68e7ac14a1a7fc806e012" ON "promotions" ("code")
            WHERE "code" IS NOT NULL
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_ea34b78314f4cef4e2889ef60e" ON "promotions" ("restaurantId")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_715c13b5ebcb4dcd1f3591bf68" ON "promotions" ("batchId")
        `);
        await queryRunner.query(`
            CREATE TABLE "promo_redemptions" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "promotionId" uuid NOT NULL,
                "customerId" uuid NOT NULL,
                "orderId" uuid,
                "discount" numeric(12, 2) NOT NULL DEFAULT '0',
                CONSTRAINT "PK_34a930e5657a7e0a837b0bb41c9" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_96c053a4a4c49d04ab1c9ebd43" ON "promo_redemptions" ("promotionId")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_8e571e4d62fc9c3ae6d251ff38" ON "promo_redemptions" ("customerId")
        `);
        await queryRunner.query(`
            CREATE TABLE "banners" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "title" character varying NOT NULL,
                "subtitle" character varying,
                "imageUrl" character varying NOT NULL,
                "link" character varying,
                "placement" character varying NOT NULL DEFAULT 'HOME',
                "cityId" uuid,
                "sortOrder" integer NOT NULL DEFAULT '0',
                "startsAt" TIMESTAMP WITH TIME ZONE,
                "endsAt" TIMESTAMP WITH TIME ZONE,
                "active" boolean NOT NULL DEFAULT true,
                CONSTRAINT "PK_e9b186b959296fcb940790d31c3" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE TABLE "cms_pages" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "slug" character varying NOT NULL,
                "language" character varying NOT NULL DEFAULT 'en',
                "title" character varying NOT NULL,
                "body" text NOT NULL,
                "published" boolean NOT NULL DEFAULT true,
                "category" character varying NOT NULL DEFAULT 'LEGAL',
                CONSTRAINT "PK_a6bd4d97252f8f122d34bc6bce6" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "IDX_110c8455b2e99e47276bccd304" ON "cms_pages" ("slug", "language")
        `);
        await queryRunner.query(`
            CREATE TABLE "faqs" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "question" character varying NOT NULL,
                "answer" text NOT NULL,
                "audience" character varying NOT NULL DEFAULT 'CUSTOMER',
                "category" character varying NOT NULL DEFAULT 'General',
                "language" character varying NOT NULL DEFAULT 'en',
                "sortOrder" integer NOT NULL DEFAULT '0',
                "active" boolean NOT NULL DEFAULT true,
                CONSTRAINT "PK_2ddf4f2c910f8e8fa2663a67bf0" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."notification_templates_channel_enum" AS ENUM('PUSH', 'SMS', 'EMAIL', 'IN_APP')
        `);
        await queryRunner.query(`
            CREATE TABLE "notification_templates" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "key" character varying NOT NULL,
                "channel" "public"."notification_templates_channel_enum" NOT NULL,
                "language" character varying NOT NULL DEFAULT 'en',
                "audience" character varying NOT NULL DEFAULT 'CUSTOMER',
                "subject" character varying,
                "body" text NOT NULL,
                "active" boolean NOT NULL DEFAULT true,
                CONSTRAINT "PK_76f0fc48b8d057d2ae7f3a2848a" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "IDX_31bebbd11bc23aa68e7d7c9087" ON "notification_templates" ("key", "channel", "language", "audience")
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."notifications_channel_enum" AS ENUM('PUSH', 'SMS', 'EMAIL', 'IN_APP')
        `);
        await queryRunner.query(`
            CREATE TABLE "notifications" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "userId" uuid NOT NULL,
                "channel" "public"."notifications_channel_enum" NOT NULL DEFAULT 'IN_APP',
                "title" character varying NOT NULL,
                "body" text NOT NULL,
                "event" character varying,
                "data" jsonb,
                "readAt" TIMESTAMP WITH TIME ZONE,
                "deliveryStatus" character varying NOT NULL DEFAULT 'SENT',
                "error" character varying,
                "category" character varying,
                "url" character varying,
                "attempts" integer NOT NULL DEFAULT '0',
                "meta" jsonb,
                CONSTRAINT "PK_6a72c3c0f683f6462415e653c3a" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_692a909ee0fa9383e7859f9b40" ON "notifications" ("userId")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_notifications_channel_created" ON "notifications" ("channel", "createdAt")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_notifications_unread" ON "notifications" ("userId", "createdAt")
            WHERE "readAt" IS NULL
                AND "channel" = 'IN_APP'
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_notifications_user_read_created" ON "notifications" ("userId", "readAt", "createdAt")
        `);
        await queryRunner.query(`
            CREATE TABLE "push_subscriptions" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "userId" uuid NOT NULL,
                "app" character varying NOT NULL DEFAULT 'customer',
                "platform" character varying NOT NULL DEFAULT 'web',
                "endpoint" character varying(2048) NOT NULL,
                "p256dh" character varying(256) NOT NULL,
                "auth" character varying(128) NOT NULL,
                "userAgent" character varying(300),
                "lastSeenAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "lastSuccessAt" TIMESTAMP WITH TIME ZONE,
                "failures" integer NOT NULL DEFAULT '0',
                "lastError" character varying(250),
                CONSTRAINT "PK_757fc8f00c34f66832668dc2e53" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_4cc061875e9eecc311a94b3e43" ON "push_subscriptions" ("userId")
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "IDX_0008bdfd174e533a3f98bf9af1" ON "push_subscriptions" ("endpoint")
        `);
        await queryRunner.query(`
            CREATE TABLE "notification_preferences" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "userId" uuid NOT NULL,
                "data" jsonb NOT NULL DEFAULT '{}',
                CONSTRAINT "PK_e94e2b543f2f218ee68e4f4fad2" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "IDX_b70c44e8b00757584a39322559" ON "notification_preferences" ("userId")
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."campaigns_channel_enum" AS ENUM('PUSH', 'SMS', 'EMAIL', 'IN_APP')
        `);
        await queryRunner.query(`
            CREATE TABLE "campaigns" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "name" character varying NOT NULL,
                "channel" "public"."campaigns_channel_enum" NOT NULL,
                "subject" character varying,
                "body" text NOT NULL,
                "audience" character varying NOT NULL DEFAULT 'CUSTOMERS',
                "filters" jsonb NOT NULL DEFAULT '{}',
                "status" character varying NOT NULL DEFAULT 'DRAFT',
                "scheduledAt" TIMESTAMP WITH TIME ZONE,
                "sentAt" TIMESTAMP WITH TIME ZONE,
                "recipientCount" integer NOT NULL DEFAULT '0',
                "deliveredCount" integer NOT NULL DEFAULT '0',
                "createdById" uuid,
                CONSTRAINT "PK_831e3fcd4fc45b4e4c3f57a9ee4" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."tickets_category_enum" AS ENUM(
                'MISSING_ITEM',
                'WRONG_ITEM',
                'NEVER_ARRIVED',
                'VERY_LATE',
                'FOOD_QUALITY',
                'RESTAURANT_CANCELLED',
                'PAYMENT',
                'PAYOUT',
                'ACCOUNT',
                'SAFETY',
                'OTHER'
            )
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."tickets_status_enum" AS ENUM(
                'OPEN',
                'PENDING',
                'ESCALATED',
                'RESOLVED',
                'CLOSED'
            )
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."tickets_tier_enum" AS ENUM('SELF_SERVE', 'TIER1', 'TIER2', 'FINANCE')
        `);
        await queryRunner.query(`
            CREATE TABLE "tickets" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "number" character varying NOT NULL,
                "subject" character varying NOT NULL,
                "requesterType" character varying NOT NULL DEFAULT 'CUSTOMER',
                "requesterId" uuid,
                "orderId" uuid,
                "restaurantId" uuid,
                "driverId" uuid,
                "category" "public"."tickets_category_enum" NOT NULL DEFAULT 'OTHER',
                "priority" character varying NOT NULL DEFAULT 'NORMAL',
                "status" "public"."tickets_status_enum" NOT NULL DEFAULT 'OPEN',
                "tier" "public"."tickets_tier_enum" NOT NULL DEFAULT 'TIER1',
                "assignedToId" uuid,
                "slaFirstResponseDueAt" TIMESTAMP WITH TIME ZONE,
                "slaResolutionDueAt" TIMESTAMP WITH TIME ZONE,
                "firstResponseAt" TIMESTAMP WITH TIME ZONE,
                "resolvedAt" TIMESTAMP WITH TIME ZONE,
                "slaBreached" boolean NOT NULL DEFAULT false,
                "reasonCode" character varying,
                "chargedTo" character varying,
                "attachments" jsonb NOT NULL DEFAULT '[]',
                "tags" jsonb NOT NULL DEFAULT '[]',
                "csat" integer,
                "csatComment" text,
                "closedAt" TIMESTAMP WITH TIME ZONE,
                "escalatedAt" TIMESTAMP WITH TIME ZONE,
                "escalationReason" character varying,
                "slaBreachType" character varying,
                "slaBreachNotifiedAt" TIMESTAMP WITH TIME ZONE,
                "lastMessageAt" TIMESTAMP WITH TIME ZONE,
                "lastMessageBy" character varying,
                "source" character varying NOT NULL DEFAULT 'MANUAL',
                "autoResolved" boolean NOT NULL DEFAULT false,
                "resolution" text,
                "reopenCount" integer NOT NULL DEFAULT '0',
                "refundedTotal" numeric(12, 2) NOT NULL DEFAULT '0',
                "meta" jsonb NOT NULL DEFAULT '{}',
                CONSTRAINT "PK_343bc942ae261cf7a1377f48fd0" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "IDX_78e08cc1101fc17f77c6f11b4c" ON "tickets" ("number")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_ffff1b4554585c0c9b95d06260" ON "tickets" ("requesterId")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_e3e1e1e9d4ee34649da54a016e" ON "tickets" ("orderId")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_12b901b34113688b4786368510" ON "tickets" ("status")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_7712f291901ceeb504b329df62" ON "tickets" ("assignedToId")
        `);
        await queryRunner.query(`
            CREATE TABLE "ticket_messages" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "ticketId" uuid NOT NULL,
                "senderType" character varying NOT NULL,
                "senderId" uuid,
                "body" text NOT NULL,
                "attachments" jsonb NOT NULL DEFAULT '[]',
                "internal" boolean NOT NULL DEFAULT false,
                "readAt" TIMESTAMP WITH TIME ZONE,
                CONSTRAINT "PK_37beb692dedf7eccb4e519ccec1" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_b01e2a35417efbe04c10828266" ON "ticket_messages" ("ticketId")
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."review_cases_trigger_enum" AS ENUM(
                'LOW_RATING',
                'FRAUD_FLAG',
                'SAFETY_COMPLAINT',
                'EXPIRED_DOCUMENTS',
                'REPEATED_CANCELLATIONS',
                'DELIVERY_DISPUTES',
                'OTHER'
            )
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."review_cases_decision_enum" AS ENUM(
                'PENDING',
                'REINSTATED',
                'WARNED',
                'SUSPENDED',
                'DEACTIVATED'
            )
        `);
        await queryRunner.query(`
            CREATE TABLE "review_cases" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "subjectType" character varying NOT NULL,
                "subjectId" uuid NOT NULL,
                "trigger" "public"."review_cases_trigger_enum" NOT NULL,
                "details" text NOT NULL,
                "noticeSentAt" TIMESTAMP WITH TIME ZONE,
                "respondBy" TIMESTAMP WITH TIME ZONE,
                "subjectResponse" text,
                "decision" "public"."review_cases_decision_enum" NOT NULL DEFAULT 'PENDING',
                "decisionNotes" text,
                "reviewerId" uuid,
                "decidedAt" TIMESTAMP WITH TIME ZONE,
                "appealStatus" character varying NOT NULL DEFAULT 'NONE',
                "appealNotes" text,
                "finalPayoutDone" boolean NOT NULL DEFAULT false,
                "status" character varying NOT NULL DEFAULT 'OPEN',
                "proposed" boolean NOT NULL DEFAULT false,
                "subjectName" character varying,
                "subjectUserId" uuid,
                "noticeBody" text,
                "evidence" jsonb NOT NULL DEFAULT '[]',
                "assignedToId" uuid,
                "previousStatus" character varying,
                "appealRequestedAt" TIMESTAMP WITH TIME ZONE,
                "appealDecidedAt" TIMESTAMP WITH TIME ZONE,
                "appealDecidedById" uuid,
                "finalPayoutAmount" numeric(12, 2),
                "finalPayoutAt" TIMESTAMP WITH TIME ZONE,
                "meta" jsonb NOT NULL DEFAULT '{}',
                CONSTRAINT "PK_20ed6c14b2ad2784823e7b9e82c" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_9dd47bd10cb2222ee146feebb3" ON "review_cases" ("subjectId")
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."canned_replies_category_enum" AS ENUM(
                'MISSING_ITEM',
                'WRONG_ITEM',
                'NEVER_ARRIVED',
                'VERY_LATE',
                'FOOD_QUALITY',
                'RESTAURANT_CANCELLED',
                'PAYMENT',
                'PAYOUT',
                'ACCOUNT',
                'SAFETY',
                'OTHER'
            )
        `);
        await queryRunner.query(`
            CREATE TABLE "canned_replies" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "title" character varying NOT NULL,
                "body" text NOT NULL,
                "category" "public"."canned_replies_category_enum",
                "audience" character varying NOT NULL DEFAULT 'ANY',
                "shortcut" character varying,
                "active" boolean NOT NULL DEFAULT true,
                "usageCount" integer NOT NULL DEFAULT '0',
                "createdById" uuid,
                CONSTRAINT "PK_dd80b4af0ce27d517e404fbc7d6" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "IDX_d98a40a9b4911821b5976dab89" ON "canned_replies" ("shortcut")
            WHERE "shortcut" IS NOT NULL
        `);
        await queryRunner.query(`
            CREATE TABLE "chat_sessions" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "ticketId" uuid NOT NULL,
                "requesterUserId" uuid NOT NULL,
                "requesterType" character varying NOT NULL,
                "status" character varying NOT NULL DEFAULT 'WAITING',
                "topic" character varying NOT NULL DEFAULT 'OTHER',
                "orderId" uuid,
                "agentId" uuid,
                "agentFirstName" character varying,
                "queuedAt" TIMESTAMP WITH TIME ZONE NOT NULL,
                "acceptedAt" TIMESTAMP WITH TIME ZONE,
                "endedAt" TIMESTAMP WITH TIME ZONE,
                "endedBy" character varying,
                "endReason" character varying,
                "waitSec" integer,
                "firstResponseSec" integer,
                "lastActivityAt" TIMESTAMP WITH TIME ZONE NOT NULL,
                "transferCount" integer NOT NULL DEFAULT '0',
                "rating" integer,
                "feedback" text,
                "meta" jsonb NOT NULL DEFAULT '{}',
                CONSTRAINT "PK_efc151a4aafa9a28b73dedc485f" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_9969cb79be79d32a164ee0da75" ON "chat_sessions" ("ticketId")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_7b3e9cebb31757299aa79bd97b" ON "chat_sessions" ("requesterUserId")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_4680547e20c7483edc930ab1c4" ON "chat_sessions" ("status")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_831e01e788c4a38b10c2ffb747" ON "chat_sessions" ("agentId")
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "uq_chat_sessions_one_open_per_user" ON "chat_sessions" ("requesterUserId")
            WHERE "status" IN ('WAITING', 'ACTIVE')
        `);
        await queryRunner.query(`
            CREATE TABLE "agent_presence" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "userId" uuid NOT NULL,
                "status" character varying NOT NULL DEFAULT 'OFFLINE',
                "maxConcurrentChats" integer,
                "lastHeartbeatAt" TIMESTAMP WITH TIME ZONE,
                "statusChangedAt" TIMESTAMP WITH TIME ZONE,
                CONSTRAINT "PK_a9f69eaf5619ea2110b2ea064e9" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "IDX_88c12bbfda687a72879b7a78d9" ON "agent_presence" ("userId")
        `);
        await queryRunner.query(`
            CREATE TABLE "audit_logs" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "actorId" uuid,
                "actorEmail" character varying,
                "actorType" character varying,
                "actorRole" character varying,
                "action" character varying NOT NULL,
                "entity" character varying,
                "entityId" character varying,
                "before" jsonb,
                "after" jsonb,
                "ip" character varying,
                "userAgent" character varying,
                "path" character varying,
                "method" character varying,
                CONSTRAINT "PK_1bb179d048bbc581caa3b013439" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_c69efb19bf127c97e6740ad530" ON "audit_logs" ("createdAt")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_2dc33f7f3c22e2e7badafca1d1" ON "audit_logs" ("actorId")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_cee5459245f652b75eb2759b4c" ON "audit_logs" ("action")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_2643f2a68c662985433dbddca1" ON "audit_logs" ("entity", "entityId")
        `);
        await queryRunner.query(`
            CREATE TABLE "settings" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "key" character varying NOT NULL,
                "value" jsonb,
                "group" character varying NOT NULL DEFAULT 'general',
                "label" character varying,
                "description" text,
                "isSecret" boolean NOT NULL DEFAULT false,
                "inputType" character varying NOT NULL DEFAULT 'text',
                "isPublic" boolean NOT NULL DEFAULT false,
                CONSTRAINT "PK_0669fe20e252eb692bf4d344975" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "IDX_c8639b7626fa94ba8265628f21" ON "settings" ("key")
        `);
        await queryRunner.query(`
            CREATE TABLE "feature_flags" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "key" character varying NOT NULL,
                "enabled" boolean NOT NULL DEFAULT false,
                "description" text,
                "rolloutPct" integer NOT NULL DEFAULT '100',
                "cityIds" jsonb NOT NULL DEFAULT '[]',
                CONSTRAINT "PK_db657d344e9caacfc9d5cf8bbac" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "IDX_36d0344370584b4d6a953c53a6" ON "feature_flags" ("key")
        `);
        await queryRunner.query(`
            CREATE TABLE "app_versions" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "app" character varying NOT NULL,
                "platform" character varying NOT NULL,
                "minVersion" character varying NOT NULL DEFAULT '1.0.0',
                "latestVersion" character varying NOT NULL DEFAULT '1.0.0',
                "forceUpdate" boolean NOT NULL DEFAULT false,
                "storeUrl" character varying,
                "releaseNotes" text,
                CONSTRAINT "PK_8d36b0dcf0c026c7aad923c80fd" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "IDX_93b214734e9899ff135b07a8e7" ON "app_versions" ("app", "platform")
        `);
        await queryRunner.query(`
            CREATE TABLE "incidents" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "title" character varying NOT NULL,
                "severity" character varying NOT NULL,
                "status" character varying NOT NULL DEFAULT 'OPEN',
                "description" text,
                "bannerMessage" character varying,
                "bannerActive" boolean NOT NULL DEFAULT false,
                "pauseNewOrders" boolean NOT NULL DEFAULT false,
                "timeline" jsonb NOT NULL DEFAULT '[]',
                "resolvedAt" TIMESTAMP WITH TIME ZONE,
                "postIncidentReport" text,
                "reportDueAt" TIMESTAMP WITH TIME ZONE,
                "ownerId" uuid,
                CONSTRAINT "PK_ccb34c01719889017e2246469f9" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE TABLE "ops_checklists" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "date" date NOT NULL,
                "kind" character varying NOT NULL,
                "cityId" uuid,
                "items" jsonb NOT NULL DEFAULT '[]',
                "notes" text,
                "completedById" uuid,
                "completedAt" TIMESTAMP WITH TIME ZONE,
                CONSTRAINT "PK_bc01daf640dee87ae36096067e6" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "IDX_ec107e5a8750ea9005e69de7bc" ON "ops_checklists" ("date", "kind", "cityId")
        `);
        await queryRunner.query(`
            CREATE TABLE "delivery_proofs" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "orderId" uuid NOT NULL,
                "driverId" uuid,
                "customerId" uuid NOT NULL,
                "method" character varying NOT NULL,
                "proofType" character varying NOT NULL,
                "strength" character varying NOT NULL DEFAULT 'STRONG',
                "pinVerified" boolean NOT NULL DEFAULT false,
                "exceptionReason" character varying,
                "exceptionNote" text,
                "photoFile" character varying,
                "photoSha256" character varying(64),
                "photoMime" character varying,
                "photoBytes" integer,
                "photoExifStripped" boolean NOT NULL DEFAULT false,
                "photoLat" double precision,
                "photoLng" double precision,
                "photoAccuracyM" double precision,
                "photoCapturedAt" TIMESTAMP WITH TIME ZONE,
                "photoPurgedAt" TIMESTAMP WITH TIME ZONE,
                "dropoffLat" double precision,
                "dropoffLng" double precision,
                "claimedLat" double precision,
                "claimedLng" double precision,
                "distanceMeters" double precision,
                "serverGpsDistanceMeters" double precision,
                "geofenceMeters" integer,
                "arrivedCustomerAt" TIMESTAMP WITH TIME ZONE,
                "deliveredAt" TIMESTAMP WITH TIME ZONE NOT NULL,
                "breadcrumb" jsonb,
                "device" jsonb,
                "instructions" jsonb,
                "flags" jsonb NOT NULL DEFAULT '[]',
                "reviewStatus" character varying NOT NULL DEFAULT 'NONE',
                "reviewedById" uuid,
                "reviewedAt" TIMESTAMP WITH TIME ZONE,
                "reviewNote" text,
                "disputeOutcome" character varying,
                "disputeOutcomeById" uuid,
                "disputeOutcomeAt" TIMESTAMP WITH TIME ZONE,
                "disputeTicketId" uuid,
                CONSTRAINT "PK_a7fac8a81fd452f3655063c1bd3" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "IDX_970782148dc0bd6a3418b03858" ON "delivery_proofs" ("orderId")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_3824750501e0382feda71c7e4c" ON "delivery_proofs" ("driverId")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_86d4c43e013a1462061ea424ee" ON "delivery_proofs" ("customerId")
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "IDX_fe5c8e49664cdf2e908d920a0d" ON "delivery_proofs" ("photoSha256")
            WHERE "photoSha256" IS NOT NULL
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_e77ed41de6668f715f90f5a008" ON "delivery_proofs" ("reviewStatus")
        `);
        await queryRunner.query(`
            CREATE TABLE "uploaded_files" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "filename" character varying NOT NULL,
                "userId" uuid,
                "userType" character varying,
                "sha256" character varying(64) NOT NULL,
                "size" integer NOT NULL,
                "mimetype" character varying NOT NULL,
                CONSTRAINT "PK_e2d47e01bd5be386bf0067b2ed8" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "IDX_cfa873851382ff0a5e552a1534" ON "uploaded_files" ("filename")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_60c4efd22171da3c032ba91bc2" ON "uploaded_files" ("userId")
        `);
        await queryRunner.query(`
            CREATE TABLE "customer_ratings" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "orderId" uuid NOT NULL,
                "customerId" uuid NOT NULL,
                "raterType" character varying NOT NULL,
                "raterId" uuid NOT NULL,
                "raterRefId" uuid,
                "rating" integer NOT NULL,
                "tags" jsonb NOT NULL DEFAULT '[]',
                "note" text,
                CONSTRAINT "PK_965674544bcbf960b6ace4c492b" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_a8b879ba40dc6cda51385d25c7" ON "customer_ratings" ("customerId")
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "IDX_a5210ce0fc6d0092441b21f3d3" ON "customer_ratings" ("orderId", "raterType")
        `);
        await queryRunner.query(`
            CREATE TABLE "rating_prompts" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "orderId" uuid NOT NULL,
                "userId" uuid NOT NULL,
                "kind" character varying NOT NULL,
                CONSTRAINT "PK_5dd6bfde5d94dc1761b832b1ed1" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "IDX_92fb6e55cf0c5773a49dea9c83" ON "rating_prompts" ("orderId", "userId", "kind")
        `);
        await queryRunner.query(`
            CREATE TABLE "assistant_sessions" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "restaurantId" uuid,
                "customerId" uuid,
                "mode" character varying NOT NULL DEFAULT 'site',
                "origin" character varying,
                "cart" jsonb NOT NULL DEFAULT '[]',
                "orderNote" text,
                "pending" jsonb,
                "transcript" jsonb NOT NULL DEFAULT '[]',
                "messageCount" integer NOT NULL DEFAULT '0',
                "cartTouched" boolean NOT NULL DEFAULT false,
                "handoffTokenHash" character varying,
                "handoffExpiresAt" TIMESTAMP WITH TIME ZONE,
                "handoffUsedAt" TIMESTAMP WITH TIME ZONE,
                "handoffCount" integer NOT NULL DEFAULT '0',
                "importedAt" TIMESTAMP WITH TIME ZONE,
                "lastActiveAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL,
                CONSTRAINT "PK_3b5a01887645356c592231681ed" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_8578074eb9bdf346bd7ef918f8" ON "assistant_sessions" ("restaurantId")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_87725b6f342a8e658294730291" ON "assistant_sessions" ("customerId")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_7ec4b8e08545c123c7b39c0c6f" ON "assistant_sessions" ("handoffTokenHash")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_92df0718671c55d149427d08ae" ON "assistant_sessions" ("expiresAt")
        `);
        await queryRunner.query(`
            CREATE TABLE "assistant_kb_drafts" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "scopeKey" character varying(60) NOT NULL,
                "restaurantId" uuid,
                "content" jsonb NOT NULL DEFAULT '{}',
                "testCases" jsonb NOT NULL DEFAULT '[]',
                "baseVersion" integer NOT NULL DEFAULT '0',
                "updatedByName" character varying,
                CONSTRAINT "PK_2af8fa0ec480b9873130c085dca" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "IDX_6928de911162ed0961e5919412" ON "assistant_kb_drafts" ("scopeKey")
        `);
        await queryRunner.query(`
            CREATE TABLE "assistant_kb_versions" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "scopeKey" character varying(60) NOT NULL,
                "version" integer NOT NULL,
                "content" jsonb NOT NULL,
                "note" character varying(300),
                "source" character varying(20) NOT NULL DEFAULT 'publish',
                "publishedById" uuid,
                "publishedByName" character varying,
                "counts" jsonb NOT NULL DEFAULT '{}',
                "restoredFrom" integer,
                CONSTRAINT "PK_6b807914a8eff39d6185f524827" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "IDX_5894e4c5837d01e2d35f286dbb" ON "assistant_kb_versions" ("scopeKey", "version")
        `);
        await queryRunner.query(`
            CREATE TABLE "assistant_kb_stats" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "scopeKey" character varying(60) NOT NULL,
                "entryId" character varying(60) NOT NULL,
                "answered" integer NOT NULL DEFAULT '0',
                "up" integer NOT NULL DEFAULT '0',
                "down" integer NOT NULL DEFAULT '0',
                "lastAnsweredAt" TIMESTAMP WITH TIME ZONE,
                CONSTRAINT "PK_5d3f5b6a21611219b5c6d63b412" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "IDX_1f63ddfc459f2afaeacf7afc06" ON "assistant_kb_stats" ("scopeKey", "entryId")
        `);
        await queryRunner.query(`
            CREATE TABLE "assistant_questions" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "scopeKey" character varying(60) NOT NULL,
                "normKey" character varying(240) NOT NULL,
                "text" character varying(240) NOT NULL,
                "outcome" character varying(12) NOT NULL,
                "entryId" character varying(60),
                "count" integer NOT NULL DEFAULT '1',
                "firstSeenAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "lastSeenAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "examples" jsonb NOT NULL DEFAULT '[]',
                "status" character varying(8) NOT NULL DEFAULT 'OPEN',
                "resolvedEntryId" character varying(60),
                CONSTRAINT "PK_9e5c588c7c47182f16bb0e14650" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "IDX_6a5fdd2d163422fa8e4452dd0e" ON "assistant_questions" ("scopeKey", "normKey", "outcome")
        `);
        await queryRunner.query(`
            CREATE TABLE "assistant_daily" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "scopeKey" character varying(60) NOT NULL,
                "day" date NOT NULL,
                "outcome" character varying(12) NOT NULL,
                "count" integer NOT NULL DEFAULT '0',
                CONSTRAINT "PK_807a385c28086037a45fdb6ce81" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "IDX_6f43d9b75f392207f5af94875e" ON "assistant_daily" ("scopeKey", "day", "outcome")
        `);
        await queryRunner.query(`
            CREATE TABLE "assistant_feedback" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "scopeKey" character varying(60) NOT NULL,
                "entryId" character varying(60),
                "rating" character varying(4) NOT NULL,
                "question" character varying(240),
                "comment" character varying(500),
                "reviewed" boolean NOT NULL DEFAULT false,
                CONSTRAINT "PK_bcb50ca5c002afb4a227ffb454c" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_62e91a66a85e198e5e3cc848f1" ON "assistant_feedback" ("scopeKey")
        `);
        await queryRunner.query(`
            CREATE TABLE "assistant_kb_requests" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "scopeKey" character varying(60) NOT NULL,
                "restaurantId" uuid,
                "kind" character varying(10) NOT NULL DEFAULT 'publish',
                "content" jsonb NOT NULL,
                "note" character varying(300),
                "status" character varying(10) NOT NULL DEFAULT 'PENDING',
                "requestedById" uuid,
                "requestedByName" character varying,
                "counts" jsonb NOT NULL DEFAULT '{}',
                "regressions" integer NOT NULL DEFAULT '0',
                "decidedById" uuid,
                "decidedByName" character varying,
                "decidedAt" TIMESTAMP WITH TIME ZONE,
                "decisionNote" character varying(300),
                "resultVersion" integer,
                CONSTRAINT "PK_49e6b8bed58d54f8b126d7dd637" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_d84fa19533229acf462c4291ce" ON "assistant_kb_requests" ("scopeKey")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_0a0f3ce766c8f51968a7841784" ON "assistant_kb_requests" ("status")
        `);
        await queryRunner.query(`
            CREATE TABLE "stripe_intents" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "intentId" character varying NOT NULL,
                "customerId" uuid NOT NULL,
                "purpose" character varying NOT NULL,
                "amount" numeric(12, 2) NOT NULL DEFAULT '0',
                "currency" character varying NOT NULL DEFAULT 'cad',
                "quoteHash" character varying,
                "status" character varying NOT NULL DEFAULT 'requires_payment_method',
                "orderId" uuid,
                "consumedAt" TIMESTAMP WITH TIME ZONE,
                "canceledAt" TIMESTAMP WITH TIME ZONE,
                "meta" jsonb,
                CONSTRAINT "PK_2a69d6e904f917799e52e5b71ab" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "IDX_025d89a85315f03f2a1dd45487" ON "stripe_intents" ("intentId")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_b8d86549027e5e4b4720202075" ON "stripe_intents" ("customerId")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_f40bfe88dbe25ca0a381a7fa62" ON "stripe_intents" ("orderId")
        `);
        await queryRunner.query(`
            CREATE TABLE "stripe_events" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "eventId" character varying NOT NULL,
                "type" character varying NOT NULL,
                "livemode" boolean NOT NULL DEFAULT false,
                "account" character varying,
                "objectId" character varying,
                "status" character varying NOT NULL DEFAULT 'RECEIVED',
                "processed" boolean NOT NULL DEFAULT false,
                "processedAt" TIMESTAMP WITH TIME ZONE,
                "error" text,
                "attempts" integer NOT NULL DEFAULT '0',
                "payload" jsonb,
                CONSTRAINT "PK_d3247bd5fc3f66b6982bbcdd897" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "IDX_890b691c40f4b7ca79603b9bef" ON "stripe_events" ("eventId")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_245ea167606b38c1e06cf244a7" ON "stripe_events" ("type")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_a73a1f0ecb542832c27bcb4d94" ON "stripe_events" ("objectId")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_4d617ecf567f4e223f0ea8dbf1" ON "stripe_events" ("status")
        `);
        await queryRunner.query(`
            CREATE TABLE "restaurant_cuisines" (
                "restaurantsId" uuid NOT NULL,
                "cuisinesId" uuid NOT NULL,
                CONSTRAINT "PK_8b81d00b4f6529ccf01b01169d7" PRIMARY KEY ("restaurantsId", "cuisinesId")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_df7fad337b960f070e5e8c3ac7" ON "restaurant_cuisines" ("restaurantsId")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_0d3daa514a0175cf284eea3b17" ON "restaurant_cuisines" ("cuisinesId")
        `);
        await queryRunner.query(`
            ALTER TABLE "users"
            ADD CONSTRAINT "FK_368e146b785b574f42ae9e53d5e" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE
            SET NULL ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "zones"
            ADD CONSTRAINT "FK_51a2d07892da307f5b0865e18b2" FOREIGN KEY ("cityId") REFERENCES "cities"("id") ON DELETE CASCADE ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "restaurants"
            ADD CONSTRAINT "FK_8267a5494d204d5ba53f11668c6" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "restaurants"
            ADD CONSTRAINT "FK_4264fec2a186dd2fcf82e00ff1d" FOREIGN KEY ("cityId") REFERENCES "cities"("id") ON DELETE
            SET NULL ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "restaurants"
            ADD CONSTRAINT "FK_67bad0e5996d57c897df5ac9f7e" FOREIGN KEY ("zoneId") REFERENCES "zones"("id") ON DELETE
            SET NULL ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "restaurants"
            ADD CONSTRAINT "FK_f2d332b106e478bb5c12685ef7a" FOREIGN KEY ("commissionTierId") REFERENCES "commission_tiers"("id") ON DELETE
            SET NULL ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "restaurant_members"
            ADD CONSTRAINT "FK_867a8b835e840b0b0e52540a29c" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "menu_items"
            ADD CONSTRAINT "FK_d56e5ccc298e8bf721f75a7eb96" FOREIGN KEY ("categoryId") REFERENCES "menu_categories"("id") ON DELETE
            SET NULL ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "modifier_options"
            ADD CONSTRAINT "FK_78598c3b139d67ed077badb37fc" FOREIGN KEY ("groupId") REFERENCES "modifier_groups"("id") ON DELETE CASCADE ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "driver_profiles"
            ADD CONSTRAINT "FK_c22d0ffc4bff60e9a39c0037590" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "customer_profiles"
            ADD CONSTRAINT "FK_5b534069c56790acd59665798c3" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "orders"
            ADD CONSTRAINT "FK_2312cd07a04f50ba29d76c9564e" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "order_items"
            ADD CONSTRAINT "FK_f1d359a55923bb45b057fbdab0d" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            ALTER TABLE "restaurant_cuisines"
            ADD CONSTRAINT "FK_df7fad337b960f070e5e8c3ac71" FOREIGN KEY ("restaurantsId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE
        `);
        await queryRunner.query(`
            ALTER TABLE "restaurant_cuisines"
            ADD CONSTRAINT "FK_0d3daa514a0175cf284eea3b17b" FOREIGN KEY ("cuisinesId") REFERENCES "cuisines"("id") ON DELETE CASCADE ON UPDATE CASCADE
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "restaurant_cuisines" DROP CONSTRAINT "FK_0d3daa514a0175cf284eea3b17b"
        `);
        await queryRunner.query(`
            ALTER TABLE "restaurant_cuisines" DROP CONSTRAINT "FK_df7fad337b960f070e5e8c3ac71"
        `);
        await queryRunner.query(`
            ALTER TABLE "order_items" DROP CONSTRAINT "FK_f1d359a55923bb45b057fbdab0d"
        `);
        await queryRunner.query(`
            ALTER TABLE "orders" DROP CONSTRAINT "FK_2312cd07a04f50ba29d76c9564e"
        `);
        await queryRunner.query(`
            ALTER TABLE "customer_profiles" DROP CONSTRAINT "FK_5b534069c56790acd59665798c3"
        `);
        await queryRunner.query(`
            ALTER TABLE "driver_profiles" DROP CONSTRAINT "FK_c22d0ffc4bff60e9a39c0037590"
        `);
        await queryRunner.query(`
            ALTER TABLE "modifier_options" DROP CONSTRAINT "FK_78598c3b139d67ed077badb37fc"
        `);
        await queryRunner.query(`
            ALTER TABLE "menu_items" DROP CONSTRAINT "FK_d56e5ccc298e8bf721f75a7eb96"
        `);
        await queryRunner.query(`
            ALTER TABLE "restaurant_members" DROP CONSTRAINT "FK_867a8b835e840b0b0e52540a29c"
        `);
        await queryRunner.query(`
            ALTER TABLE "restaurants" DROP CONSTRAINT "FK_f2d332b106e478bb5c12685ef7a"
        `);
        await queryRunner.query(`
            ALTER TABLE "restaurants" DROP CONSTRAINT "FK_67bad0e5996d57c897df5ac9f7e"
        `);
        await queryRunner.query(`
            ALTER TABLE "restaurants" DROP CONSTRAINT "FK_4264fec2a186dd2fcf82e00ff1d"
        `);
        await queryRunner.query(`
            ALTER TABLE "restaurants" DROP CONSTRAINT "FK_8267a5494d204d5ba53f11668c6"
        `);
        await queryRunner.query(`
            ALTER TABLE "zones" DROP CONSTRAINT "FK_51a2d07892da307f5b0865e18b2"
        `);
        await queryRunner.query(`
            ALTER TABLE "users" DROP CONSTRAINT "FK_368e146b785b574f42ae9e53d5e"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_0d3daa514a0175cf284eea3b17"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_df7fad337b960f070e5e8c3ac7"
        `);
        await queryRunner.query(`
            DROP TABLE "restaurant_cuisines"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_4d617ecf567f4e223f0ea8dbf1"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_a73a1f0ecb542832c27bcb4d94"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_245ea167606b38c1e06cf244a7"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_890b691c40f4b7ca79603b9bef"
        `);
        await queryRunner.query(`
            DROP TABLE "stripe_events"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_f40bfe88dbe25ca0a381a7fa62"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_b8d86549027e5e4b4720202075"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_025d89a85315f03f2a1dd45487"
        `);
        await queryRunner.query(`
            DROP TABLE "stripe_intents"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_0a0f3ce766c8f51968a7841784"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_d84fa19533229acf462c4291ce"
        `);
        await queryRunner.query(`
            DROP TABLE "assistant_kb_requests"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_62e91a66a85e198e5e3cc848f1"
        `);
        await queryRunner.query(`
            DROP TABLE "assistant_feedback"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_6f43d9b75f392207f5af94875e"
        `);
        await queryRunner.query(`
            DROP TABLE "assistant_daily"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_6a5fdd2d163422fa8e4452dd0e"
        `);
        await queryRunner.query(`
            DROP TABLE "assistant_questions"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_1f63ddfc459f2afaeacf7afc06"
        `);
        await queryRunner.query(`
            DROP TABLE "assistant_kb_stats"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_5894e4c5837d01e2d35f286dbb"
        `);
        await queryRunner.query(`
            DROP TABLE "assistant_kb_versions"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_6928de911162ed0961e5919412"
        `);
        await queryRunner.query(`
            DROP TABLE "assistant_kb_drafts"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_92df0718671c55d149427d08ae"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_7ec4b8e08545c123c7b39c0c6f"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_87725b6f342a8e658294730291"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_8578074eb9bdf346bd7ef918f8"
        `);
        await queryRunner.query(`
            DROP TABLE "assistant_sessions"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_92fb6e55cf0c5773a49dea9c83"
        `);
        await queryRunner.query(`
            DROP TABLE "rating_prompts"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_a5210ce0fc6d0092441b21f3d3"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_a8b879ba40dc6cda51385d25c7"
        `);
        await queryRunner.query(`
            DROP TABLE "customer_ratings"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_60c4efd22171da3c032ba91bc2"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_cfa873851382ff0a5e552a1534"
        `);
        await queryRunner.query(`
            DROP TABLE "uploaded_files"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_e77ed41de6668f715f90f5a008"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_fe5c8e49664cdf2e908d920a0d"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_86d4c43e013a1462061ea424ee"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_3824750501e0382feda71c7e4c"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_970782148dc0bd6a3418b03858"
        `);
        await queryRunner.query(`
            DROP TABLE "delivery_proofs"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_ec107e5a8750ea9005e69de7bc"
        `);
        await queryRunner.query(`
            DROP TABLE "ops_checklists"
        `);
        await queryRunner.query(`
            DROP TABLE "incidents"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_93b214734e9899ff135b07a8e7"
        `);
        await queryRunner.query(`
            DROP TABLE "app_versions"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_36d0344370584b4d6a953c53a6"
        `);
        await queryRunner.query(`
            DROP TABLE "feature_flags"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_c8639b7626fa94ba8265628f21"
        `);
        await queryRunner.query(`
            DROP TABLE "settings"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_2643f2a68c662985433dbddca1"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_cee5459245f652b75eb2759b4c"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_2dc33f7f3c22e2e7badafca1d1"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_c69efb19bf127c97e6740ad530"
        `);
        await queryRunner.query(`
            DROP TABLE "audit_logs"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_88c12bbfda687a72879b7a78d9"
        `);
        await queryRunner.query(`
            DROP TABLE "agent_presence"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."uq_chat_sessions_one_open_per_user"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_831e01e788c4a38b10c2ffb747"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_4680547e20c7483edc930ab1c4"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_7b3e9cebb31757299aa79bd97b"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_9969cb79be79d32a164ee0da75"
        `);
        await queryRunner.query(`
            DROP TABLE "chat_sessions"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_d98a40a9b4911821b5976dab89"
        `);
        await queryRunner.query(`
            DROP TABLE "canned_replies"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."canned_replies_category_enum"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_9dd47bd10cb2222ee146feebb3"
        `);
        await queryRunner.query(`
            DROP TABLE "review_cases"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."review_cases_decision_enum"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."review_cases_trigger_enum"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_b01e2a35417efbe04c10828266"
        `);
        await queryRunner.query(`
            DROP TABLE "ticket_messages"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_7712f291901ceeb504b329df62"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_12b901b34113688b4786368510"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_e3e1e1e9d4ee34649da54a016e"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_ffff1b4554585c0c9b95d06260"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_78e08cc1101fc17f77c6f11b4c"
        `);
        await queryRunner.query(`
            DROP TABLE "tickets"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."tickets_tier_enum"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."tickets_status_enum"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."tickets_category_enum"
        `);
        await queryRunner.query(`
            DROP TABLE "campaigns"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."campaigns_channel_enum"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_b70c44e8b00757584a39322559"
        `);
        await queryRunner.query(`
            DROP TABLE "notification_preferences"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_0008bdfd174e533a3f98bf9af1"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_4cc061875e9eecc311a94b3e43"
        `);
        await queryRunner.query(`
            DROP TABLE "push_subscriptions"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_notifications_user_read_created"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_notifications_unread"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_notifications_channel_created"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_692a909ee0fa9383e7859f9b40"
        `);
        await queryRunner.query(`
            DROP TABLE "notifications"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."notifications_channel_enum"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_31bebbd11bc23aa68e7d7c9087"
        `);
        await queryRunner.query(`
            DROP TABLE "notification_templates"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."notification_templates_channel_enum"
        `);
        await queryRunner.query(`
            DROP TABLE "faqs"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_110c8455b2e99e47276bccd304"
        `);
        await queryRunner.query(`
            DROP TABLE "cms_pages"
        `);
        await queryRunner.query(`
            DROP TABLE "banners"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_8e571e4d62fc9c3ae6d251ff38"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_96c053a4a4c49d04ab1c9ebd43"
        `);
        await queryRunner.query(`
            DROP TABLE "promo_redemptions"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_715c13b5ebcb4dcd1f3591bf68"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_ea34b78314f4cef4e2889ef60e"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_430ff68e7ac14a1a7fc806e012"
        `);
        await queryRunner.query(`
            DROP TABLE "promotions"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."promotions_fundedby_enum"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."promotions_type_enum"
        `);
        await queryRunner.query(`
            DROP TABLE "scheduled_reports"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_064ffba3c2b1f6ba2fd098d13e"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_6b20aa66f2a835a4f2fbde4872"
        `);
        await queryRunner.query(`
            DROP TABLE "invoices"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_605cf4d367799f3e5cfb9f6822"
        `);
        await queryRunner.query(`
            DROP TABLE "refunds"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."refunds_status_enum"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."refunds_chargedto_enum"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."refunds_type_enum"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_2d83ecbc94e15d9e05de7928cc"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_331debf728128971fb4018cbe4"
        `);
        await queryRunner.query(`
            DROP TABLE "payouts"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."payouts_status_enum"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."payouts_partytype_enum"
        `);
        await queryRunner.query(`
            DROP TABLE "payout_batches"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."payout_batches_status_enum"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_c97d9f66d1e3a6e62802d741cd"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_cc00eb6ee56c358434e15d94ee"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_6304897a90f01527b951762569"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_9e7de3a34bddde11c651eba1a0"
        `);
        await queryRunner.query(`
            DROP TABLE "ledger_entries"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."ledger_entries_type_enum"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."ledger_entries_partytype_enum"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_36c89b9ec806368271497c0dcb"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_92ad8cd051c76d10e284bbc328"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_6d99bdfa69280ede313699fab9"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_53a68dc905777554b7f702791f"
        `);
        await queryRunner.query(`
            DROP TABLE "reviews"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_af929a5f2a400fdb6913b4967e"
        `);
        await queryRunner.query(`
            DROP TABLE "payments"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_cc8ace314be4d8e541ca2e6b73"
        `);
        await queryRunner.query(`
            DROP TABLE "order_messages"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_74f8a596c01980f8e99f503c27"
        `);
        await queryRunner.query(`
            DROP TABLE "order_events"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_f1d359a55923bb45b057fbdab0"
        `);
        await queryRunner.query(`
            DROP TABLE "order_items"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_b4f8b74bdead6794a2252f56c9"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_01b20118a3f640214e7a8a6b29"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_775c9f06fc27ae3ff8fb26f2c4"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_76c47d954887f2da9672bc24c4"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_18dc786cf29d6ef99980ba6ae6"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_2312cd07a04f50ba29d76c9564"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_e5de51ca888d8b1f5ac25799dd"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_3e413c10c595c04c6c70e58a4d"
        `);
        await queryRunner.query(`
            DROP TABLE "orders"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."orders_dropoffmethod_enum"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."orders_paymentstatus_enum"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."orders_paymentmethod_enum"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."orders_status_enum"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."orders_fulfilment_enum"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."orders_type_enum"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_21073df658b41b9a47271d4dd7"
        `);
        await queryRunner.query(`
            DROP TABLE "data_requests"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_70ff19adfe86eac7f48e152497"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_59de462f9ce130da142e3b5a9f"
        `);
        await queryRunner.query(`
            DROP TABLE "referrals"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_08ff997110a4e3842076964f0e"
        `);
        await queryRunner.query(`
            DROP TABLE "gift_cards"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_d7778acb6fb681d43f6528dec4"
        `);
        await queryRunner.query(`
            DROP TABLE "wallet_transactions"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_d3aad4322cc23106421309385a"
        `);
        await queryRunner.query(`
            DROP TABLE "favorites"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_a4393093f31aabad6de1f54b0e"
        `);
        await queryRunner.query(`
            DROP TABLE "carts"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_b5976584943ec93aa5394a5532"
        `);
        await queryRunner.query(`
            DROP TABLE "addresses"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_1cb59133db0e45c6f80c0949f7"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_5b534069c56790acd59665798c"
        `);
        await queryRunner.query(`
            DROP TABLE "customer_profiles"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_76a267aa3f73683aff12a2b11d"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_4dfd62cb5a1ad0eac16a85e372"
        `);
        await queryRunner.query(`
            DROP TABLE "driver_location_logs"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_ff582ba952d8d3f19a4f64244a"
        `);
        await queryRunner.query(`
            DROP TABLE "sos_alerts"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_02f8ee2400ef662d0d73722157"
        `);
        await queryRunner.query(`
            DROP TABLE "training_attempts"
        `);
        await queryRunner.query(`
            DROP TABLE "training_modules"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_fcb139d895f967a80373f9c6c0"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_5ad15cf44434a0fc04909a6879"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_e4f6633e72fdb2f24007b9b310"
        `);
        await queryRunner.query(`
            DROP TABLE "incentives"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_cb009002da0449998d68c8bd7a"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_75f978faa763d6ae20771abe30"
        `);
        await queryRunner.query(`
            DROP TABLE "driver_offers"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."driver_offers_status_enum"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_b1d190a92e066211da894674c2"
        `);
        await queryRunner.query(`
            DROP TABLE "driver_shifts"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_22eb4a151d293e1bdff7a4dcc5"
        `);
        await queryRunner.query(`
            DROP TABLE "driver_documents"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."driver_documents_status_enum"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."driver_documents_type_enum"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_e9e229fb8477dc71422d56af12"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_9a37cbd5b6c4512452914e525b"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_3fdfaff969910456f61c6b695b"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_c22d0ffc4bff60e9a39c003759"
        `);
        await queryRunner.query(`
            DROP TABLE "driver_profiles"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."driver_profiles_vehicletype_enum"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."driver_profiles_status_enum"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_f4a4256540d9d3512f2dfe9b16"
        `);
        await queryRunner.query(`
            DROP TABLE "restaurant_integrations"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_055f71de33ee3bd95c38e17f23"
        `);
        await queryRunner.query(`
            DROP TABLE "menu_item_modifier_groups"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_78598c3b139d67ed077badb37f"
        `);
        await queryRunner.query(`
            DROP TABLE "modifier_options"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_c4d238ed740e076e30a4bec14e"
        `);
        await queryRunner.query(`
            DROP TABLE "modifier_groups"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_d56e5ccc298e8bf721f75a7eb9"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_a8ff5699334d3ca7b07421af0a"
        `);
        await queryRunner.query(`
            DROP TABLE "menu_items"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_99fac3bd8f4554721f954244df"
        `);
        await queryRunner.query(`
            DROP TABLE "menu_categories"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_bfbd6a02c83f3bc258ce83fcf6"
        `);
        await queryRunner.query(`
            DROP TABLE "kitchen_stations"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_afc3e02fca3327c05ab731b609"
        `);
        await queryRunner.query(`
            DROP TABLE "restaurant_documents"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."restaurant_documents_status_enum"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."restaurant_documents_type_enum"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_5e5c1bef58091022ca76719dea"
        `);
        await queryRunner.query(`
            DROP TABLE "restaurant_closures"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_c0235acc6124ed8f0c324569f7"
        `);
        await queryRunner.query(`
            DROP TABLE "restaurant_hours"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_bcae69add63ad3f9b7e05fdf8f"
        `);
        await queryRunner.query(`
            DROP TABLE "restaurant_members"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."restaurant_members_role_enum"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_0ee92bd5cca5ed5aee8832f19f"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_0ae63bc456668270cddcfa784b"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_79fb2df949956d6e2ad6799826"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_67bad0e5996d57c897df5ac9f7"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_4264fec2a186dd2fcf82e00ff1"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_afb6330c019768b4c3f9a65303"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_8267a5494d204d5ba53f11668c"
        `);
        await queryRunner.query(`
            DROP TABLE "restaurants"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."restaurants_menueditstatus_enum"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."restaurants_servicemode_enum"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."restaurants_status_enum"
        `);
        await queryRunner.query(`
            DROP TABLE "merchants"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_454d7d111836fd30f49a7a9ebb"
        `);
        await queryRunner.query(`
            DROP TABLE "cuisines"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_dd529a8ebea30f953e24a2dbea"
        `);
        await queryRunner.query(`
            DROP TABLE "commission_tiers"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_df84a504ff248483d8d32fc0cb"
        `);
        await queryRunner.query(`
            DROP TABLE "tax_classes"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_51a2d07892da307f5b0865e18b"
        `);
        await queryRunner.query(`
            DROP TABLE "zones"
        `);
        await queryRunner.query(`
            DROP TABLE "cities"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_977e24c520c49436d08e5eeea8"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_511957e3e8443429dc3fb00120"
        `);
        await queryRunner.query(`
            DROP TABLE "device_tokens"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_24051aebfe891219eaca0c1b76"
        `);
        await queryRunner.query(`
            DROP TABLE "otp_codes"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_c25bc63d248ca90e8dcc1d92d0"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_610102b60fea1455310ccd299d"
        `);
        await queryRunner.query(`
            DROP TABLE "refresh_tokens"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_875541f7dbe1b8565414f9f80b"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_e2dd77cb8a46c78d8ea34de039"
        `);
        await queryRunner.query(`
            DROP TABLE "users"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."users_status_enum"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."users_type_enum"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_648e3f5447f725579d7d4ffdfb"
        `);
        await queryRunner.query(`
            DROP TABLE "roles"
        `);
    }

}
