import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SettingsService, sealSecret } from '../settings/settings.service';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Setting } from '../database/entities';
import { AuditService } from '../audit/audit.service';
import { MapboxService } from './mapbox.service';
import { KeySource, modeOfKey, StripeClientService, StripeMode } from './stripe-client.service';

/** Events the webhook handler processes. The admin must subscribe the Stripe endpoint to exactly these. */
export const STRIPE_WEBHOOK_EVENTS = [
  'payment_intent.succeeded',
  'payment_intent.amount_capturable_updated',
  'payment_intent.payment_failed',
  'payment_intent.canceled',
  'charge.refunded',
  'charge.dispute.created',
  'charge.dispute.updated',
  'charge.dispute.closed',
  'setup_intent.succeeded',
  'transfer.created',
  'transfer.updated',
  'transfer.reversed',
  'payout.paid',
  'payout.failed',
  'account.updated',
];

export const mask = (v: string): string => (v ? `********${v.slice(-4)}` : '');

interface SecretView {
  set: boolean;
  source: KeySource;
  /** ******** + last 4 characters; never the value */
  masked: string;
}

const view = (value: string, source: KeySource): SecretView => ({ set: !!value, source, masked: mask(value) });

export interface TestResult {
  ok: boolean;
  checkedAt: string;
  reason?: string;
  [k: string]: any;
}

/**
 * Integrations admin backend: status of every external key (never the secrets), validated + audited updates of the Stripe and
 * Mapbox keys, and the "Test connection" probes. Secrets are sealed at rest by SettingsService (AES-256-GCM, DATA_ENCRYPTION_KEY).
 */
@Injectable()
export class IntegrationsService {
  private readonly logger = new Logger('Integrations');
  private lastTests: Record<string, TestResult> = {};

  constructor(
    private settings: SettingsService,
    private stripe: StripeClientService,
    private mapbox: MapboxService,
    private audit: AuditService,
    private config: ConfigService,
    @InjectRepository(Setting) private repo: Repository<Setting>,
  ) {}

  webhookUrl(): string {
    const base = String(this.config.get('publicUrl') ?? 'http://localhost:4000').replace(/\/+$/, '');
    return `${base}/api/v1/webhooks/stripe`;
  }

  // ------------------------------------------------------------------ status
  stripeStatus() {
    const c = this.stripe.config();
    const pkMode = modeOfKey(c.publishableKey);
    const warnings: string[] = [];
    const secretMode = c.mode;
    const mixed = !!(secretMode !== 'none' && pkMode !== 'none' && secretMode !== pkMode);
    if (mixed) warnings.push(`The secret key is a ${secretMode.toUpperCase()} key but the publishable key is a ${pkMode.toUpperCase()} key. Customers would not be able to pay. Use keys of the same mode.`);
    if (c.secretKey && !c.publishableKey) warnings.push('The publishable key is missing: customers cannot see the card form.');
    if (c.secretKey && !c.webhookSecret) warnings.push('The webhook signing secret is missing: payment confirmations, refunds, disputes and payouts will not be synced.');
    if (c.secretKey && c.connectEnabled === false) warnings.push('Stripe Connect is switched off: drivers and restaurants cannot be paid through Stripe.');
    if (this.stripe.apiBase()) warnings.push(`STRIPE_API_BASE is set: Stripe calls go to ${process.env.STRIPE_API_BASE} (fake server, development only).`);
    const provider = this.stripe.provider();
    if (provider === 'mock') warnings.push('MOCK payments are active (no Stripe key, ALLOW_MOCK_PAYMENTS=true): no real money moves. Development only.');
    return {
      configured: !!c.secretKey,
      mode: secretMode as StripeMode,
      livemode: secretMode === 'live',
      provider,
      keys: {
        secretKey: view(c.secretKey, c.sources.secretKey),
        publishableKey: { ...view(c.publishableKey, c.sources.publishableKey), value: c.publishableKey },
        webhookSecret: view(c.webhookSecret, c.sources.webhookSecret),
      },
      connectEnabled: c.connectEnabled,
      currency: c.currency,
      platformCountry: c.platformCountry,
      webhook: { url: this.webhookUrl(), events: STRIPE_WEBHOOK_EVENTS },
      mixedModes: mixed,
      warnings,
      lastTest: this.lastTests.stripe ?? null,
    };
  }

  mapboxStatus() {
    const c = this.mapbox.config();
    return {
      configured: !!c.token,
      keys: {
        accessToken: view(c.token, c.tokenSource),
        publicToken: { set: !!c.publicToken, masked: mask(c.publicToken), source: (c.publicToken ? 'settings' : 'none') as KeySource },
      },
      country: c.country,
      bbox: c.bbox,
      proximity: c.proximity,
      tokenKind: c.token.startsWith('sk.') ? 'secret' : c.token.startsWith('pk.') ? 'public' : c.token ? 'unknown' : 'none',
      warnings: [
        ...(c.token.startsWith('pk.') ? ['A public (pk.) token works for address search, but a secret (sk.) token with the Search scope is recommended for the server.'] : []),
        ...(process.env.MAPBOX_API_BASE && process.env.NODE_ENV !== 'production' ? [`MAPBOX_API_BASE is set: Mapbox calls go to ${process.env.MAPBOX_API_BASE} (fake server, development only).`] : []),
      ],
      lastTest: this.lastTests.mapbox ?? null,
    };
  }

  private other(label: string, items: { name: string; setting?: string; env?: string }[]) {
    const parts = items.map((i) => {
      const s = i.setting ? this.settings.get<string>(i.setting, '') : '';
      const e = i.env ? process.env[i.env] ?? '' : '';
      return { name: i.name, set: !!(s || e), source: (s ? 'settings' : e ? 'env' : 'none') as KeySource };
    });
    return { label, configured: parts.every((p) => p.set), partial: parts.some((p) => p.set) && !parts.every((p) => p.set), parts };
  }

  async status() {
    return {
      stripe: this.stripeStatus(),
      mapbox: this.mapboxStatus(),
      others: {
        googleMaps: this.other('Google Maps', [{ name: 'API key', setting: 'maps.googleApiKey', env: 'GOOGLE_MAPS_API_KEY' }]),
        twilio: this.other('Twilio (SMS)', [
          { name: 'Account SID', setting: 'notifications.twilioAccountSid', env: 'TWILIO_ACCOUNT_SID' },
          { name: 'Auth token', setting: 'notifications.twilioAuthToken', env: 'TWILIO_AUTH_TOKEN' },
        ]),
        sendgrid: this.other('SendGrid (email)', [{ name: 'API key', setting: 'notifications.sendgridApiKey', env: 'SENDGRID_API_KEY' }]),
        fcm: this.other('Firebase Cloud Messaging (push)', [{ name: 'Server key', setting: 'notifications.fcmServerKey', env: 'FCM_SERVER_KEY' }]),
        certn: this.other('Certn (background checks)', [{ name: 'API key', env: 'CERTN_API_KEY' }]),
      },
      note: 'Secrets are encrypted at rest and are never returned by this API; only whether they are set and their last 4 characters.',
    };
  }

  // ------------------------------------------------------------------ updates
  private assertSuper(req: any) {
    if (req?.user?.type !== 'SUPER_ADMIN') {
      void this.audit.logReq(req, 'security.settings_denied', 'integration', undefined, undefined, { area: 'integrations' });
      throw new ForbiddenException('Only a Super Admin can change integration keys');
    }
  }

  private async write(key: string, value: any) {
    const row = await this.repo.findOne({ where: { key } });
    if (!row) throw new NotFoundException(`Unknown setting ${key}`);
    row.value = row.isSecret ? sealSecret(value) : value;
    await this.repo.save(row);
  }

  async updateStripe(dto: { secretKey?: string | null; publishableKey?: string | null; webhookSecret?: string | null; connectEnabled?: boolean; currency?: string; platformCountry?: string }, req: any) {
    this.assertSuper(req);
    const before = this.stripe.config();
    const changed: string[] = [];
    const cleared: string[] = [];
    const set = async (field: string, key: string, v: any) => {
      if (v === undefined) return;
      if (v === null || v === '') {
        await this.write(key, '');
        cleared.push(field);
      } else {
        await this.write(key, v);
        changed.push(field);
      }
    };
    await set('secretKey', 'integrations.stripe.secretKey', dto.secretKey);
    await set('publishableKey', 'integrations.stripe.publishableKey', dto.publishableKey);
    await set('webhookSecret', 'integrations.stripe.webhookSecret', dto.webhookSecret);
    if (dto.connectEnabled !== undefined) {
      await this.write('integrations.stripe.connectEnabled', dto.connectEnabled);
      changed.push('connectEnabled');
    }
    if (dto.currency !== undefined) {
      await this.write('integrations.stripe.currency', dto.currency.toLowerCase());
      changed.push('currency');
    }
    if (dto.platformCountry !== undefined) {
      await this.write('integrations.stripe.platformCountry', dto.platformCountry.toUpperCase());
      changed.push('platformCountry');
    }
    await this.settings.reload();
    delete this.lastTests.stripe;
    const after = this.stripe.config();
    const modeChange = before.mode !== after.mode ? { from: before.mode, to: after.mode } : undefined;
    await this.audit.logReq(req, 'integrations.stripe.update', 'integration', 'stripe', undefined, { changed, cleared, ...(modeChange ? { modeChange } : {}) }); // values are never logged
    if (modeChange) this.logger.warn(`Stripe mode changed ${modeChange.from} -> ${modeChange.to} by ${req?.user?.email ?? 'admin'}`);
    return this.stripeStatus();
  }

  async updateMapbox(dto: { accessToken?: string | null; publicToken?: string | null; country?: string; bbox?: string; proximity?: string }, req: any) {
    this.assertSuper(req);
    const changed: string[] = [];
    const cleared: string[] = [];
    const set = async (field: string, key: string, v: any) => {
      if (v === undefined) return;
      if (v === null || v === '') {
        await this.write(key, '');
        cleared.push(field);
      } else {
        await this.write(key, v);
        changed.push(field);
      }
    };
    await set('accessToken', 'integrations.mapbox.accessToken', dto.accessToken);
    await set('publicToken', 'integrations.mapbox.publicToken', dto.publicToken);
    await set('country', 'integrations.mapbox.country', dto.country?.toLowerCase());
    if (dto.bbox !== undefined) {
      await this.write('integrations.mapbox.bbox', dto.bbox);
      changed.push('bbox');
    }
    if (dto.proximity !== undefined) {
      await this.write('integrations.mapbox.proximity', dto.proximity);
      changed.push('proximity');
    }
    await this.settings.reload();
    this.mapbox.clearCache();
    delete this.lastTests.mapbox;
    await this.audit.logReq(req, 'integrations.mapbox.update', 'integration', 'mapbox', undefined, { changed, cleared });
    return this.mapboxStatus();
  }

  // ------------------------------------------------------------------ test connection
  async test(name: string, req?: any): Promise<TestResult> {
    let res: TestResult;
    if (name === 'stripe') res = await this.testStripe();
    else if (name === 'mapbox') {
      const r = await this.mapbox.test();
      res = { checkedAt: new Date().toISOString(), ...r };
    } else throw new BadRequestException('Unknown integration');
    this.lastTests[name] = res;
    if (req) await this.audit.logReq(req, `integrations.${name}.test`, 'integration', name, undefined, { ok: res.ok });
    return res;
  }

  private stripeReason(e: any): string {
    const t = e?.type ?? e?.rawType;
    const code = e?.code ?? e?.raw?.code;
    if (t === 'StripeAuthenticationError' || code === 'api_key_expired' || e?.statusCode === 401) return 'Stripe rejected the secret key (it is invalid, expired or revoked). Copy it again from the Stripe dashboard (Developers > API keys).';
    if (t === 'StripePermissionError') return 'The key is valid but a restricted key lacks a permission needed for this check: ' + String(e?.message ?? '').replace(/sk_[A-Za-z0-9_]+|rk_[A-Za-z0-9_]+/g, '[key]').slice(0, 200);
    if (t === 'StripeConnectionError') return 'Could not reach Stripe (network error): ' + String(e?.message ?? '').replace(/sk_[A-Za-z0-9_]+|rk_[A-Za-z0-9_]+/g, '[key]').slice(0, 160);
    return String(e?.message ?? 'Stripe request failed').replace(/sk_[A-Za-z0-9_]+|rk_[A-Za-z0-9_]+/g, '[key]').slice(0, 240);
  }

  private async testStripe(): Promise<TestResult> {
    const checkedAt = new Date().toISOString();
    const cfg = this.stripe.config();
    if (!cfg.secretKey) return { ok: false, checkedAt, reason: this.stripe.mockAllowed() ? 'No Stripe secret key is configured (mock payments are active for development)' : 'No Stripe secret key is configured' };
    const stripe = this.stripe.client();
    const out: TestResult = { ok: false, checkedAt, mode: cfg.mode, livemode: cfg.mode === 'live' };
    try {
      const balance = await stripe.balance.retrieve();
      out.livemode = !!balance.livemode;
      out.mode = balance.livemode ? 'live' : 'test';
      out.balanceCurrencies = (balance.available ?? []).map((b: any) => b.currency);
    } catch (e: any) {
      out.reason = this.stripeReason(e);
      return out;
    }
    // the platform account (own account: no id)
    try {
      const acct = await stripe.accounts.retrieve();
      out.accountId = acct.id;
      out.country = acct.country;
      out.chargesEnabled = !!acct.charges_enabled;
      out.payoutsEnabled = !!acct.payouts_enabled;
      out.defaultCurrency = acct.default_currency;
      out.businessName = acct.business_profile?.name ?? acct.settings?.dashboard?.display_name ?? null;
    } catch (e: any) {
      out.accountError = this.stripeReason(e);
    }
    // Connect: can this platform create / list connected accounts?
    try {
      await stripe.accounts.list({ limit: 1 });
      out.connect = { enabled: true };
    } catch (e: any) {
      out.connect = { enabled: false, reason: this.stripeReason(e) };
    }
    // webhook endpoint registered for OUR url?
    try {
      const list = await stripe.webhookEndpoints.list({ limit: 100 });
      const mine = (list.data ?? []).find((w: any) => w.url === this.webhookUrl());
      if (!mine) out.webhook = { checked: true, registered: false, url: this.webhookUrl(), reason: 'No webhook endpoint with this URL is registered in Stripe' };
      else {
        const enabled: string[] = mine.enabled_events ?? [];
        const missing = enabled.includes('*') ? [] : STRIPE_WEBHOOK_EVENTS.filter((e) => !enabled.includes(e));
        out.webhook = { checked: true, registered: true, status: mine.status, url: mine.url, missingEvents: missing };
      }
    } catch (e: any) {
      out.webhook = { checked: false, reason: this.stripeReason(e) };
    }
    const pkMode = modeOfKey(cfg.publishableKey);
    out.publishableKeyMatches = cfg.publishableKey ? pkMode === out.mode : null;
    out.webhookSecretSet = !!cfg.webhookSecret;
    out.ok = true;
    const problems: string[] = [];
    if (cfg.publishableKey && pkMode !== out.mode) problems.push('the publishable key is from a different mode than the secret key');
    if (!cfg.publishableKey) problems.push('the publishable key is missing');
    if (!cfg.webhookSecret) problems.push('the webhook signing secret is missing');
    if (out.webhook?.registered === false) problems.push('the webhook endpoint is not registered in Stripe');
    if (out.webhook?.registered && out.webhook.status !== 'enabled') problems.push('the webhook endpoint is disabled in Stripe');
    if (out.webhook?.missingEvents?.length) problems.push(`the webhook endpoint is not subscribed to: ${out.webhook.missingEvents.join(', ')}`);
    if (out.connect && out.connect.enabled === false) problems.push('Stripe Connect is not enabled on this account');
    if (problems.length) out.warnings = problems;
    return out;
  }
}
