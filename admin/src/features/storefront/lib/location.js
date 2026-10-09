import { useSyncExternalStore } from "react";
import { SF_KEYS, sfStore } from "./sfApi";

/**
 * "Deliver to" location used to rank restaurants and decide which can deliver to you (the API takes lat/lng).
 * There is NO geocoding provider connected yet (no Google Maps key), so a street address cannot be turned into
 * coordinates automatically: customers pick one of these demo locations (Mississauga / Brampton, approximate) or,
 * when signed in, one of their saved addresses.
 */
export const DEMO_LOCATIONS = [
  { label: "Square One area, Mississauga", city: "Mississauga", postalCode: "L5B 2C9", lat: 43.5933, lng: -79.6419 },
  { label: "Erin Mills, Mississauga", city: "Mississauga", postalCode: "L5L 1A1", lat: 43.56, lng: -79.7 },
  { label: "Port Credit, Mississauga", city: "Mississauga", postalCode: "L5G 1A1", lat: 43.5535, lng: -79.5851 },
  { label: "Meadowvale, Mississauga", city: "Mississauga", postalCode: "L5N 7T1", lat: 43.5929, lng: -79.7564 },
  { label: "Downtown Brampton", city: "Brampton", postalCode: "L6Y 1N2", lat: 43.6858, lng: -79.7599 },
  { label: "Springdale, Brampton", city: "Brampton", postalCode: "L6R 3J7", lat: 43.7315, lng: -79.7624 },
  { label: "Bramalea, Brampton", city: "Brampton", postalCode: "L6T 3R4", lat: 43.7176, lng: -79.7217 },
];

const listeners = new Set();
let snapshot = null;

function read() {
  const v = sfStore.getJson(SF_KEYS.location, "local", null);
  return v && Number.isFinite(v.lat) && Number.isFinite(v.lng) ? v : null;
}
snapshot = read();

export function getLocation() {
  return snapshot;
}
export function setLocation(loc) {
  snapshot = loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng) ? { label: String(loc.label || "").slice(0, 120), lat: loc.lat, lng: loc.lng } : null;
  if (snapshot) sfStore.setJson(SF_KEYS.location, snapshot, "local");
  else sfStore.del(SF_KEYS.location, "local");
  listeners.forEach((l) => l());
}
const subscribe = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
export const useSfLocation = () => useSyncExternalStore(subscribe, getLocation);

/** query params for discovery calls */
export const locParams = (loc) => (loc ? { lat: loc.lat, lng: loc.lng } : {});
