import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'crypto';
import { DataSource, Repository } from 'typeorm';
import { GiftCard } from '../database/entities';
import { IGiftCardsService } from '../common/contracts';
import { NotificationsService } from '../notifications/notifications.service';
import { PageQueryDto, paginateQb, like } from '../common/pagination';
import { WalletAccess } from './wallet-access';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export function normalizeGiftCode(code: string) {
  return code.replace(/[\s]/g, '').toUpperCase();
}

@Injectable()
export class GiftCardsService implements IGiftCardsService {
  private readonly logger = new Logger(GiftCardsService.name);

  constructor(
    @InjectRepository(GiftCard) private cards: Repository<GiftCard>,
    private ds: DataSource,
    private wallet: WalletAccess,
    private notifications: NotificationsService,
  ) {}

  generateCode(): string {
    const bytes = randomBytes(12);
    const chars = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
    return `FKGC-${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
  }

  // ------------------------------------------------------------------ redeem (customer)
  async redeem(customerId: string, code: string): Promise<{ amount: number; balance: number }> {
    const normalized = normalizeGiftCode(code ?? '');
    if (!normalized) throw new BadRequestException('Enter a gift card code.');

    // Atomically zero the card's balance under a row lock, then credit the wallet.
    const amount = await this.ds.transaction(async (m) => {
      const card = await m
        .createQueryBuilder(GiftCard, 'g')
        .setLock('pessimistic_write')
        .where('upper(replace(g.code, \'-\', \'\')) = :c OR upper(g.code) = :c2', { c: normalized.replace(/-/g, ''), c2: normalized })
        .getOne();
      if (!card) throw new BadRequestException("We couldn't find that gift card. Check the code and try again.");
      if (!card.active) throw new BadRequestException('This gift card is no longer active.');
      if (card.expiresAt && card.expiresAt < new Date()) throw new BadRequestException('This gift card has expired.');
      if (card.balance <= 0) throw new BadRequestException('This gift card has already been redeemed.');
      const value = card.balance;
      await m.update(GiftCard, { id: card.id }, { balance: 0, redeemedById: customerId });
      return { id: card.id, value };
    });

    try {
      const balance = await this.wallet.get().credit(customerId, amount.value, 'GIFT_CARD', { note: 'Gift card redeemed' });
      return { amount: amount.value, balance };
    } catch (e: any) {
      // restore the card so the customer can retry
      await this.cards.update({ id: amount.id }, { balance: amount.value, redeemedById: null });
      this.logger.error(`gift card credit failed: ${e.message}`);
      throw new BadRequestException('We could not add the gift card to your wallet. Please try again.');
    }
  }

  // ------------------------------------------------------------------ admin
  async issue(input: { amount: number; count?: number; expiresAt?: Date | null; recipientEmail?: string | null; message?: string; issuedById?: string | null }) {
    const count = Math.min(Math.max(input.count ?? 1, 1), 500);
    if (!(input.amount > 0)) throw new BadRequestException('Amount must be greater than 0');
    if (input.recipientEmail && count > 1) throw new BadRequestException('recipientEmail can only be used when issuing a single card');
    const created: GiftCard[] = [];
    for (let i = 0; i < count; i++) {
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          created.push(
            await this.cards.save(
              this.cards.create({
                code: this.generateCode(),
                initialAmount: r2(input.amount),
                balance: r2(input.amount),
                expiresAt: input.expiresAt ?? null,
                purchasedById: input.issuedById ?? null,
                recipientEmail: input.recipientEmail ?? null,
                active: true,
              }),
            ),
          );
          break;
        } catch (e: any) {
          if (e.code !== '23505' || attempt === 4) throw e; // retry on duplicate code
        }
      }
    }
    if (input.recipientEmail && created[0]) await this.email(created[0], input.message);
    return created;
  }

  async email(card: GiftCard, message?: string) {
    if (!card.recipientEmail) throw new BadRequestException('This gift card has no recipient email');
    const body = [
      `You have received a FORKY gift card worth $${card.initialAmount.toFixed(2)}!`,
      message ? `\n"${message}"\n` : '',
      `Your code: ${card.code}`,
      card.expiresAt ? `Valid until ${card.expiresAt.toISOString().slice(0, 10)}.` : '',
      'Redeem it in the FORKY app under Wallet > Redeem gift card.',
    ]
      .filter(Boolean)
      .join('\n');
    await this.notifications.sendEmail(card.recipientEmail, 'Your FORKY gift card', body);
  }

  async void(id: string) {
    const card = await this.cards.findOne({ where: { id } });
    if (!card) throw new NotFoundException('Gift card not found');
    if (!card.active) throw new ConflictException('Gift card is already void');
    const before = { ...card };
    card.active = false;
    await this.cards.save(card);
    return { before, after: card };
  }

  async list(q: PageQueryDto & { status?: string }) {
    const qb = this.cards.createQueryBuilder('g');
    if (q.search) qb.andWhere('(g.code ILIKE :s OR g.recipientEmail ILIKE :s)', { s: like(q.search) });
    switch (q.status) {
      case 'ACTIVE':
        qb.andWhere('g.active = true AND g.balance > 0 AND (g.expiresAt IS NULL OR g.expiresAt > now())');
        break;
      case 'REDEEMED':
        qb.andWhere('g.balance = 0 AND g.redeemedById IS NOT NULL');
        break;
      case 'VOID':
        qb.andWhere('g.active = false');
        break;
      case 'EXPIRED':
        qb.andWhere('g.expiresAt <= now() AND g.balance > 0');
        break;
    }
    return paginateQb(qb, q, {
      sortable: { createdAt: 'g.createdAt', initialAmount: 'g.initialAmount', balance: 'g.balance', expiresAt: 'g.expiresAt' },
      defaultSort: ['g.createdAt', 'DESC'],
    });
  }

  async stats() {
    const [r] = await this.ds.query(
      `SELECT COUNT(*)::int issued,
              COALESCE(SUM("initialAmount"),0)::float "issuedAmount",
              COUNT(*) FILTER (WHERE active AND balance > 0 AND ("expiresAt" IS NULL OR "expiresAt" > now()))::int "activeCount",
              COALESCE(SUM(balance) FILTER (WHERE active AND ("expiresAt" IS NULL OR "expiresAt" > now())),0)::float "outstandingBalance",
              COUNT(*) FILTER (WHERE balance = 0 AND "redeemedById" IS NOT NULL)::int "redeemedCount",
              COALESCE(SUM("initialAmount") FILTER (WHERE balance = 0 AND "redeemedById" IS NOT NULL),0)::float "redeemedAmount",
              COUNT(*) FILTER (WHERE NOT active)::int "voidCount",
              COALESCE(SUM(balance) FILTER (WHERE active AND "expiresAt" <= now()),0)::float "expiredBalance"
       FROM gift_cards`,
    );
    return r;
  }
}
