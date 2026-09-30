import React, { useState } from "react";

/**
 * Tabs with lazy content.
 *   <Tabs tabs={[{ key:'a', label:'Overview', badge: 3, content: <A/> }, ...]} />
 * Uncontrolled unless `active` + `onChange` are passed.
 */
export function Tabs({ tabs, active, onChange, className = "" }) {
  const visible = tabs.filter((t) => !t.hidden);
  const [inner, setInner] = useState(visible[0]?.key);
  const cur = active ?? inner;
  const set = (k) => (onChange ? onChange(k) : setInner(k));
  const current = visible.find((t) => t.key === cur) || visible[0];
  return (
    <div className={className}>
      <ul className="nav border-bottom mb-24 gap-1 flex-nowrap overflow-auto">
        {visible.map((t) => (
          <li key={t.key} className="nav-item">
            <button
              type="button"
              onClick={() => set(t.key)}
              className={`nav-link px-16 py-12 text-nowrap fw-semibold border-0 bg-transparent ${current?.key === t.key ? "text-primary-600 border-bottom border-2 border-primary-600" : "text-secondary-light"}`}
              style={{ borderRadius: 0 }}
            >
              {t.label}
              {t.badge !== undefined && t.badge !== null && t.badge !== 0 && <span className="badge bg-primary-100 text-primary-600 ms-2">{t.badge}</span>}
            </button>
          </li>
        ))}
      </ul>
      <div>{current?.content}</div>
    </div>
  );
}

/** Pill-style segmented control. options: [{value,label}] */
export function Segmented({ options, value, onChange, size = "sm" }) {
  return (
    <div className="btn-group" role="group">
      {options.map((o) => {
        const opt = typeof o === "string" ? { value: o, label: o } : o;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={`btn btn-${size} ${value === opt.value ? "btn-primary-600" : "btn-outline-neutral-300 text-primary-light"}`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
