import React from "react";
import { Icon } from "@iconify/react";
import { EmptyState, ErrorState, Loading } from "./basics";

/**
 * Server-side data table.
 * columns: [{ key, title, render?(row), sortable?, sortKey?, width?, className?, align? }]
 * Pair with usePagedList():  <DataTable columns={cols} {...list.tableProps} onRowClick={...} />
 */
export function DataTable({
  columns,
  rows = [],
  meta,
  loading,
  error,
  onRetry,
  sort,
  onSort,
  onPage,
  onLimit,
  rowKey = "id",
  onRowClick,
  emptyTitle = "No records found",
  emptyText,
  dense,
  footer,
  rowClassName,
}) {
  const sortCol = sort?.sortBy;
  return (
    <div>
      {error && <ErrorState error={error} onRetry={onRetry} />}
      <div className="table-responsive scroll-sm">
        <table className={`table bordered-table ${dense ? "sm-table" : ""} mb-0 align-middle`}>
          <thead>
            <tr>
              {columns.map((c) => {
                const sk = c.sortKey || c.key;
                const sortable = c.sortable && onSort;
                return (
                  <th
                    key={c.key}
                    scope="col"
                    style={{ width: c.width, cursor: sortable ? "pointer" : undefined, textAlign: c.align }}
                    className={`${c.className || ""} text-nowrap`}
                    onClick={sortable ? () => onSort(sk) : undefined}
                  >
                    {c.title}
                    {sortable && (
                      <Icon
                        icon={sortCol === sk ? (sort.sortDir === "ASC" ? "solar:alt-arrow-up-bold" : "solar:alt-arrow-down-bold") : "solar:sort-vertical-linear"}
                        className="ms-1 text-secondary-light"
                      />
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {loading && rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length}>
                  <Loading minHeight={120} />
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length}>
                  <EmptyState title={emptyTitle} text={emptyText} />
                </td>
              </tr>
            ) : (
              rows.map((row, i) => (
                <tr
                  key={row[rowKey] ?? i}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  style={{ cursor: onRowClick ? "pointer" : undefined, opacity: loading ? 0.6 : 1 }}
                  className={typeof rowClassName === "function" ? rowClassName(row) : rowClassName}
                >
                  {columns.map((c) => (
                    <td key={c.key} className={c.className} style={{ textAlign: c.align }}>
                      {c.render ? c.render(row, i) : row[c.key] ?? "—"}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {footer}
      {meta && onPage && <Pager meta={meta} onPage={onPage} onLimit={onLimit} />}
    </div>
  );
}

export function Pager({ meta, onPage, onLimit }) {
  const { page = 1, totalPages = 1, total = 0, limit = 20 } = meta;
  const from = total === 0 ? 0 : (page - 1) * limit + 1;
  const to = Math.min(total, page * limit);
  const pages = [];
  const start = Math.max(1, page - 2);
  const end = Math.min(totalPages, start + 4);
  for (let p = Math.max(1, end - 4); p <= end; p++) pages.push(p);
  return (
    <div className="d-flex flex-wrap align-items-center justify-content-between gap-2 mt-24">
      <div className="d-flex align-items-center gap-3">
        <span className="text-secondary-light text-sm">
          Showing {from}–{to} of {total}
        </span>
        {onLimit && (
          <select className="form-select form-select-sm w-auto" value={limit} onChange={(e) => onLimit(Number(e.target.value))}>
            {[10, 20, 50, 100].map((n) => (
              <option key={n} value={n}>
                {n} / page
              </option>
            ))}
          </select>
        )}
      </div>
      <ul className="pagination mb-0 gap-1">
        <li className={`page-item ${page <= 1 ? "disabled" : ""}`}>
          <button className="page-link radius-8" onClick={() => onPage(page - 1)}>
            <Icon icon="ep:d-arrow-left" />
          </button>
        </li>
        {pages.map((p) => (
          <li key={p} className={`page-item ${p === page ? "active" : ""}`}>
            <button className="page-link radius-8" onClick={() => onPage(p)}>
              {p}
            </button>
          </li>
        ))}
        <li className={`page-item ${page >= totalPages ? "disabled" : ""}`}>
          <button className="page-link radius-8" onClick={() => onPage(page + 1)}>
            <Icon icon="ep:d-arrow-right" />
          </button>
        </li>
      </ul>
    </div>
  );
}

/**
 * Search box + filter slots + right actions above a table.
 *   <ListToolbar list={list} placeholder="Search…" filters={<Select .../>} actions={<Button/>} />
 */
export function ListToolbar({ list, placeholder = "Search…", filters, actions, onExport }) {
  return (
    <div className="d-flex flex-wrap align-items-center justify-content-between gap-3 mb-20">
      <div className="d-flex flex-wrap align-items-center gap-3">
        {list && (
          <form className="navbar-search" onSubmit={(e) => e.preventDefault()}>
            <input type="text" className="bg-base h-40-px w-auto" value={list.search} onChange={(e) => list.setSearch(e.target.value)} placeholder={placeholder} />
            <Icon icon="ion:search-outline" className="icon" />
          </form>
        )}
        {filters}
      </div>
      <div className="d-flex align-items-center gap-2 flex-wrap">
        {onExport && (
          <button type="button" className="btn btn-outline-neutral-300 text-primary-light btn-sm radius-8 d-inline-flex align-items-center gap-2" onClick={onExport}>
            <Icon icon="solar:download-minimalistic-outline" /> Export
          </button>
        )}
        {list && (
          <button type="button" className="btn btn-outline-neutral-300 text-primary-light btn-sm radius-8" title="Refresh" onClick={list.reload}>
            <Icon icon="solar:refresh-outline" />
          </button>
        )}
        {actions}
      </div>
    </div>
  );
}

/** Compact <select> filter used inside ListToolbar. options: string[] | {value,label}[] */
export function FilterSelect({ value, onChange, options, placeholder = "All", className = "" }) {
  return (
    <select className={`form-select form-select-sm h-40-px w-auto radius-8 ${className}`} value={value ?? ""} onChange={(e) => onChange(e.target.value)}>
      <option value="">{placeholder}</option>
      {options.map((o) => {
        const opt = typeof o === "string" ? { value: o, label: o.replace(/_/g, " ") } : o;
        return (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        );
      })}
    </select>
  );
}
