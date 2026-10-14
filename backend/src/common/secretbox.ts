import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

/**
 * Field-level encryption for secrets stored in the database (TOTP seeds, integration keys, VAPID keys). AES-256-GCM, random 96-bit IV per value,
 * key derived from DATA_ENCRYPTION_KEY (production REQUIRES it; in development it falls back to JWT_SECRET).
 * Values without the "enc1:" prefix are legacy plaintext and are returned unchanged, so existing rows keep working
 * and are upgraded the next time they are written.
 *
 * DO NOT RENAME THE SALT when rebranding. It is a cryptographic constant, not a brand name: changing it changes the derived key, and every
 * value sealed before (2FA seeds, integration secrets, push keys) becomes unreadable (sign-in fails with a 500). Any salt that was ever
 * shipped stays in LEGACY_SALTS so data sealed with it can still be READ; new values are always sealed with SALT.
 */
const SALT = 'forksy-secretbox-v1:';
const LEGACY_SALTS = ['forky-secretbox-v1:']; // shipped by a rebranded build on 2026-10-14 (global find-and-replace); read-only
const keyFor = (salt: string) => createHash('sha256').update(salt + (process.env.DATA_ENCRYPTION_KEY || process.env.JWT_SECRET || '')).digest();

export function seal(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keyFor(SALT), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return 'enc1:' + [iv, c.getAuthTag(), enc].map((b) => b.toString('base64url')).join('.');
}

export function unseal(stored: string): string {
  if (!stored.startsWith('enc1:')) return stored;
  const [iv, tag, enc] = stored.slice(5).split('.').map((p) => Buffer.from(p, 'base64url'));
  let lastError: unknown;
  for (const salt of [SALT, ...LEGACY_SALTS]) {
    try {
      const d = createDecipheriv('aes-256-gcm', keyFor(salt), iv);
      d.setAuthTag(tag);
      return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}
