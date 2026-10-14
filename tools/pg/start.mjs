import EmbeddedPostgres from 'embedded-postgres';
import fs from 'fs';
const dir = new URL('./data', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port: 5432, persistent: true, initdbFlags: ['--encoding=UTF8', '--locale=C'] });
if (!fs.existsSync(dir + '/PG_VERSION')) await pg.initialise();
await pg.start();
try { await pg.createDatabase('forky'); } catch (e) { console.log('db exists?', e.message); }
console.log('POSTGRES READY on 5432');
process.on('SIGINT', async () => { await pg.stop(); process.exit(0); });
setInterval(() => {}, 1 << 30);
