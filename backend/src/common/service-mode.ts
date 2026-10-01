import { RestaurantServiceMode, RestaurantStatus } from './enums';

export const SERVICE_MODE_LABELS: Record<RestaurantServiceMode, string> = {
  [RestaurantServiceMode.CLOSED]: 'Closed',
  [RestaurantServiceMode.PICKUP_ONLY]: 'Pickup only',
  [RestaurantServiceMode.PICKUP_AND_DELIVERY]: 'Pickup & delivery',
};

export interface FulfilmentAvailability {
  serviceMode: RestaurantServiceMode;
  serviceModeLabel: string;
  pickupAvailable: boolean;
  /** delivery by platform OR own drivers */
  deliveryAvailable: boolean;
  platformDeliveryAvailable: boolean;
  ownDeliveryAvailable: boolean;
}

type R = {
  status: RestaurantStatus;
  serviceMode?: RestaurantServiceMode | null;
  pickupEnabled: boolean;
  deliveryEnabled: boolean;
  ownDeliveryEnabled: boolean;
};

/**
 * Single source of truth for "which fulfilment types can a customer use right now" (ignores opening hours).
 * serviceMode decides; the admin-configured capability flags are an upper bound. Only LIVE stores are orderable.
 */
export function fulfilmentAvailability(r: R): FulfilmentAvailability {
  const mode = r.serviceMode ?? RestaurantServiceMode.PICKUP_AND_DELIVERY;
  const live = r.status === RestaurantStatus.LIVE;
  const orderable = live && mode !== RestaurantServiceMode.CLOSED;
  const pickupAvailable = orderable && !!r.pickupEnabled;
  const full = orderable && mode === RestaurantServiceMode.PICKUP_AND_DELIVERY;
  const platformDeliveryAvailable = full && !!r.deliveryEnabled;
  const ownDeliveryAvailable = full && !!r.ownDeliveryEnabled;
  return {
    serviceMode: mode,
    serviceModeLabel: SERVICE_MODE_LABELS[mode],
    pickupAvailable,
    deliveryAvailable: platformDeliveryAvailable || ownDeliveryAvailable,
    platformDeliveryAvailable,
    ownDeliveryAvailable,
  };
}
