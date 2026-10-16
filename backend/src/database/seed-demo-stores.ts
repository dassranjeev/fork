import 'reflect-metadata';
import { AppDataSource } from './data-source';
import { seedPlatform } from '../platform/platform.seed';
import { DEMO_STORE_ACCOUNT_DOMAIN, DEMO_STORE_SLUGS, removeDemoStores, seedDemoStores } from '../restaurants/restaurants.seed';

/**
 * Puts three demo stores on a site that has none (or takes them out again). Uses the database only (no API process is started), so it is safe next to a running API.
 *
 *   DEMO_STORES_PASSWORD='<at least 12 characters>' npm run seed:demo-stores         (production image: node dist/database/seed-demo-stores)
 *   npm run seed:demo-stores -- --remove
 *
 * DEMO_STORES_PASSWORD becomes the password of the demo owner and staff accounts (owner27@, manager27@, cashier27@, kitchen27@ ... stores.forksy.ca). It has no default
 * on purpose: the demo password of the repository is public. Docs: docs/store-types.md ("Demo data").
 */
async function main() {
  const remove = process.argv.includes('--remove');
  await AppDataSource.initialize();
  try {
    if (remove) {
      const r = await removeDemoStores(AppDataSource);
      if (r.refused) {
        console.error(r.refused);
        process.exitCode = 1;
      } else console.log(r.removed.length ? `Removed: ${r.removed.join(', ')}` : 'The demo stores are not there.');
      return;
    }
    const password = process.env.DEMO_STORES_PASSWORD ?? '';
    if (password.length < 12) throw new Error('Set DEMO_STORES_PASSWORD (at least 12 characters): it is the password of the demo owner and staff accounts. There is no default on purpose.');
    const opts = { demo: true, demoPassword: password };
    await seedPlatform(AppDataSource, opts); // zones, taxes, the "Grocery & retail" commission tier and the store cuisines (only what is missing)
    await seedDemoStores(AppDataSource, opts);
    console.log(`Demo stores ready: ${DEMO_STORE_SLUGS.join(', ')}`);
    console.log(`Owner logins: owner27@${DEMO_STORE_ACCOUNT_DOMAIN}, owner28@${DEMO_STORE_ACCOUNT_DOMAIN}, owner29@${DEMO_STORE_ACCOUNT_DOMAIN} (restaurant portal, /portal)`);
  } finally {
    await AppDataSource.destroy();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
