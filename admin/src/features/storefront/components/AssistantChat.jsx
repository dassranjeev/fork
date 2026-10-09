import React, { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { safeColor } from "../../../lib/safe";
import { assistantApi, botSession, handoffPath } from "../lib/assistantApi";
import { SF_KEYS, errorMessage, money, sfStore } from "../lib/sfApi";
import { useSfAuth } from "../lib/SfAuth";
import { useSfCart } from "../lib/SfCart";
import { useSfLocation } from "../lib/location";
import { availability } from "./RestaurantCard";
import { Pic, Ri, Spinner } from "./ui";

/**
 * The centralized assistant ("bot") for the storefront: floating bubble + chat panel, same behaviour as the embeddable
 * widget. Plain text only (React text nodes, never HTML), Bearer token sent when the customer is signed in so the
 * assistant writes the real server cart. Hidden when the assistant API is missing / disabled.
 */
const MAX_LOG = 30;
const cartSig = (c) => JSON.stringify((c?.items || []).map((i) => [i.lineId, i.quantity]));

function Cards({ cards, onAdd, busy }) {
  return (
    <div className="sf-bot-cards">
      {cards.map((c) => (
        <div key={c.menuItemId} className={`sf-bot-card ${c.available === false ? "is-off" : ""}`} data-testid="bot-card">
          {c.imageUrl ? <Pic src={c.imageUrl} name={c.name} className="sf-bot-card-img" /> : null}
          <div className="sf-bot-card-body">
            <b>{c.name}</b>
            {c.description && <div className="sf-small sf-muted sf-clamp2">{c.description}</div>}
            <div className="sf-tags">
              {(c.tags || []).slice(0, 3).map((t) => (
                <span key={t} className="sf-tag">{t}</span>
              ))}
              {c.available === false && <span className="sf-tag sf-tag-danger">Sold out</span>}
            </div>
            <div className="sf-row-between mt-1">
              <b>{money(c.price)}</b>
              <button type="button" className="sf-btn sf-btn-sm sf-btn-primary" disabled={busy || c.available === false} onClick={() => onAdd(c)} data-testid="bot-add">
                <Ri name="add-line" /> Add
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function RestaurantsList({ list }) {
  return (
    <div className="sf-bot-rests">
      {list.map((r) => {
        const av = availability({ ...r, isOpen: r.openNow, serviceMode: r.openNow === false ? undefined : r.pickupAvailable && !r.deliveryAvailable ? "PICKUP_ONLY" : "PICKUP_AND_DELIVERY" });
        return (
          <Link key={r.id || r.slug} to={`/order/r/${encodeURIComponent(r.slug)}`} className="sf-bot-rest" data-testid="bot-restaurant">
            <Pic src={r.logoUrl} name={r.name} className="sf-bot-rest-logo" rounded />
            <span className="flex-grow-1">
              <b>{r.name}</b>
              <span className="sf-small sf-muted d-block">
                {[r.cuisine, r.rating != null ? `${Number(r.rating).toFixed(1)} stars` : null].filter(Boolean).join(" - ")}
              </span>
            </span>
            <span className={`sf-tag sf-tag-${r.openNow === false ? "danger" : av.tone}`}>{r.openNow === false ? "Closed" : av.text}</span>
          </Link>
        );
      })}
    </div>
  );
}

export default function AssistantChat({ restaurantSlug, lift, onAvailable }) {
  const navigate = useNavigate();
  const { user } = useSfAuth();
  const { mergeAssistantCart, detachAssistantCart, openPanel } = useSfCart();
  const loc = useSfLocation();
  const [config, setConfig] = useState(null);
  const [open, setOpen] = useState(false);
  const [log, setLog] = useState(() => sfStore.getJson(SF_KEYS.botLog, "session", []) || []);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [meta, setMeta] = useState({ cart: null, orderNote: null, canCheckout: false, restaurant: null });
  const [unread, setUnread] = useState(false);
  const scroller = useRef(null);
  const lastSig = useRef("");
  const inputRef = useRef(null);

  // ---- config (per restaurant scope); a missing / disabled assistant simply hides the bubble
  useEffect(() => {
    let live = true;
    assistantApi
      .config(restaurantSlug)
      .then((c) => live && setConfig(c && c.enabled !== false ? c : null))
      .catch(() => live && setConfig(null));
    return () => {
      live = false;
    };
  }, [restaurantSlug]);

  useEffect(() => {
    onAvailable?.(!!config);
  }, [config]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const openIt = () => setOpen(true);
    window.addEventListener("sf:open-assistant", openIt);
    return () => window.removeEventListener("sf:open-assistant", openIt);
  }, []);

  // ---- persist transcript (text only is enough to rebuild the panel after a reload)
  useEffect(() => {
    sfStore.setJson(SF_KEYS.botLog, log.slice(-MAX_LOG));
  }, [log]);
  useEffect(() => {
    if (open && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [log, busy, open]);
  useEffect(() => {
    if (open) setUnread(false);
  }, [open]);

  // the conversation is tied to its scope (one restaurant, or the whole site): moving to another scope starts fresh
  const scopeKey = restaurantSlug || "";
  useEffect(() => {
    const prev = sfStore.get(SF_KEYS.botScope);
    if (prev !== null && prev !== scopeKey) {
      detachAssistantCart();
      botSession.set(null);
      setLog([]);
      setMeta({ cart: null, orderNote: null, canCheckout: false, restaurant: null });
      lastSig.current = "";
    }
    sfStore.set(SF_KEYS.botScope, scopeKey);
  }, [scopeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // a different account / a sign-out starts a fresh conversation
  const userId = user?.id || null;
  const prevUser = useRef(userId);
  useEffect(() => {
    if (prevUser.current !== userId) {
      prevUser.current = userId;
      detachAssistantCart();
      botSession.set(null);
      setLog([]);
      setMeta({ cart: null, orderNote: null, canCheckout: false, restaurant: null });
      lastSig.current = "";
    }
  }, [userId]); // eslint-disable-line react-hooks/exhaustive-deps

  const push = useCallback((m) => setLog((l) => [...l, { id: Math.random().toString(36).slice(2), ...m }].slice(-MAX_LOG)), []);

  const send = useCallback(
    async ({ message = "", quick, label }) => {
      const shown = (label || message).trim();
      if (!shown && !quick) return;
      if (shown) push({ role: "user", text: shown.slice(0, 500) });
      setBusy(true);
      try {
        // the API requires a non-empty message even for a chip tap: send the chip's label
        const body = { message: (message || label || String(quick)).trim().slice(0, 500) };
        if (loc && !restaurantSlug) {
          body.lat = loc.lat; // "near me" for the central assistant; the API never stores it
          body.lng = loc.lng;
        }
        if (restaurantSlug) body.restaurantSlug = restaurantSlug;
        const sid = botSession.get();
        if (sid) body.sessionId = sid;
        if (quick) body.quick = quick;
        const res = await assistantApi.chat(body);
        if (res.sessionId) botSession.set(res.sessionId);
        const reply = res.reply || {};
        push({ role: "bot", text: String(reply.text ?? ""), cards: reply.cards || [], restaurants: reply.restaurants || [], chips: reply.chips || [] });
        setMeta({ cart: res.cart || null, orderNote: res.orderNote ?? null, canCheckout: !!res.canCheckout, restaurant: res.restaurant || null });
        if (!open) setUnread(true);
        const sig = cartSig(res.cart);
        if (sig !== lastSig.current) {
          lastSig.current = sig;
          mergeAssistantCart(res.cart, res.restaurant).catch(() => {}); // keep the page cart in step
        }
      } catch (e) {
        push({ role: "bot", error: true, text: errorMessage(e) });
      } finally {
        setBusy(false);
      }
    },
    [mergeAssistantCart, open, push, restaurantSlug, loc]
  );

  // greeting whenever the panel is open on an empty conversation
  useEffect(() => {
    if (open && config?.greeting && log.length === 0) push({ role: "bot", text: String(config.greeting) });
  }, [open, config, log.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const [goBusy, setGoBusy] = useState(false);
  const checkout = async () => {
    setGoBusy(true);
    try {
      if (user) {
        // the assistant already wrote the real cart; carry its note into checkout
        if (meta.orderNote) sfStore.setJson(SF_KEYS.orderNote, { restaurantId: meta.restaurant?.id, note: meta.orderNote });
        setOpen(false);
        navigate("/order/checkout");
      } else {
        const sid = botSession.get();
        if (!sid) throw new Error("Say hello to the assistant first.");
        const h = await assistantApi.handoff(sid);
        setOpen(false);
        navigate(handoffPath(h.url, h.token, meta.restaurant?.slug || restaurantSlug));
      }
    } catch (e) {
      push({ role: "bot", error: true, text: errorMessage(e) });
    } finally {
      setGoBusy(false);
    }
  };

  const reset = () => {
    detachAssistantCart();
    botSession.set(null);
    setLog([]);
    setMeta({ cart: null, orderNote: null, canCheckout: false, restaurant: null });
    lastSig.current = "";
  };

  if (!config) return null;
  const color = safeColor(config.color, "#ff6917");
  const lastBot = [...log].reverse().find((m) => m.role === "bot");
  const items = meta.cart?.items || [];
  // an "Add <item>" chip duplicates the Add button of the item card shown in the same reply
  const cardIds = new Set((lastBot?.cards || []).map((c) => c.menuItemId));
  const starter = restaurantSlug
    ? [{ label: "Menu", payload: "menu" }, { label: "Popular", payload: "popular" }, { label: "Hours", payload: "hours" }, { label: "Delivery", payload: "delivery" }]
    : (config?.chips?.length ? config.chips : [{ label: "Open now", payload: "open" }, { label: "Recommend something", payload: "recommend" }, { label: "Popular dishes", payload: "popular" }, { label: "Help", payload: "help" }]);
  const botChips = lastBot?.chips?.length ? lastBot.chips : log.some((m) => m.role === "user") ? [] : starter;
  const chips = botChips.filter((c) => !(c.payload?.startsWith("add:") && cardIds.has(c.payload.slice(4))));
  const name = String(config.name || "FORKSY assistant");

  return (
    <div className={`sf-bot ${lift ? "is-lifted" : ""}`} style={{ "--sf-bot": color }}>
      {open && (
        <section className="sf-bot-panel" role="dialog" aria-label={name} data-testid="bot-panel">
          <header className="sf-bot-head">
            {config.logoUrl ? <Pic src={config.logoUrl} name={name} className="sf-bot-rest-logo" rounded /> : <Ri name="chat-smile-3-fill" />}
            <div className="flex-grow-1">
              <b>{name}</b>
              <div className="sf-small">{config.restaurant?.name ? `Ordering from ${config.restaurant.name}` : "Ask about restaurants and dishes"}</div>
            </div>
            <button type="button" className="sf-iconbtn sf-iconbtn-inv" onClick={reset} aria-label="Start a new chat" title="New chat">
              <Ri name="restart-line" />
            </button>
            <button type="button" className="sf-iconbtn sf-iconbtn-inv" onClick={() => setOpen(false)} aria-label="Close chat">
              <Ri name="close-line" />
            </button>
          </header>
          <div className="sf-bot-log" ref={scroller} aria-live="polite" data-testid="bot-log">
            {log.map((m) => (
              <div key={m.id} className={`sf-msg sf-msg-${m.role} ${m.error ? "is-error" : ""}`}>
                {m.text && <div className="sf-bubble" data-testid={m.role === "bot" ? "bot-reply" : undefined}>{m.text}</div>}
                {m.cards?.length > 0 && <Cards cards={m.cards} busy={busy} onAdd={(c) => send({ quick: assistantApi.addPayload(c), label: `Add ${c.name}` })} />}
                {m.restaurants?.length > 0 && <RestaurantsList list={m.restaurants} />}
              </div>
            ))}
            {busy && (
              <div className="sf-msg sf-msg-bot">
                <div className="sf-bubble sf-typing" aria-label="The assistant is typing">
                  <i /> <i /> <i />
                </div>
              </div>
            )}
          </div>
          {chips.length > 0 && !busy && (
            <div className="sf-bot-chips" data-testid="bot-chips">
              {chips.map((c, i) => (
                <button key={`${c.payload}-${i}`} type="button" className="sf-chip sf-chip-sm" onClick={() => (c.payload === "checkout" && meta.canCheckout ? checkout() : send({ quick: c.payload, label: c.label }))}>
                  {c.label}
                </button>
              ))}
            </div>
          )}
          {items.length > 0 && (
            <div className="sf-bot-cart" data-testid="bot-cart">
              <div className="sf-row-between">
                <span>
                  <Ri name="shopping-basket-2-line" /> <b>{meta.cart.count}</b> item{meta.cart.count === 1 ? "" : "s"} - about {money(meta.cart.subtotalEstimate)}
                </span>
                <button type="button" className="sf-btn sf-btn-link sf-btn-sm" onClick={() => { setOpen(false); openPanel(); }}>
                  View
                </button>
              </div>
              <ul className="sf-small sf-muted mb-1">
                {items.slice(0, 4).map((i) => (
                  <li key={i.lineId}>
                    {i.quantity} x {i.name}
                    {(i.options || []).length ? ` (${i.options.map((o) => o.name).join(", ")})` : ""}
                  </li>
                ))}
                {items.length > 4 && <li>and {items.length - 4} more</li>}
              </ul>
              <button type="button" className="sf-btn sf-btn-primary sf-btn-block" onClick={checkout} disabled={goBusy || busy || !meta.canCheckout} data-testid="bot-checkout">
                {goBusy ? <Spinner size={16} /> : null} Checkout
              </button>
              {!meta.canCheckout && <div className="sf-small sf-muted mt-1">Add a bit more to check out (see the assistant's note above).</div>}
            </div>
          )}
          <form
            className="sf-bot-form"
            onSubmit={(e) => {
              e.preventDefault();
              const t = text.trim();
              if (!t || busy) return;
              setText("");
              send({ message: t });
            }}
          >
            <input ref={inputRef} className="sf-input" value={text} onChange={(e) => setText(e.target.value)} maxLength={500} placeholder="Type a message..." aria-label="Message" data-testid="bot-input" autoComplete="off" />
            <button type="submit" className="sf-btn sf-btn-primary" disabled={busy || !text.trim()} aria-label="Send" data-testid="bot-send">
              <Ri name="send-plane-2-fill" />
            </button>
          </form>
        </section>
      )}
      <button type="button" className="sf-bot-bubble" onClick={() => setOpen((v) => !v)} aria-label={open ? "Close the assistant" : `Open the assistant: ${name}`} aria-expanded={open} data-testid="bot-bubble">
        <Ri name={open ? "close-line" : "chat-smile-3-fill"} />
        {unread && !open && <span className="sf-bot-dot" />}
      </button>
    </div>
  );
}
