// Usage: node scripts/create-db.js <dbname>   -> creates the database if it does not exist (UTF8)
const { Client } = require('pg');
const name = process.argv[2];
if (!name || !/^[a-z0-9_]+$/.test(name)) { console.error('usage: node scripts/create-db.js <lowercase_name>'); process.exit(1); }
(async () => {
  const c = new Client({ host: process.env.DB_HOST || 'localhost', port: +(process.env.DB_PORT || 5432), user: process.env.DB_USER || 'postgres', password: process.env.DB_PASSWORD || 'postgres', database: 'postgres' });
  await c.connect();
  const r = await c.query('SELECT 1 FROM pg_database WHERE datname=$1', [name]);
  if (!r.rowCount) { await c.query(`CREATE DATABASE "${name}" ENCODING 'UTF8' TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'`); console.log('created', name); } else console.log('exists', name);
  await c.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
