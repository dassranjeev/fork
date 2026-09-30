import React, { useState } from "react";
import { http } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useDebounced, useFetch, usePagedList, useForm, useSubmit } from "../../lib/hooks";
import { Button, DataTable, Field, FilterSelect, FormModal, IconButton, ListToolbar, PageHeader, Card, useConfirm } from "../../ui";

/** '' / null / undefined -> undefined, otherwise Number */
export const numOrU = (v) => (v === "" || v === null || v === undefined ? undefined : Number(v));
/** '' / undefined -> null, otherwise Number (used to clear optional values on PATCH) */
export const numOrNull = (v) => (v === "" || v === null || v === undefined ? null : Number(v));
export const strOrNull = (v) => (v === "" || v === undefined || v === null ? null : v);

/**
 * Config-driven list + create/edit modal + delete page used by most simple resources.
 *  props:
 *   title, subtitle, path ('/admin/tax-classes'), module ('pricing'), columns, filterDefs [{name, placeholder, options}],
 *   initial (object | fn) default form values, toForm(row)=>values, toPayload(values, editing)=>body,
 *   renderForm({f, editing, row}) => JSX, rowActions(row, reload) => JSX, loadRow(row)=>Promise<row> (fetch full record before editing),
 *   itemName, hideCreate, canDelete (bool|fn), modalSize, sortBy, searchable, toolbarExtra, headerExtra, afterSave
 */
export function CrudPage({
  title,
  subtitle,
  crumbs,
  path,
  module,
  columns,
  filterDefs = [],
  initial = {},
  toForm,
  toPayload = (v) => v,
  renderForm,
  rowActions,
  loadRow,
  itemName = "record",
  createLabel,
  hideCreate,
  canDelete = true,
  canEditRow = () => true,
  modalSize = "md",
  sortBy,
  sortDir,
  searchable = true,
  searchPlaceholder,
  limit = 20,
  toolbarExtra,
  headerExtra,
  onRowClick,
  deleteMessage,
  children,
}) {
  const { can } = useAuth();
  const confirm = useConfirm();
  const { busy, run } = useSubmit();
  const filters = Object.fromEntries(filterDefs.map((d) => [d.name, d.default ?? ""]));
  const list = usePagedList(path, { filters, sortBy, sortDir, limit });
  const f = useForm(typeof initial === "function" ? initial() : initial);
  const [editing, setEditing] = useState(null); // null | 'new' | row
  const canCreate = !hideCreate && can(module, "create");
  const canEdit = can(module, "edit");

  const openNew = () => {
    f.reset(typeof initial === "function" ? initial() : initial);
    setEditing("new");
  };
  const openEdit = async (row) => {
    let full = row;
    if (loadRow) {
      try {
        full = await loadRow(row);
      } catch {
        /* fall back to list row */
      }
    }
    f.reset(toForm ? toForm(full) : { ...full });
    setEditing(full);
  };
  const save = () => {
    const isNew = editing === "new";
    return run(
      () => (isNew ? http.post(path, toPayload(f.values, false)) : http.patch(`${path}/${editing.id}`, toPayload(f.values, true, editing))),
      {
        success: isNew ? `${itemName} created` : `${itemName} updated`,
        onDone: () => {
          setEditing(null);
          list.reload();
        },
      }
    );
  };
  const remove = async (row) => {
    const r = await confirm({
      title: `Delete ${itemName}?`,
      message: deleteMessage ? deleteMessage(row) : "This cannot be undone.",
      danger: true,
      confirmText: "Delete",
    });
    if (!r.confirmed) return;
    run(() => http.del(`${path}/${row.id}`), { success: `${itemName} deleted`, onDone: list.reload });
  };

  const cols = [
    ...columns,
    {
      key: "_actions",
      title: "",
      align: "right",
      width: 1,
      render: (row) => (
        <div className="d-flex gap-2 justify-content-end" onClick={(e) => e.stopPropagation()}>
          {rowActions?.(row, list.reload)}
          {canEdit && canEditRow(row) && <IconButton icon="solar:pen-outline" title="Edit" tone="primary" onClick={() => openEdit(row)} />}
          {can(module, "delete") && (typeof canDelete === "function" ? canDelete(row) : canDelete) && (
            <IconButton icon="solar:trash-bin-trash-outline" title="Delete" tone="danger" onClick={() => remove(row)} />
          )}
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title={title}
        subtitle={subtitle}
        crumbs={crumbs || [{ label: title }]}
        actions={
          canCreate && (
            <Button icon="solar:add-circle-outline" onClick={openNew}>
              {createLabel || `New ${itemName}`}
            </Button>
          )
        }
      />
      {typeof headerExtra === "function" ? headerExtra({ list }) : headerExtra}
      <Card>
        <ListToolbar
          list={searchable ? list : { reload: list.reload, search: "", setSearch: () => {} }}
          placeholder={searchPlaceholder}
          filters={filterDefs.map((d) => (
            <FilterSelect key={d.name} value={list.filters[d.name]} onChange={(v) => list.setFilter(d.name, v)} options={d.options} placeholder={d.placeholder || "All"} />
          ))}
          actions={toolbarExtra}
        />
        <DataTable columns={cols} {...list.tableProps} error={list.error} onRetry={list.reload} emptyTitle={`No ${itemName}s yet`} onRowClick={onRowClick} />
      </Card>
      {children?.({ list, openEdit, openNew })}
      <FormModal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing === "new" ? createLabel || `New ${itemName}` : `Edit ${itemName}`}
        onSubmit={save}
        busy={busy}
        size={modalSize}
      >
        {editing && renderForm({ f, editing: editing !== "new", row: editing === "new" ? null : editing })}
      </FormModal>
    </>
  );
}

/** City options [{value,label}] for selects. */
export function useCityOptions() {
  const { data } = useFetch("/admin/cities", { limit: 100 });
  const rows = data?.data ?? [];
  return { cities: rows, options: rows.map((c) => ({ value: c.id, label: c.name })) };
}

/** Search-and-pick a restaurant. value = restaurant id; onChange(id, restaurant). */
export function RestaurantPicker({ label = "Restaurant", value, onChange, col, hint, required }) {
  const [q, setQ] = useState("");
  const dq = useDebounced(q);
  const { data, loading } = useFetch("/admin/restaurants", { search: dq || undefined, limit: 10 });
  const rows = data?.data ?? [];
  const options = rows.map((r) => ({ value: r.id, label: r.name }));
  if (value && !options.find((o) => o.value === value)) options.unshift({ value, label: `Selected (${String(value).slice(0, 8)}…)` });
  return (
    <Field label={label} col={col} hint={hint} required={required}>
      <input className="form-control radius-8 mb-8" placeholder="Search restaurants by name…" value={q} onChange={(e) => setQ(e.target.value)} />
      <select className="form-select radius-8" value={value || ""} onChange={(e) => onChange(e.target.value, rows.find((r) => r.id === e.target.value))}>
        <option value="">{loading ? "Loading…" : "Select restaurant…"}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}
