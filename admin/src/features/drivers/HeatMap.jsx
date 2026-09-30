import React, { useMemo } from "react";
import { Card, DataTable, ErrorState, Loading, MapView, PageHeader } from "../../ui";
import { useFetch } from "../../lib/hooks";

const colorFor = (z) => (z.onlineDrivers === 0 && z.openOrders > 0 ? "#ef4444" : z.demandScore >= 50 ? "#ef4444" : z.demandScore >= 5 ? "#f59e0b" : "#22c55e");

export default function HeatMap() {
  const { data, loading, error, reload } = useFetch("/admin/drivers/heat-map", null, { refreshMs: 20000 });
  const zones = useMemo(() => (Array.isArray(data) ? data : []), [data]);
  const markers = zones.map((z) => ({
    id: z.zoneId,
    lat: z.centerLat,
    lng: z.centerLng,
    color: colorFor(z),
    glyph: String(z.openOrders),
    popup: (
      <div>
        <strong>{z.zoneName}</strong>
        <div>Online drivers: {z.onlineDrivers}</div>
        <div>On trip: {z.onTripDrivers}</div>
        <div>Open orders: {z.openOrders}</div>
        <div>Demand score: {z.demandScore}</div>
      </div>
    ),
  }));
  return (
    <>
      <PageHeader title="Demand heat map" subtitle="Live zone supply vs demand (refreshes every 20 s). Pin number = open orders; red = under-supplied." crumbs={[{ label: "Drivers", to: "/drivers" }, { label: "Heat map" }]} />
      {error && <ErrorState error={error} onRetry={reload} />}
      {loading && !data ? (
        <Loading />
      ) : (
        <div className="row gy-4">
          <div className="col-xl-7">
            <MapView markers={markers} height={520} />
          </div>
          <div className="col-xl-5">
            <Card title="Zones" noPadding bodyClassName="p-0">
              <DataTable
                dense
                rowKey="zoneId"
                rows={[...zones].sort((a, b) => b.demandScore - a.demandScore)}
                emptyTitle="No zones"
                columns={[
                  { key: "zoneName", title: "Zone" },
                  { key: "onlineDrivers", title: "Online", align: "right" },
                  { key: "openOrders", title: "Orders", align: "right" },
                  { key: "demandScore", title: "Demand", align: "right", render: (z) => <span style={{ color: colorFor(z), fontWeight: 600 }}>{z.demandScore}</span> },
                ]}
              />
            </Card>
          </div>
        </div>
      )}
    </>
  );
}
