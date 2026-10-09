import React from "react";
import { Link, useNavigate } from "react-router-dom";
import { useSfAuth } from "../lib/SfAuth";
import { useSfCart } from "../lib/SfCart";
import { money } from "../lib/sfApi";
import { Dialog, Notice, Ri, Spinner, useSfConfirm } from "./ui";

export function QtyStepper({ value, onChange, min = 0, max = 50, disabled, label = "" }) {
  return (
    <div className="sf-qty" role="group" aria-label={`Quantity ${label}`}>
      <button type="button" onClick={() => onChange(value - 1)} disabled={disabled || value <= min} aria-label={`Remove one ${label}`}>
        <Ri name={value <= 1 && min === 0 ? "delete-bin-line" : "subtract-line"} />
      </button>
      <span aria-live="polite">{value}</span>
      <button type="button" onClick={() => onChange(value + 1)} disabled={disabled || value >= max} aria-label={`Add one ${label}`}>
        <Ri name="add-line" />
      </button>
    </div>
  );
}

export function CartLines({ cart, busy, setQuantity, compact }) {
  return (
    <ul className="sf-cartlines">
      {cart.lines.map((l) => (
        <li key={l.id} className={l.valid === false ? "sf-bad" : ""}>
          <div className="sf-cartline-main">
            <div className="sf-cartline-name">
              {l.name}
              {l.valid === false && <span className="sf-tag sf-tag-danger ms-2">{l.problem === "ITEM_UNAVAILABLE" ? "Sold out" : "Unavailable"}</span>}
            </div>
            {l.modifiers?.length > 0 && <div className="sf-small sf-muted">{l.modifiers.map((m) => m.name).join(", ")}</div>}
            {l.notes && <div className="sf-small sf-muted">Note: {l.notes}</div>}
          </div>
          <div className="sf-cartline-side">
            <b>{money(l.lineTotal ?? l.unitPrice * l.quantity)}</b>
            {!compact && <QtyStepper value={l.quantity} onChange={(q) => setQuantity(l, q)} disabled={busy} label={l.name} />}
            {compact && <span className="sf-muted">x{l.quantity}</span>}
          </div>
        </li>
      ))}
    </ul>
  );
}

export default function CartPanel() {
  const { cart, panelOpen, closePanel, busy, setQuantity, clear } = useSfCart();
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
          <CartLines cart={cart} busy={busy} setQuantity={setQuantity} />
          {cart.issues.filter((i) => i.code !== "BELOW_MINIMUM").map((i, n) => (
            <Notice key={n} tone="warn" className="mt-2">
              {i.message}
            </Notice>
          ))}
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
