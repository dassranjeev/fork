import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { http } from "../../lib/api";
import { useFetch, useForm, useSubmit } from "../../lib/hooks";
import { AddressFinder, Button, Card, FormRow, LocationPicker, Modal, MultiCheck, NumberInput, PageHeader, Segmented, Select, TextArea, TextInput } from "../../ui";
import { STORE_TYPES, listOf, useLookups } from "./shared";

const INIT = {
  storeType: "RESTAURANT", name: "", description: "", phone: "", email: "", addressLine1: "", city: "", province: "ON", postalCode: "", priceLevel: 2, commissionTierId: "", cuisineIds: [],
  merchantId: "", businessName: "", legalName: "", hstNumber: "", contactEmail: "", contactPhone: "",
  ownerFirstName: "", ownerLastName: "", ownerEmail: "", ownerPhone: "",
};

export default function RestaurantCreate() {
  const nav = useNavigate();
  const { tiers } = useLookups();
  const merchants = listOf(useFetch("/admin/restaurants/merchants", { limit: 100 }).data);
  const cuisines = listOf(useFetch("/admin/cuisines", { limit: 100 }).data);
  const form = useForm(INIT);
  const v = form.values;
  const [mode, setMode] = useState("new");
  const [geo, setGeo] = useState({ lat: 43.589, lng: -79.6441 });
  const [created, setCreated] = useState(null);
  const { busy, run } = useSubmit();

  const valid = v.name.trim() && (mode === "existing" ? v.merchantId : v.businessName.trim()) && (!v.ownerEmail || (v.ownerFirstName && v.ownerLastName));

  const submit = () => {
    const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, x]) => x !== "" && x !== undefined));
    const body = clean({
      storeType: v.storeType, name: v.name.trim(), description: v.description, phone: v.phone, email: v.email, addressLine1: v.addressLine1, city: v.city, province: v.province, postalCode: v.postalCode,
      lat: geo.lat, lng: geo.lng, priceLevel: v.priceLevel, commissionTierId: v.commissionTierId, cuisineIds: v.cuisineIds.length ? v.cuisineIds : undefined,
    });
    if (mode === "existing") body.merchantId = v.merchantId;
    else body.merchant = clean({ businessName: v.businessName, legalName: v.legalName, hstNumber: v.hstNumber, contactEmail: v.contactEmail, contactPhone: v.contactPhone });
    if (v.ownerEmail) body.owner = clean({ email: v.ownerEmail, firstName: v.ownerFirstName, lastName: v.ownerLastName, phone: v.ownerPhone });
    run(() => http.post("/admin/restaurants", body), {
      success: "Restaurant created",
      onDone: (res) => (res?.temporaryPassword ? setCreated(res) : nav(`/restaurants/${res?.restaurant?.id || ""}`)),
    });
  };

  return (
    <>
      <PageHeader title="Add a business" subtitle="Creates the location in APPLIED status; continue with documents review from the detail page" back="/restaurants" crumbs={[{ label: "Restaurants", to: "/restaurants" }, { label: "Add" }]} />
      <div className="row gy-4">
        <div className="col-lg-8">
          <Card title="Restaurant or store">
            <FormRow>
              <Select col={12} label="Kind of store" allowEmpty={false} hint={`${STORE_TYPES.find((t) => t.value === v.storeType)?.hint}. It sets the defaults of the new location (prep time, delivery radius, minimum order, kitchen display), the documents asked for and the commission tier used.`} options={STORE_TYPES.map((t) => ({ value: t.value, label: `${t.label} (${t.vertical === "FOOD" ? "food" : "grocery and shops"})` }))} {...form.bind("storeType")} />
              <TextInput col={8} label="Name" required {...form.bind("name")} />
              <Select col={4} label="Price level" allowEmpty={false} options={[1, 2, 3, 4].map((n) => ({ value: n, label: "$".repeat(n) }))} value={v.priceLevel} onChange={(x) => form.set("priceLevel", Number(x))} />
              <TextArea col={12} label="Description" {...form.bind("description")} />
              <TextInput col={6} label="Phone" {...form.bind("phone")} />
              <TextInput col={6} label="Email" type="email" {...form.bind("email")} />
              <TextInput col={12} label="Address" {...form.bind("addressLine1")} />
              <TextInput col={4} label="City" {...form.bind("city")} />
              <TextInput col={4} label="Province" {...form.bind("province")} />
              <TextInput col={4} label="Postal code" {...form.bind("postalCode")} />
              <Select col={6} label="Commission tier" placeholder="Default tier" options={tiers.map((t) => ({ value: t.id, label: `${t.name} (${t.deliveryPct}% delivery)` }))} {...form.bind("commissionTierId")} />
            </FormRow>
            <MultiCheck label="Cuisines" cols={4} options={cuisines.map((c) => ({ value: c.id, label: c.name }))} value={v.cuisineIds} onChange={(x) => form.set("cuisineIds", x)} />
            <AddressFinder onPick={(a) => { setGeo({ lat: a.lat, lng: a.lng }); form.setValues((x) => ({ ...x, addressLine1: a.line1 || x.addressLine1, city: a.city || x.city, province: a.province || x.province, postalCode: a.postalCode || x.postalCode })); }} />
            <div className="text-sm fw-semibold mb-8">Map pin (click to place; zone is resolved automatically)</div>
            <LocationPicker value={geo} onChange={setGeo} height={260} />
            <div className="text-secondary-light text-xs mt-4">
              {geo.lat.toFixed(5)}, {geo.lng.toFixed(5)}
            </div>
          </Card>
        </div>
        <div className="col-lg-4">
          <Card title="Merchant" className="mb-24">
            <div className="mb-16">
              <Segmented value={mode} onChange={setMode} options={[{ value: "new", label: "New merchant" }, { value: "existing", label: "Existing" }]} />
            </div>
            {mode === "existing" ? (
              <Select label="Merchant" required options={merchants.map((m) => ({ value: m.id, label: m.businessName }))} {...form.bind("merchantId")} />
            ) : (
              <>
                <TextInput label="Business name" required {...form.bind("businessName")} />
                <TextInput label="Legal name" {...form.bind("legalName")} />
                <TextInput label="HST number" {...form.bind("hstNumber")} />
                <TextInput label="Contact email" type="email" {...form.bind("contactEmail")} />
                <TextInput label="Contact phone" {...form.bind("contactPhone")} />
              </>
            )}
          </Card>
          <Card title="Owner login (optional)" subtitle="A temporary password is shown once after creation">
            <TextInput label="Email" type="email" {...form.bind("ownerEmail")} />
            <TextInput label="First name" {...form.bind("ownerFirstName")} />
            <TextInput label="Last name" {...form.bind("ownerLastName")} />
            <TextInput label="Phone" {...form.bind("ownerPhone")} />
          </Card>
        </div>
      </div>
      <div className="d-flex gap-2 mt-24">
        <Button size="md" loading={busy} disabled={!valid} onClick={submit}>Create {v.storeType === "RESTAURANT" ? "restaurant" : "store"}</Button>
        <Button size="md" variant="light" onClick={() => nav("/restaurants")}>Cancel</Button>
      </div>
      <Modal open={!!created} onClose={() => nav(`/restaurants/${created.restaurant.id}`)} title="Restaurant created" footer={<Button onClick={() => nav(`/restaurants/${created.restaurant.id}`)}>Open restaurant</Button>}>
        <p>The owner account was created. Share this temporary password securely; it is not shown again.</p>
        <div className="p-12 radius-8 bg-neutral-200 fw-semibold font-monospace user-select-all">{created?.temporaryPassword}</div>
      </Modal>
    </>
  );
}
