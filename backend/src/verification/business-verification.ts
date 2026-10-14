import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { Between, Brackets, In, LessThanOrEqual, Repository } from 'typeorm';
import { CommissionTier, Merchant, Order, Restaurant, RestaurantMember, User } from '../database/entities';
import { ACTIVE_ORDER_STATUSES, MenuEditStatus, RestaurantRole, RestaurantStatus, VerificationAudience, VerificationMethod, VerificationStatus } from '../common/enums';
import { AuthUser } from '../common/auth.types';
import { like, paginateQb } from '../common/pagination';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { GeoService } from '../core/core.module';
import { MapboxService } from '../integrations/mapbox.service';
import { RestaurantStoreService } from '../restaurants/restaurant-store.service';
import { BackgroundCheckResult, CertnAdapter } from '../drivers/adapters/certn.adapter';
import {
  VerificationChoice,
  VerificationPolicy,
  assertOverrideAllowed,
  certnStatus,
  deadlineText,
  verificationSteps,
  verificationSummary,
  withoutRestore,
} from './verification-policy';
import { AudienceHandler, ForceItemResult, ForceOptions, ForceOutcome, Gate, RegistrationResult, StatusCounts, SubjectsQueryInput } from './verification.types';
import { MAX_CHECK_ATTEMPTS } from './driver-verification';
import { requirementsNotMet } from './verification.errors';

/** the states in which a business can still be verified */
const OPEN: VerificationStatus[] = [VerificationStatus.UNVERIFIED, VerificationStatus.PENDING, VerificationStatus.NEEDS_REVIEW];
/** restaurants that are working (or briefly paused) for customers */
const OPERATING: RestaurantStatus[] = [RestaurantStatus.LIVE, RestaurantStatus.PAUSED];
/** restaurants still on their way to going live: verification takes them live */
const GOING_LIVE: RestaurantStatus[] = [RestaurantStatus.APPLIED, RestaurantStatus.DOCS_REVIEW, RestaurantStatus.MENU_SETUP, RestaurantStatus.TEST_ORDER];

/**
 * Businesses: a merchant (the legal business and its owner) with its restaurants. Verification state lives on the merchant, the lifecycle
 * status (APPLIED ... LIVE) stays on each restaurant. The Certn check is run on the OWNER (identity + criminal record).
 */
@Injectable()
export class BusinessVerification implements AudienceHandler {
  readonly audience = VerificationAudience.BUSINESS;
  private readonly logger = new Logger('BusinessVerification');

  constructor(
    private store: RestaurantStoreService,
    private certn: CertnAdapter,
    private audit: AuditService,
    private notifications: NotificationsService,
    private geo: GeoService,
    private mapbox: MapboxService,
    @InjectRepository(Merchant) private merchants: Repository<Merchant>,
    @InjectRepository(Restaurant) private restaurants: Repository<Restaurant>,
    @InjectRepository(RestaurantMember) private members: Repository<RestaurantMember>,
    @InjectRepository(User) private users: Repository<User>,
    @InjectRepository(CommissionTier) private tiers: Repository<CommissionTier>,
    @InjectRepository(Order) private orders: Repository<Order>,
  ) {}

  // ------------------------------------------------------------------ helpers
  private async merchantOf(id: string): Promise<Merchant> {
    const m = await this.merchants.findOne({ where: { id } });
    if (!m) throw new NotFoundException('Business not found');
    return m;
  }

  private locations(merchantId: string) {
    return this.restaurants.find({ where: { merchantId }, order: { createdAt: 'ASC' } });
  }

  private async owner(merchantId: string): Promise<User | null> {
    const member = await this.members.findOne({ where: { merchantId, role: RestaurantRole.OWNER, active: true }, order: { createdAt: 'ASC' } });
    return member ? this.users.findOne({ where: { id: member.userId } }) : null;
  }

  private result(m: Merchant, r: Restaurant | null, mode: VerificationMethod): RegistrationResult {
    return { mode, accountStatus: r?.status ?? RestaurantStatus.APPLIED, verification: verificationSummary(VerificationAudience.BUSINESS, m) };
  }

  private effective(m: Merchant, policy: VerificationPolicy): VerificationChoice {
    return m.verificationMethod === VerificationMethod.MANUAL || m.verificationMethod === VerificationMethod.AUTOMATIC ? m.verificationMethod : policy.method;
  }

  private assertOpen(m: Merchant) {
    if (!OPEN.includes(m.verificationStatus)) {
      throw new BadRequestException(m.verificationStatus === VerificationStatus.VERIFIED ? 'This business is already verified' : `This business's verification is ${m.verificationStatus}`);
    }
  }

  private async notifyOwners(merchantId: string, event: string, vars: Record<string, any>) {
    const first = await this.restaurants.findOne({ where: { merchantId }, order: { createdAt: 'ASC' } });
    if (first) await this.store.notifyOwners(first, event, vars).catch((e) => this.logger.warn(`could not notify the owner of ${merchantId}: ${e.message}`));
  }

  // ------------------------------------------------------------------ registration
  async onRegistered(restaurantId: string, policy: VerificationPolicy): Promise<RegistrationResult> {
    const r = await this.restaurants.findOne({ where: { id: restaurantId } });
    if (!r) throw new NotFoundException('Restaurant not found');
    const m = await this.merchantOf(r.merchantId);
    if (r.status !== RestaurantStatus.APPLIED || m.verificationMethod) return this.result(m, r, m.verificationMethod ?? policy.mode);

    if (policy.instant) {
      m.verificationStatus = VerificationStatus.UNVERIFIED;
      m.verificationMethod = VerificationMethod.INSTANT;
      await this.merchants.save(m);
      await this.activate(r, { reason: 'Instant registration (not verified)', grantMenu: true });
      await this.audit.log({ actor: null, action: 'verification.instant_activate', entity: 'merchant', entityId: m.id, after: { restaurantId: r.id } });
      return this.result(m, r, VerificationMethod.INSTANT);
    }
    if (policy.method === VerificationMethod.AUTOMATIC && certnStatus().ready) {
      m.verificationStatus = VerificationStatus.PENDING;
      m.verificationMethod = VerificationMethod.AUTOMATIC;
      await this.merchants.save(m);
      await this.beginCheck(m, null).catch((e) => this.checkFailed(m, e));
      return this.result(await this.merchantOf(m.id), r, VerificationMethod.AUTOMATIC);
    }
    m.verificationStatus = VerificationStatus.PENDING;
    m.verificationMethod = VerificationMethod.MANUAL;
    // the automatic method is chosen but Certn cannot be used at this moment: the application waits for staff instead of failing
    if (policy.method === VerificationMethod.AUTOMATIC) m.meta = { ...m.meta, verification: { ...m.meta?.verification, fallback: 'CERTN_NOT_READY' } };
    await this.merchants.save(m);
    return this.result(m, r, VerificationMethod.MANUAL);
  }

  /**
   * Takes one restaurant live without a staff go-live: does what the go-live checklist would have needed (default commission tier,
   * location pin and zone) and lets the owner edit the menu. A restaurant without a pin is live but cannot be found by customers until
   * the owner sets its location.
   */
  private async activate(r: Restaurant, o: { reason: string; grantMenu: boolean }) {
    if (!r.commissionTierId && r.deliveryCommissionPct == null) {
      const tier = await this.tiers.findOne({ where: { isDefault: true } });
      if (tier) r.commissionTierId = tier.id;
    }
    if (r.lat == null || r.lng == null) await this.locate(r);
    if (r.lat != null && r.lng != null && !r.zoneId) {
      const zone = await this.geo.resolveZone(r.lat, r.lng).catch(() => null);
      if (zone) {
        r.zoneId = zone.id;
        r.cityId = zone.cityId;
      }
    }
    if (o.grantMenu && r.menuEditStatus !== MenuEditStatus.ALLOWED) {
      r.menuEditStatus = MenuEditStatus.ALLOWED;
      r.menuEditDecidedAt = new Date();
      r.menuEditDecidedById = null;
      r.menuEditDecisionNote = 'Allowed when the business was admitted or verified';
    }
    await this.store.changeStatus(r, RestaurantStatus.LIVE, { reason: o.reason, actor: null, action: 'verification_activate', acceptingOrders: true, pausedUntil: null, notifyEvent: 'account.approved' });
  }

  /** Best effort: a location pin from the street address (Mapbox, when configured). Never throws. */
  private async locate(r: Restaurant) {
    try {
      if (!this.mapbox.enabled) return;
      const query = [r.addressLine1, r.city, r.province, r.postalCode].filter(Boolean).join(', ');
      const session = randomUUID();
      const found = await this.mapbox.autocomplete(query, { sessionToken: session });
      const top = found.suggestions?.[0];
      if (!top) return;
      const got = await this.mapbox.retrieve(top.id, session);
      if (got.address) {
        r.lat = got.address.lat;
        r.lng = got.address.lng;
      }
    } catch (e: any) {
      this.logger.warn(`could not place restaurant ${r.id} on the map: ${e?.message ?? e}`);
    }
  }

  // ------------------------------------------------------------------ the Certn check (on the owner)
  private async beginCheck(m: Merchant, actor: AuthUser | null) {
    const owner = await this.owner(m.id);
    if (!owner) throw new BadRequestException('This business has no owner account to run the check on');
    const res = await this.certn.start(
      { subjectId: m.id, kind: 'BUSINESS', firstName: owner.firstName, lastName: owner.lastName, email: owner.email, phone: owner.phone },
      (r) => void this.applyResult(r).catch((e) => this.logger.error(`Certn result for business ${m.id} failed: ${e.message}`)),
    );
    m.backgroundCheckProvider = res.provider;
    m.backgroundCheckRef = res.ref;
    m.backgroundCheckStatus = 'IN_PROGRESS';
    m.meta = { ...m.meta, verification: { ...m.meta?.verification, certnError: null } };
    await this.merchants.save(m);
    await this.audit.log({ actor, action: 'verification.check_start', entity: 'merchant', entityId: m.id, after: { provider: res.provider, ref: res.ref } });
  }

  private async checkFailed(m: Merchant, e: any) {
    const v = m.meta?.verification ?? {};
    const attempts = (v.certnAttempts ?? 0) + 1;
    const message = String(e?.message ?? e).slice(0, 200);
    this.logger.warn(`Certn check for business ${m.id} could not start (attempt ${attempts}): ${message}`);
    m.meta = { ...m.meta, verification: { ...v, certnAttempts: attempts, certnError: message } };
    if (attempts >= MAX_CHECK_ATTEMPTS) {
      m.verificationStatus = VerificationStatus.NEEDS_REVIEW;
      await this.notifications
        .notifyOps('restaurant.background_check', { name: m.businessName, status: 'could not start' }, { merchantId: m.id }, { title: 'Background check could not start', body: `${m.businessName}: starting the Certn check failed ${attempts} times (${message}). Start it again or review the business by hand.` })
        .catch(() => undefined);
    }
    await this.merchants.save(m);
  }

  async startCheck(id: string, actor: AuthUser) {
    const m = await this.merchantOf(id);
    this.assertOpen(m);
    const certn = certnStatus();
    if (!certn.ready) throw new BadRequestException(certn.reason ?? 'Certn is not configured');
    if (m.backgroundCheckStatus === 'IN_PROGRESS') throw new BadRequestException('A background check is already in progress');
    if (m.verificationStatus !== VerificationStatus.PENDING) {
      m.verificationStatus = VerificationStatus.PENDING;
      m.verificationMethod = VerificationMethod.AUTOMATIC;
    }
    m.meta = { ...m.meta, verification: { ...m.meta?.verification, certnAttempts: 0, certnError: null } };
    await this.beginCheck(m, actor);
    return { provider: m.backgroundCheckProvider, ref: m.backgroundCheckRef, status: m.backgroundCheckStatus, verificationStatus: m.verificationStatus };
  }

  /** The Certn result (webhook or mock). Null when no business has this reference. */
  async applyResult(r: BackgroundCheckResult): Promise<boolean | null> {
    const m = await this.merchants.findOne({ where: { backgroundCheckRef: r.ref } });
    if (!m) return null;
    if (r.status === 'IN_PROGRESS' || m.backgroundCheckStatus === r.status) return true;
    m.backgroundCheckStatus = r.status;
    await this.merchants.save(m);
    const automatic = m.verificationMethod === VerificationMethod.AUTOMATIC && [VerificationStatus.PENDING, VerificationStatus.NEEDS_REVIEW].includes(m.verificationStatus);
    // automatic verification takes the business live by itself: only a flagged or failed result needs a person
    if (!(automatic && r.status === 'CLEAR')) await this.notifications.notifyOps('restaurant.background_check', { name: m.businessName, status: r.status }, { merchantId: m.id }).catch(() => undefined);
    await this.audit.log({ actor: null, action: 'verification.check_result', entity: 'merchant', entityId: m.id, after: { status: r.status, ref: r.ref } });
    if (!automatic) return true;
    if (r.status === 'CLEAR') {
      await this.complete(m, VerificationMethod.AUTOMATIC, null, 'Certn check clear');
    } else {
      // flagged or failed: a person decides. Nobody is rejected automatically.
      m.verificationStatus = VerificationStatus.NEEDS_REVIEW;
      await this.merchants.save(m);
      await this.audit.log({ actor: null, action: 'verification.needs_review', entity: 'merchant', entityId: m.id, after: { check: r.status } });
    }
    return true;
  }

  // ------------------------------------------------------------------ verify / reject
  /** The checklist the business has to satisfy for the given method. */
  async gates(m: Merchant, method: VerificationChoice, rs?: Restaurant[]): Promise<Gate[]> {
    const background: Gate = { key: 'background_check', label: 'Owner background check clear', done: m.backgroundCheckStatus === 'CLEAR', detail: m.backgroundCheckStatus };
    if (method === VerificationMethod.AUTOMATIC) return [background];
    const list = (rs ?? (await this.locations(m.id))).filter((r) => ![RestaurantStatus.REJECTED, RestaurantStatus.SUSPENDED].includes(r.status));
    const gates: Gate[] = [];
    for (const r of list) {
      const c = await this.store.documentChecklist(r.id);
      gates.push({
        key: `documents_approved:${r.id}`,
        label: `${r.name}: required documents approved`,
        done: c.allApproved,
        detail: c.items.filter((i) => i.status !== 'APPROVED').map((i) => `${i.type}: ${i.status}`).join(', ') || undefined,
      });
    }
    return gates;
  }

  /**
   * Verified: the verification fields are set, restaurants that Force verification took off line go back to what they were, and
   * restaurants that were waiting to go live are taken live. Suspended and rejected restaurants are left alone.
   */
  private async complete(m: Merchant, method: VerificationMethod, by: string | null, note: string) {
    const now = new Date();
    Object.assign(m, { verificationStatus: VerificationStatus.VERIFIED, verificationMethod: method, verifiedAt: now, verifiedBy: by, verificationDueAt: null, meta: withoutRestore(m.meta) });
    await this.merchants.save(m);
    for (const r of await this.locations(m.id)) {
      const v = r.meta?.verification;
      if (v?.restoreStatus) {
        const to = v.restoreStatus as RestaurantStatus;
        const accepting = v.restoreAccepting ?? to === RestaurantStatus.LIVE;
        r.meta = withoutRestore(r.meta);
        await this.store.changeStatus(r, to, { reason: 'Verified', actor: null, action: 'verification_restore', acceptingOrders: accepting, pausedUntil: null });
      } else if (GOING_LIVE.includes(r.status)) {
        await this.activate(r, { reason: note, grantMenu: true });
      }
    }
    await this.notifyOwners(m.id, 'verification.verified', { name: m.businessName });
    await this.audit.log({ actor: null, action: 'verification.verified', entity: 'merchant', entityId: m.id, after: { method, by, note } });
  }

  async verify(id: string, actor: AuthUser, dto: { note?: string; override?: boolean }, policy: VerificationPolicy) {
    const m = await this.merchantOf(id);
    this.assertOpen(m);
    const method = this.effective(m, policy);
    const gates = await this.gates(m, method);
    const missing = gates.filter((g) => !g.done);
    let overridden = false;
    if (missing.length) {
      if (!dto.override) throw requirementsNotMet(gates);
      assertOverrideAllowed(actor, dto.note);
      overridden = true;
    }
    await this.complete(m, method, actor.id, dto.note?.trim() || (overridden ? 'Verified by Super Admin override' : 'Verified by staff'));
    await this.audit.log({ actor, action: 'verification.verify', entity: 'merchant', entityId: m.id, after: { method, overridden, missing: missing.map((g) => g.key), note: dto.note ?? null } });
    return this.details(id, policy);
  }

  async reject(id: string, actor: AuthUser, reason: string) {
    const m = await this.merchantOf(id);
    this.assertOpen(m);
    const rs = await this.locations(m.id);
    if (rs.some((r) => OPERATING.includes(r.status))) {
      throw new BadRequestException('This business has a restaurant that is live: use suspend (SOP-08) instead of reject');
    }
    for (const r of rs.filter((x) => ![RestaurantStatus.REJECTED, RestaurantStatus.SUSPENDED].includes(x.status))) {
      await this.store.changeStatus(r, RestaurantStatus.REJECTED, { reason, actor, action: 'reject', acceptingOrders: false, notifyEvent: 'account.rejected' });
    }
    m.verificationStatus = VerificationStatus.REJECTED;
    m.verificationDueAt = null;
    m.meta = withoutRestore(m.meta);
    await this.merchants.save(m);
    await this.audit.log({ actor, action: 'verification.reject', entity: 'merchant', entityId: m.id, after: { reason } });
    return { verificationStatus: m.verificationStatus };
  }

  async details(id: string, policy: VerificationPolicy) {
    const m = await this.merchantOf(id);
    const rs = await this.locations(id);
    const owner = await this.owner(id);
    const method = this.effective(m, policy);
    const v = m.meta?.verification ?? {};
    const operating = rs.some((r) => OPERATING.includes(r.status));
    return {
      audience: VerificationAudience.BUSINESS,
      id: m.id,
      name: m.businessName,
      email: m.contactEmail,
      phone: m.contactPhone,
      owner: owner ? { name: `${owner.firstName} ${owner.lastName}`.trim(), email: owner.email } : null,
      restaurants: rs.map((r) => ({ id: r.id, name: r.name, status: r.status, acceptingOrders: r.acceptingOrders })),
      accountStatus: operating ? RestaurantStatus.LIVE : rs[0]?.status ?? null,
      operating,
      verification: {
        ...verificationSummary(VerificationAudience.BUSINESS, m),
        effectiveMethod: method,
        verifiedBy: m.verifiedBy,
        forcedAt: m.verificationForcedAt,
        fallback: v.fallback ?? null,
        certnError: v.certnError ?? null,
        certnAttempts: v.certnAttempts ?? 0,
      },
      backgroundCheck: { provider: m.backgroundCheckProvider, status: m.backgroundCheckStatus, ref: m.backgroundCheckRef },
      gates: await this.gates(m, method, rs),
      canVerify: OPEN.includes(m.verificationStatus),
      canStartCheck: OPEN.includes(m.verificationStatus) && m.backgroundCheckStatus !== 'IN_PROGRESS',
      canReject: OPEN.includes(m.verificationStatus) && !operating,
    };
  }

  // ------------------------------------------------------------------ force verification
  async forceTargets(ids?: string[]) {
    const skipped: ForceItemResult[] = [];
    if (ids?.length) {
      const rows = await this.merchants.find({ where: { id: In(ids) } });
      const byId = new Map(rows.map((m) => [m.id, m]));
      const targets: string[] = [];
      for (const id of ids) {
        const m = byId.get(id);
        if (!m) skipped.push({ id, name: '', outcome: 'SKIPPED', note: 'business not found' });
        else if (m.verificationStatus !== VerificationStatus.UNVERIFIED) skipped.push({ id, name: m.businessName, outcome: 'SKIPPED', note: `already ${m.verificationStatus}` });
        else targets.push(id);
      }
      return { targets, skipped };
    }
    const rows = await this.merchants.find({ where: { verificationStatus: VerificationStatus.UNVERIFIED }, select: ['id'], order: { createdAt: 'ASC' }, take: 5000 });
    return { targets: rows.map((r) => r.id), skipped };
  }

  async force(id: string, o: ForceOptions): Promise<ForceItemResult> {
    const m = await this.merchantOf(id);
    const name = m.businessName;
    if (m.verificationStatus !== VerificationStatus.UNVERIFIED) return { id, name, outcome: 'SKIPPED', note: `already ${m.verificationStatus}` };
    m.verificationStatus = VerificationStatus.PENDING;
    m.verificationMethod = o.method;
    m.verificationForcedAt = new Date();
    m.verificationDueAt = o.dueAt;
    m.verifiedAt = null;
    m.verifiedBy = null;
    m.meta = { ...m.meta, verification: { ...(m.meta?.verification ?? {}), forcedBy: o.actor.id, certnAttempts: 0, certnError: null, reminderSentAt: null, fallback: null } };
    await this.merchants.save(m);
    if (o.method === VerificationMethod.AUTOMATIC && m.backgroundCheckStatus === 'CLEAR') {
      await this.complete(m, VerificationMethod.AUTOMATIC, null, 'Certn check was already clear');
      return { id, name, outcome: 'VERIFIED', note: 'a clear Certn result was already on file' };
    }
    if (o.method === VerificationMethod.AUTOMATIC && o.startCheckNow) await this.beginCheck(m, o.actor).catch((e) => this.checkFailed(m, e));
    void this.notifyRequired(m, o.method, o.dueAt);
    if (o.dueAt.getTime() > Date.now()) return { id, name, outcome: 'GRACE', note: `open until ${o.dueAt.toISOString().slice(0, 10)}` };
    if (!o.blockNow) return { id, name, outcome: 'DEFERRED', note: 'will be taken off line by the next sweep' };
    const outcome = await this.block(m);
    const notes: Partial<Record<ForceOutcome, string>> = { DEFERRED: 'has orders in progress: taken off line when they finish', SKIPPED: 'had no live restaurant: marked pending, nothing to take off line' };
    return { id, name, outcome, note: notes[outcome] };
  }

  private async notifyRequired(m: Merchant, method: VerificationMethod, dueAt: Date | null) {
    await this.notifyOwners(m.id, 'verification.required', { deadline: deadlineText(dueAt), steps: verificationSteps(VerificationAudience.BUSINESS, method) });
  }

  /** Takes a business's live restaurants off line until verified (each one remembers what it was, so it comes back by itself). */
  private async block(m: Merchant): Promise<ForceOutcome> {
    const rs = await this.restaurants.find({ where: { merchantId: m.id, status: In(OPERATING) } });
    if (!rs.length) return 'SKIPPED';
    const inFlight = await this.orders.count({ where: { restaurantId: In(rs.map((r) => r.id)), status: In(ACTIVE_ORDER_STATUSES) } });
    if (inFlight > 0) return 'DEFERRED';
    const to = m.verificationMethod === VerificationMethod.AUTOMATIC ? RestaurantStatus.APPLIED : RestaurantStatus.DOCS_REVIEW;
    for (const r of rs) {
      r.meta = { ...r.meta, verification: { restoreStatus: r.status, restoreAccepting: r.acceptingOrders, blockedAt: new Date().toISOString() } };
      await this.store.changeStatus(r, to, { reason: 'Verification required: finish your verification to take orders again', actor: null, action: 'verification_block', acceptingOrders: false, pausedUntil: null });
    }
    await this.audit.log({ actor: null, action: 'verification.block', entity: 'merchant', entityId: m.id, after: { restaurants: rs.length, to, dueAt: m.verificationDueAt } });
    return 'BLOCKED';
  }

  // ------------------------------------------------------------------ sweeper steps
  async enforceDue(): Promise<number> {
    const due = await this.merchants.find({
      where: { verificationStatus: In([VerificationStatus.PENDING, VerificationStatus.NEEDS_REVIEW, VerificationStatus.REJECTED]), verificationDueAt: LessThanOrEqual(new Date()) },
      order: { verificationDueAt: 'ASC' },
      take: 200,
    });
    let n = 0;
    for (const m of due) {
      try {
        if ((await this.block(m)) === 'BLOCKED') n++;
      } catch (e: any) {
        this.logger.error(`could not take business ${m.id} off line: ${e.message}`);
      }
    }
    return n;
  }

  async retryChecks(limit: number): Promise<number> {
    const rows = await this.merchants.find({
      where: { verificationMethod: VerificationMethod.AUTOMATIC, verificationStatus: VerificationStatus.PENDING, backgroundCheckStatus: 'NOT_STARTED', updatedAt: LessThanOrEqual(new Date(Date.now() - 60_000)) },
      order: { updatedAt: 'ASC' },
      take: limit,
    });
    let n = 0;
    for (const m of rows) {
      try {
        const certn = certnStatus();
        if (!certn.ready) throw new Error(certn.reason ?? 'Certn is not configured');
        await this.beginCheck(m, null);
        n++;
      } catch (e) {
        await this.checkFailed(m, e);
      }
    }
    return n;
  }

  async remind(): Promise<number> {
    const rows = await this.merchants.find({ where: { verificationStatus: VerificationStatus.PENDING, verificationDueAt: Between(new Date(), new Date(Date.now() + 24 * 3600_000)) }, take: 200 });
    let n = 0;
    for (const m of rows) {
      if (m.meta?.verification?.reminderSentAt) continue;
      m.meta = { ...m.meta, verification: { ...m.meta?.verification, reminderSentAt: new Date().toISOString() } };
      await this.merchants.save(m);
      await this.notifyRequired(m, m.verificationMethod ?? VerificationMethod.MANUAL, m.verificationDueAt);
      n++;
    }
    return n;
  }

  // ------------------------------------------------------------------ overview
  async counts(): Promise<StatusCounts> {
    const rows: { s: VerificationStatus; n: number }[] = await this.merchants.createQueryBuilder('m').select('m.verificationStatus', 's').addSelect('COUNT(*)::int', 'n').groupBy('m.verificationStatus').getRawMany();
    const by = (s: VerificationStatus) => rows.find((r) => r.s === s)?.n ?? 0;
    const operatingUnverified = await this.merchants
      .createQueryBuilder('m')
      .where('m.verificationStatus IN (:...open)', { open: OPEN })
      .andWhere('EXISTS (SELECT 1 FROM restaurants r WHERE r."merchantId" = m.id AND r.status IN (:...op))', { op: OPERATING })
      .getCount();
    const withDeadline = await this.merchants
      .createQueryBuilder('m')
      .where('m.verificationDueAt IS NOT NULL AND m.verificationStatus IN (:...st)', { st: [VerificationStatus.PENDING, VerificationStatus.NEEDS_REVIEW] })
      .getCount();
    const c = {
      UNVERIFIED: by(VerificationStatus.UNVERIFIED),
      PENDING: by(VerificationStatus.PENDING),
      NEEDS_REVIEW: by(VerificationStatus.NEEDS_REVIEW),
      VERIFIED: by(VerificationStatus.VERIFIED),
      REJECTED: by(VerificationStatus.REJECTED),
    };
    return { ...c, total: Object.values(c).reduce((a, b) => a + b, 0), operatingUnverified, withDeadline };
  }

  async list(q: SubjectsQueryInput) {
    const qb = this.merchants.createQueryBuilder('m');
    if (q.status) qb.andWhere('m.verificationStatus = :vs', { vs: q.status });
    if (q.search) {
      qb.andWhere(
        new Brackets((b) =>
          b
            .where('m.businessName ILIKE :s', { s: like(q.search!) })
            .orWhere('m.contactEmail ILIKE :s', { s: like(q.search!) })
            .orWhere('m.legalName ILIKE :s', { s: like(q.search!) }),
        ),
      );
    }
    const res = await paginateQb(qb, { page: q.page, limit: q.limit } as any, { sortable: {}, defaultSort: ['m.createdAt', 'DESC'] });
    const ids = res.data.map((m) => m.id);
    const rs = ids.length ? await this.restaurants.find({ where: { merchantId: In(ids) }, select: ['id', 'merchantId', 'status', 'name'], order: { createdAt: 'ASC' } }) : [];
    const owners = ids.length ? await this.members.find({ where: { merchantId: In(ids), role: RestaurantRole.OWNER, active: true }, relations: ['user'] }) : [];
    return {
      data: res.data.map((m) => {
        const mine = rs.filter((r) => r.merchantId === m.id);
        const owner = owners.find((o) => o.merchantId === m.id)?.user;
        return {
          id: m.id,
          audience: VerificationAudience.BUSINESS,
          name: m.businessName,
          email: m.contactEmail,
          phone: m.contactPhone,
          owner: owner ? `${owner.firstName} ${owner.lastName}`.trim() : null,
          ownerEmail: owner?.email ?? null,
          /** the first location: where the admin console shows this business (/restaurants/:id) */
          restaurantId: mine[0]?.id ?? null,
          locations: mine.length,
          accountStatus: mine.some((r) => OPERATING.includes(r.status)) ? RestaurantStatus.LIVE : mine[0]?.status ?? null,
          operating: mine.some((r) => OPERATING.includes(r.status)),
          verificationStatus: m.verificationStatus,
          verificationMethod: m.verificationMethod,
          verifiedAt: m.verifiedAt,
          verificationForcedAt: m.verificationForcedAt,
          verificationDueAt: m.verificationDueAt,
          backgroundCheckStatus: m.backgroundCheckStatus,
          createdAt: m.createdAt,
        };
      }),
      meta: res.meta,
    };
  }
}
