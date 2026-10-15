import React, { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage, sfHttp } from "../lib/sfApi";
import ProductCard from "./ProductCard";
import { ErrorBox, Loading, Ri, Spinner } from "./ui";

const LIMIT = 24;

/**
 * The body of a grocery / convenience / specialty store page (returns the department list and the product column, to sit in the store page's layout).
 *  - no filter: an overview, a few products per department (what the store page already loaded);
 *  - a department, a search (name, brand, SKU or barcode) or "in stock only": the paged catalog, GET /public/stores/:slug/catalog.
 */
export default function Catalog({ slug, storeName, sections, departments, closed, onOpen, onQuick }) {
  const [cat, setCat] = useState(""); // department id, "" = overview
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [inStock, setInStock] = useState(false);
  const [res, setRes] = useState(null); // { data, meta }
  const [loading, setLoading] = useState(false);
  const [more, setMore] = useState(false);
  const [error, setError] = useState("");
  const seq = useRef(0);
  const topRef = useRef(null);

  // the search box goes into the query a moment after typing stops
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 350);
    return () => clearTimeout(t);
  }, [text]);

  const browsing = !!(cat || q || inStock);

  const load = useCallback(
    async (page, append) => {
      const my = ++seq.current;
      append ? setMore(true) : setLoading(true);
      setError("");
      try {
        // a search looks through the whole store, not just the open department
        const r = await sfHttp.get(`/public/stores/${encodeURIComponent(slug)}/catalog`, { categoryId: q ? undefined : cat || undefined, q: q || undefined, inStock: inStock ? "true" : undefined, page, limit: LIMIT }, { noAuth: true });
        if (my !== seq.current) return;
        setRes((cur) => (append && cur ? { ...r, data: [...cur.data, ...r.data] } : r));
      } catch (e) {
        if (my === seq.current) setError(errorMessage(e));
      } finally {
        if (my === seq.current) {
          setLoading(false);
          setMore(false);
        }
      }
    },
    [slug, cat, q, inStock]
  );
  useEffect(() => {
    if (!browsing) {
      seq.current += 1; // drop an answer that is still on its way
      setRes(null);
      setLoading(false);
      setError("");
      return;
    }
    load(1, false);
  }, [browsing, load]);

  const choose = (id) => {
    setCat(id);
    setText("");
    setQ("");
    topRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  };

  const dept = departments.find((d) => d.id === cat);
  const title = q ? `Results for "${q}"` : dept ? dept.name : "All products";
  const total = res?.meta?.total ?? 0;

  return (
    <>
      <nav className="sf-catnav" aria-label="Departments">
        <button type="button" className={!cat && !q ? "on" : ""} aria-pressed={!cat && !q} onClick={() => choose("")} data-testid="dept-overview">
          Overview
        </button>
        {departments.map((d) => (
          <button key={d.id} type="button" className={cat === d.id && !q ? "on" : ""} aria-pressed={cat === d.id && !q} onClick={() => choose(d.id)} data-testid="dept-link" data-dept={d.name}>
            {d.name} <span className="sf-count">{d.itemCount}</span>
          </button>
        ))}
      </nav>
      <div className="sf-menu-col" data-testid="menu">
        <div className="sf-storebar" ref={topRef}>
          <form
            className="sf-storesearch"
            role="search"
            onSubmit={(e) => {
              e.preventDefault();
              setQ(text.trim());
            }}
          >
            <Ri name="search-line" />
            <input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Search this store: product, brand or barcode" aria-label={`Search ${storeName}`} data-testid="store-search" maxLength={80} />
          </form>
          <button type="button" className={`sf-chip ${inStock ? "on" : ""}`} aria-pressed={inStock} onClick={() => setInStock((v) => !v)} data-testid="filter-instock">
            <Ri name={inStock ? "checkbox-circle-line" : "checkbox-blank-circle-line"} /> In stock only
          </button>
        </div>

        {browsing ? (
          <section aria-live="polite">
            <h2 className="sf-h2" data-testid="catalog-title">
              {title}{" "}
              {res && <span className="sf-muted sf-small ms-2">{total} {total === 1 ? "product" : "products"}</span>}
            </h2>
            {error && <ErrorBox message={error} onRetry={() => load(1, false)} />}
            {loading && !res && <Loading text="Loading products..." />}
            {res && res.data.length === 0 && !loading && (
              <div className="sf-center sf-muted py-4" data-testid="catalog-empty">
                <Ri name="search-line" className="sf-bigicon" />
                <p className="mt-2">{q ? `No product matches "${q}".` : "No products here."}{inStock ? " Try turning off the in stock filter." : ""}</p>
                <button
                  type="button"
                  className="sf-btn sf-btn-light"
                  onClick={() => {
                    setText("");
                    setQ("");
                    setCat("");
                    setInStock(false);
                  }}
                >
                  Clear search and filters
                </button>
              </div>
            )}
            <div className={`sf-products ${loading && res ? "is-busy" : ""}`} data-testid="catalog-results">
              {(res?.data || []).map((it) => (
                <ProductCard key={it.id} item={it} closed={closed} onOpen={onOpen} onQuick={onQuick} />
              ))}
            </div>
            {res && res.data.length > 0 && (
              <div className="sf-center mt-3 mb-4">
                <p className="sf-small sf-muted mb-2">
                  Showing {res.data.length} of {total}
                </p>
                {res.data.length < total && (
                  <button type="button" className="sf-btn sf-btn-light" disabled={more} onClick={() => load((res.meta?.page || 1) + 1, true)} data-testid="load-more">
                    {more ? <Spinner size={16} /> : null} Load more
                  </button>
                )}
              </div>
            )}
          </section>
        ) : (
          <>
            {sections.length === 0 && <p className="sf-muted">This store has no products listed at the moment.</p>}
            {sections.map((s) => (
              <section key={s.id} id={`cat-${s.id}`} className="sf-cat" data-testid="dept-section">
                <div className="sf-row-between">
                  <h2 className="sf-h2">{s.name}</h2>
                  {s.id !== "popular" && (
                    <button type="button" className="sf-btn sf-btn-link" onClick={() => choose(s.id)} data-testid="dept-see-all">
                      See all {s.itemCount ?? s.items.length}
                    </button>
                  )}
                </div>
                <div className="sf-products">
                  {s.items.map((it) => (
                    <ProductCard key={`${s.id}-${it.id}`} item={it} closed={closed} onOpen={onOpen} onQuick={onQuick} />
                  ))}
                </div>
              </section>
            ))}
          </>
        )}
      </div>
    </>
  );
}
