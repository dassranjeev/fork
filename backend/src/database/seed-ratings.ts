import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { AppModule } from '../app.module';
import { seedRatings } from '../ratings/ratings.seed';

/** Idempotent: adds the demo ratings data to an already seeded database. `npm run seed:ratings` */
async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const config = app.get(ConfigService);
  await seedRatings(app.get(DataSource), { demo: config.get<boolean>('seed.demoData')!, demoPassword: process.env.SEED_DEMO_PASSWORD ?? 'Demo@12345' });
  await app.close();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
