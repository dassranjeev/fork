import React, { useState } from "react";
import { Badge, Button, Card, DataTable, ErrorState, FormModal, IconButton, Loading, MoneyInput, PageHeader, TextArea, TextInput, MultiCheck, useConfirm } from "../../ui";
import { useFetch, useForm, useSubmit } from "../../lib/hooks";
import { useAuth } from "../../lib/auth";
import { http } from "../../lib/api";
import { money, titleCase } from "../../lib/format";

const EMPTY = { name: "", description: "", permissions: {}, refundLimit: 0, cityIds: [], zoneIds: [] };

/** module x action checkbox grid */
function PermissionMatrix({ modules, actions, value, onChange, disabled }) {
  const has = (m, a) => (value[m] || []).includes(a);
  const toggle = (m, a) => {
    const cur = value[m] || [];
    const next = cur.includes(a) ? cur.filter((x) => x !== a) : [...cur, a];
    onChange({ ...value, [m]: next });
  };
  const toggleRow = (m) => onChange({ ...value, [m]: (value[m] || []).length === actions.length ? [] : [...actions] });
  const toggleCol = (a) => {
    const all = modules.every((m) => has(m, a));
    const out = {};
    modules.forEach((m) => {
      const cur = (value[m] || []).filter((x) => x !== a);
      out[m] = all ? cur : [...cur, a];
    });
    onChange(out);
  };
  return (
    <div className="table-responsive border radius-8" style={{ maxHeight: 360, overflow: "auto" }}>
      <table className="table mb-0 align-middle text-center sm-table">
        <thead className="position-sticky top-0 bg-base" style={{ zIndex: 1 }}>
          <tr>
            <th className="text-start">Module</th>
            {actions.map((a) => (
              <th key={a}>
                <button type="button" className="btn btn-link p-0 text-sm text-secondary-light text-decoration-none" disabled={disabled} onClick={() => toggleCol(a)} title="Toggle whole column">
                  {titleCase(a)}
                </button>
              </th>
            ))}
            <th>All</th>
          </tr>
        </thead>
        <tbody>
          {modules.map((m) => (
            <tr key={m}>
              <td className="text-start fw-medium">{titleCase(m)}</td>
              {actions.map((a) => (
                <td key={a}>
                  <input type="checkbox" className="form-check-input" checked={has(m, a)} disabled={disabled} onChange={() => toggle(m, a)} aria-label={`${m} ${a}`} />
                </td>
              ))}
              <td>
                <input type="checkbox" className="form-check-input" checked={(value[m] || []).length === actions.length} disabled={disabled} onChange={() => toggleRow(m)} aria-label={`${m} all`} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Roles() {
  const { can } = useAuth();
  const confirm = useConfirm();
  const roles = useFetch("/admin/roles");
  const meta = useFetch("/admin/roles/meta");
  const cities = useFetch("/admin/cities", { limit: 100 });
  const zones = useFetch("/admin/zones", { limit: 200 });
  const [editing, setEditing] = useState(null); // "new" | role
  const form = useForm(EMPTY);
  const { busy, run } = useSubmit();
  const v = form.values;
  const isNew = editing === "new";
  const modules = meta.data?.modules || [];
  const actions = meta.data?.actions || [];
  const cityOpts = (cities.data?.data || []).map((c) => ({ value: c.id, label: c.name }));
  const zoneOpts = (zones.data?.data || []).map((z) => ({ value: z.id, label: `${z.name}${z.city?.name ? ` (${z.city.name})` : ""}` }));

  const open = (role) => {
    form.reset(role ? { name: role.name, description: role.description || "", permissions: role.permissions || {}, refundLimit: role.refundLimit ?? 0, cityIds: role.cityIds || [], zoneIds: role.zoneIds || [] } : EMPTY);
    setEditing(role || "new");
  };

  const save = () =>
    run(
      async () => {
        const body = { name: v.name, description: v.description, permissions: v.permissions, refundLimit: Number(v.refundLimit) || 0, cityIds: v.cityIds, zoneIds: v.zoneIds };
        if (isNew) await http.post("/admin/roles", body);
        else await http.patch(`/admin/roles/${editing.id}`, body);
      },
      { success: isNew ? "Role created" : "Role saved", onDone: () => { setEditing(null); roles.reload(); } }
    );

  const clone = async (r) => {
    const { confirmed, value } = await confirm({ title: `Clone "${r.name}"`, confirmText: "Clone", prompt: { label: "New role name", required: true, defaultValue: `${r.name} (copy)` } });
    if (!confirmed || !value.trim()) return;
    await run(() => http.post(`/admin/roles/${r.id}/clone`, { name: value.trim() }), { success: "Role cloned", onDone: roles.reload });
  };

  const remove = async (r) => {
    const { confirmed } = await confirm({ title: `Delete role "${r.name}"?`, message: "This cannot be undone.", confirmText: "Delete", danger: true });
    if (!confirmed) return;
    await run(() => http.del(`/admin/roles/${r.id}`), { success: "Role deleted", onDone: roles.reload });
  };

  const summary = (r) => {
    const n = Object.values(r.permissions || {}).filter((a) => a.length).length;
    return `${n} of ${modules.length || "—"} modules`;
  };

  const columns = [
    {
      key: "name",
      title: "Role",
      render: (r) => (
        <div>
          <div className="fw-semibold">
            {r.name} {r.isSystem && <Badge tone="info" className="ms-1">System</Badge>}
          </div>
          <div className="text-xs text-secondary-light">{r.description}</div>
        </div>
      ),
    },
    { key: "perm", title: "Access", render: summary },
    { key: "refundLimit", title: "Refund limit", render: (r) => money(r.refundLimit) },
    { key: "scope", title: "Scope", render: (r) => (r.cityIds?.length || r.zoneIds?.length ? `${r.cityIds.length} cities, ${r.zoneIds.length} zones` : <span className="text-secondary-light">All areas</span>) },
    { key: "userCount", title: "Users", align: "right", render: (r) => r.userCount },
    {
      key: "actions",
      title: "",
      align: "right",
      render: (r) => (
        <div className="d-flex gap-1 justify-content-end" onClick={(e) => e.stopPropagation()}>
          <IconButton icon={can("roles", "edit") ? "solar:pen-outline" : "solar:eye-outline"} title={can("roles", "edit") ? "Edit" : "View"} tone="primary" onClick={() => open(r)} />
          {can("roles", "create") && <IconButton icon="solar:copy-outline" title="Clone" onClick={() => clone(r)} />}
          {can("roles", "delete") && !r.isSystem && <IconButton icon="solar:trash-bin-trash-outline" title="Delete" tone="danger" onClick={() => remove(r)} />}
        </div>
      ),
    },
  ];

  const readOnly = !isNew && !can("roles", "edit");

  return (
    <>
      <PageHeader
        title="Roles & Permissions"
        subtitle="Control what each staff role can see and do"
        crumbs={[{ label: "Admin" }, { label: "Roles" }]}
        actions={can("roles", "create") && <Button icon="solar:add-circle-outline" onClick={() => open(null)}>New role</Button>}
      />
      <Card noPadding>
        {roles.error && <ErrorState error={roles.error} onRetry={roles.reload} />}
        <DataTable columns={columns} rows={roles.data?.data || []} loading={roles.loading} onRowClick={(r) => open(r)} emptyTitle="No roles yet" />
      </Card>

      <FormModal open={!!editing} onClose={() => setEditing(null)} title={isNew ? "New role" : `${readOnly ? "Role" : "Edit role"}: ${editing?.name || ""}`} size="xl" onSubmit={readOnly ? () => setEditing(null) : save} busy={busy} disabled={!v.name} submitText={readOnly ? "Close" : isNew ? "Create role" : "Save role"}>
        <div className="row">
          <TextInput col="col-md-6" label="Name" required disabled={readOnly} {...form.bind("name")} />
          <MoneyInput col="col-md-6" label="Refund limit (per order)" hint="Largest refund this role may issue without escalation" disabled={readOnly} {...form.bind("refundLimit")} />
          <TextArea label="Description" rows={2} disabled={readOnly} {...form.bind("description")} />
        </div>
        <label className="form-label fw-semibold text-sm">Permissions</label>
        {meta.loading ? <Loading minHeight={120} /> : meta.error ? <ErrorState error={meta.error} onRetry={meta.reload} /> : (
          <PermissionMatrix modules={modules} actions={actions} value={v.permissions} onChange={(p) => form.set("permissions", p)} disabled={readOnly} />
        )}
        <div className="mt-20">
          <MultiCheck label="City scope" hint="Leave empty for all cities" cols={3} options={cityOpts} value={v.cityIds} onChange={(x) => !readOnly && form.set("cityIds", x)} />
          <MultiCheck label="Zone scope" hint="Leave empty for all zones" cols={3} options={zoneOpts} value={v.zoneIds} onChange={(x) => !readOnly && form.set("zoneIds", x)} />
        </div>
      </FormModal>
    </>
  );
}
