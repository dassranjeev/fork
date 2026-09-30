import React from "react";
import { Link } from "react-router-dom";
import { Badge, Button, Card, StatCard, StatusBadge } from "../../ui";
import { fmtTime, money, titleCase } from "../../lib/format";
import { Async, PortalPage, useAction, useApi, usePortalFetch, useRealtimeReload } from "./shared";
import { usePortal } from "./context";

function StoreControls({ data, reload }) {
  const api = useApi();
  const { role, reloadLocations } = usePortal();
  const { run, isBusy } = useAction();
  const r = data.restaurant;
  const canControl = role !== "KITCHEN";
  const live = r.status === "LIVE";
  const paused = r.pausedUntil && new Date(r.pausedUntil) > new Date();
  const go = async (key, fn, msg) => {
    const res = await run(key, fn, msg);
    if (res.ok) {
      reload();
      reloadLocations();
    }
  };
  return (
    <Card title="Store status" subtitle="Control whether customers can order right now">
      <div className="d-flex flex-wrap align-items-center gap-3 mb-20">
        <StatusBadge status={r.status} />
        <Badge tone={data.open?.open ? "success" : "warning"}>{data.open?.open ? "Open now" : "Closed"}</Badge>
        {data.open?.closesAt && data.open.open && <span className="text-secondary-light text-sm">closes {fmtTime(data.open.closesAt)}</span>}
        {data.open?.opensAt && !data.open.open && <span className="text-secondary-light text-sm">opens {fmtTime(data.open.opensAt)}</span>}
        {!r.acceptingOrders && live && <Badge tone="danger">Not accepting orders</Badge>}
        {paused && <Badge tone="warning">Paused until {fmtTime(r.pausedUntil)}</Badge>}
        {r.busyExtraPrepMin > 0 && <Badge tone="warning">Busy +{r.busyExtraPrepMin} min</Badge>}
      </div>
      {!live && <div className="alert alert-warning radius-8 text-sm">This location is {titleCase(r.status)}, so order controls are unavailable.</div>}
      {canControl && live && (
        <>
          <div className="d-flex flex-wrap gap-2 mb-16">
            {r.acceptingOrders ? (
              <Button variant="outline-danger" size="md" icon="solar:pause-circle-outline" loading={isBusy("acc")} onClick={() => go("acc", () => api.patch("/restaurant/store/accepting", { accepting: false }), "Orders paused")}>
                Stop accepting orders
              </Button>
            ) : (
              <Button variant="success" size="md" icon="solar:play-circle-outline" loading={isBusy("acc")} onClick={() => go("acc", () => api.patch("/restaurant/store/accepting", { accepting: true }), "Now accepting orders")}>
                Start accepting orders
              </Button>
            )}
          </div>
          <div className="text-sm fw-semibold mb-8">Busy mode</div>
          <div className="d-flex flex-wrap gap-2">
            {[10, 20, 30].map((m) => (
              <Button key={m} variant="outline" loading={isBusy(`p${m}`)} onClick={() => go(`p${m}`, () => api.post("/restaurant/store/busy", { extraPrepMin: m }), `Prep times +${m} min`)}>
                +{m} min prep
              </Button>
            ))}
            {[15, 30, 60].map((m) => (
              <Button key={m} variant="outline" loading={isBusy(`z${m}`)} onClick={() => go(`z${m}`, () => api.post("/restaurant/store/busy", { pauseMinutes: m }), `Paused for ${m} min`)}>
                Pause {m} min
              </Button>
            ))}
            {(r.busyExtraPrepMin > 0 || paused) && (
              <Button variant="outline" loading={isBusy("clr")} onClick={() => go("clr", () => api.post("/restaurant/store/busy/clear"), "Busy mode cleared")}>
                Clear
              </Button>
            )}
          </div>
        </>
      )}
    </Card>
  );
}

export default function Dashboard() {
  const state = usePortalFetch("/restaurant/dashboard", null, { refreshMs: 30000 });
  useRealtimeReload(() => state.reload());
  const { role, isManager } = usePortal();
  return (
    <PortalPage title="Dashboard" subtitle={undefined}>
      <Async state={state}>
        {(d) => (
          <>
            <div className="row gy-4 mb-24">
              <div className="col-xl-3 col-sm-6">
                <StatCard label="Orders today" value={d.today.orders} icon="solar:bag-check-outline" tone="primary" />
              </div>
              <div className="col-xl-3 col-sm-6">
                <StatCard label="Sales today" value={money(d.today.sales)} icon="solar:wallet-money-outline" tone="success" />
              </div>
              <div className="col-xl-3 col-sm-6">
                <StatCard label="Waiting to accept" value={d.today.pendingAccept} icon="solar:bell-bing-outline" tone={d.today.pendingAccept ? "danger" : "info"} to="/portal/orders" />
              </div>
              <div className="col-xl-3 col-sm-6">
                <StatCard label="In kitchen" value={d.today.inKitchen} icon="solar:chef-hat-outline" tone="warning" hint={`${d.today.ready} ready · ${d.today.late} late`} to="/portal/kds" />
              </div>
            </div>
            <div className="row gy-4">
              <div className="col-lg-7">
                <StoreControls data={d} reload={state.reload} />
              </div>
              <div className="col-lg-5">
                <Card title="Rating" className="mb-24">
                  <div className="d-flex align-items-baseline gap-3">
                    <h3 className="mb-0">{d.restaurant.rating ? Number(d.restaurant.rating).toFixed(1) : "—"}</h3>
                    <span className="text-secondary-light">{d.restaurant.ratingCount} reviews · reliability {d.restaurant.reliabilityScore}%</span>
                  </div>
                </Card>
                {isManager && d.documentChecklist && (
                  <Card title="Documents" subtitle={`${d.documentChecklist.approved} of ${d.documentChecklist.total} approved`}>
                    <ul className="list-unstyled mb-0">
                      {d.documentChecklist.items.map((it) => (
                        <li key={it.type} className="d-flex justify-content-between align-items-center py-8 border-bottom">
                          <span className="text-sm">{titleCase(it.type)}</span>
                          <StatusBadge status={it.status} />
                        </li>
                      ))}
                    </ul>
                  </Card>
                )}
                {!isManager && (
                  <Card title="Quick links">
                    <div className="d-flex flex-wrap gap-2">
                      <Link to="/portal/orders" className="btn btn-outline-primary-600 radius-8">Live orders</Link>
                      <Link to="/portal/kds" className="btn btn-outline-primary-600 radius-8">Kitchen display</Link>
                      {role !== "KITCHEN" && <Link to="/portal/menu" className="btn btn-outline-primary-600 radius-8">86 an item</Link>}
                    </div>
                  </Card>
                )}
              </div>
            </div>
          </>
        )}
      </Async>
    </PortalPage>
  );
}
