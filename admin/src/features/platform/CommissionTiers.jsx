import React, { useEffect, useState } from "react";
import { http } from "../../lib/api";
import { useFetch, useSubmit } from "../../lib/hooks";
import { Badge, BoolBadge, Button, FormRow, IconButton, Modal, PercentInput, Select, Switch, TagsInput, TextArea, TextInput, useConfirm } from "../../ui";
import { CrudPage } from "./crud";

function ApplyModal({ tier, tiers, onClose, onDone }) {
  const { busy, run } = useSubmit();
  const confirm = useConfirm();
  const { data: cities } = useFetch("/admin/cities", { limit: 100 });
  const [sel, setSel] = useState({ cityId: "", zoneId: "", fromTierId: "", clearOverrides: false, ids: [] });
  const { data: zones } = useFetch(sel.cityId ? "/admin/zones" : null, { cityId: sel.cityId, limit: 100 });
  const [preview, setPreview] = useState(null);
  useEffect(() => setPreview(null), [sel]);

  const body = (dryRun) => ({
    ...(sel.cityId ? { cityId: sel.cityId } : {}),
    ...(sel.zoneId ? { zoneId: sel.zoneId } : {}),
    ...(sel.fromTierId ? { fromTierId: sel.fromTierId } : {}),
    ...(sel.ids.length ? { restaurantIds: sel.ids } : {}),
    clearOverrides: sel.clearOverrides,
    dryRun,
  });
  const hasSelector = sel.cityId || sel.zoneId || sel.fromTierId || sel.ids.length;
  const doPreview = () => run(() => http.post(`/admin/commission-tiers/${tier.id}/apply`, body(true)), { onDone: setPreview });
  const doApply = async () => {
    const r = await confirm({ title: `Apply "${tier.name}"?`, message: `This moves ${preview?.matched ?? "all matching"} restaurant(s) to the ${tier.name} tier.`, confirmText: "Apply" });
    if (!r.confirmed) return;
    run(() => http.post(`/admin/commission-tiers/${tier.id}/apply`, body(false)), {
      success: "Tier applied",
      onDone: () => {
        onDone();
        onClose();
      },
    });
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={`Bulk apply: ${tier.name}`}
      size="lg"
      footer={
        <>
          <Button variant="light" onClick={onClose}>
            Close
          </Button>
          <Button variant="outline" disabled={!hasSelector} loading={busy} onClick={doPreview}>
            Preview (dry run)
          </Button>
          <Button disabled={!hasSelector || !preview || !preview.matched} loading={busy} onClick={doApply}>
            Apply to {preview?.matched ?? 0}
          </Button>
        </>
      }
    >
      <p className="text-secondary-light text-sm">Pick at least one selector. Restaurants matching all selectors are moved to this tier.</p>
      <FormRow>
        <Select col={6} label="City" value={sel.cityId} onChange={(v) => setSel({ ...sel, cityId: v, zoneId: "" })} options={(cities?.data ?? []).map((c) => ({ value: c.id, label: c.name }))} />
        <Select col={6} label="Zone" value={sel.zoneId} disabled={!sel.cityId} onChange={(v) => setSel({ ...sel, zoneId: v })} options={(zones?.data ?? []).map((z) => ({ value: z.id, label: z.name }))} />
        <Select col={6} label="Currently on tier" value={sel.fromTierId} onChange={(v) => setSel({ ...sel, fromTierId: v })} options={tiers.filter((t) => t.id !== tier.id).map((t) => ({ value: t.id, label: t.name }))} />
        <TagsInput col={6} label="Specific restaurant IDs" value={sel.ids} onChange={(ids) => setSel({ ...sel, ids })} placeholder="Paste UUIDs, Enter" />
      </FormRow>
      <Switch label="Clear per-restaurant commission overrides" checked={sel.clearOverrides} onChange={(v) => setSel({ ...sel, clearOverrides: v })} />
      {preview && (
        <div className="alert alert-info radius-8">
          <strong>{preview.matched}</strong> restaurant(s) match.
          {preview.restaurants?.length > 0 && (
            <ul className="mb-0 mt-8 ps-3" style={{ maxHeight: 180, overflowY: "auto" }}>
              {preview.restaurants.map((r, i) => (
                <li key={r.id || r.restaurantId || i}>{r.name || r.id}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Modal>
  );
}

export default function CommissionTiers() {
  const [applyTo, setApplyTo] = useState(null);
  const { data } = useFetch("/admin/commission-tiers", { limit: 100 });
  const tiers = data?.data ?? [];
  return (
    <CrudPage
      title="Commission Tiers"
      subtitle="Delivery, pickup and own-driver commission rates charged to restaurants."
      path="/admin/commission-tiers"
      module="pricing"
      itemName="tier"
      initial={{ name: "", description: "", deliveryPct: 20, pickupPct: 8, ownDriverPct: 12, active: true, isDefault: false }}
      searchPlaceholder="Search tiers…"
      canDelete={(r) => !r.isDefault && !r.restaurantCount}
      columns={[
        {
          key: "name",
          title: "Tier",
          render: (r) => (
            <div>
              <div className="fw-semibold">
                {r.name} {r.isDefault && <Badge tone="primary" className="ms-1">Default</Badge>}
              </div>
              <div className="text-secondary-light text-xs">{r.description}</div>
            </div>
          ),
        },
        { key: "deliveryPct", title: "Delivery", render: (r) => `${r.deliveryPct}%` },
        { key: "pickupPct", title: "Pickup", render: (r) => `${r.pickupPct}%` },
        { key: "ownDriverPct", title: "Own driver", render: (r) => `${r.ownDriverPct}%` },
        { key: "restaurantCount", title: "Restaurants" },
        { key: "active", title: "Status", render: (r) => <BoolBadge value={r.active} yes="Active" no="Inactive" /> },
      ]}
      toPayload={(v) => ({
        name: v.name,
        description: v.description || undefined,
        deliveryPct: Number(v.deliveryPct),
        pickupPct: Number(v.pickupPct),
        ownDriverPct: Number(v.ownDriverPct),
        active: !!v.active,
        isDefault: !!v.isDefault,
      })}
      rowActions={(row) => <IconButton icon="solar:users-group-rounded-outline" title="Bulk apply to restaurants" tone="success" onClick={() => setApplyTo(row)} />}
      renderForm={({ f }) => (
        <>
          <TextInput label="Name" required {...f.bind("name")} />
          <TextArea label="Description" rows={2} {...f.bind("description")} />
          <FormRow>
            <PercentInput col={4} label="Delivery" max={100} {...f.bind("deliveryPct")} />
            <PercentInput col={4} label="Pickup" max={100} {...f.bind("pickupPct")} />
            <PercentInput col={4} label="Own driver" max={100} {...f.bind("ownDriverPct")} />
          </FormRow>
          <Switch label="Active" {...f.bindCheck("active")} />
          <Switch label="Default tier" hint="Assigned to new restaurants." {...f.bindCheck("isDefault")} />
        </>
      )}
    >
      {({ list }) => applyTo && <ApplyModal tier={applyTo} tiers={tiers} onClose={() => setApplyTo(null)} onDone={list.reload} />}
    </CrudPage>
  );
}
