import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { In, Repository } from 'typeorm';
import { DriverProfile, Restaurant, RestaurantMember, ReviewCase, User } from '../database/entities';
import { ActorType, CaseDecision, CaseTrigger, DriverStatus, LedgerType, PartyType, RestaurantRole, RestaurantStatus } from '../common/enums';
import { Events } from '../common/contracts';
import { AuthUser } from '../common/auth.types';
import { PageQueryDto, paginateQb } from '../common/pagination';
import { SettingsService } from '../settings/settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { LedgerService } from '../orders/ledger.service';

export type Subject = 'DRIVER' | 'RESTAURANT';
const OPEN_CASE_STATUSES = ['PROPOSED', 'OPEN', 'AWAITING_RESPONSE'];

export interface OpenCaseInput {
  subjectType: Subject;
  subjectId: string;
  trigger: CaseTrigger;
  details: string;
  proposed?: boolean;
}

/**
 * SOP-08: deactivation and account review cases for drivers and restaurants.
 * Ontario gig-worker rules: a written notice with a response deadline is required before an adverse decision
 * (settings `driver.deactivationResponseDays`, default 7 days). Decisions apply status effects on the subject
 * (DriverProfile.status / Restaurant.status) via this module's own repositories - the owning module (Drivers /
 * Restaurants) is notified through `Events.DRIVER_STATUS_CHANGED` / `Events.RESTAURANT_STATUS_CHANGED`.
 */
@Injectable()
export class ReviewCasesService {
  constructor(
    private settings: SettingsService,
    private notifications: NotificationsService,
    private ledger: LedgerService,
    private events: EventEmitter2,
    @InjectRepository(ReviewCase) private cases: Repository<ReviewCase>,
    @InjectRepository(DriverProfile) private drivers: Repository<DriverProfile>,
    @InjectRepository(Restaurant) private restaurants: Repository<Restaurant>,
    @InjectRepository(RestaurantMember) private members: Repository<RestaurantMember>,
    @InjectRepository(User) private users: Repository<User>,
  ) {}

  async get(id: string): Promise<ReviewCase> {
    const c = await this.cases.findOne({ where: { id } });
    if (!c) throw new NotFoundException('Review case not found');
    return c;
  }

  async list(q: PageQueryDto & { subjectType?: string; status?: string; decision?: string }) {
    const qb = this.cases.createQueryBuilder('c');
    if (q.subjectType) qb.andWhere('c.subjectType = :st', { st: q.subjectType });
    if (q.status) qb.andWhere('c.status IN (:...statuses)', { statuses: q.status.split(',') });
    if (q.decision) qb.andWhere('c.decision IN (:...decisions)', { decisions: q.decision.split(',') });
    if (q.search) qb.andWhere('(c.subjectName ILIKE :search OR c.details ILIKE :search)', { search: `%${q.search}%` });
    return paginateQb(qb, q, { sortable: { createdAt: 'c.createdAt', respondBy: 'c.respondBy' }, defaultSort: ['c.createdAt', 'DESC'] });
  }

  /** Cases visible to the subject themselves (restaurant portal / driver app). `subjectIds` covers a restaurant owner's locations. */
  async listForSubject(subjectType: Subject, subjectIds: string[], q: PageQueryDto) {
    if (!subjectIds.length) return { data: [], meta: { page: 1, limit: q.limit ?? 20, total: 0, totalPages: 1 } };
    const qb = this.cases.createQueryBuilder('c').where('c.subjectType = :t AND c.subjectId IN (:...ids) AND c.proposed = false', { t: subjectType, ids: subjectIds });
    return paginateQb(qb, q, { defaultSort: ['c.createdAt', 'DESC'] });
  }

  async getForSubject(id: string, subjectType: Subject, subjectIds: string[]): Promise<ReviewCase> {
    const c = await this.get(id);
    if (c.subjectType !== subjectType || !subjectIds.includes(c.subjectId) || c.proposed) throw new NotFoundException('Review case not found');
    return c;
  }

  private async subjectUserId(subjectType: Subject, subjectId: string): Promise<string | null> {
    if (subjectType === 'DRIVER') return (await this.drivers.findOne({ where: { id: subjectId } }))?.userId ?? null;
    const r = await this.restaurants.findOne({ where: { id: subjectId } });
    if (!r) return null;
    const owner = await this.members
      .createQueryBuilder('m')
      .where('m.merchantId = :mid AND m.restaurantId IS NULL AND m.role = :role AND m.active = true', { mid: r.merchantId, role: RestaurantRole.OWNER })
      .getOne();
    return owner?.userId ?? null;
  }

  private async subjectNameAndStatus(subjectType: Subject, subjectId: string): Promise<{ name: string | null; status: string | null }> {
    if (subjectType === 'DRIVER') {
      const d = await this.drivers.findOne({ where: { id: subjectId }, relations: { user: true } });
      return { name: d?.user ? `${d.user.firstName} ${d.user.lastName}`.trim() : null, status: d?.status ?? null };
    }
    const r = await this.restaurants.findOne({ where: { id: subjectId } });
    return { name: r?.name ?? null, status: r?.status ?? null };
  }

  async open(input: OpenCaseInput): Promise<ReviewCase> {
    const [{ name, status }, subjectUserId] = await Promise.all([this.subjectNameAndStatus(input.subjectType, input.subjectId), this.subjectUserId(input.subjectType, input.subjectId)]);
    const saved = await this.cases.save(
      this.cases.create({
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        trigger: input.trigger,
        details: input.details,
        subjectName: name,
        subjectUserId,
        previousStatus: status,
        proposed: !!input.proposed,
        status: input.proposed ? 'PROPOSED' : 'OPEN',
      }),
    );
    if (!input.proposed) {
      await this.notifications.notifyOps('ticket.update', { number: saved.subjectName ?? saved.subjectId, subject: `Review case opened (${saved.trigger})` }, { caseId: saved.id, event: 'case.opened' }).catch(() => undefined);
    }
    return saved;
  }

  /** SOP-08 auto-detector: proposes (does not open) cases for low rating / repeated cancellations. */
  async detectCandidates(): Promise<OpenCaseInput[]> {
    if (!this.settings.get<boolean>('support.reviewDetectorEnabled', true)) return [];
    const minRatings = this.settings.get<number>('support.reviewMinRatings', 10);
    const lowRating = this.settings.get<number>('support.reviewLowRatingThreshold', 4.2);
    const cancelThreshold = this.settings.get<number>('support.reviewCancellationThreshold', 5);
    const out: OpenCaseInput[] = [];

    const lowDrivers = await this.drivers.createQueryBuilder('d').where('d.ratingCount >= :m AND d.rating < :r AND d.status = :active', { m: minRatings, r: lowRating, active: DriverStatus.ACTIVE }).getMany();
    for (const d of lowDrivers) {
      if (!(await this.hasOpenCase('DRIVER', d.id))) out.push({ subjectType: 'DRIVER', subjectId: d.id, trigger: CaseTrigger.LOW_RATING, details: `Rating ${d.rating} over ${d.ratingCount} ratings (below ${lowRating})`, proposed: true });
    }
    const lowRestaurants = await this.restaurants.createQueryBuilder('r').where('r.ratingCount >= :m AND r.rating < :r AND r.status = :live', { m: minRatings, r: lowRating, live: RestaurantStatus.LIVE }).getMany();
    for (const r of lowRestaurants) {
      if (!(await this.hasOpenCase('RESTAURANT', r.id))) out.push({ subjectType: 'RESTAURANT', subjectId: r.id, trigger: CaseTrigger.LOW_RATING, details: `Rating ${r.rating} over ${r.ratingCount} ratings (below ${lowRating})`, proposed: true });
    }
    // ratings system: rolling 30-day rating below ratings.driver.reviewBelow with enough ratings (see docs/ratings.md)
    const rBelow = this.settings.get<number>('ratings.driver.reviewBelow', 4.2);
    const rMin = this.settings.get<number>('ratings.driver.minRatings', 20);
    const slump = await this.drivers.createQueryBuilder('d').where('d.ratingCount30d >= :m AND d.rating30d < :r AND d.status = :active', { m: rMin, r: rBelow, active: DriverStatus.ACTIVE }).getMany();
    for (const d of slump) {
      if (out.some((c) => c.subjectType === 'DRIVER' && c.subjectId === d.id && c.trigger === CaseTrigger.LOW_RATING)) continue;
      if (!(await this.hasOpenCase('DRIVER', d.id))) out.push({ subjectType: 'DRIVER', subjectId: d.id, trigger: CaseTrigger.LOW_RATING, details: `Rolling 30-day rating ${d.rating30d} over ${d.ratingCount30d} ratings (below ${rBelow})`, proposed: true });
    }
    const cancelDrivers = await this.drivers.createQueryBuilder('d').where('d.cancellations >= :c AND d.status = :active', { c: cancelThreshold, active: DriverStatus.ACTIVE }).getMany();
    for (const d of cancelDrivers) {
      if (!(await this.hasOpenCase('DRIVER', d.id))) out.push({ subjectType: 'DRIVER', subjectId: d.id, trigger: CaseTrigger.REPEATED_CANCELLATIONS, details: `${d.cancellations} cancellations on record (threshold ${cancelThreshold})`, proposed: true });
    }
    const strikeThreshold = this.settings.get<number>('support.deliveryDisputeStrikeThreshold', 3);
    const disputeDrivers = await this.drivers.createQueryBuilder('d').where('d.deliveryDisputes30d >= :s AND d.status = :active', { s: strikeThreshold, active: DriverStatus.ACTIVE }).getMany();
    for (const d of disputeDrivers) {
      if (!(await this.hasOpenCase('DRIVER', d.id))) out.push({ subjectType: 'DRIVER', subjectId: d.id, trigger: CaseTrigger.DELIVERY_DISPUTES, details: `${d.deliveryDisputes30d} delivery-dispute strikes in 30 days (never-arrived claims without valid proof or confirmed not delivered; threshold ${strikeThreshold})`, proposed: true });
    }
    return out;
  }

  private async hasOpenCase(subjectType: Subject, subjectId: string): Promise<boolean> {
    return !!(await this.cases.findOne({ where: { subjectType, subjectId, status: In(OPEN_CASE_STATUSES) } }));
  }

  /** Run by the scheduler: proposes candidates that are not already open/proposed. Idempotent. */
  async runDetector(): Promise<number> {
    const candidates = await this.detectCandidates();
    for (const c of candidates) await this.open(c);
    return candidates.length;
  }

  async sendNotice(id: string, _actor: AuthUser, input: { noticeBody: string; responseDays?: number }): Promise<ReviewCase> {
    const c = await this.get(id);
    if (c.status === 'DECIDED' || c.status === 'CLOSED' || c.status === 'DISMISSED') throw new BadRequestException('This case is already closed');
    const days = input.responseDays ?? this.settings.get<number>('driver.deactivationResponseDays', 7);
    c.noticeBody = input.noticeBody;
    c.noticeSentAt = new Date();
    c.respondBy = new Date(Date.now() + days * 86400_000);
    c.status = 'AWAITING_RESPONSE';
    c.proposed = false;
    await this.cases.save(c);
    if (c.subjectUserId) {
      await this.notifications
        .notify({
          userId: c.subjectUserId,
          audience: c.subjectType === 'DRIVER' ? 'DRIVER' : 'RESTAURANT',
          event: 'account.deactivation_notice',
          vars: { reason: c.trigger, respondBy: c.respondBy.toDateString() },
          data: { caseId: c.id },
        })
        .catch(() => undefined);
    }
    return c;
  }

  async dismiss(id: string, notes?: string): Promise<ReviewCase> {
    const c = await this.get(id);
    c.status = 'DISMISSED';
    c.decisionNotes = notes ?? c.decisionNotes;
    return this.cases.save(c);
  }

  /** Driver / restaurant answers the written notice. */
  async respond(id: string, subjectType: Subject, subjectIds: string[], response: string): Promise<ReviewCase> {
    const c = await this.getForSubject(id, subjectType, subjectIds);
    if (c.status !== 'AWAITING_RESPONSE') throw new BadRequestException('This case is not awaiting a response');
    c.subjectResponse = response;
    c.status = 'OPEN';
    await this.cases.save(c);
    await this.notifications.notifyOps('ticket.update', { number: c.subjectName ?? c.id, subject: 'Review case response received' }, { caseId: c.id, event: 'case.response' }).catch(() => undefined);
    return c;
  }

  async addEvidence(id: string, actor: AuthUser, input: { type: string; ref?: string; url?: string; note: string }): Promise<ReviewCase> {
    const c = await this.get(id);
    c.evidence = [...(c.evidence ?? []), { ...input, addedById: actor.id, at: new Date() }];
    return this.cases.save(c);
  }

  async decide(id: string, actor: AuthUser, input: { decision: CaseDecision; notes?: string }): Promise<ReviewCase> {
    const c = await this.get(id);
    if (c.status === 'DECIDED' || c.status === 'CLOSED') throw new ConflictException('This case already has a decision');
    c.decision = input.decision;
    c.decisionNotes = input.notes ?? null;
    c.reviewerId = actor.id;
    c.decidedAt = new Date();
    c.status = 'DECIDED';
    await this.cases.save(c);
    await this.applyDecisionEffects(c, actor);
    return c;
  }

  /** Applies the driver/restaurant status effect of a decision and tells the owning module via a domain event. */
  private async applyDecisionEffects(c: ReviewCase, actor: AuthUser): Promise<void> {
    const from = c.previousStatus ?? '';
    let to: string | null = null;
    if (c.subjectType === 'DRIVER') {
      if (c.decision === CaseDecision.REINSTATED) to = DriverStatus.ACTIVE;
      else if (c.decision === CaseDecision.SUSPENDED) to = DriverStatus.SUSPENDED;
      else if (c.decision === CaseDecision.DEACTIVATED) to = DriverStatus.DEACTIVATED;
      if (to) await this.drivers.update(c.subjectId, { status: to as DriverStatus, statusReason: `${c.decision}: ${c.decisionNotes ?? c.trigger}` });
    } else {
      if (c.decision === CaseDecision.REINSTATED) to = RestaurantStatus.LIVE;
      else if (c.decision === CaseDecision.SUSPENDED || c.decision === CaseDecision.DEACTIVATED) to = RestaurantStatus.SUSPENDED;
      if (to) await this.restaurants.update(c.subjectId, { status: to as RestaurantStatus, statusReason: `${c.decision}: ${c.decisionNotes ?? c.trigger}` });
    }
    if (to) {
      this.events.emit(c.subjectType === 'DRIVER' ? Events.DRIVER_STATUS_CHANGED : Events.RESTAURANT_STATUS_CHANGED, {
        id: c.subjectId,
        from,
        to,
        reason: `SOP-08 case ${c.id}: ${c.decision}`,
        actor: { type: ActorType.STAFF, id: actor.id },
      });
    }
    if (c.subjectUserId) {
      await this.notifications
        .notify({
          userId: c.subjectUserId,
          audience: c.subjectType === 'DRIVER' ? 'DRIVER' : 'RESTAURANT',
          event: c.decision === CaseDecision.REINSTATED ? 'account.approved' : 'account.rejected',
          vars: { name: c.subjectName ?? '', reason: c.decisionNotes ?? c.trigger },
          data: { caseId: c.id, decision: c.decision },
        })
        .catch(() => undefined);
    }
  }

  async requestAppeal(id: string, subjectType: Subject, subjectIds: string[], notes?: string): Promise<ReviewCase> {
    const c = await this.getForSubject(id, subjectType, subjectIds);
    if (c.status !== 'DECIDED') throw new BadRequestException('Only a decided case can be appealed');
    if (c.appealStatus !== 'NONE') throw new ConflictException('An appeal was already requested for this case');
    c.appealStatus = 'REQUESTED';
    c.appealRequestedAt = new Date();
    if (notes) c.appealNotes = notes;
    await this.cases.save(c);
    await this.notifications.notifyOps('ticket.update', { number: c.subjectName ?? c.id, subject: 'Review case appeal requested' }, { caseId: c.id, event: 'case.appeal' }).catch(() => undefined);
    return c;
  }

  async decideAppeal(id: string, actor: AuthUser, input: { result: 'UPHELD' | 'OVERTURNED'; notes?: string }): Promise<ReviewCase> {
    const c = await this.get(id);
    if (c.appealStatus !== 'REQUESTED') throw new BadRequestException('No appeal is pending for this case');
    c.appealStatus = input.result;
    c.appealDecidedAt = new Date();
    c.appealDecidedById = actor.id;
    if (input.notes) c.appealNotes = [c.appealNotes, input.notes].filter(Boolean).join('\n');
    if (input.result === 'OVERTURNED') {
      c.decision = CaseDecision.REINSTATED;
      c.status = 'CLOSED';
      await this.cases.save(c);
      await this.applyDecisionEffects(c, actor);
    } else {
      c.status = 'CLOSED';
      await this.cases.save(c);
    }
    return c;
  }

  /** Records the final payout owed on separation (e.g. last week's earnings) via the shared ledger. */
  async finalPayout(id: string, amount: number): Promise<ReviewCase> {
    const c = await this.get(id);
    if (c.finalPayoutDone) throw new ConflictException('Final payout already recorded for this case');
    c.finalPayoutDone = true;
    c.finalPayoutAmount = amount;
    c.finalPayoutAt = new Date();
    await this.cases.save(c);
    if (amount > 0) {
      if (c.subjectType === 'DRIVER') {
        await this.ledger.add({ partyType: PartyType.DRIVER, partyId: c.subjectId, type: LedgerType.ADJUSTMENT, amount, description: `SOP-08 final payout - case ${c.id}` });
      } else {
        const r = await this.restaurants.findOne({ where: { id: c.subjectId } });
        await this.ledger.add({ partyType: PartyType.RESTAURANT, partyId: r?.merchantId ?? c.subjectId, restaurantId: c.subjectId, type: LedgerType.ADJUSTMENT, amount, description: `SOP-08 final payout - case ${c.id}` });
      }
    }
    return c;
  }
}
