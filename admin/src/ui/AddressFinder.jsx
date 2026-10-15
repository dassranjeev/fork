import React, { useEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react/offline";
import { http } from "../lib/api";

const sessionId = () => (window.crypto?.randomUUID ? window.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}-adm`);

/**
 * "Find address" helper for the admin forms: types an address, shows suggestions from the active maps provider, Mapbox or Google (through the authenticated
 * GET /admin/geocode/* routes; the provider key stays on the server) and calls onPick({ line1, city, province, postalCode, lat, lng, label }).
 * Renders nothing useful (a short hint) when address search is not configured.
 */
export function AddressFinder({ onPick, label = "Find address", placeholder = "Type a street address to find its map position", proximity }) {
  const [q, setQ] = useState("");
  const [items, setItems] = useState([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [off, setOff] = useState(false);
  const session = useRef(sessionId());
  const seq = useRef(0);

  useEffect(() => {
    const text = q.trim();
    if (text.length < 3) {
      setItems([]);
      setMsg("");
      return undefined;
    }
    const my = ++seq.current;
    const t = setTimeout(async () => {
      setBusy(true);
      try {
        const r = await http.get("/admin/geocode/autocomplete", { q: text, sessionToken: session.current, proximity });
        if (my !== seq.current) return;
        if (r.enabled === false) {
          setOff(true);
          setItems([]);
        } else {
          setOff(false);
          setItems(r.suggestions || []);
          setMsg((r.suggestions || []).length ? "" : "No matching address");
          setOpen(true);
        }
      } catch (e) {
        if (my === seq.current) setMsg(e?.response?.data?.message || "Search failed");
      } finally {
        if (my === seq.current) setBusy(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [q, proximity]);

  const pick = async (it) => {
    setOpen(false);
    setBusy(true);
    try {
      const r = await http.get("/admin/geocode/retrieve", { id: it.id, sessionToken: session.current });
      if (r.address) {
        setQ(r.address.label || it.label);
        onPick(r.address);
        session.current = sessionId();
      }
    } catch (e) {
      setMsg(e?.response?.data?.message || "Lookup failed");
    } finally {
      setBusy(false);
    }
  };

  if (off) return <div className="text-secondary-light text-xs mb-12" data-testid="finder-off">Address search is not configured (System &gt; Integrations &gt; Maps). Click the map to place the pin.</div>;
  return (
    <div className="mb-16 position-relative" data-testid="address-finder">
      <label className="form-label fw-semibold text-sm">{label}</label>
      <div className="input-group">
        <span className="input-group-text bg-transparent"><Icon icon="solar:map-point-search-outline" /></span>
        <input className="form-control radius-8" value={q} placeholder={placeholder} maxLength={100} onChange={(e) => setQ(e.target.value)} onFocus={() => items.length && setOpen(true)} onKeyDown={(e) => e.key === "Escape" && setOpen(false)} aria-label={label} data-testid="finder-input" autoComplete="off" />
        {busy && <span className="input-group-text bg-transparent"><span className="spinner-border spinner-border-sm" /></span>}
      </div>
      {open && (items.length > 0 || msg) && (
        <ul className="list-group position-absolute w-100 shadow-sm radius-8" style={{ zIndex: 1050, maxHeight: 260, overflowY: "auto" }} role="listbox" data-testid="finder-list">
          {items.map((it) => (
            <li key={it.id} role="option" aria-selected="false" className="list-group-item list-group-item-action" style={{ cursor: "pointer" }} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(it)} data-testid="finder-option">
              <b>{it.line1}</b> <span className="text-secondary-light text-sm">{it.secondary}</span>
            </li>
          ))}
          {!items.length && msg && <li className="list-group-item text-secondary-light text-sm">{msg}</li>}
        </ul>
      )}
    </div>
  );
}
