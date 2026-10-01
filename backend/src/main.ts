import 'reflect-metadata';
import { Logger, RequestMethod, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: false });
  const config = app.get(ConfigService);

  app.set('trust proxy', 1);
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.enableCors({ origin: config.get<string[]>('corsOrigins'), credentials: true });
  app.setGlobalPrefix('api/v1', { exclude: [{ path: 'uploads/(.*)', method: RequestMethod.GET }] });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, transformOptions: { enableImplicitConversion: true }, forbidNonWhitelisted: false }));
  // Stripe webhooks need the raw body: handled in PaymentsController via req.rawBody
  app.useBodyParser('json', { limit: '5mb' });

  const doc = new DocumentBuilder()
    .setTitle('FORKSY API')
    .setDescription(
      'Food delivery platform API.\n\n- `/auth/*` all apps\n- `/admin/*` Admin Console (staff + super admin)\n- `/restaurant/*` Restaurant portal & tablet KDS\n- `/driver/*` Driver app\n- `/customer/*` Customer app & website\n- `/public/*` no auth\n- WebSocket (Socket.IO) on the same port: see `RealtimeService` for rooms & events.',
    )
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, doc), { swaggerOptions: { persistAuthorization: true } });

  const port = config.get<number>('port');
  await app.listen(port);
  new Logger('Bootstrap').log(`FORKSY API running on http://localhost:${port}/api/v1  (docs: /docs)`);
}
bootstrap();
