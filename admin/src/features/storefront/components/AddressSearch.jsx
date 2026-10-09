import React, { useEffect, useId, useRef, useState } from "react";
import { newSessionToken, retrieveAddress, suggestAddresses } from "../lib/geocode";
import { errorMessage } from "../lib/sfApi";
import { Ri, Spinner } from "./ui";

/**
 * Address autocomplete (ARIA combobox): debounced typing, Up / Down / Enter / Escape, click or tap. `onPick(address)` receives
 * { line1, city, province, postalCode, lat, lng, label } from the FORKSY API (which asks Mapbox). The parent only renders this
 * when address search is enabled.
 */
export default function AddressSearch({ onPick, proximity, label = "Search your address", placeholder = "Start typing your street address", testId = "addr-search" }) {
  const id = useId();
  const [text, setText] = useState("");
  const [items, setItems] = useState([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const session = useRef(newSessionToken());
  const seq = useRef(0);
  const box = useRef(null);

  useEffect(() => {
    const q = text.trim();
    if (q.length < 3) {
      setItems([]);
      setMsg("");
      setBusy(false);
      return undefined;
    }
    const my = ++seq.current;
    setBusy(true);
    const t = setTimeout(async () => {
      try {
        const r = await suggestAddresses(q, session.current, proximity);
        if (my !== seq.current) return;
        if (r.enabled === false) {
          setMsg("Address search is not available right now. Enter the address below.");
          setItems([]);
        } else {
          setItems(r.suggestions || []);
          setMsg(r.error ? r.error : (r.suggestions || []).length ? "" : "No matching address found. Check the spelling or enter it below.");
        }
        setActive(-1);
        setOpen(true);
      } catch (e) {
        if (my === seq.current) {
          setItems([]);
          setMsg(errorMessage(e));
          setOpen(true);
        }
      } finally {
        if (my === seq.current) setBusy(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [text, proximity]);

  useEffect(() => {
    const close = (e) => !box.current?.contains(e.target) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const pick = async (it) => {
    setOpen(false);
    setBusy(true);
    try {
      const r = await retrieveAddress(it.id, session.current);
      if (r.address) {
        setText(r.address.label || it.label);
        onPick(r.address);
        session.current = newSessionToken(); // the session ends with the retrieve
        setItems([]);
        setMsg("");
      } else setMsg("That address could not be located. Try another one.");
    } catch (e) {
      setMsg(errorMessage(e));
      setOpen(true);
    } finally {
      setBusy(false);
    }
  };

  const onKey = (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open && items.length) setOpen(true);
      setActive((a) => Math.min(items.length - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter" && open && active >= 0 && items[active]) {
      e.preventDefault();
      pick(items[active]);
    } else if (e.key === "Escape") {
      if (open) {
        e.stopPropagation();
        setOpen(false);
      }
    }
  };

  const listId = `${id}-list`;
  return (
    <div className="sf-field sf-combo" ref={box}>
      <label className="sf-label" htmlFor={`${id}-in`}>{label}</label>
      <div className="sf-combo-wrap">
        <input
          id={`${id}-in`}
          className="sf-input"
          role="combobox"
          aria-expanded={open && (items.length > 0 || !!msg)}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? `${id}-o${active}` : undefined}
          autoComplete="off"
          value={text}
          placeholder={placeholder}
          maxLength={100}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          onFocus={() => (items.length || msg) && setOpen(true)}
          data-testid={testId}
        />
        {busy && <span className="sf-combo-spin"><Spinner size={16} /></span>}
      </div>
      {open && (items.length > 0 || msg) && (
        <ul id={listId} role="listbox" className="sf-combo-list" data-testid={`${testId}-list`}>
          {items.map((it, i) => (
            <li key={it.id} id={`${id}-o${i}`} role="option" aria-selected={i === active} className={`sf-combo-opt ${i === active ? "on" : ""}`} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(it)} data-testid={`${testId}-option`}>
              <Ri name="map-pin-2-line" /> <span><b>{it.line1}</b> <span className="sf-muted">{it.secondary}</span></span>
            </li>
          ))}
          {items.length === 0 && msg && <li className="sf-combo-msg" role="presentation">{msg}</li>}
        </ul>
      )}
      <div className="sf-small sf-muted" aria-live="polite">Choose a suggestion to fill in the address and the map position.</div>
    </div>
  );
}
