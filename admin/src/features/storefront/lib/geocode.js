/**
 * Address search client. The browser talks ONLY to the FORKSY API (/public/geocode/*); the maps provider key (Mapbox or Google) never leaves the server,
 * so the Content-Security-Policy needs no provider origin for address search. When the server answers { enabled:false } the callers fall back to the
 * demo areas / manual coordinates.
 */
import { getPaymentsConfig } from "./payments";
import { sfHttp } from "./sfApi";

/** Is address search available? (cached: it comes with the public payments config) */
export async function addressSearchEnabled() {
  const c = await getPaymentsConfig();
  return !!c.addressSearch;
}

/** A fresh random session token: groups the suggestions and the final retrieve into one billing session of the maps provider. */
export const newSessionToken = () => {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  }
};

export const suggestAddresses = (q, sessionToken, proximity) => sfHttp.get("/public/geocode/autocomplete", { q, sessionToken, proximity }, { noAuth: true });
export const retrieveAddress = (id, sessionToken) => sfHttp.get("/public/geocode/retrieve", { id, sessionToken }, { noAuth: true });
