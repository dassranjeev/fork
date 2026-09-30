import React, { useState } from "react";
import { http } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useFetch, useSubmit } from "../../lib/hooks";
import { fmtTime, num, timeAgo } from "../../lib/format";
import { Badge, BarChart, Button, Card, EmptyState, ErrorState, FilterSelect, Loading, PageHeader, StatCard, useConfirm } from "../../ui";
import { useCityOptions } from "./crud";

const STATUS_TONE = { OK: "success", SHORT: "warning", CRITICAL: "danger", SURPLUS: "info" };

function ZoneCard({ z, onChanged }) {
  const { can } = useAuth();
  const confirm = useConfirm();
  const { busy, run } = useSubmit();
  const enableBusy = async () => {
    const r = await confirm({ title: `Enable busy mode in ${z.zone}?`, message: "Raises the delivery fee multiplier and/or shrinks the radius to slow demand.", confirmText: "Enable busy mode" });
    if (r.confirmed) run(() => http.post(`/admin/zones/${z.zoneId}/busy-mode`, { enabled: true, reason: "Enabled from supply/demand forecast" }), { success: "Busy mode enabled", onDone: onChanged });
  };
  const disableBusy = () => run(() => http.post(`/admin/zones/${z.zoneId}/busy-mode`, { enabled: false }), { success: "Busy mode disabled", onDone: onChanged });
  const pctOnline = z.targetDrivers ? Math.min(100, (z.onlineDrivers / z.targetDrivers) * 100) : 100;
  return (
    <Card
      className="h-100"
      title={
        <span className="d-inline-flex align-items-center gap-2">
          {z.zone} <Badge tone={STATUS_TONE[z.status] || "neutral"}>{z.status}</Badge>
          {z.busyMode && <Badge tone="warning">Busy mode</Badge>}
        </span>
      }
      actions={
        can("zones", "edit") &&
        (z.busyMode ? (
          <Button variant="light" loading={busy} onClick={disableBusy}>Busy off</Button>
        ) : (
          <Button variant={z.suggestBusyMode ? "warning" : "light"} loading={busy} onClick={enableBusy}>
            {z.suggestBusyMode ? "Suggested: busy mode" : "Busy mode"}
          </Button>
        ))
      }
    >
      <div className="row text-center gy-2 mb-16">
        {[
          ["Online", `${z.onlineDrivers}/${z.targetDrivers}`],
          ["Idle", z.idleDrivers],
          ["On trip", z.onTripDrivers],
          ["Open orders", z.openOrders],
          ["Unassigned", z.unassignedOrders],
          ["Late", z.lateOrders],
        ].map(([l, v]) => (
          <div className="col-4" key={l}>
            <div className="fw-bold text-lg">{v}</div>
            <div className="text-secondary-light text-xs">{l}</div>
          </div>
        ))}
      </div>
      <div className="progress mb-16" style={{ height: 6 }} title={`${pctOnline.toFixed(0)}% of target drivers online`}>
        <div className={`progress-bar bg-${z.status === "OK" || z.status === "SURPLUS" ? "success-main" : z.status === "SHORT" ? "warning-main" : "danger-main"}`} style={{ width: `${pctOnline}%` }} />
      </div>
      {z.alerts?.length > 0 && (
        <ul className="ps-3 text-sm text-warning-main mb-16">
          {z.alerts.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
      )}
      <table className="table table-sm mb-0 text-sm">
        <thead>
          <tr>
            <th>Next hours</th>
            <th>Expected orders</th>
            <th>Drivers needed</th>
          </tr>
        </thead>
        <tbody>
          {z.forecast.map((h) => (
            <tr key={h.hourStart}>
              <td>{fmtTime(h.hourStart)}</td>
              <td>{num(h.expectedOrders, 1)}</td>
              <td className={h.driversNeeded > z.onlineDrivers ? "text-danger-main fw-semibold" : ""}>{h.driversNeeded}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="text-secondary-light text-xs mt-2">Orders last hour: {z.ordersLastHour} · gap to target: {z.driverGap}</div>
    </Card>
  );
}

export default function Supply() {
  const { options } = useCityOptions();
  const [cityId, setCityId] = useState("");
  const { data, loading, error, reload } = useFetch("/admin/operations/supply", { cityId: cityId || undefined }, { refreshMs: 30000 });
  const zones = data?.zones ?? [];
  return (
    <>
      <PageHeader
        title="Supply & Demand"
        subtitle="Live driver supply against open orders, with a 3-hour forecast per zone (auto-refreshes every 30s)."
        crumbs={[{ label: "Supply & demand" }]}
        actions={
          <>
            <FilterSelect value={cityId} onChange={setCityId} options={options} placeholder="All cities" />
            <Button variant="light" icon="solar:refresh-outline" onClick={reload}>Refresh</Button>
          </>
        }
      />
      {error && <ErrorState error={error} onRetry={reload} />}
      {loading && !data && <Loading />}
      {data && (
        <>
          <div className="row gy-3 mb-24">
            <div className="col-md-3 col-6"><StatCard label="Online drivers" value={data.totals.onlineDrivers} icon="solar:scooter-outline" tone="success" /></div>
            <div className="col-md-3 col-6"><StatCard label="Open orders" value={data.totals.openOrders} icon="solar:bag-3-outline" tone="info" /></div>
            <div className="col-md-3 col-6"><StatCard label="Unassigned orders" value={data.totals.unassignedOrders} icon="solar:danger-circle-outline" tone={data.totals.unassignedOrders ? "danger" : "success"} /></div>
            <div className="col-md-3 col-6"><StatCard label="Zones needing attention" value={data.alerts?.length ?? 0} icon="solar:bell-bing-outline" tone="warning" hint={`${data.ordersPerDriverHour} orders/driver/hr · ${timeAgo(data.generatedAt)}`} /></div>
          </div>
          {zones.length > 1 && (
            <Card title="Drivers online vs target" className="mb-24">
              <BarChart
                height={240}
                categories={zones.map((z) => z.zone)}
                series={[
                  { name: "Online", data: zones.map((z) => z.onlineDrivers) },
                  { name: "Target", data: zones.map((z) => z.targetDrivers) },
                  { name: "Open orders", data: zones.map((z) => z.openOrders) },
                ]}
              />
            </Card>
          )}
          {zones.length === 0 ? (
            <Card><EmptyState title="No zones" text="Create zones to see supply and demand." /></Card>
          ) : (
            <div className="row gy-3">
              {zones.map((z) => (
                <div className="col-xl-4 col-md-6" key={z.zoneId}>
                  <ZoneCard z={z} onChanged={reload} />
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}
