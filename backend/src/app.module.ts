import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ServeStaticModule } from '@nestjs/serve-static';
import { ThrottlerModule } from '@nestjs/throttler';
import { AppThrottlerGuard, throttlerDefinitions } from './common/throttle';
import { InputSanitizerInterceptor } from './common/input.interceptor';
import { uploadStaticOptions } from './uploads/uploads.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { join } from 'path';
import configuration from './config/configuration';
import { ALL_ENTITIES } from './database/entities';
import { AllExceptionsFilter } from './common/filters';
import { JwtAuthGuard, PermissionsGuard, RestaurantRolesGuard, UserTypesGuard } from './common/guards';
import { AuditInterceptor } from './audit/audit.interceptor';

// platform services (global)
import { AuditModule } from './audit/audit.module';
import { SettingsModule } from './settings/settings.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { RealtimeModule } from './realtime/realtime.module';
import { NotificationsModule } from './notifications/notifications.module';
import { UploadsModule } from './uploads/uploads.module';
import { CoreModule } from './core/core.module';
import { AuthModule } from './auth/auth.module';
import { StaffModule } from './staff/staff.module';
import { HealthModule } from './health/health.module';

// feature modules
import { PlatformModule } from './platform/platform.module';
import { OrdersModule } from './orders/orders.module';
import { DispatchModule } from './dispatch/dispatch.module';
import { RestaurantsModule } from './restaurants/restaurants.module';
import { DriversModule } from './drivers/drivers.module';
import { CustomersModule } from './customers/customers.module';
import { FinanceModule } from './finance/finance.module';
import { SupportModule } from './support/support.module';
import { MarketingModule } from './marketing/marketing.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { RatingsModule } from './ratings/ratings.module';
import { AssistantModule } from './assistant/assistant.module';
import { PaymentsModule } from './payments/payments.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (c: ConfigService) => ({
        type: 'postgres' as const,
        host: c.get<string>('db.host'),
        port: c.get<number>('db.port'),
        username: c.get<string>('db.username'),
        password: c.get<string>('db.password'),
        database: c.get<string>('db.database'),
        ssl: c.get('db.ssl') ? { rejectUnauthorized: false } : false,
        entities: ALL_ENTITIES,
        synchronize: c.get('db.synchronize'),
        logging: c.get('db.logging'),
        autoLoadEntities: false,
        // connection pool + per-statement guard rails (slow / injected pg_sleep / runaway analytics queries are killed by the DB)
        extra: {
          max: c.get<number>('db.poolMax'),
          statement_timeout: c.get<number>('db.statementTimeoutMs'),
          lock_timeout: c.get<number>('db.lockTimeoutMs'),
          idle_in_transaction_session_timeout: 60_000,
          connectionTimeoutMillis: 10_000,
          idleTimeoutMillis: 30_000,
        },
      }),
    }),
    ScheduleModule.forRoot(),
    EventEmitterModule.forRoot({ global: true, maxListeners: 30 }),
    ThrottlerModule.forRoot({ throttlers: throttlerDefinitions(), errorMessage: 'Too many requests. Please slow down.' }),
    ServeStaticModule.forRoot({
      rootPath: join(process.cwd(), process.env.UPLOAD_DIR ?? 'uploads'),
      serveRoot: '/uploads',
      serveStaticOptions: uploadStaticOptions,
    }),

    AuditModule,
    SettingsModule,
    IntegrationsModule,
    RealtimeModule,
    NotificationsModule,
    UploadsModule,
    CoreModule,
    AuthModule,
    StaffModule,
    HealthModule,

    PlatformModule,
    OrdersModule,
    DispatchModule,
    RestaurantsModule,
    DriversModule,
    CustomersModule,
    FinanceModule,
    SupportModule,
    MarketingModule,
    AnalyticsModule,
    RatingsModule,
    AssistantModule,
    PaymentsModule,
  ],
  providers: [
    // order matters: authenticate -> account type -> staff permission -> restaurant role
    { provide: APP_GUARD, useClass: AppThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: UserTypesGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_GUARD, useClass: RestaurantRolesGuard },
    { provide: APP_INTERCEPTOR, useClass: InputSanitizerInterceptor },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
