import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DriverProfile, Merchant, User } from '../database/entities';
import { PartyType } from '../common/enums';
import { StripeClientService } from '../integrations/stripe-client.service';
import { PayoutsService } from '../finance/payouts.service';
import { PartiesService } from '../finance/parties.service';

export type ConnectStatus = 'NOT_STARTED' | 'PENDING' | 'RESTRICTED' | 'ENABLED';

export interface ConnectView {
  status: ConnectStatus;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  requirementsDue: string[];
  bankLast4: string | null;
  /** payouts go through Stripe Connect on this platform right now */
  connectRequired: boolean;
  disabledReason: string | null;
  syncedAt: string | null;
  /** short human text for the app / portal */
  message: string;
}

/** Plain-language names for the most common Stripe requirement codes (the rest are shown as the code). */
const REQ_LABEL: Record<string, string> = {
  external_account: 'Bank account or debit card',
  'business_profile.url': 'Business website',
  'business_profile.mcc': 'Business category',
  'tos_acceptance.date': 'Accept the Stripe terms',
  'tos_acceptance.ip': 'Accept the Stripe terms',
  'individual.first_name': 'Legal first name',
  'individual.last_name': 'Legal last name',
  'individual.dob.day': 'Date of birth',
  'individual.dob.month': 'Date of birth',
  'individual.dob.year': 'Date of birth',
  'individual.address.line1': 'Home address',
  'individual.address.city': 'Home address',
  'individual.address.postal_code': 'Home address',
  'individual.address.state': 'Home address',
  'individual.id_number': 'Government ID number',
  'individual.verification.document': 'Photo ID',
  'company.name': 'Company legal name',
  'company.tax_id': 'Business number',
  'company.address.line1': 'Business address',
  'company.phone': 'Business phone',
  'representative.first_name': 'Representative name',
  'representative.dob.day': 'Representative date of birth',
};
export const requirementLabel = (code: string) => REQ_LABEL[code] ?? code;

/**
 * Stripe Connect (Express accounts, "separate charges and transfers"): onboarding links, status sync, Express dashboard login links.
 * The Stripe account is the payout account: identity checks and bank details live at Stripe, FORKY stores only the account id,
 * the status and a few non-sensitive facts (bank last 4, requirements due).
 */
@Injectable()
export class ConnectService {
  private readonly logger = new Logger('Connect');

  constructor(
    @InjectRepository(Merchant) private merchants: Repository<Merchant>,
    @InjectRepository(DriverProfile) private drivers: Repository<DriverProfile>,
    @InjectRepository(User) private users: Repository<User>,
    private stripeClient: StripeClientService,
    private config: ConfigService,
    private payouts: PayoutsService,
    private parties: PartiesService,
  ) {}

  private repo(t: PartyType): Repository<any> {
    if (t === PartyType.RESTAURANT) return this.merchants;
    if (t === PartyType.DRIVER) return this.drivers;
    throw new BadRequestException('partyType must be RESTAURANT or DRIVER');
  }

  private stripe(): any {
    const cfg = this.stripeClient.config();
    if (!cfg.secretKey) throw new ServiceUnavailableException('Payout accounts are not available yet: Stripe is not configured.');
    if (!cfg.connectEnabled) throw new ServiceUnavailableException('Stripe Connect payouts are switched off by an administrator.');
    return this.stripeClient.client();
  }

  private webUrl(): string {
    return String(this.config.get('webUrl') ?? 'http://localhost:3000').replace(/\/+$/, '');
  }

  // ------------------------------------------------------------------ status mapping
  static statusOf(acct: any | null): { status: ConnectStatus; view: Omit<ConnectView, 'connectRequired' | 'message' | 'syncedAt'> } {
    if (!acct) return { status: 'NOT_STARTED', view: { status: 'NOT_STARTED', payoutsEnabled: false, detailsSubmitted: false, requirementsDue: [], bankLast4: null, disabledReason: null } };
    const due: string[] = [...new Set<string>([...(acct.requirements?.currently_due ?? []), ...(acct.requirements?.past_due ?? [])])];
    const disabled: string | null = acct.requirements?.disabled_reason ?? null;
    const transfers = acct.capabilities?.transfers;
    const payoutsEnabled = !!acct.payouts_enabled;
    const detailsSubmitted = !!acct.details_submitted;
    const bank = (acct.external_accounts?.data ?? [])[0];
    let status: ConnectStatus;
    const rejected = !!disabled && /^rejected|\.fraud|\.listed|\.terms_of_service/.test(disabled);
    if (detailsSubmitted && payoutsEnabled && transfers !== 'inactive' && transfers !== 'pending' && due.length === 0 && !disabled) status = 'ENABLED';
    else if (rejected || (detailsSubmitted && (acct.requirements?.past_due?.length || transfers === 'inactive' || (disabled && !/^requirements\.pending_verification|under_review/.test(disabled))))) status = 'RESTRICTED';
    else status = 'PENDING';
    return { status, view: { status, payoutsEnabled, detailsSubmitted, requirementsDue: due, bankLast4: bank?.last4 ?? null, disabledReason: disabled } };
  }

  private message(status: ConnectStatus, due: string[], required: boolean): string {
    if (!required) return 'Payouts are not processed through Stripe on this platform right now.';
    switch (status) {
      case 'NOT_STARTED':
        return 'Set up your payout account to get paid. It takes about 5 minutes: Stripe checks your identity and collects your bank details.';
      case 'ENABLED':
        return 'Your payout account is ready. Payouts are sent automatically.';
      case 'RESTRICTED':
        return 'Stripe needs more information before it can pay you' + (due.length ? `: ${[...new Set(due.map(requirementLabel))].slice(0, 4).join(', ')}.` : '.');
      default:
        return due.length ? `Almost done. Still needed: ${[...new Set(due.map(requirementLabel))].slice(0, 4).join(', ')}.` : 'Stripe is verifying your details. This usually takes a few minutes.';
    }
  }

  private connectRequired(): boolean {
    const c = this.stripeClient.config();
    return !!c.secretKey && c.connectEnabled;
  }

  async view(partyType: PartyType, partyId: string, opts: { sync?: boolean } = {}): Promise<ConnectView & { accountId?: string | null }> {
    let row: any = await this.repo(partyType).findOne({ where: { id: partyId } });
    if (!row) throw new NotFoundException('Party not found');
    if (opts.sync && row.stripeAccountId && this.stripeClient.client()) row = await this.syncFromStripe(partyType, partyId).then(() => this.repo(partyType).findOne({ where: { id: partyId } }));
    const info = row.stripeAccountInfo ?? {};
    const status: ConnectStatus = (row.stripeAccountStatus as ConnectStatus) ?? 'NOT_STARTED';
    const due: string[] = info.requirementsDue ?? [];
    const required = this.connectRequired();
    return {
      status,
      payoutsEnabled: !!info.payoutsEnabled,
      detailsSubmitted: !!info.detailsSubmitted,
      requirementsDue: due.map(requirementLabel).filter((v, i, a) => a.indexOf(v) === i),
      bankLast4: info.bankLast4 ?? null,
      connectRequired: required,
      disabledReason: info.disabledReason ?? null,
      syncedAt: info.syncedAt ?? null,
      message: this.message(status, due, required),
    };
  }

  // ------------------------------------------------------------------ account + onboarding
  async ensureAccount(partyType: PartyType, partyId: string, user?: { id: string }): Promise<string> {
    const stripe = this.stripe();
    const cfg = this.stripeClient.config();
    const row: any = await this.repo(partyType).findOne({ where: { id: partyId } });
    if (!row) throw new NotFoundException('Party not found');
    if (row.stripeAccountId) return row.stripeAccountId;
    const base: any = {
      type: 'express',
      country: cfg.platformCountry,
      capabilities: { transfers: { requested: true } },
      metadata: { partyType, partyId, platform: 'forky' },
    };
    if (partyType === PartyType.DRIVER) {
      const u = await this.users.findOne({ where: { id: row.userId } });
      Object.assign(base, {
        business_type: 'individual',
        email: u?.email ?? undefined,
        individual: { first_name: u?.firstName || undefined, last_name: u?.lastName || undefined, email: u?.email ?? undefined },
        business_profile: { product_description: 'Delivery driver on the FORKY marketplace' },
      });
    } else {
      Object.assign(base, {
        business_type: 'company',
        email: row.contactEmail ?? undefined,
        company: { name: row.legalName || row.businessName },
        business_profile: { name: row.businessName, product_description: 'Restaurant / store on the FORKY marketplace' },
      });
    }
    const acct = await stripe.accounts.create(base, { idempotencyKey: `acct-${partyType}-${partyId}` });
    // another request may have created the same account (same idempotency key => same id); save only if still empty
    await this.repo(partyType)
      .createQueryBuilder()
      .update()
      .set({ stripeAccountId: acct.id })
      .where('id = :id AND "stripeAccountId" IS NULL', { id: partyId })
      .execute();
    await this.applyAccount(partyType, partyId, acct);
    this.logger.log(`Created Stripe Express account for ${partyType} ${partyId}`);
    return acct.id;
  }

  /** The Stripe-hosted onboarding link (account_onboarding). Express accounts that are already ENABLED get the dashboard login link instead. */
  async onboardingLink(partyType: PartyType, partyId: string, kind: 'driver' | 'restaurant'): Promise<{ url: string; kind: 'onboarding' | 'dashboard'; expiresAt: string | null; status: ConnectStatus }> {
    const stripe = this.stripe();
    const accountId = await this.ensureAccount(partyType, partyId);
    const v = await this.syncFromStripe(partyType, partyId);
    if (v.status === 'ENABLED') {
      const d = await this.dashboardLink(partyType, partyId);
      return { url: d.url, kind: 'dashboard', expiresAt: null, status: v.status };
    }
    const web = this.webUrl();
    const ret = kind === 'driver' ? `${web}/order/payouts/return?status=complete&for=driver` : `${web}/portal/finance?stripe=return`;
    const refresh = kind === 'driver' ? `${web}/order/payouts/return?status=refresh&for=driver` : `${web}/portal/finance?stripe=refresh`;
    const link = await stripe.accountLinks.create({ account: accountId, type: 'account_onboarding', return_url: ret, refresh_url: refresh });
    return { url: link.url, kind: 'onboarding', expiresAt: link.expires_at ? new Date(link.expires_at * 1000).toISOString() : null, status: v.status };
  }

  async dashboardLink(partyType: PartyType, partyId: string): Promise<{ url: string }> {
    const stripe = this.stripe();
    const row: any = await this.repo(partyType).findOne({ where: { id: partyId } });
    if (!row?.stripeAccountId) throw new ConflictException('Set up your payout account first');
    try {
      const link = await stripe.accounts.createLoginLink(row.stripeAccountId);
      return { url: link.url };
    } catch (e: any) {
      // Express dashboard only exists once onboarding was submitted
      throw new ConflictException('The Stripe dashboard is available after you finished the payout account setup.');
    }
  }

  // ------------------------------------------------------------------ sync
  /** Retrieve the account from Stripe and store its state on the party. Returns the new view. */
  async syncFromStripe(partyType: PartyType, partyId: string): Promise<ConnectView> {
    const row: any = await this.repo(partyType).findOne({ where: { id: partyId } });
    if (!row) throw new NotFoundException('Party not found');
    if (!row.stripeAccountId) return this.view(partyType, partyId);
    const stripe = this.stripe();
    const acct = await stripe.accounts.retrieve(row.stripeAccountId);
    await this.applyAccount(partyType, partyId, acct);
    return this.view(partyType, partyId);
  }

  /** Store an account object (from retrieve or the account.updated webhook). Becoming ENABLED sends the payouts that were waiting. */
  async applyAccount(partyType: PartyType, partyId: string, acct: any): Promise<ConnectStatus> {
    const row: any = await this.repo(partyType).findOne({ where: { id: partyId } });
    if (!row) throw new NotFoundException('Party not found');
    const { status, view } = ConnectService.statusOf(acct);
    const prev: ConnectStatus = (row.stripeAccountStatus as ConnectStatus) ?? 'NOT_STARTED';
    const prevInfo = row.stripeAccountInfo ?? {};
    await this.repo(partyType).update(partyId, {
      stripeAccountStatus: status,
      stripeAccountInfo: {
        ...prevInfo,
        payoutsEnabled: view.payoutsEnabled,
        detailsSubmitted: view.detailsSubmitted,
        chargesEnabled: !!acct.charges_enabled,
        requirementsDue: view.requirementsDue,
        disabledReason: view.disabledReason,
        bankLast4: view.bankLast4 ?? prevInfo.bankLast4 ?? null,
        capabilities: acct.capabilities ?? {},
        country: acct.country ?? null,
        syncedAt: new Date().toISOString(),
      },
    });
    if (status === 'ENABLED' && prev !== 'ENABLED') {
      this.payouts.onAccountReady(partyType, partyId).catch((e) => this.logger.warn(`could not send waiting payouts for ${partyType} ${partyId}: ${e.message}`));
    }
    return status;
  }

  /** account.updated webhook: the event carries the whole account. Unknown accounts are ignored. */
  async applyAccountEvent(acct: any): Promise<boolean> {
    const party = await this.payouts.findPartyByAccount(acct.id);
    if (!party) return false;
    await this.applyAccount(party.type, party.id, acct);
    return true;
  }

  /** Admin: sync every party that has a Stripe account (or one party). */
  async syncAll(): Promise<{ synced: number; failed: number }> {
    let synced = 0;
    let failed = 0;
    for (const t of [PartyType.RESTAURANT, PartyType.DRIVER]) {
      const rows: any[] = await this.repo(t).createQueryBuilder('p').select('p.id', 'id').where('p."stripeAccountId" IS NOT NULL').getRawMany();
      for (const r of rows) {
        try {
          await this.syncFromStripe(t, r.id);
          synced++;
        } catch (e: any) {
          failed++;
          this.logger.warn(`sync ${t} ${r.id}: ${e.message}`);
        }
      }
    }
    return { synced, failed };
  }

  /** Admin list of payout accounts for the "Payout accounts" filter. */
  async list(q: { partyType?: string; status?: string; search?: string; page?: number; limit?: number }) {
    const page = Math.max(1, Number(q.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(q.limit) || 25));
    const out: any[] = [];
    const types = q.partyType === 'DRIVER' ? [PartyType.DRIVER] : q.partyType === 'RESTAURANT' ? [PartyType.RESTAURANT] : [PartyType.RESTAURANT, PartyType.DRIVER];
    for (const t of types) {
      if (t === PartyType.RESTAURANT) {
        const qb = this.merchants.createQueryBuilder('m').select(['m.id', 'm.businessName', 'm.stripeAccountId', 'm.stripeAccountStatus', 'm.stripeAccountInfo', 'm.payoutHold']);
        if (q.status) qb.andWhere('m.stripeAccountStatus = :st', { st: q.status });
        if (q.search) qb.andWhere('m.businessName ILIKE :s', { s: `%${q.search}%` });
        for (const m of await qb.getMany()) out.push({ partyType: 'RESTAURANT', partyId: m.id, name: m.businessName, status: m.stripeAccountStatus, hasAccount: !!m.stripeAccountId, payoutsEnabled: !!m.stripeAccountInfo?.payoutsEnabled, requirementsDue: m.stripeAccountInfo?.requirementsDue ?? [], bankLast4: m.stripeAccountInfo?.bankLast4 ?? null, syncedAt: m.stripeAccountInfo?.syncedAt ?? null, hold: m.payoutHold });
      } else {
        const qb = this.drivers.createQueryBuilder('d').leftJoinAndSelect('d.user', 'u');
        if (q.status) qb.andWhere('d.stripeAccountStatus = :st', { st: q.status });
        if (q.search) qb.andWhere("(u.firstName || ' ' || u.lastName) ILIKE :s", { s: `%${q.search}%` });
        for (const d of await qb.getMany()) out.push({ partyType: 'DRIVER', partyId: d.id, name: d.user ? `${d.user.firstName} ${d.user.lastName}`.trim() : d.id, status: d.stripeAccountStatus, hasAccount: !!d.stripeAccountId, payoutsEnabled: !!d.stripeAccountInfo?.payoutsEnabled, requirementsDue: d.stripeAccountInfo?.requirementsDue ?? [], bankLast4: d.stripeAccountInfo?.bankLast4 ?? null, syncedAt: d.stripeAccountInfo?.syncedAt ?? null, hold: !!d.meta?.payoutHold });
      }
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    const counts = out.reduce((acc: Record<string, number>, r) => ((acc[r.status] = (acc[r.status] ?? 0) + 1), acc), {});
    return { data: out.slice((page - 1) * limit, page * limit), meta: { page, limit, total: out.length, totalPages: Math.max(1, Math.ceil(out.length / limit)) }, counts, connectRequired: this.connectRequired() };
  }

  async partyName(partyType: PartyType, partyId: string): Promise<string> {
    return (await this.parties.info(partyType, partyId)).name;
  }
}
