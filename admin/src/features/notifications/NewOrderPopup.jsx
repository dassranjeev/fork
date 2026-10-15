import React, { useEffect, useState } from "react";
import { Icon } from "@iconify/react/offline";
import { useNavigate } from "react-router-dom";
import { toast } from "react-toastify";
import { errorMessage, http } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { money } from "../../lib/format";
import { useAlerts } from "../../lib/notify";
import { Badge, Button, Modal, Select, TextArea } from "../../ui";
import { OrderItems } from "../portal/Orders";
import { usePortal } from "../portal/context";
import { ORDER_TYPE_LABEL, useTick } from "../portal/shared";

const REJECT_REASONS = [
  { value: "BUSY", label: "Too busy" },
  { value: "ITEM_UNAVAILABLE", label: "Item unavailable" },
  { value: "CLOSING", label: "Closing soon" },
  { value: "OTHER", label: "Other" },
];

const clock = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/**
 * The new-order POPUP of the Restaurant Portal, on every page: it opens by itself when an order is waiting for the restaurant to accept it (the restaurant
 * accepts manually, or something blocked automatic acceptance) and shows the items, notes, total and the time left, with Accept (prep time adjustable) and
 * Reject. Orders that are accepted automatically never open it. Several waiting orders are answered one after the other, oldest first.
 * "Not now" only closes the popup: the red alarm banner and the sound stay until the order is answered or acknowledged.
 */
export default function NewOrderPopup() {
  const { items, acknowledge } = useAlerts();
  const { impersonating, user } = useAuth();
  const { restaurantId, setRestaurantId } = usePortal();
  const navigate = useNavigate();
  const [closed, setClosed] = useState({});
  const [loaded, setLoaded] = useState({ id: null, order: null, rid: null });
  const [prep, setPrep] = useState(20);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("BUSY");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(null);
  useTick(1000);

  const waiting = impersonating ? [] : items.filter((a) => a.kind === "order" && !closed[a.id]);
  const current = waiting[0];
  const currentId = current?.id;
  const alertRid = current?.restaurantId;
  const myLocations = (user?.restaurantIds || []).join(",");
  const order = loaded.id === currentId ? loaded.order : null;
  const rid = (loaded.id === currentId && loaded.rid) || alertRid || restaurantId;

  // the order behind the alert (items, notes, total, how long is left). An alert that arrived live does not say which location it is for until the
  // next sync: then the account's locations are tried one by one.
  useEffect(() => {
    setRejecting(false);
    setNote("");
    if (!currentId) return undefined;
    let off = false;
    const tryOrder = [...new Set([alertRid, restaurantId, ...myLocations.split(",")].filter(Boolean))];
    (async () => {
      for (const id of alertRid ? [alertRid] : tryOrder) {
        try {
          const d = await http.get(`/restaurant/orders/${currentId}`, { restaurantId: id });
          if (off) return;
          const o = d.order;
          if (o?.status !== "PLACED") {
            // somebody else (or the system) already answered it
            setClosed((c) => ({ ...c, [currentId]: true }));
            return;
          }
          setLoaded({ id: currentId, order: o, rid: id });
          setPrep(Number(o.prepTimeMin) || 20);
          return;
        } catch {
          /* not this location (or a hiccup): the next one, or the next sync fills in the location and runs this again */
        }
      }
    })();
    return () => {
      off = true;
    };
  }, [currentId, alertRid, restaurantId, myLocations]);

  if (!current) return null;

  const done = (msg) => {
    toast.success(msg);
    acknowledge(current.id, "order");
    setClosed((c) => ({ ...c, [current.id]: true }));
  };
  const accept = async () => {
    setBusy("accept");
    try {
      await http.post(`/restaurant/orders/${current.id}/accept`, { prepTimeMin: prep }, { params: { restaurantId: rid } });
      done(`Order ${order.code} accepted: ready in ${prep} min`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const reject = async () => {
    setBusy("reject");
    try {
      await http.post(`/restaurant/orders/${current.id}/reject`, { reason, note: note.trim() || undefined }, { params: { restaurantId: rid } });
      done(`Order ${order.code} rejected`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const later = () => setClosed((c) => ({ ...c, [current.id]: true }));
  const openOrder = () => {
    acknowledge(current.id, "order");
    if (rid && rid !== restaurantId) setRestaurantId(rid);
    navigate(`/portal/orders?order=${current.id}`);
    later();
  };

  const left = order?.acceptDeadlineAt ? new Date(order.acceptDeadlineAt).getTime() - Date.now() : null;
  const itemCount = (order?.items || []).filter((i) => !i.removed).reduce((n, i) => n + (Number(i.quantity) || 1), 0);

  return (
    <Modal
      open
      onClose={later}
      closeOnBackdrop={false}
      size="lg"
      title={
        <span data-testid="new-order-popup" data-order={current.id}>
          <Icon icon="solar:bell-bing-bold" className="text-danger-600 me-2" aria-hidden="true" />
          New order {order?.code || ""}
          {waiting.length > 1 && <span className="text-secondary-light text-sm fw-normal ms-2">({waiting.length} waiting)</span>}
        </span>
      }
      footer={
        <div className="d-flex flex-wrap align-items-center justify-content-between gap-2 w-100">
          <div className="d-flex gap-2">
            <button type="button" className="btn btn-link text-secondary-light px-0" onClick={later} data-testid="new-order-later">
              Not now
            </button>
            <button type="button" className="btn btn-link px-0" onClick={openOrder} data-testid="new-order-open">
              Open in Orders
            </button>
          </div>
          {order && !rejecting && (
            <div className="d-flex gap-2">
              <Button variant="outline-danger" onClick={() => setRejecting(true)} disabled={!!busy} data-testid="new-order-reject">
                Reject
              </Button>
              <Button variant="success" loading={busy === "accept"} disabled={!!busy} onClick={accept} data-testid="new-order-accept">
                Accept ({prep} min)
              </Button>
            </div>
          )}
          {order && rejecting && (
            <div className="d-flex gap-2">
              <Button variant="outline" onClick={() => setRejecting(false)} disabled={!!busy}>
                Back
              </Button>
              <Button variant="danger" loading={busy === "reject"} disabled={!!busy} onClick={reject} data-testid="new-order-reject-confirm">
                Reject order
              </Button>
            </div>
          )}
        </div>
      }
    >
      {!order ? (
        <div className="text-center text-secondary-light py-24" data-testid="new-order-loading">
          Loading the order…
        </div>
      ) : (
        <>
          <div className="d-flex flex-wrap align-items-center gap-2 mb-12">
            <Badge tone="info">{ORDER_TYPE_LABEL[order.type] || order.type}</Badge>
            <Badge tone="neutral">
              {itemCount} item{itemCount === 1 ? "" : "s"}
            </Badge>
            <Badge tone="neutral">{money(order.total)}</Badge>
            {order.hasAllergyFlag && <Badge tone="danger">Allergy</Badge>}
            {order.type !== "PICKUP" && order.dropoffMethod === "LEAVE_AT_DOOR" && <Badge tone="info">Contactless</Badge>}
            {left !== null && (
              <span className="ms-auto" data-testid="new-order-left">
                <Badge tone={left < 60000 ? "danger" : "warning"}>
                  <Icon icon="solar:clock-circle-outline" className="me-1" aria-hidden="true" />
                  {left > 0 ? `Answer within ${clock(left)}` : "Waiting for your answer"}
                </Badge>
              </span>
            )}
          </div>
          <OrderItems order={order} />
          {order.customerNotes && <div className="alert alert-warning py-8 px-12 radius-8 text-sm mt-12 mb-0">Customer note: {order.customerNotes}</div>}
          {!rejecting ? (
            <div className="d-flex flex-wrap align-items-center gap-2 mt-16" data-testid="new-order-prep">
              <span className="fw-semibold text-sm me-2">Ready in</span>
              <Button variant="outline" onClick={() => setPrep((p) => Math.max(5, p - 5))} aria-label="5 minutes less" disabled={prep <= 5}>
                -5
              </Button>
              <span className="fw-bold px-8" data-testid="new-order-prep-min">
                {prep} min
              </span>
              <Button variant="outline" onClick={() => setPrep((p) => Math.min(240, p + 5))} aria-label="5 minutes more">
                +5
              </Button>
              <Button variant="outline" onClick={() => setPrep((p) => Math.min(240, p + 10))} aria-label="10 minutes more">
                +10
              </Button>
            </div>
          ) : (
            <div className="mt-16" data-testid="new-order-reject-form">
              <Select label="Reason" value={reason} onChange={setReason} options={REJECT_REASONS} allowEmpty={false} />
              <TextArea label="Note (optional)" value={note} onChange={setNote} rows={2} />
              <p className="text-secondary-light text-sm mb-0">The customer is told and their payment is refunded in full.</p>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
