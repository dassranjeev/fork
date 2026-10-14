import 'reflect-metadata';
import { Logger, RequestMethod } from '@nestjs/common';
import { StrictValidationPipe } from './common/strict-validation.pipe';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { json, raw } from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AssistantConfigService } from './assistant/assistant-config.service';
import { assistantCors } from './assistant/assistant.cors';
import { KNOWN_DEFAULT_PASSWORDS, corsOriginCheck, productionProblems, stripeProductionProblems, trustProxySetting } from './common/security';
import { StripeClientService } from './integrations/stripe-client.service';

/** Refuse to boot a production deployment that is configured insecurely. There is deliberately no override flag. */
function productionGate() {
  if (process.env.NODE_ENV !== 'production') return;
  const problems = productionProblems({
    env: 'production',
    jwtSecret: process.env.JWT_SECRET ?? '',
    dbSync: process.env.DB_SYNC === 'true',
    exposeOtp: process.env.EXPOSE_OTP === 'true',
    corsOrigins: (process.env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    publicUrl: process.env.PUBLIC_URL ?? '',
    allowMockPayments: !!process.env.ALLOW_MOCK_PAYMENTS,
    fakeProviderBases: !!(process.env.STRIPE_API_BASE || process.env.MAPBOX_API_BASE),
    enforce2fa: process.env.ENFORCE_2FA === 'true',
    seedSuperAdminPassword: process.env.SEED_SUPERADMIN_PASSWORD ?? '',
    dbPassword: process.env.DB_PASSWORD ?? '',
    dataEncryptionKey: process.env.DATA_ENCRYPTION_KEY ?? '',
  });
  if (problems.length) {
    const msg = ['', '=== FORKY refuses to start: insecure PRODUCTION configuration ===', ...problems.map((p) => `  - ${p}`), '', 'Fix the environment and restart. (See docs/SECURITY.md, "Production deployment checklist".)', ''].join('\n');
    // eslint-disable-next-line no-console
    console.error(msg);
    process.exit(1);
  }
}

/** DB-level production checks: no demo accounts / no known default admin password may exist. */
async function productionDbGate(ds: DataSource, app: NestExpressApplication) {
  if (process.env.NODE_ENV !== 'production') return;
  // DB_SYNC is refused in production, so the schema comes from migrations: fail with a clear message instead of "relation users does not exist"
  let pendingMigrations = false;
  let migrationCheckError = '';
  try {
    pendingMigrations = await ds.showMigrations();
  } catch (e: any) {
    migrationCheckError = e?.message ?? String(e);
  }
  if (pendingMigrations || migrationCheckError) {
    // eslint-disable-next-line no-console
    console.error(
      [
        '',
        '=== FORKY refuses to start: the database schema is not up to date ===',
        migrationCheckError ? `  - could not read the migrations table: ${migrationCheckError}` : '  - there are pending migrations',
        '  - run  node dist/database/migrate  first (docker compose: docker compose run --rm migrate), or set DB_MIGRATIONS_RUN=true',
        '',
      ].join(String.fromCharCode(10)),
    );
    process.exit(1);
  }
  const problems: string[] = [];
  const demo = await ds.query(`SELECT COUNT(*)::int AS n FROM users WHERE email ILIKE '%@demo.forky.ca' OR email ILIKE '%@demo-restaurant.ca'`);
  if (demo[0]?.n > 0) problems.push(`${demo[0].n} demo accounts (@demo.forky.ca / @demo-restaurant.ca) exist in the production database - purge the demo data`);
  const admins: { email: string; passwordHash: string }[] = await ds.query(`SELECT email, "passwordHash" FROM users WHERE type = 'SUPER_ADMIN' AND "passwordHash" IS NOT NULL`);
  for (const a of admins) {
    for (const pw of KNOWN_DEFAULT_PASSWORDS) {
      if (await bcrypt.compare(pw, a.passwordHash)) problems.push(`super admin ${a.email} still has a known default password - change it first`);
    }
  }
  // Stripe: keys can live in System > Integrations (database) or the environment
  // ALLOW_NO_STRIPE=true lets the API boot before payments are configured (card payments fail until keys are saved in System > Integrations)
  if (process.env.ALLOW_NO_STRIPE === 'true') {
    // eslint-disable-next-line no-console
    console.warn('WARNING: ALLOW_NO_STRIPE=true - Stripe configuration is not enforced; payments will not work until keys are configured');
  } else {
    problems.push(...stripeProductionProblems(app.get(StripeClientService).config()));
  }
  if (problems.length) {
    // eslint-disable-next-line no-console
    console.error(['', '=== FORKY refuses to start: insecure production DATA ===', ...problems.map((p) => `  - ${p}`), ''].join('\n'));
    process.exit(1);
  }
}

async function bootstrap() {
  productionGate();
  // rawBody stays OFF globally: the raw bytes are captured only for the two webhook routes that verify a signature (below)
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: false, bodyParser: true });
  const config = app.get(ConfigService);
  const log = new Logger('Bootstrap');
  const isProd = config.get('env') === 'production';
  await productionDbGate(app.get(DataSource), app);

  // ---- network edge ---------------------------------------------------------------------------------
  app.disable('x-powered-by');
  // X-Forwarded-For is honoured ONLY for the configured number of trusted proxy hops (TRUST_PROXY); default none => cannot be spoofed.
  app.set('trust proxy', trustProxySetting());
  app.set('query parser', 'simple'); // no nested objects / prototype tricks via ?a[b]=c
  app.use(
    helmet({
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"], formAction: ["'none'"] } },
      crossOriginResourcePolicy: { policy: 'cross-origin' }, // uploaded images are embedded by the web apps
      crossOriginOpenerPolicy: { policy: 'same-origin' },
      referrerPolicy: { policy: 'no-referrer' },
      frameguard: { action: 'deny' },
      hsts: isProd ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
      xPermittedCrossDomainPolicies: { permittedPolicies: 'none' },
    }),
  );
  app.use((req: any, res: any, next: any) => {
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    // authenticated API responses must never be stored by shared caches; public GETs may be cached briefly by the CDN
    if (req.path.startsWith('/api/') && !(req.method === 'GET' && req.path.startsWith('/api/v1/public/'))) res.setHeader('Cache-Control', 'no-store');
    next();
  });
  // dynamic CORS for the embeddable assistant (public endpoints only); must come before the static CORS policy below
  app.use(assistantCors(app.get(AssistantConfigService)));
  app.enableCors({
    origin: corsOriginCheck,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Device-Info', 'X-Requested-With', 'Accept', 'Accept-Language'],
    exposedHeaders: ['Retry-After', 'X-RateLimit-Limit', 'X-RateLimit-Remaining'],
    maxAge: 600,
  });
  app.setGlobalPrefix('api/v1', { exclude: [{ path: 'uploads/(.*)', method: RequestMethod.GET }, { path: 'assistant/widget.js', method: RequestMethod.GET }, { path: 'assistant/forky-icon.png', method: RequestMethod.GET }] });

  // ---- request size limits: 100 kb by default; only the menu CSV import may send more ---------------
  const small = config.get<string>('limits.jsonBody')!;
  const large = config.get<string>('limits.jsonBodyLarge')!;
  app.use(/^\/api\/v1\/restaurant\/menu\/csv$/, json({ limit: large })); // first parser wins; the default one below skips already-parsed bodies
  // Stripe webhook: the signature is computed over the EXACT raw bytes, so this one route gets the raw body (a Buffer) instead of parsed JSON
  app.use('/api/v1/webhooks/stripe', raw({ type: '*/*', limit: '1mb' }));
  // Certn webhook: parsed as JSON as usual, but its HMAC is also computed over the raw bytes (req.rawBody)
  app.use(/^\/api\/v1\/public\/webhooks\/certn$/, json({ limit: small, verify: (req: any, _res: any, buf: Buffer) => { req.rawBody = buf; } }));
  // bot training: importing a whole knowledge base (up to 500 answers) can be larger than the default 100 kb
  app.use(/^\/api\/v1\/(?:restaurant|admin)\/assistant\/training\/(?:restaurants\/[0-9a-fA-F-]{36}\/|central\/)?import(?:-csv)?$/, json({ limit: large }));
  app.useBodyParser('json', { limit: small });
  app.useBodyParser('urlencoded', { limit: small, extended: false, parameterLimit: 200 });

  app.useGlobalPipes(
    new StrictValidationPipe({
      whitelist: true, // strips undeclared properties (mass-assignment defence)
      forbidNonWhitelisted: config.get<boolean>('security.forbidUnknownFields'), // ...and rejects the request instead of ignoring them
      transform: true,
      transformOptions: { enableImplicitConversion: true },
      validationError: { target: false, value: false }, // never echo submitted values back
    }),
  );

  // ---- API docs: dev only (SWAGGER_ENABLED=true to force on) -----------------------------------------
  if (config.get<boolean>('security.swaggerEnabled')) {
    const doc = new DocumentBuilder()
      .setTitle('FORKY API')
      .setDescription(
        'Food delivery platform API.\n\n- `/auth/*` all apps\n- `/admin/*` Admin Console (staff + super admin)\n- `/restaurant/*` Restaurant portal & tablet KDS\n- `/driver/*` Driver app\n- `/customer/*` Customer app & website\n- `/public/*` no auth\n- WebSocket (Socket.IO) on the same port: see `RealtimeService` for rooms & events.',
      )
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    app.use('/docs', (_req: any, res: any, next: any) => {
      // Swagger UI needs inline scripts/styles; scoped to /docs only
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; frame-ancestors 'none'");
      next();
    });
    SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, doc), { swaggerOptions: { persistAuthorization: true } });
    log.warn('Swagger UI is ENABLED at /docs (development only)');
  }

  // ---- slowloris / slow-POST / connection exhaustion (must be set BEFORE listen) ---------------------
  const http = app.getHttpServer();
  http.headersTimeout = 15_000; // headers must arrive within 15 s
  http.requestTimeout = 60_000; // whole request (incl. upload body) within 60 s
  http.keepAliveTimeout = 5_000;
  (http as any).connectionsCheckingInterval = 3_000; // how often stalled connections are reaped (Node default: 30 s)
  http.maxHeadersCount = 100;
  http.maxRequestsPerSocket = 1000;
  http.maxConnections = config.get<number>('limits.maxConnections')!;

  const port = config.get<number>('port')!;
  await app.listen(port);

  const stripeSvc = app.get(StripeClientService);
  const pay = stripeSvc.provider();
  if (pay === 'mock') log.warn('MOCK PAYMENTS ARE ACTIVE (no Stripe key + ALLOW_MOCK_PAYMENTS=true): no real money moves. Add the Stripe test keys under System > Integrations.');
  else if (pay === 'none') log.error('Payments are NOT configured: no Stripe key (System > Integrations) and mock payments are not allowed - customers cannot pay.');
  else log.log(`Payments: Stripe (${stripeSvc.config().mode.toUpperCase()} mode)${stripeSvc.apiBase() ? ' via STRIPE_API_BASE (fake server)' : ''}`);
  if (!isProd) {
    log.warn('Development mode: OTP codes in responses and demo accounts are active. NEVER run this configuration in production.');
  }
  log.log(`FORKY API running on http://localhost:${port}/api/v1${config.get('security.swaggerEnabled') ? '  (docs: /docs)' : ''}`);
}
bootstrap();
