import React, { useEffect, useRef, useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { addressSearchEnabled } from "../lib/geocode";
import { DEMO_LOCATIONS, setLocation, useSfLocation } from "../lib/location";
import AddressSearch from "./AddressSearch";
import NotifyBell from "./NotifyBell";
import { useSfAuth } from "../lib/SfAuth";
import { useSfCart } from "../lib/SfCart";
import { money, sfHttp } from "../lib/sfApi";
import { Dialog, Notice, Ri, useToast } from "./ui";

export function LocationDialog({ open, onClose }) {
  const loc = useSfLocation();
  const { user } = useSfAuth();
  const [addresses, setAddresses] = useState([]);
  const [search, setSearch] = useState(false);
  useEffect(() => {
    if (open) addressSearchEnabled().then(setSearch).catch(() => setSearch(false));
  }, [open]);
  useEffect(() => {
    if (!open || !user) return;
    sfHttp.get("/customer/addresses").then((a) => setAddresses(Array.isArray(a) ? a : a?.data || [])).catch(() => setAddresses([]));
  }, [open, user]);
  const pick = (l) => {
    setLocation(l);
    onClose();
  };
  return (
    <Dialog open={open} onClose={onClose} title="Where should we deliver?">
      {search ? (
        <AddressSearch testId="loc-search" proximity={loc ? `${loc.lng},${loc.lat}` : undefined} onPick={(a) => pick({ label: `${a.line1}, ${a.city}`, lat: a.lat, lng: a.lng })} />
      ) : (
        <Notice tone="info">
          Street address search is not connected yet (no map provider key), so please pick the closest area. The restaurants that can deliver to you are decided from it.
        </Notice>
      )}
      {addresses.filter((a) => a.lat != null && a.lng != null).length > 0 && (
        <>
          <h3 className="sf-h3 mt-3">Your saved addresses</h3>
          <div className="sf-list">
            {addresses
              .filter((a) => a.lat != null && a.lng != null)
              .map((a) => (
                <button key={a.id} type="button" className={`sf-listbtn ${loc && loc.lat === a.lat && loc.lng === a.lng ? "on" : ""}`} onClick={() => pick({ label: `${a.label || a.line1}, ${a.city}`, lat: a.lat, lng: a.lng })}>
                  <Ri name="home-4-line" /> <span>{a.label ? `${a.label} - ` : ""}{a.line1}, {a.city}</span>
                </button>
              ))}
          </div>
        </>
      )}
      <h3 className="sf-h3 mt-3">Areas</h3>
      <div className="sf-list">
        {DEMO_LOCATIONS.map((l) => (
          <button key={l.label} type="button" className={`sf-listbtn ${loc && loc.lat === l.lat && loc.lng === l.lng ? "on" : ""}`} onClick={() => pick(l)}>
            <Ri name="map-pin-2-line" /> <span>{l.label}</span>
          </button>
        ))}
      </div>
      {loc && (
        <button type="button" className="sf-btn sf-btn-light mt-3" onClick={() => pick(null)}>
          Clear location
        </button>
      )}
    </Dialog>
  );
}

function AccountMenu() {
  const { user, logout } = useSfAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => !ref.current?.contains(e.target) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  if (!user) {
    return (
      <div className="sf-acct-links">
        <Link className="sf-btn sf-btn-sm sf-btn-light" to="/order/login">
          Sign in
        </Link>
        <Link className="sf-btn sf-btn-sm sf-btn-primary sf-hide-xs" to="/order/login?tab=register">
          Create account
        </Link>
      </div>
    );
  }
  return (
    <div className="sf-menu-wrap" ref={ref}>
      <button type="button" className="sf-btn sf-btn-sm sf-btn-light" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)} data-testid="account-menu">
        <Ri name="user-3-line" /> <span className="sf-hide-xs">{user.firstName || "Account"}</span> <Ri name="arrow-down-s-line" />
      </button>
      {open && (
        <div className="sf-menu" role="menu">
          <div className="sf-menu-head">
            <b>{[user.firstName, user.lastName].filter(Boolean).join(" ") || "Your account"}</b>
            <div className="sf-muted sf-small">{user.email || user.phone}</div>
          </div>
          <Link role="menuitem" to="/order/orders" className="sf-menu-item">
            <Ri name="receipt-line" /> My orders
          </Link>
          <Link role="menuitem" to="/order/wallet" className="sf-menu-item">
            <Ri name="wallet-3-line" /> Wallet and cards
          </Link>
          <Link role="menuitem" to="/order/notifications" className="sf-menu-item">
            <Ri name="notification-3-line" /> Notifications
          </Link>
          <Link role="menuitem" to="/order/account" className="sf-menu-item" data-testid="menu-account">
            <Ri name="settings-3-line" /> Account and notification settings
          </Link>
          <button
            role="menuitem"
            type="button"
            className="sf-menu-item"
            onClick={async () => {
              await logout();
              toast("You are signed out.");
              navigate("/order");
            }}
          >
            <Ri name="logout-box-r-line" /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}

export default function Header({ onLocation }) {
  const loc = useSfLocation();
  const { cart, openPanel } = useSfCart();
  const { user } = useSfAuth();
  return (
    <header className="sf-header">
      <div className="sf-container sf-header-row">
        <Link to="/order" className="sf-logo" aria-label="FORKY home">
          <img src="/brand/logo-horizontal-orange.png" alt="FORKY" height="34" />
        </Link>
        <button type="button" className="sf-loc" onClick={onLocation} data-testid="location-button">
          <Ri name="map-pin-2-fill" />
          <span className="sf-loc-text">
            <span className="sf-small sf-muted">Deliver to</span>
            <b>{loc?.label || "Choose area"}</b>
          </span>
        </button>
        <nav className="sf-nav" aria-label="Main">
          <NavLink to="/order" end className="sf-navlink">
            Restaurants
          </NavLink>
          <NavLink to="/order/orders" className="sf-navlink">
            My orders
          </NavLink>
        </nav>
        <div className="sf-header-actions">
          {user && <NotifyBell />}
          <AccountMenu />
          <button type="button" className="sf-cartbtn" onClick={openPanel} aria-label={`Cart, ${cart.itemCount} item${cart.itemCount === 1 ? "" : "s"}`} data-testid="cart-button">
            <Ri name="shopping-basket-2-line" />
            {cart.itemCount > 0 && <span className="sf-badge" data-testid="cart-badge">{cart.itemCount}</span>}
            {cart.itemCount > 0 && <span className="sf-cart-total sf-hide-xs">{money(cart.subtotal)}</span>}
          </button>
        </div>
      </div>
    </header>
  );
}
