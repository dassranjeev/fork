import React from "react";
import { safeImgUrl } from "../lib/safe";
import { Icon } from "@iconify/react/offline";
import { Link } from "react-router-dom";
import { initials, statusColor, titleCase } from "../lib/format";

/** Page title row with breadcrumb + right-aligned actions. */
export function PageHeader({ title, subtitle, crumbs = [], actions, back }) {
  return (
    <div className="mb-24">
      <div className="d-flex flex-wrap align-items-center justify-content-between gap-3">
        <div className="d-flex align-items-center gap-12">
          {back && (
            <Link to={back} className="w-36-px h-36-px bg-neutral-200 rounded-circle d-flex justify-content-center align-items-center text-secondary-light">
              <Icon icon="solar:arrow-left-outline" className="text-xl" />
            </Link>
          )}
          <div>
            <h6 className="fw-semibold mb-0">{title}</h6>
            {subtitle && <p className="text-secondary-light text-sm mb-0 mt-4">{subtitle}</p>}
          </div>
        </div>
        <div className="d-flex align-items-center flex-wrap gap-3">
          {crumbs.length > 0 && (
            <ul className="d-flex align-items-center gap-2 mb-0 me-3 d-none d-lg-flex">
              <li className="fw-medium">
                <Link to="/" className="d-flex align-items-center gap-1 hover-text-primary">
                  <Icon icon="solar:home-smile-angle-outline" className="icon text-lg" />
                </Link>
              </li>
              {crumbs.map((c, i) => (
                <React.Fragment key={i}>
                  <li> / </li>
                  <li className="fw-medium">{c.to ? <Link to={c.to} className="hover-text-primary">{c.label}</Link> : c.label}</li>
                </React.Fragment>
              ))}
            </ul>
          )}
          {actions}
        </div>
      </div>
    </div>
  );
}

export function Card({ title, subtitle, actions, children, className = "", bodyClassName = "", noPadding, footer }) {
  return (
    <div className={`card radius-12 border-0 shadow-sm ${className}`}>
      {(title || actions) && (
        <div className="card-header py-16 px-24 border-bottom d-flex flex-wrap align-items-center justify-content-between gap-2">
          <div>
            {title && <h6 className="text-lg fw-semibold mb-0">{title}</h6>}
            {subtitle && <p className="text-secondary-light text-sm mb-0">{subtitle}</p>}
          </div>
          {actions && <div className="d-flex align-items-center gap-2 flex-wrap">{actions}</div>}
        </div>
      )}
      <div className={`${noPadding ? "" : "card-body p-24"} ${bodyClassName}`}>{children}</div>
      {footer && <div className="card-footer px-24 py-16">{footer}</div>}
    </div>
  );
}

const TONE_ICON_BG = {
  primary: "bg-primary-100 text-primary-600",
  success: "bg-success-100 text-success-600",
  warning: "bg-warning-100 text-warning-600",
  danger: "bg-danger-100 text-danger-600",
  info: "bg-info-100 text-info-600",
  purple: "bg-lilac-100 text-lilac-600",
  neutral: "bg-neutral-200 text-secondary-light",
};

/** KPI tile. `delta` is a % change (positive = good unless `invertDelta`). */
export function StatCard({ label, value, icon = "solar:chart-2-outline", tone = "primary", delta, invertDelta, hint, to, loading }) {
  const good = delta === undefined || delta === null ? null : invertDelta ? delta <= 0 : delta >= 0;
  const body = (
    <div className="card radius-12 border-0 shadow-sm h-100">
      <div className="card-body p-20">
        <div className="d-flex justify-content-between align-items-start gap-3">
          <div>
            <p className="fw-medium text-primary-light mb-1 text-sm">{label}</p>
            <h5 className="mb-0">{loading ? "…" : value}</h5>
          </div>
          <div className={`w-48-px h-48-px rounded-circle d-flex justify-content-center align-items-center ${TONE_ICON_BG[tone] || TONE_ICON_BG.primary}`}>
            <Icon icon={icon} className="text-2xl mb-0" />
          </div>
        </div>
        {(delta !== undefined && delta !== null) || hint ? (
          <p className="fw-medium text-sm text-primary-light mt-12 mb-0 d-flex align-items-center gap-2">
            {delta !== undefined && delta !== null && (
              <span className={`d-inline-flex align-items-center gap-1 ${good ? "text-success-main" : "text-danger-main"}`}>
                <Icon icon={delta >= 0 ? "bxs:up-arrow" : "bxs:down-arrow"} className="text-xs" />
                {Math.abs(delta).toFixed(1)}%
              </span>
            )}
            {hint && <span className="text-secondary-light">{hint}</span>}
          </p>
        ) : null}
      </div>
    </div>
  );
  return to ? (
    <Link to={to} className="d-block h-100">
      {body}
    </Link>
  ) : (
    body
  );
}

const BADGE_CLASS = {
  success: "bg-success-focus text-success-main border-success-main",
  warning: "bg-warning-focus text-warning-main border-warning-main",
  danger: "bg-danger-focus text-danger-main border-danger-main",
  info: "bg-info-focus text-info-main border-info-main",
  primary: "bg-primary-50 text-primary-600 border-primary-600",
  purple: "bg-lilac-100 text-lilac-600 border-lilac-600",
  neutral: "bg-neutral-200 text-neutral-600 border-neutral-400",
};

export function Badge({ tone = "neutral", children, className = "" }) {
  return <span className={`px-12 py-4 radius-4 fw-medium text-sm border ${BADGE_CLASS[tone] || BADGE_CLASS.neutral} ${className}`}>{children}</span>;
}

/** Colour-coded status pill; colours come from lib/format STATUS_COLORS. */
export function StatusBadge({ status, label, tone }) {
  if (status === undefined || status === null || status === "") return <span className="text-secondary-light">—</span>;
  return <Badge tone={tone || statusColor(status)}>{label || titleCase(status)}</Badge>;
}

export function BoolBadge({ value, yes = "Yes", no = "No", invert }) {
  const good = invert ? !value : value;
  return <Badge tone={good ? "success" : "neutral"}>{value ? yes : no}</Badge>;
}

export function Avatar({ name, src, size = 40, tone = "primary" }) {
  const style = { width: size, height: size, fontSize: size * 0.4 };
  if (safeImgUrl(src)) return <img src={safeImgUrl(src)} alt={name} className="rounded-circle object-fit-cover flex-shrink-0" style={style} />;
  return (
    <span className={`rounded-circle d-inline-flex align-items-center justify-content-center fw-semibold flex-shrink-0 ${TONE_ICON_BG[tone]}`} style={style}>
      {initials(name) || "?"}
    </span>
  );
}

export function Spinner({ size = 20 }) {
  return <span className="spinner-border text-primary-600" style={{ width: size, height: size }} role="status" />;
}

export function Loading({ text = "Loading…", minHeight = 200 }) {
  return (
    <div className="d-flex flex-column align-items-center justify-content-center gap-2 text-secondary-light" style={{ minHeight }}>
      <Spinner size={28} />
      <span className="text-sm">{text}</span>
    </div>
  );
}

export function EmptyState({ icon = "solar:inbox-outline", title = "Nothing here yet", text, action }) {
  return (
    <div className="d-flex flex-column align-items-center justify-content-center text-center py-40 px-16 text-secondary-light">
      <Icon icon={icon} className="text-6xl mb-12" style={{ opacity: 0.5 }} />
      <h6 className="mb-4 text-primary-light">{title}</h6>
      {text && <p className="text-sm mb-12" style={{ maxWidth: 420 }}>{text}</p>}
      {action}
    </div>
  );
}

export function ErrorState({ error, onRetry }) {
  return (
    <div className="alert alert-danger d-flex align-items-center justify-content-between gap-3 radius-8" role="alert">
      <span>{error || "Failed to load"}</span>
      {onRetry && (
        <button className="btn btn-sm btn-outline-danger" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

/** Uniform button. variant: primary | outline | danger | success | light | link */
export function Button({ variant = "primary", size = "sm", icon, loading, children, className = "", ...rest }) {
  const cls = {
    primary: "btn btn-primary-600",
    outline: "btn btn-outline-primary-600",
    danger: "btn btn-danger-600",
    "outline-danger": "btn btn-outline-danger-600",
    success: "btn btn-success-600",
    warning: "btn btn-warning-600",
    light: "btn btn-outline-neutral-300 text-primary-light",
    link: "btn btn-link text-primary-600 p-0",
  }[variant];
  return (
    <button type="button" {...rest} disabled={rest.disabled || loading} className={`${cls} ${size === "sm" ? "btn-sm px-16 py-8" : "px-20 py-11"} radius-8 d-inline-flex align-items-center gap-2 ${className}`}>
      {loading ? <span className="spinner-border spinner-border-sm" /> : icon ? <Icon icon={icon} className="text-lg" /> : null}
      {children}
    </button>
  );
}

export function IconButton({ icon, title, onClick, tone = "neutral", to, disabled }) {
  const cls = {
    neutral: "bg-neutral-200 text-neutral-600",
    primary: "bg-primary-100 text-primary-600",
    success: "bg-success-100 text-success-600",
    danger: "bg-danger-100 text-danger-600",
    warning: "bg-warning-100 text-warning-600",
  }[tone];
  const inner = <Icon icon={icon} className="text-lg" />;
  const base = `w-32-px h-32-px ${cls} rounded-circle d-inline-flex justify-content-center align-items-center border-0`;
  if (to)
    return (
      <Link to={to} title={title} className={base}>
        {inner}
      </Link>
    );
  return (
    <button type="button" title={title} onClick={onClick} disabled={disabled} className={base}>
      {inner}
    </button>
  );
}

/** Label / value list for detail pages. items: [{ label, value }] */
export function KeyValue({ items, cols = 2 }) {
  return (
    <div className="row gy-3">
      {items
        .filter(Boolean)
        .map((it, i) => (
          <div key={i} className={`col-md-${12 / cols}`}>
            <div className="text-secondary-light text-sm mb-1">{it.label}</div>
            <div className="fw-medium text-primary-light">{it.value === undefined || it.value === null || it.value === "" ? "—" : it.value}</div>
          </div>
        ))}
    </div>
  );
}

/** Vertical event timeline. items: [{ title, text, at, tone }] */
export function Timeline({ items = [] }) {
  if (!items.length) return <EmptyState title="No events" />;
  return (
    <ul className="list-unstyled mb-0 position-relative ps-4" style={{ borderLeft: "2px solid var(--neutral-200)" }}>
      {items.map((it, i) => (
        <li key={i} className="mb-16 position-relative">
          <span
            className={`position-absolute rounded-circle bg-${it.tone === "danger" ? "danger-main" : it.tone === "success" ? "success-main" : it.tone === "warning" ? "warning-main" : "primary-600"}`}
            style={{ left: -31, top: 4, width: 12, height: 12 }}
          />
          <div className="d-flex justify-content-between gap-3 flex-wrap">
            <span className="fw-semibold text-sm">{it.title}</span>
            {it.at && <span className="text-secondary-light text-xs">{it.at}</span>}
          </div>
          {it.text && <div className="text-secondary-light text-sm">{it.text}</div>}
        </li>
      ))}
    </ul>
  );
}

/** Horizontal progress bar with label. */
export function Progress({ value = 0, max = 100, tone = "primary", height = 8, label }) {
  const p = Math.min(100, Math.max(0, (value / (max || 1)) * 100));
  return (
    <div>
      {label && (
        <div className="d-flex justify-content-between text-sm mb-1">
          <span>{label}</span>
          <span className="text-secondary-light">{p.toFixed(0)}%</span>
        </div>
      )}
      <div className="progress" style={{ height }}>
        <div className={`progress-bar bg-${tone === "primary" ? "primary-600" : tone + "-main"}`} style={{ width: `${p}%` }} />
      </div>
    </div>
  );
}
