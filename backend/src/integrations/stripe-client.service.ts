import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';

export type KeySource = 'settings' | 'env' | 'none';
export type StripeMode = 'test' | 'live' | 'none';

export interface StripeConfig {
  secretKey: string;
  publishableKey: string;
  webhookSecret: string;
  connectEnabled: boolean;
  currency: string;
  platformCountry: string;
  sources: { secretKey: KeySource; publishableKey: KeySource; webhookSecret: KeySource };
  /** test | live (from the secret key prefix) | none */
  mode: StripeMode;
}

export const STRIPE_SECRET_RE = /^(sk|rk)_(test|live)_[A-Za-z0-9]{10,250}$/;
export const STRIPE_PUBLISHABLE_RE = /^pk_(test|live)_[A-Za-z0-9]{10,250}$/;
export const STRIPE_WEBHOOK_RE = /^whsec_[A-Za-z0-9+/=_-]{10,250}$/;

export const modeOfKey = (k: string): StripeMode => (/^(sk|rk|pk)_live_/.test(k) ? 'live' : /^(sk|rk|pk)_test_/.test(k) ? 'test' : 'none');

/**
 * The ONE place that knows where the Stripe credentials come from and builds the Stripe client.
 *
 *  - Credentials: the setting (System > Integrations, stored encrypted) WINS, the environment variable is the fallback
 *    (STRIPE_SECRET_KEY / STRIPE_PUBLISHABLE_KEY / STRIPE_WEBHOOK_SECRET).
 *  - STRIPE_API_BASE (e.g. http://localhost:4242) points the client at a fake Stripe server. It is honoured only outside production.
 *  - Mock mode (no Stripe key at all) exists for automated tests and a developer machine ONLY: it needs NODE_ENV != production
 *    AND no key AND ALLOW_MOCK_PAYMENTS=true. With a key present the mock is never used.
 */
@Injectable()
export class StripeClientService {
  private readonly logger = new Logger('Stripe');
  private cached: { sig: string; client: any } | null = null;

  constructor(private settings: SettingsService) {}

  private pick(settingKey: string, envName: string): { value: string; source: KeySource } {
    const s = this.settings.get<string>(settingKey, '');
    if (typeof s === 'string' && s.trim()) return { value: s.trim(), source: 'settings' };
    const e = (process.env[envName] ?? '').trim();
    if (e) return { value: e, source: 'env' };
    return { value: '', source: 'none' };
  }

  config(): StripeConfig {
    const sk = this.pick('integrations.stripe.secretKey', 'STRIPE_SECRET_KEY');
    const pk = this.pick('integrations.stripe.publishableKey', 'STRIPE_PUBLISHABLE_KEY');
    const wh = this.pick('integrations.stripe.webhookSecret', 'STRIPE_WEBHOOK_SECRET');
    return {
      secretKey: sk.value,
      publishableKey: pk.value,
      webhookSecret: wh.value,
      connectEnabled: this.settings.get<boolean>('integrations.stripe.connectEnabled', true) !== false,
      currency: String(this.settings.get<string>('integrations.stripe.currency', 'cad') || 'cad').toLowerCase(),
      platformCountry: String(this.settings.get<string>('integrations.stripe.platformCountry', 'CA') || 'CA').toUpperCase(),
      sources: { secretKey: sk.source, publishableKey: pk.source, webhookSecret: wh.source },
      mode: modeOfKey(sk.value),
    };
  }

  /** Base URL override for a fake Stripe server (development / automated tests only). */
  apiBase(): { host: string; port: number; protocol: 'http' | 'https' } | null {
    const raw = (process.env.STRIPE_API_BASE ?? '').trim();
    if (!raw || process.env.NODE_ENV === 'production') return null;
    try {
      const u = new URL(raw);
      const protocol = u.protocol === 'https:' ? 'https' : 'http';
      return { host: u.hostname, port: u.port ? Number(u.port) : protocol === 'https' ? 443 : 80, protocol };
    } catch {
      this.logger.error('STRIPE_API_BASE is not a valid URL - ignored');
      return null;
    }
  }

  /** The Stripe client for the configured secret key, or null when no key is configured. */
  client(): any | null {
    const { secretKey } = this.config();
    if (!secretKey) return null;
    const base = this.apiBase();
    const sig = `${secretKey}|${base ? `${base.protocol}://${base.host}:${base.port}` : ''}`;
    if (!this.cached || this.cached.sig !== sig) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Stripe = require('stripe');
      this.cached = { sig, client: new (Stripe.default ?? Stripe)(secretKey, { maxNetworkRetries: 2, timeout: 20_000, appInfo: { name: 'FORKY' }, ...(base ?? {}) }) };
    }
    return this.cached.client;
  }

  /** Stripe client or a 503 (never a silent mock). */
  require(): any {
    const c = this.client();
    if (!c) throw new ServiceUnavailableException('Payments are not configured yet (no Stripe key). Ask an administrator to add the Stripe keys under System > Integrations.');
    return c;
  }

  /** Mock payments: automated tests / a dev machine only (see class comment). */
  mockAllowed(): boolean {
    return process.env.NODE_ENV !== 'production' && process.env.ALLOW_MOCK_PAYMENTS === 'true' && !this.config().secretKey;
  }

  /** 'stripe' = a key is configured, 'mock' = the dev mock is active, 'none' = payments are unavailable. */
  provider(): 'stripe' | 'mock' | 'none' {
    if (this.config().secretKey) return 'stripe';
    return this.mockAllowed() ? 'mock' : 'none';
  }

  /** Webhook signature verification (throws when the signature is bad / the secret is missing). */
  constructEvent(raw: Buffer, signature: string, toleranceSec = 300): any {
    const { webhookSecret } = this.config();
    if (!webhookSecret) throw new Error('STRIPE_WEBHOOK_SECRET is not configured');
    // the SDK instance is only needed for its webhooks helper; any key works (no network call is made)
    const c = this.client() ?? (() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Stripe = require('stripe');
      return new (Stripe.default ?? Stripe)('sk_test_webhook_verification_only');
    })();
    return c.webhooks.constructEvent(raw, signature, webhookSecret, toleranceSec);
  }
}

/** Dollars -> integer cents (CAD has 2 decimals). */
export const toCents = (n: number) => Math.round((Number(n) + Number.EPSILON) * 100);
export const fromCents = (n: number) => Math.round(Number(n)) / 100;
