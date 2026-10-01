/**
 * Driver scoring engine - spec 5.4. Pure functions (no I/O) so the rules are easy to test.
 * Every factor is normalised to 0..1, multiplied by its weight (setting `dispatch.weights`) and summed to a 0..100 score.
 */
import { VehicleType } from '../common/enums';
import { haversineKm } from '../common/geo.util';

export interface ScoreWeights {
  distance: number;
  readyMatch: number;
  vehicleFit: number;
  load: number;
  performance: number;
  fairness: number;
  /** rolling 14-day offer acceptance score (see AcceptanceService) */
  acceptance: number;
}

export const DEFAULT_WEIGHTS: ScoreWeights = {
  distance: 0.3,
  readyMatch: 0.2,
  vehicleFit: 0.08,
  load: 0.08,
  performance: 0.06,
  fairness: 0.08,
  acceptance: 0.2,
};

export const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

/** Average city speeds (km/h) per vehicle, used for the road-ETA estimate when no maps provider is configured. */
export function vehicleSpeedKmh(v: VehicleType): number {
  switch (v) {
    case VehicleType.BIKE:
      return 15;
    case VehicleType.E_BIKE:
      return 20;
    case VehicleType.SCOOTER:
      return 25;
    case VehicleType.ON_FOOT:
      return 5;
    default:
      return 28;
  }
}

export interface BikeRules {
  /** bikes excluded when pickup+drop distance exceeds this (km) */
  maxKm: number;
  /** ...or when the order subtotal exceeds this ($) */
  maxSubtotal: number;
}

/** Distance / size multipliers relative to the bike limits. Cars are unrestricted. */
const VEHICLE_LIMITS: Record<VehicleType, { km: number; size: number } | null> = {
  [VehicleType.CAR]: null,
  [VehicleType.SCOOTER]: { km: 2.5, size: 0.75 },
  [VehicleType.E_BIKE]: { km: 1.5, size: 1 },
  [VehicleType.BIKE]: { km: 1, size: 1 },
  [VehicleType.ON_FOOT]: { km: 0.4, size: 0.6 },
};

export interface ScoreInput {
  radiusKm: number;
  pickupRoadKm: number;
  pickupEtaMin: number;
  dropRoadKm: number;
  /** minutes between driver arrival and food ready: positive = driver arrives early, negative = late */
  slackMin: number;
  readyWindowMin: number;
  vehicleType: VehicleType;
  orderSubtotal: number;
  itemCount: number;
  bike: BikeRules;
  activeOrders: number;
  batchingEnabled: boolean;
  batchMaxOrders: number;
  batchCompatible: boolean;
  acceptanceRate: number; // 0..100 (rolling-window, smoothed score)
  /** acceptance below this (%) halves the acceptance factor - soft penalty, never a hard block */
  acceptanceLowThreshold?: number;
  onTimeRate: number; // 0..100
  rating: number; // 0..5
  minutesSinceLastOffer: number | null;
}

export interface ScoreResult {
  eligible: boolean;
  reasons: string[];
  /** 0..100 */
  score: number;
  /** raw 0..1 factor values */
  factors: Record<string, number>;
  /** weighted points per factor (sum = score) plus informational values (etaMin, slackMin) */
  breakdown: Record<string, number>;
}

/** Ready-time match: arriving 0..window minutes before the food is ready is ideal; early = idle wait, late = cold food. */
export function readyMatchFactor(slackMin: number, windowMin: number): number {
  if (slackMin < 0) return clamp01(1 + slackMin / 8); // 8 min late -> 0
  if (slackMin <= windowMin) return 1;
  const over = slackMin - windowMin; // waiting around
  return Math.max(0.1, 1 - 0.075 * over); // 12+ min early -> 0.1
}

export function vehicleFit(i: Pick<ScoreInput, 'vehicleType' | 'pickupRoadKm' | 'dropRoadKm' | 'orderSubtotal' | 'itemCount' | 'bike'>) {
  const tripKm = i.pickupRoadKm + i.dropRoadKm;
  const lim = VEHICLE_LIMITS[i.vehicleType];
  if (!lim) {
    // cars: slightly preferred for long / large orders, bikes are kept for short small ones
    const small = tripKm <= i.bike.maxKm * 0.6 && i.orderSubtotal <= i.bike.maxSubtotal * 0.6;
    return { eligible: true, factor: small ? 0.7 : 1, reason: null as string | null };
  }
  const maxKm = i.bike.maxKm * lim.km;
  const maxSub = i.bike.maxSubtotal * lim.size;
  const largeItems = i.itemCount > Math.round(12 * lim.size);
  if (tripKm > maxKm) return { eligible: false, factor: 0, reason: 'VEHICLE_TOO_FAR' };
  if (i.orderSubtotal > maxSub || largeItems) return { eligible: false, factor: 0, reason: 'ORDER_TOO_LARGE_FOR_VEHICLE' };
  return { eligible: true, factor: clamp01(1 - 0.4 * (tripKm / maxKm)), reason: null };
}

export function scoreCandidate(i: ScoreInput, w: ScoreWeights): ScoreResult {
  const reasons: string[] = [];
  const vf = vehicleFit(i);
  if (!vf.eligible && vf.reason) reasons.push(vf.reason);

  // current load: 0 orders -> 1; a compatible batch -> 0.6; incompatible / over limit -> excluded
  let load = 1;
  if (i.activeOrders > 0) {
    if (!i.batchingEnabled) {
      reasons.push('ON_TRIP');
      load = 0;
    } else if (i.activeOrders >= i.batchMaxOrders) {
      reasons.push('BATCH_FULL');
      load = 0;
    } else if (!i.batchCompatible) {
      reasons.push('BATCH_INCOMPATIBLE');
      load = 0;
    } else load = 0.6;
  }

  const distance = clamp01(1 - i.pickupRoadKm / Math.max(0.5, i.radiusKm * 1.3));
  const readyMatch = readyMatchFactor(i.slackMin, i.readyWindowMin);
  // acceptance has its own weighted factor, so "performance" is on-time + rating only (no double counting)
  const performance = clamp01((i.onTimeRate / 100) * 0.5 + (i.rating / 5) * 0.5);
  const lowThr = i.acceptanceLowThreshold ?? 50;
  const acceptance = clamp01(i.acceptanceRate / 100) * (i.acceptanceRate < lowThr ? 0.5 : 1);
  const fairness = i.minutesSinceLastOffer == null ? 1 : clamp01(i.minutesSinceLastOffer / 30);

  const factors = { distance, readyMatch, vehicleFit: vf.factor, load, performance, fairness, acceptance };
  const sumW = Object.values(w).reduce((a, b) => a + b, 0) || 1;
  const breakdown: Record<string, number> = {};
  let total = 0;
  for (const k of Object.keys(factors) as (keyof ScoreWeights)[]) {
    const pts = ((w[k] ?? 0) / sumW) * factors[k] * 100;
    breakdown[k] = round(pts);
    total += pts;
  }
  breakdown.acceptanceRate = round(i.acceptanceRate, 1);
  breakdown.etaMin = round(i.pickupEtaMin, 1);
  breakdown.slackMin = round(i.slackMin, 1);
  return {
    eligible: reasons.length === 0,
    reasons,
    score: round(total),
    factors: Object.fromEntries(Object.entries(factors).map(([k, v]) => [k, round(v, 3)])),
    breakdown,
  };
}

/** Bearing in degrees 0..360 from a to b. */
export function bearingDeg(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const y = Math.sin(r(bLng - aLng)) * Math.cos(r(bLat));
  const x = Math.cos(r(aLat)) * Math.sin(r(bLat)) - Math.sin(r(aLat)) * Math.cos(r(bLat)) * Math.cos(r(bLng - aLng));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export function angleDiffDeg(a: number, b: number) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

export interface BatchPoint {
  restaurantLat: number;
  restaurantLng: number;
  dropLat: number;
  dropLng: number;
  /** existing order already picked up (food is in the car) */
  pickedUp: boolean;
}

/**
 * Batching rules (spec 5.4): max N orders per trip, same/adjacent restaurants, second drop within 1.5 km of the first,
 * same general direction, no order held more than 10 extra minutes.
 */
export function batchCompatible(
  existing: BatchPoint,
  next: BatchPoint,
  rules: { maxDropKm: number; maxExtraMin: number; adjacentRestaurantKm?: number; kmh?: number },
): { ok: boolean; reason?: string; extraMin: number } {
  const adj = rules.adjacentRestaurantKm ?? 1;
  const kmh = rules.kmh ?? 28;
  const rr = haversineKm(existing.restaurantLat, existing.restaurantLng, next.restaurantLat, next.restaurantLng);
  const dd = haversineKm(existing.dropLat, existing.dropLng, next.dropLat, next.dropLng);
  // the first order waits while the driver detours to the second restaurant and then between drops
  const extraMin = ((rr * 1.3 + dd * 1.3) / kmh) * 60;
  if (existing.pickedUp) return { ok: false, reason: 'FIRST_ORDER_ALREADY_PICKED_UP', extraMin };
  if (rr > adj) return { ok: false, reason: 'RESTAURANTS_NOT_ADJACENT', extraMin };
  if (dd > rules.maxDropKm) return { ok: false, reason: 'DROPS_TOO_FAR_APART', extraMin };
  const b1 = bearingDeg(existing.restaurantLat, existing.restaurantLng, existing.dropLat, existing.dropLng);
  const b2 = bearingDeg(next.restaurantLat, next.restaurantLng, next.dropLat, next.dropLng);
  if (angleDiffDeg(b1, b2) > 60) return { ok: false, reason: 'DIFFERENT_DIRECTION', extraMin };
  if (extraMin > rules.maxExtraMin) return { ok: false, reason: 'EXTRA_WAIT_TOO_LONG', extraMin };
  return { ok: true, extraMin };
}
