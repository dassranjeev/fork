import React, { useCallback, useEffect, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { ErrorBox, Loading, Ri, Spinner } from "../components/ui";
import { fmtDateTime } from "../lib/fmt";
import { errorMessage, money, sfHttp } from "../lib/sfApi";
import { useSfAuth } from "../lib/SfAuth";

const tone = (s) => (["CANCELLED", "REJECTED"].includes(s) ? "danger" : ["DELIVERED", "COLLECTED"].includes(s) ? "ok" : "warn");

export default function Orders() {
  const { user, loading } = useSfAuth();
  const [rows, setRows] = useState(null);
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState("");
  const [more, setMore] = useState(false);

  const load = useCallback(async (page = 1) => {
    try {
      setError("");
      const r = await sfHttp.get("/customer/orders", { page, limit: 15 });
      setRows((cur) => (page > 1 && cur ? [...cur, ...r.data] : r.data));
      setMeta(r.meta);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setMore(false);
    }
  }, []);
  useEffect(() => {
    if (user) load(1);
  }, [user, load]);

  if (loading) return <div className="sf-container"><Loading /></div>;
  if (!user) return <Navigate to="/order/login?next=/order/orders" replace />;
  return (
    <div className="sf-container sf-narrow">
      <h1 className="sf-h1">My orders</h1>
      {error && <ErrorBox message={error} onRetry={() => load(1)} />}
      {!rows && !error && <Loading />}
      {rows && rows.length === 0 && (
        <div className="sf-center sf-muted py-5">
          <Ri name="receipt-line" className="sf-bigicon" />
          <p className="mt-2">No orders yet.</p>
          <Link to="/order" className="sf-btn sf-btn-primary">Find something to eat</Link>
        </div>
      )}
      <div className="sf-orderlist" data-testid="orders-list">
        {(rows || []).map((o) => (
          <Link key={o.id} to={`/order/track/${o.id}`} className="sf-card sf-pad sf-orderrow" data-testid="order-row">
            <div className="sf-row-between">
              <b>{o.code}</b>
              <span className={`sf-tag sf-tag-${tone(o.status)}`}>{o.status.replace(/_/g, " ")}</span>
            </div>
            <div className="sf-row-between sf-small sf-muted">
              <span>
                {o.type === "PICKUP" ? "Pickup" : "Delivery"} - {fmtDateTime(o.createdAt)}
              </span>
              <b>{money(o.total)}</b>
            </div>
          </Link>
        ))}
      </div>
      {meta && rows && rows.length < meta.total && (
        <div className="sf-center mt-3">
          <button type="button" className="sf-btn sf-btn-light" disabled={more} onClick={() => { setMore(true); load((meta.page || 1) + 1); }}>
            {more ? <Spinner size={16} /> : null} Show more
          </button>
        </div>
      )}
    </div>
  );
}
