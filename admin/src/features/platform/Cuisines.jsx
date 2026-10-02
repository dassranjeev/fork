import React from "react";
import { safeImgUrl } from "../../lib/safe";
import { BoolBadge, FormRow, NumberInput, Switch, TextInput, FileInput } from "../../ui";
import { CrudPage } from "./crud";

export default function Cuisines() {
  return (
    <CrudPage
      title="Cuisines"
      subtitle="Cuisine categories customers filter restaurants by."
      path="/admin/cuisines"
      module="content"
      itemName="cuisine"
      limit={50}
      sortBy="sortOrder"
      sortDir="ASC"
      initial={{ name: "", slug: "", iconUrl: "", sortOrder: 100, active: true }}
      searchPlaceholder="Search cuisines…"
      filterDefs={[{ name: "active", placeholder: "All statuses", options: [{ value: "true", label: "Active" }, { value: "false", label: "Inactive" }] }]}
      canDelete={(r) => !r.restaurantCount}
      columns={[
        { key: "sortOrder", title: "#", sortable: true, width: 60 },
        {
          key: "name",
          title: "Name",
          sortable: true,
          render: (r) => (
            <div className="d-flex align-items-center gap-2">
              {r.iconUrl && <img src={safeImgUrl(r.iconUrl)} alt="" width={24} height={24} className="radius-4" />}
              <span className="fw-semibold">{r.name}</span>
            </div>
          ),
        },
        { key: "slug", title: "Slug", render: (r) => <span className="font-monospace text-secondary-light">{r.slug}</span> },
        { key: "restaurantCount", title: "Restaurants" },
        { key: "active", title: "Status", render: (r) => <BoolBadge value={r.active} yes="Active" no="Inactive" /> },
      ]}
      toPayload={(v, editing) => ({
        name: v.name,
        ...(v.slug ? { slug: v.slug } : {}),
        iconUrl: v.iconUrl || undefined,
        sortOrder: v.sortOrder === "" ? undefined : Number(v.sortOrder),
        active: !!v.active,
        ...(editing ? {} : {}),
      })}
      renderForm={({ f }) => (
        <>
          <FormRow>
            <TextInput col={7} label="Name" required {...f.bind("name")} />
            <NumberInput col={5} label="Sort order" step="1" {...f.bind("sortOrder")} />
            <TextInput col={12} label="Slug" hint="Leave blank to auto-generate." {...f.bind("slug")} />
          </FormRow>
          <FileInput label="Icon" value={f.values.iconUrl} onChange={(u) => f.set("iconUrl", u || "")} />
          <Switch label="Active" {...f.bindCheck("active")} />
        </>
      )}
    />
  );
}
