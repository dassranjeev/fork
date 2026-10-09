import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createPrivateKey, createSign } from 'crypto';
import { In, Repository } from 'typeorm';
import { unseal } from '../common/secretbox';
import { DeviceToken } from '../database/entities';
import { SettingsService } from '../settings/settings.service';
import { PushPayload, PushResult } from './web-push.service';
import { Urgency } from './events';

interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id: string;
  token_uri?: string;
}

const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/**
 * Firebase Cloud Messaging HTTP v1 for FUTURE native apps (device tokens registered through POST /notifications/devices).
 * Auth: a service-account JSON (setting `notifications.fcm.serviceAccountJson`, a secret, or env FCM_SERVICE_ACCOUNT_JSON) is
 * exchanged for an OAuth2 access token with an RS256 JWT signed with node:crypto; the token is cached until shortly before it
 * expires. The API base (FCM_API_BASE) and, outside production, the token endpoint (FCM_TOKEN_URI) can be redirected to a fake
 * server for tests. The legacy server-key API is gone.
 */
@Injectable()
export class FcmService {
  private readonly logger = new Logger('FCM');
  private cache: { token: string; exp: number; fingerprint: string } | null = null;
  private pending: Promise<string> | null = null;
  private readonly retryBaseMs = parseInt(process.env.PUSH_RETRY_BASE_MS ?? '400', 10);

  constructor(
    private settings: SettingsService,
    @InjectRepository(DeviceToken) private tokens: Repository<DeviceToken>,
  ) {}

  apiBase(): string {
    return (process.env.FCM_API_BASE || 'https://fcm.googleapis.com').replace(/\/+$/, '');
  }

  serviceAccount(): ServiceAccount | null {
    const raw = (process.env.FCM_SERVICE_ACCOUNT_JSON || this.settings.get<string>('notifications.fcm.serviceAccountJson') || '').toString().trim();
    if (!raw) return null;
    try {
      const j = JSON.parse(raw.startsWith('{') ? raw : unseal(raw));
      if (j?.client_email && j?.private_key && j?.project_id) return j as ServiceAccount;
    } catch {
      /* fall through */
    }
    this.logger.warn('FCM service account JSON is set but invalid (needs client_email, private_key, project_id)');
    return null;
  }

  configured() {
    return !!this.serviceAccount();
  }

  private tokenUri(sa: ServiceAccount): string {
    const prod = process.env.NODE_ENV === 'production';
    if (process.env.FCM_TOKEN_URI && !prod) return process.env.FCM_TOKEN_URI;
    return sa.token_uri === DEFAULT_TOKEN_URI || !sa.token_uri || prod ? DEFAULT_TOKEN_URI : sa.token_uri;
  }

  /** RS256 JWT assertion for the service account. */
  signJwt(sa: ServiceAccount, aud: string, now = Math.floor(Date.now() / 1000)): string {
    const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64u(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud, iat: now, exp: now + 3600 }));
    const sig = createSign('RSA-SHA256').update(`${head}.${claims}`).sign(createPrivateKey(sa.private_key));
    return `${head}.${claims}.${b64u(sig)}`;
  }

  /** Cached OAuth2 access token (refreshed 60 s before it expires; concurrent callers share one request). */
  async accessToken(force = false): Promise<string> {
    const sa = this.serviceAccount();
    if (!sa) throw new Error('FCM is not configured');
    const fp = `${sa.client_email}|${sa.private_key.length}`;
    if (!force && this.cache && this.cache.fingerprint === fp && this.cache.exp - 60_000 > Date.now()) return this.cache.token;
    if (this.pending) return this.pending;
    this.pending = (async () => {
      const uri = this.tokenUri(sa);
      const res = await fetch(uri, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: this.signJwt(sa, uri) }).toString(),
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`FCM OAuth ${res.status}`);
      const j: any = await res.json();
      if (!j?.access_token) throw new Error('FCM OAuth: no access_token');
      this.cache = { token: String(j.access_token), exp: Date.now() + Number(j.expires_in ?? 3600) * 1000, fingerprint: fp };
      return this.cache.token;
    })().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  /** FCM v1 message body for one device token. data values must be strings. */
  buildMessage(token: string, p: PushPayload, urgency: Urgency, ttlSec: number) {
    const high = urgency === 'high';
    const data: Record<string, string> = { event: p.event, url: p.url, link: p.url, ...(p.tag ? { tag: p.tag } : {}), ...(p.id ? { notificationId: p.id } : {}) };
    for (const [k, v] of Object.entries(p.data ?? {})) data[k] = String(v);
    return {
      message: {
        token,
        notification: { title: p.title, body: p.body },
        data,
        android: { priority: high ? 'HIGH' : 'NORMAL', ttl: `${Math.max(0, Math.floor(ttlSec))}s`, ...(p.tag ? { collapse_key: p.tag.slice(0, 64) } : {}), notification: { ...(p.tag ? { tag: p.tag } : {}), channel_id: p.critical ? 'critical' : 'default' } },
        apns: { headers: { 'apns-priority': high ? '10' : '5', 'apns-expiration': String(Math.floor(Date.now() / 1000) + ttlSec), ...(p.tag ? { 'apns-collapse-id': p.tag.slice(0, 64) } : {}) }, payload: { aps: { sound: 'default', ...(p.tag ? { 'thread-id': p.tag } : {}) } } },
      },
    };
  }

  /** Send to every native device token of a user. Never throws. */
  async sendToUser(userId: string, p: PushPayload, opts: { urgency: Urgency; ttl: number }): Promise<PushResult> {
    const out: PushResult = { sent: 0, failed: 0, removed: 0, attempts: 0, errors: [] };
    let devices: DeviceToken[];
    try {
      devices = await this.tokens.find({ where: { userId, platform: In(['ios', 'android']) } });
    } catch (e: any) {
      out.errors.push(`lookup: ${e.message}`);
      return out;
    }
    if (!devices.length) return { ...out, skipped: 'no native device token' };
    const sa = this.serviceAccount();
    if (!sa) {
      this.logger.debug(`[fcm:not-configured] ${devices.length} device(s) of ${userId} skipped`);
      return { ...out, skipped: 'FCM is not configured' };
    }
    for (let i = 0; i < devices.length; i += 8) {
      await Promise.all(
        devices.slice(i, i + 8).map(async (d) => {
          const r = await this.sendOne(sa, d, p, opts);
          out.attempts += r.attempts;
          if (r.state === 'sent') out.sent++;
          else if (r.state === 'gone') out.removed++;
          else {
            out.failed++;
            if (out.errors.length < 5) out.errors.push(r.error ?? 'failed');
          }
        }),
      );
    }
    return out;
  }

  private async sendOne(sa: ServiceAccount, d: DeviceToken, p: PushPayload, opts: { urgency: Urgency; ttl: number }) {
    const url = `${this.apiBase()}/v1/projects/${encodeURIComponent(sa.project_id)}/messages:send`;
    let lastError = '';
    let attempts = 0;
    let refreshed = false;
    for (let i = 0; i < 3; i++) {
      attempts++;
      let wait = 0;
      try {
        const token = await this.accessToken();
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(this.buildMessage(d.token, p, opts.urgency, opts.ttl)),
          redirect: 'manual',
          signal: AbortSignal.timeout(10_000),
        });
        const text = await res.text().catch(() => '');
        if (res.ok) {
          await this.tokens.update(d.id, { failures: 0, lastSeenAt: new Date() }).catch(() => undefined);
          return { state: 'sent' as const, attempts };
        }
        let code = '';
        try {
          const j = JSON.parse(text);
          code = String(j?.error?.status ?? '') + ' ' + JSON.stringify(j?.error?.details ?? '');
        } catch {
          /* not json */
        }
        if (res.status === 404 || /UNREGISTERED|NOT_FOUND/.test(code) || (res.status === 400 && /INVALID_ARGUMENT/.test(code) && /registration|token/i.test(text))) {
          await this.tokens.delete(d.id).catch(() => undefined);
          return { state: 'gone' as const, attempts };
        }
        lastError = `FCM ${res.status} ${code.trim().slice(0, 80)}`;
        if (res.status === 401 && !refreshed) {
          refreshed = true;
          await this.accessToken(true).catch(() => undefined);
          continue;
        }
        if (res.status === 429 || res.status >= 500) wait = Math.min(parseInt(res.headers.get('retry-after') ?? '', 10) * 1000 || this.retryBaseMs * 2 ** i, 5000);
        else break;
      } catch (e: any) {
        lastError = String(e?.message ?? e).slice(0, 200);
        wait = this.retryBaseMs * 2 ** i;
      }
      if (i < 2) await sleep(wait);
    }
    await this.tokens
      .createQueryBuilder()
      .update()
      .set({ failures: () => '"failures" + 1' })
      .where('id = :id', { id: d.id })
      .execute()
      .catch(() => undefined);
    return { state: 'failed' as const, attempts, error: lastError };
  }
}
