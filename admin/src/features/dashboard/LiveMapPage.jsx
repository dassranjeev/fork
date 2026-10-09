import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Badge, Button, Card, EmptyState, ErrorState, Loading, MapView, Modal, PageHeader, Segmented, StatusBadge } from "../../ui";
import { http } from "../../lib/api";
import { useFetch, useSubmit } from "../../lib/hooks";
import { useAuth } from "../../lib/auth";
import { useSocketEvent } from "../../lib/socket";
import { fmtTime, money, num, timeAgo, titleCase } from "../../lib/format";
import { CityFilter } from "./shared";

const FLAG_COLOR = { NONE: "#22c55e", AMBER: "#eab308", RED: "#ef4444" };
const FLAG_TONE = { NONE: "success", AMBER: "warning", RED: "danger" };

function Legend() {
  const item = (c, t) => (
    <span className="d-inline-flex align-items-center gap-1 text-sm text-secondary-light me-3">
      <span style={{ width: 10, height: 10, borderRadius: "50%", background: c, display: "inline-block" }} />
      {t}
    </span>
  );
  return (
    <div className="mb-12">
      {item(FLAG_COLOR.NONE, "Order on track")}
      {item(FLAG_COLOR.AMBER, "Order delayed")}
      {item(FLAG_COLOR.RED, "Order very late / unassigned")}
      {item("#487fff", "Driver idle")}
      {item("#ff6917", "Driver on trip")}
      {item("#94a3b8", "Restaurant")}
    </div>
  );
}

export default function LiveMapPage() {
  const { can } = useAuth();
  const canEdit = can("operations", "edit");
  const [cityId, setCityId] = useState("");
  const [filter, setFilter] = useState("all");
  const [selectedId, setSelectedId] = useState(null);
  const [showRestaurants, setShowRestaurants] = useState(true);
  const [fit, setFit] = useState(true);
  const snap = useFetch("/admin/live-map", { cityId }, { refreshMs: 15000 });
  useSocketEvent(["order.new", "order.status", "dispatch.escalated", "dispatch.assigned"], () => snap.reload());

  // fit bounds only on first load / city change, not on every poll
  useEffect(() => setFit(true), [cityId]);
  useEffect(() => {
    if (fit && snap.data) {
      const t = setTimeout(() => setFit(false), 800);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [fit, snap.data]);

  const data = snap.data;
  const orders = useMemo(() => data?.orders || [], [data]);
  const drivers = useMemo(() => data?.drivers || [], [data]);
  const restaurants = useMemo(() => data?.restaurants || [], [data]);
  const selected = orders.find((o) => o.id === selectedId) || null;
  const driverById = useMemo(() => Object.fromEntries(drivers.map((d) => [d.id, d])), [drivers]);

  const shown = orders.filter((o) => {
    if (filter === "flagged") return o.flag !== "NONE";
    if (filter === "unassigned") return o.fulfilment === "PLATFORM_DRIVER" && !o.driverId;
    return true;
  });

  const markers = useMemo(() => {
    const m = [];
    if (showRestaurants)
      restaurants.forEach((r) => m.push({ id: `r-${r.id}`, lat: r.lat, lng: r.lng, kind: "dot", size: 12, color: "#94a3b8", title: r.name }));
    drivers.forEach((d) =>
      m.push({
        id: `d-${d.id}`,
        lat: d.lat,
        lng: d.lng,
        kind: "dot",
        size: 18,
        color: d.onTrip ? "#ff6917" : "#487fff",
        popup: (
          <div>
            <strong>{d.name}</strong>
            <div>{titleCase(d.vehicleType)} - {d.onTrip ? "On trip" : "Idle"}</div>
            <div>Rating {d.rating ?? "—"} | seen {timeAgo(d.lastLocationAt)}</div>
          </div>
        ),
      })
    );
    shown.forEach((o, i) => {
      const lat = o.restaurantLat ?? o.dropLat;
      const lng = o.restaurantLng ?? o.dropLng;
      if (lat == null) return;
      m.push({
        id: `o-${o.id}`,
        lat: lat + (i % 5) * 0.0002,
        lng: lng + (i % 3) * 0.0002,
        color: FLAG_COLOR[o.flag],
        glyph: o.id === selectedId ? "★" : "",
        size: o.id === selectedId ? 38 : 30,
        title: `${o.code} - ${titleCase(o.status)}`,
        onClick: () => setSelectedId(o.id),
      });
    });
    if (selected?.dropLat != null) m.push({ id: `drop-${selected.id}`, lat: selected.dropLat, lng: selected.dropLng, kind: "dot", size: 14, color: "#8b5cf6", title: "Drop-off" });
    return m;
  }, [restaurants, drivers, shown, showRestaurants, selected, selectedId]);

  const lines = useMemo(() => {
    if (!selected || selected.dropLat == null || selected.restaurantLat == null) return [];
    const pts = [[selected.restaurantLat, selected.restaurantLng], [selected.dropLat, selected.dropLng]];
    const drv = driverById[selected.driverId];
    return [{ id: "route", points: pts, color: "#8b5cf6", dashed: true }, ...(drv ? [{ id: "drv", points: [[drv.lat, drv.lng], pts[0]], color: "#487fff" }] : [])];
  }, [selected, driverById]);

  const counts = data?.counts || {};

  return (
    <>
      <PageHeader
        title="Live Operations Map"
        subtitle={data ? `Updated ${fmtTime(data.generatedAt)} - auto-refreshes every 15s` : "Active orders, drivers and restaurants"}
        actions={
          <>
            <CityFilter value={cityId} onChange={setCityId} />
            <Button variant="light" icon="solar:refresh-outline" onClick={snap.reload}>
              Refresh
            </Button>
          </>
        }
      />
      {snap.error && <ErrorState error={snap.error} onRetry={snap.reload} />}
      {snap.loading && !data ? (
        <Loading />
      ) : (
        <>
          <div className="row g-3 mb-16">
            {[
              ["Active orders", counts.orders, "primary"],
              ["Online drivers", counts.onlineDrivers, "info"],
              ["Drivers on trip", counts.driversOnTrip, "warning"],
              ["Unassigned", counts.unassigned, "danger"],
              ["Red flags", counts.redFlags, "danger"],
            ].map(([l, v, t]) => (
              <div className="col-6 col-md" key={l}>
                <div className="card radius-12 border-0 shadow-sm px-16 py-12">
                  <div className="text-secondary-light text-sm">{l}</div>
                  <h5 className={`mb-0 text-${t === "primary" ? "primary-600" : t + "-main"}`}>{num(v)}</h5>
                </div>
              </div>
            ))}
          </div>
          <Legend />
          <div className="row g-3">
            <div className="col-xl-8">
              <MapView markers={markers} lines={lines} height={640} fit={fit} zoom={12} />
              <div className="mt-2">
                <label className="text-sm text-secondary-light d-inline-flex align-items-center gap-2">
                  <input type="checkbox" checked={showRestaurants} onChange={(e) => setShowRestaurants(e.target.checked)} /> Show restaurants ({restaurants.length})
                </label>
              </div>
            </div>
            <div className="col-xl-4">
              <Card
                title={selected ? `Order ${selected.code}` : "Active orders"}
                noPadding
                actions={selected && <Button variant="light" onClick={() => setSelectedId(null)}>Back to list</Button>}
              >
                {selected ? (
                  <OrderPanel order={selected} driver={driverById[selected.driverId]} canEdit={canEdit} onChanged={snap.reload} />
                ) : (
                  <div>
                    <div className="p-16 border-bottom">
                      <Segmented
                        value={filter}
                        onChange={setFilter}
                        options={[
                          { value: "all", label: `All (${orders.length})` },
                          { value: "flagged", label: `Flagged (${orders.filter((o) => o.flag !== "NONE").length})` },
                          { value: "unassigned", label: "Unassigned" },
                        ]}
                      />
                    </div>
                    <div style={{ maxHeight: 540, overflowY: "auto" }}>
                      {shown.length === 0 && <EmptyState title="No orders" text="No active orders match this filter." />}
                      {shown.map((o) => (
                        <button key={o.id} type="button" onClick={() => setSelectedId(o.id)} className="w-100 text-start bg-transparent border-0 border-bottom px-16 py-12 d-block">
                          <div className="d-flex justify-content-between align-items-center gap-2">
                            <span className="fw-semibold">{o.code}</span>
                            <Badge tone={FLAG_TONE[o.flag]}>{o.flag === "NONE" ? "On track" : o.flag === "AMBER" ? "Delayed" : "Critical"}</Badge>
                          </div>
                          <div className="text-secondary-light text-sm">{o.restaurantName}</div>
                          <div className="d-flex gap-2 align-items-center mt-1 flex-wrap">
                            <StatusBadge status={o.status} />
                            {o.fulfilment === "PLATFORM_DRIVER" && !o.driverId && <Badge tone="danger">No driver</Badge>}
                            {o.minutesLate > 0 && <span className="text-danger-main text-sm">{o.minutesLate} min late</span>}
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </Card>
            </div>
          </div>
        </>
      )}
    </>
  );
}

function OrderPanel({ order, driver, canEdit, onChanged }) {
  const [candOpen, setCandOpen] = useState(false);
  const { busy, run } = useSubmit();
  const needsDriver = order.fulfilment === "PLATFORM_DRIVER";
  const kv = (l, v) => (
    <div className="d-flex justify-content-between gap-3 py-8 border-bottom">
      <span className="text-secondary-light text-sm">{l}</span>
      <span className="fw-medium text-sm text-end">{v ?? "—"}</span>
    </div>
  );
  return (
    <div className="p-20">
      <div className="d-flex gap-2 flex-wrap mb-12">
        <StatusBadge status={order.status} />
        <Badge tone={FLAG_TONE[order.flag]}>{order.flag}</Badge>
        {order.flagReasons?.map((r) => (
          <Badge key={r} tone="neutral">{titleCase(r)}</Badge>
        ))}
      </div>
      {kv("Restaurant", order.restaurantName)}
      {kv("Fulfilment", titleCase(order.fulfilment))}
      {kv("Driver", driver ? `${driver.name} (${titleCase(driver.vehicleType)})` : order.driverId ? "Assigned (offline)" : "Unassigned")}
      {kv("Ready ETA", fmtTime(order.estimatedReadyAt))}
      {kv("Delivery ETA", fmtTime(order.estimatedDeliveryAt))}
      {kv("Minutes late", order.minutesLate || 0)}
      {order.dispatch && kv("Dispatch", `${titleCase(order.dispatch.state)} - ${order.dispatch.widenings} widening(s), ${order.dispatch.radiusKm} km`)}
      <div className="d-flex flex-wrap gap-2 mt-16">
        <Link to={`/orders/${order.id}`} className="btn btn-sm btn-outline-neutral-300 text-primary-light radius-8">
          Open order
        </Link>
        {needsDriver && canEdit && (
          <Button icon="solar:user-plus-outline" onClick={() => setCandOpen(true)}>
            {order.driverId ? "Reassign driver" : "Assign driver"}
          </Button>
        )}
        {needsDriver && canEdit && !order.driverId && (
          <Button
            variant="light"
            loading={busy}
            onClick={() => run(() => http.post(`/admin/live-map/orders/${order.id}/start-dispatch`), { success: "Dispatch restarted", onDone: onChanged })}
          >
            Restart auto-dispatch
          </Button>
        )}
      </div>
      {candOpen && <CandidatesModal order={order} onClose={() => setCandOpen(false)} onDone={() => { setCandOpen(false); onChanged(); }} />}
    </div>
  );
}

function CandidatesModal({ order, onClose, onDone }) {
  const { data, loading, error, reload } = useFetch(`/admin/live-map/orders/${order.id}/candidates`, { limit: 15 });
  const { busy, run } = useSubmit();
  const reassign = !!order.driverId;
  const pick = (c) =>
    run(() => http.post(`/admin/live-map/orders/${order.id}/${reassign ? "reassign" : "assign"}`, { driverId: c.driverId }), {
      success: `${reassign ? "Reassigned" : "Assigned"} to ${c.name}`,
      onDone,
    });
  return (
    <Modal open onClose={onClose} title={`${reassign ? "Reassign" : "Assign"} driver - ${order.code}`} size="xl">
      {loading && <Loading />}
      {error && <ErrorState error={error} onRetry={reload} />}
      {data && data.length === 0 && <EmptyState title="No candidate drivers" />}
      {data && data.length > 0 && (
        <div className="table-responsive">
          <table className="table bordered-table sm-table mb-0 align-middle">
            <thead>
              <tr>
                <th>Driver</th>
                <th>Vehicle</th>
                <th>Distance</th>
                <th>ETA</th>
                <th>Est. pay</th>
                <th>Score</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.map((c) => (
                <tr key={c.driverId}>
                  <td>
                    <div className="fw-medium">{c.name}</div>
                    <div className="text-secondary-light text-xs">{c.phone}</div>
                  </td>
                  <td>{titleCase(c.vehicleType)}</td>
                  <td>{c.distanceKm} km</td>
                  <td>{c.etaMin} min</td>
                  <td>{money(c.estimatedPay)}</td>
                  <td>{Number(c.score).toFixed(1)}</td>
                  <td>
                    {c.eligible ? (
                      <Badge tone="success">Eligible</Badge>
                    ) : (
                      <span title={(c.reasons || []).join(", ")}>
                        <Badge tone="danger">{titleCase((c.reasons || ["Ineligible"])[0])}</Badge>
                      </span>
                    )}
                    {c.onTrip && <Badge tone="warning" className="ms-1">On trip</Badge>}
                  </td>
                  <td>
                    <Button variant={c.eligible ? "primary" : "light"} disabled={busy} onClick={() => pick(c)}>
                      {c.eligible ? "Select" : "Force"}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}
