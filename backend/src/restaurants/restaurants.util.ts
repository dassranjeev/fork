import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { randomBytes } from 'crypto';
import { ActorRef, IOrdersService } from '../common/contracts';
import { AuthUser } from '../common/auth.types';
import { ActorType, RestaurantRole, StoreType } from '../common/enums';
import { profileOf } from '../common/store-types';

export const slugify = (s: string) =>
  (s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

/** Human-typeable temporary password (>= 8 chars, mixed). */
export const tempPassword = () => `Fk${randomBytes(4).toString('hex')}!${Math.floor(10 + Math.random() * 89)}`;

export const restaurantActor = (u: AuthUser): ActorRef => ({ type: ActorType.RESTAURANT, id: u.id, name: u.name });
export const staffActor = (u: AuthUser): ActorRef => ({ type: ActorType.STAFF, id: u.id, name: u.name });

/**
 * Restaurant-facing order shape: the kitchen needs the handoff METHOD as information (e.g. "Contactless") but never the customer's delivery PIN,
 * the driver instructions, the access code or the proof photo.
 */
export function restaurantOrderView<T extends Record<string, any>>(o: T): T {
  if (!o) return o;
  const { deliveryPin: _p, dropoffNotes: _n, accessCode: _a, proofPhotoUrl: _ph, ...rest } = o as any;
  if (rest.deliveryAddress) rest.deliveryAddress = { ...rest.deliveryAddress, dropoffNotes: undefined };
  return rest as T;
}

/** parse "true"/"1" query strings (implicit conversion turns "false" into true, so query flags are strings). */
export const flag = (v: unknown) => v === true || v === 'true' || v === '1' || v === 1;

/**
 * Resolves OrdersService lazily (it is owned by another module/engineer and provided by a @Global() module),
 * so this module compiles and boots even before OrdersModule is implemented.
 */
@Injectable()
export class OrdersGateway {
  private readonly logger = new Logger('OrdersGateway');
  private svc: IOrdersService | null = null;

  constructor(private moduleRef: ModuleRef) {}

  get available(): boolean {
    try {
      this.get();
      return true;
    } catch {
      return false;
    }
  }

  get(): IOrdersService {
    if (this.svc) return this.svc;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require('../orders/orders.service');
      const cls = mod?.OrdersService;
      if (!cls) throw new Error('OrdersService class not exported yet');
      this.svc = this.moduleRef.get(cls, { strict: false }) as IOrdersService;
      return this.svc;
    } catch (e: any) {
      this.logger.warn(`OrdersService unavailable: ${e.message}`);
      throw new BadRequestException('Order processing is not available yet');
    }
  }
}

/** The restaurant location a portal request is about: ?restaurantId= (or body.restaurantId), defaulting to the user's only location. */
export function resolveRestaurantId(user: AuthUser, requested?: string | null): string {
  const ids = user.restaurantIds ?? [];
  if (!ids.length) throw new ForbiddenException('This account has no restaurant locations');
  if (requested) {
    if (!ids.includes(requested)) throw new ForbiddenException('You do not have access to this location');
    return requested;
  }
  if (ids.length === 1) return ids[0];
  throw new BadRequestException('restaurantId is required (you have several locations)');
}

export function assertOwner(user: AuthUser) {
  if (user.restaurantRole !== RestaurantRole.OWNER) throw new ForbiddenException('Only the owner can do this');
}

export function notFound(what: string): never {
  throw new NotFoundException(`${what} not found`);
}

/** "HH:mm" validation. */
export const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Next 04:00 local (America/Toronto) as a Date - used as default auto-restock time for 86'd items. */
export function nextRestockTime(now = new Date(), timeZone = 'America/Toronto'): Date {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(now)) p[part.type] = part.value;
  const localMin = (p.hour === '24' ? 0 : +p.hour) * 60 + +p.minute;
  // minutes until the next 04:00 local wall clock
  let delta = 4 * 60 - localMin;
  if (delta <= 0) delta += 1440;
  return new Date(now.getTime() + delta * 60_000);
}

/**
 * The columns a NEW location of this store type starts with (prep time, radius, minimum order, scheduling, kitchen display).
 * Owners and admins can change every one of them afterwards; only creation uses these.
 */
export function storeTypeDefaults(type?: StoreType | string | null) {
  const p = profileOf(type);
  return {
    storeType: p.type,
    prepTimeMin: p.defaults.prepTimeMin,
    pickupPrepTimeMin: p.defaults.pickupPrepTimeMin,
    deliveryRadiusKm: p.defaults.deliveryRadiusKm,
    minimumOrder: p.defaults.minimumOrder,
    scheduleLeadMin: p.defaults.scheduleLeadMin,
    maxOrdersPerSlot: p.defaults.maxOrdersPerSlot,
    kdsEnabled: p.kdsDefault,
  };
}
