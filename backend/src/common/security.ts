import sanitizeHtml from 'sanitize-html';

/**
 * Shared security helpers: client IP, production safety gate, input sanitising.
 * Keep this file dependency-free (no Nest imports) so main.ts can use it before the app boots.
 */

// ------------------------------------------------------------------ CORS allow-list (shared by HTTP + Socket.IO)
export function corsAllowlist(): string[] {
  const isProd = process.env.NODE_ENV === 'production';
  return (process.env.CORS_ORIGINS ?? (isProd ? '' : 'http://localhost:3000,http://localhost:3001'))
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

/** a CORS_ORIGINS entry that covers subdomains: https://*.example.com (at least two labels after the *.) */
const WILDCARD_ENTRY = /^(https?):\/\/\*\.((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?::(\d{1,5}))?$/i;
export const isWildcardOrigin = (entry: string) => entry.includes('*');
export const isValidWildcardOrigin = (entry: string) => {
  const m = WILDCARD_ENTRY.exec(entry);
  return !!m && m[2].split('.').length >= 2 && /[a-z]/i.test(m[2].split('.').pop()!);
};

/**
 * Does one CORS_ORIGINS entry allow this browser origin?
 *   exact:     https://app.example.com
 *   wildcard:  https://*.example.com = every subdomain at any depth (a.example.com, b.a.example.com) but NOT example.com itself (list it too) and never a look-alike
 *              such as evilexample.com or example.com.evil.com. Scheme and port must be the same.
 * The browser origin is parsed first: anything with a login, a path, a query or a fragment is refused.
 */
export function originMatches(entry: string, origin: string): boolean {
  const o = origin.trim().replace(/\/$/, '');
  const e = entry.trim().replace(/\/$/, '');
  if (!o || o.toLowerCase() === 'null') return false;
  if (!isWildcardOrigin(e)) return o.toLowerCase() === e.toLowerCase();
  const w = WILDCARD_ENTRY.exec(e);
  if (!w) return false;
  let u: URL;
  try {
    u = new URL(o);
  } catch {
    return false;
  }
  if (u.origin.toLowerCase() !== o.toLowerCase() || u.username || u.password) return false;
  if (u.protocol !== `${w[1].toLowerCase()}:`) return false;
  const port = w[3] ?? '';
  if (u.port !== (port === (w[1].toLowerCase() === 'https' ? '443' : '80') ? '' : port)) return false;
  const suffix = `.${w[2].toLowerCase()}`;
  const host = u.hostname.toLowerCase();
  return host.length > suffix.length && host.endsWith(suffix);
}

/** is this browser origin on the allow-list (CORS_ORIGINS, wildcards included)? */
export function corsOriginAllowed(origin: string, list: string[] = corsAllowlist()): boolean {
  return list.some((entry) => originMatches(entry, origin));
}

/** cors `origin` callback: no Origin header (mobile apps, curl, server-to-server) is allowed; browsers must be on the allow-list. */
export function corsOriginCheck(origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) {
  if (!origin) return cb(null, true);
  return cb(null, corsOriginAllowed(origin));
}

// ------------------------------------------------------------------ client IP
/**
 * The real client IP. Relies on Express `trust proxy` (see TRUST_PROXY) so X-Forwarded-For is only honoured
 * for the configured number of trusted hops - a client talking to the app directly can NOT spoof it.
 */
export function clientIp(req: any): string {
  return (req?.ip as string) || req?.socket?.remoteAddress || 'unknown';
}

/** TRUST_PROXY=<hops> (e.g. 1 behind one load balancer, 2 behind Cloudflare + LB). Default 0 = do not trust X-Forwarded-For. */
export function trustProxySetting(): number | boolean {
  const v = (process.env.TRUST_PROXY ?? '').trim().toLowerCase();
  if (!v || v === 'false' || v === '0') return false;
  if (v === 'true') return 1; // never "trust everything": at most one hop
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 && n <= 5 ? n : false;
}

/** exact IP or IPv4 CIDR match (IPv6-mapped IPv4 addresses are unwrapped). Used for the optional admin IP allow-list. */
export function ipAllowed(ip: string, list: unknown): boolean {
  if (!Array.isArray(list) || !list.length) return true; // empty list = no restriction
  const v4 = (s: string) => {
    const m = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s.trim());
    return m ? ((+m[1] << 24) >>> 0) + (+m[2] << 16) + (+m[3] << 8) + +m[4] : null;
  };
  const me = v4(ip);
  for (const entry of list as string[]) {
    if (typeof entry !== 'string') continue;
    const [base, bits] = entry.split('/');
    if (!bits) {
      if (entry.trim() === ip || (v4(entry) !== null && v4(entry) === me)) return true;
      continue;
    }
    const b = v4(base);
    const n = Number(bits);
    if (me !== null && b !== null && n >= 0 && n <= 32) {
      const mask = n === 0 ? 0 : (0xffffffff << (32 - n)) >>> 0;
      if (((me & mask) >>> 0) === ((b & mask) >>> 0)) return true;
    }
  }
  return false;
}

// ------------------------------------------------------------------ production safety gate
export const KNOWN_DEFAULT_SECRETS = [
  'change-me-in-production',
  'change-me-to-a-long-random-string',
  'change-me',
  'changeme',
  'secret',
  'jwt-secret',
  'your-secret-key',
];
export const KNOWN_DEFAULT_PASSWORDS = ['Admin@12345', 'Demo@12345', 'admin', 'password', 'Password1'];

export interface SafetyInput {
  env: string;
  jwtSecret: string;
  dbSync: boolean;
  exposeOtp: boolean;
  corsOrigins: string[];
  publicUrl: string;
  /** ALLOW_MOCK_PAYMENTS is set (development mock payments) */
  allowMockPayments: boolean;
  /** STRIPE_API_BASE / MAPBOX_API_BASE / GOOGLE_API_BASE (fake servers for tests) are set */
  fakeProviderBases: boolean;
  enforce2fa: boolean;
  seedSuperAdminPassword: string;
  dbPassword: string;
  dataEncryptionKey: string;
}

/** Returns the list of problems that make a production boot unsafe. Empty = OK. */
export function productionProblems(i: SafetyInput): string[] {
  const p: string[] = [];
  const secret = i.jwtSecret ?? '';
  if (!secret || KNOWN_DEFAULT_SECRETS.includes(secret.toLowerCase()) || /^change[-_ ]?me/i.test(secret)) p.push('JWT_SECRET is missing or a known default value');
  else if (secret.length < 32) p.push(`JWT_SECRET is too short (${secret.length} chars, need >= 32 random characters)`);
  else if (new Set(secret).size < 10) p.push('JWT_SECRET has too little entropy (use e.g. `openssl rand -base64 48`)');
  if (i.dbSync) p.push('DB_SYNC=true (schema auto-sync must be OFF in production; use migrations)');
  if (i.exposeOtp) p.push('EXPOSE_OTP=true (one-time codes would be returned in API responses)');
  if (!i.corsOrigins.length) p.push('CORS_ORIGINS is empty (set the exact https origins of the admin console / website)');
  for (const o of i.corsOrigins) {
    if (o === '*' || /localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0/i.test(o)) p.push(`CORS_ORIGINS contains a local/wildcard origin: ${o}`);
    else if (!/^https:\/\//i.test(o)) p.push(`CORS_ORIGINS contains a non-HTTPS origin: ${o}`);
    // a subdomain pattern is allowed when it is shaped https://*.example.com (never a bare * or https://*.com)
    else if (isWildcardOrigin(o) && !isValidWildcardOrigin(o)) p.push(`CORS_ORIGINS contains a wildcard that is not of the form https://*.example.com: ${o}`);
  }
  if (!/^https:\/\//i.test(i.publicUrl) || /localhost|127\.0\.0\.1/i.test(i.publicUrl)) p.push('PUBLIC_URL must be the public https URL (not localhost / http)');
  if (i.allowMockPayments) p.push('ALLOW_MOCK_PAYMENTS is set (the mock payment provider is a development tool and must not exist in production)');
  if (i.fakeProviderBases) p.push('STRIPE_API_BASE / MAPBOX_API_BASE / GOOGLE_API_BASE are set (they point the API at fake servers; remove them in production)');
  // Stripe keys may live in the environment OR in System > Integrations (database): they are checked after the database is up, see stripeProductionProblems()
  if (!i.enforce2fa) p.push('ENFORCE_2FA is not true (staff and restaurant owners must use two-factor authentication in production)');
  if ((i.dataEncryptionKey ?? '').length < 32) p.push('DATA_ENCRYPTION_KEY is missing or shorter than 32 chars (it encrypts TOTP seeds at rest; keep it separate from JWT_SECRET)');
  if (KNOWN_DEFAULT_PASSWORDS.includes(i.seedSuperAdminPassword)) p.push('SEED_SUPERADMIN_PASSWORD is the known default - set a unique strong password');
  if (!i.dbPassword || ['postgres', 'password', 'admin', 'root'].includes(i.dbPassword)) p.push('DB_PASSWORD is empty or a well-known default; use a dedicated least-privilege DB user with a strong password');
  return p;
}

/** Production Stripe configuration (keys from settings or env). Empty = OK. Checked at boot once the settings are loaded. */
export function stripeProductionProblems(c: { secretKey: string; publishableKey: string; webhookSecret: string; connectEnabled: boolean }): string[] {
  const p: string[] = [];
  if (!c.secretKey) p.push('The Stripe secret key is not configured (System > Integrations or STRIPE_SECRET_KEY): customers could not pay');
  else if (!/^(sk|rk)_live_/.test(c.secretKey)) p.push('The Stripe secret key is not a LIVE key (sk_live_... / rk_live_...)');
  if (!c.publishableKey) p.push('The Stripe publishable key is not configured (System > Integrations or STRIPE_PUBLISHABLE_KEY)');
  else if (!/^pk_live_/.test(c.publishableKey)) p.push('The Stripe publishable key is not a LIVE key (pk_live_...)');
  if (!c.webhookSecret) p.push('The Stripe webhook signing secret is not configured (System > Integrations or STRIPE_WEBHOOK_SECRET)');
  return p;
}

// ------------------------------------------------------------------ input sanitising
const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
/** zero-width + bidi override/isolate characters (used for spoofing / homoglyph tricks) */
const INVISIBLE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
const TAG = /<\/?[a-zA-Z!?][^>]{0,2000}>/g;

/**
 * Plain-text field: remove HTML tags/comments, script/style bodies, control + bidi characters.
 * (Output encoding is still the renderer's job - React escapes - but nothing HTML-shaped is stored.)
 */
export function sanitizePlain(s: string): string {
  let out = s.normalize('NFC').replace(CTRL, '').replace(INVISIBLE, '');
  // drop whole <script>/<style> elements including content
  out = out.replace(/<\s*(script|style|iframe|object|embed)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '');
  let prev: string;
  do {
    prev = out;
    out = out.replace(TAG, '');
  } while (out !== prev);
  // a lone "<script" / "<img" fragment without closing ">" is still dangerous in some sinks
  out = out.replace(/<\s*\/?\s*(script|style|iframe|object|embed|img|svg|link|meta|body|html|form|input|a)\b[^>]*$/gi, '');
  out = out.replace(/\bjavascript\s*:/gi, '').replace(/\bvbscript\s*:/gi, '').replace(/\bdata\s*:\s*text\/html/gi, '');
  return out;
}

const RICH_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ['p', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'a', 'span', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'code', 'pre', 'img'],
  allowedAttributes: { a: ['href', 'title', 'target', 'rel'], img: ['src', 'alt', 'title', 'width', 'height'], '*': [] },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesByTag: { img: ['http', 'https'] },
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  transformTags: { a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer nofollow' }) },
  nonTextTags: ['style', 'script', 'textarea', 'option', 'noscript'],
};

/** Rich-text field (CMS pages, FAQ answers, email templates): strict allow-list sanitiser (no scripts, events, javascript: URLs). */
export function sanitizeRich(s: string): string {
  return sanitizeHtml(s.replace(CTRL, '').replace(INVISIBLE, ''), RICH_OPTIONS);
}

/** http(s) absolute URL or a site-relative path (/uploads/...) - everything else (javascript:, data:, file:) is rejected. */
export function isSafeUrl(u: string): boolean {
  const s = u.trim();
  if (!s) return true;
  if (s.length > 2048) return false;
  if (/[\u0000-\u001F\u007F\s]/.test(s)) return false;
  if (s.startsWith('/') && !s.startsWith('//')) return true;
  try {
    const url = new URL(s);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/** Escape for HTML text/attribute context (server-generated HTML: invoices, emails, statements). */
export function escapeHtml(v: unknown): string {
  return String(v ?? '').replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' })[c]!);
}

/** CSV/Excel formula injection: neutralise cells that spreadsheets would execute. */
export function csvSafe(v: unknown): string {
  let s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return s;
}

// ------------------------------------------------------------------ deep request sanitiser (interceptor uses this)
/** keys that carry secrets / opaque tokens - never altered */
const OPAQUE_KEY = /(password|passphrase|token|secret|signature|hash)$|^(otp|otpCode|code|csv|promoCode|giftCardCode|referralCode|raw)$/i;
/** keys that hold URLs and must be safe http(s)/relative URLs */
const URL_KEY = /(url|uri|link|href|src)s?$|^(avatar|image|photo|logo|banner|icon|cover|thumbnail)s?(url|uri|link|src|path)?$/i;
/** keys that legitimately hold rich text (sanitised with the allow-list instead of stripped) */
const RICH_KEY = /^(bodyHtml|contentHtml|html|htmlBody|descriptionHtml)$/i;

export class InputRejected extends Error {
  constructor(public field: string, public reason: string) {
    super(`${field}: ${reason}`);
  }
}

export interface SanitizeLimits {
  maxString: number;
  maxArray: number;
  maxDepth: number;
  maxKeys: number;
}
export const DEFAULT_LIMITS: SanitizeLimits = { maxString: 5_000, maxArray: 1000, maxDepth: 10, maxKeys: 200 };
/** fields that may legitimately be longer than the default cap */
const LONG_KEY = /(html|content|body|csv|json|template|polygon|geojson|coordinates|description|notes?|message|text)$/i;

/**
 * Walk a parsed JSON body / query: reject prototype pollution keys, absurd sizes, unsafe URLs; strip HTML from strings.
 * `richPaths` = keys (by name) that are allowed to carry HTML (sanitised through the allow-list).
 */
/** CMS-style field: HTML is allowed but only through the strict allow-list; text without markup is kept verbatim (no entity mangling). */
export function sanitizeRichOrText(s: string): string {
  const clean = s.replace(CTRL, '').replace(INVISIBLE, '');
  return /<\s*[a-zA-Z!\/?]/.test(clean) ? sanitizeRich(clean) : clean;
}

export function sanitizeDeep(value: any, key = '', depth = 0, lim: SanitizeLimits = DEFAULT_LIMITS, path = '', richKeys?: RegExp): any {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (value.length > (/csv$/i.test(key) ? 1_500_000 : LONG_KEY.test(key) ? 20_000 : lim.maxString)) throw new InputRejected(path || key || 'value', `string longer than ${lim.maxString} characters`);
    if (OPAQUE_KEY.test(key)) return value;
    if (URL_KEY.test(key)) {
      // banner links use an app-internal scheme: restaurant:<id> | promo:<code> | url:https://...
      const internal = /^(restaurant|promo):[A-Za-z0-9_-]{1,64}$/.exec(value.trim());
      const wrapped = /^url:(.+)$/.exec(value.trim());
      if (internal) return value.trim();
      if (wrapped && isSafeUrl(wrapped[1])) return value.trim();
      if (!isSafeUrl(value)) throw new InputRejected(path || key, 'must be an http(s) URL or site-relative path');
      return value.trim();
    }
    if (RICH_KEY.test(key)) return sanitizeRich(value);
    if (richKeys && richKeys.test(key)) return sanitizeRichOrText(value);
    return sanitizePlain(value);
  }
  if (typeof value !== 'object') return value;
  if (depth > lim.maxDepth) throw new InputRejected(path || key || 'value', `nesting deeper than ${lim.maxDepth}`);
  if (Array.isArray(value)) {
    if (value.length > lim.maxArray) throw new InputRejected(path || key || 'value', `array longer than ${lim.maxArray}`);
    return value.map((v, i) => sanitizeDeep(v, key, depth + 1, lim, `${path}[${i}]`, richKeys));
  }
  const keys = Object.keys(value);
  if (keys.length > lim.maxKeys) throw new InputRejected(path || key || 'value', `object has more than ${lim.maxKeys} keys`);
  const out: Record<string, any> = {};
  for (const k of keys) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') throw new InputRejected(path || k, 'forbidden key');
    out[k] = sanitizeDeep(value[k], k, depth + 1, lim, path ? `${path}.${k}` : k, richKeys);
  }
  return out;
}
