import React, { useCallback, useEffect, useState } from "react";
import { toast } from "react-toastify";
import { Badge, Card, Select } from "../../ui";
import { errorMessage } from "../../lib/api";

const ITEMS = [
  { key: "autoAccept", label: "Accept new orders automatically", hint: "The prep time is estimated from your kitchen load. If the kitchen already has many open orders, the order waits for you instead." },
  { key: "autoStartPrep", label: "Start preparing automatically", hint: "The kitchen ticket starts as soon as the order is accepted. Scheduled orders start in time to be ready." },
  { key: "autoReady", label: "Mark orders ready automatically", hint: "When the prep time is over the order is marked READY and the nearest driver is offered it. You can still mark it ready earlier, or extend the prep time." },
];
const toSel = (v) => (v === true ? "on" : v === false ? "off" : "default");
const fromSel = (s) => (s === "on" ? true : s === "off" ? false : null);

/**
 * How much of the order flow runs by itself: accept -> start prep -> ready -> driver search.
 * Used by the restaurant portal (path /restaurant/automation) and the admin console (path /admin/restaurants/:id/automation).
 * `api` is an object with get(url) / patch(url, body) returning the response body.
 */
export default function OrderAutomationCard({ api, path, canEdit = true, className = "" }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(null);
  const load = useCallback(() => {
    Promise.resolve(api.get(path))
      .then(setData)
      .catch((e) => toast.error(errorMessage(e)));
  }, [api, path]);
  useEffect(load, [load]);

  const change = async (key, value) => {
    setBusy(key);
    try {
      setData(await api.patch(path, { [key]: fromSel(value) }));
      toast.success("Automation updated");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card title="Order automation" subtitle="Orders move through accept, prepare and ready by themselves. Turn a step off here if you want to do it by hand." className={className}>
      {!data ? (
        <div className="text-secondary-light">Loading…</div>
      ) : (
        <div className="row g-3">
          {ITEMS.map((it) => (
            <div key={it.key} className="col-lg-4">
              <Select
                label={it.label}
                hint={it.hint}
                allowEmpty={false}
                disabled={!canEdit || busy === it.key}
                value={toSel(data.overrides?.[it.key])}
                onChange={(v) => change(it.key, v)}
                options={[
                  { value: "default", label: `Follow FORKY default (${data.platformDefaults?.[it.key] ? "on" : "off"})` },
                  { value: "on", label: "Always on" },
                  { value: "off", label: "Always off (I do it by hand)" },
                ]}
              />
              <div className="mt-6">
                <Badge tone={data.effective?.[it.key] ? "success" : "neutral"}>{data.effective?.[it.key] ? "Automatic now" : "Manual now"}</Badge>
              </div>
            </div>
          ))}
        </div>
      )}
      {!canEdit && <div className="text-secondary-light text-sm mt-12">Only an owner or location manager can change this.</div>}
    </Card>
  );
}
