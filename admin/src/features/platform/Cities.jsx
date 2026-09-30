import React from "react";
import { BoolBadge, FormRow, LocationPicker, NumberInput, Select, Switch, TextInput } from "../../ui";
import { money } from "../../lib/format";
import { CrudPage } from "./crud";

// [field, label, unit]
const GROUPS = [
  {
    title: "Customer fees",
    fields: [
      ["baseDeliveryFee", "Base delivery fee", "$"],
      ["perKmFee", "Per-km fee", "$"],
      ["serviceFeePct", "Service fee", "%"],
      ["serviceFeeCap", "Service fee cap", "$"],
      ["smallOrderThreshold", "Small-order threshold", "$"],
      ["smallOrderFee", "Small-order fee", "$"],
      ["busyMultiplier", "Busy multiplier", "x"],
    ],
  },
  {
    title: "Driver pay",
    fields: [
      ["driverBaseFare", "Base fare", "$"],
      ["driverPerKm", "Per km", "$"],
      ["driverPerWaitMin", "Per wait minute", "$"],
      ["driverFreeWaitMin", "Free wait (min)", "min"],
      ["driverMinPerTrip", "Minimum per trip", "$"],
      ["payoutReleaseThreshold", "Payout release threshold", "$"],
    ],
  },
  {
    title: "Dispatch",
    fields: [
      ["offerTimeoutSec", "Offer timeout", "sec"],
      ["offersBeforeWiden", "Offers before widening", ""],
      ["maxRadiusWidenings", "Max radius widenings", ""],
      ["radiusWidenStepKm", "Widen step", "km"],
      ["widenBoostAmount", "Widen boost", "$"],
      ["batchMaxOrders", "Batch: max orders", ""],
      ["batchMaxDropDistanceKm", "Batch: max drop distance", "km"],
      ["batchMaxExtraMinutes", "Batch: max extra minutes", "min"],
    ],
  },
  {
    title: "Order timers",
    fields: [
      ["autoRejectSeconds", "Auto-reject after", "sec"],
      ["pickupOverdueMin", "Pickup overdue", "min"],
      ["lateOnTheWayGraceMin", "Late on-the-way grace", "min"],
      ["veryLateMin", "Very late after", "min"],
    ],
  },
];
const NUM_FIELDS = GROUPS.flatMap((g) => g.fields.map((x) => x[0]));
const DEFAULTS = {
  name: "",
  province: "ON",
  country: "Canada",
  timezone: "America/Toronto",
  currency: "CAD",
  active: true,
  centerLat: 43.589,
  centerLng: -79.6441,
  baseDeliveryFee: 1.99,
  perKmFee: 0.5,
  serviceFeePct: 10,
  serviceFeeCap: 5,
  smallOrderThreshold: 15,
  smallOrderFee: 2,
  busyMultiplier: 1,
  driverBaseFare: 3,
  driverPerKm: 0.6,
  driverPerWaitMin: 0.25,
  driverFreeWaitMin: 5,
  driverMinPerTrip: 4.5,
  offerTimeoutSec: 30,
  offersBeforeWiden: 3,
  maxRadiusWidenings: 2,
  radiusWidenStepKm: 2,
  widenBoostAmount: 2,
  batchMaxOrders: 2,
  batchMaxDropDistanceKm: 1.5,
  batchMaxExtraMinutes: 10,
  autoRejectSeconds: 180,
  pickupOverdueMin: 10,
  lateOnTheWayGraceMin: 10,
  veryLateMin: 30,
  payoutReleaseThreshold: 250,
};

export default function Cities() {
  return (
    <CrudPage
      title="Cities"
      subtitle="City-level pricing, driver pay and dispatch settings. Zones can override fees."
      path="/admin/cities"
      module="zones"
      itemName="city"
      modalSize="xl"
      initial={DEFAULTS}
      searchPlaceholder="Search cities…"
      filterDefs={[{ name: "active", placeholder: "All statuses", options: [{ value: "true", label: "Active" }, { value: "false", label: "Inactive" }] }]}
      canDelete={(r) => !r.zoneCount && !r.restaurantCount}
      columns={[
        {
          key: "name",
          title: "City",
          render: (r) => (
            <div>
              <div className="fw-semibold">{r.name}</div>
              <div className="text-secondary-light text-xs">
                {r.province}, {r.country} · {r.timezone}
              </div>
            </div>
          ),
        },
        { key: "zoneCount", title: "Zones" },
        { key: "restaurantCount", title: "Restaurants" },
        { key: "baseDeliveryFee", title: "Delivery fee", render: (r) => `${money(r.baseDeliveryFee)} + ${money(r.perKmFee)}/km` },
        { key: "serviceFeePct", title: "Service fee", render: (r) => `${r.serviceFeePct}% (cap ${money(r.serviceFeeCap)})` },
        { key: "driverBaseFare", title: "Driver base", render: (r) => `${money(r.driverBaseFare)} + ${money(r.driverPerKm)}/km` },
        { key: "active", title: "Status", render: (r) => <BoolBadge value={r.active} yes="Active" no="Inactive" /> },
      ]}
      toPayload={(v) => {
        const b = {
          name: v.name,
          province: v.province,
          country: v.country,
          timezone: v.timezone,
          currency: v.currency,
          active: !!v.active,
          centerLat: Number(v.centerLat),
          centerLng: Number(v.centerLng),
        };
        NUM_FIELDS.forEach((k) => {
          if (v[k] !== "" && v[k] !== null && v[k] !== undefined) b[k] = Number(v[k]);
        });
        return b;
      }}
      renderForm={({ f }) => (
        <>
          <h6 className="text-md mb-12">General</h6>
          <FormRow>
            <TextInput col={4} label="Name" required {...f.bind("name")} />
            <TextInput col={2} label="Province" {...f.bind("province")} />
            <TextInput col={2} label="Country" {...f.bind("country")} />
            <TextInput col={2} label="Timezone" {...f.bind("timezone")} />
            <Select col={2} label="Currency" allowEmpty={false} options={["CAD", "USD"]} {...f.bind("currency")} />
          </FormRow>
          <div className="row">
            <div className="col-md-8 mb-16">
              <label className="form-label fw-semibold text-primary-light text-sm mb-8">Centre (click the map)</label>
              <LocationPicker
                height={240}
                value={{ lat: Number(f.values.centerLat), lng: Number(f.values.centerLng) }}
                onChange={({ lat, lng }) => {
                  f.set("centerLat", Number(lat.toFixed(5)));
                  f.set("centerLng", Number(lng.toFixed(5)));
                }}
              />
            </div>
            <div className="col-md-4">
              <NumberInput label="Latitude" {...f.bind("centerLat")} />
              <NumberInput label="Longitude" {...f.bind("centerLng")} />
              <Switch label="Active" hint="Inactive cities are hidden from customers." {...f.bindCheck("active")} />
            </div>
          </div>
          {GROUPS.map((g) => (
            <div key={g.title} className="mb-8">
              <h6 className="text-md mb-12 mt-8">{g.title}</h6>
              <FormRow>
                {g.fields.map(([k, label, unit]) => (
                  <NumberInput key={k} col={3} label={label} prefix={unit === "$" ? "$" : undefined} suffix={unit && unit !== "$" ? unit : undefined} {...f.bind(k)} />
                ))}
              </FormRow>
            </div>
          ))}
        </>
      )}
    />
  );
}
