import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import ItemDialog, { hasRequiredChoices, itemDisabled } from "../components/ItemDialog";
import { availability, Rating } from "../components/RestaurantCard";
import { ErrorBox, Loading, Notice, Pic, Ri, priceLevel, useToast } from "../components/ui";
import { DAYS, fmtOpens, hoursText } from "../lib/fmt";
import { locParams, useSfLocation } from "../lib/location";
import { errorMessage, errorStatus, money, sfHttp } from "../lib/sfApi";
import { useSfCart } from "../lib/SfCart";

function ItemCard({ item, closed, onOpen, onQuick }) {
  const disabled = itemDisabled(item, closed);
  const quick = !disabled && !(item.modifierGroups || []).length;
  return (
    <div className={`sf-item ${disabled ? "is-disabled" : ""}`} data-testid="menu-item" data-item-id={item.id}>
      <button type="button" className="sf-item-main" onClick={() => onOpen(item)} aria-label={`${item.name}, ${money(item.price)}${item.available === false ? ", sold out" : ""}`}>
        <div className="sf-item-text">
          <div className="sf-item-name">{item.name}</div>
          {item.description && <div className="sf-small sf-muted sf-clamp2">{item.description}</div>}
          <div className="sf-item-price">
            {money(item.price)}
            {item.pickupPrice != null && item.pickupPrice < item.price && <span className="sf-small sf-muted ms-2">{money(item.pickupPrice)} pickup</span>}
          </div>
          <div className="sf-tags">
            {item.available === false && <span className="sf-tag sf-tag-danger">Sold out{item.unavailableReason ? ` - ${item.unavailableReason}` : ""}</span>}
            {item.isPopular && item.available !== false && <span className="sf-tag sf-tag-promo">Popular</span>}
            {(item.dietaryTags || []).slice(0, 3).map((t) => (
              <span key={t} className="sf-tag sf-tag-ok">{t}</span>
            ))}
            {(item.modifierGroups || []).length > 0 && <span className="sf-tag">Customisable</span>}
          </div>
        </div>
        {item.imageUrl && <Pic src={item.imageUrl} name={item.name} className="sf-item-img" />}
      </button>
      <button
        type="button"
        className="sf-addbtn"
        disabled={disabled}
        onClick={() => (quick ? onQuick(item) : onOpen(item))}
        aria-label={disabled ? `${item.name} is not available` : `Add ${item.name}`}
        data-testid="item-quick-add"
      >
        <Ri name={disabled ? "forbid-line" : "add-line"} />
      </button>
    </div>
  );
}

export default function Restaurant() {
  const { slug } = useParams();
  const loc = useSfLocation();
  const toast = useToast();
  const { cart, addItem, openPanel } = useSfCart();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(null); // item shown in the dialog
  const [activeCat, setActiveCat] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await sfHttp.get(`/public/restaurants/${encodeURIComponent(slug)}`, locParams(loc), { noAuth: true }));
    } catch (e) {
      setData(null);
      setError({ status: errorStatus(e), message: errorMessage(e) });
    } finally {
      setLoading(false);
    }
  }, [slug, loc]);
  useEffect(() => {
    load();
  }, [load]);
  // refresh availability while the page stays open (sold-out toggles, opening hours)
  useEffect(() => {
    const t = setInterval(() => load(), 120000);
    return () => clearInterval(t);
  }, [load]);

  const r = data?.restaurant;
  const sections = useMemo(() => {
    if (!data) return [];
    const cats = (data.menu?.categories || []).filter((c) => c.items?.length);
    const pop = data.menu?.popular || [];
    return [...(pop.length ? [{ id: "popular", name: "Popular", items: pop }] : []), ...cats];
  }, [data]);

  if (loading && !data) return <div className="sf-container"><Loading text="Loading menu..." /></div>;
  if (error) {
    return (
      <div className="sf-container">
        {error.status === 404 ? (
          <div className="sf-center py-5">
            <Ri name="store-3-line" className="sf-bigicon" />
            <h1 className="sf-h2 mt-2">We could not find that restaurant</h1>
            <p className="sf-muted">It may have closed or the link is wrong.</p>
            <Link to="/order" className="sf-btn sf-btn-primary">Browse restaurants</Link>
          </div>
        ) : (
          <ErrorBox message={error.message} onRetry={load} />
        )}
      </div>
    );
  }
  if (!r) return null;

  const av = availability(r);
  const closed = r.serviceMode === "CLOSED" || r.isOpen === false;
  const closedReason = closed ? (r.serviceMode === "CLOSED" ? "Closed" : "Closed now") : "";
  const tz = r.timezone || "America/Toronto";
  const todayName = new Date().toLocaleDateString("en-US", { weekday: "long", timeZone: tz });
  const todayIdx = DAYS.indexOf(todayName);
  const todayRows = (r.hours || []).filter((h) => h.dayOfWeek === todayIdx);
  const sameRestaurant = cart.restaurant?.id === r.id;

  const add = (payload) => addItem({ restaurant: r, ...payload });
  const quickAdd = async (item) => {
    if (hasRequiredChoices(item)) return setOpen(item);
    if (await add({ item, quantity: 1, options: [], notes: "" })) toast(`${item.name} added to your cart`, "success");
  };

  return (
    <div className="sf-container sf-rpage">
      <div className="sf-rhead">
        <div className="sf-rhead-cover">
          <Pic src={r.coverUrl} name={r.name} className="sf-rhead-img" />
        </div>
        <div className="sf-rhead-body">
          <Pic src={r.logoUrl} name={r.name} className="sf-rhead-logo" rounded />
          <div className="sf-rhead-info">
            <h1 data-testid="restaurant-name">{r.name}</h1>
            <div className="sf-small sf-muted">
              {(r.cuisines || []).join(" - ")} - {priceLevel(r.priceLevel)}
            </div>
            <div className="sf-rhead-meta">
              <Rating r={r} />
              {r.etaRange && (
                <span>
                  <Ri name="time-line" /> {r.etaRange.min}-{r.etaRange.max} min
                </span>
              )}
              <span>
                <Ri name="timer-line" /> Prep ~{r.prepTimeMin} min
              </span>
              {r.minimumOrder > 0 && (
                <span>
                  <Ri name="shopping-bag-3-line" /> {money(r.minimumOrder)} minimum
                </span>
              )}
              {r.deliveryFee != null && r.deliveryAvailable && (
                <span>
                  <Ri name="e-bike-2-line" /> {r.deliveryFee === 0 ? "Free delivery" : `${money(r.deliveryFee)} delivery`}
                </span>
              )}
            </div>
          </div>
          <span className={`sf-tag sf-tag-${av.tone} sf-rhead-badge`} data-testid="service-badge">
            {av.text}
          </span>
        </div>
      </div>

      {closed && (
        <Notice tone="danger" icon="time-line">
          <b>{r.serviceMode === "CLOSED" ? "This place is not taking orders right now." : `${r.name} is closed right now.`}</b>{" "}
          {r.nextOpening && r.serviceMode !== "CLOSED" ? `Opens ${fmtOpens(r.nextOpening, tz)} ` : ""}You can look at the menu, but items cannot be added to your cart until it is open.
        </Notice>
      )}
      {!closed && av.text === "Pickup only" && <Notice tone="warn" icon="walk-line">{av.detail}. You can still order for pickup.</Notice>}
      {!closed && !r.deliveryAvailable && r.serviceMode === "PICKUP_AND_DELIVERY" && !loc && (
        <Notice tone="info">Choose your area at the top to see if {r.name} delivers to you.</Notice>
      )}
      {sameRestaurant === false && cart.restaurant && cart.itemCount > 0 && (
        <Notice tone="info" icon="shopping-basket-2-line">
          Your cart has items from <b>{cart.restaurant.name}</b>. Adding something here will ask if you want to start a new cart.
        </Notice>
      )}

      <div className="sf-rlayout">
        <nav className="sf-catnav" aria-label="Menu sections">
          {sections.map((s) => (
            <a
              key={s.id}
              href={`#cat-${s.id}`}
              className={activeCat === s.id ? "on" : ""}
              onClick={(e) => {
                e.preventDefault();
                setActiveCat(s.id);
                document.getElementById(`cat-${s.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
            >
              {s.name}
            </a>
          ))}
        </nav>
        <div className="sf-menu-col" data-testid="menu">
          {sections.length === 0 && <p className="sf-muted">This menu is empty at the moment.</p>}
          {sections.map((s) => (
            <section key={s.id} id={`cat-${s.id}`} className="sf-cat">
              <h2 className="sf-h2">{s.name}</h2>
              {s.description && <p className="sf-small sf-muted">{s.description}</p>}
              <div className="sf-items">
                {s.items.map((it) => (
                  <ItemCard key={`${s.id}-${it.id}`} item={it} closed={closed} onOpen={setOpen} onQuick={quickAdd} />
                ))}
              </div>
            </section>
          ))}
        </div>
        <aside className="sf-rinfo">
          <div className="sf-card sf-pad">
            <h3 className="sf-h3">Info</h3>
            <p className="mb-1">
              <Ri name="map-pin-line" /> {r.address?.line1}, {r.address?.city}
            </p>
            {r.phone && (
              <p className="mb-1">
                <Ri name="phone-line" /> {r.phone}
              </p>
            )}
            <p className="mb-1">
              <Ri name="time-line" /> Today: {todayRows.length ? todayRows.map(hoursText).join(", ") : "Closed"}
            </p>
            <details className="sf-small">
              <summary>All opening hours</summary>
              <table className="sf-hours">
                <tbody>
                  {DAYS.map((d, i) => (
                    <tr key={d} className={i === todayIdx ? "on" : ""}>
                      <td>{d}</td>
                      <td>{(r.hours || []).filter((h) => h.dayOfWeek === i).map(hoursText).join(", ") || "Closed"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
            {r.pickupInstructions && <p className="sf-small sf-muted mt-2">Pickup: {r.pickupInstructions}</p>}
          </div>
          {data.promos?.length > 0 && (
            <div className="sf-card sf-pad mt-3">
              <h3 className="sf-h3">Offers</h3>
              {data.promos.slice(0, 3).map((p) => (
                <div key={p.id} className="sf-small mb-2">
                  <b>{p.label || p.name}</b> {p.code && <code>{p.code}</code>}
                  <div className="sf-muted">{p.description}</div>
                </div>
              ))}
            </div>
          )}
        </aside>
      </div>

      {cart.itemCount > 0 && sameRestaurant && (
        <div className="sf-cartbar">
          <button type="button" className="sf-btn sf-btn-primary sf-btn-block" onClick={openPanel} data-testid="view-cart">
            <span className="sf-badge-inline">{cart.itemCount}</span> View cart <span className="ms-auto">{money(cart.subtotal)}</span>
          </button>
        </div>
      )}

      {open && (
        <ItemDialog
          key={open.id}
          item={open}
          open
          onClose={() => setOpen(null)}
          disabledReason={closedReason ? `${closedReason} - cannot add` : ""}
          onAdd={async (p) => {
            const ok = await add(p);
            if (ok) toast(`${p.item.name} added to your cart`, "success");
            return ok;
          }}
        />
      )}
    </div>
  );
}
