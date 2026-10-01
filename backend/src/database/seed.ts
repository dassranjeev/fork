import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { AppModule } from '../app.module';
import { Role, User } from './entities';
import { UserStatus, UserType } from '../common/enums';
import { SeedOptions } from './seed-types';
import { seedPlatform } from '../platform/platform.seed';
import { seedMarketing } from '../marketing/marketing.seed';
import { seedRestaurants, seedRestaurantsExtra } from '../restaurants/restaurants.seed';
import { seedDrivers, seedDriversExtra } from '../drivers/drivers.seed';
import { seedCustomers, seedCustomersExtra } from '../customers/customers.seed';
import { seedOrders } from '../orders/orders.seed';
import { seedSupport } from '../support/support.seed';
import { seedFinance } from '../finance/finance.seed';

/** Demo staff (one per default role). Password = demoPassword. */
const DEMO_STAFF: { email: string; first: string; last: string; role: string }[] = [
  { email: 'ops@forksy.ca', first: 'Olivia', last: 'Operations', role: 'Operations Manager' },
  { email: 'dispatch@forksy.ca', first: 'Dev', last: 'Dispatcher', role: 'Dispatcher' },
  { email: 'support@forksy.ca', first: 'Sam', last: 'Support', role: 'Customer Support Agent' },
  { email: 'supervisor@forksy.ca', first: 'Sara', last: 'Supervisor', role: 'Support Supervisor' },
  { email: 'success@forksy.ca', first: 'Rita', last: 'Success', role: 'Restaurant Success Manager' },
  { email: 'driverops@forksy.ca', first: 'Dan', last: 'DriverOps', role: 'Driver Operations' },
  { email: 'finance@forksy.ca', first: 'Fiona', last: 'Finance', role: 'Finance Manager' },
  { email: 'marketing@forksy.ca', first: 'Max', last: 'Marketing', role: 'Marketing Manager' },
  { email: 'analyst@forksy.ca', first: 'Anya', last: 'Analyst', role: 'Analyst (read-only)' },
];

async function seedCore(ds: DataSource, config: ConfigService, opts: SeedOptions) {
  const users = ds.getRepository(User);
  const email = config.get<string>('seed.superAdminEmail')!.toLowerCase();
  if (!(await users.findOne({ where: { email } }))) {
    await users.save(
      users.create({
        type: UserType.SUPER_ADMIN,
        status: UserStatus.ACTIVE,
        email,
        firstName: 'Super',
        lastName: 'Admin',
        emailVerified: true,
        passwordHash: await bcrypt.hash(config.get<string>('seed.superAdminPassword')!, 12),
      }),
    );
    console.log(`  + super admin ${email}`);
  }
  if (!opts.demo) return;
  const roles = await ds.getRepository(Role).find();
  const hash = await bcrypt.hash(opts.demoPassword, 10);
  for (const s of DEMO_STAFF) {
    if (await users.findOne({ where: { email: s.email } })) continue;
    const role = roles.find((r) => r.name === s.role);
    await users.save(
      users.create({ type: UserType.STAFF, status: UserStatus.ACTIVE, email: s.email, firstName: s.first, lastName: s.last, roleId: role?.id ?? null, emailVerified: true, passwordHash: hash }),
    );
    console.log(`  + staff ${s.email} (${s.role})`);
  }
}

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const ds = app.get(DataSource);
  const config = app.get(ConfigService);
  const opts: SeedOptions = { demo: config.get<boolean>('seed.demoData')!, demoPassword: process.env.SEED_DEMO_PASSWORD ?? 'Demo@12345' };

  // order matters: foundations first, transactional history last
  const steps: [string, () => Promise<void>][] = [
    ['core (super admin + staff)', () => seedCore(ds, config, opts)],
    ['platform (cities, zones, taxes, tiers, cuisines, ops)', () => seedPlatform(ds, opts)],
    ['marketing (promos, banners, CMS, FAQ)', () => seedMarketing(ds, opts)],
    ['restaurants', () => seedRestaurants(ds, opts)],
    ['drivers', () => seedDrivers(ds, opts)],
    ['customers', () => seedCustomers(ds, opts)],
    ['orders (history, ledger, reviews)', () => seedOrders(ds, opts)],
    ['extra Brampton + Mississauga restaurants, drivers, customers', async () => {
      await seedRestaurantsExtra(ds, opts);
      await seedDriversExtra(ds, opts);
      await seedCustomersExtra(ds, opts);
    }],
    ['support (tickets, cases)', () => seedSupport(ds, opts)],
    ['finance (payout batches, invoices)', () => seedFinance(ds, opts)],
  ];
  for (const [name, fn] of steps) {
    console.log(`Seeding ${name} ...`);
    await fn();
  }
  console.log('\nSeed complete.');
  if (opts.demo) console.log(`Demo accounts use password: ${opts.demoPassword}`);
  await app.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
