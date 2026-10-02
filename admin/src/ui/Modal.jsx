import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react/offline";
import { Button } from "./basics";

/** Bootstrap-styled modal driven by React state (no bootstrap JS needed). size: sm | md | lg | xl */
export function Modal({ open, onClose, title, children, footer, size = "md", scroll = true, closeOnBackdrop = true }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === "Escape" && onClose?.();
    document.addEventListener("keydown", onKey);
    document.body.classList.add("modal-open");
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.classList.remove("modal-open");
    };
  }, [open, onClose]);
  if (!open) return null;
  const dlg = { sm: "modal-sm", md: "", lg: "modal-lg", xl: "modal-xl" }[size];
  return (
    <>
      <div className="modal-backdrop fade show" style={{ zIndex: 1050 }} />
      <div className="modal fade show d-block" style={{ zIndex: 1055, overflowY: "auto" }} tabIndex={-1} onMouseDown={(e) => closeOnBackdrop && e.target === e.currentTarget && onClose?.()}>
        <div className={`modal-dialog modal-dialog-centered ${scroll ? "modal-dialog-scrollable" : ""} ${dlg}`}>
          <div className="modal-content radius-12">
            <div className="modal-header py-16 px-24 border-bottom">
              <h6 className="modal-title fw-semibold mb-0">{title}</h6>
              <button type="button" className="btn p-0 border-0 text-secondary-light" onClick={onClose} aria-label="Close">
                <Icon icon="radix-icons:cross-2" className="text-xl" />
              </button>
            </div>
            <div className="modal-body p-24">{children}</div>
            {footer && <div className="modal-footer px-24 py-16 border-top gap-2">{footer}</div>}
          </div>
        </div>
      </div>
    </>
  );
}

/** Modal with Cancel / Save footer wired to a submit handler. */
export function FormModal({ open, onClose, title, onSubmit, busy, submitText = "Save", children, size = "md", submitVariant = "primary", disabled }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size={size}
      footer={
        <>
          <Button variant="light" onClick={onClose}>
            Cancel
          </Button>
          <Button variant={submitVariant} loading={busy} disabled={disabled} onClick={onSubmit}>
            {submitText}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit?.();
        }}
      >
        {children}
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- confirm / prompt
const ConfirmCtx = createContext(null);

/**
 * Promise-based confirm & prompt dialog. Mount <ConfirmProvider> once (App does).
 *   const confirm = useConfirm();
 *   const r = await confirm({ title: 'Reject application?', danger: true, prompt: { label: 'Reason', required: true } });
 *   if (r.confirmed) api.post(..., { reason: r.value });
 * prompt.type: 'text' | 'textarea' | 'select' (with prompt.options) | 'number'
 */
export function ConfirmProvider({ children }) {
  const [state, setState] = useState(null);
  const [value, setValue] = useState("");
  const resolver = useRef();

  const confirm = useCallback((opts = {}) => {
    setValue(opts.prompt?.defaultValue ?? "");
    setState(opts);
    return new Promise((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const close = (confirmed) => {
    const v = value;
    setState(null);
    resolver.current?.({ confirmed, value: v });
  };

  const p = state?.prompt;
  const invalid = p?.required && !String(value).trim();

  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      <Modal
        open={!!state}
        onClose={() => close(false)}
        title={state?.title || "Are you sure?"}
        size="sm"
        footer={
          <>
            <Button variant="light" onClick={() => close(false)}>
              {state?.cancelText || "Cancel"}
            </Button>
            <Button variant={state?.danger ? "danger" : "primary"} disabled={invalid} onClick={() => close(true)}>
              {state?.confirmText || "Confirm"}
            </Button>
          </>
        }
      >
        {state?.message && <p className="mb-16 text-secondary-light">{state.message}</p>}
        {p && (
          <div>
            {p.label && <label className="form-label fw-semibold text-sm">{p.label}</label>}
            {p.type === "select" ? (
              <select className="form-select radius-8" value={value} onChange={(e) => setValue(e.target.value)}>
                <option value="">Select…</option>
                {(p.options || []).map((o) => {
                  const opt = typeof o === "string" ? { value: o, label: o.replace(/_/g, " ") } : o;
                  return (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  );
                })}
              </select>
            ) : p.type === "textarea" ? (
              <textarea className="form-control radius-8" rows={3} value={value} onChange={(e) => setValue(e.target.value)} placeholder={p.placeholder} autoFocus />
            ) : (
              <input type={p.type || "text"} className="form-control radius-8" value={value} onChange={(e) => setValue(e.target.value)} placeholder={p.placeholder} autoFocus />
            )}
          </div>
        )}
      </Modal>
    </ConfirmCtx.Provider>
  );
}

export const useConfirm = () => useContext(ConfirmCtx);
