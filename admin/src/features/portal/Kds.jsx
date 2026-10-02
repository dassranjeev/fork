import React, { useState } from "react";
import { Icon } from "@iconify/react/offline";
import { Badge, Button, ErrorState, Loading, Progress } from "../../ui";
import { useLocalState } from "../../lib/hooks";
import { minutesBetween } from "../../lib/format";
import { PortalPage, modifierText, useAction, useApi, usePortalFetch, useRealtimeReload, useTick } from "./shared";

const COLS = [
  { key: "NEW", title: "New", icon: "solar:bell-bing-outline", head: "#dc2626" },
  { key: "PREPARING", title: "Preparing", icon: "solar:chef-hat-outline", head: "#f59e0b" },
  { key: "READY", title: "Ready", icon: "solar:check-circle-outline", head: "#16a34a" },
  { key: "PICKED_UP", title: "Picked up", icon: "solar:delivery-outline", head: "#6b7280" },
];

const NEXT = { NEW: "PREPARING", PREPARING: "READY", READY: "NEW" };
const ITEM_ICON = { NEW: "solar:stop-circle-outline", PREPARING: "solar:play-circle-bold", READY: "solar:check-circle-bold" };
const ITEM_COLOR = { NEW: "#9ca3af", PREPARING: "#f59e0b", READY: "#16a34a" };

/** green -> amber -> red based on time left until the promised ready time */
function timerTone(mins) {
  if (mins === null) return { bg: "#6b7280", label: "" };
  if (mins < 0) return { bg: "#dc2626" };
  if (mins <= 5) return { bg: "#f59e0b" };
  return { bg: "#16a34a" };
}

function Ticket({ t, col, large, onChanged }) {
  const api = useApi();
  const { run, isBusy } = useAction();
  const due = t.estimatedReadyAt ? Math.round((new Date(t.estimatedReadyAt).getTime() - Date.now()) / 60000) : null;
  const elapsed = t.acceptedAt ? minutesBetween(t.acceptedAt) : t.elapsedMin;
  const tone = col === "PICKED_UP" || col === "READY" ? { bg: "#6b7280" } : timerTone(due);
  const go = async (key, path, body, msg) => {
    const r = await run(key, () => api.post(path, body), msg);
    if (r.ok) onChanged();
  };
  return (
    <div className="card radius-12 shadow-sm mb-12 border-0">
      <div className="d-flex justify-content-between align-items-center px-16 py-8 radius-12" style={{ background: tone.bg, color: "#fff", borderBottomLeftRadius: 0, borderBottomRightRadius: 0 }}>
        <span className="fw-bold" style={{ fontSize: large ? 22 : 16 }}>{t.code}</span>
        <span className="fw-semibold" style={{ fontSize: large ? 18 : 14 }}>
          {col === "PICKED_UP" || col === "READY" ? `${elapsed ?? 0} min` : due === null ? `${elapsed ?? 0} min` : due < 0 ? `${-due} min late` : `${due} min left`}
        </span>
      </div>
      <div className="card-body p-16" style={{ fontSize: large ? 20 : 15 }}>
        <div className="text-secondary-light mb-8" style={{ fontSize: 12 }}>
          {t.fulfilment === "PICKUP" ? "Pickup" : "Delivery"} · {elapsed ?? 0} min since accepted
        </div>
        <ul className="list-unstyled mb-0">
          {t.items.map((it) => (
            <li key={it.id} className="d-flex align-items-start gap-2 py-6 border-bottom">
              <button
                type="button"
                className="btn p-0 border-0 bg-transparent flex-shrink-0"
                title={`Mark ${NEXT[it.kitchenStatus] || "NEW"}`}
                disabled={isBusy(it.id) || col === "PICKED_UP"}
                onClick={() => go(it.id, `/restaurant/kds/items/${it.id}/status`, { status: NEXT[it.kitchenStatus] || "NEW" })}
              >
                <Icon icon={ITEM_ICON[it.kitchenStatus] || ITEM_ICON.NEW} style={{ color: ITEM_COLOR[it.kitchenStatus] || ITEM_COLOR.NEW, fontSize: large ? 32 : 26 }} />
              </button>
              <div>
                <span className="fw-bold">{it.quantity}×</span> {it.name}
                {it.modifiers?.length > 0 && <div className="text-secondary-light" style={{ fontSize: "0.8em" }}>{modifierText(it.modifiers)}</div>}
                {it.notes && <div className="text-warning-main" style={{ fontSize: "0.8em" }}>Note: {it.notes}</div>}
              </div>
            </li>
          ))}
        </ul>
        <div className="d-flex gap-2 mt-12">
          {col === "NEW" && (
            <Button size="md" variant="warning" className="flex-fill justify-content-center" loading={isBusy("start")} onClick={() => go("start", `/restaurant/kds/${t.id}/start`, undefined, "Started")}>
              Start
            </Button>
          )}
          {col === "PREPARING" && (
            <Button size="md" variant="success" className="flex-fill justify-content-center" loading={isBusy("ready")} onClick={() => go("ready", `/restaurant/kds/${t.id}/ready`, undefined, `${t.code} ready`)}>
              Ready
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function Kds() {
  const [station, setStation] = useState("");
  const [large, setLarge] = useLocalState("portal.kds.large", false);
  const stations = usePortalFetch("/restaurant/store/stations");
  const board = usePortalFetch("/restaurant/kds/board", { stationId: station || undefined }, { refreshMs: 10000 });
  const api = useApi();
  const { run, isBusy } = useAction();
  useRealtimeReload(() => board.reload());
  useTick(20000);

  const bump = async () => {
    const r = await run("bump", () => api.post("/restaurant/kds/bump", { stationId: station || undefined }), "Station bumped");
    if (r.ok) board.reload();
  };
  const d = board.data;

  return (
    <PortalPage
      title="Kitchen display"
      actions={
        <>
          <select className="form-select form-select-sm radius-8 h-40-px w-auto" value={station} onChange={(e) => setStation(e.target.value)} aria-label="Station">
            <option value="">All stations</option>
            {(stations.data || []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          {station && (
            <Button variant="outline" loading={isBusy("bump")} onClick={bump}>
              Bump station
            </Button>
          )}
          <Button variant="outline" icon="solar:text-field-focus-outline" onClick={() => setLarge(!large)}>
            {large ? "Normal text" : "Large text"}
          </Button>
          <Button variant="outline" icon="solar:maximize-square-outline" onClick={() => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.()}>
            Fullscreen
          </Button>
        </>
      }
    >
      {board.error && !d && <ErrorState error={board.error} onRetry={board.reload} />}
      {board.loading && !d && <Loading />}
      {d && (
        <>
          <div className="d-flex align-items-center gap-3 mb-16" style={{ maxWidth: 420 }}>
            <span className="text-sm fw-semibold text-nowrap">Kitchen load</span>
            <div className="flex-grow-1">
              <Progress value={Math.round((d.load || 0) * 100)} tone={d.load > 0.85 ? "danger" : d.load > 0.6 ? "warning" : "success"} />
            </div>
            <Badge tone="neutral">{Math.round((d.load || 0) * 100)}% of {d.capacityTickets}</Badge>
          </div>
          <div className="row g-3">
            {COLS.map((c) => {
              const list = d.columns[c.key] || [];
              return (
                <div key={c.key} className="col-xl-3 col-md-6">
                  <div className="d-flex align-items-center justify-content-between px-16 py-8 radius-8 mb-12 text-white" style={{ background: c.head }}>
                    <span className="fw-semibold d-flex align-items-center gap-2">
                      <Icon icon={c.icon} className="text-xl" /> {c.title}
                    </span>
                    <span className="fw-bold">{list.length}</span>
                  </div>
                  {list.length === 0 ? (
                    <div className="text-center text-secondary-light text-sm py-32 border radius-12" style={{ borderStyle: "dashed" }}>
                      Nothing here
                    </div>
                  ) : (
                    list.map((t) => <Ticket key={t.id} t={t} col={c.key} large={large} onChanged={board.reload} />)
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </PortalPage>
  );
}
