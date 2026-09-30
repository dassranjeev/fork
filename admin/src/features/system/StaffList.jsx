import React, { useState } from "react";
import { Avatar, Badge, Button, Card, DataTable, FilterSelect, FormModal, IconButton, ListToolbar, Modal, PageHeader, Select, StatusBadge, Switch, TextInput, useConfirm } from "../../ui";
import { useFetch, useForm, usePagedList, useSubmit } from "../../lib/hooks";
import { useAuth } from "../../lib/auth";
import { http } from "../../lib/api";
import { fmtDateTime, fullName } from "../../lib/format";

const EMPTY = { email: "", firstName: "", lastName: "", phone: "", roleId: "", superAdmin: false, password: "", status: "ACTIVE" };

export default function StaffList() {
  const { can, user: me } = useAuth();
  const confirm = useConfirm();
  const roles = useFetch("/admin/roles");
  const roleList = roles.data?.data || [];
  const list = usePagedList("/admin/staff", { filters: { roleId: "", status: "" }, sortBy: "createdAt", sortDir: "DESC" });
  const [editing, setEditing] = useState(null); // null | "new" | user
  const [secret, setSecret] = useState(null); // {title, value}
  const form = useForm(EMPTY);
  const { busy, run } = useSubmit();

  const openNew = () => {
    form.reset(EMPTY);
    setEditing("new");
  };
  const openEdit = (u) => {
    form.reset({ ...EMPTY, email: u.email, firstName: u.firstName || "", lastName: u.lastName || "", phone: u.phone || "", roleId: u.roleId || "", status: u.status });
    setEditing(u);
  };
  const isNew = editing === "new";
  const v = form.values;

  const save = () =>
    run(
      async () => {
        if (isNew) {
          const body = { email: v.email, firstName: v.firstName, lastName: v.lastName, phone: v.phone || undefined, password: v.password || undefined };
          if (v.superAdmin) body.superAdmin = true;
          else body.roleId = v.roleId;
          const r = await http.post("/admin/staff", body);
          if (r.temporaryPassword) setSecret({ title: `Account created for ${v.email}`, value: r.temporaryPassword });
        } else {
          const body = { firstName: v.firstName, lastName: v.lastName, phone: v.phone || undefined };
          if (editing.type !== "SUPER_ADMIN") {
            if (v.roleId) body.roleId = v.roleId;
            body.status = v.status;
          }
          await http.patch(`/admin/staff/${editing.id}`, body);
        }
      },
      {
        success: isNew ? "Staff user created" : "Staff user updated",
        onDone: () => {
          setEditing(null);
          list.reload();
        },
      }
    );

  const action = async (u, kind) => {
    const cfg = {
      "reset-2fa": { title: "Reset two-factor authentication?", message: `${fullName(u)} will need to set up 2FA again at next sign-in.`, confirmText: "Reset 2FA", success: "2FA reset" },
      "reset-password": { title: "Reset password?", message: `A new temporary password is generated and all sessions for ${fullName(u)} are revoked.`, confirmText: "Reset password" },
      "revoke-sessions": { title: "Sign out everywhere?", message: `All active sessions of ${fullName(u)} will be revoked.`, confirmText: "Revoke sessions", success: "Sessions revoked" },
      deactivate: { title: "Deactivate this user?", message: `${fullName(u)} will lose access immediately.`, confirmText: "Deactivate", danger: true, success: "User deactivated" },
      activate: { title: "Reactivate this user?", confirmText: "Activate", success: "User activated" },
      remove: { title: "Remove this staff user?", message: "Access is removed and the account is closed. Audit history is kept.", confirmText: "Remove", danger: true, success: "User removed" },
    }[kind];
    const { confirmed } = await confirm({ title: cfg.title, message: cfg.message, confirmText: cfg.confirmText, danger: cfg.danger });
    if (!confirmed) return;
    await run(
      async () => {
        if (kind === "deactivate") await http.patch(`/admin/staff/${u.id}`, { status: "SUSPENDED" });
        else if (kind === "activate") await http.patch(`/admin/staff/${u.id}`, { status: "ACTIVE" });
        else if (kind === "remove") await http.del(`/admin/staff/${u.id}`);
        else {
          const r = await http.post(`/admin/staff/${u.id}/${kind}`);
          if (r?.temporaryPassword) setSecret({ title: `New temporary password for ${u.email}`, value: r.temporaryPassword });
        }
      },
      { success: cfg.success, onDone: list.reload }
    );
  };

  const canEdit = can("staff", "edit");
  const columns = [
    {
      key: "name",
      title: "Name",
      sortable: true,
      sortKey: "firstName",
      render: (u) => (
        <div className="d-flex align-items-center gap-2">
          <Avatar name={fullName(u)} size={36} />
          <div>
            <div className="fw-semibold">{fullName(u)}</div>
            <div className="text-xs text-secondary-light">{u.email}</div>
          </div>
        </div>
      ),
    },
    { key: "role", title: "Role", render: (u) => (u.type === "SUPER_ADMIN" ? <Badge tone="purple">Super Admin</Badge> : u.role?.name || <span className="text-secondary-light">No role</span>) },
    { key: "status", title: "Status", render: (u) => <StatusBadge status={u.status} /> },
    { key: "twoFactorEnabled", title: "2FA", render: (u) => (u.twoFactorEnabled ? <Badge tone="success">On</Badge> : <Badge tone="warning">Off</Badge>) },
    { key: "lastLoginAt", title: "Last sign-in", sortable: true, render: (u) => <span className="text-nowrap">{u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : "Never"}</span> },
    {
      key: "actions",
      title: "",
      align: "right",
      render: (u) => {
        const self = u.id === me?.id;
        return (
          <div className="d-flex gap-1 justify-content-end" onClick={(e) => e.stopPropagation()}>
            {canEdit && <IconButton icon="solar:pen-outline" title="Edit" tone="primary" onClick={() => openEdit(u)} />}
            {canEdit && <IconButton icon="solar:shield-check-outline" title="Reset 2FA" tone="warning" onClick={() => action(u, "reset-2fa")} />}
            {canEdit && <IconButton icon="solar:key-outline" title="Reset password" tone="warning" onClick={() => action(u, "reset-password")} />}
            {canEdit && <IconButton icon="solar:logout-2-outline" title="Revoke sessions" onClick={() => action(u, "revoke-sessions")} />}
            {canEdit && !self && (u.status === "ACTIVE" ? <IconButton icon="solar:user-block-outline" title="Deactivate" tone="danger" onClick={() => action(u, "deactivate")} /> : <IconButton icon="solar:user-check-outline" title="Activate" tone="success" onClick={() => action(u, "activate")} />)}
            {can("staff", "delete") && !self && <IconButton icon="solar:trash-bin-trash-outline" title="Remove" tone="danger" onClick={() => action(u, "remove")} />}
          </div>
        );
      },
    },
  ];

  const invalid = isNew ? !v.email || !v.firstName || !v.lastName || (!v.superAdmin && !v.roleId) : !v.firstName || !v.lastName;

  return (
    <>
      <PageHeader title="Staff Users" subtitle="Back-office team members, their roles and access" crumbs={[{ label: "Admin" }, { label: "Staff Users" }]} />
      <Card noPadding>
        <div className="p-24 pb-0">
          <ListToolbar
            list={list}
            placeholder="Search name or email…"
            filters={
              <>
                <FilterSelect value={list.filters.roleId} onChange={(x) => list.setFilter("roleId", x)} options={roleList.map((r) => ({ value: r.id, label: r.name }))} placeholder="All roles" />
                <FilterSelect value={list.filters.status} onChange={(x) => list.setFilter("status", x)} options={["ACTIVE", "SUSPENDED"]} placeholder="All statuses" />
              </>
            }
            actions={can("staff", "create") && <Button icon="solar:add-circle-outline" onClick={openNew}>Add staff user</Button>}
          />
        </div>
        <DataTable columns={columns} {...list.tableProps} error={list.error} onRetry={list.reload} emptyTitle="No staff users match" />
      </Card>

      <FormModal open={!!editing} onClose={() => setEditing(null)} title={isNew ? "Add staff user" : `Edit ${fullName(editing || {})}`} onSubmit={save} busy={busy} disabled={invalid} submitText={isNew ? "Create user" : "Save changes"}>
        <div className="row">
          <TextInput col="col-md-6" label="First name" required {...form.bind("firstName")} />
          <TextInput col="col-md-6" label="Last name" required {...form.bind("lastName")} />
          <TextInput col="col-md-6" label="Email" type="email" required disabled={!isNew} {...form.bind("email")} />
          <TextInput col="col-md-6" label="Phone" {...form.bind("phone")} />
          {isNew && me?.type === "SUPER_ADMIN" && <Switch label="Super admin (full access, no role)" checked={!!v.superAdmin} onChange={(x) => form.set("superAdmin", x)} />}
          {!(v.superAdmin || editing?.type === "SUPER_ADMIN") && (
            <Select col="col-md-6" label="Role" required options={roleList.map((r) => ({ value: r.id, label: r.name }))} {...form.bind("roleId")} />
          )}
          {!isNew && editing?.type !== "SUPER_ADMIN" && <Select col="col-md-6" label="Status" allowEmpty={false} options={["ACTIVE", "SUSPENDED"]} {...form.bind("status")} />}
          {isNew && <TextInput col="col-md-6" label="Password" hint="Leave blank to generate a temporary password" type="password" {...form.bind("password")} />}
        </div>
      </FormModal>

      <Modal open={!!secret} onClose={() => setSecret(null)} title={secret?.title} size="sm" footer={<Button onClick={() => setSecret(null)}>Done</Button>}>
        <p className="text-secondary-light">Copy this temporary password now. It is shown only once.</p>
        <div className="p-12 bg-neutral-100 radius-8 font-monospace fw-semibold user-select-all">{secret?.value}</div>
      </Modal>
    </>
  );
}
