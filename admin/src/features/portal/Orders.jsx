import React, { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react/offline";
import { Badge, Button, DataTable, ErrorState, FilterSelect, FormModal, ListToolbar, Loading, Modal, Segmented, Select, StatusBadge, TextArea, TextInput, Timeline, useConfirm } from "../../ui";
import { fmtDateTime, fmtTime, money, ORDER_STATUSES, titleCase } from "../../lib/format";
import { errorMessage, http } from "../../lib/api";
import { usePagedList } from "../../lib/hooks";
import { ORDER_TYPE_LABEL, PortalPage, modifierText, useAction, useApi, usePortalFetch, useRealtimeReload, useTick } from "./shared";
import { usePortal } from "./context";

const COLUMNS = [
  { key: "new", title: "New", statuses: ["PLACED"], tone: "danger", icon: "solar:bell-bing-outline" },
  { key: "kitchen", title: "In kitchen", statuses: ["ACCEPTED", "DRIVER_ASSIGNED", "PREPARING"], tone: "warning", icon: "solar:chef-hat-outline" },
  { key: "ready", title: "Ready", statuses: ["READY"], tone: "success", icon: "solar:check-circle-outline" },
  { key: "out", title: "Out / collected", statuses: ["PICKED_UP", "ON_THE_WAY"], tone: "primary", icon: "solar:delivery-outline" },
];

const REJECT_REASONS = [
  { value: "BUSY", label: "Too busy" },
  { value: "ITEM_UNAVAILABLE", label: "Item unavailable" },
  { value: "CLOSING", label: "Closing soon" },
  { value: "OTHER", label: "Other" },
];

function beep() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    [880, 660, 880].forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = f;
      o.connect(g);
      g.connect(ctx.destination);
      g.gain.value = 0.15;
      o.start(ctx.currentTime + i * 0.22);
      o.stop(ctx.currentTime + i * 0.22 + 0.15);
    });
  } catch {
    /* audio blocked */
  }
}

/** Loads open orders + their items (the list endpoint has no items). */
function useLiveOrders() {
  const { restaurantId } = usePortal();
  const [orders, setOrders] = useState(null);
  const [error, setError] = useState(null);
  const cache = useRef(new Map());
  const seen = useRef(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    if (!restaurantId) return;
    const id = ++seq.current;
    try {
      const list = await http.get("/restaurant/orders", { restaurantId, limit: 100 });
      const rows = list.data || [];
      const full = await Promise.all(
        rows.map(async (o) => {
          const key = `${o.id}:${o.updatedAt}`;
          if (cache.current.has(key)) return cache.current.get(key);
          try {
            const d = await http.get(`/restaurant/orders/${o.id}`, { restaurantId });
            const merged = { ...o, ...d.order };
            cache.current.set(key, merged);
            return merged;
          } catch {
            return o;
          }
        })
      );
      if (id !== seq.current) return;
      const newIds = full.filter((o) => o.status === "PLACED").map((o) => o.id);
      if (seen.current && newIds.some((x) => !seen.current.has(x))) beep();
      seen.current = new Set(newIds);
      setOrders(full);
      setError(null);
    } catch (e) {
      if (id === seq.current) setError(errorMessage(e));
    }
  }, [restaurantId]);

  useEffect(() => {
    setOrders(null);
    seen.current = null;
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, [load]);

  return { orders, error, reload: load };
}

function Countdown({ target, label, warnMin = 2 }) {
  if (!target) return null;
  const mins = Math.round((new Date(target).getTime() - Date.now()) / 60000);
  const tone = mins < 0 ? "danger" : mins <= warnMin ? "warning" : "success";
  return (
    <Badge tone={tone}>
      <Icon icon="solar:clock-circle-outline" className="me-1" />
      {label} {mins < 0 ? `${-mins} min late` : `${mins} min`}
    </Badge>
  );
}

function RejectModal({ order, onClose, onDone }) {
  const api = useApi();
  const { busy, run } = useAction();
  const [reason, setReason] = useState("BUSY");
  const [note, setNote] = useState("");
  if (!order) return null;
  const submit = async () => {
    const r = await run("reject", () => api.post(`/restaurant/orders/${order.id}/reject`, { reason, note: note || undefined }), `Order ${order.code} rejected`);
    if (r.ok) onDone();
  };
  return (
    <FormModal open onClose={onClose} title={`Reject ${order.code}`} onSubmit={submit} busy={!!busy} submitText="Reject order" submitVariant="danger">
      <Select label="Reason" value={reason} onChange={setReason} options={REJECT_REASONS} allowEmpty={false} />
      <TextArea label="Note (optional)" value={note} onChange={setNote} rows={2} />
      <p className="text-secondary-light text-sm mb-0">The customer is notified and the payment authorisation is released.</p>
    </FormModal>
  );
}

function HandoffModal({ order, onClose, onDone }) {
  const api = useApi();
  const { busy, run } = useAction();
  const [code, setCode] = useState("");
  if (!order) return null;
  const submit = async () => {
    const r = await run("handoff", () => api.post(`/restaurant/orders/${order.id}/handoff`, { code: code.trim() }), `Order ${order.code} handed off`);
    if (r.ok) onDone();
  };
  return (
    <FormModal open onClose={onClose} title={`Hand off ${order.code}`} onSubmit={submit} busy={!!busy} submitText="Confirm handoff" disabled={!code.trim()}>
      <TextInput label={order.type === "PICKUP" ? "Customer pickup code" : "Driver pickup code"} value={code} onChange={setCode} autoFocus placeholder="Enter the code" />
    </FormModal>
  );
}

export function OrderItems({ order, onRemove, removing }) {
  const active = (order.items || []).filter((x) => !x.removed).length;
  return (
    <ul className="list-unstyled mb-0">
      {(order.items || []).length === 0 && <li className="text-secondary-light text-sm py-6">No item lines on this order</li>}
      {(order.items || []).map((it) => (
        <li key={it.id} className="d-flex justify-content-between align-items-start gap-2 py-6 border-bottom">
          <div className={it.removed ? "text-decoration-line-through text-secondary-light" : ""}>
            <span className="fw-semibold">{it.quantity}×</span> {it.name}
            {it.modifiers?.length > 0 && <div className="text-secondary-light text-xs">{modifierText(it.modifiers)}</div>}
            {it.notes && <div className="text-warning-main text-xs">Note: {it.notes}</div>}
          </div>
          <div className="d-flex align-items-center gap-2 flex-shrink-0">
            <span className="text-sm text-secondary-light">{money(it.lineTotal)}</span>
            {onRemove && !it.removed && active > 1 && ["PLACED", "ACCEPTED", "PREPARING", "DRIVER_ASSIGNED"].includes(order.status) && (
              <button type="button" className="btn btn-sm p-0 border-0 text-danger-600" title="Item unavailable - remove from order" disabled={removing} onClick={() => onRemove(it)}>
                <Icon icon="solar:trash-bin-minimalistic-outline" className="text-lg" />
              </button>
            )}
            {it.removed && <Badge tone="danger">Removed</Badge>}
          </div>
        </li>
      ))}
    </ul>
  );
}

function OrderCard({ order, reload }) {
  const api = useApi();
  const confirm = useConfirm();
  const { run, isBusy } = useAction();
  const [reject, setReject] = useState(false);
  const [handoff, setHandoff] = useState(false);
  const s = order.status;
  const act = async (key, path, body, msg) => {
    const r = await run(key, () => api.post(`/restaurant/orders/${order.id}/${path}`, body), msg);
    if (r.ok) reload();
  };
  const removeItem = async (it) => {
    const r = await confirm({
      title: `Remove ${it.name}?`,
      message: "The customer is asked to approve the change and is refunded for this item.",
      danger: true,
      confirmText: "Remove item",
      prompt: { label: "Reason", type: "text", defaultValue: "Out of stock" },
    });
    if (!r.confirmed) return;
    const res = await run("rm", () => api.post(`/restaurant/orders/${order.id}/items/${it.id}/remove`, { reason: r.value || undefined }), "Item removed");
    if (res.ok) reload();
  };
  const edge = s === "PLACED" ? "#dc2626" : s === "READY" ? "#16a34a" : "#eab308";

  return (
    <div className="card radius-12 shadow-sm mb-12" style={{ borderLeft: `4px solid ${edge}` }}>
      <div className="card-body p-16">
        <div className="d-flex justify-content-between align-items-start gap-2 mb-8">
          <div>
            <div className="fw-bold text-lg">{order.code}</div>
            <div className="text-secondary-light text-xs d-flex align-items-center gap-1">
              <Icon icon={order.type === "PICKUP" ? "solar:shop-2-outline" : "solar:delivery-outline"} /> {ORDER_TYPE_LABEL[order.type] || titleCase(order.type)} · placed {fmtTime(order.createdAt)}
            </div>
          </div>
          <div className="text-end">
            <StatusBadge status={s} />
            <div className="fw-semibold mt-4">{money(order.total)}</div>
          </div>
        </div>
        <div className="d-flex flex-wrap gap-2 mb-8">
          {s === "PLACED" && <Countdown target={order.acceptDeadlineAt} label="Accept within" warnMin={1} />}
          {["ACCEPTED", "DRIVER_ASSIGNED", "PREPARING"].includes(s) && <Countdown target={order.estimatedReadyAt} label="Ready in" />}
          {order.isScheduled && <Badge tone="info">Scheduled {fmtDateTime(order.scheduledFor)}</Badge>}
          {order.hasAllergyFlag && <Badge tone="danger">Allergy</Badge>}
        </div>
        <OrderItems order={order} onRemove={removeItem} removing={isBusy("rm")} />
        {order.customerNotes && <div className="alert alert-warning py-8 px-12 radius-8 text-sm mt-8 mb-0">Customer note: {order.customerNotes}</div>}

        <div className="d-flex flex-wrap gap-2 mt-12">
          {s === "PLACED" && (
            <>
              <Button variant="success" loading={isBusy("acc0")} onClick={() => act("acc0", "accept", {}, `Order ${order.code} accepted`)}>
                Accept ({order.prepTimeMin ?? "-"} min)
              </Button>
              {[5, 10, 15].map((m) => (
                <Button key={m} variant="outline" loading={isBusy(`acc${m}`)} onClick={() => act(`acc${m}`, "accept", { addMinutes: m }, `Accepted with +${m} min`)}>
                  +{m}
                </Button>
              ))}
              <Button variant="outline-danger" onClick={() => setReject(true)}>
                Reject
              </Button>
            </>
          )}
          {["ACCEPTED", "DRIVER_ASSIGNED"].includes(s) && (
            <Button
              variant="warning"
              loading={isBusy("start")}
              onClick={async () => {
                const r = await run("start", () => api.post(`/restaurant/kds/${order.id}/start`), "Preparing");
                if (r.ok) reload();
              }}
            >
              Start preparing
            </Button>
          )}
          {s === "PREPARING" && (
            <Button variant="success" loading={isBusy("ready")} onClick={() => act("ready", "ready", undefined, `Order ${order.code} ready`)}>
              Mark ready
            </Button>
          )}
          {["ACCEPTED", "DRIVER_ASSIGNED", "PREPARING"].includes(s) && (
            <Button variant="outline" loading={isBusy("ext")} onClick={() => act("ext", "extend-prep", { addMinutes: 5 }, "Prep extended by 5 min")}>
              +5 min
            </Button>
          )}
          {s === "READY" && (
            <Button variant="primary" icon="solar:hand-shake-outline" onClick={() => setHandoff(true)}>
              Hand off (code)
            </Button>
          )}
        </div>
      </div>
      <RejectModal
        order={reject ? order : null}
        onClose={() => setReject(false)}
        onDone={() => {
          setReject(false);
          reload();
        }}
      />
      <HandoffModal
        order={handoff ? order : null}
        onClose={() => setHandoff(false)}
        onDone={() => {
          setHandoff(false);
          reload();
        }}
      />
    </div>
  );
}

function LiveBoard() {
  const { orders, error, reload } = useLiveOrders();
  useRealtimeReload(reload);
  useTick(15000);
  if (error && !orders) return <ErrorState error={error} onRetry={reload} />;
  if (!orders) return <Loading />;
  return (
    <div className="row g-3">
      {COLUMNS.map((c) => {
        const list = orders.filter((o) => c.statuses.includes(o.status)).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
        return (
          <div key={c.key} className="col-xl-3 col-md-6">
            <div className="d-flex align-items-center justify-content-between mb-12">
              <h6 className="mb-0 d-flex align-items-center gap-2">
                <Icon icon={c.icon} className="text-xl" /> {c.title}
              </h6>
              <Badge tone={c.tone}>{list.length}</Badge>
            </div>
            {list.length === 0 ? (
              <div className="text-center text-secondary-light text-sm py-32 border radius-12" style={{ borderStyle: "dashed" }}>
                No orders
              </div>
            ) : (
              list.map((o) => <OrderCard key={o.id} order={o} reload={reload} />)
            )}
          </div>
        );
      })}
    </div>
  );
}

function OrderDetailModal({ id, onClose }) {
  const state = usePortalFetch(id ? `/restaurant/orders/${id}` : null);
  const o = state.data?.order;
  return (
    <Modal open={!!id} onClose={onClose} title={o ? `Order ${o.code}` : "Order"} size="lg">
      {state.error && <ErrorState error={state.error} onRetry={state.reload} />}
      {state.loading && !o && <Loading />}
      {o && (
        <div className="row gy-4">
          <div className="col-md-7">
            <div className="d-flex gap-2 mb-12 flex-wrap align-items-center">
              <StatusBadge status={o.status} />
              <Badge tone="info">{ORDER_TYPE_LABEL[o.type] || o.type}</Badge>
              <span className="text-secondary-light text-sm">{fmtDateTime(o.createdAt)}</span>
            </div>
            <OrderItems order={o} />
            <div className="mt-12 text-sm">
              <div className="d-flex justify-content-between"><span>Subtotal</span><span>{money(o.subtotal)}</span></div>
              <div className="d-flex justify-content-between"><span>Commission ({o.commissionPct}%)</span><span>-{money(o.commissionAmount)}</span></div>
              <div className="d-flex justify-content-between fw-semibold"><span>Your payout</span><span>{money(o.restaurantPayout)}</span></div>
            </div>
            {(o.cancelReason || o.rejectReason) && <div className="text-danger-600 text-sm mt-8">Reason: {o.cancelReason || o.rejectReason}</div>}
          </div>
          <div className="col-md-5 ps-4">
            <Timeline
              items={(state.data.timeline || []).map((t) => ({
                title: t.toStatus ? titleCase(t.toStatus) : titleCase(t.type),
                text: t.note,
                at: fmtDateTime(t.createdAt),
              }))}
            />
          </div>
        </div>
      )}
    </Modal>
  );
}

function History() {
  const { restaurantId } = usePortal();
  const list = usePagedList("/restaurant/orders", { limit: 15, sortBy: "createdAt", sortDir: "DESC", filters: { restaurantId, status: "DELIVERED" } });
  const [open, setOpen] = useState(null);
  const { setFilter } = list;
  useEffect(() => {
    setFilter("restaurantId", restaurantId);
  }, [restaurantId, setFilter]);
  const cols = [
    { key: "code", title: "Order", render: (o) => <span className="fw-semibold">{o.code}</span> },
    { key: "createdAt", title: "Placed", render: (o) => fmtDateTime(o.createdAt) },
    { key: "type", title: "Type", render: (o) => ORDER_TYPE_LABEL[o.type] || o.type },
    { key: "status", title: "Status", render: (o) => <StatusBadge status={o.status} /> },
    { key: "subtotal", title: "Subtotal", align: "right", render: (o) => money(o.subtotal) },
    { key: "restaurantPayout", title: "Payout", align: "right", render: (o) => money(o.restaurantPayout) },
  ];
  return (
    <>
      <ListToolbar
        filters={<FilterSelect value={list.filters.status} onChange={(v) => list.setFilter("status", v)} options={ORDER_STATUSES} placeholder="All statuses" />}
        actions={<Button variant="outline" icon="solar:refresh-outline" onClick={list.reload}>Refresh</Button>}
      />
      <div className="card radius-12 border-0 shadow-sm">
        <DataTable columns={cols} {...list.tableProps} error={list.error} onRetry={list.reload} onRowClick={(o) => setOpen(o.id)} emptyTitle="No orders match" />
      </div>
      <OrderDetailModal id={open} onClose={() => setOpen(null)} />
    </>
  );
}

export default function Orders() {
  const [tab, setTab] = useState("live");
  return (
    <PortalPage
      title="Orders"
      actions={
        <Segmented
          options={[
            { value: "live", label: "Live board" },
            { value: "history", label: "History" },
          ]}
          value={tab}
          onChange={setTab}
        />
      }
    >
      {tab === "live" ? <LiveBoard /> : <History />}
    </PortalPage>
  );
}
