import React, { useState } from "react";
import { Avatar, Badge, BoolBadge, Button, FormModal, IconButton, Modal, Select, Switch, TextInput, useConfirm } from "../../ui";
import { fmtDateTime, fullName } from "../../lib/format";
import { Async, PortalPage, ROLE_LABEL, useAction, useApi, usePortalFetch } from "./shared";
import { usePortal } from "./context";

function TempPassword({ value, onClose }) {
  return (
    <Modal open={!!value} onClose={onClose} title="Temporary password" size="sm" footer={<Button onClick={onClose}>Done</Button>}>
      <p className="text-secondary-light text-sm">Share this with the staff member. It is shown only once and they should change it after signing in.</p>
      <div className="p-16 bg-neutral-100 radius-8 text-center fw-bold text-lg" style={{ fontFamily: "monospace", userSelect: "all" }}>
        {value}
      </div>
    </Modal>
  );
}

function MemberModal({ member, open, onClose, onSaved, onPassword }) {
  const api = useApi();
  const { locations, restaurantId, isOwner } = usePortal();
  const { busy, run } = useAction();
  const [f, setF] = useState({});
  React.useEffect(() => {
    if (!open) return;
    setF(
      member
        ? { firstName: member.firstName || "", lastName: member.lastName || "", phone: member.phone || "", role: member.role, restaurantId: member.restaurantId || restaurantId, active: member.active }
        : { firstName: "", lastName: "", email: "", phone: "", role: "CASHIER", restaurantId, active: true }
    );
  }, [open, member, restaurantId]);
  if (!open) return null;
  const roles = (isOwner ? ["OWNER", "LOCATION_MANAGER", "CASHIER", "KITCHEN"] : ["CASHIER", "KITCHEN"]).map((r) => ({ value: r, label: ROLE_LABEL[r] }));
  const needsLocation = f.role !== "OWNER";
  const submit = async () => {
    const loc = needsLocation ? f.restaurantId : undefined;
    const body = member
      ? { firstName: f.firstName, lastName: f.lastName, phone: f.phone || undefined, role: f.role, restaurantId: loc, active: f.active }
      : { firstName: f.firstName, lastName: f.lastName, email: f.email, phone: f.phone || undefined, role: f.role, restaurantId: loc };
    const r = await run("save", () => (member ? api.patch(`/restaurant/staff/${member.id}`, body) : api.post("/restaurant/staff", body)), member ? "Staff member saved" : "Staff member added");
    if (r.ok) {
      if (r.data?.temporaryPassword) onPassword(r.data.temporaryPassword);
      onSaved();
    }
  };
  const ok = f.firstName?.trim() && f.lastName?.trim() && (member || f.email?.trim());
  return (
    <FormModal open onClose={onClose} title={member ? `Edit ${fullName(member)}` : "Add staff member"} onSubmit={submit} busy={!!busy} disabled={!ok}>
      <div className="row">
        <TextInput col={6} label="First name" required value={f.firstName} onChange={(v) => setF({ ...f, firstName: v })} />
        <TextInput col={6} label="Last name" required value={f.lastName} onChange={(v) => setF({ ...f, lastName: v })} />
        {!member && <TextInput col={6} label="Email" required type="email" value={f.email} onChange={(v) => setF({ ...f, email: v })} />}
        <TextInput col={6} label="Phone" value={f.phone} onChange={(v) => setF({ ...f, phone: v })} />
        <Select col={6} label="Role" allowEmpty={false} value={f.role} onChange={(v) => setF({ ...f, role: v })} options={roles} />
        {needsLocation && <Select col={6} label="Location" allowEmpty={false} value={f.restaurantId} onChange={(v) => setF({ ...f, restaurantId: v })} options={locations.map((l) => ({ value: l.id, label: l.name }))} />}
      </div>
      {member && <Switch label="Active (can sign in)" checked={f.active} onChange={(v) => setF({ ...f, active: v })} className="mb-0" />}
      {!member && <p className="text-secondary-light text-sm mb-0">A temporary password is generated for the new member.</p>}
    </FormModal>
  );
}

export default function Staff() {
  const state = usePortalFetch("/restaurant/staff");
  const api = useApi();
  const confirm = useConfirm();
  const { run } = useAction();
  const [edit, setEdit] = useState(null);
  const [pw, setPw] = useState(null);

  const reset = async (m) => {
    const c = await confirm({ title: `Reset password for ${fullName(m)}?`, message: "A new temporary password is generated.", confirmText: "Reset" });
    if (!c.confirmed) return;
    const r = await run(m.id, () => api.post(`/restaurant/staff/${m.id}/reset-password`));
    if (r.ok) setPw(r.data.temporaryPassword);
  };
  const deactivate = async (m) => {
    const c = await confirm({ title: `Deactivate ${fullName(m)}?`, message: "They will no longer be able to sign in.", danger: true, confirmText: "Deactivate" });
    if (!c.confirmed) return;
    const r = await run(m.id, () => api.del(`/restaurant/staff/${m.id}`), "Staff member deactivated");
    if (r.ok) state.reload();
  };

  return (
    <PortalPage
      title="Staff"
      subtitle="People who can sign in to this portal"
      actions={
        <Button icon="solar:user-plus-outline" onClick={() => setEdit({ member: null })}>
          Add staff
        </Button>
      }
    >
      <Async state={state} empty={(d) => d.length === 0} emptyProps={{ title: "No staff yet" }}>
        {(rows) => (
          <div className="card radius-12 border-0 shadow-sm">
            <div className="table-responsive">
              <table className="table bordered-table mb-0 align-middle">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Role</th>
                    <th>Location</th>
                    <th>Status</th>
                    <th>Last sign-in</th>
                    <th className="text-end">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((m) => (
                    <tr key={m.id}>
                      <td>
                        <div className="d-flex align-items-center gap-2">
                          <Avatar name={fullName(m)} size={36} />
                          <div>
                            <div className="fw-semibold">{fullName(m)}</div>
                            <div className="text-secondary-light text-xs">{m.email}</div>
                          </div>
                        </div>
                      </td>
                      <td>
                        <Badge tone={m.role === "OWNER" ? "purple" : m.role === "LOCATION_MANAGER" ? "primary" : "neutral"}>{ROLE_LABEL[m.role] || m.role}</Badge>
                      </td>
                      <td>{m.restaurantName || "—"}</td>
                      <td>
                        <BoolBadge value={m.active} yes="Active" no="Inactive" />
                      </td>
                      <td>{m.lastLoginAt ? fmtDateTime(m.lastLoginAt) : "Never"}</td>
                      <td className="text-end">
                        <div className="d-inline-flex gap-2">
                          <IconButton icon="solar:pen-outline" tone="primary" title="Edit" onClick={() => setEdit({ member: m })} />
                          <IconButton icon="solar:key-outline" tone="warning" title="Reset password" onClick={() => reset(m)} />
                          {m.active && <IconButton icon="solar:user-block-outline" tone="danger" title="Deactivate" onClick={() => deactivate(m)} />}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Async>
      <MemberModal
        open={!!edit}
        member={edit?.member}
        onClose={() => setEdit(null)}
        onPassword={setPw}
        onSaved={() => {
          setEdit(null);
          state.reload();
        }}
      />
      <TempPassword value={pw} onClose={() => setPw(null)} />
    </PortalPage>
  );
}
