import React, { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import PushBanner from "../components/PushBanner";
import RestaurantCard from "../components/RestaurantCard";
import { ErrorBox, Loading, Ri, Spinner } from "../components/ui";
import { locParams, useSfLocation } from "../lib/location";
import { errorMessage, sfHttp } from "../lib/sfApi";

const LIMIT = 18;

export default function Home({ openAssistant }) {
  const loc = useSfLocation();
  const [params, setParams] = useSearchParams();
  const q = params.get("q") || "";
  const openNow = params.get("open") === "1";
  const fulfilment = ["delivery", "pickup"].includes(params.get("f")) ? params.get("f") : "";
  const cuisine = params.get("c") || "";
  const [text, setText] = useState(q);
  const [home, setHome] = useState(null);
  const [res, setRes] = useState(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState("");
  const seq = useRef(0);

  const set = useCallback(
    (patch) => {
      const next = new URLSearchParams(params);
      Object.entries(patch).forEach(([k, v]) => (v ? next.set(k, v) : next.delete(k)));
      setParams(next, { replace: true });
    },
    [params, setParams]
  );

  // debounce the search box into the URL
  useEffect(() => {
    if (text === q) return undefined;
    const t = setTimeout(() => set({ q: text.trim() }), 350);
    return () => clearTimeout(t);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let live = true;
    sfHttp.get("/public/home", locParams(loc), { noAuth: true }).then((h) => live && setHome(h)).catch(() => {});
    return () => {
      live = false;
    };
  }, [loc]);

  const load = useCallback(
    async (pg, append) => {
      const my = ++seq.current;
      append ? setMore(true) : setLoading(true);
      setError("");
      try {
        const r = await sfHttp.get(
          "/public/search",
          { q, openNow: openNow ? "true" : undefined, fulfilment: fulfilment || undefined, cuisine: cuisine || undefined, page: pg, limit: LIMIT, ...locParams(loc) },
          { noAuth: true }
        );
        if (my !== seq.current) return;
        setRes((cur) => (append && cur ? { ...r, restaurants: [...cur.restaurants, ...r.restaurants] } : r));
        setPage(pg);
      } catch (e) {
        if (my === seq.current) setError(errorMessage(e));
      } finally {
        if (my === seq.current) {
          setLoading(false);
          setMore(false);
        }
      }
    },
    [q, openNow, fulfilment, cuisine, loc]
  );
  useEffect(() => {
    load(1, false);
  }, [load]);

  const list = res?.restaurants || [];
  const total = res?.meta?.total ?? list.length;
  const promos = home?.promotions || [];
  const cuisines = (home?.cuisines || []).filter((c) => c.restaurantCount > 0);

  return (
    <div className="sf-container">
      <section className="sf-hero">
        <h1>Food and groceries from local places, delivered.</h1>
        <p>Mississauga and Brampton restaurants, cafes and convenience stores.</p>
        <form className="sf-search" role="search" onSubmit={(e) => { e.preventDefault(); set({ q: text.trim() }); }}>
          <Ri name="search-line" />
          <input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Search restaurants, dishes or cuisines" aria-label="Search" data-testid="search-input" maxLength={80} />
          <button type="submit" className="sf-btn sf-btn-primary">
            Search
          </button>
        </form>
        {openAssistant && (
          <button type="button" className="sf-btn sf-btn-light sf-hero-bot" onClick={openAssistant}>
            <Ri name="chat-smile-3-line" /> Not sure what to order? Ask our assistant
          </button>
        )}
      </section>

      <PushBanner />

      <div className="sf-filters" role="group" aria-label="Filters">
        <button type="button" className={`sf-chip ${openNow ? "on" : ""}`} aria-pressed={openNow} onClick={() => set({ open: openNow ? "" : "1" })} data-testid="filter-open">
          <Ri name="door-open-line" /> Open now
        </button>
        <button type="button" className={`sf-chip ${fulfilment === "delivery" ? "on" : ""}`} aria-pressed={fulfilment === "delivery"} onClick={() => set({ f: fulfilment === "delivery" ? "" : "delivery" })} data-testid="filter-delivery">
          <Ri name="e-bike-2-line" /> Delivery
        </button>
        <button type="button" className={`sf-chip ${fulfilment === "pickup" ? "on" : ""}`} aria-pressed={fulfilment === "pickup"} onClick={() => set({ f: fulfilment === "pickup" ? "" : "pickup" })} data-testid="filter-pickup">
          <Ri name="walk-line" /> Pickup
        </button>
        {cuisines.slice(0, 12).map((c) => (
          <button key={c.id} type="button" className={`sf-chip ${cuisine === c.slug ? "on" : ""}`} aria-pressed={cuisine === c.slug} onClick={() => set({ c: cuisine === c.slug ? "" : c.slug })}>
            {c.name}
          </button>
        ))}
      </div>

      {promos.length > 0 && !q && (
        <div className="sf-promos" aria-label="Offers">
          {promos.slice(0, 4).map((p) => (
            <div key={p.id} className="sf-promo">
              <b>{p.label || p.name}</b>
              <span className="sf-small">{p.description}</span>
              {p.code && <code>{p.code}</code>}
            </div>
          ))}
        </div>
      )}

      <h2 className="sf-h2">
        {q ? `Results for "${q}"` : "Restaurants and stores near you"}
        {res && <span className="sf-muted sf-small ms-2">{total} found</span>}
      </h2>
      {!loc && <p className="sf-small sf-muted">Tip: choose your area at the top to see who delivers to you.</p>}

      {error && <ErrorBox message={error} onRetry={() => load(1, false)} />}
      {loading && !res && <Loading text="Finding places..." />}
      {res && list.length === 0 && !loading && (
        <div className="sf-center sf-muted py-5">
          <Ri name="emotion-sad-line" className="sf-bigicon" />
          <p className="mt-2">Nothing matches. Try removing a filter.</p>
          <button type="button" className="sf-btn sf-btn-light" onClick={() => { setText(""); setParams({}, { replace: true }); }}>
            Clear filters
          </button>
        </div>
      )}
      <div className={`sf-grid ${loading && res ? "is-busy" : ""}`} data-testid="restaurant-list">
        {list.map((r) => (
          <RestaurantCard key={r.id} r={r} />
        ))}
      </div>
      {res && list.length < total && (
        <div className="sf-center mt-3 mb-4">
          <button type="button" className="sf-btn sf-btn-light" disabled={more} onClick={() => load(page + 1, true)}>
            {more ? <Spinner size={16} /> : null} Show more
          </button>
        </div>
      )}
    </div>
  );
}
