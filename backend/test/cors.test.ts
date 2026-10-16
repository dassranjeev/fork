/**
 * Unit tests of the CORS allow-list (no server): exact origins, https://*.example.com subdomain entries, look-alike and trick origins, and the production safety rule for the list.
 *
 *   cd backend && npx ts-node --transpile-only test/cors.test.ts
 */
import { corsOriginAllowed, corsOriginCheck, isValidWildcardOrigin, originMatches, productionProblems } from '../src/common/security';

let failed = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

const LIST = ['https://app.forky.ca', 'https://forky.ca', 'https://*.forky.ca'];
const yes = (o: string, list = LIST) => corsOriginAllowed(o, list);

check('an exact origin is allowed, case and a trailing slash do not matter', yes('https://app.forky.ca') && yes('https://APP.forky.ca') && yes('https://app.forky.ca/') && yes('https://forky.ca'));
check('a subdomain of forky.ca is allowed', yes('https://api.forky.ca') && yes('https://shop.forky.ca') && yes('https://a-b.forky.ca') && yes('https://X1.FORKY.CA'));
check('so is a subdomain of a subdomain (any depth)', yes('https://a.b.forky.ca') && yes('https://one.two.three.forky.ca'));
check('forky.ca itself is not covered by *.forky.ca (it has its own entry)', !originMatches('https://*.forky.ca', 'https://forky.ca') && yes('https://forky.ca') && !yes('https://forky.ca', ['https://*.forky.ca']));
check('look-alike hosts are refused', !yes('https://evilforky.ca') && !yes('https://forky.ca.evil.com') && !yes('https://a.forky.ca.evil.com') && !yes('https://forky-ca.com') && !yes('https://xforky.ca') && !yes('https://forky.com'));
check('other sites and the local machine are refused', !yes('https://example.com') && !yes('http://localhost:3000') && !yes('http://127.0.0.1:5173') && !yes('https://app.forky.ca.localhost'));
check('the scheme must be the same: http://x.forky.ca is refused by an https entry', !yes('http://shop.forky.ca') && !yes('http://forky.ca') && !yes('ftp://shop.forky.ca'));
check('the port must be the same: none in the entry means the default port only', !yes('https://shop.forky.ca:8443') && originMatches('https://*.forky.ca:8443', 'https://shop.forky.ca:8443') && !originMatches('https://*.forky.ca:8443', 'https://shop.forky.ca') && originMatches('https://*.forky.ca:443', 'https://shop.forky.ca'));
check('a login, a path, a query or a fragment in the "origin" is refused', !yes('https://evil@shop.forky.ca') && !yes('https://evil:pw@shop.forky.ca') && !yes('https://shop.forky.ca/path') && !yes('https://shop.forky.ca?x=1') && !yes('https://shop.forky.ca#x'));
check('"null", empty and rubbish origins are refused', !yes('null') && !yes('') && !yes('   ') && !yes('not a url') && !yes('https://') && !yes('https://.forky.ca'));
check('an entry that is not a wildcard still needs an exact match', !yes('https://shop.forky.ca', ['https://app.forky.ca']) && yes('https://app.forky.ca', ['https://app.forky.ca']));
check('an empty list allows no browser origin', !yes('https://app.forky.ca', []));
check('http wildcard entries work for development (same scheme rule); a one-label domain like *.localhost is never a wildcard', originMatches('http://*.example.test:3000', 'http://app.example.test:3000') && !originMatches('http://*.example.test:3000', 'https://app.example.test:3000') && !originMatches('http://*.localhost:3000', 'http://app.localhost:3000'));

// the shape of a wildcard entry
check('valid wildcard entries', ['https://*.forky.ca', 'https://*.example.co.uk', 'https://*.sub.forky.ca', 'https://*.forky.ca:8443'].every(isValidWildcardOrigin));
check('invalid wildcard entries', ['https://*', '*', 'https://*.ca', 'https://*.*.forky.ca', 'https://a.*.forky.ca', 'https://*forky.ca', 'https://*.forky.ca/', 'https://*.-forky.ca', 'https://*.123', 'https://*.forky.ca:99999x'].every((e) => !isValidWildcardOrigin(e)), ['https://*', 'https://*.ca', 'https://*.123'].map(isValidWildcardOrigin));

// the cors middleware callback (HTTP and Socket.IO use it) reads CORS_ORIGINS
const saved = process.env.CORS_ORIGINS;
process.env.CORS_ORIGINS = LIST.join(', ');
const run = (o: string | undefined) => { let r: boolean | undefined; corsOriginCheck(o, (_e, a) => { r = a; }); return r; };
check('the cors callback: no Origin header is fine (apps, curl), a listed subdomain is allowed, a stranger is not', run(undefined) === true && run('https://shop.forky.ca') === true && run('https://forky.ca') === true && run('https://evil.example') === false && run('https://evilforky.ca') === false);
process.env.CORS_ORIGINS = saved;
if (saved === undefined) delete process.env.CORS_ORIGINS;

// the production start-up rule for the list
const base = { env: 'production', jwtSecret: 'x7Kq9mPz2LwR4vTn8Bc3Yd6Fh1JgS5aUeOiQ0pZ', dbSync: false, exposeOtp: false, corsOrigins: LIST, publicUrl: 'https://api.forky.ca', allowMockPayments: false, fakeProviderBases: false, enforce2fa: true, seedSuperAdminPassword: 'aVery-Unique-Pass-7391!', dbPassword: 'k3Lm9Pq2Zt7Wx5Bn8Cv1', dataEncryptionKey: 'b6N2dF8gH4jK0lM3pQ7rS9tV1wX5yZ8a' } as any;
const corsProblems = (list: string[]) => productionProblems({ ...base, corsOrigins: list }).filter((p: string) => /CORS/.test(p));
check('production accepts exact origins and https://*.example.com entries', corsProblems(LIST).length === 0 && corsProblems(['https://forky.ca', 'https://*.forky.ca']).length === 0, corsProblems(LIST));
check('production still refuses *, localhost, plain http and badly shaped wildcards', corsProblems(['*']).length === 1 && corsProblems(['https://localhost:3000']).length === 1 && corsProblems(['http://app.forky.ca']).length === 1 && corsProblems(['http://*.forky.ca']).length === 1 && corsProblems(['https://*.ca']).length === 1 && corsProblems(['https://*']).length === 1 && corsProblems(['https://*.localhost']).length === 1 && corsProblems([]).length === 1, [corsProblems(['https://*.ca']), corsProblems(['https://*'])]);

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall CORS checks passed');
process.exit(failed ? 1 : 0);
