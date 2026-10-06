import React, { useMemo, useState } from "react";
import { Icon } from "@iconify/react/offline";
import { Badge, BoolBadge, Button, Card, EmptyState, FormModal, IconButton, MultiCheck, NumberInput, MoneyInput, Select, Switch, TagsInput, Tabs, TextArea, TextInput, useConfirm } from "../../ui";
import { fmtDateTime, money } from "../../lib/format";
import { Async, PortalPage, useAction, useApi, usePortalFetch, useRealtimeReload } from "./shared";
import { usePortal } from "./context";

// ------------------------------------------------------------------ 86 / restock
function EightySixModal({ target, onClose, onDone }) {
  const api = useApi();
  const { busy, run } = useAction();
  const [mode, setMode] = useState("day");
  const [hours, setHours] = useState(2);
  if (!target) return null;
  const submit = async () => {
    const body = mode === "hours" ? { hours: Number(hours) || 1 } : mode === "manual" ? { untilTomorrow: false } : {};
    const r = await run("86", () => api.post(`/restaurant/menu/${target.kind}/${target.id}/86`, body), `${target.name} marked out of stock`);
    if (r.ok) onDone();
  };
  return (
    <FormModal open onClose={onClose} title={`86 "${target.name}"`} onSubmit={submit} busy={!!busy} submitText="Mark out of stock" submitVariant="danger" size="sm">
      <Select
        label="Out of stock"
        allowEmpty={false}
        value={mode}
        onChange={setMode}
        options={[
          { value: "day", label: "Rest of the day (back tomorrow 4 am)" },
          { value: "hours", label: "For a number of hours" },
          { value: "manual", label: "Until I restock it" },
        ]}
      />
      {mode === "hours" && <NumberInput label="Hours" value={hours} onChange={setHours} min={1} max={72} />}
    </FormModal>
  );
}

// ------------------------------------------------------------------ item editor
function ItemModal({ item, menu, open, onClose, onSaved, defaultCategoryId }) {
  const api = useApi();
  const { busy, run } = useAction();
  const [f, setF] = useState(null);
  React.useEffect(() => {
    if (!open) return;
    setF(
      item
        ? {
            name: item.name,
            description: item.description || "",
            categoryId: item.categoryId || "",
            price: item.price,
            pickupPrice: item.pickupPrice ?? "",
            stationId: item.stationId || "",
            prepTimeMin: item.prepTimeMin ?? "",
            allergens: item.allergens || [],
            dietaryTags: item.dietaryTags || [],
            isPopular: !!item.isPopular,
            active: item.active !== false,
            groupIds: (item.modifierGroups || []).map((g) => g.id),
          }
        : { name: "", description: "", categoryId: defaultCategoryId || menu.categories[0]?.id || "", price: "", pickupPrice: "", stationId: "", prepTimeMin: "", allergens: [], dietaryTags: [], isPopular: false, active: true, groupIds: [] }
    );
  }, [open, item, menu, defaultCategoryId]);
  if (!open || !f) return null;
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }));
  const submit = async () => {
    if (!f.name.trim() || f.price === "") return;
    const body = {
      name: f.name.trim(),
      description: f.description || null,
      categoryId: f.categoryId || null,
      price: Number(f.price),
      pickupPrice: f.pickupPrice === "" ? null : Number(f.pickupPrice),
      stationId: f.stationId || null,
      prepTimeMin: f.prepTimeMin === "" ? null : Number(f.prepTimeMin),
      allergens: f.allergens,
      dietaryTags: f.dietaryTags,
      isPopular: f.isPopular,
      active: f.active,
      groupIds: f.groupIds,
    };
    const r = await run("save", () => (item ? api.patch(`/restaurant/menu/items/${item.id}`, body) : api.post("/restaurant/menu/items", body)), item ? "Item saved" : "Item created");
    if (r.ok) onSaved();
  };
  return (
    <FormModal open onClose={onClose} title={item ? `Edit ${item.name}` : "New item"} onSubmit={submit} busy={!!busy} size="lg" disabled={!f.name.trim() || f.price === ""}>
      <div className="row">
        <TextInput col={8} label="Name" required value={f.name} onChange={set("name")} />
        <Select col={4} label="Category" value={f.categoryId} onChange={set("categoryId")} options={menu.categories.map((c) => ({ value: c.id, label: c.name }))} placeholder="Uncategorised" />
        <TextArea label="Description" value={f.description} onChange={set("description")} rows={2} />
        <MoneyInput col={4} label="Delivery price" required value={f.price} onChange={set("price")} />
        <MoneyInput col={4} label="Pickup price" hint="Leave empty to use the delivery price" value={f.pickupPrice} onChange={set("pickupPrice")} />
        <NumberInput col={4} label="Prep time (min)" hint="Empty = store default" value={f.prepTimeMin} onChange={set("prepTimeMin")} min={0} />
        <Select col={6} label="Kitchen station" value={f.stationId} onChange={set("stationId")} options={menu.stations.map((s) => ({ value: s.id, label: s.name }))} placeholder="None" />
        <div className="col-md-6 pt-28 d-flex gap-4">
          <Switch label="Active" checked={f.active} onChange={set("active")} className="mb-0" />
          <Switch label="Popular" checked={f.isPopular} onChange={set("isPopular")} className="mb-0" />
        </div>
        <TagsInput col={6} label="Allergens" value={f.allergens} onChange={set("allergens")} className="mt-16" suggestions={["gluten", "dairy", "nuts", "peanuts", "soy", "eggs", "fish", "shellfish", "sesame"]} />
        <TagsInput col={6} label="Dietary tags" value={f.dietaryTags} onChange={set("dietaryTags")} className="mt-16" suggestions={["vegetarian", "vegan", "halal", "gluten-free", "spicy"]} />
      </div>
      {menu.modifierGroups.length > 0 && <MultiCheck label="Modifier groups" cols={2} options={menu.modifierGroups.map((g) => ({ value: g.id, label: g.name }))} value={f.groupIds} onChange={set("groupIds")} />}
    </FormModal>
  );
}

// ------------------------------------------------------------------ items tab
function ItemsTab({ menu, reload }) {
  const api = useApi();
  const confirm = useConfirm();
  const { isManager: mgr } = usePortal();
  const isManager = mgr && menu.access?.canEdit !== false;
  const { run } = useAction();
  const [edit, setEdit] = useState(null);
  const [eighty, setEighty] = useState(null);
  const [q, setQ] = useState("");
  const match = (i) => !q || i.name.toLowerCase().includes(q.toLowerCase());

  const restock = async (kind, it) => {
    const r = await run(it.id, () => api.post(`/restaurant/menu/${kind}/${it.id}/restock`), `${it.name} back in stock`);
    if (r.ok) reload();
  };
  const del = async (it) => {
    const c = await confirm({ title: `Delete ${it.name}?`, message: "This removes the item from your menu.", danger: true, confirmText: "Delete" });
    if (!c.confirmed) return;
    const r = await run(it.id, () => api.del(`/restaurant/menu/items/${it.id}`), "Item deleted");
    if (r.ok) reload();
  };

  const groups = [...menu.categories, ...(menu.uncategorized.length ? [{ id: "_none", name: "Uncategorised", items: menu.uncategorized }] : [])];
  return (
    <>
      <div className="d-flex flex-wrap justify-content-between gap-3 mb-20">
        <form className="navbar-search" onSubmit={(e) => e.preventDefault()}>
          <input type="text" className="bg-base h-40-px w-auto" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search items…" />
          <Icon icon="ion:search-outline" className="icon" />
        </form>
        {isManager && (
          <Button icon="solar:add-circle-outline" onClick={() => setEdit({ item: null })}>
            Add item
          </Button>
        )}
      </div>
      {groups.length === 0 && <EmptyState title="No menu yet" text="Create a category, then add your first item." />}
      {groups.map((c) => {
        const items = (c.items || []).filter(match);
        if (q && !items.length) return null;
        return (
          <Card key={c.id} title={c.name} subtitle={`${items.length} item${items.length === 1 ? "" : "s"}${c.active === false ? " · hidden" : ""}`} className="mb-20" noPadding>
            <div className="table-responsive">
              <table className="table bordered-table sm-table mb-0 align-middle">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th className="text-end">Delivery</th>
                    <th className="text-end">Pickup</th>
                    <th>Station</th>
                    <th>Status</th>
                    <th className="text-end">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {items.length === 0 && (
                    <tr>
                      <td colSpan={6} className="text-center text-secondary-light py-20">
                        No items
                      </td>
                    </tr>
                  )}
                  {items.map((it) => (
                    <tr key={it.id}>
                      <td>
                        <div className="fw-semibold">{it.name}</div>
                        {it.description && <div className="text-secondary-light text-xs text-truncate" style={{ maxWidth: 320 }}>{it.description}</div>}
                      </td>
                      <td className="text-end">{money(it.price)}</td>
                      <td className="text-end">{it.pickupPrice != null && Number(it.pickupPrice) !== Number(it.price) ? money(it.pickupPrice) : <span className="text-secondary-light">same</span>}</td>
                      <td>{it.stationName || "—"}</td>
                      <td>
                        {!it.active ? <Badge tone="neutral">Hidden</Badge> : it.available ? <Badge tone="success">In stock</Badge> : <Badge tone="danger">86&apos;d{it.restockAt ? ` until ${fmtDateTime(it.restockAt)}` : ""}</Badge>}
                      </td>
                      <td className="text-end">
                        <div className="d-inline-flex gap-2">
                          {it.available ? (
                            <Button variant="outline-danger" onClick={() => setEighty({ kind: "items", id: it.id, name: it.name })}>
                              86
                            </Button>
                          ) : (
                            <Button variant="success" onClick={() => restock("items", it)}>
                              Restock
                            </Button>
                          )}
                          {isManager && (
                            <>
                              <IconButton icon="solar:pen-outline" title="Edit" tone="primary" onClick={() => setEdit({ item: it })} />
                              <IconButton icon="solar:trash-bin-trash-outline" title="Delete" tone="danger" onClick={() => del(it)} />
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        );
      })}
      <ItemModal
        open={!!edit}
        item={edit?.item}
        menu={menu}
        onClose={() => setEdit(null)}
        onSaved={() => {
          setEdit(null);
          reload();
        }}
      />
      <EightySixModal
        target={eighty}
        onClose={() => setEighty(null)}
        onDone={() => {
          setEighty(null);
          reload();
        }}
      />
    </>
  );
}

// ------------------------------------------------------------------ categories tab
function CategoryModal({ cat, open, onClose, onSaved }) {
  const api = useApi();
  const { busy, run } = useAction();
  const [f, setF] = useState({ name: "", description: "", active: true });
  React.useEffect(() => {
    if (open) setF(cat ? { name: cat.name, description: cat.description || "", active: cat.active !== false } : { name: "", description: "", active: true });
  }, [open, cat]);
  if (!open) return null;
  const submit = async () => {
    const body = { name: f.name.trim(), description: f.description || null, active: f.active };
    const r = await run("save", () => (cat ? api.patch(`/restaurant/menu/categories/${cat.id}`, body) : api.post("/restaurant/menu/categories", body)), "Category saved");
    if (r.ok) onSaved();
  };
  return (
    <FormModal open onClose={onClose} title={cat ? "Edit category" : "New category"} onSubmit={submit} busy={!!busy} disabled={!f.name.trim()} size="sm">
      <TextInput label="Name" required value={f.name} onChange={(v) => setF({ ...f, name: v })} />
      <TextArea label="Description" rows={2} value={f.description} onChange={(v) => setF({ ...f, description: v })} />
      <Switch label="Visible to customers" checked={f.active} onChange={(v) => setF({ ...f, active: v })} className="mb-0" />
    </FormModal>
  );
}

function CategoriesTab({ menu, reload }) {
  const api = useApi();
  const confirm = useConfirm();
  const { run } = useAction();
  const [edit, setEdit] = useState(null);
  const cats = menu.categories;
  const canEdit = menu.access?.canEdit !== false;
  const move = async (i, dir) => {
    const ids = cats.map((c) => c.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    const r = await run("mv", () => api.patch("/restaurant/menu/categories/reorder", { ids }));
    if (r.ok) reload();
  };
  const del = async (c) => {
    const others = cats.filter((x) => x.id !== c.id);
    const has = (c.items || []).length > 0;
    const res = await confirm({
      title: `Delete ${c.name}?`,
      message: has ? `Its ${c.items.length} items need a new home.` : undefined,
      danger: true,
      confirmText: "Delete",
      prompt: has ? { label: "Move items to", type: "select", required: true, options: others.map((o) => ({ value: o.id, label: o.name })) } : undefined,
    });
    if (!res.confirmed) return;
    const r = await run(c.id, () => api.del(`/restaurant/menu/categories/${c.id}${has ? `?moveItemsTo=${res.value}` : ""}`), "Category deleted");
    if (r.ok) reload();
  };
  return (
    <>
      {canEdit && (
        <div className="d-flex justify-content-end mb-20">
          <Button icon="solar:add-circle-outline" onClick={() => setEdit({ cat: null })}>
            Add category
          </Button>
        </div>
      )}
      <Card noPadding>
        {cats.length === 0 ? (
          <EmptyState title="No categories" text="Categories group your items on the menu." />
        ) : (
          <ul className="list-unstyled mb-0">
            {cats.map((c, i) => (
              <li key={c.id} className="d-flex align-items-center justify-content-between gap-3 px-20 py-12 border-bottom">
                <div>
                  <div className="fw-semibold">{c.name}</div>
                  <div className="text-secondary-light text-sm">{(c.items || []).length} items</div>
                </div>
                <div className="d-flex align-items-center gap-2">
                  <BoolBadge value={c.active !== false} yes="Visible" no="Hidden" />
                  {canEdit && (
                    <>
                      <IconButton icon="solar:alt-arrow-up-linear" title="Move up" disabled={i === 0} onClick={() => move(i, -1)} />
                      <IconButton icon="solar:alt-arrow-down-linear" title="Move down" disabled={i === cats.length - 1} onClick={() => move(i, 1)} />
                      <IconButton icon="solar:pen-outline" title="Edit" tone="primary" onClick={() => setEdit({ cat: c })} />
                      <IconButton icon="solar:trash-bin-trash-outline" title="Delete" tone="danger" onClick={() => del(c)} />
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <CategoryModal
        open={!!edit}
        cat={edit?.cat}
        onClose={() => setEdit(null)}
        onSaved={() => {
          setEdit(null);
          reload();
        }}
      />
    </>
  );
}

// ------------------------------------------------------------------ modifier groups tab
function GroupModal({ group, open, onClose, onSaved }) {
  const api = useApi();
  const { busy, run } = useAction();
  const [f, setF] = useState({ name: "", required: false, minSelect: 0, maxSelect: 1, options: [] });
  React.useEffect(() => {
    if (!open) return;
    setF(
      group
        ? { name: group.name, required: !!group.required, minSelect: group.minSelect ?? 0, maxSelect: group.maxSelect ?? 1, options: [] }
        : { name: "", required: false, minSelect: 0, maxSelect: 1, options: [{ name: "", priceDelta: 0 }] }
    );
  }, [open, group]);
  if (!open) return null;
  const setOpt = (i, patch) => setF((x) => ({ ...x, options: x.options.map((o, k) => (k === i ? { ...o, ...patch } : o)) }));
  const submit = async () => {
    const body = { name: f.name.trim(), required: f.required, minSelect: Number(f.minSelect) || 0, maxSelect: Number(f.maxSelect) || 1 };
    if (!group) body.options = f.options.filter((o) => o.name.trim()).map((o) => ({ name: o.name.trim(), priceDelta: Number(o.priceDelta) || 0 }));
    const r = await run("save", () => (group ? api.patch(`/restaurant/menu/groups/${group.id}`, body) : api.post("/restaurant/menu/groups", body)), "Group saved");
    if (r.ok) onSaved();
  };
  return (
    <FormModal open onClose={onClose} title={group ? `Edit ${group.name}` : "New modifier group"} onSubmit={submit} busy={!!busy} disabled={!f.name.trim()}>
      <TextInput label="Group name" required value={f.name} onChange={(v) => setF({ ...f, name: v })} placeholder="e.g. Size, Toppings" />
      <div className="row align-items-end">
        <div className="col-4">
          <Switch label="Required" checked={f.required} onChange={(v) => setF({ ...f, required: v, minSelect: v ? Math.max(1, f.minSelect) : 0 })} />
        </div>
        <NumberInput col={4} label="Min choices" value={f.minSelect} onChange={(v) => setF({ ...f, minSelect: v })} min={0} />
        <NumberInput col={4} label="Max choices" value={f.maxSelect} onChange={(v) => setF({ ...f, maxSelect: v })} min={1} />
      </div>
      {!group && (
        <>
          <div className="fw-semibold text-sm mb-8">Options</div>
          {f.options.map((o, i) => (
            <div key={i} className="row g-2 mb-8 align-items-center">
              <div className="col-7">
                <input className="form-control radius-8" placeholder="Option name" value={o.name} onChange={(e) => setOpt(i, { name: e.target.value })} />
              </div>
              <div className="col-4">
                <input type="number" step="0.01" className="form-control radius-8" placeholder="+ price" value={o.priceDelta} onChange={(e) => setOpt(i, { priceDelta: e.target.value })} />
              </div>
              <div className="col-1">
                <IconButton icon="solar:close-circle-outline" tone="danger" title="Remove" onClick={() => setF({ ...f, options: f.options.filter((_, k) => k !== i) })} />
              </div>
            </div>
          ))}
          <Button variant="outline" icon="solar:add-circle-outline" onClick={() => setF({ ...f, options: [...f.options, { name: "", priceDelta: 0 }] })}>
            Add option
          </Button>
        </>
      )}
    </FormModal>
  );
}

function OptionModal({ target, onClose, onSaved }) {
  const api = useApi();
  const { busy, run } = useAction();
  const [f, setF] = useState({ name: "", priceDelta: 0, isDefault: false });
  React.useEffect(() => {
    if (target) setF(target.option ? { name: target.option.name, priceDelta: target.option.priceDelta, isDefault: !!target.option.isDefault } : { name: "", priceDelta: 0, isDefault: false });
  }, [target]);
  if (!target) return null;
  const submit = async () => {
    const body = { name: f.name.trim(), priceDelta: Number(f.priceDelta) || 0, isDefault: f.isDefault };
    const r = await run("save", () => (target.option ? api.patch(`/restaurant/menu/options/${target.option.id}`, body) : api.post(`/restaurant/menu/groups/${target.group.id}/options`, body)), "Option saved");
    if (r.ok) onSaved();
  };
  return (
    <FormModal open onClose={onClose} title={target.option ? "Edit option" : `Add option to ${target.group.name}`} onSubmit={submit} busy={!!busy} disabled={!f.name.trim()} size="sm">
      <TextInput label="Name" required value={f.name} onChange={(v) => setF({ ...f, name: v })} />
      <MoneyInput label="Price change" hint="Added to the item price (can be 0)" value={f.priceDelta} onChange={(v) => setF({ ...f, priceDelta: v })} />
      <Switch label="Selected by default" checked={f.isDefault} onChange={(v) => setF({ ...f, isDefault: v })} className="mb-0" />
    </FormModal>
  );
}

function GroupsTab({ menu, reload }) {
  const api = useApi();
  const confirm = useConfirm();
  const { isManager: mgr } = usePortal();
  const isManager = mgr && menu.access?.canEdit !== false;
  const { run } = useAction();
  const [group, setGroup] = useState(null);
  const [opt, setOpt] = useState(null);
  const [eighty, setEighty] = useState(null);
  const done = (set) => () => {
    set(null);
    reload();
  };
  const delGroup = async (g) => {
    const c = await confirm({ title: `Delete ${g.name}?`, message: "It is removed from every item that uses it.", danger: true, confirmText: "Delete" });
    if (!c.confirmed) return;
    const r = await run(g.id, () => api.del(`/restaurant/menu/groups/${g.id}`), "Group deleted");
    if (r.ok) reload();
  };
  const delOpt = async (o) => {
    const r = await run(o.id, () => api.del(`/restaurant/menu/options/${o.id}`), "Option deleted");
    if (r.ok) reload();
  };
  const restock = async (o) => {
    const r = await run(o.id, () => api.post(`/restaurant/menu/options/${o.id}/restock`), `${o.name} back in stock`);
    if (r.ok) reload();
  };
  return (
    <>
      {isManager && (
        <div className="d-flex justify-content-end mb-20">
          <Button icon="solar:add-circle-outline" onClick={() => setGroup({ group: null })}>
            Add modifier group
          </Button>
        </div>
      )}
      {menu.modifierGroups.length === 0 && <EmptyState title="No modifier groups" text="Use groups for sizes, toppings, sides and other choices." />}
      <div className="row g-3">
        {menu.modifierGroups.map((g) => (
          <div key={g.id} className="col-lg-6">
            <Card
              title={g.name}
              subtitle={`${g.required ? "Required" : "Optional"} · choose ${g.minSelect ?? 0}-${g.maxSelect ?? 1}`}
              actions={
                isManager && (
                  <div className="d-flex gap-2">
                    <IconButton icon="solar:add-circle-outline" title="Add option" tone="success" onClick={() => setOpt({ group: g })} />
                    <IconButton icon="solar:pen-outline" title="Edit group" tone="primary" onClick={() => setGroup({ group: g })} />
                    <IconButton icon="solar:trash-bin-trash-outline" title="Delete group" tone="danger" onClick={() => delGroup(g)} />
                  </div>
                )
              }
            >
              <ul className="list-unstyled mb-0">
                {(g.options || []).map((o) => (
                  <li key={o.id} className="d-flex justify-content-between align-items-center gap-2 py-8 border-bottom">
                    <div>
                      <span className="fw-medium">{o.name}</span> {o.isDefault && <Badge tone="info" className="ms-1">Default</Badge>}
                      <div className="text-secondary-light text-xs">{Number(o.priceDelta) ? `+${money(o.priceDelta)}` : "No extra charge"}</div>
                    </div>
                    <div className="d-flex align-items-center gap-2">
                      {!o.available && <Badge tone="danger">86&apos;d</Badge>}
                      {o.available ? (
                        <Button variant="outline-danger" onClick={() => setEighty({ kind: "options", id: o.id, name: o.name })}>
                          86
                        </Button>
                      ) : (
                        <Button variant="success" onClick={() => restock(o)}>
                          Restock
                        </Button>
                      )}
                      {isManager && (
                        <>
                          <IconButton icon="solar:pen-outline" title="Edit" tone="primary" onClick={() => setOpt({ group: g, option: o })} />
                          <IconButton icon="solar:trash-bin-trash-outline" title="Delete" tone="danger" onClick={() => delOpt(o)} />
                        </>
                      )}
                    </div>
                  </li>
                ))}
                {(g.options || []).length === 0 && <li className="text-secondary-light text-sm py-8">No options yet</li>}
              </ul>
            </Card>
          </div>
        ))}
      </div>
      <GroupModal open={!!group} group={group?.group} onClose={() => setGroup(null)} onSaved={done(setGroup)} />
      <OptionModal target={opt} onClose={() => setOpt(null)} onSaved={done(setOpt)} />
      <EightySixModal target={eighty} onClose={() => setEighty(null)} onDone={done(setEighty)} />
    </>
  );
}

// ------------------------------------------------------------------ page
/** Shown while FORKSY has not allowed this restaurant to change its own menu. */
function MenuAccessBanner({ access, reload }) {
  const api = useApi();
  const { isManager } = usePortal();
  const { busy, run } = useAction();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  if (!access || access.canEdit) return null;
  const waiting = access.status === "REQUESTED";
  const submit = async () => {
    const r = await run("access", () => api.post("/restaurant/menu/access/request", { note: note.trim() || undefined }), "Request sent to FORKSY");
    if (r.ok) {
      setOpen(false);
      setNote("");
      reload();
    }
  };
  return (
    <div className={`alert ${waiting ? "alert-info" : "alert-warning"} radius-8 mb-20 d-flex flex-wrap align-items-center justify-content-between gap-3`}>
      <div>
        <strong>{waiting ? "Waiting for FORKSY approval" : "Menu editing is turned off"}</strong>
        <div className="text-sm">
          {waiting
            ? `You asked to edit your menu${access.requestedAt ? " on " + fmtDateTime(access.requestedAt) : ""}. You can keep marking items out of stock (86) meanwhile.`
            : "Your menu is read-only. You can still mark items out of stock (86) and back in stock. Ask FORKSY to allow you to add, update and remove items."}
          {!waiting && access.decisionNote ? ` FORKSY note: ${access.decisionNote}` : ""}
        </div>
      </div>
      {isManager && !waiting && (
        <Button icon="solar:lock-unlocked-outline" onClick={() => setOpen(true)}>
          Request access
        </Button>
      )}
      <FormModal open={open} onClose={() => setOpen(false)} title="Request menu editing access" onSubmit={submit} busy={!!busy} submitText="Send request" size="sm">
        <TextArea label="Why do you need to edit the menu? (optional)" value={note} onChange={setNote} rows={3} />
        <div className="text-secondary-light text-sm">FORKSY staff will review your request and you will be notified.</div>
      </FormModal>
    </div>
  );
}

export default function Menu() {
  const state = usePortalFetch("/restaurant/menu", { includeInactive: "true" });
  const { isManager } = usePortal();
  const [tab, setTab] = useState("items");
  useRealtimeReload(state.reload, ["menu.access_changed"]);
  const api = useApi();
  const { run, isBusy } = useAction();
  const exportCsv = async () => {
    const r = await run("csv", () => api.get("/restaurant/menu/csv"));
    if (r.ok && r.data?.csv) {
      const url = URL.createObjectURL(new Blob([r.data.csv], { type: "text/csv" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = "menu.csv";
      a.click();
      URL.revokeObjectURL(url);
    }
  };
  const tabs = useMemo(
    () => (menu) => [
      { key: "items", label: "Items", badge: menu.counts?.items, content: <ItemsTab menu={menu} reload={state.reload} /> },
      { key: "categories", label: "Categories", badge: menu.counts?.categories, hidden: !isManager, content: <CategoriesTab menu={menu} reload={state.reload} /> },
      { key: "groups", label: "Modifier groups", badge: menu.counts?.modifierGroups, content: <GroupsTab menu={menu} reload={state.reload} /> },
    ],
    [isManager, state.reload]
  );
  return (
    <PortalPage
      title="Menu"
      subtitle={isManager ? undefined : "Mark items out of stock (86) or back in stock"}
      actions={
        isManager && (
          <Button variant="outline" icon="solar:download-minimalistic-outline" loading={isBusy("csv")} onClick={exportCsv}>
            Export CSV
          </Button>
        )
      }
    >
      <Async state={state}>
        {(menu) => (
          <>
            <MenuAccessBanner access={menu.access} reload={state.reload} />
            <Tabs tabs={tabs(menu)} active={tab} onChange={setTab} />
          </>
        )}
      </Async>
    </PortalPage>
  );
}
