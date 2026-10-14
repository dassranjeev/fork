import { BadRequestException, ConflictException, ForbiddenException, GoneException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Cron } from '@nestjs/schedule';
import { createHash, timingSafeEqual } from 'crypto';
import { existsSync } from 'fs';
import { readFile, unlink, writeFile } from 'fs/promises';
import { join } from 'path';
import { Between, In, IsNull, LessThan, Not, Repository } from 'typeorm';
import { DeliveryProof, DriverLocationLog, DriverProfile, Order, OrderEvent, Ticket, UploadedFile } from '../database/entities';
import { ActorType, DeliveryAction, DropoffMethod, FulfilmentMode, OrderStatus, ProofExceptionReason, ProofType, TicketStatus } from '../common/enums';
import { haversineKm } from '../common/geo.util';
import { stripImageMetadata } from '../common/image-meta';
import { SettingsService } from '../settings/settings.service';
import { AuditService } from '../audit/audit.service';
import { RealtimeService } from '../realtime/realtime.module';
import { NotificationsService } from '../notifications/notifications.service';
import { UploadsService } from '../uploads/uploads.module';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { backfillDeliveryInstructions } from './delivery-backfill';

export interface ProofRequirement {
  method: DropoffMethod;
  /** PIN | PHOTO | NONE */
  rule: 'PIN' | 'PHOTO' | 'NONE';
  pinRequired: boolean;
  photoRequired: boolean;
  label: string;
  exceptionReasons: string[];
  /** PIN off + not contactless: the driver chooses between these (HANDED_TO_CUSTOMER needs no photo, LEFT_AT_LOCATION needs one) */
  deliveryActions?: { value: string; label: string; photoRequired: boolean }[];
}

export interface ProofInput {
  pin?: string;
  proofPhotoUrl?: string;
  deliveryAction?: string;
  lat?: number;
  lng?: number;
  accuracy?: number;
  capturedAt?: string;
  exceptionReason?: string;
  note?: string;
}

/** Validated, not-yet-persisted evidence. Built by prepare(), written by persist() when the order really becomes DELIVERED. */
export interface ProofDraft {
  method: DropoffMethod;
  proofType: ProofType;
  strength: 'STRONG' | 'WEAK';
  pinVerified: boolean;
  exceptionReason: string | null;
  exceptionNote: string | null;
  photo: null | { srcFile: string; buf: Buffer; sha256: string; mime: string; lat: number; lng: number; accuracy: number; capturedAt: Date };
  claimed: { lat: number | null; lng: number | null };
  distanceMeters: number | null;
  serverGpsDistanceMeters: number | null;
  geofenceMeters: number | null;
  flags: string[];
  breadcrumb: Record<string, any> | null;
  device: Record<string, any>;
  deliveryAction?: string | null;
  actorUserId?: string;
}

const MAX_PIN_FAILURES = 5;
const FLAGS_THAT_WEAKEN = ['GEOFENCE_OVERRIDE', 'GPS_MISMATCH', 'GPS_UNVERIFIED', 'LOW_ACCURACY', 'STAFF_FORCED', 'NO_DROPOFF_COORDS'];

/** constant-time PIN comparison; empty / oversize never matches */
export function pinMatches(given: string | undefined | null, expected: string | null | undefined): boolean {
  if (typeof given !== 'string' || !expected || !given.length || given.length > 10) return false;
  const a = Buffer.from(given.trim());
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

@Injectable()
export class ProofService implements OnModuleInit {
  private readonly logger = new Logger(ProofService.name);

  /** migration-like boot step (idempotent): contactless history -> LEAVE_AT_DOOR, demo customers' saved delivery defaults */
  async onModuleInit() {
    try {
      await backfillDeliveryInstructions(this.ds, { demo: this.config.get<boolean>('seed.demoData') ?? false });
    } catch (e) {
      this.logger.warn(`delivery backfill skipped: ${(e as Error).message}`);
    }
  }

  constructor(
    @InjectDataSource() private ds: DataSource,
    private settings: SettingsService,
    private config: ConfigService,
    private uploads: UploadsService,
    private audit: AuditService,
    private rt: RealtimeService,
    private notifications: NotificationsService,
    @InjectRepository(DeliveryProof) private proofs: Repository<DeliveryProof>,
    @InjectRepository(UploadedFile) private registry: Repository<UploadedFile>,
    @InjectRepository(DriverLocationLog) private logs: Repository<DriverLocationLog>,
    @InjectRepository(DriverProfile) private drivers: Repository<DriverProfile>,
    @InjectRepository(Order) private orders: Repository<Order>,
    @InjectRepository(OrderEvent) private events: Repository<OrderEvent>,
    @InjectRepository(Ticket) private tickets: Repository<Ticket>,
  ) {}

  // ------------------------------------------------------------------ rules
  /** Should a new/changed order of this kind carry a delivery PIN? Only the customer's usePin choice decides (PIN methods, delivery only). */
  shouldHavePin(method: DropoffMethod, total: number, fulfilment: FulfilmentMode, usePin = true): boolean {
    // the customer decides: usePin=false means no PIN, and the driver must photograph the delivered order instead
    if (fulfilment === FulfilmentMode.PICKUP || method === DropoffMethod.LEAVE_AT_DOOR || !usePin) return false;
    return true; // the customer's choice is final: not overridden by order value or any setting
  }

  requirementFor(order: Pick<Order, 'fulfilment' | 'dropoffMethod' | 'requiresPin'>, action?: string | null): ProofRequirement {
    const method = order.dropoffMethod ?? DropoffMethod.HAND_TO_ME;
    const exceptionReasons = Object.values(ProofExceptionReason) as string[];
    if (order.fulfilment === FulfilmentMode.PICKUP) return { method, rule: 'NONE', pinRequired: false, photoRequired: false, label: 'No proof needed (pickup)', exceptionReasons: [] };
    const pinRequired = method !== DropoffMethod.LEAVE_AT_DOOR && !!order.requiresPin;
    // photo: contactless always; any delivery without a PIN (customer opted out); optionally every delivery (delivery.proof.photoAlways)
    const photoRequired =
      method === DropoffMethod.LEAVE_AT_DOOR
        ? true // contactless ALWAYS needs a photo taken in the app at the drop-off location (no setting can switch this off)
        : // PIN off: leaving the order needs a photo; handing it to the customer in person does not (photo then optional)
          this.settings.get<boolean>('delivery.proof.photoAlways', false) || (!pinRequired && action !== DeliveryAction.HANDED_TO_CUSTOMER);
    const choose = !pinRequired && method !== DropoffMethod.LEAVE_AT_DOOR && !this.settings.get<boolean>('delivery.proof.photoAlways', false);
    const deliveryActions = choose
      ? [
          { value: DeliveryAction.HANDED_TO_CUSTOMER, label: 'Handed to the customer', photoRequired: false },
          { value: DeliveryAction.LEFT_AT_LOCATION, label: 'Delivered (left at the location) - photo required', photoRequired: true },
        ]
      : undefined;
    return { method, deliveryActions, rule: pinRequired ? 'PIN' : photoRequired ? 'PHOTO' : 'NONE', pinRequired, photoRequired, label: pinRequired && photoRequired ? 'PIN and photo required' : pinRequired ? 'PIN required' : photoRequired ? 'Photo required' : 'No proof required', exceptionReasons };
  }

  private geofence() {
    return { enforce: this.settings.get<boolean>('delivery.proof.requireGeofence', true), meters: Math.max(10, Number(this.settings.get<number>('delivery.proof.geofenceMeters', 100))) };
  }

  // ------------------------------------------------------------------ validation (before the order is changed)
  async prepare(order: Order, driver: DriverProfile, input: ProofInput, ctx: { ip?: string; userAgent?: string } = {}): Promise<ProofDraft> {
    if (!order.driverArrivedCustomerAt) throw new BadRequestException('Mark "arrived at customer" before completing the delivery');
    const action = input.deliveryAction ?? null;
    if (action && !(Object.values(DeliveryAction) as string[]).includes(action)) throw new BadRequestException('Unknown delivery action');
    if (action && (order.requiresPin || order.dropoffMethod === DropoffMethod.LEAVE_AT_DOOR)) throw new BadRequestException('deliveryAction only applies to orders where the customer turned the PIN off');
    const req = this.requirementFor(order, action);
    const gf = this.geofence();
    const flags: string[] = [];
    const exception = input.exceptionReason ?? null;
    if (exception && !(Object.values(ProofExceptionReason) as string[]).includes(exception)) throw new BadRequestException('Unknown exception reason');

    // ---- PIN (constant-time, attempts limited per order)
    let pinVerified = false;
    if (input.pin) {
      const failures = Number(order.meta?.pinFailures ?? 0);
      if (failures >= MAX_PIN_FAILURES) throw new ForbiddenException('Too many wrong PIN attempts - use the exception path (photo + reason) instead');
      if (!req.pinRequired || !order.deliveryPin) throw new BadRequestException('This order does not use a delivery PIN');
      if (pinMatches(input.pin, order.deliveryPin)) {
        pinVerified = true;
      } else {
        await this.orders.update(order.id, { meta: { ...(order.meta ?? {}), pinFailures: failures + 1 } } as any);
        await this.event(order.id, 'PROOF_REJECTED', ActorType.DRIVER, driver.id, 'Wrong delivery PIN', { reason: 'WRONG_PIN', attempt: failures + 1 });
        throw new ForbiddenException('Delivery PIN does not match');
      }
    }
    if (exception && pinVerified) throw new BadRequestException('The PIN was verified - an exception reason is not needed');
    if (req.pinRequired && !pinVerified && !exception) throw new ForbiddenException("The customer's 4-digit delivery PIN is required. Ask the customer, or use the exception path (photo + reason).");

    // ---- photo
    const hasPhoto = !!input.proofPhotoUrl;
    if (req.photoRequired && !hasPhoto && !exception) throw new BadRequestException(req.pinRequired ? 'A photo of the delivered order is required as well as the PIN' : 'A photo of the delivered order, taken at the drop-off location and uploaded in the app, is required');
    if (exception && !hasPhoto) throw new BadRequestException('The exception path requires a photo');
    let photo: ProofDraft['photo'] = null;
    if (hasPhoto) {
      if (input.lat == null || input.lng == null || input.accuracy == null || !input.capturedAt) throw new BadRequestException('A proof photo needs lat, lng, accuracy and capturedAt');
      photo = await this.loadPhoto(order, driver, input);
    }

    // ---- location, geofence, server GPS cross-check
    const fix = await this.serverFix(driver.id);
    let claimed: { lat: number | null; lng: number | null } = { lat: null, lng: null };
    if (photo) claimed = { lat: photo.lat, lng: photo.lng };
    else if (input.lat != null && input.lng != null) claimed = { lat: input.lat, lng: input.lng };
    else if (fix) claimed = { lat: fix.lat, lng: fix.lng };

    const dest = order.deliveryAddress;
    let distanceMeters: number | null = null;
    if (dest?.lat == null || dest?.lng == null) {
      flags.push('NO_DROPOFF_COORDS');
    } else if (claimed.lat != null && claimed.lng != null) {
      distanceMeters = Math.round(haversineKm(claimed.lat, claimed.lng, Number(dest.lat), Number(dest.lng)) * 1000);
      if (gf.enforce && distanceMeters > gf.meters) {
        // strict: the exception path does not bypass the geofence
        await this.event(order.id, 'PROOF_REJECTED', ActorType.DRIVER, driver.id, `Outside geofence (${distanceMeters} m)`, { reason: 'OUTSIDE_GEOFENCE', distanceMeters });
        throw new ForbiddenException(`You are ${distanceMeters} m from the drop-off address; deliveries must be completed within ${gf.meters} m of the delivery location. Move closer and retry.`);
      }
    } else if (gf.enforce) {
      throw new BadRequestException('Your location is required to complete the delivery (send lat/lng, or keep location updates on)');
    }

    let serverGpsDistanceMeters: number | null = null;
    if (!fix) {
      flags.push('GPS_UNVERIFIED');
    } else if (claimed.lat != null && claimed.lng != null) {
      serverGpsDistanceMeters = Math.round(haversineKm(claimed.lat, claimed.lng, fix.lat, fix.lng) * 1000);
      if (serverGpsDistanceMeters > this.settings.get<number>('delivery.proof.gpsMismatchMeters', 300)) flags.push('GPS_MISMATCH');
    }
    if (photo && photo.accuracy > 100) flags.push('LOW_ACCURACY');

    // ---- classify
    let proofType: ProofType;
    if (exception) proofType = ProofType.EXCEPTION;
    else if (pinVerified && photo) proofType = ProofType.PIN_AND_PHOTO;
    else if (pinVerified) proofType = ProofType.PIN;
    else if (photo) proofType = ProofType.PHOTO;
    else if (action === DeliveryAction.HANDED_TO_CUSTOMER && !req.pinRequired && !req.photoRequired) proofType = ProofType.HANDED_OVER;
    else proofType = ProofType.NONE;
    if (proofType === ProofType.HANDED_OVER) flags.push('HANDED_OVER_NO_PHOTO');
    // the PIN is customer-confirmed: GPS flags do not weaken it. A photo / nothing is only strong when clean.
    const weak = proofType === ProofType.EXCEPTION || proofType === ProofType.NONE || proofType === ProofType.HANDED_OVER || (!pinVerified && flags.some((f) => FLAGS_THAT_WEAKEN.includes(f)));
    if (weak && proofType !== ProofType.HANDED_OVER) flags.unshift('WEAK_PROOF'); // a hand-over the customer made possible by turning the PIN off is "no evidence", not suspicious

    return {
      method: req.method,
      proofType,
      strength: weak ? 'WEAK' : 'STRONG',
      pinVerified,
      exceptionReason: exception,
      exceptionNote: input.note ?? null,
      photo,
      claimed,
      distanceMeters,
      serverGpsDistanceMeters,
      geofenceMeters: gf.enforce ? gf.meters : null,
      flags,
      breadcrumb: await this.breadcrumb(driver.id, dest?.lat != null ? { lat: Number(dest.lat), lng: Number(dest.lng) } : null),
      device: { ip: ctx.ip ?? null, userAgent: (ctx.userAgent ?? '').slice(0, 200) || null },
      deliveryAction: action,
      actorUserId: driver.userId,
    };
  }

  private async loadPhoto(order: Order, driver: DriverProfile, input: ProofInput): Promise<NonNullable<ProofDraft['photo']>> {
    // own URL only: <publicUrl>/uploads/<uuid>.(jpg|png)
    let filename: string | null = null;
    try {
      const u = new URL(input.proofPhotoUrl!);
      const pub = new URL(this.config.get<string>('publicUrl') ?? 'http://localhost:4000');
      const m = /^\/uploads\/([0-9a-f-]{36}\.(?:jpe?g|png))$/i.exec(u.pathname);
      if (m && u.host === pub.host && (u.protocol === 'http:' || u.protocol === 'https:')) filename = m[1];
    } catch {
      /* falls through to the error below */
    }
    if (!filename) throw new BadRequestException('The proof photo must be a JPEG or PNG uploaded through the FORKY app (POST /uploads)');
    const row = await this.registry.findOne({ where: { filename } });
    if (!row || row.userId !== driver.userId) throw new ForbiddenException('That photo was not uploaded by you');
    if (!['image/jpeg', 'image/png'].includes(row.mimetype)) throw new BadRequestException('Proof photos must be JPEG or PNG');
    if (order.pickedUpAt && row.createdAt.getTime() < order.pickedUpAt.getTime() - 60_000) throw new BadRequestException('That photo was uploaded before you picked up this order');

    const captured = new Date(input.capturedAt!);
    if (Number.isNaN(captured.getTime())) throw new BadRequestException('capturedAt is not a valid date');
    const maxAge = this.settings.get<number>('delivery.proof.photoMaxAgeMinutes', 10) * 60_000;
    if (Date.now() - captured.getTime() > maxAge) throw new BadRequestException(`The photo is too old - it must be taken within ${Math.round(maxAge / 60000)} minutes of completing the delivery`);
    if (captured.getTime() - Date.now() > 120_000) throw new BadRequestException('capturedAt is in the future');
    if (order.pickedUpAt && captured.getTime() < order.pickedUpAt.getTime() - 60_000) throw new BadRequestException('The photo was taken before you picked up this order');
    if (order.driverArrivedCustomerAt && captured.getTime() < order.driverArrivedCustomerAt.getTime() - 60_000) throw new BadRequestException('The photo must be taken at the drop-off location, after you tap "arrived at customer"');

    const path = join(this.uploads.dir, filename);
    if (!existsSync(path)) throw new BadRequestException('The uploaded photo could not be found - upload it again');
    const raw = await readFile(path);
    const stripped = stripImageMetadata(raw);
    if (!stripped) throw new BadRequestException('The photo is not a valid JPEG / PNG image');
    const sha256 = createHash('sha256').update(stripped.buf).digest('hex');
    const rawSha = createHash('sha256').update(raw).digest('hex');
    const dup = await this.proofs.findOne({ where: { photoSha256: In([sha256, rawSha]) } });
    if (dup && dup.orderId !== order.id) {
      await this.event(order.id, 'PROOF_REJECTED', ActorType.DRIVER, driver.id, 'Photo already used as proof on another delivery', { reason: 'PHOTO_REUSED' });
      await this.audit.log({ actor: { id: driver.userId, type: 'DRIVER' } as any, action: 'delivery.proof.photo_reuse_attempt', entity: 'Order', entityId: order.id, after: { sha256, originalOrderId: dup.orderId, driverId: driver.id } });
      this.rt.emitToOps('delivery.proof_flagged', { orderId: order.id, code: order.code, flags: ['PHOTO_REUSED'] });
      throw new ConflictException('This photo was already used as proof for another delivery. Take a new photo at the drop-off.');
    }
    return { srcFile: filename, buf: stripped.buf, sha256, mime: stripped.mime, lat: Number(input.lat), lng: Number(input.lng), accuracy: Number(input.accuracy), capturedAt: captured };
  }

  /** latest server-side GPS fix of the driver, if fresh enough */
  private async serverFix(driverId: string): Promise<{ lat: number; lng: number; at: Date } | null> {
    const maxAge = this.settings.get<number>('delivery.proof.serverGpsMaxAgeSec', 300) * 1000;
    const [p, last] = await Promise.all([this.drivers.findOne({ where: { id: driverId } }), this.logs.findOne({ where: { driverId }, order: { createdAt: 'DESC' } })]);
    const cands: { lat: number; lng: number; at: Date }[] = [];
    if (p?.lat != null && p?.lng != null && p.lastLocationAt) cands.push({ lat: Number(p.lat), lng: Number(p.lng), at: p.lastLocationAt });
    if (last) cands.push({ lat: last.lat, lng: last.lng, at: last.createdAt });
    cands.sort((a, b) => b.at.getTime() - a.at.getTime());
    const best = cands[0];
    return best && Date.now() - best.at.getTime() <= maxAge ? best : null;
  }

  private async breadcrumb(driverId: string, dest: { lat: number; lng: number } | null) {
    const since = new Date(Date.now() - 10 * 60_000);
    const rows = await this.logs.find({ where: { driverId, createdAt: Between(since, new Date()) }, order: { createdAt: 'ASC' }, take: 500 });
    const step = Math.max(1, Math.ceil(rows.length / 30));
    const points = rows.filter((_, i) => i % step === 0 || i === rows.length - 1).map((r) => ({ lat: r.lat, lng: r.lng, at: r.createdAt, distanceMeters: dest ? Math.round(haversineKm(r.lat, r.lng, dest.lat, dest.lng) * 1000) : null }));
    const min = dest && rows.length ? Math.min(...rows.map((r) => haversineKm(r.lat, r.lng, dest.lat, dest.lng) * 1000)) : null;
    return { windowMinutes: 10, count: rows.length, minDistanceMeters: min == null ? null : Math.round(min), points };
  }

  // ------------------------------------------------------------------ persistence (inside the DELIVERED transition)
  async persist(order: Order, draft: ProofDraft): Promise<DeliveryProof> {
    let photoFile: string | null = null;
    if (draft.photo) {
      photoFile = `${order.id}-${draft.photo.sha256.slice(0, 12)}.${draft.photo.mime === 'image/png' ? 'png' : 'jpg'}`;
      await writeFile(join(this.uploads.privateDir, 'proofs', photoFile), draft.photo.buf, { mode: 0o600 });
    }
    const instructions = { method: order.dropoffMethod, dropoffNotes: order.dropoffNotes ?? null, requiresPin: order.requiresPin, usePin: order.usePin, deliveryAction: draft.deliveryAction ?? null, deliveryAddressLabel: order.deliveryAddress?.label ?? null };
    let saved: DeliveryProof;
    try {
      saved = await this.proofs.save(
        this.proofs.create({
          orderId: order.id,
          driverId: order.driverId,
          customerId: order.customerId,
          method: draft.method,
          proofType: draft.proofType,
          strength: draft.strength,
          pinVerified: draft.pinVerified,
          exceptionReason: draft.exceptionReason,
          exceptionNote: draft.exceptionNote,
          photoFile,
          photoSha256: draft.photo?.sha256 ?? null,
          photoMime: draft.photo?.mime ?? null,
          photoBytes: draft.photo?.buf.length ?? null,
          photoExifStripped: !!draft.photo,
          photoLat: draft.photo?.lat ?? null,
          photoLng: draft.photo?.lng ?? null,
          photoAccuracyM: draft.photo?.accuracy ?? null,
          photoCapturedAt: draft.photo?.capturedAt ?? null,
          dropoffLat: order.deliveryAddress?.lat != null ? Number(order.deliveryAddress.lat) : null,
          dropoffLng: order.deliveryAddress?.lng != null ? Number(order.deliveryAddress.lng) : null,
          claimedLat: draft.claimed.lat,
          claimedLng: draft.claimed.lng,
          distanceMeters: draft.distanceMeters,
          serverGpsDistanceMeters: draft.serverGpsDistanceMeters,
          geofenceMeters: draft.geofenceMeters,
          arrivedCustomerAt: order.driverArrivedCustomerAt,
          deliveredAt: new Date(),
          breadcrumb: draft.breadcrumb,
          device: draft.device,
          instructions,
          flags: draft.flags,
          reviewStatus: draft.strength === 'WEAK' && draft.proofType !== ProofType.HANDED_OVER ? 'NEEDS_REVIEW' : 'NONE',
        }),
      );
    } catch (e: any) {
      if (photoFile) await unlink(join(this.uploads.privateDir, 'proofs', photoFile)).catch(() => undefined);
      if (e?.code === '23505') throw new ConflictException('This photo was already used as proof for another delivery');
      throw e;
    }
    if (draft.photo) {
      // the evidence copy is private and metadata-free: take the world-readable upload away
      await unlink(join(this.uploads.dir, draft.photo.srcFile)).catch(() => undefined);
      order.proofPhotoUrl = `/api/v1/orders/${order.id}/proof/photo`;
    }
    await this.event(order.id, draft.exceptionReason ? 'PROOF_EXCEPTION' : 'PROOF_RECORDED', ActorType.DRIVER, order.driverId, draft.exceptionReason ? `Delivered via exception path: ${draft.exceptionReason}` : `Delivery proof: ${draft.proofType}`, {
      proofType: draft.proofType,
      strength: draft.strength,
      flags: draft.flags,
      distanceMeters: draft.distanceMeters,
    });
    if ((draft.strength === 'WEAK' && draft.proofType !== ProofType.HANDED_OVER) || draft.flags.some((f) => f !== 'HANDED_OVER_NO_PHOTO')) {
      this.rt.emitToOps('delivery.proof_flagged', { orderId: order.id, code: order.code, flags: draft.flags, proofType: draft.proofType });
    }
    if (draft.exceptionReason) {
      await this.audit.log({ actor: { id: draft.actorUserId, type: 'DRIVER' } as any, action: 'delivery.proof.exception', entity: 'Order', entityId: order.id, after: { reason: draft.exceptionReason, flags: draft.flags, distanceMeters: draft.distanceMeters } });
      await this.notifications.notifyOps('order.stuck', { code: order.code, reason: `Delivered with exception ${draft.exceptionReason} (weak proof) - review required` }, { orderId: order.id, event: 'proof.exception' }).catch(() => undefined);
    }
    if (draft.method === DropoffMethod.LEAVE_AT_DOOR && draft.photo) {
      await this.notifications
        .notify({ userId: order.customerId, audience: 'CUSTOMER', event: 'delivery.left_at_door', title: 'Your order was left at your door', body: `Order ${order.code} was left at your door. A photo of the drop-off is in your order details.`, data: { orderId: order.id } })
        .catch(() => undefined);
    }
    return saved;
  }

  /** Staff forced the delivery (no driver evidence): keeps the invariant "every delivered order has an evidence row". */
  async recordForced(order: Order, actorId?: string | null): Promise<void> {
    if (await this.proofs.exist({ where: { orderId: order.id } })) return;
    await this.proofs.save(
      this.proofs.create({
        orderId: order.id,
        driverId: order.driverId,
        customerId: order.customerId,
        method: order.dropoffMethod ?? DropoffMethod.HAND_TO_ME,
        proofType: ProofType.NONE,
        strength: 'WEAK',
        pinVerified: false,
        dropoffLat: order.deliveryAddress?.lat != null ? Number(order.deliveryAddress.lat) : null,
        dropoffLng: order.deliveryAddress?.lng != null ? Number(order.deliveryAddress.lng) : null,
        arrivedCustomerAt: order.driverArrivedCustomerAt,
        deliveredAt: new Date(),
        flags: ['WEAK_PROOF', 'STAFF_FORCED'],
        reviewStatus: 'NONE',
        device: { forcedBy: actorId ?? null },
        instructions: { method: order.dropoffMethod, dropoffNotes: order.dropoffNotes ?? null, requiresPin: order.requiresPin },
      }),
    );
  }

  // ------------------------------------------------------------------ reads
  find(orderId: string) {
    return this.proofs.findOne({ where: { orderId } });
  }

  private photoPath(orderId: string) {
    return `/api/v1/orders/${orderId}/proof/photo`;
  }

  /** What the customer may see: result, time, map point and photo link - no flags, GPS cross-checks or device data. */
  customerView(p: DeliveryProof | null) {
    if (!p) return null;
    return {
      proofType: p.proofType,
      method: p.method,
      deliveredAt: p.deliveredAt,
      pinVerified: p.pinVerified,
      photoUrl: p.photoFile && !p.photoPurgedAt ? this.photoPath(p.orderId) : null,
      photoPurged: !!p.photoPurgedAt,
      location: p.photoLat != null ? { lat: p.photoLat, lng: p.photoLng } : p.claimedLat != null ? { lat: p.claimedLat, lng: p.claimedLng } : null,
      dropoff: p.dropoffLat != null ? { lat: p.dropoffLat, lng: p.dropoffLng } : null,
    };
  }

  /** Full evidence for staff (the stored file name is never exposed). */
  staffView(p: DeliveryProof | null) {
    if (!p) return null;
    const { photoFile, ...rest } = p;
    return { ...rest, photoUrl: photoFile && !p.photoPurgedAt ? this.photoPath(p.orderId) : null, photoAvailable: !!photoFile && !p.photoPurgedAt };
  }

  /** compact form for ticket / dispute screens */
  summary(p: DeliveryProof | null) {
    if (!p) return null;
    return {
      proofType: p.proofType,
      strength: p.strength,
      pinVerified: p.pinVerified,
      flags: p.flags,
      distanceMeters: p.distanceMeters,
      deliveredAt: p.deliveredAt,
      photoAvailable: !!p.photoFile && !p.photoPurgedAt,
      reviewStatus: p.reviewStatus,
      disputeOutcome: p.disputeOutcome,
    };
  }

  /** valid proof = customer PIN verified, or a clean photo inside the geofence. Legacy orders without an evidence record never count. */
  isValid(p: DeliveryProof | null): boolean {
    if (!p || p.strength !== 'STRONG' || p.proofType === ProofType.EXCEPTION || p.proofType === ProofType.NONE || p.proofType === ProofType.HANDED_OVER) return false;
    return p.pinVerified || (!!p.photoSha256 && !p.flags.some((f) => FLAGS_THAT_WEAKEN.includes(f)));
  }

  async photoFileFor(orderId: string): Promise<{ path: string; mime: string }> {
    const p = await this.proofs.findOne({ where: { orderId } });
    if (!p || !p.photoFile) throw new NotFoundException('No proof photo for this order');
    if (p.photoPurgedAt) throw new GoneException('The proof photo was deleted after the retention period');
    const path = join(this.uploads.privateDir, 'proofs', p.photoFile);
    if (!existsSync(path)) throw new NotFoundException('No proof photo for this order');
    return { path, mime: p.photoMime ?? 'image/jpeg' };
  }

  /** the review / dispute block is the only mutable part of the evidence record */
  patchReview(id: string, patch: Partial<Pick<DeliveryProof, 'reviewStatus' | 'reviewedById' | 'reviewedAt' | 'reviewNote' | 'disputeOutcome' | 'disputeOutcomeById' | 'disputeOutcomeAt' | 'disputeTicketId'>>) {
    return this.proofs.update(id, patch as any);
  }

  async markReviewed(orderId: string, staffId: string, note?: string) {
    const p = await this.proofs.findOne({ where: { orderId } });
    if (!p) throw new NotFoundException('No delivery proof for this order');
    p.reviewStatus = 'REVIEWED';
    p.reviewedById = staffId;
    p.reviewedAt = new Date();
    p.reviewNote = note ?? null;
    return this.proofs.save(p);
  }

  private async event(orderId: string, type: string, actorType: ActorType, actorId: string | null | undefined, note: string, data: Record<string, any>) {
    await this.events.insert({ orderId, type, actorType, actorId: actorId ?? null, note, data, fromStatus: null, toStatus: null });
  }

  // ------------------------------------------------------------------ retention
  /** Daily: delete proof photo FILES older than the retention window (unless disputed) and blank old access codes. Evidence rows stay. */
  @Cron('0 30 3 * * *')
  async retentionSweep() {
    try {
      await this.purgePhotos();
      await this.purgeAccessCodes();
    } catch (e) {
      this.logger.warn(`retention sweep failed: ${(e as Error).message}`);
    }
  }

  async purgePhotos(): Promise<number> {
    const days = this.settings.get<number>('delivery.proof.retentionDays', 90);
    const cutoff = new Date(Date.now() - days * 86400_000);
    const old = await this.proofs.find({ where: { photoFile: Not(IsNull()), photoPurgedAt: IsNull(), deliveredAt: LessThan(cutoff) }, take: 500 });
    let n = 0;
    for (const p of old) {
      if (p.reviewStatus === 'NEEDS_REVIEW') continue;
      const recent = new Date(Date.now() - 30 * 86400_000);
      const open = await this.tickets
        .createQueryBuilder('t')
        .where('t.orderId = :o', { o: p.orderId })
        .andWhere('(t.status NOT IN (:...done) OR t."createdAt" >= :recent OR t."updatedAt" >= :recent)', { done: [TicketStatus.RESOLVED, TicketStatus.CLOSED], recent })
        .getCount();
      if (open) continue;
      await unlink(join(this.uploads.privateDir, 'proofs', p.photoFile!)).catch(() => undefined);
      await this.proofs.update(p.id, { photoPurgedAt: new Date() });
      n++;
    }
    return n;
  }

  async purgeAccessCodes(): Promise<number> {
    const days = this.settings.get<number>('delivery.accessCodeRetentionDays', 7);
    const cutoff = new Date(Date.now() - days * 86400_000);
    const r = await this.orders
      .createQueryBuilder()
      .update(Order)
      .set({ accessCode: null, accessCodePurgedAt: new Date() })
      .where('"accessCode" IS NOT NULL AND status IN (:...end) AND "updatedAt" < :cutoff', { end: [OrderStatus.DELIVERED, OrderStatus.COLLECTED, OrderStatus.CANCELLED, OrderStatus.REJECTED], cutoff })
      .execute();
    return r.affected ?? 0;
  }
}
