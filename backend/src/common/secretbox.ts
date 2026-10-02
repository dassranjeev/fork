import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

/**
 * Field-level encryption for secrets stored in the database (TOTP seeds). AES-256-GCM, random 96-bit IV per value,
 * key derived from DATA_ENCRYPTION_KEY (production REQUIRES it; in development it falls back to JWT_SECRET).
 * Values without the "enc1:" prefix are legacy plaintext and are returned unchanged, so existing rows keep working
 * and are upgraded the next time they are written.
 */
const key = () => createHash('sha256').update('forksy-secretbox-v1:' + (process.env.DATA_ENCRYPTION_KEY || process.env.JWT_SECRET || '')).digest();

export function seal(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return 'enc1:' + [iv, c.getAuthTag(), enc].map((b) => b.toString('base64url')).join('.');
}

export function unseal(stored: string): string {
  if (!stored.startsWith('enc1:')) return stored;
  const [iv, tag, enc] = stored.slice(5).split('.').map((p) => Buffer.from(p, 'base64url'));
  const d = createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}
