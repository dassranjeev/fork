import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DataSource, In, IsNull, Repository } from 'typeorm';
import { randomInt } from 'crypto';
import {
  Cuisine,
  KitchenStation,
  MenuItem,
  Merchant,
  Restaurant,
  RestaurantClosure,
  RestaurantDocument,
  RestaurantHours,
  RestaurantIntegration,
  RestaurantMember,
  Review,
  User,
} from '../database/entities';
import { DocStatus, OrderStatus, RestaurantDocType, RestaurantRole, RestaurantServiceMode, RestaurantStatus, UserStatus, UserType, VerificationAudience } from '../common/enums';
import { verificationSummary } from '../verification/verification-policy';
import { fulfilmentAvailability } from '../common/service-mode';
import { ActorRef, Events, StatusChangedEvent } from '../common/contracts';
import { AuthUser } from '../common/auth.types';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SettingsService } from '../settings/settings.service';
import { RealtimeService } from '../realtime/realtime.module';
import { AvailabilityService } from '../core/core.module';
import { AuthService } from '../auth/auth.service';
import { JwtStrategy } from '../auth/jwt.strategy';
import { PageQueryDto, pageMeta } from '../common/pagination';
import {
  AdminUpdateRestaurantDto,
  ClosureDto,
  DocumentUploadDto,
  FulfilmentDto,
  HoursDto,
  IntegrationDto,
  MemberDto,
  ServiceModeDto,
  StationDto,
  TabletHeartbeatDto,
  UpdateIntegrationDto,
  UpdateMemberDto,
  UpdateStoreDto,
} from './dto';
import { HHMM, tempPassword } from './restaurants.util';

const DOC_TYPES = Object.values(RestaurantDocType) as string[];

import { RatingsAdminService } from '../ratings/ratings-admin.service';
import { RatingAggregatesService } from '../ratings/rating-aggregates.service';

@Injectable()
export class RestaurantStoreService {
  constructor(
    @InjectDataSource() private ds: DataSource,
    @InjectRepository(Restaurant) readonly restaurants: Repository<Restaurant>,
    @InjectRepository(Merchant) readonly merchants: Repository<Merchant>,
    @InjectRepository(Cuisine) private cuisines: Repository<Cuisine>,
    @InjectRepository(RestaurantHours) private hours: Repository<RestaurantHours>,
    @InjectRepository(RestaurantClosure) private closures: Repository<RestaurantClosure>,
    @InjectRepository(RestaurantDocument) readonly docs: Repository<RestaurantDocument>,
    @InjectRepository(KitchenStation) private stations: Repository<KitchenStation>,
    @InjectRepository(RestaurantIntegration) private integrations: Repository<RestaurantIntegration>,
    @InjectRepository(RestaurantMember) private members: Repository<RestaurantMember>,
    @InjectRepository(User) private users: Repository<User>,
    @InjectRepository(Review) private reviews: Repository<Review>,
    @InjectRepository(MenuItem) private items: Repository<MenuItem>,
    private audit: AuditService,
    private notifications: NotificationsService,
    private settings: SettingsService,
    private rt: RealtimeService,
    private events: EventEmitter2,
    private availability: AvailabilityService,
    private auth: AuthService,
    private strategy: JwtStrategy,
    private ratingsAdmin: RatingsAdminService,
    private ratingAggregates: RatingAggregatesService,
  ) {}

  // ------------------------------------------------------------------ helpers
  async get(id: string): Promise<Restaurant> {
    const r = await this.restaurants.findOne({ where: { id } });
    if (!r) throw new NotFoundException('Restaurant not found');
    return r;
  }

  async patchMeta(id: string, patch: Record<string, any>) {
    await this.ds.query(`UPDATE restaurants SET meta = COALESCE(meta,'{}'::jsonb) || $2::jsonb, "updatedAt" = now() WHERE id = $1`, [id, JSON.stringify(patch)]);
  }

  /** Notify the OWNER login(s) of the merchant (approve / reject / suspend messages). */
  async notifyOwners(restaurant: Restaurant, event: string, vars: Record<string, any>) {
    const owners = await this.members.find({ where: { merchantId: restaurant.merchantId, role: RestaurantRole.OWNER, active: true } });
    await Promise.all(owners.map((o) => this.notifications.notify({ userId: o.userId, audience: 'RESTAURANT', event, vars, data: { restaurantId: restaurant.id } })));
    this.rt.emitToRestaurant(restaurant.id, event, { vars });
  }

  /** Literal-text notification to the owner login(s) (for events without a built-in template). */
  async notifyOwnersText(restaurant: Restaurant, event: string, title: string, body: string) {
    const owners = await this.members.find({ where: { merchantId: restaurant.merchantId, role: RestaurantRole.OWNER, active: true } });
    await Promise.all(owners.map((o) => this.notifications.notify({ userId: o.userId, audience: 'RESTAURANT', event, title, body, data: { restaurantId: restaurant.id } })));
  }

  requiredDocTypes(): string[] {
    return this.settings.get<string[]>('restaurant.requiredDocuments', ['BUSINESS_LICENCE', 'HEALTH_CERTIFICATE', 'VOID_CHEQUE']);
  }

  /** Single source for every status transition (admin actions + system). Writes status, reason, audit, event, owner notification. */
  async changeStatus(
    r: Restaurant,
    to: RestaurantStatus,
    opts: { reason?: string | null; actor?: AuthUser | null; req?: any; action: string; notifyEvent?: string; acceptingOrders?: boolean; pausedUntil?: Date | null },
  ) {
    const from = r.status;
    const before = { status: from, statusReason: r.statusReason, acceptingOrders: r.acceptingOrders };
    r.status = to;
    r.statusReason = opts.reason ?? null;
    if (opts.acceptingOrders !== undefined) r.acceptingOrders = opts.acceptingOrders;
    if (opts.pausedUntil !== undefined) r.pausedUntil = opts.pausedUntil;
    if (to === RestaurantStatus.LIVE && !r.wentLiveAt) {
      r.wentLiveAt = new Date();
      r.isNew = true;
    }
    await this.restaurants.save(r);
    const after = { status: r.status, statusReason: r.statusReason, acceptingOrders: r.acceptingOrders };
    if (opts.req) await this.audit.logReq(opts.req, `restaurant.${opts.action}`, 'restaurant', r.id, before, { ...after, reason: opts.reason });
    else await this.audit.log({ actor: opts.actor ?? null, action: `restaurant.${opts.action}`, entity: 'restaurant', entityId: r.id, before, after });
    const actor: ActorRef | undefined = opts.actor ? { type: opts.actor.type === UserType.RESTAURANT ? ('RESTAURANT' as any) : ('STAFF' as any), id: opts.actor.id, name: opts.actor.name } : undefined;
    const payload: StatusChangedEvent = { id: r.id, from, to, reason: opts.reason ?? undefined, actor };
    this.events.emit(Events.RESTAURANT_STATUS_CHANGED, payload);
    this.rt.emitToOps('restaurant.status', { id: r.id, name: r.name, from, to, reason: opts.reason });
    if (opts.notifyEvent) {
      await this.notifyOwners(r, opts.notifyEvent, {
        name: r.name,
        reason: opts.reason ?? '',
        respondBy: new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10),
      });
    }
    return r;
  }

  // ------------------------------------------------------------------ store view / profile
  async view(id: string) {
    const r = await this.restaurants.findOne({ where: { id }, relations: { cuisines: true, commissionTier: true, zone: true } });
    if (!r) throw new NotFoundException('Restaurant not found');
    const [hours, closures, stations, integrations, docs] = await Promise.all([
      this.hours.find({ where: { restaurantId: id }, order: { dayOfWeek: 'ASC', openTime: 'ASC' } }),
      this.closures.find({ where: { restaurantId: id }, order: { startDate: 'DESC' } }),
      this.stations.find({ where: { restaurantId: id }, order: { sortOrder: 'ASC' } }),
      this.integrations.find({ where: { restaurantId: id } }),
      this.docs.find({ where: { restaurantId: id }, order: { createdAt: 'DESC' } }),
    ]);
    const open = await this.availability.status(r).catch(() => ({ open: false }));
    const meta = r.meta ?? {};
    const merchant = await this.merchants.findOne({ where: { id: r.merchantId } });
    // the verification state belongs to the business (merchant): shown on the restaurant page and in the portal
    const verification = merchant ? verificationSummary(VerificationAudience.BUSINESS, merchant) : null;
    return { ...r, ...this.modeInfo(r), hours, closures, stations, integrations, documents: docs, openStatus: open, printers: meta.printers ?? {}, notificationSettings: meta.notificationSettings ?? {}, kdsSettings: meta.kds ?? {}, tablet: meta.tablet ?? {}, verification };
  }

  async updateProfile(id: string, dto: UpdateStoreDto & Partial<AdminUpdateRestaurantDto>, req?: any) {
    const r = await this.get(id);
    const before = JSON.parse(JSON.stringify(r));
    const { cuisineIds, merchantId, ...rest } = dto as any;
    if (rest.slug && rest.slug !== r.slug && (await this.restaurants.exist({ where: { slug: rest.slug } }))) throw new ConflictException('Slug already used');
    if (merchantId && !(await this.merchants.exist({ where: { id: merchantId } }))) throw new BadRequestException('Unknown merchantId');
    for (const [k, v] of Object.entries(rest)) if (v !== undefined) (r as any)[k] = v;
    if (merchantId) r.merchantId = merchantId;
    if (cuisineIds) r.cuisines = cuisineIds.length ? await this.cuisines.find({ where: { id: In(cuisineIds) } }) : [];
    await this.restaurants.save(r);
    if (req) await this.audit.logReq(req, 'restaurant.update', 'restaurant', id, before, dto);
    return this.view(id);
  }

  async updateFulfilment(id: string, dto: FulfilmentDto, req?: any) {
    const r = await this.get(id);
    const before = { ...r, meta: undefined };
    for (const [k, v] of Object.entries(dto)) if (v !== undefined) (r as any)[k] = v;
    if (!r.deliveryEnabled && !r.ownDeliveryEnabled && !r.pickupEnabled) throw new BadRequestException('Enable at least one fulfilment mode (delivery, own drivers or pickup)');
    await this.restaurants.save(r);
    if (req) await this.audit.logReq(req, 'restaurant.fulfilment', 'restaurant', id, before, dto);
    return this.view(id);
  }

  // ------------------------------------------------------------------ hours / closures
  async setHours(id: string, dto: HoursDto, req?: any) {
    await this.get(id);
    const rows: Partial<RestaurantHours>[] = [];
    for (const h of dto.hours) {
      if (!Number.isInteger(h.dayOfWeek) || h.dayOfWeek < 0 || h.dayOfWeek > 6) throw new BadRequestException('dayOfWeek must be 0 (Sunday) .. 6');
      if (!h.closed && (!HHMM.test(h.openTime ?? '') || !HHMM.test(h.closeTime ?? ''))) throw new BadRequestException('openTime/closeTime must be HH:mm');
      rows.push({ restaurantId: id, dayOfWeek: h.dayOfWeek, openTime: h.openTime ?? '00:00', closeTime: h.closeTime ?? '00:00', closed: !!h.closed });
    }
    await this.ds.transaction(async (em) => {
      await em.delete(RestaurantHours, { restaurantId: id });
      if (rows.length) await em.insert(RestaurantHours, rows);
    });
    if (req) await this.audit.logReq(req, 'restaurant.hours', 'restaurant', id, undefined, dto.hours);
    return this.hours.find({ where: { restaurantId: id }, order: { dayOfWeek: 'ASC', openTime: 'ASC' } });
  }

  listHours(id: string) {
    return this.hours.find({ where: { restaurantId: id }, order: { dayOfWeek: 'ASC', openTime: 'ASC' } });
  }

  listClosures(id: string) {
    return this.closures.find({ where: { restaurantId: id }, order: { startDate: 'DESC' } });
  }

  async addClosure(id: string, dto: ClosureDto, req?: any) {
    await this.get(id);
    if (dto.endDate < dto.startDate) throw new BadRequestException('endDate must be on or after startDate');
    const closed = dto.closed ?? true;
    if (!closed && (!HHMM.test(dto.openTime ?? '') || !HHMM.test(dto.closeTime ?? ''))) throw new BadRequestException('Special hours need openTime and closeTime (HH:mm)');
    const c = await this.closures.save(
      this.closures.create({ restaurantId: id, startDate: dto.startDate.slice(0, 10), endDate: dto.endDate.slice(0, 10), closed, openTime: closed ? null : dto.openTime!, closeTime: closed ? null : dto.closeTime!, reason: dto.reason ?? null }),
    );
    if (req) await this.audit.logReq(req, 'restaurant.closure.add', 'restaurant', id, undefined, c);
    return c;
  }

  async removeClosure(id: string, closureId: string, req?: any) {
    const c = await this.closures.findOne({ where: { id: closureId, restaurantId: id } });
    if (!c) throw new NotFoundException('Closure not found');
    await this.closures.delete(closureId);
    if (req) await this.audit.logReq(req, 'restaurant.closure.remove', 'restaurant', id, c);
    return { ok: true };
  }

  // ------------------------------------------------------------------ stations
  listStations(id: string) {
    return this.stations.find({ where: { restaurantId: id }, order: { sortOrder: 'ASC', name: 'ASC' } });
  }
  async addStation(id: string, dto: StationDto) {
    await this.get(id);
    const max = await this.stations.maximum('sortOrder', { restaurantId: id });
    return this.stations.save(this.stations.create({ restaurantId: id, name: dto.name, sortOrder: dto.sortOrder ?? (max ?? -1) + 1 }));
  }
  async updateStation(id: string, stationId: string, dto: Partial<StationDto>) {
    const s = await this.stations.findOne({ where: { id: stationId, restaurantId: id } });
    if (!s) throw new NotFoundException('Station not found');
    if (dto.name !== undefined) s.name = dto.name;
    if (dto.sortOrder !== undefined) s.sortOrder = dto.sortOrder;
    return this.stations.save(s);
  }
  async removeStation(id: string, stationId: string) {
    const s = await this.stations.findOne({ where: { id: stationId, restaurantId: id } });
    if (!s) throw new NotFoundException('Station not found');
    await this.items.update({ restaurantId: id, stationId }, { stationId: null });
    await this.stations.delete(stationId);
    return { ok: true };
  }

  // ------------------------------------------------------------------ busy mode / accepting
  async setBusy(id: string, dto: { extraPrepMin?: number; pauseMinutes?: number }, actor: AuthUser) {
    const r = await this.get(id);
    if (dto.extraPrepMin === undefined && dto.pauseMinutes === undefined) throw new BadRequestException('Provide extraPrepMin and/or pauseMinutes');
    const meta = { ...(r.meta ?? {}) };
    if (dto.extraPrepMin !== undefined) {
      r.busyExtraPrepMin = dto.extraPrepMin;
      meta.busyManual = dto.extraPrepMin > 0;
    }
    if (dto.pauseMinutes) r.pausedUntil = new Date(Date.now() + dto.pauseMinutes * 60_000);
    r.meta = meta;
    await this.restaurants.save(r);
    await this.audit.log({ actor, action: 'restaurant.busy_mode', entity: 'restaurant', entityId: id, after: dto });
    this.rt.emitToOps('restaurant.busy', { id, extraPrepMin: r.busyExtraPrepMin, pausedUntil: r.pausedUntil });
    this.rt.emitToRestaurant(id, 'store.updated', { busyExtraPrepMin: r.busyExtraPrepMin, pausedUntil: r.pausedUntil, acceptingOrders: r.acceptingOrders });
    return { busyExtraPrepMin: r.busyExtraPrepMin, pausedUntil: r.pausedUntil, acceptingOrders: r.acceptingOrders };
  }

  async clearBusy(id: string, actor: AuthUser) {
    const r = await this.get(id);
    r.busyExtraPrepMin = 0;
    r.pausedUntil = null;
    r.meta = { ...(r.meta ?? {}), busyManual: false };
    await this.restaurants.save(r);
    await this.audit.log({ actor, action: 'restaurant.busy_mode.clear', entity: 'restaurant', entityId: id });
    this.rt.emitToRestaurant(id, 'store.updated', { busyExtraPrepMin: 0, pausedUntil: null, acceptingOrders: r.acceptingOrders });
    return { busyExtraPrepMin: 0, pausedUntil: null, acceptingOrders: r.acceptingOrders };
  }

  /**
   * Store on/off switch ("stop taking orders"). Only meaningful while LIVE.
   * Kept coherent with serviceMode: stopping orders == CLOSED; resuming from CLOSED == PICKUP_AND_DELIVERY.
   */
  async setAccepting(id: string, accepting: boolean, actor: AuthUser) {
    const r = await this.get(id);
    if (r.status !== RestaurantStatus.LIVE) throw new BadRequestException(`Store is ${r.status}; it cannot take orders until it is live`);
    if (!accepting) await this.setServiceMode(id, { mode: 'CLOSED' }, actor);
    else if (r.serviceMode === RestaurantServiceMode.CLOSED) await this.setServiceMode(id, { mode: 'PICKUP_AND_DELIVERY' }, actor);
    const fresh = await this.get(id);
    fresh.acceptingOrders = accepting;
    if (accepting) fresh.pausedUntil = null;
    await this.restaurants.save(fresh);
    await this.audit.log({ actor, action: accepting ? 'restaurant.resume_orders' : 'restaurant.pause_orders', entity: 'restaurant', entityId: id });
    this.rt.emitToRestaurant(id, 'store.updated', { acceptingOrders: accepting, ...this.modeInfo(fresh) });
    return { acceptingOrders: accepting, ...this.modeInfo(fresh) };
  }

  // ------------------------------------------------------------------ service mode (CLOSED / PICKUP_ONLY / PICKUP_AND_DELIVERY)
  modeInfo(r: Restaurant) {
    const av = fulfilmentAvailability(r);
    return {
      serviceMode: av.serviceMode,
      serviceModeLabel: av.serviceModeLabel,
      serviceModeUpdatedAt: r.serviceModeUpdatedAt,
      serviceModeResumeAt: r.serviceModeResumeAt,
      pickupAvailable: av.pickupAvailable,
      deliveryAvailable: av.deliveryAvailable,
    };
  }

  /**
   * Single entry point for changing the service mode (store portal and admin console).
   * Orders already placed keep their original fulfilment and carry on; only NEW orders are affected.
   */
  async setServiceMode(id: string, dto: ServiceModeDto, actor?: AuthUser | null, req?: any) {
    const r = await this.get(id);
    const mode = dto.mode as RestaurantServiceMode;
    let resumeAt: Date | null = null;
    if (dto.resumeAt && mode !== RestaurantServiceMode.PICKUP_AND_DELIVERY) {
      resumeAt = new Date(dto.resumeAt);
      if (isNaN(resumeAt.getTime()) || resumeAt.getTime() <= Date.now()) throw new BadRequestException('resumeAt must be a future time');
      if (resumeAt.getTime() > Date.now() + 14 * 86400_000) throw new BadRequestException('resumeAt can be at most 14 days ahead');
    }
    const before = { serviceMode: r.serviceMode, serviceModeResumeAt: r.serviceModeResumeAt, acceptingOrders: r.acceptingOrders };
    const from = r.serviceMode;
    r.serviceMode = mode;
    r.serviceModeUpdatedAt = new Date();
    r.serviceModeResumeAt = resumeAt;
    // keep the legacy on/off switch coherent: CLOSED == not accepting; any open mode == accepting
    r.acceptingOrders = mode !== RestaurantServiceMode.CLOSED;
    if (mode !== RestaurantServiceMode.CLOSED) r.pausedUntil = null;
    await this.restaurants.save(r);
    const after = { serviceMode: r.serviceMode, serviceModeResumeAt: r.serviceModeResumeAt, acceptingOrders: r.acceptingOrders };
    if (req) await this.audit.logReq(req, 'restaurant.service_mode', 'restaurant', id, before, after);
    else await this.audit.log({ actor: actor ?? null, action: 'restaurant.service_mode', entity: 'restaurant', entityId: id, before, after });
    const info = this.modeInfo(r);
    this.rt.emitToRestaurant(id, 'store.updated', { acceptingOrders: r.acceptingOrders, pausedUntil: r.pausedUntil, ...info, changedBy: actor?.name ?? null });
    this.rt.emitToOps('store.updated', { id, name: r.name, ...info });
    this.events.emit(Events.RESTAURANT_SERVICE_MODE_CHANGED, {
      id,
      from,
      to: mode,
      resumeAt,
      actor: actor ? { type: actor.type === UserType.RESTAURANT ? 'RESTAURANT' : 'STAFF', id: actor.id, name: actor.name } : undefined,
    });
    const [row] = await this.ds.query(
      `SELECT COUNT(*)::int AS n FROM orders WHERE "restaurantId" = $1 AND ("kitchenReleaseAt" IS NULL OR "kitchenReleasedAt" IS NOT NULL) AND status IN ($2,$3,$4,$5,$6,$7)`,
      [id, OrderStatus.PLACED, OrderStatus.ACCEPTED, OrderStatus.PREPARING, OrderStatus.READY, OrderStatus.DRIVER_ASSIGNED, OrderStatus.PICKED_UP],
    );
    return { id, ...info, openOrders: row?.n ?? 0 };
  }

  /** Auto switch-back: when serviceModeResumeAt has passed the store returns to PICKUP_AND_DELIVERY. */
  @Cron(CronExpression.EVERY_MINUTE)
  async resumeServiceModes() {
    const due = await this.restaurants
      .createQueryBuilder('r')
      .where('r.serviceModeResumeAt IS NOT NULL AND r.serviceModeResumeAt <= now() AND r.serviceMode != :m', { m: RestaurantServiceMode.PICKUP_AND_DELIVERY })
      .getMany();
    for (const r of due) {
      await this.setServiceMode(r.id, { mode: 'PICKUP_AND_DELIVERY' }, null).catch(() => undefined);
    }
  }

  // ------------------------------------------------------------------ printers / notifications / kds settings (Restaurant.meta)
  async setPrinters(id: string, dto: { receiptPrinterEnabled?: boolean; kitchenPrinterEnabled?: boolean; config?: Record<string, any> }) {
    const r = await this.get(id);
    if (dto.receiptPrinterEnabled !== undefined) r.receiptPrinterEnabled = dto.receiptPrinterEnabled;
    if (dto.kitchenPrinterEnabled !== undefined) r.kitchenPrinterEnabled = dto.kitchenPrinterEnabled;
    if (dto.config) r.meta = { ...(r.meta ?? {}), printers: { ...(r.meta?.printers ?? {}), ...dto.config } };
    await this.restaurants.save(r);
    return { receiptPrinterEnabled: r.receiptPrinterEnabled, kitchenPrinterEnabled: r.kitchenPrinterEnabled, config: r.meta?.printers ?? {} };
  }

  async setNotificationSettings(id: string, settings: Record<string, any>) {
    const r = await this.get(id);
    r.meta = { ...(r.meta ?? {}), notificationSettings: { ...(r.meta?.notificationSettings ?? {}), ...settings } };
    await this.restaurants.save(r);
    return r.meta.notificationSettings;
  }

  async setKdsSettings(id: string, settings: Record<string, any>) {
    const r = await this.get(id);
    r.meta = { ...(r.meta ?? {}), kds: { ...(r.meta?.kds ?? {}), ...settings } };
    await this.restaurants.save(r);
    return r.meta.kds;
  }

  // ------------------------------------------------------------------ tablet
  /** Ops / owner: issue a fresh one-time activation code (6 digits). Deactivates the current tablet. */
  async issueTabletCode(id: string, actor?: AuthUser) {
    const r = await this.get(id);
    r.tabletCode = String(randomInt(100000, 999999));
    r.tabletActivated = false;
    await this.restaurants.save(r);
    if (actor) await this.audit.log({ actor, action: 'restaurant.tablet.code', entity: 'restaurant', entityId: id });
    return { tabletCode: r.tabletCode, tabletActivated: false };
  }

  async activateTablet(id: string, code: string | null, deviceId?: string, actor?: AuthUser, force = false) {
    const r = await this.get(id);
    if (!force) {
      if (!r.tabletCode || r.tabletCode !== code) throw new BadRequestException('Invalid activation code');
    }
    r.tabletActivated = true;
    r.meta = { ...(r.meta ?? {}), tablet: { ...(r.meta?.tablet ?? {}), deviceId: deviceId ?? r.meta?.tablet?.deviceId ?? null, activatedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() } };
    await this.restaurants.save(r);
    await this.audit.log({ actor: actor ?? null, action: 'restaurant.tablet.activate', entity: 'restaurant', entityId: id, after: { deviceId } });
    return { tabletActivated: true };
  }

  async heartbeat(id: string, dto: TabletHeartbeatDto) {
    const r = await this.get(id);
    const tablet = { ...(r.meta?.tablet ?? {}), lastSeenAt: new Date().toISOString(), appVersion: dto.appVersion ?? r.meta?.tablet?.appVersion, battery: dto.battery ?? null, network: dto.network ?? null, queuedActions: dto.queuedActions ?? 0, deviceId: dto.deviceId ?? r.meta?.tablet?.deviceId };
    await this.patchMeta(id, { tablet });
    const [row] = await this.ds.query(`SELECT COUNT(*)::int AS n FROM orders WHERE "restaurantId" = $1 AND ("kitchenReleaseAt" IS NULL OR "kitchenReleasedAt" IS NOT NULL) AND status = 'PLACED'`, [id]);
    const [row2] = await this.ds.query(`SELECT COUNT(*)::int AS n FROM orders WHERE "restaurantId" = $1 AND ("kitchenReleaseAt" IS NULL OR "kitchenReleasedAt" IS NOT NULL) AND status IN ('ACCEPTED','DRIVER_ASSIGNED','PREPARING')`, [id]);
    const open = await this.availability.status(r).catch(() => ({ open: false }));
    return {
      serverTime: new Date().toISOString(),
      pendingOrders: row?.n ?? 0,
      inKitchen: row2?.n ?? 0,
      config: {
        restaurantStatus: r.status,
        acceptingOrders: r.acceptingOrders,
        ...this.modeInfo(r),
        pausedUntil: r.pausedUntil,
        busyExtraPrepMin: r.busyExtraPrepMin,
        prepTimeMin: r.prepTimeMin,
        pickupPrepTimeMin: r.pickupPrepTimeMin,
        autoRejectSeconds: r.autoRejectSeconds,
        kdsEnabled: r.kdsEnabled,
        tabletActivated: r.tabletActivated,
        receiptPrinterEnabled: r.receiptPrinterEnabled,
        kitchenPrinterEnabled: r.kitchenPrinterEnabled,
        printers: r.meta?.printers ?? {},
        kds: r.meta?.kds ?? {},
        notificationSettings: r.meta?.notificationSettings ?? {},
        open: open.open,
      },
    };
  }

  // ------------------------------------------------------------------ integrations (POS)
  listIntegrations(id: string) {
    return this.integrations.find({ where: { restaurantId: id } });
  }
  async addIntegration(id: string, dto: IntegrationDto) {
    await this.get(id);
    return this.integrations.save(this.integrations.create({ restaurantId: id, provider: dto.provider, status: dto.status ?? 'DISCONNECTED', config: dto.config ?? {} }));
  }
  async updateIntegration(id: string, integrationId: string, dto: UpdateIntegrationDto) {
    const i = await this.integrations.findOne({ where: { id: integrationId, restaurantId: id } });
    if (!i) throw new NotFoundException('Integration not found');
    if (dto.status !== undefined) i.status = dto.status;
    if (dto.config) i.config = { ...i.config, ...dto.config };
    if (dto.status === 'CONNECTED') i.lastSyncAt = new Date();
    return this.integrations.save(i);
  }
  async removeIntegration(id: string, integrationId: string) {
    await this.integrations.delete({ id: integrationId, restaurantId: id });
    return { ok: true };
  }

  // ------------------------------------------------------------------ documents
  listDocuments(id: string) {
    return this.docs.find({ where: { restaurantId: id }, order: { type: 'ASC', createdAt: 'DESC' } });
  }

  async uploadDocument(id: string, dto: DocumentUploadDto, actor: AuthUser) {
    const r = await this.get(id);
    if (!DOC_TYPES.includes(dto.type)) throw new BadRequestException(`type must be one of ${DOC_TYPES.join(', ')}`);
    const doc = await this.docs.save(
      this.docs.create({ restaurantId: id, type: dto.type as RestaurantDocType, fileUrl: dto.fileUrl, fileName: dto.fileName ?? null, expiresAt: dto.expiresAt ? dto.expiresAt.slice(0, 10) : null, status: DocStatus.PENDING }),
    );
    if (r.status === RestaurantStatus.APPLIED) await this.restaurants.update(id, { status: RestaurantStatus.DOCS_REVIEW });
    await this.audit.log({ actor, action: 'restaurant.document.upload', entity: 'restaurant', entityId: id, after: { type: dto.type, docId: doc.id } });
    this.notifications.notifyOps('restaurant.document_uploaded', { name: r.name, docType: dto.type }, { restaurantId: id }).catch(() => undefined);
    return doc;
  }

  /** required document checklist: latest doc per required type */
  async documentChecklist(id: string) {
    const docs = await this.docs.find({ where: { restaurantId: id }, order: { createdAt: 'DESC' } });
    const required = this.requiredDocTypes();
    const items = required.map((type) => {
      const latest = docs.find((d) => d.type === type) ?? null;
      return { type, required: true, status: latest?.status ?? 'MISSING', docId: latest?.id ?? null, expiresAt: latest?.expiresAt ?? null, rejectReason: latest?.rejectReason ?? null };
    });
    return { items, allApproved: items.every((i) => i.status === DocStatus.APPROVED), approved: items.filter((i) => i.status === DocStatus.APPROVED).length, total: items.length };
  }

  // ------------------------------------------------------------------ members
  private async assertLocation(merchantId: string, restaurantId: string) {
    if (!(await this.restaurants.exist({ where: { id: restaurantId, merchantId } }))) throw new BadRequestException('restaurantId does not belong to this merchant');
  }

  async listMembers(merchantId: string, restaurantId?: string | null) {
    const qb = this.members
      .createQueryBuilder('m')
      .leftJoinAndSelect('m.user', 'u')
      .where('m.merchantId = :merchantId', { merchantId })
      .orderBy('m.role', 'ASC')
      .addOrderBy('m.createdAt', 'ASC');
    if (restaurantId) qb.andWhere('(m.restaurantId IS NULL OR m.restaurantId = :restaurantId)', { restaurantId });
    const rows = await qb.getMany();
    const names = new Map((await this.restaurants.find({ where: { merchantId }, select: ['id', 'name'] })).map((r) => [r.id, r.name]));
    return rows.map((m) => ({
      id: m.id,
      userId: m.userId,
      role: m.role,
      active: m.active,
      restaurantId: m.restaurantId,
      restaurantName: m.restaurantId ? names.get(m.restaurantId) ?? null : 'All locations',
      firstName: m.user?.firstName,
      lastName: m.user?.lastName,
      email: m.user?.email,
      phone: m.user?.phone,
      userStatus: m.user?.status,
      lastLoginAt: m.user?.lastLoginAt,
      createdAt: m.createdAt,
    }));
  }

  /**
   * Create a login (User type RESTAURANT) + membership. `scope` limits what the caller may create:
   * managers can only add CASHIER / KITCHEN staff at their own locations.
   */
  async createMember(merchantId: string, dto: MemberDto, defaultRestaurantId: string | null, actor: AuthUser, scope?: { locations: string[]; role: RestaurantRole }, req?: any) {
    const role = dto.role as RestaurantRole;
    if (scope && scope.role !== RestaurantRole.OWNER && ![RestaurantRole.CASHIER, RestaurantRole.KITCHEN].includes(role)) throw new ForbiddenException('Managers can only add cashiers and kitchen staff');
    let restaurantId: string | null = null;
    if (role !== RestaurantRole.OWNER) {
      restaurantId = dto.restaurantId ?? defaultRestaurantId;
      if (!restaurantId) throw new BadRequestException('restaurantId is required for this role');
      await this.assertLocation(merchantId, restaurantId);
      if (scope && !scope.locations.includes(restaurantId)) throw new ForbiddenException('You do not manage this location');
    }
    const email = dto.email.toLowerCase();
    if (await this.users.exist({ where: { email } })) throw new ConflictException('Email already registered');
    const phone = dto.phone ? this.auth.normalizePhone(dto.phone) : null;
    if (phone && (await this.users.exist({ where: { phone } }))) throw new ConflictException('Phone already registered');
    const password = dto.password ?? tempPassword();
    const user = await this.users.save(
      this.users.create({ type: UserType.RESTAURANT, status: UserStatus.ACTIVE, email, phone, firstName: dto.firstName, lastName: dto.lastName, emailVerified: true, passwordHash: await this.auth.hash(password) }),
    );
    const member = await this.members.save(this.members.create({ userId: user.id, merchantId, restaurantId, role, active: true }));
    await this.finishMemberAudit(req, actor, 'restaurant.member.create', member.id, { email, role, restaurantId });
    return { member: { ...member, email, firstName: user.firstName, lastName: user.lastName }, temporaryPassword: dto.password ? undefined : password };
  }

  private async finishMemberAudit(req: any, actor: AuthUser, action: string, id: string, after: any) {
    if (req) await this.audit.logReq(req, action, 'restaurant_member', id, undefined, after);
    else await this.audit.log({ actor, action, entity: 'restaurant_member', entityId: id, after });
  }

  private async memberFor(merchantId: string, memberId: string, scope?: { locations: string[]; role: RestaurantRole }) {
    const m = await this.members.findOne({ where: { id: memberId, merchantId } });
    if (!m) throw new NotFoundException('Member not found');
    if (scope && scope.role !== RestaurantRole.OWNER) {
      if (!m.restaurantId || !scope.locations.includes(m.restaurantId) || ![RestaurantRole.CASHIER, RestaurantRole.KITCHEN].includes(m.role)) throw new ForbiddenException('You cannot manage this member');
    }
    return m;
  }

  async updateMember(merchantId: string, memberId: string, dto: UpdateMemberDto, actor: AuthUser, scope?: { locations: string[]; role: RestaurantRole }, req?: any) {
    const m = await this.memberFor(merchantId, memberId, scope);
    const before = { role: m.role, active: m.active, restaurantId: m.restaurantId };
    if (dto.role) {
      if (scope && scope.role !== RestaurantRole.OWNER && ![RestaurantRole.CASHIER, RestaurantRole.KITCHEN].includes(dto.role as RestaurantRole)) throw new ForbiddenException('Managers can only assign cashier / kitchen roles');
      if (m.role === RestaurantRole.OWNER && dto.role !== 'OWNER') {
        const owners = await this.members.count({ where: { merchantId, role: RestaurantRole.OWNER, active: true } });
        if (owners <= 1) throw new BadRequestException('A merchant needs at least one active owner');
      }
      m.role = dto.role as RestaurantRole;
      if (m.role === RestaurantRole.OWNER) m.restaurantId = null;
    }
    if (dto.restaurantId && m.role !== RestaurantRole.OWNER) {
      await this.assertLocation(merchantId, dto.restaurantId);
      if (scope && !scope.locations.includes(dto.restaurantId)) throw new ForbiddenException('You do not manage that location');
      m.restaurantId = dto.restaurantId;
    }
    if (m.role !== RestaurantRole.OWNER && !m.restaurantId) throw new BadRequestException('restaurantId is required for this role');
    if (dto.active !== undefined) {
      if (!dto.active && m.role === RestaurantRole.OWNER) {
        const owners = await this.members.count({ where: { merchantId, role: RestaurantRole.OWNER, active: true } });
        if (owners <= 1 && m.active) throw new BadRequestException('A merchant needs at least one active owner');
      }
      m.active = dto.active;
    }
    await this.members.save(m);
    const userPatch: Partial<User> = {};
    if (dto.firstName !== undefined) userPatch.firstName = dto.firstName;
    if (dto.lastName !== undefined) userPatch.lastName = dto.lastName;
    if (dto.phone !== undefined) userPatch.phone = this.auth.normalizePhone(dto.phone);
    if (dto.active !== undefined) {
      const other = await this.members.count({ where: { userId: m.userId, active: true } });
      userPatch.status = dto.active || other > 0 ? UserStatus.ACTIVE : UserStatus.SUSPENDED;
    }
    if (Object.keys(userPatch).length) await this.users.update(m.userId, userPatch);
    this.strategy.invalidate(m.userId);
    await this.finishMemberAudit(req, actor, 'restaurant.member.update', m.id, { before, dto });
    return (await this.listMembers(merchantId)).find((x) => x.id === m.id);
  }

  async resetMemberPassword(merchantId: string, memberId: string, actor: AuthUser, scope?: { locations: string[]; role: RestaurantRole }, req?: any) {
    const m = await this.memberFor(merchantId, memberId, scope);
    const pw = tempPassword();
    await this.users.update(m.userId, { passwordHash: await this.auth.hash(pw), passwordChangedAt: new Date(), failedLoginCount: 0, lockedUntil: null });
    await this.ds.query(`UPDATE refresh_tokens SET "revokedAt" = now() WHERE "userId" = $1 AND "revokedAt" IS NULL`, [m.userId]).catch(() => undefined);
    this.strategy.invalidate(m.userId);
    await this.finishMemberAudit(req, actor, 'restaurant.member.reset_password', m.id, {});
    return { temporaryPassword: pw };
  }

  async removeMember(merchantId: string, memberId: string, actor: AuthUser, scope?: { locations: string[]; role: RestaurantRole }, req?: any) {
    return this.updateMember(merchantId, memberId, { active: false }, actor, scope, req);
  }

  // ------------------------------------------------------------------ reviews
  /** restaurantIds = null => no restaurant restriction (admin, cross-store moderation view). */
  async listReviews(restaurantIds: string[] | null, q: PageQueryDto & { status?: string; maxRating?: string; replied?: string; restaurantId?: string }) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 20;
    const qb = this.reviews
      .createQueryBuilder('rv')
      .leftJoin('orders', 'o', 'o.id = rv.orderId')
      .leftJoin('users', 'u', 'u.id = rv.customerId')
      .leftJoin('restaurants', 'r', 'r.id = rv.restaurantId')
      .select([
        'rv.id AS id',
        'rv.orderId AS "orderId"',
        'rv.restaurantId AS "restaurantId"',
        'r.name AS "restaurantName"',
        'rv.restaurantRating AS rating',
        'rv.restaurantTags AS tags',
        'rv.comment AS comment',
        'rv.reply AS reply',
        'rv.repliedAt AS "repliedAt"',
        'rv.status AS status',
        'rv.reportedAt AS "reportedAt"',
        'rv.reportReason AS "reportReason"',
        'rv.editCount AS "editCount"',
        'rv.flagReasons AS "flagReasons"',
        'rv.moderation AS moderation',
        'rv.createdAt AS "createdAt"',
        'o.code AS "orderCode"',
        `TRIM(COALESCE(u."firstName", '') || ' ' || COALESCE(LEFT(u."lastName", 1) || '.', '')) AS "customerName"`,
      ])
      .where('rv.restaurantRating IS NOT NULL');
    if (restaurantIds) qb.andWhere('rv.restaurantId IN (:...ids)', { ids: restaurantIds.length ? restaurantIds : ['00000000-0000-0000-0000-000000000000'] });
    if (q.restaurantId) qb.andWhere('rv.restaurantId = :single', { single: q.restaurantId });
    if (q.status) qb.andWhere('rv.status = :st', { st: q.status });
    if (q.maxRating) qb.andWhere('rv.restaurantRating <= :mr', { mr: +q.maxRating });
    if (q.replied === 'true') qb.andWhere('rv.reply IS NOT NULL');
    if (q.replied === 'false') qb.andWhere('rv.reply IS NULL');
    if (q.search) qb.andWhere('rv.comment ILIKE :s', { s: `%${q.search}%` });
    const total = await qb.getCount();
    const data = await qb.orderBy('rv.createdAt', 'DESC').offset((page - 1) * limit).limit(limit).getRawMany();
    if (restaurantIds) for (const d of data) { delete d.flagReasons; delete d.moderation; } // internal fraud/moderation detail is staff-only
    return { data, meta: pageMeta(total, page, limit) };
  }

  async reply(reviewId: string, restaurantIds: string[], reply: string, actor: AuthUser) {
    const rv = await this.reviews.findOne({ where: { id: reviewId } });
    if (!rv || !restaurantIds.includes(rv.restaurantId)) throw new NotFoundException('Review not found');
    rv.reply = reply.trim();
    rv.repliedAt = new Date();
    await this.reviews.save(rv);
    await this.audit.log({ actor, action: 'review.reply', entity: 'review', entityId: reviewId, after: { reply: rv.reply } });
    this.notifications.notify({ userId: rv.customerId, audience: 'CUSTOMER', event: 'review.reply', title: 'The restaurant replied to your review', body: rv.reply, data: { reviewId } }).catch(() => undefined);
    return rv;
  }

  /** Staff moderation (restaurants:approve). Delegates to the ratings module: reason required, audit-logged, aggregates refreshed. */
  async moderate(reviewId: string, status: 'VISIBLE' | 'HIDDEN' | 'FLAGGED', reason: string | undefined, req: any) {
    const action = status === 'HIDDEN' ? 'HIDE' : status === 'FLAGGED' ? 'FLAG' : 'RESTORE';
    return this.ratingsAdmin.moderate(reviewId, 'RESTAURANT', action, reason ?? '', req);
  }

  async recomputeRating(restaurantId: string) {
    await this.ratingAggregates.refresh({ restaurantIds: [restaurantId] });
  }

  // ------------------------------------------------------------------ performance stats (spec 12: Restaurant Performance)
  async stats(restaurantId: string, q: { from?: string; to?: string; days?: number } = {}) {
    const to = q.to ? new Date(q.to) : new Date();
    const from = q.from ? new Date(q.from) : new Date(to.getTime() - (q.days ?? 30) * 86400_000);
    const [o] = await this.ds.query(
      `SELECT
         COUNT(*)::int AS orders,
         COUNT(*) FILTER (WHERE "acceptedAt" IS NOT NULL)::int AS accepted,
         COUNT(*) FILTER (WHERE status = 'REJECTED')::int AS rejected,
         COUNT(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled,
         COUNT(*) FILTER (WHERE status = 'CANCELLED' AND "acceptedAt" IS NOT NULL)::int AS "cancelledAfterAccept",
         COUNT(*) FILTER (WHERE status IN ('DELIVERED','COLLECTED'))::int AS completed,
         COUNT(*) FILTER (WHERE status = 'PLACED')::int AS "inFlight",
         COALESCE(SUM(subtotal) FILTER (WHERE status IN ('DELIVERED','COLLECTED')),0)::float AS sales,
         COALESCE(AVG(subtotal) FILTER (WHERE status IN ('DELIVERED','COLLECTED')),0)::float AS aov,
         COUNT(*) FILTER (WHERE "readyAt" IS NOT NULL AND "estimatedReadyAt" IS NOT NULL)::int AS "prepMeasured",
         COUNT(*) FILTER (WHERE "readyAt" IS NOT NULL AND "estimatedReadyAt" IS NOT NULL AND "readyAt" <= "estimatedReadyAt" + interval '2 minutes')::int AS "prepOnTime",
         COALESCE(AVG(EXTRACT(EPOCH FROM ("readyAt" - COALESCE("acceptedAt","createdAt")))/60) FILTER (WHERE "readyAt" IS NOT NULL),0)::float AS "avgPrepMin",
         COALESCE(AVG(EXTRACT(EPOCH FROM ("acceptedAt" - "createdAt"))) FILTER (WHERE "acceptedAt" IS NOT NULL),0)::float AS "avgAcceptSec"
       FROM orders WHERE "restaurantId" = $1 AND ("kitchenReleaseAt" IS NULL OR "kitchenReleasedAt" IS NOT NULL) AND "createdAt" >= $2 AND "createdAt" <= $3`,
      [restaurantId, from, to],
    );
    let errorOrders = 0;
    try {
      const [e] = await this.ds.query(
        `SELECT COUNT(DISTINCT rf."orderId")::int AS n FROM refunds rf JOIN orders o ON o.id = rf."orderId"
         WHERE o."restaurantId" = $1 AND rf."chargedTo" = 'RESTAURANT' AND o."createdAt" >= $2 AND o."createdAt" <= $3`,
        [restaurantId, from, to],
      );
      errorOrders = e?.n ?? 0;
    } catch {
      errorOrders = 0;
    }
    const r = await this.get(restaurantId);
    const decided = Math.max(0, o.orders - o.inFlight); // orders whose accept/reject decision is final
    const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
    return {
      restaurantId,
      period: { from, to },
      orders: o.orders,
      completed: o.completed,
      rejected: o.rejected,
      cancelled: o.cancelled,
      cancelledAfterAccept: o.cancelledAfterAccept,
      acceptanceRate: pct(o.accepted, Math.max(decided, o.accepted)),
      cancellationRate: pct(o.cancelled, o.orders),
      prepAccuracy: pct(o.prepOnTime, o.prepMeasured),
      avgPrepMinutes: Math.round(o.avgPrepMin * 10) / 10,
      avgAcceptSeconds: Math.round(o.avgAcceptSec),
      errorRate: pct(errorOrders, o.completed),
      errorOrders,
      sales: Math.round(o.sales * 100) / 100,
      avgOrderValue: Math.round(o.aov * 100) / 100,
      avgRating: r.rating,
      ratingCount: r.ratingCount,
      reliabilityScore: r.reliabilityScore,
    };
  }

  // ------------------------------------------------------------------ portal dashboard
  async dashboard(restaurantId: string) {
    const r = await this.get(restaurantId);
    const open = await this.availability.status(r).catch(() => ({ open: false }));
    const [today] = await this.ds.query(
      `SELECT
         COUNT(*)::int AS orders,
         COALESCE(SUM(total) FILTER (WHERE status IN ('DELIVERED','COLLECTED')),0)::float AS sales,
         COUNT(*) FILTER (WHERE status = 'PLACED')::int AS "pendingAccept",
         COUNT(*) FILTER (WHERE status IN ('ACCEPTED','DRIVER_ASSIGNED','PREPARING'))::int AS "inKitchen",
         COUNT(*) FILTER (WHERE status = 'READY')::int AS ready,
         COUNT(*) FILTER (WHERE "isLate")::int AS late
       FROM orders WHERE "restaurantId" = $1 AND ("kitchenReleaseAt" IS NULL OR "kitchenReleasedAt" IS NOT NULL) AND "createdAt" >= date_trunc('day', now())`,
      [restaurantId],
    );
    const checklist = await this.documentChecklist(restaurantId);
    return {
      restaurant: {
        id: r.id,
        name: r.name,
        status: r.status,
        acceptingOrders: r.acceptingOrders,
        ...this.modeInfo(r),
        pausedUntil: r.pausedUntil,
        busyExtraPrepMin: r.busyExtraPrepMin,
        rating: r.rating,
        ratingCount: r.ratingCount,
        reliabilityScore: r.reliabilityScore,
        kdsEnabled: r.kdsEnabled,
        tabletActivated: r.tabletActivated,
      },
      open,
      today,
      documentChecklist: checklist,
    };
  }

  // ------------------------------------------------------------------ document expiry reminders (SOP-01 compliance)
  @Cron(CronExpression.EVERY_DAY_AT_8AM)
  async sweepDocumentExpiry() {
    const days = this.settings.get<number[]>('restaurant.docExpiryReminderDays', [30, 14, 7, 1]);
    for (const d of days) {
      const target = new Date();
      target.setDate(target.getDate() + d);
      const dateStr = target.toISOString().slice(0, 10);
      const due = await this.docs.find({ where: { status: DocStatus.APPROVED, expiresAt: dateStr } });
      for (const doc of due) {
        const r = await this.restaurants.findOne({ where: { id: doc.restaurantId } });
        if (!r) continue;
        await this.notifyOwnersText(r, 'document.expiring', 'Document expiring soon', `Your ${doc.type} expires on ${doc.expiresAt}. Upload a renewed copy to stay live.`);
        this.notifications.notifyOps('document.expiring', { subject: r.name, docType: doc.type, expiresAt: doc.expiresAt }, { restaurantId: r.id }).catch(() => undefined);
      }
    }
  }
}
