import React, { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import AuthForms from "../components/AuthForms";
import { ErrorBox, Loading, Notice, Ri, Spinner } from "../components/ui";
import { assistantApi } from "../lib/assistantApi";
import { SF_KEYS, errorMessage, sfHttp, sfStore } from "../lib/sfApi";
import { useSfAuth } from "../lib/SfAuth";
import { useSfCart } from "../lib/SfCart";

/**
 * Handoff from an assistant (embedded widget on a merchant site, or the site bot) to the storefront.
 *
 * Token handling (the one-time token is a bearer secret):
 *  1. read ?token= on the very first render and remove the whole query string from the address bar (history.replaceState)
 *  2. keep it only in sessionStorage ("sf.handoff") so the flow survives a reload / the login detour
 *  3. status machine, persisted BEFORE every side effect:  pending -> importing -> done | failed
 *     - the import is attempted exactly once per token; `importing` found after a reload is never replayed
 *       (the server may have consumed the token): we look at the server cart instead
 *     - on done / failed the token is dropped from storage: a consumed token can never be reused
 *     - only a network failure (no response at all) goes back to `pending` so the customer can retry
 */
export const HANDOFF_NOTE_KEY = SF_KEYS.orderNote;

const USED_KEY = "sf.handoff.used";
const usedList = () => sfStore.getJson(USED_KEY, "session", []) || [];
const markUsed = (fp) => sfStore.setJson(USED_KEY, [...usedList().filter((x) => x !== fp), fp].slice(-10));
const unmarkUsed = (fp) => sfStore.setJson(USED_KEY, usedList().filter((x) => x !== fp));
const readState = () => sfStore.getJson(SF_KEYS.handoff, "session", null);
const writeState = (s) => (s ? sfStore.setJson(SF_KEYS.handoff, s) : sfStore.del(SF_KEYS.handoff));

/** Runs once, synchronously, on the first render. */
function captureToken() {
  let token = null;
  let slug = null;
  try {
    const p = new URLSearchParams(window.location.search);
    token = (p.get("token") || "").trim() || null;
    slug = (p.get("restaurant") || p.get("r") || p.get("slug") || "").trim().slice(0, 120) || null;
    if (window.location.search || window.location.hash) {
      window.history.replaceState(window.history.state, "", window.location.pathname); // token gone from the address bar
    }
  } catch {
    /* ignore */
  }
  if (token) {
    const cur = readState();
    if (cur && cur.token === token) {
      // same link opened again (reload before the URL was cleaned, back button): keep the persisted state
      if (slug && !cur.slug) writeState({ ...cur, slug });
    } else if (usedList().includes(token.slice(-8)) || (cur && cur.fingerprint === token.slice(-8))) {
      // this link was already used in this tab (or is being used): never replay it
      writeState({ token: null, fingerprint: token.slice(-8), status: "failed", slug, error: "This checkout link was already used. Go back to the restaurant and tap checkout again to get a new one.", at: Date.now() });
    } else {
      writeState({ token, fingerprint: token.slice(-8), status: "pending", slug, at: Date.now() });
    }
  }
  return readState();
}

export default function Handoff() {
  const navigate = useNavigate();
  const { user, loading } = useSfAuth();
  const { ready, refresh } = useSfCart();
  const [state, setState] = useState(captureToken);
  const [restaurantName, setRestaurantName] = useState("");
  const [busyMsg, setBusyMsg] = useState("");
  const running = useRef(false);

  const update = useCallback((patch) => {
    const next = { ...(readState() || {}), ...patch };
    writeState(next);
    setState(next);
    return next;
  }, []);

  // friendly restaurant name for the sign-in screen (only when the link told us which restaurant)
  useEffect(() => {
    if (!state?.slug || restaurantName) return;
    sfHttp
      .get(`/public/restaurants/${encodeURIComponent(state.slug)}`, undefined, { noAuth: true })
      .then((d) => setRestaurantName(d?.restaurant?.name || ""))
      .catch(() => {});
  }, [state?.slug, restaurantName]);

  const doImport = useCallback(async () => {
    const cur = readState();
    if (!cur || cur.status !== "pending" || !cur.token || running.current) return;
    running.current = true;
    const token = cur.token;
    markUsed(cur.fingerprint || token.slice(-8));
    update({ status: "importing" }); // persisted first: a reload in the middle never replays the token
    try {
      const r = await assistantApi.importHandoff(token);
      // consumed: drop the token for good
      const note = r.orderNote || "";
      if (note) sfStore.setJson(HANDOFF_NOTE_KEY, { restaurantId: r.restaurant?.id, note });
      sfStore.del(SF_KEYS.guestCart, "local"); // the assistant cart replaces any guest cart
      update({ token: null, status: "done", result: { restaurant: r.restaurant, cartCount: r.cartCount, orderNote: note, skipped: r.skipped || [] }, slug: r.restaurant?.slug || cur.slug });
      await refresh().catch(() => {});
    } catch (e) {
      if (!e?.response) {
        // network failure: the token was not consumed, allow a retry
        unmarkUsed(cur.fingerprint || token.slice(-8));
        update({ status: "pending", networkError: errorMessage(e) });
      } else {
        update({ token: null, status: "failed", error: errorMessage(e), httpStatus: e.response.status });
      }
    } finally {
      running.current = false;
    }
  }, [refresh, update]);

  // signed in + cart synced -> import (once)
  useEffect(() => {
    if (loading || !user || !ready || !state) return;
    if (state.status === "pending") doImport();
  }, [loading, user, ready, state, doImport]);

  // reload while "importing": do not replay; look at what the server has
  useEffect(() => {
    if (loading || !user || !ready || state?.status !== "importing" || running.current) return;
    running.current = true;
    (async () => {
      try {
        const c = await refresh();
        if (c && c.itemCount > 0) {
          update({ token: null, status: "done", result: { restaurant: c.restaurant ? { id: c.restaurant.id, slug: c.restaurant.slug, name: c.restaurant.name } : null, cartCount: c.itemCount, orderNote: "", skipped: [], recovered: true } });
        } else {
          update({ token: null, status: "failed", error: "We could not confirm that your order was imported. Please go back to the restaurant and start the checkout again." });
        }
      } catch {
        update({ token: null, status: "failed", error: "We could not confirm that your order was imported. Please go back to the restaurant and start the checkout again." });
      } finally {
        running.current = false;
      }
    })();
  }, [loading, user, ready, state?.status, refresh, update]);

  const result = state?.result;
  const finish = useCallback(() => {
    writeState(null);
    navigate("/order/checkout", { replace: true });
  }, [navigate]);

  // no skipped items: continue by itself after a short moment
  const [count, setCount] = useState(4);
  useEffect(() => {
    if (state?.status !== "done" || result?.skipped?.length) return undefined;
    if (count <= 0) {
      finish();
      return undefined;
    }
    const t = setTimeout(() => setCount((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [state?.status, result?.skipped?.length, count, finish]);

  const restaurantLink = state?.slug || result?.restaurant?.slug ? `/order/r/${encodeURIComponent(state?.slug || result.restaurant.slug)}` : "/order";

  // ------------------------------------------------------------------ views
  if (!state) {
    return (
      <div className="sf-container sf-narrow">
        <div className="sf-center py-5">
          <Ri name="link-unlink" className="sf-bigicon" />
          <h1 className="sf-h2 mt-2">This checkout link is not valid</h1>
          <p className="sf-muted">It is missing its code, or you already used it. Go back to the restaurant and tap checkout again.</p>
          <Link to="/order" className="sf-btn sf-btn-primary">Browse restaurants</Link>
        </div>
      </div>
    );
  }

  if (state.status === "failed") {
    return (
      <div className="sf-container sf-narrow" data-testid="handoff-failed">
        <div className="sf-center py-4">
          <Ri name="error-warning-line" className="sf-bigicon sf-danger" />
          <h1 className="sf-h2 mt-2">We could not bring your order over</h1>
        </div>
        <ErrorBox message={state.error || "This checkout link is not valid."} />
        <p className="sf-muted">The link can only be used once and expires after a short time. Go back to the restaurant and tap checkout again to get a new one.</p>
        <div className="d-grid gap-2">
          <Link to={restaurantLink} className="sf-btn sf-btn-primary" onClick={() => writeState(null)}>
            {state.slug || result?.restaurant ? "Back to the restaurant" : "Browse restaurants"}
          </Link>
          {user && (
            <Link to="/order/checkout" className="sf-btn sf-btn-light" onClick={() => writeState(null)}>
              Go to my cart
            </Link>
          )}
        </div>
      </div>
    );
  }

  if (state.status === "done" && result) {
    return (
      <div className="sf-container sf-narrow" data-testid="handoff-done">
        <div className="sf-center py-4">
          <Ri name="checkbox-circle-fill" className="sf-bigicon sf-ok" />
          <h1 className="sf-h2 mt-2" data-testid="handoff-summary">
            {result.recovered ? "Your order is ready for checkout" : `We added ${result.cartCount} item${result.cartCount === 1 ? "" : "s"}${result.restaurant?.name ? ` from ${result.restaurant.name}` : ""}`}
          </h1>
        </div>
        {result.orderNote && (
          <div className="sf-card sf-pad mb-3">
            <b>Note for the kitchen</b>
            <p className="mb-0">{result.orderNote}</p>
            <div className="sf-small sf-muted">We will put this in your order. You can change it at checkout.</div>
          </div>
        )}
        {result.skipped?.length > 0 && (
          <Notice tone="warn" icon="alert-line">
            <b>Some items could not be added:</b>
            <ul className="mb-0" data-testid="handoff-skipped">
              {result.skipped.map((s, i) => (
                <li key={i}>
                  {s.name} <span className="sf-muted">- {s.reason}</span>
                </li>
              ))}
            </ul>
          </Notice>
        )}
        <button type="button" className="sf-btn sf-btn-primary sf-btn-block" onClick={finish} data-testid="handoff-continue">
          Continue to checkout {!result.skipped?.length && count > 0 ? `(${count})` : ""}
        </button>
        <Link to={restaurantLink} className="sf-btn sf-btn-link sf-btn-block" onClick={() => writeState(null)}>
          Keep browsing the menu
        </Link>
      </div>
    );
  }

  // pending / importing
  if (loading || (user && (!ready || state.status === "importing" || state.status === "pending"))) {
    return (
      <div className="sf-container sf-narrow">
        <Loading text={busyMsg || "Bringing your order over..."} />
        {state.networkError && (
          <ErrorBox message={state.networkError} onRetry={() => { update({ networkError: null }); doImport(); }} />
        )}
      </div>
    );
  }

  // not signed in
  return (
    <div className="sf-container sf-narrow" data-testid="handoff-login">
      <div className="sf-center py-3">
        <Ri name="shopping-basket-2-line" className="sf-bigicon" />
        <h1 className="sf-h2 mt-2">Log in or create an account to continue with your order{restaurantName ? ` from ${restaurantName}` : ""}</h1>
        <p className="sf-muted">Your items are waiting. It takes a minute, then you check out.</p>
      </div>
      <div className="sf-card sf-pad">
        <AuthForms
          onDone={() => {
            setBusyMsg("Bringing your order over...");
          }}
        />
      </div>
      <p className="sf-small sf-muted mt-3 text-center">
        <Spinner size={12} /> Your checkout link is kept safely in this tab. If you reload this page you will not lose it.
      </p>
    </div>
  );
}
