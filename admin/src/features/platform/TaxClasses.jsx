import React from "react";
import { BoolBadge, Badge, FormRow, NumberInput, Switch, TextInput } from "../../ui";
import { CrudPage } from "./crud";

export default function TaxClasses() {
  return (
    <CrudPage
      title="Tax Classes"
      subtitle="Tax rates applied to menu items and fees at checkout."
      path="/admin/tax-classes"
      module="pricing"
      itemName="tax class"
      initial={{ code: "", name: "", ratePct: 13, active: true, isDefault: false }}
      searchPlaceholder="Search tax classes…"
      canDelete={(r) => !r.isDefault && !r.menuItemCount}
      columns={[
        { key: "code", title: "Code", render: (r) => <span className="fw-semibold font-monospace">{r.code}</span> },
        { key: "name", title: "Name" },
        { key: "ratePct", title: "Rate", render: (r) => `${r.ratePct}%` },
        { key: "menuItemCount", title: "Menu items" },
        { key: "isDefault", title: "Default", render: (r) => (r.isDefault ? <Badge tone="primary">Default</Badge> : "—") },
        { key: "active", title: "Active", render: (r) => <BoolBadge value={r.active} yes="Active" no="Inactive" /> },
      ]}
      toPayload={(v, editing) => {
        const b = { name: v.name, ratePct: Number(v.ratePct), active: !!v.active, isDefault: !!v.isDefault };
        if (!editing) b.code = String(v.code).toUpperCase().replace(/[^A-Z0-9_]/g, "_");
        return b;
      }}
      renderForm={({ f, editing }) => (
        <>
          <FormRow>
            <TextInput col={5} label="Code" required disabled={editing} hint="UPPER_SNAKE, e.g. HST_ON" {...f.bind("code")} />
            <TextInput col={7} label="Name" required {...f.bind("name")} />
            <NumberInput col={6} label="Rate" suffix="%" min={0} max={50} step="0.01" required {...f.bind("ratePct")} />
          </FormRow>
          <Switch label="Active" {...f.bindCheck("active")} />
          <Switch label="Default tax class" hint="Used for new menu items." {...f.bindCheck("isDefault")} />
        </>
      )}
    />
  );
}
