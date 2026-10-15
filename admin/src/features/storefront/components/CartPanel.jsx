import React from "react";
import { Link, useNavigate } from "react-router-dom";
import { useSfAuth } from "../lib/SfAuth";
import { useSfCart } from "../lib/SfCart";
import { SUBSTITUTION_CHOICES, isWeighed, stepText, weightText } from "../lib/retail";
import { money } from "../lib/sfApi";
import { Dialog, Notice, Ri, Spinner, useSfConfirm } from "./ui";

/** `display` replaces the number in the middle (a weighed product shows its weight: "1.5 kg"); `step` is what one press adds ("one", "0.5 kg"). */
export function QtyStepper({ value, onChange, min = 0, max = 50, disabled, label = "", display, step = "one" }) {
  return (
    <div className="sf-qty" role="group" aria-label={`Quantity ${label}`}>
      <button type="button" onClick={() => onChange(value - 1)} disabled={disabled || value <= min} aria-label={`Remove ${step} ${label}`}>
        <Ri name={value <= 1 && min === 0 ? "delete-bin-line" : "subtract-line"} />
      </button>
      <span aria-live="polite">{display ?? value}</span>
      <button type="button" onClick={() => onChange(value + 1)} disabled={disabled || value >= max} aria-label={`Add ${step} ${label}`}>
        <Ri name="add-line" />
      </button>
    </div>
  );
}

const PROBLEM_TAG = { ITEM_UNAVAILABLE: "Sold out", INSUFFICIENT_STOCK: "Not enough in stock", NOT_SERVED_NOW: "Not served now" };

export function CartLines({ cart, busy, setQuantity, setSubstitution, compact }) {
  const retail = !!cart.restaurant?.retail;
  return (
    <ul className="sf-cartlines">
      {cart.lines.map((l) => {
        const weighed = isWeighed(l);
        const cap = Math.min(l.maxQuantity ?? 99, cart.restaurant?.maxQtyPerLine ?? (retail ? 99 : 50));
        const detail = [l.brand, !weighed && l.packSize].filter(Boolean).join(" - ");
        return (
          <li key={l.id} className={l.valid === false ? "sf-bad" : ""} data-testid="cart-line">
            <div className="sf-cartline-main">
              <div className="sf-cartline-name">
                {l.name}
                {l.valid === false && <span className="sf-tag sf-tag-danger ms-2">{PROBLEM_TAG[l.problem] || "Unavailable"}</span>}
                {l.minAge > 0 && <span className="sf-tag sf-tag-warn ms-2" title="ID is checked at your door">{l.minAge}+</span>}
              </div>
              {detail && <div className="sf-small sf-muted">{detail}</div>}
              {weighed && (
                <div className="sf-small sf-muted" data-testid="cart-weight">
                  {l.weightLabel || `~${weightText(l, l.quantity)}`} at {money(l.unitPrice)} per {stepText(l)}
                </div>
              )}
              {l.modifiers?.length > 0 && <div className="sf-small sf-muted">{l.modifiers.map((m) => m.name).join(", ")}</div>}
              {l.notes && <div className="sf-small sf-muted">Note: {l.notes}</div>}
              {retail && setSubstitution && !compact && (
                <label className="sf-sub sf-small">
                  <span className="sf-muted">If it is not available</span>
                  <select className="sf-input sf-select-sm" value={l.substitution || "ALLOW"} onChange={(e) => setSubstitution(l, e.target.value)} disabled={busy} data-testid="substitution-select" aria-label={`If ${l.name} is not available`}>
                    {SUBSTITUTION_CHOICES.map((c) => (
                      <option key={c.value} value={c.value}>{c.short}</option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            <div className="sf-cartline-side">
              <b>{money(l.lineTotal ?? l.unitPrice * l.quantity)}</b>
              {!compact && <QtyStepper value={l.quantity} onChange={(q) => setQuantity(l, q)} disabled={busy} label={l.name} max={cap} display={weighed ? weightText(l, l.quantity) : undefined} step={weighed ? stepText(l) : "one"} />}
              {compact && <span className="sf-muted">x{l.quantity}</span>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** Notices every cart view shows for grocery baskets: the ID check (age-restricted products) and how weighed products are charged. */
export function RetailCartNotes({ cart, pickup = false }) {
  const weighed = cart.lines.some((l) => isWeighed(l));
  if (!cart.requiresIdCheck && !weighed) return null;
  return (
    <>
      {cart.requiresIdCheck && (
        <Notice tone="warn" icon="id-card-line" className="mt-2">
          <span data-testid="id-check-notice">Age-restricted items: ID is checked at {pickup ? "the counter" : "your door"} ({cart.minAge || 19}+).</span>
        </Notice>
      )}
      {weighed && <p className="sf-small sf-muted mt-2 mb-0">Weighed items are charged for the weight the store measures, up to the estimate. If they weigh less you get the difference back.</p>}
    </>
  );
}

export default function CartPanel() {
  const { cart, panelOpen, closePanel, busy, setQuantity, setSubstitution, clear } = useSfCart();
  const { isLoggedIn } = useSfAuth();
  const navigate = useNavigate();
  const confirm = useSfConfirm();
  const empty = cart.lines.length === 0;

  const checkout = () => {
    closePanel();
    navigate(isLoggedIn ? "/order/checkout" : "/order/login?next=/order/checkout");
  };
  return (
    <Dialog
      open={panelOpen}
      onClose={closePanel}
      side
      title={cart.restaurant ? `Your cart - ${cart.restaurant.name}` : "Your cart"}
      footer={
        !empty && (
          <div className="sf-cartfoot">
            <div className="sf-row-between">
              <span>Subtotal</span>
              <b data-testid="cart-subtotal">{money(cart.subtotal)}</b>
            </div>
            {!cart.meetsMinimum && (
              <Notice tone="warn" className="mt-2">
                Add {money((cart.restaurant?.minimumOrder || 0) - cart.subtotal)} more to reach the {money(cart.restaurant?.minimumOrder)} minimum order.
              </Notice>
            )}
            <button type="button" className="sf-btn sf-btn-primary sf-btn-block mt-2" onClick={checkout} data-testid="cart-checkout" disabled={busy}>
              {busy ? <Spinner size={16} /> : null} {isLoggedIn ? "Go to checkout" : "Sign in to check out"}
            </button>
            {!isLoggedIn && <p className="sf-small sf-muted mt-2 mb-0">Your cart is saved on this device and moves into your account when you sign in or create one.</p>}
          </div>
        )
      }
    >
      {empty ? (
        <div className="sf-center sf-muted py-5">
          <Ri name="shopping-basket-2-line" className="sf-bigicon" />
          <p className="mt-2">Your cart is empty.</p>
          <Link to="/order" className="sf-btn sf-btn-light" onClick={closePanel}>
            Browse restaurants
          </Link>
        </div>
      ) : (
        <>
          {cart.restaurant && (
            <p className="sf-small sf-muted">
              From{" "}
              <Link to={`/order/r/${encodeURIComponent(cart.restaurant.slug)}`} onClick={closePanel}>
                {cart.restaurant.name}
              </Link>
              {cart.restaurant.isOpen === false && <span className="sf-tag sf-tag-danger ms-2">Closed now</span>}
            </p>
          )}
          <CartLines cart={cart} busy={busy} setQuantity={setQuantity} setSubstitution={setSubstitution} />
          {cart.issues.filter((i) => i.code !== "BELOW_MINIMUM").map((i, n) => (
            <Notice key={n} tone="warn" className="mt-2">
              {i.message}
            </Notice>
          ))}
          <RetailCartNotes cart={cart} />
          <button
            type="button"
            className="sf-btn sf-btn-link mt-2"
            onClick={async () => {
              if (await confirm({ title: "Empty your cart?", message: "All items will be removed.", confirmText: "Empty cart", danger: true })) clear();
            }}
          >
            <Ri name="delete-bin-line" /> Empty cart
          </button>
        </>
      )}
    </Dialog>
  );
}
