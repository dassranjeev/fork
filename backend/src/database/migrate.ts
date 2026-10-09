import 'reflect-metadata';
import { AppDataSource } from './data-source';

/**
 * Applies every pending migration, then exits. This is what production runs before the API starts:
 *
 *   node dist/database/migrate                      (docker compose: docker compose run --rm migrate)
 *
 * Safe to run repeatedly and from several replicas at once: a Postgres advisory lock lets only one runner work at a time,
 * and all pending migrations are applied in ONE transaction (all-or-nothing).
 */
const LOCK_KEY = 727_274_001; // arbitrary constant, only has to be the same in every runner

async function main() {
  await AppDataSource.initialize();
  const lock = AppDataSource.createQueryRunner();
  await lock.connect();
  try {
    await lock.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    const applied = await AppDataSource.runMigrations({ transaction: 'all' });
    if (!applied.length) console.log('Database schema is up to date - no pending migrations.');
    else for (const m of applied) console.log(`  applied ${m.name}`);
  } finally {
    await lock.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    await lock.release();
    await AppDataSource.destroy();
  }
}

main().catch((e) => {
  console.error('Migration failed:', e?.message ?? e);
  process.exit(1);
});
