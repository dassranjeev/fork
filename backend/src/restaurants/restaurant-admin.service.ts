import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DataSource, In, LessThanOrEqual, Not, Repository } from 'typeorm';
import {
  CommissionTier,
  Cuisine,
  Merchant,
  MenuItem,
  Restaurant,
  RestaurantDocument,
  RestaurantMember,
  User,
  Zone,
} from '../database/entities';
import { DocStatus, RestaurantDocType, RestaurantRole, RestaurantStatus, UserStatus, UserType, VerificationAudience, VerificationMethod, VerificationStatus } from '../common/enums';
import { verificationSummary, withoutRestore } from '../verification/verification-policy';
import { AuthUser } from '../common/auth.types';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { GeoService } from '../core/core.module';
import { like, paginateQb } from '../common/pagination';
import { RestaurantStoreService } from './restaurant-store.service';
import { slugify, tempPassword } from './restaurants.util';
import {
  AgreementDto,
  ApproveDocDto,
  BulkDto,
  CommissionDto,
  CreateRestaurantDto,
  LocationDto,
  MenuReviewDto,
  MerchantDto,
  MerchantsQuery,
  OptionalReasonDto,
  ReasonDto,
  RejectDocDto,
  RestaurantsQuery,
  TestOrderDto,
  UpdateMerchantDto,
} from './dto';

/**
 * SOP-01 onboarding pipeline + merchant/restaurant admin CRUD (ARCHITECTURE.md RestaurantsModule row).
 * Delegates status transitions and owner notifications to RestaurantStoreService.changeStatus/notifyOwners*
 * so there is a single source of truth for the lifecycle audit/event/notification wiring.
 */
@Injectable()
export class RestaurantAdminService {
  constructor(
    @InjectDataSource() private ds: DataSource,
    @InjectRepository(Merchant) private merchants: Repository<Merchant>,
    @InjectRepository(Restaurant) private restaurants: Repository<Restaurant>,
    @InjectRepository(RestaurantDocument) private docsRepo: Repository<RestaurantDocument>,
    @InjectRepository(Cuisine) private cuisines: Repository<Cuisine>,
    @InjectRepository(CommissionTier) private tiers: Repository<CommissionTier>,
    @InjectRepository(Zone) private zones: Repository<Zone>,
    @InjectRepository(RestaurantMember) private members: Repository<RestaurantMember>,
    @InjectRepository(User) private users: Repository<User>,
    @InjectRepository(MenuItem) private menuItems: Repository<MenuItem>,
    private store: RestaurantStoreService,
    private geo: GeoService,
    private auth: AuthService,
    private audit: AuditService,
  ) {}

  // ------------------------------------------------------------------ merchants
  listMerchants(q: MerchantsQuery) {
    const qb = this.merchants.createQueryBuilder('m');
    if (q.search) qb.andWhere('(m.businessName ILIKE :s OR m.contactEmail ILIKE :s OR m.legalName ILIKE :s)', { s: like(q.search) });
    if (q.hasLocations === 'true') qb.andWhere('EXISTS (SELECT 1 FROM restaurants r WHERE r."merchantId" = m.id)');
    if (q.hasLocations === 'false') qb.andWhere('NOT EXISTS (SELECT 1 FROM restaurants r WHERE r."merchantId" = m.id)');
    if (q.verification) qb.andWhere('m.verificationStatus = :vs', { vs: q.verification });
    return paginateQb(qb, q, { sortable: { businessName: 'm.businessName', createdAt: 'm.createdAt' }, defaultSort: ['m.createdAt', 'DESC'] });
  }

  async getMerchant(id: string) {
    const m = await this.merchants.findOne({ where: { id } });
    if (!m) throw new NotFoundException('Merchant not found');
    const locations = await this.restaurants.find({ where: { merchantId: id }, select: ['id', 'name', 'status', 'city'], order: { name: 'ASC' } });
    return { ...m, locations };
  }

  async createMerchant(dto: MerchantDto, req?: any) {
    const m = await this.merchants.save(
      this.merchants.create({
        businessName: dto.businessName,
        legalName: dto.legalName ?? null,
        hstNumber: dto.hstNumber ?? null,
        contactEmail: dto.contactEmail ?? null,
        contactPhone: dto.contactPhone ?? null,
        stripeAccountId: dto.stripeAccountId ?? null,
        bank: dto.bank ?? null,
      }),
    );
    if (req) await this.audit.logReq(req, 'merchant.create', 'merchant', m.id, undefined, dto);
    return m;
  }

  async updateMerchant(id: string, dto: UpdateMerchantDto, req?: any) {
    const m = await this.merchants.findOne({ where: { id } });
    if (!m) throw new NotFoundException('Merchant not found');
    const before = { ...m };
    for (const [k, v] of Object.entries(dto)) if (v !== undefined) (m as any)[k] = v;
    await this.merchants.save(m);
    if (req) await this.audit.logReq(req, 'merchant.update', 'merchant', id, before, dto);
    return m;
  }

  // ------------------------------------------------------------------ restaurants list / create
  async list(q: RestaurantsQuery) {
    const qb = this.restaurants.createQueryBuilder('r').leftJoin('r.cuisines', 'c');
    if (q.search) qb.andWhere('(r.name ILIKE :s OR r.slug ILIKE :s)', { s: like(q.search) });
    if (q.status) qb.andWhere('r.status = :status', { status: q.status });
    if (q.city) qb.andWhere('r.city ILIKE :city', { city: like(q.city) });
    if (q.cityId) qb.andWhere('r.cityId = :cityId', { cityId: q.cityId });
    if (q.zoneId) qb.andWhere('r.zoneId = :zoneId', { zoneId: q.zoneId });
    if (q.merchantId) qb.andWhere('r.merchantId = :merchantId', { merchantId: q.merchantId });
    if (q.commissionTierId) qb.andWhere('r.commissionTierId = :ct', { ct: q.commissionTierId });
    if (q.menuAccess) qb.andWhere('r.menuEditStatus = :ma', { ma: q.menuAccess });
    if (q.minRating) qb.andWhere('r.rating >= :minR', { minR: +q.minRating });
    if (q.maxRating) qb.andWhere('r.rating <= :maxR', { maxR: +q.maxRating });
    if (q.cuisineId) qb.andWhere('c.id = :cid', { cid: q.cuisineId });
    if (q.cuisine) qb.andWhere('c.slug = :cslug', { cslug: q.cuisine });
    if (q.hasExpiringDocs === 'true') {
      const days = q.expiringDays ? +q.expiringDays : 30;
      qb.andWhere(
        `EXISTS (SELECT 1 FROM restaurant_documents d WHERE d."restaurantId" = r.id AND d.status = 'APPROVED' AND d."expiresAt" IS NOT NULL AND d."expiresAt" <= (CURRENT_DATE + (:days || ' days')::interval))`,
        { days },
      );
    }
    if (q.verification) {
      qb.andWhere('EXISTS (SELECT 1 FROM merchants vm WHERE vm.id = r."merchantId" AND vm."verificationStatus" = :vs)', { vs: q.verification });
    }
    const res = await paginateQb(qb, q, {
      sortable: { name: 'r.name', createdAt: 'r.createdAt', rating: 'r.rating', status: 'r.status' },
      defaultSort: ['r.createdAt', 'DESC'],
    });
    // the verification state belongs to the business (merchant); show it on every location row
    const ids = [...new Set(res.data.map((r) => r.merchantId))];
    const owners = ids.length ? await this.merchants.find({ where: { id: In(ids) } }) : [];
    const byId = new Map(owners.map((m) => [m.id, m]));
    return { ...res, data: res.data.map((r) => ({ ...r, verification: byId.has(r.merchantId) ? verificationSummary(VerificationAudience.BUSINESS, byId.get(r.merchantId)!) : null })) };
  }

  async create(dto: CreateRestaurantDto, actor: AuthUser, req?: any) {
    const result = await this.ds.transaction(async (em) => {
      let merchantId = dto.merchantId ?? null;
      if (!merchantId) {
        if (!dto.merchant) throw new BadRequestException('Provide merchantId or merchant');
        const merchant = await em.save(
          em.create(Merchant, {
            businessName: dto.merchant.businessName,
            legalName: dto.merchant.legalName ?? null,
            hstNumber: dto.merchant.hstNumber ?? null,
            contactEmail: dto.merchant.contactEmail ?? null,
            contactPhone: dto.merchant.contactPhone ?? null,
            stripeAccountId: dto.merchant.stripeAccountId ?? null,
            bank: dto.merchant.bank ?? null,
          }),
        );
        merchantId = merchant.id;
      } else if (!(await em.findOne(Merchant, { where: { id: merchantId } }))) {
        throw new BadRequestException('Unknown merchantId');
      }

      let slug = slugify(dto.slug || dto.name) || 'restaurant';
      if (await em.findOne(Restaurant, { where: { slug } })) slug = `${slug}-${tempPassword().slice(2, 6).toLowerCase()}`;
      const cuisines = dto.cuisineIds?.length ? await em.find(Cuisine, { where: { id: In(dto.cuisineIds) } }) : [];
      const defaultTier = dto.commissionTierId ? null : await this.tiers.findOne({ where: { isDefault: true } });
      const zone = dto.lat != null && dto.lng != null ? await this.geo.resolveZone(dto.lat, dto.lng) : null;

      const restaurant = await em.save(
        em.create(Restaurant, {
          merchantId,
          name: dto.name,
          slug,
          description: dto.description ?? null,
          phone: dto.phone ?? null,
          email: dto.email ?? null,
          addressLine1: dto.addressLine1 ?? '',
          addressLine2: dto.addressLine2 ?? null,
          city: dto.city ?? '',
          province: dto.province ?? 'ON',
          postalCode: dto.postalCode ?? '',
          lat: dto.lat ?? null,
          lng: dto.lng ?? null,
          zoneId: zone?.id ?? null,
          cityId: zone?.cityId ?? null,
          hstNumber: dto.hstNumber ?? null,
          priceLevel: dto.priceLevel ?? 2,
          cuisines,
          commissionTierId: dto.commissionTierId ?? defaultTier?.id ?? null,
          status: RestaurantStatus.APPLIED,
          acceptingOrders: false,
        }),
      );

      let temporaryPassword: string | undefined;
      if (dto.owner) {
        const email = dto.owner.email.toLowerCase();
        if (await em.findOne(User, { where: { email } })) throw new ConflictException('Owner email already registered');
        const phone = dto.owner.phone ? this.auth.normalizePhone(dto.owner.phone) : null;
        temporaryPassword = tempPassword();
        const user = await em.save(
          em.create(User, {
            type: UserType.RESTAURANT,
            status: UserStatus.ACTIVE,
            email,
            phone,
            firstName: dto.owner.firstName,
            lastName: dto.owner.lastName,
            emailVerified: true,
            passwordHash: await this.auth.hash(temporaryPassword),
          }),
        );
        await em.save(em.create(RestaurantMember, { userId: user.id, merchantId, restaurantId: null, role: RestaurantRole.OWNER, active: true }));
      }
      return { restaurant, merchantId, temporaryPassword };
    });

    if (req) await this.audit.logReq(req, 'restaurant.create', 'restaurant', result.restaurant.id, undefined, { name: dto.name });
    else await this.audit.log({ actor, action: 'restaurant.create', entity: 'restaurant', entityId: result.restaurant.id, after: { name: dto.name } });
    return { restaurant: await this.store.view(result.restaurant.id), temporaryPassword: result.temporaryPassword };
  }

  // ------------------------------------------------------------------ onboarding: documents
  async approveDocument(restaurantId: string, docId: string, dto: ApproveDocDto, req: any) {
    const doc = await this.docsRepo.findOne({ where: { id: docId, restaurantId } });
    if (!doc) throw new NotFoundException('Document not found');
    doc.status = DocStatus.APPROVED;
    doc.rejectReason = null;
    doc.reviewedAt = new Date();
    doc.reviewedById = req?.user?.id ?? null;
    if (dto.expiresAt) doc.expiresAt = dto.expiresAt.slice(0, 10);
    await this.docsRepo.save(doc);
    await this.audit.logReq(req, 'restaurant.document.approve', 'restaurant_document', docId, undefined, { type: doc.type });
    return doc;
  }

  async rejectDocument(restaurantId: string, docId: string, dto: RejectDocDto, req: any) {
    const doc = await this.docsRepo.findOne({ where: { id: docId, restaurantId } });
    if (!doc) throw new NotFoundException('Document not found');
    doc.status = DocStatus.REJECTED;
    doc.rejectReason = dto.reason;
    doc.reviewedAt = new Date();
    doc.reviewedById = req?.user?.id ?? null;
    await this.docsRepo.save(doc);
    const r = await this.store.get(restaurantId);
    await this.store.notifyOwnersText(r, 'restaurant.document_rejected', 'A document was rejected', `Your ${doc.type} was rejected: ${dto.reason}. Please upload a corrected copy.`);
    await this.audit.logReq(req, 'restaurant.document.reject', 'restaurant_document', docId, undefined, { type: doc.type, reason: dto.reason });
    return doc;
  }

  /** DOCS_REVIEW -> MENU_SETUP once every required document is APPROVED. */
  async docsApprove(id: string, req: any) {
    const r = await this.store.get(id);
    if (![RestaurantStatus.APPLIED, RestaurantStatus.DOCS_REVIEW].includes(r.status)) {
      throw new BadRequestException(`Cannot approve documents from status ${r.status}`);
    }
    const checklist = await this.store.documentChecklist(id);
    if (!checklist.allApproved) throw new BadRequestException('Not all required documents are approved yet');
    return this.store.changeStatus(r, RestaurantStatus.MENU_SETUP, { req, action: 'docs_review.approve' });
  }

  // ------------------------------------------------------------------ onboarding: commission / location / agreement
  async updateCommission(id: string, dto: CommissionDto, req: any) {
    const r = await this.store.get(id);
    const before = { commissionTierId: r.commissionTierId, deliveryCommissionPct: r.deliveryCommissionPct, pickupCommissionPct: r.pickupCommissionPct, ownDriverCommissionPct: r.ownDriverCommissionPct };
    if (dto.commissionTierId !== undefined) {
      if (dto.commissionTierId && !(await this.tiers.exist({ where: { id: dto.commissionTierId } }))) throw new BadRequestException('Unknown commissionTierId');
      r.commissionTierId = dto.commissionTierId;
    }
    if (dto.deliveryCommissionPct !== undefined) r.deliveryCommissionPct = dto.deliveryCommissionPct;
    if (dto.pickupCommissionPct !== undefined) r.pickupCommissionPct = dto.pickupCommissionPct;
    if (dto.ownDriverCommissionPct !== undefined) r.ownDriverCommissionPct = dto.ownDriverCommissionPct;
    await this.restaurants.save(r);
    await this.audit.logReq(req, 'restaurant.commission', 'restaurant', id, before, dto);
    return this.store.view(id);
  }

  async updateLocation(id: string, dto: LocationDto, req: any) {
    const r = await this.store.get(id);
    const before = { lat: r.lat, lng: r.lng, zoneId: r.zoneId, cityId: r.cityId };
    r.lat = dto.lat;
    r.lng = dto.lng;
    if (dto.addressLine1 !== undefined) r.addressLine1 = dto.addressLine1;
    if (dto.city !== undefined) r.city = dto.city;
    if (dto.postalCode !== undefined) r.postalCode = dto.postalCode;
    if (dto.zoneId) {
      const zone = await this.zones.findOne({ where: { id: dto.zoneId } });
      if (!zone) throw new BadRequestException('Unknown zoneId');
      r.zoneId = zone.id;
      r.cityId = zone.cityId;
    } else {
      const zone = await this.geo.resolveZone(dto.lat, dto.lng);
      r.zoneId = zone?.id ?? null;
      r.cityId = zone?.cityId ?? r.cityId;
    }
    await this.restaurants.save(r);
    await this.audit.logReq(req, 'restaurant.location', 'restaurant', id, before, dto);
    return this.store.view(id);
  }

  async signAgreement(id: string, dto: AgreementDto, req: any) {
    const r = await this.store.get(id);
    const m = await this.merchants.findOne({ where: { id: r.merchantId } });
    if (!m) throw new NotFoundException('Merchant not found');
    m.agreementSignedAt = dto.signedAt ? new Date(dto.signedAt) : new Date();
    m.agreementSignedBy = dto.signedBy;
    await this.merchants.save(m);
    if (dto.documentUrl) {
      await this.docsRepo.save(
        this.docsRepo.create({ restaurantId: id, type: RestaurantDocType.AGREEMENT, fileUrl: dto.documentUrl, status: DocStatus.APPROVED, reviewedAt: new Date() }),
      );
    }
    await this.audit.logReq(req, 'restaurant.agreement.sign', 'merchant', m.id, undefined, { signedBy: dto.signedBy, notes: dto.notes });
    return { agreementSignedAt: m.agreementSignedAt, agreementSignedBy: m.agreementSignedBy };
  }

  // ------------------------------------------------------------------ onboarding: menu review / test order / go-live
  async menuReview(id: string, dto: MenuReviewDto, req: any) {
    const r = await this.store.get(id);
    if (r.status !== RestaurantStatus.MENU_SETUP) throw new BadRequestException(`Restaurant is ${r.status}, expected MENU_SETUP`);
    if (dto.approved) {
      const items = await this.menuItems.count({ where: { restaurantId: id, active: true } });
      if (!items) throw new BadRequestException('Add at least one active menu item before approving the menu');
      await this.store.patchMeta(id, { menuReview: { approved: true, notes: dto.notes ?? null, at: new Date().toISOString() } });
      const updated = await this.store.changeStatus(r, RestaurantStatus.TEST_ORDER, { req, action: 'menu.approve' });
      await this.store.notifyOwnersText(r, 'menu.approved', 'Menu approved', 'Your menu was approved. Next: complete a test order to go live.');
      return updated;
    }
    await this.store.patchMeta(id, { menuReview: { approved: false, notes: dto.notes ?? null, at: new Date().toISOString() } });
    await this.store.notifyOwnersText(r, 'menu.changes_requested', 'Menu changes requested', dto.notes ?? 'Please update your menu before we can continue onboarding.');
    await this.audit.logReq(req, 'restaurant.menu_review.reject', 'restaurant', id, undefined, { notes: dto.notes });
    return this.store.view(id);
  }

  async testOrder(id: string, dto: TestOrderDto, req: any) {
    const r = await this.store.get(id);
    if (dto.action === 'request') {
      if (r.status !== RestaurantStatus.TEST_ORDER) throw new BadRequestException(`Restaurant is ${r.status}, expected TEST_ORDER`);
      await this.store.patchMeta(id, { testOrder: { requestedAt: new Date().toISOString(), completed: false } });
      await this.store.notifyOwnersText(
        r,
        'test_order.requested',
        'Place a test order',
        dto.notes ?? 'Ops asked you to place or expect a test order to confirm menu accuracy and kitchen readiness before going live.',
      );
      await this.audit.logReq(req, 'restaurant.test_order.request', 'restaurant', id, undefined, {});
      return this.store.view(id);
    }
    const meta = { ...(r.meta ?? {}) };
    meta.testOrder = { ...(meta.testOrder ?? {}), completed: true, orderId: dto.orderId ?? null, notes: dto.notes ?? null, completedAt: new Date().toISOString() };
    await this.store.patchMeta(id, { testOrder: meta.testOrder });
    await this.audit.logReq(req, 'restaurant.test_order.complete', 'restaurant', id, undefined, { orderId: dto.orderId });
    return this.store.view(id);
  }

  async goLive(id: string, dto: OptionalReasonDto, req: any) {
    const r = await this.store.get(id);
    if (r.status === RestaurantStatus.LIVE) return this.store.view(id);
    if (![RestaurantStatus.TEST_ORDER, RestaurantStatus.PAUSED, RestaurantStatus.SUSPENDED].includes(r.status) && !dto.force) {
      throw new BadRequestException(`Restaurant is ${r.status}; complete onboarding first (or pass force:true as super admin)`);
    }
    if (!dto.force) {
      const checklist = await this.store.documentChecklist(id);
      if (!checklist.allApproved) throw new BadRequestException('Required documents are not all approved');
      if (!r.commissionTierId && r.deliveryCommissionPct == null) throw new BadRequestException('Set a commission tier or override before going live');
      if (!r.zoneId) throw new BadRequestException('Set the restaurant location / zone before going live');
      const items = await this.menuItems.count({ where: { restaurantId: id, active: true } });
      if (!items) throw new BadRequestException('Menu has no active items');
      if (!r.meta?.testOrder?.completed) throw new BadRequestException('Complete a test order before going live');
    }
    const live = await this.store.changeStatus(r, RestaurantStatus.LIVE, { reason: dto.reason ?? null, req, action: 'go_live', notifyEvent: 'account.approved', acceptingOrders: true });
    await this.verifiedByStaff(live, req);
    return live;
  }

  /** A staff go-live IS the manual verification of the business (docs/verification.md); it also ends any "verification required" block. */
  private async verifiedByStaff(r: Restaurant, req: any) {
    const m = await this.merchants.findOne({ where: { id: r.merchantId } });
    if (m && m.verificationStatus !== VerificationStatus.VERIFIED) {
      m.verificationStatus = VerificationStatus.VERIFIED;
      m.verificationMethod = VerificationMethod.MANUAL;
      m.verifiedAt = new Date();
      m.verifiedBy = req?.user?.id ?? null;
      m.verificationDueAt = null;
      m.meta = withoutRestore(m.meta);
      await this.merchants.save(m);
    }
    if (r.meta?.verification?.restoreStatus) {
      r.meta = withoutRestore(r.meta);
      await this.restaurants.save(r);
    }
  }

  // ------------------------------------------------------------------ lifecycle: pause / suspend / reactivate / reject
  async pause(id: string, dto: ReasonDto, req: any) {
    const r = await this.store.get(id);
    if (r.status !== RestaurantStatus.LIVE) throw new BadRequestException('Only a live restaurant can be paused');
    const pausedUntil = dto.resumeAfterHours ? new Date(Date.now() + dto.resumeAfterHours * 3600_000) : null;
    return this.store.changeStatus(r, RestaurantStatus.PAUSED, { reason: dto.reason, req, action: 'pause', acceptingOrders: false, pausedUntil, notifyEvent: 'account.deactivation_notice' });
  }

  async suspend(id: string, dto: ReasonDto, req: any) {
    const r = await this.store.get(id);
    return this.store.changeStatus(r, RestaurantStatus.SUSPENDED, { reason: dto.reason, req, action: 'suspend', acceptingOrders: false, pausedUntil: null, notifyEvent: 'account.deactivation_notice' });
  }

  async reactivate(id: string, dto: OptionalReasonDto, req: any) {
    const r = await this.store.get(id);
    if (![RestaurantStatus.PAUSED, RestaurantStatus.SUSPENDED].includes(r.status)) throw new BadRequestException(`Restaurant is ${r.status}, not paused/suspended`);
    return this.store.changeStatus(r, RestaurantStatus.LIVE, { reason: dto.reason ?? null, req, action: 'reactivate', acceptingOrders: true, pausedUntil: null, notifyEvent: 'account.approved' });
  }

  async reject(id: string, dto: ReasonDto, req: any) {
    const r = await this.store.get(id);
    if (r.status === RestaurantStatus.LIVE) throw new BadRequestException('Use suspend for a restaurant that already went live');
    const rejected = await this.store.changeStatus(r, RestaurantStatus.REJECTED, { reason: dto.reason, req, action: 'reject', acceptingOrders: false, notifyEvent: 'account.rejected' });
    // the business is rejected when none of its locations is left (a business that was verified before stays verified)
    const remaining = await this.restaurants.count({ where: { merchantId: r.merchantId, status: Not(RestaurantStatus.REJECTED) } });
    if (!remaining) {
      await this.merchants.update({ id: r.merchantId, verificationStatus: Not(VerificationStatus.VERIFIED) }, { verificationStatus: VerificationStatus.REJECTED, verificationDueAt: null });
    }
    return rejected;
  }

  async bulk(dto: BulkDto, req: any) {
    const results: { id: string; ok: boolean; error?: string }[] = [];
    for (const id of dto.restaurantIds) {
      try {
        if (dto.action === 'pause') await this.pause(id, { reason: dto.reason ?? 'Bulk pause' }, req);
        else if (dto.action === 'reactivate') await this.reactivate(id, { reason: dto.reason }, req);
        else if (dto.action === 'suspend') await this.suspend(id, { reason: dto.reason ?? 'Bulk suspend' }, req);
        else if (dto.action === 'apply-tier') {
          if (!dto.commissionTierId) throw new BadRequestException('commissionTierId is required for apply-tier');
          await this.updateCommission(id, { commissionTierId: dto.commissionTierId }, req);
        }
        results.push({ id, ok: true });
      } catch (e: any) {
        results.push({ id, ok: false, error: e.message ?? String(e) });
      }
    }
    return { ok: true, count: results.length, results };
  }

  /** Auto-reactivate restaurants whose admin pause window elapsed. */
  @Cron(CronExpression.EVERY_MINUTE)
  async sweepAutoReactivate() {
    const due = await this.restaurants.find({ where: { status: RestaurantStatus.PAUSED, pausedUntil: LessThanOrEqual(new Date()) } });
    for (const r of due) {
      await this.store.changeStatus(r, RestaurantStatus.LIVE, { action: 'auto_reactivate', acceptingOrders: true, pausedUntil: null }).catch(() => undefined);
    }
  }
}
