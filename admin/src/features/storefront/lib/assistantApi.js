/**
 * Assistant ("bot") API contract, as used by the storefront (paths under /api/v1). Owned by the assistant backend.
 *
 *  GET  /public/assistant/config[?restaurantSlug=slug]
 *       -> { enabled, name, greeting, color|null, restaurant:{id,slug,name,logoUrl}|null, mode:"site" }
 *  POST /public/assistant/chat   body { restaurantSlug?, sessionId?, message(1..500), quick? }   (Bearer customer token optional)
 *       -> { sessionId, restaurant|null,
 *            reply:{ text, cards?:[{menuItemId,name,description?,price,imageUrl?,tags?,available}],
 *                    restaurants?:[{id,slug,name,cuisine?,openNow,deliveryAvailable,pickupAvailable,rating?,logoUrl?}],
 *                    chips?:[{label,payload}] },
 *            cart:{ items:[{lineId,menuItemId,name,quantity,unitPrice,options:[{id,name,priceDelta}],notes?,lineTotal}], count, subtotalEstimate },
 *            orderNote:string|null, canCheckout:boolean, loggedIn:boolean }
 *       A chip sends its `payload` back as `quick` (message may be "").
 *  POST /public/assistant/handoff  body { sessionId } -> { token, url, expiresAt }
 *  POST /customer/assistant/import-handoff (Bearer customer) body { token }
 *       -> { restaurant:{id,slug,name}, cartCount, orderNote|null, skipped:[{name,reason}] }   (400 + message for bad / used / expired)
 */
import { SF_KEYS, sfHttp, sfStore, sfTokens } from "./sfApi";

export const assistantApi = {
  config: (restaurantSlug) => sfHttp.get("/public/assistant/config", { restaurantSlug }, { noAuth: true }),
  chat: (body) => sfHttp.post("/public/assistant/chat", body), // sends the customer's token when there is one
  handoff: (sessionId) => sfHttp.post("/public/assistant/handoff", { sessionId }, { noAuth: true }),
  importHandoff: (token) => sfHttp.post("/customer/assistant/import-handoff", { token }),
  /** the `quick` payload that asks the assistant to add a card's item (card Add button) */
  addPayload: (card) => `add:${card.menuItemId}`,
};

export const botSession = {
  get: () => sfStore.get(SF_KEYS.botSession),
  set: (id) => (id ? sfStore.set(SF_KEYS.botSession, id) : sfStore.del(SF_KEYS.botSession)),
  /** a signed-out customer gets a fresh assistant session */
  hasToken: () => !!sfTokens.access,
};

/**
 * Where a handoff url points. Only same-site /order/handoff?token=... urls are followed in-app; anything else is
 * ignored (the API is trusted, but a redirect target must never be an arbitrary URL).
 */
export function handoffPath(url, token, restaurantSlug) {
  const extra = restaurantSlug && /^[a-z0-9][a-z0-9-]{0,80}$/.test(restaurantSlug) ? `&restaurant=${restaurantSlug}` : ""; // lets the sign-in screen name the restaurant
  try {
    const u = new URL(url, window.location.origin);
    const t = u.searchParams.get("token");
    if ((u.pathname === "/order/handoff" || u.pathname.endsWith("/order/handoff")) && t) return `/order/handoff?token=${encodeURIComponent(t)}${extra}`;
  } catch {
    /* fall through */
  }
  return `/order/handoff?token=${encodeURIComponent(token)}${extra}`;
}
