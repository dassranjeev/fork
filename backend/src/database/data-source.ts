import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { ALL_ENTITIES } from './entities';
import { MIGRATIONS_GLOB, MIGRATIONS_TABLE } from './migrations.config';

// CLI / migration runner only: pick up backend/.env when it exists (the API itself loads it through ConfigModule).
// In a container the real environment is used and there is no .env file.
try {
  process.loadEnvFile('.env');
} catch {
  /* no .env file - rely on the process environment */
}

/**
 * TypeORM DataSource for migrations. Same DB_* variables as the API (see config/configuration.ts).
 * No statement_timeout here on purpose: creating an index on a large table can legitimately take longer than the API's 15 s guard.
 *
 *   npm run migration:generate -- src/database/migrations/<Name>   (diff entities vs the database in DB_NAME)
 *   npm run migration:run | migration:revert | migration:show | migration:check
 */
export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: parseInt(process.env.DB_PORT ?? '5432', 10),
  username: process.env.DB_USER ?? 'postgres',
  password: process.env.DB_PASSWORD ?? 'postgres',
  database: process.env.DB_NAME ?? 'forky',
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  entities: ALL_ENTITIES,
  migrations: [MIGRATIONS_GLOB],
  migrationsTableName: MIGRATIONS_TABLE,
  synchronize: false,
  logging: process.env.DB_LOGGING === 'true',
});

