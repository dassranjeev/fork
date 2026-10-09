import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { SF_KEYS, errorCode, errorDetails, errorMessage, sfHttp, sfStore } from "./sfApi";
import { useSfAuth } from "./SfAuth";
import { useSfConfirm, useToast } from "../components/ui";

/**
 * Cart for the storefront.
 *  - Guest: kept client-side in localStorage (sf.cart.v1), ONE restaurant at a time.
 *  - Logged in: the server cart (/customer/cart) is the single source of truth; every change goes through the API.
 *  - On sign-in a non-empty guest cart replaces the server cart (POST /customer/cart/replace) and is then dropped locally.
 * Both modes expose the same normalised shape (see emptyCart()).
 */
const CartContext = createContext(null);
export const useSfCart = () => useContext(CartContext);

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

export const emptyCart = (guest = true) => ({
  guest,
  restaurant: null,
  lines: [],
  itemCount: 0,
  subtotal: 0,
  promoCode: null,
  issues: [],
  valid: true,
  meetsMinimum: true,
});

const signature = (l) => `${l.menuItemId}|${(l.modifiers || []).map((m) => m.optionId).sort().join(",")}|${(l.notes || "").trim()}`;
const newKey = () => `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

function finalise(cart) {
  const lines = cart.lines.map((l) => ({ ...l, lineTotal: round2(l.unitPrice * l.quantity) }));
  const subtotal = round2(lines.reduce((s, l) => s + l.lineTotal, 0));
  const minimum = cart.restaurant?.minimumOrder || 0;
  const meetsMinimum = subtotal >= minimum;
  const issues = [...(cart.issues || []).filter((i) => i.code !== "BELOW_MINIMUM")];
  if (!meetsMinimum) issues.push({ code: "BELOW_MINIMUM", message: `Minimum order is $${minimum.toFixed(2)}` });
  return { ...cart, lines, subtotal, itemCount: lines.reduce((n, l) => n + l.quantity, 0), meetsMinimum, issues };
}

function readGuest() {
  const raw = sfStore.getJson(SF_KEYS.guestCart, "local", null);
  if (!raw || !Array.isArray(raw.lines) || !raw.restaurant) return emptyCart(true);
  return finalise({ ...emptyCart(true), restaurant: raw.restaurant, lines: raw.lines });
}
function writeGuest(cart) {
  if (!cart.lines.length) sfStore.del(SF_KEYS.guestCart, "local");
  else sfStore.setJson(SF_KEYS.guestCart, { restaurant: cart.restaurant, lines: cart.lines }, "local");
}

/** Server cart view -> normalised cart. */
function fromServer(v) {
  return {
    guest: false,
    restaurant: v.restaurant || null,
    lines: (v.lines || []).map((l) => ({
      id: l.lineId,
      menuItemId: l.menuItemId,
      name: l.name,
      imageUrl: l.imageUrl,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      lineTotal: l.lineTotal,
      modifiers: (l.modifiers || []).map((m) => ({ optionId: m.optionId, name: m.name, priceDelta: m.priceDelta, groupName: m.groupName })),
      notes: l.notes || "",
      valid: l.valid !== false,
      problem: l.problem || null,
    })),
    itemCount: v.itemCount || 0,
    subtotal: v.subtotal || 0,
    promoCode: v.promoCode || null,
    issues: v.issues || [],
    valid: v.valid !== false,
    meetsMinimum: v.meetsMinimum !== false,
  };
}

const toServerItems = (lines) => lines.map((l) => ({ menuItemId: l.menuItemId, quantity: l.quantity, modifierOptionIds: (l.modifiers || []).map((m) => m.optionId), notes: l.notes ? l.notes.slice(0, 300) : undefined }));

/** Compact restaurant record kept with the guest cart (only what the cart / checkout need). */
export function cartRestaurant(r) {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    logoUrl: r.logoUrl || null,
    minimumOrder: r.minimumOrder || 0,
    isOpen: r.isOpen !== false,
    serviceMode: r.serviceMode,
    deliveryAvailable: !!r.deliveryAvailable,
    pickupAvailable: !!r.pickupAvailable,
  };
}

export function SfCartProvider({ children }) {
  const { user, loading: authLoading } = useSfAuth();
  const confirm = useSfConfirm();
  const toast = useToast();
  const [cart, setCart] = useState(() => readGuest());
  const [busy, setBusy] = useState(false);
  const [readyFor, setReadyFor] = useState(undefined); // user id (or null for guest) whose cart is loaded
  const ready = !authLoading && readyFor === (user?.id ?? null);
  const [panelOpen, setPanelOpen] = useState(false);
  const cartRef = useRef(cart);
  cartRef.current = cart;
  const loggedIn = !!user;
  const loggedInRef = useRef(loggedIn);
  loggedInRef.current = loggedIn;

  const setGuest = useCallback((next) => {
    const fin = finalise(next);
    writeGuest(fin);
    setCart(fin);
    return fin;
  }, []);

  const refresh = useCallback(async () => {
    if (!loggedInRef.current) return setGuest(readGuest());
    const v = await sfHttp.get("/customer/cart");
    const c = fromServer(v);
    setCart(c);
    return c;
  }, [setGuest]);

  // ---- sign-in / sign-out: sync the guest cart into the account, or drop the account cart from view
  const syncedFor = useRef(null);
  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      if (syncedFor.current) {
        syncedFor.current = null;
        setCart(readGuest()); // logged out: back to the (normally empty) guest cart
      }
      setReadyFor(null);
      return;
    }
    if (syncedFor.current === user.id) return;
    syncedFor.current = user.id;
    let cancelled = false;
    (async () => {
      try {
        const guest = readGuest();
        const handoff = sfStore.getJson(SF_KEYS.handoff, "session", null);
        const handoffRunning = !!handoff && (handoff.status === "pending" || handoff.status === "importing") && Date.now() - (handoff.at || 0) < 15 * 60 * 1000;
        if (guest.lines.length && guest.restaurant && !handoffRunning) {
          let c = null;
          try {
            c = fromServer(await sfHttp.post("/customer/cart/replace", { restaurantId: guest.restaurant.id, items: toServerItems(guest.lines) }));
          } catch (e) {
            // one bad line (sold out meanwhile) must not lose the rest: add them one by one
            let first = true;
            const skipped = [];
            for (const l of guest.lines) {
              try {
                c = fromServer(await sfHttp.post("/customer/cart/items", { restaurantId: guest.restaurant.id, replaceCart: first, ...toServerItems([l])[0] }));
                first = false;
              } catch (e2) {
                skipped.push(l.name);
              }
            }
            if (skipped.length) toast(`Could not add: ${skipped.join(", ")} (${errorMessage(e)})`, "danger");
          }
          if (c) {
            sfStore.del(SF_KEYS.guestCart, "local");
            if (!cancelled) setCart(c);
          }
          if (!c) await refresh();
        } else {
          await refresh();
        }
      } catch {
        if (!cancelled) setCart(emptyCart(false));
      } finally {
        if (!cancelled) setReadyFor(user.id);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, authLoading]);

  /** Another tab changed the guest cart. */
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key === SF_KEYS.guestCart && !loggedInRef.current) setCart(readGuest());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  /** Run a server cart mutation; returns the new cart or null (an error toast is shown). */
  const serverCall = useCallback(
    async (fn) => {
      setBusy(true);
      try {
        const c = fromServer(await fn());
        setCart(c);
        return c;
      } catch (e) {
        toast(errorMessage(e), "danger");
        return null;
      } finally {
        setBusy(false);
      }
    },
    [toast]
  );

  /**
   * Add an item. item = menu item ({id,name,price,imageUrl}); restaurant = the page's restaurant; options = chosen
   * modifier options [{optionId,name,priceDelta,groupName}]. Resolves true when the item is in the cart.
   */
  const addItem = useCallback(
    async ({ restaurant, item, quantity = 1, options = [], notes = "" }) => {
      const rest = cartRestaurant(restaurant);
      const cur = cartRef.current;
      const note = notes.trim().slice(0, 300);
      if (loggedInRef.current) {
        const body = { menuItemId: item.id, quantity, modifierOptionIds: options.map((o) => o.optionId), notes: note || undefined, restaurantId: rest.id };
        setBusy(true);
        try {
          let v;
          try {
            v = await sfHttp.post("/customer/cart/items", body);
          } catch (e) {
            if (errorCode(e) !== "CART_RESTAURANT_CONFLICT") throw e;
            const d = errorDetails(e);
            const ok = await confirm({
              title: "Start a new cart?",
              message: `Your cart has items from ${d?.currentRestaurant?.name || "another restaurant"}. Start a new cart for ${rest.name}? Your current cart will be emptied.`,
              confirmText: "Start new cart",
            });
            if (!ok) return false;
            v = await sfHttp.post("/customer/cart/items", { ...body, replaceCart: true });
          }
          setCart(fromServer(v));
          return true;
        } catch (e) {
          toast(errorMessage(e), "danger");
          return false;
        } finally {
          setBusy(false);
        }
      }
      // guest
      let base = cur;
      if (cur.restaurant && cur.restaurant.id !== rest.id && cur.lines.length) {
        const ok = await confirm({
          title: "Start a new cart?",
          message: `Your cart has items from ${cur.restaurant.name}. Start a new cart for ${rest.name}? Your current cart will be emptied.`,
          confirmText: "Start new cart",
        });
        if (!ok) return false;
        base = emptyCart(true);
      }
      const unitPrice = round2(Number(item.price) + options.reduce((s, o) => s + Number(o.priceDelta || 0), 0));
      const line = { id: newKey(), menuItemId: item.id, name: item.name, imageUrl: item.imageUrl || null, quantity, unitPrice, modifiers: options, notes: note, valid: true, problem: null };
      const lines = [...base.lines];
      const same = lines.findIndex((l) => signature(l) === signature(line));
      if (same >= 0) lines[same] = { ...lines[same], quantity: Math.min(50, lines[same].quantity + quantity) };
      else lines.push(line);
      setGuest({ ...base, restaurant: rest, lines });
      return true;
    },
    [confirm, setGuest, toast]
  );

  const setQuantity = useCallback(
    async (line, quantity) => {
      if (loggedInRef.current) {
        if (quantity <= 0) return serverCall(() => sfHttp.del(`/customer/cart/items/${line.id}`));
        return serverCall(() => sfHttp.patch(`/customer/cart/items/${line.id}`, { quantity: Math.min(50, quantity) }));
      }
      const cur = cartRef.current;
      const lines = quantity <= 0 ? cur.lines.filter((l) => l.id !== line.id) : cur.lines.map((l) => (l.id === line.id ? { ...l, quantity: Math.min(50, quantity) } : l));
      return setGuest({ ...cur, lines, restaurant: lines.length ? cur.restaurant : null });
    },
    [serverCall, setGuest]
  );

  const clear = useCallback(async () => {
    if (loggedInRef.current) return serverCall(() => sfHttp.del("/customer/cart"));
    return setGuest(emptyCart(true));
  }, [serverCall, setGuest]);

  const setPromo = useCallback(
    async (code) => {
      if (!loggedInRef.current) return null;
      return serverCall(() => sfHttp.post("/customer/cart/promo", { code: code || null }));
    },
    [serverCall]
  );

  /** After a successful order: the server cart was emptied by the API. */
  const afterOrder = useCallback(async () => {
    try {
      await refresh();
    } catch {
      setCart(emptyCart(!loggedInRef.current));
    }
  }, [refresh]);

  /**
   * The assistant (bot) changed ITS cart. Logged in: it wrote the real server cart, so just re-read it.
   * Guest: merge the bot session's cart into the guest cart (by delta, so repeated replies never double count).
   */
  const mergeAssistantCart = useCallback(
    async (botCart, botRestaurant) => {
      if (loggedInRef.current) return refresh();
      if (!botCart) return null;
      let base = cartRef.current;
      const botLines = botCart.items || [];
      if (!botLines.length && !base.lines.some((l) => l.bot)) return base;
      if (botLines.length && botRestaurant?.id && base.restaurant && base.restaurant.id !== botRestaurant.id) {
        base = emptyCart(true); // the assistant moved to another restaurant: its cart wins
      }
      let lines = base.lines.map((l) => ({ ...l }));
      const seen = new Set();
      for (const b of botLines) {
        seen.add(b.lineId);
        const opts = (b.options || []).map((o) => ({ optionId: o.id, name: o.name, priceDelta: o.priceDelta || 0, groupName: o.groupName || "" }));
        const idx = lines.findIndex((l) => l.bot?.lineId === b.lineId);
        if (idx >= 0) {
          const prev = lines[idx].bot.qty;
          lines[idx] = { ...lines[idx], quantity: Math.max(1, Math.min(50, lines[idx].quantity + (b.quantity - prev))), bot: { lineId: b.lineId, qty: b.quantity } };
        } else {
          const sigLine = { menuItemId: b.menuItemId, modifiers: opts, notes: b.notes || "" };
          const same = lines.findIndex((l) => !l.bot && signature(l) === signature(sigLine));
          if (same >= 0) lines[same] = { ...lines[same], quantity: Math.min(50, lines[same].quantity + b.quantity), bot: { lineId: b.lineId, qty: b.quantity } };
          else lines.push({ id: newKey(), menuItemId: b.menuItemId, name: b.name, imageUrl: null, quantity: b.quantity, unitPrice: b.unitPrice, modifiers: opts, notes: b.notes || "", valid: true, problem: null, bot: { lineId: b.lineId, qty: b.quantity } });
        }
      }
      // lines the bot no longer has: take their bot quantity back out
      lines = lines
        .map((l) => (l.bot && !seen.has(l.bot.lineId) ? { ...l, quantity: l.quantity - l.bot.qty, bot: undefined } : l))
        .filter((l) => l.quantity > 0);
      const restaurant = botRestaurant?.id ? { ...(base.restaurant?.id === botRestaurant.id ? base.restaurant : {}), ...cartRestaurant(botRestaurant) } : base.restaurant;
      return setGuest({ ...base, restaurant: lines.length ? restaurant : null, lines });
    },
    [refresh, setGuest]
  );

  /** The assistant conversation ended / changed scope: lines it added stay in the cart as ordinary lines. */
  const detachAssistantCart = useCallback(() => {
    const cur = cartRef.current;
    if (loggedInRef.current || !cur.lines.some((l) => l.bot)) return;
    setGuest({ ...cur, lines: cur.lines.map((l) => ({ ...l, bot: undefined })) });
  }, [setGuest]);

  const value = useMemo(
    () => ({ cart, busy, ready, loggedIn, panelOpen, openPanel: () => setPanelOpen(true), closePanel: () => setPanelOpen(false), addItem, setQuantity, clear, setPromo, refresh, afterOrder, mergeAssistantCart, detachAssistantCart }),
    [cart, busy, ready, loggedIn, panelOpen, addItem, setQuantity, clear, setPromo, refresh, afterOrder, mergeAssistantCart, detachAssistantCart]
  );
  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}
