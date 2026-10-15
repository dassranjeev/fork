import React, { useEffect, useState } from "react";
import { Icon } from "@iconify/react/offline";
import { toast } from "react-toastify";
import { Badge, Button, FormModal, Progress, TextInput, useConfirm } from "../../ui";
import { errorMessage } from "../../lib/api";
import { money } from "../../lib/format";
import { useAction, useApi } from "./shared";

/**
 * The picking list of a grocery-type order (docs/store-types.md): the store goes through the basket line by line.
 *   Found / Weighed   the product is in the bag (a weighed product is weighed: the customer pays for the weight up to the estimate, never more)
 *   Out of stock      the line is removed and refunded at once
 *   Replace           another product of the store; the customer pays the LOWER price (only when the customer allowed replacements)
 * The customer is told after each step and the timeline records it.
 */

export const weightWord = (it, w) => `${+Number(w).toFixed(3)} ${String(it.weightUnit || "KG").toLowerCase()}`;

const TEMP = { CHILLED: { icon: "solar:snowflake-outline", label: "Chilled" }, FROZEN: { icon: "solar:temperature-outline", label: "Frozen" } };

/** Search the store's products for a replacement. */
function ReplaceModal({ order, item, onClose, onDone }) {
  const api = useApi();
  const { busy, run } = useAction();
  const [q, setQ] = useState("");
  const [rows, setRows] = useState([]);
  const [searching, setSearching] = useState(false);
  const [chosen, setChosen] = useState(null);
  const [qty, setQty] = useState(item?.quantity || 1);
  useEffect(() => {
    if (!item) return undefined;
    setQ("");
    setChosen(null);
    setQty(item.quantity);
    return undefined;
  }, [item]);
  useEffect(() => {
    if (!item) return undefined;
    let off = false;
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const r = await api.get("/restaurant/menu/items", { q: q.trim() || undefined, stock: "in", available: "true", active: "true", limit: 8, sortBy: "name", sortDir: "ASC" });
        if (!off) setRows((r.data || []).filter((x) => x.id !== item.menuItemId));
      } catch (e) {
        if (!off) toast.error(errorMessage(e));
      } finally {
        if (!off) setSearching(false);
      }
    }, 250);
    return () => {
      off = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, item]);
  if (!item) return null;
  const stepPrice = (p) => (p.sellBy === "WEIGHT" ? Number(p.price) * Number(p.stepSize) : Number(p.price));
  const submit = async () => {
    const r = await run("replace", () => api.post(`/restaurant/orders/${order.id}/items/${item.id}/pick`, { status: "REPLACED", replacementItemId: chosen.id, replacementQuantity: Number(qty) || item.quantity }), `${item.name} replaced with ${chosen.name}`);
    if (r.ok) onDone();
  };
  const now = Math.min(Number(item.lineTotal), stepPrice(chosen || { price: 0 }) * (Number(qty) || 1));
  return (
    <FormModal open onClose={onClose} title={`Replace "${item.name}"`} onSubmit={submit} busy={!!busy} submitText="Replace" disabled={!chosen} size="lg">
      <TextInput label="Find a product" value={q} onChange={setQ} placeholder="Name, brand, SKU or barcode" autoFocus />
      <div className="border radius-8 mb-12" style={{ maxHeight: 240, overflowY: "auto" }} data-testid="replace-results">
        {searching && <div className="text-secondary-light text-sm p-12">Searching…</div>}
        {!searching && rows.length === 0 && <div className="text-secondary-light text-sm p-12">No product that can be ordered matches.</div>}
        {rows.map((p) => (
          <button key={p.id} type="button" className={`d-flex justify-content-between align-items-center w-100 text-start px-12 py-8 border-0 border-bottom bg-transparent ${chosen?.id === p.id ? "bg-primary-50" : ""}`} onClick={() => setChosen(p)} data-testid={`replace-${p.sku || p.id}`}>
            <span>
              <span className="fw-semibold">{p.name}</span>
              <span className="text-secondary-light text-xs d-block">{[p.brand, p.packSize, p.sku].filter(Boolean).join(" · ")}</span>
            </span>
            <span className="text-end">
              {money(stepPrice(p))}
              <span className="text-secondary-light text-xs d-block">{p.sellBy === "WEIGHT" ? `per ${Number(p.stepSize)} ${String(p.weightUnit).toLowerCase()}` : "each"}</span>
            </span>
          </button>
        ))}
      </div>
      {chosen && (
        <div className="row align-items-end">
          <div className="col-md-4">
            <TextInput label={chosen.sellBy === "WEIGHT" ? `Steps of ${Number(chosen.stepSize)} ${String(chosen.weightUnit).toLowerCase()}` : "Quantity"} type="number" value={qty} onChange={setQty} />
          </div>
          <div className="col-md-8 text-sm text-secondary-light pb-16">
            The customer ordered <strong>{item.quantity} × {item.name}</strong> ({money(item.lineTotal)}). They pay the <strong>lower</strong> price: {now < Number(item.lineTotal) - 0.004 ? `${money(now)} for the replacement, ${money(Number(item.lineTotal) - now)} (plus its tax) is refunded` : "the replacement costs the same or more, so nothing changes for them"}.
          </div>
        </div>
      )}
    </FormModal>
  );
}

function Line({ order, item, reload, onReplace }) {
  const api = useApi();
  const confirm = useConfirm();
  const { run, isBusy } = useAction();
  const [w, setW] = useState("");
  const weighed = item.sellBy === "WEIGHT";
  const unit = String(item.weightUnit || "KG").toLowerCase();
  const est = Number(item.estimatedWeight ?? 0);
  const pick = async (body, msg) => {
    const r = await run(`${item.id}-${body.status}`, () => api.post(`/restaurant/orders/${order.id}/items/${item.id}/pick`, body), msg);
    if (r.ok) {
      setW("");
      reload();
    }
    return r;
  };
  const outOfStock = async () => {
    const c = await confirm({ title: `${item.name}: out of stock?`, message: `The line is refunded to the customer (${money(Number(item.lineTotal) + Number(item.taxAmount) - Number(item.adjustmentRefund || 0))}) and the product shows as sold out for everyone.`, danger: true, confirmText: "Out of stock" });
    if (c.confirmed) pick({ status: "OUT_OF_STOCK" }, `${item.name}: out of stock, refunded`);
  };
  const weigh = () => {
    const n = Number(w);
    if (!(n > 0)) return toast.error(`Enter what the scale says, in ${unit}`);
    pick({ status: "PICKED", actualWeight: n }, `${item.name}: weighed ${n} ${unit}`);
  };
  const st = item.pickStatus || "PENDING";
  const gone = item.removed || st === "OUT_OF_STOCK";
  const refundText = Number(item.adjustmentRefund) > 0 ? ` · ${money(item.adjustmentRefund)} refunded` : "";

  return (
    <li className="py-10 border-bottom" data-testid={`pick-line-${item.sku || item.id}`}>
      <div className="d-flex justify-content-between align-items-start gap-2 flex-wrap">
        <div className={gone ? "text-decoration-line-through text-secondary-light" : ""}>
          <span className="fw-semibold">{weighed ? `~${+est.toFixed(3)} ${unit}` : `${item.quantity}×`}</span> {item.name}
          {item.packSize && <span className="text-secondary-light text-xs"> · {item.packSize}</span>}
          {item.minAge > 0 && <Badge tone="danger" className="ms-2">{item.minAge}+ ID</Badge>}
          {TEMP[item.temperature] && (
            <span className="ms-2 text-info-600" title={TEMP[item.temperature].label}>
              <Icon icon={TEMP[item.temperature].icon} /> <span className="text-xs">{TEMP[item.temperature].label}</span>
            </span>
          )}
          {item.sku && <div className="text-secondary-light text-xs font-monospace">{[item.sku, item.barcode].filter(Boolean).join(" · ")}</div>}
          {item.notes && <div className="text-warning-main text-xs">Note: {item.notes}</div>}
          {item.substitution === "REFUND" && !gone && <div className="text-xs text-secondary-light">Customer: if missing, refund — no replacement</div>}
        </div>
        <div className="d-flex align-items-center gap-2 flex-wrap justify-content-end">
          {st === "PICKED" && (
            <Badge tone="success">
              <Icon icon="solar:check-circle-outline" /> {weighed && item.actualWeight != null ? `Weighed ${weightWord(item, item.actualWeight)}${refundText}` : "Found"}
            </Badge>
          )}
          {st === "REPLACED" && <Badge tone="info">Replaced with {item.replacement?.quantity} × {item.replacement?.name}{refundText}</Badge>}
          {gone && <Badge tone="danger">Out of stock{refundText}</Badge>}
        </div>
      </div>
      {!gone && st !== "REPLACED" && (
        <div className="d-flex flex-wrap align-items-center gap-2 mt-8">
          {weighed ? (
            <>
              <div className="input-group input-group-sm" style={{ width: 170 }}>
                <input type="number" min="0" step="0.001" className="form-control radius-8" placeholder={`Weight (${unit})`} value={w} onChange={(e) => setW(e.target.value)} onKeyDown={(e) => e.key === "Enter" && weigh()} aria-label={`Weight of ${item.name} in ${unit}`} data-testid={`weight-${item.sku || item.id}`} />
                <span className="input-group-text">{unit}</span>
              </div>
              <Button variant="success" loading={isBusy(`${item.id}-PICKED`)} onClick={weigh} data-testid={`weighed-${item.sku || item.id}`}>
                {st === "PICKED" ? "Re-weigh" : "Weighed"}
              </Button>
            </>
          ) : (
            st === "PENDING" && (
              <Button variant="success" icon="solar:check-circle-outline" loading={isBusy(`${item.id}-PICKED`)} onClick={() => pick({ status: "PICKED" }, `${item.name}: found`)} data-testid={`found-${item.sku || item.id}`}>
                Found
              </Button>
            )
          )}
          <Button variant="outline-danger" loading={isBusy(`${item.id}-OUT_OF_STOCK`)} onClick={outOfStock} data-testid={`oos-${item.sku || item.id}`}>
            Out of stock
          </Button>
          {st === "PENDING" && (
            <Button variant="outline" disabled={item.substitution === "REFUND"} title={item.substitution === "REFUND" ? "The customer asked for a refund instead of a replacement" : "Pick another product for it"} onClick={() => onReplace(item)} data-testid={`replace-btn-${item.sku || item.id}`}>
              Replace…
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

export default function PickingList({ order, reload }) {
  const api = useApi();
  const { run, isBusy } = useAction();
  const [replace, setReplace] = useState(null);
  const items = order.items || [];
  const live = items.filter((i) => !i.removed);
  const done = live.filter((i) => ["PICKED", "REPLACED"].includes(i.pickStatus)).length;
  const pending = live.filter((i) => (i.pickStatus || "PENDING") === "PENDING");
  const easy = pending.filter((i) => i.sellBy !== "WEIGHT");
  const allFound = async () => {
    for (const it of easy) {
      const r = await run("all", () => api.post(`/restaurant/orders/${order.id}/items/${it.id}/pick`, { status: "PICKED" }));
      if (!r.ok) break;
    }
    reload();
  };
  return (
    <div data-testid="picking-list">
      <div className="d-flex align-items-center justify-content-between gap-2 mb-8 flex-wrap">
        <div className="fw-semibold text-sm">
          <Icon icon="solar:cart-large-minimalistic-outline" className="me-1" /> Picking: {done} of {live.length} done
          {order.basket?.estimatedKg > 0 && <span className="text-secondary-light fw-normal"> · about {order.basket.estimatedKg} kg</span>}
          {order.basket?.chilled > 0 && <Badge tone="info" className="ms-2">{order.basket.chilled} chilled</Badge>}
          {order.basket?.frozen > 0 && <Badge tone="info" className="ms-2">{order.basket.frozen} frozen</Badge>}
        </div>
        {easy.length > 1 && (
          <Button variant="light" loading={isBusy("all")} onClick={allFound}>
            All {easy.length} found
          </Button>
        )}
      </div>
      <div className="mb-8"><Progress value={live.length ? Math.round((done / live.length) * 100) : 0} /></div>
      <ul className="list-unstyled mb-0">
        {items.map((it) => (
          <Line key={it.id} order={order} item={it} reload={reload} onReplace={setReplace} />
        ))}
      </ul>
      <ReplaceModal
        order={order}
        item={replace}
        onClose={() => setReplace(null)}
        onDone={() => {
          setReplace(null);
          reload();
        }}
      />
    </div>
  );
}
