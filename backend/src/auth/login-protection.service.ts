import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';

interface Bucket {
  fails: number; // failures in the current window
  episodes: number; // how many times this key has been blocked (drives progressive back-off)
  windowStart: number;
  blockedUntil: number;
  lastSeen: number;
}

/**
 * Progressive brute-force protection, keyed independently by client IP and by identifier (email / phone / user id),
 * and applied to *every* attempted identifier - existing or not - so the response never reveals whether an account exists.
 *
 *  - per identifier: `maxFailedLogins` failures within 15 min => blocked for lockMinutes, doubling each repeat episode (max 24 h)
 *  - per IP:         20 failures (across identifiers) within 15 min => blocked 5 min, doubling each episode (max 24 h)
 *
 * In-memory (per instance). For a multi-instance deployment put Cloudflare / a WAF rate rule in front and/or swap the Map for Redis.
 */
@Injectable()
export class LoginProtection {
  private buckets = new Map<string, Bucket>();
  private readonly WINDOW = 15 * 60_000;
  private readonly MAX_KEYS = 100_000;

  constructor(private config: ConfigService) {}

  private get maxId() {
    return this.config.get<number>('security.maxFailedLogins') ?? 5;
  }
  private get lockMs() {
    return (this.config.get<number>('security.lockMinutes') ?? 15) * 60_000;
  }
  private get(key: string): Bucket {
    let b = this.buckets.get(key);
    const now = Date.now();
    if (!b) {
      if (this.buckets.size >= this.MAX_KEYS) this.sweep(true);
      b = { fails: 0, episodes: 0, windowStart: now, blockedUntil: 0, lastSeen: now };
      this.buckets.set(key, b);
    }
    if (now - b.windowStart > this.WINDOW && b.blockedUntil < now) {
      b.fails = 0;
      b.windowStart = now;
    }
    b.lastSeen = now;
    return b;
  }

  private static norm(id: string) {
    return id.trim().toLowerCase().slice(0, 200);
  }

  /** Throws 429 (identical text for unknown and known accounts) if the ip or identifier is currently blocked. */
  check(ip: string, identifier: string, scope = 'login'): void {
    const now = Date.now();
    const bi = this.buckets.get(`${scope}:ip:${ip}`);
    const ba = this.buckets.get(`${scope}:id:${LoginProtection.norm(identifier)}`);
    const until = Math.max(bi?.blockedUntil ?? 0, ba?.blockedUntil ?? 0);
    if (until > now) {
      const retry = Math.ceil((until - now) / 1000);
      throw new HttpException({ statusCode: 429, message: 'Too many attempts. Please try again later.', retryAfterSeconds: retry }, HttpStatus.TOO_MANY_REQUESTS, {});
    }
  }

  /** Record a failure. Returns { blocked } when this failure tripped a block (caller audits it). */
  fail(ip: string, identifier: string, scope = 'login'): { blocked: 'ip' | 'identifier' | null; seconds: number } {
    const now = Date.now();
    let blocked: 'ip' | 'identifier' | null = null;
    let seconds = 0;
    const ba = this.get(`${scope}:id:${LoginProtection.norm(identifier)}`);
    ba.fails++;
    if (ba.fails >= this.maxId) {
      const ms = Math.min(this.lockMs * 2 ** ba.episodes, 24 * 3600_000);
      ba.blockedUntil = now + ms;
      ba.episodes++;
      ba.fails = 0;
      blocked = 'identifier';
      seconds = Math.round(ms / 1000);
    }
    const bi = this.get(`${scope}:ip:${ip}`);
    bi.fails++;
    if (bi.fails >= 20) {
      const ms = Math.min(5 * 60_000 * 2 ** bi.episodes, 24 * 3600_000);
      bi.blockedUntil = now + ms;
      bi.episodes++;
      bi.fails = 0;
      blocked = 'ip';
      seconds = Math.round(ms / 1000);
    }
    return { blocked, seconds };
  }

  success(identifier: string, scope = 'login'): void {
    const b = this.buckets.get(`${scope}:id:${LoginProtection.norm(identifier)}`);
    if (b) {
      b.fails = 0;
      b.episodes = 0;
      b.blockedUntil = 0;
    }
  }

  /** Admin unlock (e.g. support unblocks a locked user). */
  clear(identifier: string, scope = 'login'): void {
    this.buckets.delete(`${scope}:id:${LoginProtection.norm(identifier)}`);
  }

  @Interval(5 * 60_000)
  sweep(force = false) {
    const now = Date.now();
    for (const [k, b] of this.buckets) {
      if (b.blockedUntil > now) continue;
      if (force || now - b.lastSeen > 2 * this.WINDOW) this.buckets.delete(k);
    }
  }
}
