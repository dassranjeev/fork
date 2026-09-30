import { DataSource } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { SeedOptions } from '../database/seed-types';
import { Address, CustomerProfile, User, WalletTransaction } from '../database/entities';
import { UserStatus, UserType } from '../common/enums';

const FIRST = ['Ava', 'Liam', 'Noah', 'Emma', 'Olivia', 'Ethan', 'Mia', 'Lucas', 'Sofia', 'Aiden', 'Zoe', 'Priya', 'Arjun', 'Chloe', 'Ryan'];
const LAST = ['Patel', 'Singh', 'Nguyen', 'Smith', 'Brown', 'Tremblay', 'Khan', 'Lee', 'Martin', 'Wilson'];
const DIET = [[], ['vegetarian'], ['vegan'], ['halal'], ['gluten-free'], []];
const ALLERGENS = [[], [], ['peanuts'], ['dairy'], ['shellfish'], []];
const STREETS = ['Hurontario St', 'Burnhamthorpe Rd', 'Dundas St W', 'Mavis Rd', 'Erin Centre Blvd', 'Lakeshore Rd W'];

/** ~30 demo customers (customerN@demo.forksy.ca, phone +1416555 0201..) with addresses, prefs, some wallet credit. Idempotent. */
export async function seedCustomers(ds: DataSource, opts: SeedOptions): Promise<void> {
  if (!opts.demo) return;
  const hash = await bcrypt.hash(opts.demoPassword, 10);
  const users = ds.getRepository(User);
  let created = 0;
  for (let n = 1; n <= 30; n++) {
    const email = `customer${n}@demo.forksy.ca`;
    if (await users.findOne({ where: { email } })) continue;
    const user = await users.save(
      users.create({
        type: UserType.CUSTOMER,
        status: UserStatus.ACTIVE,
        email,
        phone: `+1416555${String(200 + n).padStart(4, '0')}`,
        firstName: FIRST[n % FIRST.length],
        lastName: LAST[n % LAST.length],
        emailVerified: true,
        phoneVerified: true,
        language: n % 10 === 0 ? 'fr' : 'en',
        passwordHash: hash,
      }),
    );
    const wallet = n % 4 === 0 ? 10 + (n % 3) * 5 : 0;
    await ds.getRepository(CustomerProfile).save(
      ds.getRepository(CustomerProfile).create({
        userId: user.id,
        dietaryPreferences: DIET[n % DIET.length],
        allergens: ALLERGENS[n % ALLERGENS.length],
        walletBalance: wallet,
        referralCode: `FORK${String(n).padStart(3, '0')}${user.id.slice(0, 3).toUpperCase()}`,
        marketingEmailConsent: n % 3 !== 0,
        marketingSmsConsent: n % 5 === 0,
        marketingConsentAt: new Date(),
        meta: {},
      }),
    );
    if (wallet > 0) {
      await ds.getRepository(WalletTransaction).insert({ customerId: user.id, amount: wallet, balanceAfter: wallet, type: 'CREDIT', note: 'Welcome credit (demo)' });
    }
    const addrs = ds.getRepository(Address);
    for (let k = 0; k < (n % 3 === 0 ? 2 : 1); k++) {
      await addrs.save(
        addrs.create({
          customerId: user.id,
          label: k === 0 ? 'Home' : 'Work',
          line1: `${100 + n * 7 + k * 31} ${STREETS[(n + k) % STREETS.length]}`,
          city: 'Mississauga',
          province: 'ON',
          postalCode: `L5B ${1 + (n % 9)}${String.fromCharCode(65 + (n % 20))}${1 + (k % 9)}`,
          lat: 43.589 + ((n % 11) - 5) * 0.006 + k * 0.004,
          lng: -79.6441 + ((n % 7) - 3) * 0.008,
          isDefault: k === 0,
        }),
      );
    }
    created++;
  }
  if (created) console.log(`  + ${created} demo customers`);
}
