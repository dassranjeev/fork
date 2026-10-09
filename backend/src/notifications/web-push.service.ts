import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { DataSource, In, LessThan, Repository } from 'typeorm';
import * as webpush from 'web-push';
import { seal, unseal } from '../common/secretbox';
import { WebPushSubscription } from '../database/entities';
import { SettingsService } from '../settings/settings.service';
import { URGENCY_TTL, Urgency } from './events';

/** What goes over the wire to the browser (<= 2.5 KB JSON). Built and sanitised by NotificationsService. */
export interface PushPayload {
  title: string;
  body: string;
  tag?: string;
  url: string;
  icon: string;
  badge: string;
  requireInteraction?: boolean;
  event: string;
  /** notification id (lets the page mark it read) */
  id?: string;
  /** urgency / ui hints for the service worker */
  critical?: boolean;
  data?: Record<string, string | number | boolean>;
  ts: number;
}

export interface PushResult {
  sent: number;
  failed: number;
  removed: number;
  attempts: number;
  errors: string[];
  skipped?: string;
}

export const MAX_PAYLOAD_BYTES = 2560;
const KNOWN_PUSH_HOSTS = [
  'fcm.googleapis.com',
  'android.googleapis.com',
  'updates.push.services.mozilla.com',
  'push.services.mozilla.com',
  'notify.windows.com',
  'push.apple.com',
  'web.push.apple.com',
];

/** tiny counting semaphore: bounds the number of in-flight requests to push services */
class Semaphore {
  private waiters: (() => void)[] = [];
  private active = 0;
  constructor(private max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.waiters.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * SSRF guard for subscription endpoints (a user chooses the URL the server will POST to). Production: https only and a known push
 * service host (or PUSH_ENDPOINT_HOSTS). Development / test: any https host, plus http on loopback so a local fake push service works.
 */
export function pushEndpointProblem(endpoint: string): string | null {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return 'endpoint is not a valid URL';
  }
  const prod = process.env.NODE_ENV === 'production';
  const host = u.hostname.toLowerCase();
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
  if (u.username || u.password) return 'endpoint must not contain credentials';
  if (!prod && loopback && (u.protocol === 'http:' || u.protocol === 'https:')) return null;
  if (u.protocol !== 'https:') return 'endpoint must be https';
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host) || host.includes(':')) return 'endpoint must use a host name';
  if (loopback || host.endsWith('.local') || host.endsWith('.internal')) return 'endpoint host is not allowed';
  if (prod) {
    const extra = (process.env.PUSH_ENDPOINT_HOSTS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const ok = [...KNOWN_PUSH_HOSTS, ...extra].some((h) => host === h || host.endsWith('.' + h));
    if (!ok) return 'endpoint host is not a recognised push service';
  }
  return null;
}

@Injectable()
export class WebPushService {
  private readonly logger = new Logger('WebPush');
  private vapidP: Promise<{ publicKey: string; privateKey: string; source: 'env' | 'stored' | 'generated' }> | null = null;
  private sem = new Semaphore(parseInt(process.env.PUSH_MAX_IN_FLIGHT ?? '16', 10));
  /** per-user bound on concurrent device sends */
  private readonly perUserLimit = 6;
  private readonly retryBaseMs = parseInt(process.env.PUSH_RETRY_BASE_MS ?? '400', 10);
  private readonly maxAttempts = 3;

  constructor(
    private settings: SettingsService,
    @InjectDataSource() private ds: DataSource,
    @InjectRepository(WebPushSubscription) private subs: Repository<WebPushSubscription>,
  ) {}

  // ---------------------------------------------------------------- VAPID keys
  /**
   * VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY from the environment win. Otherwise the pair is read from the settings table, where it
   * is stored encrypted (secretbox) as ONE value; when it is missing it is generated once (compare-and-set, so concurrent
   * instances end up with the same pair) and every later start reuses it.
   */
  vapid() {
    if (!this.vapidP) {
      this.vapidP = this.loadVapid().catch((e) => {
        this.vapidP = null;
        throw e;
      });
    }
    return this.vapidP;
  }

  private async loadVapid() {
    const envPub = process.env.VAPID_PUBLIC_KEY?.trim();
    const envPriv = process.env.VAPID_PRIVATE_KEY?.trim();
    if (envPub && envPriv) return { publicKey: envPub, privateKey: envPriv, source: 'env' as const };
    const read = async () => {
      const rows: { value: any }[] = await this.ds.query(`SELECT value FROM settings WHERE key = 'notifications.vapid.keys'`);
      const v = rows[0]?.value;
      if (typeof v !== 'string' || !v) return null;
      try {
        const j = JSON.parse(unseal(v));
        return j?.publicKey && j?.privateKey ? { publicKey: String(j.publicKey), privateKey: String(j.privateKey) } : null;
      } catch (e: any) {
        this.logger.error(`stored VAPID keys cannot be read (${e.message}) - was DATA_ENCRYPTION_KEY changed?`);
        return null;
      }
    };
    const existing = await read();
    if (existing) return { ...existing, source: 'stored' as const };
    const gen = webpush.generateVAPIDKeys();
    const sealed = JSON.stringify(seal(JSON.stringify(gen)));
    const upd = await this.ds.query(`UPDATE settings SET value = $1::jsonb WHERE key = 'notifications.vapid.keys' AND (value IS NULL OR value = '""'::jsonb)`, [sealed]);
    if (!(Array.isArray(upd) ? upd[1] : 0)) {
      await this.ds.query(
        `INSERT INTO settings (key, value, "group", label, "isSecret", "inputType", "isPublic") VALUES ('notifications.vapid.keys', $1::jsonb, 'notifications', 'Web Push (VAPID) key pair - generated automatically, stored encrypted', true, 'password', false) ON CONFLICT (key) DO NOTHING`,
        [sealed],
      );
    }
    const winner = await read();
    if (!winner) throw new Error('could not persist VAPID keys');
    // informational, non-secret mirror
    await this.ds
      .query(`UPDATE settings SET value = $1::jsonb WHERE key = 'notifications.vapid.publicKey'`, [JSON.stringify(winner.publicKey)])
      .catch(() => undefined);
    this.settings.reload().catch(() => undefined);
    this.logger.log(`VAPID keys ${winner.publicKey === gen.publicKey ? 'generated and stored (encrypted)' : 'loaded (generated by another instance)'}`);
    return { ...winner, source: (winner.publicKey === gen.publicKey ? 'generated' : 'stored') as 'generated' | 'stored' };
  }

  subject(): string {
    const s = (process.env.VAPID_SUBJECT || this.settings.get<string>('notifications.vapid.subject') || '').trim();
    if (/^(mailto:\S+@\S+|https:\/\/\S+)$/.test(s)) return s;
    const mail = this.settings.get<string>('general.supportEmail');
    return mail && /^\S+@\S+$/.test(mail) ? `mailto:${mail}` : 'mailto:support@forksy.ca';
  }

  async publicKey(): Promise<string | null> {
    try {
      return (await this.vapid()).publicKey;
    } catch (e: any) {
      this.logger.error(`VAPID unavailable: ${e.message}`);
      return null;
    }
  }

  // ---------------------------------------------------------------- subscriptions
  async subscribe(userId: string, app: WebPushSubscription['app'], sub: { endpoint: string; keys: { p256dh: string; auth: string } }, userAgent?: string) {
    const problem = pushEndpointProblem(sub.endpoint);
    if (problem) throw new BadRequestException(problem);
    // reject keys the encryption layer would refuse later (65-byte uncompressed P-256 point, 16-byte auth secret)
    const p = Buffer.from(sub.keys.p256dh, 'base64url');
    const a = Buffer.from(sub.keys.auth, 'base64url');
    if (p.length !== 65 || p[0] !== 4 || a.length !== 16) throw new BadRequestException('subscription keys are invalid');
    const ua = userAgent ? userAgent.slice(0, 300) : null;
    let row = await this.subs.findOne({ where: { endpoint: sub.endpoint } });
    if (row) {
      // the browser is now used by this user: the subscription moves to them (never stays with the previous user)
      Object.assign(row, { userId, app, p256dh: sub.keys.p256dh, auth: sub.keys.auth, userAgent: ua ?? row.userAgent, lastSeenAt: new Date(), failures: 0, lastError: null });
    } else {
      row = this.subs.create({ userId, app, platform: 'web', endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth, userAgent: ua, lastSeenAt: new Date(), failures: 0 });
    }
    await this.subs.save(row);
    // cap devices per user: drop the least recently seen beyond 10
    const mine = await this.subs.find({ where: { userId }, order: { lastSeenAt: 'DESC' }, select: ['id'] });
    if (mine.length > 10) await this.subs.delete({ id: In(mine.slice(10).map((m) => m.id)) });
    return row;
  }

  async unsubscribe(userId: string, endpoint: string) {
    const r = await this.subs.delete({ userId, endpoint });
    return { removed: r.affected ?? 0 };
  }

  forUser(userId: string) {
    return this.subs.find({ where: { userId }, order: { lastSeenAt: 'DESC' } });
  }

  async status(userId: string, endpoint?: string) {
    const mine = await this.forUser(userId);
    return { subscribed: endpoint ? mine.some((s) => s.endpoint === endpoint) : mine.length > 0, count: mine.length, current: endpoint ? mine.find((s) => s.endpoint === endpoint)?.id ?? null : null };
  }

  /** Touch lastSeenAt for the browser that is asking about itself (keeps it out of the stale clean-up). */
  async touch(userId: string, endpoint: string) {
    await this.subs.update({ userId, endpoint }, { lastSeenAt: new Date() });
  }

  async removeById(userId: string, id: string) {
    const r = await this.subs.delete({ id, userId });
    return (r.affected ?? 0) > 0;
  }

  // ---------------------------------------------------------------- delivery
  private clamp(p: PushPayload): string {
    let json = JSON.stringify(p);
    if (Buffer.byteLength(json) <= MAX_PAYLOAD_BYTES) return json;
    // too big: drop optional data first, then shorten the text
    const slim: PushPayload = { ...p, data: undefined };
    json = JSON.stringify(slim);
    if (Buffer.byteLength(json) <= MAX_PAYLOAD_BYTES) return json;
    slim.body = slim.body.slice(0, 100);
    slim.title = slim.title.slice(0, 60);
    return JSON.stringify(slim);
  }

  /** Send to every web subscription of a user. Never throws. */
  async sendToUser(userId: string, payload: PushPayload, opts: { urgency: Urgency; ttl?: number }): Promise<PushResult> {
    const out: PushResult = { sent: 0, failed: 0, removed: 0, attempts: 0, errors: [] };
    let subs: WebPushSubscription[];
    try {
      subs = await this.forUser(userId);
    } catch (e: any) {
      out.errors.push(`lookup: ${e.message}`);
      return out;
    }
    if (!subs.length) return { ...out, skipped: 'no web subscription' };
    let keys: Awaited<ReturnType<WebPushService['vapid']>>;
    try {
      keys = await this.vapid();
    } catch (e: any) {
      return { ...out, failed: subs.length, errors: [`VAPID unavailable: ${e.message}`] };
    }
    const json = this.clamp(payload);
    const topic = payload.tag ? createHash('sha256').update(payload.tag).digest('base64url').slice(0, 32) : undefined;
    const ttl = Math.max(0, Math.min(opts.ttl ?? URGENCY_TTL[opts.urgency], 7 * 86400));
    const local = new Semaphore(this.perUserLimit);
    await Promise.all(
      subs.map((s) =>
        local.run(() =>
          this.sem.run(async () => {
            const r = await this.sendOne(s, json, { ttl, urgency: opts.urgency, topic }, keys);
            out.attempts += r.attempts;
            if (r.state === 'sent') out.sent++;
            else if (r.state === 'gone') out.removed++;
            else {
              out.failed++;
              if (out.errors.length < 5) out.errors.push(r.error ?? 'failed');
            }
          }),
        ),
      ),
    );
    return out;
  }

  private async sendOne(s: WebPushSubscription, json: string, o: { ttl: number; urgency: Urgency; topic?: string }, keys: { publicKey: string; privateKey: string }) {
    let attempts = 0;
    let lastError = '';
    for (let i = 0; i < this.maxAttempts; i++) {
      attempts++;
      let wait = 0;
      try {
        const d = webpush.generateRequestDetails({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, json, {
          TTL: o.ttl,
          urgency: o.urgency,
          topic: o.topic,
          contentEncoding: 'aes128gcm',
          vapidDetails: { subject: this.subject(), publicKey: keys.publicKey, privateKey: keys.privateKey },
        } as any) as any;
        const headers: Record<string, string> = { ...d.headers };
        delete headers['Content-Length'];
        delete headers['content-length'];
        const res = await fetch(d.endpoint, { method: 'POST', headers, body: d.body, redirect: 'manual', signal: AbortSignal.timeout(10_000) });
        const status = res.status;
        await res.arrayBuffer().catch(() => undefined);
        if (status >= 200 && status < 300) {
          await this.subs.update(s.id, { failures: 0, lastError: null, lastSuccessAt: new Date() }).catch(() => undefined);
          return { state: 'sent' as const, attempts };
        }
        if (status === 404 || status === 410) {
          await this.subs.delete(s.id).catch(() => undefined);
          this.logger.log(`push subscription ${s.id} removed (push service answered ${status})`);
          return { state: 'gone' as const, attempts };
        }
        lastError = `push service answered ${status}`;
        if (status === 429) wait = Math.min(parseInt(res.headers.get('retry-after') ?? '', 10) * 1000 || this.retryBaseMs * 2 ** i, 5000);
        else if (status >= 500) wait = this.retryBaseMs * 2 ** i;
        else break; // 400 / 401 / 403 / 413: retrying will not help
      } catch (e: any) {
        lastError = String(e?.message ?? e).slice(0, 200);
        if (/invalid|must be|keys|authSecret|p256dh/i.test(lastError) && !/fetch failed|timeout|abort/i.test(lastError)) break;
        wait = this.retryBaseMs * 2 ** i;
      }
      if (i < this.maxAttempts - 1) await sleep(wait + Math.floor(Math.random() * 100));
    }
    await this.subs
      .createQueryBuilder()
      .update()
      .set({ failures: () => '"failures" + 1', lastError: lastError.slice(0, 250) })
      .where('id = :id', { id: s.id })
      .execute()
      .catch(() => undefined);
    return { state: 'failed' as const, attempts, error: lastError };
  }

  // ---------------------------------------------------------------- health + clean-up
  async health() {
    const [byApp, totals, failing] = await Promise.all([
      this.ds.query(`SELECT app, COUNT(*)::int AS n FROM push_subscriptions GROUP BY app ORDER BY app`),
      this.ds.query(`SELECT COUNT(*)::int AS n, COUNT(DISTINCT "userId")::int AS users FROM push_subscriptions`),
      this.ds.query(`SELECT COUNT(*)::int AS n FROM push_subscriptions WHERE failures > 0`),
    ]);
    const day = await this.ds.query(
      `SELECT COUNT(*) FILTER (WHERE "deliveryStatus" = 'SENT')::int AS sent, COUNT(*) FILTER (WHERE "deliveryStatus" = 'FAILED')::int AS failed,
              COUNT(*) FILTER (WHERE "deliveryStatus" = 'SKIPPED')::int AS skipped,
              COALESCE(SUM(COALESCE((meta->>'removed')::int, 0)), 0)::int AS removed
         FROM notifications WHERE channel = 'PUSH' AND "createdAt" > now() - interval '24 hours'`,
    );
    const week = await this.ds.query(`SELECT COALESCE(SUM(COALESCE((meta->>'removed')::int, 0)), 0)::int AS removed FROM notifications WHERE channel = 'PUSH' AND "createdAt" > now() - interval '7 days'`);
    const d = day[0] ?? { sent: 0, failed: 0, skipped: 0, removed: 0 };
    const attempted = d.sent + d.failed;
    return {
      subscriptions: totals[0]?.n ?? 0,
      users: totals[0]?.users ?? 0,
      byApp: Object.fromEntries(byApp.map((r: any) => [r.app, r.n])),
      failingSubscriptions: failing[0]?.n ?? 0,
      last24h: { sent: d.sent, failed: d.failed, skipped: d.skipped, failureRate: attempted ? Math.round((d.failed / attempted) * 1000) / 10 : 0, deadRemoved: d.removed },
      deadRemoved7d: week[0]?.removed ?? 0,
    };
  }

  /** Daily: drop subscriptions that keep failing (>= 20 in a row) or were not seen for 120 days. */
  @Cron('17 3 * * *')
  async purgeStale() {
    const a = await this.subs.createQueryBuilder().delete().where('failures >= 20').execute();
    const b = await this.subs.delete({ lastSeenAt: LessThan(new Date(Date.now() - 120 * 86400_000)) });
    if ((a.affected ?? 0) + (b.affected ?? 0)) this.logger.log(`purged ${(a.affected ?? 0) + (b.affected ?? 0)} stale push subscriptions`);
  }
}
