import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Badge, Button, Card, EmptyState, ErrorState, FormModal, KeyValue, Loading, MapView, Select, TextArea } from "../../ui";
import { useFetch, useForm, useSubmit } from "../../lib/hooks";
import { useAuth } from "../../lib/auth";
import api, { http } from "../../lib/api";
import { fmtDateTime, titleCase } from "../../lib/format";

const FLAG_TEXT = {
  WEAK_PROOF: "Weak proof",
  GEOFENCE_OVERRIDE: "Delivered outside the geofence (exception)",
  GPS_MISMATCH: "Claimed location far from the driver's server GPS",
  GPS_UNVERIFIED: "No fresh server GPS to cross-check",
  LOW_ACCURACY: "Low GPS accuracy on the photo",
  STAFF_FORCED: "Status forced by staff - no driver evidence",
  NO_DROPOFF_COORDS: "Drop-off address had no coordinates",
};

/** green = strong, amber = weak, red = missing */
export function ProofBadge({ proof, valid }) {
  if (!proof) return <Badge tone="danger">No proof on file</Badge>;
  if (proof.proofType === "NONE") return <Badge tone="danger">No proof</Badge>;
  if (proof.proofType === "HANDED_OVER") return <Badge tone="info">Handed over in person · no PIN or photo (customer chose no PIN)</Badge>;
  const label = titleCase(String(proof.proofType).replace("_AND_", " + "));
  return <Badge tone={valid ?? proof.strength === "STRONG" ? "success" : "warning"}>{label} · {proof.strength === "STRONG" ? "strong" : "weak"}</Badge>;
}

/** The proof photo sits behind the bearer token, so it is fetched through the API client as a blob (an <img src> cannot send headers). */
export function useProofPhoto(orderId, enabled) {
  const [state, setState] = useState({ url: null, error: null, loading: false });
  useEffect(() => {
    if (!enabled || !orderId) return undefined;
    let revoked = false;
    let objectUrl = null;
    setState({ url: null, error: null, loading: true });
    api
      .get(`/orders/${orderId}/proof/photo`, { responseType: "blob" })
      .then((r) => {
        if (revoked) return;
        objectUrl = URL.createObjectURL(r.data);
        setState({ url: objectUrl, error: null, loading: false });
      })
      .catch((e) => !revoked && setState({ url: null, error: e?.response?.status === 410 ? "The photo was deleted after the retention period." : "Photo could not be loaded.", loading: false }));
    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [orderId, enabled]);
  return state;
}

function Photo({ orderId, available, height = 260 }) {
  const p = useProofPhoto(orderId, available);
  if (!available) return <EmptyState icon="solar:gallery-remove-outline" title="No photo" text="This delivery has no stored proof photo." />;
  if (p.loading) return <Loading minHeight={height} />;
  if (p.error) return <div className="alert alert-warning radius-8 text-sm mb-0">{p.error}</div>;
  // p.url is a blob: URL created by this component from an authenticated response, never from API-provided strings
  return <img src={p.url} alt="Delivery proof" className="radius-8 border" style={{ maxWidth: "100%", maxHeight: height, objectFit: "contain" }} />;
}

function ReviewModal({ orderId, onClose, onDone }) {
  const f = useForm({ note: "" });
  const { busy, run } = useSubmit();
  return (
    <FormModal open onClose={onClose} title="Mark proof as reviewed" onSubmit={() => run(() => http.post(`/admin/orders/${orderId}/proof/review`, { note: f.values.note || undefined }), { success: "Marked as reviewed", onDone: () => { onClose(); onDone(); } })} busy={busy} submitText="Mark reviewed">
      <TextArea label="Review note" rows={3} {...f.bind("note")} />
    </FormModal>
  );
}

/** "Delivery proof" tab on the order page. */
export function DeliveryProofTab({ orderId, status }) {
  const { can } = useAuth();
  const q = useFetch(`/admin/orders/${orderId}/proof`);
  const [modal, setModal] = useState(false);
  if (q.loading && !q.data) return <Loading minHeight={240} />;
  if (q.error && !q.data) return <ErrorState error={q.error} onRetry={q.reload} />;
  const d = q.data;
  if (!d) return null;
  const p = d.proof;
  const req = d.requirement;
  const delivered = ["DELIVERED", "COLLECTED"].includes(status);

  const markers = [];
  const lines = [];
  if (d.dropoff?.lat != null) markers.push({ id: "drop", lat: d.dropoff.lat, lng: d.dropoff.lng, color: "#22c55e", glyph: "D", title: `Drop-off address: ${d.dropoff.line1 || ""}` });
  if (p?.photoLat != null) markers.push({ id: "photo", lat: p.photoLat, lng: p.photoLng, color: "#ff6917", glyph: "P", title: `Photo location (${p.distanceMeters ?? "?"} m from drop-off)` });
  else if (p?.claimedLat != null) markers.push({ id: "claim", lat: p.claimedLat, lng: p.claimedLng, color: "#ff6917", glyph: "P", title: "Claimed delivery location" });
  const pts = (p?.breadcrumb?.points || []).filter((x) => x.lat != null);
  pts.forEach((x, i) => markers.push({ id: `b${i}`, lat: x.lat, lng: x.lng, kind: "dot", color: "#487fff", size: 10, title: `GPS ${fmtDateTime(x.at)} · ${x.distanceMeters ?? "?"} m from drop-off` }));
  if (pts.length > 1) lines.push({ id: "trail", points: pts.map((x) => [x.lat, x.lng]), color: "#487fff", dashed: true });

  return (
    <>
      <div className="row gy-4">
        <div className="col-lg-7">
          <Card title="Evidence" actions={<ProofBadge proof={p} valid={d.valid} />}>
            {!p && (
              <div className="alert alert-danger radius-8 text-sm">
                {delivered ? "This delivered order has no evidence record." : "The order has not been delivered yet."}
                {d.legacyPhoto && " It has a legacy photo link from before the proof system, which cannot be verified."}
              </div>
            )}
            {p && (
              <>
                {p.flags?.length > 0 && (
                  <div className="d-flex gap-2 flex-wrap mb-16">
                    {p.flags.map((f) => <Badge key={f} tone={f === "WEAK_PROOF" || f === "GEOFENCE_OVERRIDE" || f === "GPS_MISMATCH" ? "danger" : "warning"} title={FLAG_TEXT[f]}>{titleCase(f)}</Badge>)}
                  </div>
                )}
                <KeyValue cols={2} items={[
                  { label: "Handoff method", value: titleCase(p.method) },
                  { label: "PIN verified", value: p.pinVerified ? <Badge tone="success">Yes</Badge> : <Badge tone="neutral">No</Badge> },
                  { label: "Delivered (server time)", value: fmtDateTime(p.deliveredAt) },
                  { label: "Arrived at customer", value: fmtDateTime(p.arrivedCustomerAt) },
                  { label: "Distance to drop-off", value: p.distanceMeters != null ? `${p.distanceMeters} m (geofence ${p.geofenceMeters ?? "off"} m)` : "-" },
                  { label: "Vs driver's server GPS", value: p.serverGpsDistanceMeters != null ? `${p.serverGpsDistanceMeters} m` : "no fresh fix" },
                  p.photoCapturedAt && { label: "Photo taken", value: `${fmtDateTime(p.photoCapturedAt)} · accuracy ${p.photoAccuracyM ?? "?"} m` },
                  p.photoSha256 && { label: "Photo hash", value: <code className="text-xs">{p.photoSha256.slice(0, 16)}…</code> },
                  p.exceptionReason && { label: "Exception reason", value: <Badge tone="warning">{titleCase(p.exceptionReason)}</Badge> },
                  p.exceptionNote && { label: "Driver note", value: p.exceptionNote },
                  { label: "Review", value: p.reviewStatus === "NEEDS_REVIEW" ? <Badge tone="warning">Needs review</Badge> : p.reviewStatus === "REVIEWED" ? <Badge tone="success">Reviewed {fmtDateTime(p.reviewedAt)}</Badge> : "Not required" },
                  p.disputeOutcome && { label: "Dispute outcome", value: <Badge tone={p.disputeOutcome === "NOT_DELIVERED" ? "danger" : "info"}>{titleCase(p.disputeOutcome)}</Badge> },
                  { label: "Device / IP", value: p.device?.ip || "-" },
                ]} />
                {p.reviewNote && <div className="text-sm text-secondary-light mt-12">Review note: {p.reviewNote}</div>}
                {can("orders", "edit") && p.reviewStatus === "NEEDS_REVIEW" && <div className="mt-16"><Button variant="light" icon="solar:check-read-outline" onClick={() => setModal(true)}>Mark reviewed</Button></div>}
              </>
            )}
          </Card>
        </div>
        <div className="col-lg-5">
          <Card title="Customer's request" className="mb-24">
            <KeyValue cols={1} items={[
              { label: "Method", value: titleCase(d.instructions.method) },
              { label: "Delivery instructions", value: d.instructions.dropoffNotes || "None" },
              { label: "Proof rule", value: req?.label },
            ]} />
          </Card>
          <Card title="Photo"><Photo orderId={orderId} available={!!p?.photoAvailable} /></Card>
        </div>
        <div className="col-12">
          <Card title="Map" subtitle={p?.breadcrumb ? `Driver GPS in the 10 minutes before delivery (${p.breadcrumb.count} points, closest ${p.breadcrumb.minDistanceMeters ?? "?"} m)` : undefined}>
            {markers.length ? <MapView markers={markers} lines={lines} height={380} /> : <EmptyState icon="solar:map-point-outline" title="No location data" />}
          </Card>
        </div>
      </div>
      {modal && <ReviewModal orderId={orderId} onClose={() => setModal(false)} onDone={q.reload} />}
    </>
  );
}

const OUTCOMES = [
  { value: "UPHELD_DELIVERED", label: "Upheld - the order was delivered (claim rejected)" },
  { value: "NOT_DELIVERED", label: "Not delivered (claim confirmed)" },
  { value: "INCONCLUSIVE", label: "Inconclusive" },
];

function OutcomeModal({ ticketId, current, onClose, onDone }) {
  const f = useForm({ outcome: current || "", note: "" });
  const { busy, run } = useSubmit();
  return (
    <FormModal open onClose={onClose} title="Record dispute outcome" onSubmit={() => run(() => http.post(`/admin/support/tickets/${ticketId}/delivery-outcome`, { outcome: f.values.outcome, note: f.values.note || undefined }), { success: "Outcome recorded", onDone: () => { onClose(); onDone(); } })} busy={busy} submitText="Record outcome" disabled={!f.values.outcome}>
      <p className="text-secondary-light text-sm">Updates the driver's delivery-dispute strike and, for repeated rejected claims, flags the customer for review (never an automatic ban).</p>
      <Select label="Outcome" required options={OUTCOMES} {...f.bind("outcome")} />
      <TextArea label="Note" rows={2} {...f.bind("note")} />
    </FormModal>
  );
}

/** Compact version for the support ticket: badge, small photo, key facts and the outcome buttons. */
export function CompactProof({ ticket, orderContext, onChanged }) {
  const { can } = useAuth();
  const [modal, setModal] = useState(false);
  const dp = orderContext?.deliveryProof;
  const delivered = ["DELIVERED", "COLLECTED"].includes(orderContext?.order?.status);
  const outcome = ticket?.meta?.deliveryOutcome;
  const dispute = ticket?.category === "NEVER_ARRIVED";
  if (!orderContext?.order || orderContext.order.type !== "DELIVERY") return null;
  return (
    <Card title="Delivery proof" className="mt-24" actions={<ProofBadge proof={dp} valid={dp?.valid} />}>
      {!dp && <div className="text-sm mb-8">{delivered ? "No proof record for this delivery (older order or staff-forced)." : "Not delivered yet."}{orderContext.deliveryEvidence?.legacyPhotoUnverified && " A legacy photo link exists but cannot be verified."}</div>}
      {dp && (
        <div className="row gy-3 align-items-start">
          <div className="col-md-5"><Photo orderId={orderContext.order.id} available={!!dp.photoAvailable} height={170} /></div>
          <div className="col-md-7">
            <KeyValue cols={1} items={[
              { label: "Method", value: titleCase(dp.method) },
              { label: "PIN verified", value: dp.pinVerified ? "Yes" : "No" },
              { label: "Distance to drop-off", value: dp.distanceMeters != null ? `${dp.distanceMeters} m` : "-" },
              { label: "Delivered", value: fmtDateTime(dp.deliveredAt) },
              { label: "Flags", value: dp.flags?.length ? dp.flags.map(titleCase).join(", ") : "None" },
            ]} />
          </div>
        </div>
      )}
      <div className="d-flex gap-2 flex-wrap mt-16 align-items-center">
        <Link className="btn btn-sm btn-outline-primary-600 radius-8" to={`/orders/${orderContext.order.id}`}>Full evidence</Link>
        {dispute && can("support", "edit") && <Button size="sm" variant="light" onClick={() => setModal(true)}>{outcome ? "Change outcome" : "Record outcome"}</Button>}
        {outcome && <Badge tone={outcome.outcome === "NOT_DELIVERED" ? "danger" : "info"}>{titleCase(outcome.outcome)}</Badge>}
      </div>
      {modal && <OutcomeModal ticketId={ticket.id} current={outcome?.outcome} onClose={() => setModal(false)} onDone={onChanged} />}
    </Card>
  );
}
