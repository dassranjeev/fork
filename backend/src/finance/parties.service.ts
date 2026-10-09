import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomInt } from 'crypto';
import { DriverProfile, Merchant, Restaurant, RestaurantMember, User } from '../database/entities';
import { PartyType, RestaurantRole } from '../common/enums';
import { NotificationsService } from '../notifications/notifications.service';
import { StripeClientService } from '../integrations/stripe-client.service';
import { maskAccount, r2 } from './finance.util';

export interface PartyInfo {
  partyType: PartyType;
  partyId: string;
  name: string;
  bankOk: boolean;
  bankVerified: boolean;
  bankMasked: string | null;
  hold: boolean;
  holdReason: string | null;
  stripeAccountId: string | null;
  schedule: string;
  /** Stripe Connect payout account: NOT_STARTED | PENDING | RESTRICTED | ENABLED */
  connectStatus: string;
  connectInfo: Record<string, any> | null;
  /** payouts go through Stripe Connect (Stripe key configured and Connect switched on) */
  connectRequired: boolean;
  /** the party can be paid right now (Connect ENABLED when required, otherwise the legacy verified bank) */
  payoutReady: boolean;
}

@Injectable()
export class PartiesService {
  constructor(
    @InjectRepository(Merchant) private merchants: Repository<Merchant>,
    @InjectRepository(Restaurant) private restaurants: Repository<Restaurant>,
    @InjectRepository(DriverProfile) private drivers: Repository<DriverProfile>,
    @InjectRepository(RestaurantMember) private members: Repository<RestaurantMember>,
    @InjectRepository(User) private users: Repository<User>,
    private notifications: NotificationsService,
    private stripeClient: StripeClientService,
  ) {}

  /** Real payouts need a connected Stripe account in ENABLED state; the legacy bank check only applies to the dev mock. */
  private connectRequired(): boolean {
    const c = this.stripeClient.config();
    return !!c.secretKey && c.connectEnabled;
  }

  async info(partyType: PartyType, partyId: string): Promise<PartyInfo> {
    if (partyType === PartyType.RESTAURANT) {
      const m = await this.merchants.findOne({ where: { id: partyId } });
      if (!m) throw new NotFoundException('Merchant not found');
      const locs = await this.restaurants.find({ where: { merchantId: partyId }, select: ['id', 'payoutSchedule'] });
      const verified = !!m.bank?.verified;
      const req = this.connectRequired();
      const ready = req ? m.stripeAccountStatus === 'ENABLED' : verified;
      return {
        partyType,
        partyId,
        name: m.businessName,
        bankOk: ready,
        bankVerified: verified,
        bankMasked: maskAccount(m.bank?.accountLast4 ?? m.stripeAccountInfo?.bankLast4),
        hold: !!m.payoutHold,
        holdReason: m.payoutHoldReason,
        stripeAccountId: m.stripeAccountId,
        schedule: locs.some((l) => l.payoutSchedule === 'DAILY') ? 'DAILY' : 'WEEKLY',
        connectStatus: m.stripeAccountStatus ?? 'NOT_STARTED',
        connectInfo: m.stripeAccountInfo ?? null,
        connectRequired: req,
        payoutReady: ready,
      };
    }
    if (partyType === PartyType.DRIVER) {
      const d = await this.drivers.findOne({ where: { id: partyId }, relations: ['user'] });
      if (!d) throw new NotFoundException('Driver not found');
      const hasBank = !!(d.bank?.accountLast4 || d.bank?.debitCardLast4);
      const hold = d.meta?.payoutHold as { reason?: string } | undefined;
      const req = this.connectRequired();
      const bankVerified = hasBank && d.meta?.bankVerification?.status !== 'PENDING';
      const ready = req ? d.stripeAccountStatus === 'ENABLED' : hasBank;
      return {
        partyType,
        partyId,
        name: d.user ? `${d.user.firstName} ${d.user.lastName}`.trim() : partyId,
        bankOk: ready,
        bankVerified,
        bankMasked: maskAccount(d.bank?.accountLast4 ?? d.bank?.debitCardLast4 ?? d.stripeAccountInfo?.bankLast4),
        hold: !!hold,
        holdReason: hold?.reason ?? null,
        stripeAccountId: d.stripeAccountId,
        schedule: d.payoutSchedule,
        connectStatus: d.stripeAccountStatus ?? 'NOT_STARTED',
        connectInfo: d.stripeAccountInfo ?? null,
        connectRequired: req,
        payoutReady: ready,
      };
    }
    throw new BadRequestException('partyType must be RESTAURANT or DRIVER');
  }

  /** Bulk names for ledger/payout views. */
  async names(partyType: PartyType, ids: string[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const uniq = [...new Set(ids.filter(Boolean))];
    if (!uniq.length) return out;
    if (partyType === PartyType.RESTAURANT) {
      const rows = await this.merchants.createQueryBuilder('m').select(['m.id', 'm.businessName']).where('m.id IN (:...ids)', { ids: uniq }).getMany();
      rows.forEach((r) => (out[r.id] = r.businessName));
    } else if (partyType === PartyType.DRIVER) {
      const rows = await this.drivers.createQueryBuilder('d').leftJoinAndSelect('d.user', 'u').where('d.id IN (:...ids)', { ids: uniq }).getMany();
      rows.forEach((r) => (out[r.id] = r.user ? `${r.user.firstName} ${r.user.lastName}`.trim() : r.id));
    }
    return out;
  }

  // ------------------------------------------------------------ hold
  async setHold(partyType: PartyType, partyId: string, hold: boolean, reason?: string) {
    if (partyType === PartyType.RESTAURANT) {
      const m = await this.merchants.findOne({ where: { id: partyId } });
      if (!m) throw new NotFoundException('Merchant not found');
      m.payoutHold = hold;
      m.payoutHoldReason = hold ? reason ?? 'Manual hold' : null;
      await this.merchants.save(m);
    } else if (partyType === PartyType.DRIVER) {
      const d = await this.drivers.findOne({ where: { id: partyId } });
      if (!d) throw new NotFoundException('Driver not found');
      const meta = { ...(d.meta ?? {}) };
      if (hold) meta.payoutHold = { reason: reason ?? 'Manual hold', at: new Date().toISOString() };
      else delete meta.payoutHold;
      d.meta = meta;
      await this.drivers.save(d);
    } else throw new BadRequestException('partyType must be RESTAURANT or DRIVER');
    return this.info(partyType, partyId);
  }

  // ------------------------------------------------------------ bank details & micro-deposit verification (SOP-01 step 5)
  async updateBank(partyType: PartyType, partyId: string, dto: { institution?: string; transit?: string; accountNumber?: string; holder?: string; debitCardLast4?: string }) {
    const last4 = dto.accountNumber ? String(dto.accountNumber).replace(/\D/g, '').slice(-4) : undefined;
    if (dto.accountNumber && String(dto.accountNumber).replace(/\D/g, '').length < 5) throw new BadRequestException('Account number is too short');
    if (partyType === PartyType.RESTAURANT) {
      const m = await this.merchants.findOne({ where: { id: partyId } });
      if (!m) throw new NotFoundException('Merchant not found');
      m.bank = {
        institution: dto.institution ?? m.bank?.institution,
        transit: dto.transit ?? m.bank?.transit,
        accountLast4: last4 ?? m.bank?.accountLast4,
        holder: dto.holder ?? m.bank?.holder,
        verified: false, // any change requires a new micro-deposit check
      };
      m.bankVerification = null;
      await this.merchants.save(m);
    } else if (partyType === PartyType.DRIVER) {
      const d = await this.drivers.findOne({ where: { id: partyId } });
      if (!d) throw new NotFoundException('Driver not found');
      d.bank = {
        ...(d.bank ?? {}),
        ...(dto.institution ? { institution: dto.institution } : {}),
        ...(dto.transit ? { transit: dto.transit } : {}),
        ...(last4 ? { accountLast4: last4 } : {}),
        ...(dto.holder ? { holder: dto.holder } : {}),
        ...(dto.debitCardLast4 ? { debitCardLast4: String(dto.debitCardLast4).slice(-4) } : {}),
      };
      await this.drivers.save(d);
    } else throw new BadRequestException('partyType must be RESTAURANT or DRIVER');
    return this.bankView(partyType, partyId);
  }

  async bankView(partyType: PartyType, partyId: string) {
    const i = await this.info(partyType, partyId);
    let verification: any = null;
    let bank: any = null;
    if (partyType === PartyType.RESTAURANT) {
      const m = await this.merchants.findOneOrFail({ where: { id: partyId } });
      bank = m.bank;
      verification = m.bankVerification;
    } else {
      const d = await this.drivers.findOneOrFail({ where: { id: partyId } });
      bank = d.bank;
      verification = d.meta?.bankVerification ?? null;
    }
    return {
      partyType,
      partyId,
      name: i.name,
      bank: bank ? { institution: bank.institution ?? null, transit: bank.transit ?? null, account: maskAccount(bank.accountLast4), holder: bank.holder ?? null, debitCard: maskAccount(bank.debitCardLast4) } : null,
      verified: i.bankVerified,
      payoutAccount: { required: i.connectRequired, status: i.connectStatus, ready: i.payoutReady, hasAccount: !!i.stripeAccountId, payoutsEnabled: !!i.connectInfo?.payoutsEnabled, requirementsDue: i.connectInfo?.requirementsDue ?? [], bankLast4: i.connectInfo?.bankLast4 ?? null, syncedAt: i.connectInfo?.syncedAt ?? null },
      verification: verification ? { status: verification.status, initiatedAt: verification.initiatedAt ?? null, verifiedAt: verification.verifiedAt ?? null, attempts: verification.attempts ?? 0 } : null,
    };
  }

  /** Mock micro-deposit: two random amounts (cents) are "deposited"; the owner reads them from their bank statement. */
  async initiateVerification(partyType: PartyType, partyId: string) {
    const amounts = [r2(randomInt(1, 100) / 100), r2(randomInt(1, 100) / 100)];
    const v = { status: 'PENDING' as const, amounts, initiatedAt: new Date().toISOString(), attempts: 0 };
    if (partyType === PartyType.RESTAURANT) {
      const m = await this.merchants.findOne({ where: { id: partyId } });
      if (!m) throw new NotFoundException('Merchant not found');
      if (!m.bank?.accountLast4) throw new BadRequestException('No bank details on file');
      m.bankVerification = v;
      m.bank = { ...m.bank, verified: false };
      await this.merchants.save(m);
    } else if (partyType === PartyType.DRIVER) {
      const d = await this.drivers.findOne({ where: { id: partyId } });
      if (!d) throw new NotFoundException('Driver not found');
      if (!d.bank?.accountLast4) throw new BadRequestException('No bank account on file');
      d.meta = { ...(d.meta ?? {}), bankVerification: v };
      await this.drivers.save(d);
    } else throw new BadRequestException('partyType must be RESTAURANT or DRIVER');
    const view = await this.bankView(partyType, partyId);
    // Mock mode only: expose the amounts so QA can complete the flow (never in production).
    return process.env.NODE_ENV === 'production' ? view : { ...view, mockAmounts: amounts };
  }

  async confirmVerification(partyType: PartyType, partyId: string, amounts: number[]) {
    if (!Array.isArray(amounts) || amounts.length !== 2) throw new BadRequestException('Provide the two micro-deposit amounts');
    const check = (v?: { status: string; amounts?: number[]; attempts?: number } | null) => {
      if (!v || v.status !== 'PENDING' || !v.amounts) throw new BadRequestException('No micro-deposit verification is pending');
      if ((v.attempts ?? 0) >= 3) throw new BadRequestException('Too many attempts. Start a new verification.');
      const want = [...v.amounts].sort((a, b) => a - b);
      const got = amounts.map((a) => r2(Number(a))).sort((a, b) => a - b);
      return want[0] === got[0] && want[1] === got[1];
    };
    let ok = false;
    if (partyType === PartyType.RESTAURANT) {
      const m = await this.merchants.findOne({ where: { id: partyId } });
      if (!m) throw new NotFoundException('Merchant not found');
      ok = check(m.bankVerification);
      m.bankVerification = { ...m.bankVerification!, attempts: (m.bankVerification!.attempts ?? 0) + 1, status: ok ? 'VERIFIED' : 'PENDING', ...(ok ? { verifiedAt: new Date().toISOString(), amounts: undefined } : {}) };
      if (ok) m.bank = { ...(m.bank ?? {}), verified: true };
      await this.merchants.save(m);
    } else if (partyType === PartyType.DRIVER) {
      const d = await this.drivers.findOne({ where: { id: partyId } });
      if (!d) throw new NotFoundException('Driver not found');
      const v = d.meta?.bankVerification;
      ok = check(v);
      d.meta = { ...(d.meta ?? {}), bankVerification: { ...v, attempts: (v.attempts ?? 0) + 1, status: ok ? 'VERIFIED' : 'PENDING', ...(ok ? { verifiedAt: new Date().toISOString(), amounts: undefined } : {}) } };
      await this.drivers.save(d);
    } else throw new BadRequestException('partyType must be RESTAURANT or DRIVER');
    if (!ok) throw new BadRequestException('Amounts do not match');
    return this.bankView(partyType, partyId);
  }

  // ------------------------------------------------------------ notifications
  async notifyParty(partyType: PartyType, partyId: string, event: string, vars: Record<string, any>, data: Record<string, any>) {
    if (partyType === PartyType.RESTAURANT) {
      const ms = await this.members.find({ where: { merchantId: partyId, role: RestaurantRole.OWNER, active: true } });
      const ids = [...new Set(ms.map((m) => m.userId))];
      await Promise.all(ids.map((userId) => this.notifications.notify({ userId, audience: 'RESTAURANT', event, vars, data })));
    } else if (partyType === PartyType.DRIVER) {
      const d = await this.drivers.findOne({ where: { id: partyId }, select: ['id', 'userId'] });
      if (d) await this.notifications.notify({ userId: d.userId, audience: 'DRIVER', event, vars, data });
    }
  }
}
