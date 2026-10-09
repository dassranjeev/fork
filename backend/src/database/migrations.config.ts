import { join } from 'path';

/**
 * Shared by the API (app.module.ts) and the CLI DataSource (data-source.ts).
 * The glob matches .ts files under ts-node (dev, migration:generate) and .js files in the compiled dist/ (production).
 */
export const MIGRATIONS_GLOB = join(__dirname, 'migrations', '*.{ts,js}');
export const MIGRATIONS_TABLE = 'schema_migrations';
