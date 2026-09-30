import React, { useState } from "react";
import { Icon } from "@iconify/react";
import { toast } from "react-toastify";
import { errorMessage, http } from "../../lib/api";
import { useFetch } from "../../lib/hooks";
import { useAuth } from "../../lib/auth";
import { Button, ErrorState, FilterSelect, Loading } from "../../ui";
import { compact, money, num, pct } from "../../lib/format";

/** Active cities for filter dropdowns. */
export function useCities() {
  const { data } = useFetch("/admin/cities", { limit: 100 });
  return (data?.data || (Array.isArray(data) ? data : [])).map((c) => ({ value: c.id, label: c.name }));
}

export function CityFilter({ value, onChange }) {
  const cities = useCities();
  return <FilterSelect value={value} onChange={onChange} options={cities} placeholder="All cities" />;
}

const iso = (d) => d.toISOString().slice(0, 10);
export function presetRange(days) {
  const to = new Date();
  const from = new Date(Date.now() - (days - 1) * 86400000);
  return { from: iso(from), to: iso(to) };
}

/** Filter bar shared by analytics pages. state = {from,to,groupBy,cityId}; setState(patch) */
export function RangeBar({ state, onChange, groupBy = true, city = true, children, exportKey }) {
  const { can } = useAuth();
  const [busy, setBusy] = useState(false);
  const doExport = async () => {
    setBusy(true);
    try {
      const r = await http.get(`/admin/reports/${exportKey}/export`, { ...state, format: "csv" });
      const blob = new Blob([r.csv], { type: "text/csv;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = r.filename || `${exportKey}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const inputCls = "form-control form-control-sm h-40-px radius-8 w-auto";
  return (
    <div className="d-flex flex-wrap align-items-center justify-content-between gap-3 mb-20">
      <div className="d-flex flex-wrap align-items-center gap-2">
        <input type="date" className={inputCls} value={state.from || ""} max={state.to || undefined} onChange={(e) => onChange({ from: e.target.value })} />
        <span className="text-secondary-light">to</span>
        <input type="date" className={inputCls} value={state.to || ""} min={state.from || undefined} onChange={(e) => onChange({ to: e.target.value })} />
        {[7, 30, 90].map((d) => (
          <button key={d} type="button" className="btn btn-sm btn-outline-neutral-300 text-primary-light radius-8" onClick={() => onChange(presetRange(d))}>
            {d}d
          </button>
        ))}
        {groupBy && (
          <FilterSelect
            value={state.groupBy}
            onChange={(v) => onChange({ groupBy: v || "day" })}
            options={[{ value: "day", label: "By day" }, { value: "week", label: "By week" }, { value: "month", label: "By month" }]}
            placeholder="By day"
          />
        )}
        {city && <CityFilter value={state.cityId} onChange={(v) => onChange({ cityId: v })} />}
        {children}
      </div>
      {exportKey && can("reports", "export") && (
        <Button variant="light" icon="solar:download-minimalistic-outline" loading={busy} onClick={doExport}>
          Export CSV
        </Button>
      )}
    </div>
  );
}

export const useRangeState = (days = 30, extra = {}) => {
  const [s, setS] = useState({ ...presetRange(days), groupBy: "day", cityId: "", ...extra });
  return [s, (patch) => setS((p) => ({ ...p, ...patch }))];
};

/** Turns a `{value, previous, changePct}` KPI into StatCard props. */
export const kpiProps = (k, fmt = num) => ({ value: fmt(k?.value), delta: k?.changePct ?? undefined, hint: k?.changePct != null ? "vs prev." : undefined });
export const fmts = { money, num, pct, compact };

export const bucketLabel = (b) => String(b || "").slice(5, 10);

export function SectionNote({ children }) {
  return (
    <p className="text-secondary-light text-sm d-flex gap-2 align-items-start mb-0">
      <Icon icon="solar:info-circle-outline" className="text-lg flex-shrink-0" />
      <span>{children}</span>
    </p>
  );
}

/** Resolve loading / error / empty into a single render. */
export function Async({ state, children }) {
  if (state.loading && !state.data) return <Loading />;
  if (state.error && !state.data) return <ErrorState error={state.error} onRetry={state.reload} />;
  if (!state.data) return null;
  return children(state.data);
}
