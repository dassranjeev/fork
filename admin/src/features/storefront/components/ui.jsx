import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { safeImgUrl } from "../../../lib/safe";

/** Remix icon (offline icon font shipped in public/assets/css/remixicon.css; no network). */
export const Ri = ({ name, className = "", ...rest }) => <i className={`ri-${name} ${className}`} aria-hidden="true" {...rest} />;

export function Spinner({ size = 20 }) {
  return <span className="sf-spinner" style={{ width: size, height: size }} role="status" aria-label="Loading" />;
}

export function Loading({ text = "Loading..." }) {
  return (
    <div className="sf-center sf-muted py-5">
      <Spinner size={26} />
      <div className="mt-2">{text}</div>
    </div>
  );
}

export function ErrorBox({ message, onRetry, children }) {
  return (
    <div className="sf-alert sf-alert-danger" role="alert">
      <Ri name="error-warning-line" />
      <div className="flex-grow-1">
        {message}
        {children}
      </div>
      {onRetry && (
        <button type="button" className="sf-btn sf-btn-sm sf-btn-light" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function Notice({ tone = "info", icon, children, className = "" }) {
  const ic = icon || { info: "information-line", warn: "alert-line", success: "checkbox-circle-line", danger: "error-warning-line" }[tone];
  return (
    <div className={`sf-alert sf-alert-${tone} ${className}`} role={tone === "danger" ? "alert" : "status"}>
      <Ri name={ic} />
      <div className="flex-grow-1">{children}</div>
    </div>
  );
}

/** Restaurant logo / cover / item picture with a safe URL and a lettered placeholder (also when the image fails to load). */
export function Pic({ src, name = "", className = "", rounded = false }) {
  const [bad, setBad] = useState(false);
  const url = safeImgUrl(src);
  useEffect(() => setBad(false), [src]);
  if (!url || bad) {
    return (
      <div className={`sf-pic sf-pic-ph ${rounded ? "sf-round" : ""} ${className}`} aria-hidden="true">
        {String(name).trim().charAt(0).toUpperCase() || "F"}
      </div>
    );
  }
  return <img className={`sf-pic ${rounded ? "sf-round" : ""} ${className}`} src={url} alt="" loading="lazy" onError={() => setBad(true)} referrerPolicy="no-referrer" />;
}

export function Stars({ value, onChange, size = 28, label = "Rating" }) {
  return (
    <div className="sf-stars" role={onChange ? "radiogroup" : "img"} aria-label={`${label}: ${value || 0} of 5`}>
      {[1, 2, 3, 4, 5].map((n) =>
        onChange ? (
          <button key={n} type="button" className={`sf-star ${n <= (value || 0) ? "on" : ""}`} style={{ fontSize: size }} onClick={() => onChange(n)} aria-label={`${n} star${n > 1 ? "s" : ""}`} role="radio" aria-checked={n === value}>
            <Ri name={n <= (value || 0) ? "star-fill" : "star-line"} />
          </button>
        ) : (
          <span key={n} className={`sf-star ${n <= Math.round(value || 0) ? "on" : ""}`} style={{ fontSize: size }}>
            <Ri name={n <= Math.round(value || 0) ? "star-fill" : "star-line"} />
          </span>
        )
      )}
    </div>
  );
}

/** Modal dialog; on phones it slides up as a bottom sheet. `side` makes it a right-hand drawer (cart). */
export function Dialog({ open, onClose, title, children, footer, side = false, labelledBy }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const prev = document.activeElement;
    const onKey = (e) => e.key === "Escape" && onClose?.();
    document.addEventListener("keydown", onKey);
    document.body.classList.add("sf-noscroll");
    const t = setTimeout(() => ref.current?.querySelector("[data-autofocus],input,textarea,select")?.focus?.({ preventScroll: true }), 30);
    return () => {
      clearTimeout(t);
      document.removeEventListener("keydown", onKey);
      document.body.classList.remove("sf-noscroll");
      prev?.focus?.({ preventScroll: true });
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="sf-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div ref={ref} className={`sf-dialog ${side ? "sf-dialog-side" : ""}`} role="dialog" aria-modal="true" aria-label={title} aria-labelledby={labelledBy}>
        <div className="sf-dialog-head">
          <h2 className="sf-dialog-title">{title}</h2>
          <button type="button" className="sf-iconbtn" onClick={onClose} aria-label="Close">
            <Ri name="close-line" />
          </button>
        </div>
        <div className="sf-dialog-body">{children}</div>
        {footer && <div className="sf-dialog-foot">{footer}</div>}
      </div>
    </div>
  );
}

const ConfirmCtx = createContext(null);
/** `const confirm = useSfConfirm(); if (await confirm({ title, message, confirmText })) ...` */
export const useSfConfirm = () => useContext(ConfirmCtx);

export function SfConfirmProvider({ children }) {
  const [state, setState] = useState(null);
  const confirm = useCallback((opts) => new Promise((resolve) => setState({ ...opts, resolve })), []);
  const close = (v) => {
    state?.resolve(v);
    setState(null);
  };
  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      <Dialog
        open={!!state}
        onClose={() => close(false)}
        title={state?.title || "Are you sure?"}
        footer={
          <>
            <button type="button" className="sf-btn sf-btn-light" onClick={() => close(false)}>
              {state?.cancelText || "Cancel"}
            </button>
            <button type="button" className={`sf-btn ${state?.danger ? "sf-btn-danger" : "sf-btn-primary"}`} onClick={() => close(true)} data-autofocus>
              {state?.confirmText || "Yes"}
            </button>
          </>
        }
      >
        <p className="mb-0">{state?.message}</p>
      </Dialog>
    </ConfirmCtx.Provider>
  );
}

/** Simple toast (own, so the storefront does not depend on the admin's toast container styles). */
const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }) {
  const [list, setList] = useState([]);
  const push = useCallback((message, tone = "info") => {
    const id = Math.random().toString(36).slice(2);
    setList((l) => [...l.slice(-3), { id, message, tone }]);
    setTimeout(() => setList((l) => l.filter((t) => t.id !== id)), tone === "danger" ? 6000 : 3200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="sf-toasts" aria-live="polite">
        {list.map((t) => (
          <div key={t.id} className={`sf-toast sf-toast-${t.tone}`} role={t.tone === "danger" ? "alert" : "status"}>
            {t.message}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const priceLevel = (n) => "$".repeat(Math.max(1, Math.min(4, Number(n) || 1)));
