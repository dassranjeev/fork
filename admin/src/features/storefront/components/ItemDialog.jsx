import React, { useMemo, useState } from "react";
import { money } from "../lib/sfApi";
import { Dialog, Pic, Ri, Spinner } from "./ui";
import { QtyStepper } from "./CartPanel";

/** Minimum / maximum picks for a modifier group. */
export const groupLimits = (g) => ({ min: g.required ? Math.max(1, g.minSelect || 0) : g.minSelect || 0, max: g.maxSelect > 0 ? g.maxSelect : Infinity });

export const hasRequiredChoices = (item) => (item.modifierGroups || []).some((g) => groupLimits(g).min > 0);

export const itemDisabled = (item, restaurantClosed) => restaurantClosed || item.available === false;

function initialSelection(item) {
  const sel = {};
  for (const g of item.modifierGroups || []) {
    const { max } = groupLimits(g);
    const defaults = g.options.filter((o) => o.isDefault && o.available !== false).slice(0, Number.isFinite(max) ? max : 99);
    sel[g.id] = defaults.map((o) => o.id);
  }
  return sel;
}

export default function ItemDialog({ item, open, onClose, onAdd, disabledReason }) {
  const [sel, setSel] = useState(() => (item ? initialSelection(item) : {}));
  const [notes, setNotes] = useState("");
  const [qty, setQty] = useState(1);
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);

  const errors = useMemo(() => {
    const out = {};
    for (const g of item?.modifierGroups || []) {
      const { min, max } = groupLimits(g);
      const n = (sel[g.id] || []).length;
      if (n < min) out[g.id] = `Choose ${min === 1 ? "1 option" : `at least ${min}`}`;
      else if (n > max) out[g.id] = `Choose at most ${max}`;
    }
    return out;
  }, [item, sel]);

  if (!item) return null;

  const chosen = [];
  let delta = 0;
  for (const g of item.modifierGroups || []) {
    for (const o of g.options) {
      if ((sel[g.id] || []).includes(o.id)) {
        chosen.push({ optionId: o.id, name: o.name, priceDelta: o.priceDelta || 0, groupName: g.name });
        delta += o.priceDelta || 0;
      }
    }
  }
  const unit = Number(item.price) + delta;
  const blocked = !!disabledReason || item.available === false;

  const toggle = (g, o) => {
    const { max } = groupLimits(g);
    setSel((cur) => {
      const now = cur[g.id] || [];
      if (now.includes(o.id)) return { ...cur, [g.id]: now.filter((x) => x !== o.id) };
      if (max === 1) return { ...cur, [g.id]: [o.id] };
      if (now.length >= max) return cur;
      return { ...cur, [g.id]: [...now, o.id] };
    });
  };

  const submit = async () => {
    setTouched(true);
    if (Object.keys(errors).length || blocked) return;
    setBusy(true);
    const ok = await onAdd({ item, quantity: qty, options: chosen, notes });
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={item.name}
      footer={
        <div className="sf-itemfoot">
          <QtyStepper value={qty} min={1} onChange={(q) => setQty(Math.max(1, q))} label={item.name} />
          <button type="button" className="sf-btn sf-btn-primary flex-grow-1" onClick={submit} disabled={busy || blocked} data-testid="item-add">
            {busy ? <Spinner size={16} /> : null} {blocked ? disabledReason || "Not available" : `Add to cart - ${money(unit * qty)}`}
          </button>
        </div>
      }
    >
      {item.imageUrl && <Pic src={item.imageUrl} name={item.name} className="sf-item-hero" />}
      {item.description && <p>{item.description}</p>}
      <div className="sf-tags">
        {(item.dietaryTags || []).map((t) => (
          <span key={t} className="sf-tag sf-tag-ok">{t}</span>
        ))}
        {(item.allergens || []).length > 0 && <span className="sf-tag sf-tag-warn">Contains: {item.allergens.join(", ")}</span>}
        {item.calories ? <span className="sf-tag">{item.calories} cal</span> : null}
      </div>
      {(item.modifierGroups || []).map((g) => {
        const { min, max } = groupLimits(g);
        const err = touched && errors[g.id];
        const single = max === 1;
        return (
          <fieldset key={g.id} className={`sf-group ${err ? "has-error" : ""}`} data-testid="modifier-group">
            <legend>
              {g.name}
              <span className={`sf-tag ${min > 0 ? "sf-tag-danger" : ""} ms-2`}>{min > 0 ? "Required" : "Optional"}</span>
            </legend>
            <div className="sf-small sf-muted mb-1">{single ? "Choose 1" : Number.isFinite(max) ? `Choose ${min > 0 ? `${min} to ` : "up to "}${max}` : min > 0 ? `Choose at least ${min}` : "Choose any"}</div>
            {g.options.map((o) => {
              const on = (sel[g.id] || []).includes(o.id);
              const off = o.available === false || (!on && !single && (sel[g.id] || []).length >= max);
              return (
                <label key={o.id} className={`sf-option ${on ? "on" : ""} ${off ? "off" : ""}`}>
                  <input type={single ? "radio" : "checkbox"} name={g.id} checked={on} disabled={off} onChange={() => toggle(g, o)} />
                  <span className="flex-grow-1">
                    {o.name}
                    {o.available === false && <span className="sf-tag sf-tag-danger ms-2">Unavailable</span>}
                  </span>
                  {o.priceDelta ? <span className="sf-muted">{o.priceDelta > 0 ? "+" : ""}{money(o.priceDelta)}</span> : null}
                </label>
              );
            })}
            {err && (
              <div className="sf-error" role="alert">
                <Ri name="error-warning-line" /> {errors[g.id]}
              </div>
            )}
          </fieldset>
        );
      })}
      <label className="sf-label mt-3" htmlFor="item-notes">
        Special instructions <span className="sf-muted">(optional)</span>
      </label>
      <textarea id="item-notes" className="sf-input" rows={2} maxLength={300} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Allergies, no onions..." />
      <div className="sf-small sf-muted text-end">{notes.length}/300</div>
    </Dialog>
  );
}
