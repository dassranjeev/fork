/** Typed environment config. Access with ConfigService.get('jwt.secret') etc. */
const isProd = (process.env.NODE_ENV ?? 'development') === 'production';

/**
 * Secure-by-default: in production the dangerous dev conveniences default to OFF and the boot gate in
 * `src/common/security.ts` (productionProblems) refuses to start if any of them is switched on.
 */
export default () => ({
  env: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '4000', 10),
  publicUrl: process.env.PUBLIC_URL ?? 'http://localhost:4000',
  /** The customer website (FORKSY storefront). Used for the assistant's checkout hand-off link: ${WEB_URL}/order/handoff?token=... */
  webUrl: (process.env.WEB_URL ?? 'http://localhost:3000').replace(/[/]+$/, ''),
  /** Optional: enables the LlmBrain adapter stub of the ordering assistant (untested, see docs/assistant.md). */
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  corsOrigins: (process.env.CORS_ORIGINS ?? (isProd ? '' : 'http://localhost:3000,http://localhost:3001'))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  db: {
    host: process.env.DB_HOST ?? 'localhost',
    port: parseInt(process.env.DB_PORT ?? '5432', 10),
    username: process.env.DB_USER ?? 'postgres',
    password: process.env.DB_PASSWORD ?? 'postgres',
    database: process.env.DB_NAME ?? 'forksy',
    ssl: process.env.DB_SSL === 'true',
    /** auto-create / update tables from entities. Dev only - the production gate refuses DB_SYNC=true. */
    synchronize: (process.env.DB_SYNC ?? (isProd ? 'false' : 'true')) === 'true',
    logging: process.env.DB_LOGGING === 'true',
    poolMax: parseInt(process.env.DB_POOL_MAX ?? '20', 10),
    /** hard cap for any single SQL statement (ms) - protects against expensive analytics / injection-driven pg_sleep */
    statementTimeoutMs: parseInt(process.env.DB_STATEMENT_TIMEOUT_MS ?? '15000', 10),
    lockTimeoutMs: parseInt(process.env.DB_LOCK_TIMEOUT_MS ?? '10000', 10),
  },
  jwt: {
    secret: process.env.JWT_SECRET ?? 'change-me-in-production',
    accessTtl: process.env.JWT_ACCESS_TTL ?? '15m',
    refreshTtlDays: parseInt(process.env.JWT_REFRESH_TTL_DAYS ?? '30', 10),
    issuer: 'forksy-api',
    audience: 'forksy-clients',
  },
  security: {
    /** Force 2FA for staff & restaurant owners (spec 10.1). Required in production. */
    enforce2fa: (process.env.ENFORCE_2FA ?? 'false') === 'true',
    maxFailedLogins: parseInt(process.env.MAX_FAILED_LOGINS ?? '5', 10),
    lockMinutes: parseInt(process.env.LOCK_MINUTES ?? '15', 10),
    otpTtlMinutes: 10,
    /** Dev only: the OTP is returned in the API response and logged. Hard-disabled when NODE_ENV=production. */
    exposeOtp: (process.env.EXPOSE_OTP ?? (isProd ? 'false' : 'true')) === 'true' && !isProd,
    /** Swagger UI + /docs-json. Default off in production. */
    swaggerEnabled: (process.env.SWAGGER_ENABLED ?? (isProd ? 'false' : 'true')) === 'true',
    /** Number of trusted reverse-proxy hops for X-Forwarded-For (0 = none; the header is ignored). */
    trustProxy: process.env.TRUST_PROXY ?? '0',
    /** Reject request fields not declared in the DTO (400) instead of silently stripping them. */
    forbidUnknownFields: (process.env.VALIDATION_FORBID_UNKNOWN ?? 'true') === 'true',
  },
  limits: {
    jsonBody: process.env.BODY_LIMIT_JSON ?? '100kb',
    /** routes that legitimately take bigger JSON bodies (menu CSV import ...) */
    jsonBodyLarge: process.env.BODY_LIMIT_JSON_LARGE ?? '2mb',
    socketMaxBufferBytes: parseInt(process.env.SOCKET_MAX_BUFFER_BYTES ?? '16384', 10),
    maxConnections: parseInt(process.env.MAX_CONNECTIONS ?? '2000', 10),
    socketMaxPerIp: parseInt(process.env.SOCKET_MAX_PER_IP ?? '30', 10),
    socketMaxPerUser: parseInt(process.env.SOCKET_MAX_PER_USER ?? '8', 10),
  },
  uploads: {
    dir: process.env.UPLOAD_DIR ?? 'uploads',
    privateDir: process.env.PRIVATE_UPLOAD_DIR ?? 'private-uploads',
    maxMb: parseInt(process.env.UPLOAD_MAX_MB ?? '10', 10),
  },
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY ?? '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? '',
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY ?? '',
  },
  social: {
    /** comma separated OAuth client ids whose id_tokens we accept (aud check). Required for social sign-in in production. */
    googleClientIds: (process.env.GOOGLE_CLIENT_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    appleClientIds: (process.env.APPLE_CLIENT_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  },
  maps: { googleKey: process.env.GOOGLE_MAPS_API_KEY ?? '' },
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID ?? '',
    authToken: process.env.TWILIO_AUTH_TOKEN ?? '',
    from: process.env.TWILIO_FROM ?? '',
  },
  sendgrid: { apiKey: process.env.SENDGRID_API_KEY ?? '', from: process.env.EMAIL_FROM ?? 'no-reply@forksy.ca' },
  /** FCM HTTP v1 (native apps): service-account JSON; the legacy server key API is gone. Browser push needs no key (VAPID is generated). */
  fcm: { serviceAccountJson: process.env.FCM_SERVICE_ACCOUNT_JSON ?? '' },
  certn: { apiKey: process.env.CERTN_API_KEY ?? '', webhookSecret: process.env.CERTN_WEBHOOK_SECRET ?? '' },
  seed: {
    superAdminEmail: process.env.SEED_SUPERADMIN_EMAIL ?? 'admin@forksy.ca',
    superAdminPassword: process.env.SEED_SUPERADMIN_PASSWORD ?? 'Admin@12345',
    demoData: (process.env.SEED_DEMO ?? 'true') === 'true',
  },
});
