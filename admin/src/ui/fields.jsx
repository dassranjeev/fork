import React, { useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { toast } from "react-toastify";
import { errorMessage, http } from "../lib/api";

/** Label + control + error wrapper. */
export function Field({ label, hint, error, required, children, className = "mb-16", col }) {
  const wrap = col ? `col-md-${col}` : "";
  return (
    <div className={`${wrap} ${className}`}>
      {label && (
        <label className="form-label fw-semibold text-primary-light text-sm mb-8">
          {label} {required && <span className="text-danger-600">*</span>}
        </label>
      )}
      {children}
      {hint && !error && <div className="text-secondary-light text-xs mt-4">{hint}</div>}
      {error && <div className="text-danger-600 text-xs mt-4">{error}</div>}
    </div>
  );
}

const ctl = "form-control radius-8";

export function TextInput({ label, hint, error, required, col, className, value, onChange, type = "text", ...rest }) {
  return (
    <Field label={label} hint={hint} error={error} required={required} col={col} className={className}>
      <input type={type} className={`${ctl} ${error ? "is-invalid" : ""}`} value={value ?? ""} onChange={(e) => onChange?.(e.target.value)} {...rest} />
    </Field>
  );
}

/** Number input returning a number (or '' when empty). */
export function NumberInput({ label, hint, error, required, col, className, value, onChange, min, max, step = "any", prefix, suffix, ...rest }) {
  const input = (
    <input
      type="number"
      className={`${ctl} ${error ? "is-invalid" : ""}`}
      value={value ?? ""}
      min={min}
      max={max}
      step={step}
      onChange={(e) => onChange?.(e.target.value === "" ? "" : Number(e.target.value))}
      {...rest}
    />
  );
  return (
    <Field label={label} hint={hint} error={error} required={required} col={col} className={className}>
      {prefix || suffix ? (
        <div className="input-group">
          {prefix && <span className="input-group-text">{prefix}</span>}
          {input}
          {suffix && <span className="input-group-text">{suffix}</span>}
        </div>
      ) : (
        input
      )}
    </Field>
  );
}

export const MoneyInput = (props) => <NumberInput prefix="$" step="0.01" min={0} {...props} />;
export const PercentInput = (props) => <NumberInput suffix="%" step="0.1" min={0} {...props} />;

export function TextArea({ label, hint, error, required, col, className, value, onChange, rows = 3, ...rest }) {
  return (
    <Field label={label} hint={hint} error={error} required={required} col={col} className={className}>
      <textarea className={`${ctl} ${error ? "is-invalid" : ""}`} rows={rows} value={value ?? ""} onChange={(e) => onChange?.(e.target.value)} {...rest} />
    </Field>
  );
}

/** options: string[] | { value, label }[] */
export function Select({ label, hint, error, required, col, className, value, onChange, options = [], placeholder, allowEmpty = true, ...rest }) {
  return (
    <Field label={label} hint={hint} error={error} required={required} col={col} className={className}>
      <select className={`form-select ${ctl} ${error ? "is-invalid" : ""}`} value={value ?? ""} onChange={(e) => onChange?.(e.target.value)} {...rest}>
        {allowEmpty && <option value="">{placeholder || "Select…"}</option>}
        {options.map((o) => {
          const opt = typeof o === "string" ? { value: o, label: o.replace(/_/g, " ") } : o;
          return (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          );
        })}
      </select>
    </Field>
  );
}

export function Switch({ label, hint, checked, onChange, className = "mb-16", col, disabled }) {
  return (
    <div className={`${col ? `col-md-${col}` : ""} ${className}`}>
      <div className="form-check form-switch switch-primary d-flex align-items-center gap-3">
        <input className="form-check-input" type="checkbox" role="switch" checked={!!checked} disabled={disabled} onChange={(e) => onChange?.(e.target.checked)} />
        <label className="form-check-label fw-medium text-primary-light">{label}</label>
      </div>
      {hint && <div className="text-secondary-light text-xs mt-4 ms-5 ps-3">{hint}</div>}
    </div>
  );
}

export function Checkbox({ label, checked, onChange, className = "" }) {
  return (
    <div className={`form-check ${className}`}>
      <input className="form-check-input" type="checkbox" checked={!!checked} onChange={(e) => onChange?.(e.target.checked)} />
      <label className="form-check-label">{label}</label>
    </div>
  );
}

/** Pick several options with checkboxes. value: string[] */
export function MultiCheck({ label, options = [], value = [], onChange, cols = 3, className = "mb-16", hint }) {
  const toggle = (v) => onChange?.(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  return (
    <Field label={label} className={className} hint={hint}>
      <div className="row gy-2">
        {options.map((o) => {
          const opt = typeof o === "string" ? { value: o, label: o.replace(/_/g, " ") } : o;
          return (
            <div key={opt.value} className={`col-md-${12 / cols}`}>
              <Checkbox label={opt.label} checked={value.includes(opt.value)} onChange={() => toggle(opt.value)} />
            </div>
          );
        })}
      </div>
    </Field>
  );
}

/** Free-text tags: type and press Enter / comma. value: string[] */
export function TagsInput({ label, hint, value = [], onChange, placeholder = "Type and press Enter", suggestions = [], className, col }) {
  const [draft, setDraft] = useState("");
  const add = (t) => {
    const v = t.trim();
    if (v && !value.includes(v)) onChange?.([...value, v]);
    setDraft("");
  };
  return (
    <Field label={label} hint={hint} className={className} col={col}>
      <div className="d-flex flex-wrap gap-2 p-2 border radius-8 bg-base">
        {value.map((t) => (
          <span key={t} className="badge bg-primary-50 text-primary-600 d-inline-flex align-items-center gap-1 px-12 py-6">
            {t}
            <button type="button" className="btn p-0 border-0 text-primary-600" onClick={() => onChange?.(value.filter((x) => x !== t))}>
              <Icon icon="radix-icons:cross-2" />
            </button>
          </span>
        ))}
        <input
          className="border-0 flex-grow-1 bg-transparent"
          style={{ minWidth: 120, outline: "none" }}
          value={draft}
          placeholder={placeholder}
          list={suggestions.length ? `tags-${label}` : undefined}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add(draft);
            } else if (e.key === "Backspace" && !draft && value.length) onChange?.(value.slice(0, -1));
          }}
          onBlur={() => draft && add(draft)}
        />
        {suggestions.length > 0 && (
          <datalist id={`tags-${label}`}>
            {suggestions.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        )}
      </div>
    </Field>
  );
}

export function DateInput({ label, hint, error, required, col, className, value, onChange, withTime, ...rest }) {
  // value: ISO string; the input works with local yyyy-mm-dd[Thh:mm]
  const toLocal = (v) => {
    if (!v) return "";
    if (!withTime) return String(v).slice(0, 10);
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return "";
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  return (
    <Field label={label} hint={hint} error={error} required={required} col={col} className={className}>
      <input
        type={withTime ? "datetime-local" : "date"}
        className={`${ctl} ${error ? "is-invalid" : ""}`}
        value={toLocal(value)}
        onChange={(e) => onChange?.(e.target.value ? (withTime ? new Date(e.target.value).toISOString() : e.target.value) : null)}
        {...rest}
      />
    </Field>
  );
}

/** Upload a file/image to /uploads and store the returned URL. */
export function FileInput({ label, hint, value, onChange, accept = "image/*", col, className, preview = true }) {
  const ref = useRef();
  const [busy, setBusy] = useState(false);
  const pick = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setBusy(true);
    try {
      const res = await http.upload(f);
      onChange?.(res.url, res);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
      if (ref.current) ref.current.value = "";
    }
  };
  const isImg = value && /\.(png|jpe?g|webp|gif|svg)(\?|$)/i.test(value);
  return (
    <Field label={label} hint={hint} col={col} className={className}>
      <div className="d-flex align-items-center gap-3 flex-wrap">
        {preview && isImg && <img src={value} alt="" className="radius-8 object-fit-cover" style={{ width: 64, height: 64 }} />}
        {value && !isImg && (
          <a href={value} target="_blank" rel="noreferrer" className="text-primary-600 text-sm">
            View file
          </a>
        )}
        <label className="btn btn-outline-primary-600 btn-sm radius-8 mb-0 d-inline-flex align-items-center gap-2">
          <Icon icon="solar:upload-outline" /> {busy ? "Uploading…" : value ? "Replace" : "Upload"}
          <input ref={ref} type="file" accept={accept} hidden onChange={pick} />
        </label>
        {value && (
          <button type="button" className="btn btn-sm text-danger-600 p-0" onClick={() => onChange?.(null)}>
            Remove
          </button>
        )}
      </div>
    </Field>
  );
}

/** Edit any JSON value in a textarea with validation. */
export function JsonInput({ label, hint, value, onChange, rows = 8, className, col }) {
  const [text, setText] = useState(() => JSON.stringify(value ?? {}, null, 2));
  const [err, setErr] = useState(null);
  return (
    <Field label={label} hint={hint} error={err} className={className} col={col}>
      <textarea
        className={`${ctl} font-monospace text-sm ${err ? "is-invalid" : ""}`}
        rows={rows}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          try {
            onChange?.(JSON.parse(e.target.value));
            setErr(null);
          } catch {
            setErr("Invalid JSON");
          }
        }}
      />
    </Field>
  );
}

/** Grid row helper for forms: <FormRow><TextInput col={6}/>...</FormRow> */
export const FormRow = ({ children, className = "" }) => <div className={`row ${className}`}>{children}</div>;
