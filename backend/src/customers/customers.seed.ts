import { DataSource } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { SeedOptions } from '../database/seed-types';
import { Address, CustomerProfile, User, WalletTransaction, Zone } from '../database/entities';
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

// ---------------------------------------------------------------- customers 31..50 (Brampton + Mississauga)
const EX_FIRST = ['Harjot', 'Aisha', 'Gurleen', 'Mateo', 'Fatima', 'Jaspreet', 'Daniel', 'Simran', 'Omar', 'Emily', 'Arjun', 'Zainab', 'Tyler', 'Manpreet', 'Sophie', 'Imran', 'Kiran', 'Jordan', 'Nadia', 'Rohan'];
const EX_LAST = ['Dhaliwal', 'Siddiqui', 'Grewal', 'Rodriguez', 'Malik', 'Bhatti', 'Thompson', 'Randhawa', 'Hussain', 'Clarke', 'Mehta', 'Qureshi', 'Anderson', 'Sekhon', 'Bouchard', 'Chaudhry', 'Sharma', 'Williams', 'Ali', 'Kapoor'];
type Spot = { zone: string; city: string; streets: [string, string][] }; // [street, postal]
const SPOTS: Spot[] = [
  { zone: 'Downtown Brampton', city: 'Brampton', streets: [['Main St N', 'L6V 1P1'], ['Queen St W', 'L6Y 1M5'], ['Vodden St E', 'L6V 1L9'], ['Church St W', 'L6X 1G9']] },
  { zone: 'Bramalea', city: 'Brampton', streets: [['Bramalea Rd', 'L6T 2W8'], ['Queen St E', 'L6T 1A4'], ['Williams Pkwy', 'L6S 5Y5'], ['Dixie Rd', 'L6T 3S1']] },
  { zone: 'Springdale', city: 'Brampton', streets: [['Sandalwood Pkwy E', 'L6R 0H6'], ['Bovaird Dr E', 'L6S 3W3'], ['Mclaughlin Rd N', 'L6Z 4S1'], ['Father Tobin Rd', 'L6R 3M9']] },
  { zone: 'Heart Lake', city: 'Brampton', streets: [['Heart Lake Rd', 'L6Z 1C7'], ['Sandalwood Pkwy W', 'L7A 1A8'], ['Countryside Dr', 'L6P 0B6'], ['Great Lakes Dr', 'L6R 2L1']] },
  { zone: 'City Centre', city: 'Mississauga', streets: [['Hurontario St', 'L5B 3Y3'], ['Burnhamthorpe Rd W', 'L5B 4K6'], ['Confederation Pkwy', 'L5B 1B4'], ['Duke of York Blvd', 'L5B 3P8']] },
  { zone: 'Port Credit', city: 'Mississauga', streets: [['Lakeshore Rd E', 'L5G 1E7'], ['Hurontario St', 'L5G 3H5'], ['Stavebank Rd', 'L5G 2V1'], ['Mineola Rd E', 'L5G 2E6']] },
  { zone: 'Streetsville', city: 'Mississauga', streets: [['Queen St S', 'L5M 1K8'], ['Britannia Rd W', 'L5M 2B9'], ['Thomas St', 'L5M 0N2'], ['Mississauga Rd', 'L5N 2R7']] },
  { zone: 'Erin Mills', city: 'Mississauga', streets: [['Erin Mills Pkwy', 'L5M 4Z5'], ['Eglinton Ave W', 'L5M 6N2'], ['Glen Erin Dr', 'L5L 1J3'], ['The Collegeway', 'L5L 5C1']] },
  { zone: 'Meadowvale', city: 'Mississauga', streets: [['Derry Rd W', 'L5N 6A7'], ['Winston Churchill Blvd', 'L5N 6B2'], ['Aquitaine Ave', 'L5N 3S9'], ['Battleford Rd', 'L5N 2S3']] },
];

/** Adds customer31..50 (phones +1416555 0231..): ~half Brampton, half Mississauga. Idempotent. Runs after the orders seed so history is unchanged. */
export async function seedCustomersExtra(ds: DataSource, opts: SeedOptions): Promise<void> {
  if (!opts.demo) return;
  const hash = await bcrypt.hash(opts.demoPassword, 10);
  const users = ds.getRepository(User);
  const zones = new Map((await ds.getRepository(Zone).find()).map((z) => [z.name, z]));
  let created = 0;
  for (let n = 31; n <= 50; n++) {
    const idx = n - 31;
    const email = `customer${n}@demo.forksy.ca`;
    if (await users.findOne({ where: { email } })) continue;
    const brampton = idx % 2 === 0;
    const pool = SPOTS.filter((s) => (s.city === 'Brampton') === brampton);
    const spot = pool[Math.floor(idx / 2) % pool.length];
    const zone = zones.get(spot.zone);
    if (!zone) continue;
    const user = await users.save(
      users.create({
        type: UserType.CUSTOMER,
        status: UserStatus.ACTIVE,
        email,
        phone: `+1416555${String(200 + n).padStart(4, '0')}`,
        firstName: EX_FIRST[idx],
        lastName: EX_LAST[idx],
        emailVerified: true,
        phoneVerified: true,
        language: 'en',
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
    for (let k = 0; k < (n % 2 === 1 || n % 5 === 0 ? 2 : 1); k++) {
      const [street, postalCode] = spot.streets[(idx + k) % spot.streets.length];
      await addrs.save(
        addrs.create({
          customerId: user.id,
          label: k === 0 ? 'Home' : 'Work',
          line1: `${20 + ((n * 37 + k * 91) % 480)} ${street}`,
          city: spot.city,
          province: 'ON',
          postalCode,
          lat: +(zone.centerLat + (((n * 7 + k * 3) % 9) - 4) * 0.003).toFixed(6),
          lng: +(zone.centerLng + (((n * 5 + k * 2) % 9) - 4) * 0.004).toFixed(6),
          isDefault: k === 0,
        }),
      );
    }
    created++;
  }
  if (created) console.log(`  + ${created} extra demo customers (Brampton + Mississauga)`);
}
