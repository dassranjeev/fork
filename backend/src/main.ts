import 'reflect-metadata';
import { Logger, RequestMethod } from '@nestjs/common';
import { StrictValidationPipe } from './common/strict-validation.pipe';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { json } from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { KNOWN_DEFAULT_PASSWORDS, corsOriginCheck, productionProblems, trustProxySetting } from './common/security';

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
    stripeSecretKey: process.env.STRIPE_SECRET_KEY ?? '',
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? '',
    enforce2fa: process.env.ENFORCE_2FA === 'true',
    seedSuperAdminPassword: process.env.SEED_SUPERADMIN_PASSWORD ?? '',
    dbPassword: process.env.DB_PASSWORD ?? '',
    dataEncryptionKey: process.env.DATA_ENCRYPTION_KEY ?? '',
  });
  if (problems.length) {
    const msg = ['', '=== FORKSY refuses to start: insecure PRODUCTION configuration ===', ...problems.map((p) => `  - ${p}`), '', 'Fix the environment and restart. (See docs/SECURITY.md, "Production deployment checklist".)', ''].join('\n');
    // eslint-disable-next-line no-console
    console.error(msg);
    process.exit(1);
  }
}

/** DB-level production checks: no demo accounts / no known default admin password may exist. */
async function productionDbGate(ds: DataSource) {
  if (process.env.NODE_ENV !== 'production') return;
  const problems: string[] = [];
  const demo = await ds.query(`SELECT COUNT(*)::int AS n FROM users WHERE email ILIKE '%@demo.forksy.ca' OR email ILIKE '%@demo-restaurant.ca'`);
  if (demo[0]?.n > 0) problems.push(`${demo[0].n} demo accounts (@demo.forksy.ca / @demo-restaurant.ca) exist in the production database - purge the demo data`);
  const admins: { email: string; passwordHash: string }[] = await ds.query(`SELECT email, "passwordHash" FROM users WHERE type = 'SUPER_ADMIN' AND "passwordHash" IS NOT NULL`);
  for (const a of admins) {
    for (const pw of KNOWN_DEFAULT_PASSWORDS) {
      if (await bcrypt.compare(pw, a.passwordHash)) problems.push(`super admin ${a.email} still has a known default password - change it first`);
    }
  }
  if (problems.length) {
    // eslint-disable-next-line no-console
    console.error(['', '=== FORKSY refuses to start: insecure production DATA ===', ...problems.map((p) => `  - ${p}`), ''].join('\n'));
    process.exit(1);
  }
}

async function bootstrap() {
  productionGate();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: false, bodyParser: true, rawBody: true });
  const config = app.get(ConfigService);
  const log = new Logger('Bootstrap');
  const isProd = config.get('env') === 'production';
  await productionDbGate(app.get(DataSource));

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
  app.enableCors({
    origin: corsOriginCheck,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Device-Info', 'X-Requested-With', 'Accept', 'Accept-Language'],
    exposedHeaders: ['Retry-After', 'X-RateLimit-Limit', 'X-RateLimit-Remaining'],
    maxAge: 600,
  });
  app.setGlobalPrefix('api/v1', { exclude: [{ path: 'uploads/(.*)', method: RequestMethod.GET }] });

  // ---- request size limits: 100 kb by default; only the menu CSV import may send more ---------------
  const small = config.get<string>('limits.jsonBody')!;
  const large = config.get<string>('limits.jsonBodyLarge')!;
  app.use(/^\/api\/v1\/restaurant\/menu\/csv$/, json({ limit: large })); // first parser wins; the default one below skips already-parsed bodies
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
      .setTitle('FORKSY API')
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

  if (isProd && !config.get('stripe.secretKey')) log.error('STRIPE_SECRET_KEY missing - card payments will be refused');
  if (!isProd) {
    log.warn('Development mode: mock payment provider, OTP codes in responses and demo accounts are active. NEVER run this configuration in production.');
  }
  log.log(`FORKSY API running on http://localhost:${port}/api/v1${config.get('security.swaggerEnabled') ? '  (docs: /docs)' : ''}`);
}
bootstrap();
