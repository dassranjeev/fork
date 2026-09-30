/** Typed environment config. Access with ConfigService.get('jwt.secret') etc. */
export default () => ({
  env: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '4000', 10),
  publicUrl: process.env.PUBLIC_URL ?? 'http://localhost:4000',
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:3000,http://localhost:3001').split(',').map((s) => s.trim()),
  db: {
    host: process.env.DB_HOST ?? 'localhost',
    port: parseInt(process.env.DB_PORT ?? '5432', 10),
    username: process.env.DB_USER ?? 'postgres',
    password: process.env.DB_PASSWORD ?? 'postgres',
    database: process.env.DB_NAME ?? 'forksy',
    ssl: process.env.DB_SSL === 'true',
    /** auto-create / update tables from entities. Turn OFF in production and use migrations. */
    synchronize: (process.env.DB_SYNC ?? 'true') === 'true',
    logging: process.env.DB_LOGGING === 'true',
  },
  jwt: {
    secret: process.env.JWT_SECRET ?? 'change-me-in-production',
    accessTtl: process.env.JWT_ACCESS_TTL ?? '15m',
    refreshTtlDays: parseInt(process.env.JWT_REFRESH_TTL_DAYS ?? '30', 10),
  },
  security: {
    /** Force 2FA for staff & restaurant owners (spec 10.1). Disable only in local dev. */
    enforce2fa: (process.env.ENFORCE_2FA ?? 'false') === 'true',
    maxFailedLogins: parseInt(process.env.MAX_FAILED_LOGINS ?? '5', 10),
    lockMinutes: parseInt(process.env.LOCK_MINUTES ?? '15', 10),
    otpTtlMinutes: 10,
    /** In dev the OTP is returned in the API response and logged (never in production). */
    exposeOtp: (process.env.EXPOSE_OTP ?? 'true') === 'true',
  },
  uploads: {
    dir: process.env.UPLOAD_DIR ?? 'uploads',
    maxMb: parseInt(process.env.UPLOAD_MAX_MB ?? '10', 10),
  },
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY ?? '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? '',
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY ?? '',
  },
  maps: { googleKey: process.env.GOOGLE_MAPS_API_KEY ?? '' },
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID ?? '',
    authToken: process.env.TWILIO_AUTH_TOKEN ?? '',
    from: process.env.TWILIO_FROM ?? '',
  },
  sendgrid: { apiKey: process.env.SENDGRID_API_KEY ?? '', from: process.env.EMAIL_FROM ?? 'no-reply@forksy.ca' },
  fcm: { serverKey: process.env.FCM_SERVER_KEY ?? '' },
  certn: { apiKey: process.env.CERTN_API_KEY ?? '' },
  seed: {
    superAdminEmail: process.env.SEED_SUPERADMIN_EMAIL ?? 'admin@forksy.ca',
    superAdminPassword: process.env.SEED_SUPERADMIN_PASSWORD ?? 'Admin@12345',
    demoData: (process.env.SEED_DEMO ?? 'true') === 'true',
  },
});
