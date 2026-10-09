import React, { useState } from "react";
import { useParams } from "react-router-dom";
import { Icon } from "@iconify/react/offline";
import {
  Avatar, Badge, BoolBadge, Button, Card, DataTable, DateInput, ErrorState, FormModal, FormRow, KeyValue, Loading, MultiCheck, NumberInput,
  PageHeader, Progress, Select, StatusBadge, Switch, Tabs, TextArea, TextInput, useConfirm,
} from "../../ui";
import { http } from "../../lib/api";
import { useFetch, useForm, useSubmit } from "../../lib/hooks";
import { useAuth } from "../../lib/auth";
import { fmtDateTime, money, num, timeAgo, titleCase } from "../../lib/format";
import DriverRatingCard from "../ratings/DriverRatingCard";
import PayoutAccountBadge from "../finance/PayoutAccountBadge";
import { fmtDay as fmtDate } from "./shared";
import { EXPIRY_REQUIRED, VEHICLES, acceptanceTone, fileHref, useZones } from "./shared";

// ------------------------------------------------------------------ small modals
function DocReviewModal({ driverId, doc, onClose, onDone }) {
  const f = useForm({ mode: "APPROVED", rejectReason: "", expiresAt: doc?.expiresAt ? String(doc.expiresAt).slice(0, 10) : "" });
  const { busy, run } = useSubmit();
  if (!doc) return null;
  const v = f.values;
  const needsExpiry = EXPIRY_REQUIRED.includes(doc.type);
  const invalid = v.mode === "REJECTED" ? v.rejectReason.trim().length < 3 : needsExpiry && !v.expiresAt;
  const submit = () =>
    run(
      () =>
        http.patch(`/admin/drivers/${driverId}/documents/${doc.id}`, v.mode === "REJECTED" ? { status: "REJECTED", rejectReason: v.rejectReason } : { status: "APPROVED", ...(v.expiresAt ? { expiresAt: v.expiresAt } : {}) }),
      { success: v.mode === "REJECTED" ? "Document rejected" : "Document approved", onDone }
    );
  return (
    <FormModal open onClose={onClose} title={`Review ${titleCase(doc.type)}`} onSubmit={submit} busy={busy} disabled={invalid} submitText={v.mode === "REJECTED" ? "Reject document" : "Approve document"} submitVariant={v.mode === "REJECTED" ? "danger" : "primary"}>
      {doc.fileUrl && /\.(png|jpe?g|webp|gif)$/i.test(doc.fileUrl) && <img src={fileHref(doc.fileUrl)} alt={doc.type} className="radius-8 w-100 mb-16" onError={(e) => { e.currentTarget.style.display = "none"; }} style={{ maxHeight: 260, objectFit: "contain", background: "var(--neutral-100, #f3f4f6)" }} />}
      <Select label="Decision" allowEmpty={false} options={[{ value: "APPROVED", label: "Approve" }, { value: "REJECTED", label: "Reject" }]} {...f.bind("mode")} />
      {v.mode === "APPROVED" ? (
        <DateInput label="Expiry date (as printed on the document)" required={needsExpiry} hint={needsExpiry ? "Required for licence, insurance and registration" : "Optional"} {...f.bind("expiresAt")} />
      ) : (
        <TextArea label="Reason shown to the driver" required placeholder="e.g. Blurry image, document expired" {...f.bind("rejectReason")} />
      )}
    </FormModal>
  );
}

function InsuranceModal({ driverId, insurance, onClose, onDone }) {
  const f = useForm({ coversDelivery: insurance?.coversDelivery ?? true, expiresAt: insurance?.expiresAt ? String(insurance.expiresAt).slice(0, 10) : "", provider: "", policyNumber: "" });
  const { busy, run } = useSubmit();
  const v = f.values;
  return (
    <FormModal open onClose={onClose} title="Insurance confirmation" busy={busy} disabled={!v.expiresAt} onSubmit={() => run(() => http.put(`/admin/drivers/${driverId}/insurance`, v), { success: "Insurance saved", onDone })}>
      <Switch label="Policy covers delivery use" checked={v.coversDelivery} onChange={(x) => f.set("coversDelivery", x)} />
      <FormRow>
        <DateInput col={6} label="Policy expiry" required {...f.bind("expiresAt")} />
        <TextInput col={6} label="Provider" {...f.bind("provider")} />
        <TextInput col={12} label="Policy number" {...f.bind("policyNumber")} />
      </FormRow>
    </FormModal>
  );
}

function ActivateModal({ driver, mode, onClose, onDone }) {
  const { options } = useZones();
  const f = useForm({ zoneIds: driver.zoneIds || [], insulatedBagConfirmed: !!driver.insulatedBagConfirmed, note: "", override: false });
  const { busy, run } = useSubmit();
  const { isSuper } = useAuth();
  const v = f.values;
  const activate = mode === "activate";
  const submit = () => {
    const url = `/admin/drivers/${driver.id}/${activate ? "activate" : "approve"}`;
    const body = activate
      ? { zoneIds: v.zoneIds, insulatedBagConfirmed: v.insulatedBagConfirmed }
      : { ...(v.zoneIds.length ? { zoneIds: v.zoneIds } : {}), insulatedBagConfirmed: v.insulatedBagConfirmed, note: v.note || undefined, override: v.override || undefined };
    return run(() => http.post(url, body), { success: activate ? "Driver activated" : "Driver approved", onDone });
  };
  return (
    <FormModal open onClose={onClose} title={activate ? "Activate driver" : "Approve driver"} submitText={activate ? "Activate" : "Approve"} onSubmit={submit} busy={busy} disabled={activate && (!v.zoneIds.length || !v.insulatedBagConfirmed)}>
      <MultiCheck label={activate ? "Zones to activate for" : "Zones (optional - selecting zones approves and activates in one step)"} options={options} value={v.zoneIds} onChange={(z) => f.set("zoneIds", z)} cols={2} />
      <Switch label="Insulated bag confirmed" checked={v.insulatedBagConfirmed} onChange={(x) => f.set("insulatedBagConfirmed", x)} />
      {!activate && <TextArea label="Note" {...f.bind("note")} />}
      {!activate && isSuper && <Switch label="Override checklist gates" hint="Bypasses missing documents / background / training. Audit-logged." checked={v.override} onChange={(x) => f.set("override", x)} />}
    </FormModal>
  );
}

function ReasonModal({ title, url, confirmText, danger, withDays, optional, onClose, onDone }) {
  const f = useForm({ reason: "", respondWithinDays: "", evidence: "" });
  const { busy, run } = useSubmit();
  const v = f.values;
  const body = { reason: v.reason || undefined, ...(withDays ? { respondWithinDays: v.respondWithinDays === "" ? undefined : v.respondWithinDays, evidence: v.evidence || undefined } : {}) };
  return (
    <FormModal open onClose={onClose} title={title} submitText={confirmText} submitVariant={danger ? "danger" : "primary"} busy={busy} disabled={!optional && v.reason.trim().length < 3} onSubmit={() => run(() => http.post(url, body), { success: "Done", onDone })}>
      <TextArea label="Reason" required={!optional} {...f.bind("reason")} />
      {withDays && (
        <>
          <NumberInput label="Driver can respond within (days)" min={0} max={60} hint="Leave empty for the platform default" {...f.bind("respondWithinDays")} />
          <TextArea label="Evidence / links" rows={2} {...f.bind("evidence")} />
        </>
      )}
    </FormModal>
  );
}

function BackgroundModal({ driverId, onClose, onDone }) {
  const f = useForm({ status: "CLEAR", note: "" });
  const { busy, run } = useSubmit();
  return (
    <FormModal open onClose={onClose} title="Override background check" busy={busy} disabled={f.values.note.trim().length < 3} onSubmit={() => run(() => http.post(`/admin/drivers/${driverId}/background-check/override`, f.values), { success: "Background check updated", onDone })}>
      <Select label="Result" allowEmpty={false} options={["CLEAR", "CONSIDER", "FAILED"]} {...f.bind("status")} />
      <TextArea label="Note" required {...f.bind("note")} />
    </FormModal>
  );
}

function ZonesModal({ driver, onClose, onDone }) {
  const { options } = useZones();
  const [ids, setIds] = useState(driver.zoneIds || []);
  const { busy, run } = useSubmit();
  return (
    <FormModal open onClose={onClose} title="Driver zones" busy={busy} onSubmit={() => run(() => http.put(`/admin/drivers/${driver.id}/zones`, { zoneIds: ids }), { success: "Zones updated", onDone })}>
      <MultiCheck options={options} value={ids} onChange={setIds} cols={2} />
    </FormModal>
  );
}

function EditModal({ driver, onClose, onDone }) {
  const f = useForm({
    firstName: driver.user?.firstName || "", lastName: driver.user?.lastName || "", phone: driver.phone || "", vehicleType: driver.vehicleType || "CAR",
    vehicleMake: driver.vehicle?.make || "", vehicleModel: driver.vehicle?.model || "", vehicleColor: driver.vehicle?.color || "", licensePlate: driver.vehicle?.licensePlate || "",
    payoutSchedule: driver.payoutSchedule || "WEEKLY", notes: driver.notes || "",
  });
  const { busy, run } = useSubmit();
  const strip = (o) => Object.fromEntries(Object.entries(o).filter(([, x]) => x !== ""));
  return (
    <FormModal open onClose={onClose} title="Edit driver" size="lg" busy={busy} onSubmit={() => run(() => http.patch(`/admin/drivers/${driver.id}`, strip(f.values)), { success: "Driver updated", onDone })}>
      <FormRow>
        <TextInput col={6} label="First name" {...f.bind("firstName")} />
        <TextInput col={6} label="Last name" {...f.bind("lastName")} />
        <TextInput col={6} label="Phone" {...f.bind("phone")} />
        <Select col={6} label="Payout schedule" allowEmpty={false} options={["WEEKLY", "INSTANT"]} {...f.bind("payoutSchedule")} />
        <Select col={4} label="Vehicle" allowEmpty={false} options={VEHICLES} {...f.bind("vehicleType")} />
        <TextInput col={4} label="Make" {...f.bind("vehicleMake")} />
        <TextInput col={4} label="Model" {...f.bind("vehicleModel")} />
        <TextInput col={6} label="Colour" {...f.bind("vehicleColor")} />
        <TextInput col={6} label="Licence plate" {...f.bind("licensePlate")} />
        <TextArea col={12} label="Internal notes" {...f.bind("notes")} />
      </FormRow>
    </FormModal>
  );
}

// ------------------------------------------------------------------ tabs
function Overview({ d, reload, can }) {
  const [modal, setModal] = useState(null);
  const ob = d.onboarding || {};
  const bc = d.backgroundCheck || {};
  const close = () => setModal(null);
  const done = () => { close(); reload(); };
  const { run, busy } = useSubmit();
  const canEdit = can("drivers", "edit");
  return (
    <div className="row gy-4">
      <div className="col-xl-7">
        <Card title="Profile" actions={canEdit && <Button variant="light" icon="solar:pen-outline" onClick={() => setModal("edit")}>Edit</Button>}>
          <KeyValue
            items={[
              { label: "Email", value: d.email },
              { label: "Phone", value: d.phone },
              { label: "City", value: d.city?.name },
              { label: "Vehicle", value: [titleCase(d.vehicle?.type), d.vehicle?.color, d.vehicle?.make, d.vehicle?.model].filter(Boolean).join(" · ") },
              { label: "Licence plate", value: d.vehicle?.licensePlate },
              { label: "Payout schedule", value: titleCase(d.payoutSchedule) },
              { label: "Payout account (Stripe)", value: <PayoutAccountBadge partyType="DRIVER" partyId={d.id} /> },
              { label: "Bank", value: d.bank ? `${d.bank.institution}-${d.bank.transit} ${d.bank.account}` : "Not provided" },
              { label: "Tax info (T4A)", value: d.taxInfo ? `${d.taxInfo.legalName} · SIN ${d.taxInfo.sin}` : "Not provided" },
              { label: "Ontario notice acknowledged", value: <BoolBadge value={d.ontarioNoticeAcked} /> },
              { label: "Insulated bag", value: <BoolBadge value={d.insulatedBagConfirmed} /> },
              { label: "Applied", value: fmtDateTime(d.createdAt) },
              { label: "Approved", value: fmtDateTime(d.approvedAt) },
              { label: "Last login", value: fmtDateTime(d.user?.lastLoginAt) },
              { label: "Notes", value: d.notes },
            ]}
          />
        </Card>
        <Card className="mt-24" title="Zones" actions={canEdit && <Button variant="light" icon="solar:map-point-outline" onClick={() => setModal("zones")}>Edit zones</Button>}>
          {d.zones?.length ? <div className="d-flex flex-wrap gap-2">{d.zones.map((z) => <Badge key={z.id} tone="primary">{z.name}</Badge>)}</div> : <span className="text-secondary-light">Not activated for any zone.</span>}
        </Card>
      </div>
      <div className="col-xl-5">
        <Card title="Onboarding checklist" subtitle={ob.complete ? "Complete" : `${ob.missing?.length || 0} step(s) outstanding`}>
          <Progress value={ob.percent || 0} label="Progress" />
          <ul className="list-unstyled mt-16 mb-0 d-flex flex-column gap-2">
            {(ob.steps || []).map((s) => (
              <li key={s.key} className="d-flex align-items-start gap-2">
                <Icon icon={s.done ? "solar:check-circle-bold" : "solar:clock-circle-outline"} className={`text-xl mt-1 ${s.done ? "text-success-main" : "text-warning-main"}`} />
                <div className="flex-grow-1">
                  <div className={`text-sm ${s.done ? "" : "fw-semibold"}`}>{s.label}</div>
                  {s.detail && <div className="text-xs text-secondary-light">{s.detail}</div>}
                </div>
                <span className="text-xs text-secondary-light">{s.owner === "OPS" ? "Ops" : "Driver"}</span>
              </li>
            ))}
          </ul>
        </Card>
        <Card className="mt-24" title="Insurance" actions={canEdit && <Button variant="light" onClick={() => setModal("insurance")}>Confirm</Button>}>
          {d.insurance ? (
            <KeyValue cols={2} items={[{ label: "Covers delivery", value: <BoolBadge value={d.insurance.coversDelivery} /> }, { label: "Expires", value: fmtDate(d.insurance.expiresAt) }]} />
          ) : (
            <span className="text-secondary-light">Not confirmed yet.</span>
          )}
        </Card>
        <Card
          className="mt-24"
          title="Background check"
          actions={
            <>
              {canEdit && <Button variant="light" loading={busy} onClick={() => run(() => http.post(`/admin/drivers/${d.id}/background-check/start`), { success: "Background check started", onDone: reload })}>Start check</Button>}
              {can("drivers", "approve") && <Button variant="light" onClick={() => setModal("bg")}>Override</Button>}
            </>
          }
        >
          <KeyValue cols={2} items={[{ label: "Status", value: <StatusBadge status={bc.status || d.backgroundCheckStatus} /> }, { label: "Provider", value: bc.provider }, { label: "Reference", value: bc.ref }]} />
          {bc.history?.length > 0 && (
            <ul className="mt-12 mb-0 text-sm text-secondary-light">
              {bc.history.map((h, i) => (
                <li key={i}>{[h.status, h.note, h.at && fmtDateTime(h.at)].filter(Boolean).join(" · ")}</li>
              ))}
            </ul>
          )}
        </Card>
        <Card className="mt-24" title="Training" subtitle={d.training?.completed ? "Completed" : "Not completed"}>
          {(d.training?.modules || []).length === 0 && <span className="text-secondary-light">No training modules configured.</span>}
          {(d.training?.modules || []).map((m) => (
            <div key={m.moduleId} className="d-flex justify-content-between align-items-center py-8 border-bottom">
              <div>
                <div className="text-sm fw-medium">{m.title}</div>
                <div className="text-xs text-secondary-light">{m.attempts} attempt(s) · best {m.bestScore ?? "—"} / pass {m.passMark}</div>
              </div>
              <StatusBadge status={m.passed ? "Passed" : "Pending"} tone={m.passed ? "success" : "warning"} />
            </div>
          ))}
        </Card>
      </div>
      {modal === "edit" && <EditModal driver={d} onClose={close} onDone={done} />}
      {modal === "zones" && <ZonesModal driver={d} onClose={close} onDone={done} />}
      {modal === "insurance" && <InsuranceModal driverId={d.id} insurance={d.insurance} onClose={close} onDone={done} />}
      {modal === "bg" && <BackgroundModal driverId={d.id} onClose={close} onDone={done} />}
    </div>
  );
}

function Documents({ d, reload, can }) {
  const [review, setReview] = useState(null);
  const docs = d.documents || [];
  const reqByDoc = Object.fromEntries((d.requiredDocuments || []).map((r) => [r.documentId, r]));
  const missing = (d.requiredDocuments || []).filter((r) => !r.uploaded);
  return (
    <>
      {missing.length > 0 && (
        <div className="alert alert-warning radius-8 mb-16">
          Missing required documents: {missing.map((m) => titleCase(m.type)).join(", ")}
        </div>
      )}
      <Card noPadding bodyClassName="p-0">
        <DataTable
          rowKey="id"
          rows={docs}
          emptyTitle="No documents uploaded"
          emptyText="The driver has not uploaded any documents yet."
          columns={[
            { key: "type", title: "Document", render: (x) => <span className="fw-medium">{titleCase(x.type)}</span> },
            { key: "status", title: "Status", render: (x) => <StatusBadge status={x.status} /> },
            { key: "expiresAt", title: "Expires", render: (x) => (reqByDoc[x.id]?.expired ? <span className="text-danger-main">{fmtDate(x.expiresAt)} (expired)</span> : fmtDate(x.expiresAt)) },
            { key: "rejectReason", title: "Reject reason", render: (x) => x.rejectReason || "—" },
            { key: "createdAt", title: "Uploaded", render: (x) => fmtDate(x.createdAt) },
            {
              key: "a",
              title: "",
              align: "right",
              render: (x) => (
                <div className="d-flex gap-2 justify-content-end">
                  {x.fileUrl && <a className="btn btn-sm btn-outline-neutral-300 text-primary-light radius-8" href={fileHref(x.fileUrl)} target="_blank" rel="noopener noreferrer">View</a>}
                  {can("drivers", "approve") && <Button variant={x.status === "PENDING" ? "primary" : "light"} onClick={() => setReview(x)}>Review</Button>}
                </div>
              ),
            },
          ]}
        />
      </Card>
      {review && <DocReviewModal driverId={d.id} doc={review} onClose={() => setReview(null)} onDone={() => { setReview(null); reload(); }} />}
    </>
  );
}

function AcceptanceCard({ d }) {
  const a = d.performance?.acceptance || d.acceptance || {};
  const { data, loading } = useFetch(`/admin/drivers/${d.id}/offers`, { days: a.windowDays || 14 });
  const rows = data?.offers || [];
  const tone = acceptanceTone(a.rate);
  const tile = (label, value, cls = "") => (
    <div className="col-6 col-md-3">
      <div className="border radius-8 p-12"><div className="text-secondary-light text-xs">{label}</div><div className={`fw-semibold fs-5 ${cls}`}>{value}</div></div>
    </div>
  );
  return (
    <Card
      title={`Acceptance score · rolling ${a.windowDays || 14} days`}
      subtitle={`accepted ÷ (accepted + declined + expired); blends toward 90% under 5 offers. Updated ${a.lastUpdatedAt ? timeAgo(a.lastUpdatedAt) : "—"}`}
      className="mb-24"
    >
      <div className="row g-3 mb-16">
        <div className="col-6 col-md-3">
          <div className="border radius-8 p-12"><div className="text-secondary-light text-xs">Acceptance rate</div><div className="fs-4"><Badge tone={tone}>{num(a.rate)}%</Badge></div></div>
        </div>
        {tile("Accepted", num(a.accepted), "text-success-main")}
        {tile("Declined", num(a.declined))}
        {tile("Expired (ignored)", num(a.expired), a.expired ? "text-warning-main" : "")}
      </div>
      <DataTable
        rows={rows}
        loading={loading}
        emptyTitle="No offers in this window"
        columns={[
          { key: "sentAt", title: "Offer time", render: (o) => fmtDateTime(o.sentAt) },
          { key: "orderCode", title: "Order", render: (o) => o.orderCode || "—" },
          { key: "outcome", title: "Outcome", render: (o) => <StatusBadge status={o.outcome} tone={o.outcome === "ACCEPTED" ? "success" : o.outcome === "EXPIRED" ? "warning" : o.outcome === "DECLINED" ? "danger" : "neutral"} /> },
          { key: "responseSec", title: "Response", render: (o) => (o.responseSec != null ? `${o.responseSec}s` : o.outcome === "EXPIRED" ? "no response" : "—") },
          { key: "declineReason", title: "Decline reason", render: (o) => o.declineReason || "—" },
        ]}
      />
    </Card>
  );
}

function Performance({ d }) {
  const p = d.performance || {};
  const tiles = [
    ["Rating", p.ratingCount >= 5 ? `${Number(p.rating).toFixed(2)} (${p.ratingCount})` : p.ratingCount ? `New (${p.ratingCount})` : "—"],
    ["Acceptance (14d)", `${num(p.acceptanceRate)}%`],
    ["Completion", `${num(p.completionRate)}%`],
    ["On time", `${num(p.onTimeRate)}%`],
    ["Total trips", num(p.totalTrips)],
    ["Cancellations", num(p.cancellations)],
    ["Delivery disputes (30d)", `${num(p.deliveryDisputes30d)} (total ${num(p.deliveryDisputesTotal)})`],
  ];
  return (
    <>
      <div className="row g-3 mb-24">
        {tiles.map(([l, v]) => (
          <div key={l} className="col-6 col-md-4 col-xl-2">
            <div className="card radius-12 border-0 shadow-sm"><div className="card-body p-16"><div className="text-secondary-light text-sm">{l}</div><div className="fw-semibold fs-5">{v}</div></div></div>
          </div>
        ))}
      </div>
      <DriverRatingCard driverId={d.id} />
      <AcceptanceCard d={d} />
      <Card title="Recent offers" noPadding bodyClassName="p-0">
        <DataTable
          rows={d.offers || []}
          emptyTitle="No offers yet"
          columns={[
            { key: "sentAt", title: "Sent", render: (o) => fmtDateTime(o.sentAt) },
            { key: "status", title: "Result", render: (o) => <StatusBadge status={o.status} tone={o.status === "ACCEPTED" ? "success" : o.status === "EXPIRED" ? "warning" : "neutral"} /> },
            { key: "estimatedPay", title: "Est. pay", render: (o) => money(o.estimatedPay) },
            { key: "boostAmount", title: "Boost", render: (o) => (o.boostAmount ? money(o.boostAmount) : "—") },
            { key: "declineReason", title: "Decline reason", render: (o) => o.declineReason || "—" },
          ]}
        />
      </Card>
      {(d.cases?.length > 0 || d.sosAlerts?.length > 0) && (
        <div className="row gy-4 mt-0">
          {d.cases?.length > 0 && (
            <div className="col-lg-6">
              <Card title="Cases" className="mt-24">
                {d.cases.map((c, i) => <div key={c.id || i} className="py-8 border-bottom text-sm">{[c.number || c.id, c.subject, c.status].filter(Boolean).join(" · ")}</div>)}
              </Card>
            </div>
          )}
          {d.sosAlerts?.length > 0 && (
            <div className="col-lg-6">
              <Card title="SOS alerts" className="mt-24">
                {d.sosAlerts.map((s) => (
                  <div key={s.id} className="py-8 border-bottom text-sm d-flex justify-content-between">
                    <span>{s.message || "SOS"} · {timeAgo(s.createdAt)}</span>
                    <StatusBadge status={s.status} />
                  </div>
                ))}
              </Card>
            </div>
          )}
        </div>
      )}
    </>
  );
}

function Earnings({ d }) {
  const e = d.earnings || {};
  const l = e.last30d || {};
  const total30 = (l.basePay || 0) + (l.tips || 0) + (l.boosts || 0);
  return (
    <>
      <div className="row g-3 mb-24">
        {[
          ["Unpaid balance", money(e.unpaidBalance)],
          ["Lifetime earnings", money(e.lifetime)],
          ["Last 30d total", money(total30)],
          ["Last 30d trips", num(l.trips)],
          ["Base pay", money(l.basePay)],
          ["Tips", money(l.tips)],
          ["Boosts", money(l.boosts)],
        ].map(([t, v]) => (
          <div key={t} className="col-6 col-md-4 col-xl-3">
            <div className="card radius-12 border-0 shadow-sm"><div className="card-body p-16"><div className="text-secondary-light text-sm">{t}</div><div className="fw-semibold fs-5">{v}</div></div></div>
          </div>
        ))}
      </div>
      <Card title="Recent trips" noPadding bodyClassName="p-0">
        <DataTable
          rows={d.recentTrips || []}
          emptyTitle="No trips yet"
          columns={[
            { key: "code", title: "Order", render: (t) => <span className="fw-semibold">{t.code}</span> },
            { key: "restaurant", title: "Restaurant" },
            { key: "status", title: "Status", render: (t) => <StatusBadge status={t.status} /> },
            { key: "createdAt", title: "Date", render: (t) => fmtDateTime(t.createdAt) },
            { key: "distanceKm", title: "Distance", render: (t) => (t.distanceKm != null ? `${Number(t.distanceKm).toFixed(1)} km` : "—") },
            { key: "driverPay", title: "Pay", align: "right", render: (t) => money(t.driverPay) },
            { key: "tip", title: "Tip", align: "right", render: (t) => money(t.tip) },
            { key: "boost", title: "Boost", align: "right", render: (t) => (t.boost ? money(t.boost) : "—") },
          ]}
        />
      </Card>
    </>
  );
}

function ShiftsTab({ d }) {
  const { data, loading, error, reload } = useFetch("/admin/drivers/shifts", { driverId: d.id, limit: 50 });
  const { nameOf } = useZones();
  const rows = data?.data || [];
  return (
    <Card noPadding bodyClassName="p-0" title="Booked shifts">
      {error && <ErrorState error={error} onRetry={reload} />}
      <DataTable
        rows={rows}
        loading={loading}
        emptyTitle="No shifts booked"
        emptyText="Drivers book shifts from the driver app once slots are published."
        columns={[
          { key: "zone", title: "Zone", render: (s) => s.zoneName || nameOf(s.zoneId) },
          { key: "startsAt", title: "Starts", render: (s) => fmtDateTime(s.startsAt) },
          { key: "endsAt", title: "Ends", render: (s) => fmtDateTime(s.endsAt) },
          { key: "status", title: "Status", render: (s) => <StatusBadge status={s.status} /> },
        ]}
      />
    </Card>
  );
}

// ------------------------------------------------------------------ page
export default function DriverDetail() {
  const { id } = useParams();
  const { data: d, loading, error, reload } = useFetch(`/admin/drivers/${id}`);
  const { can } = useAuth();
  const { busy, run } = useSubmit();
  const confirm = useConfirm();
  const [modal, setModal] = useState(null);
  const close = () => setModal(null);
  const done = () => { close(); reload(); };

  if (loading && !d) return <Loading />;
  if (error && !d) return (<><PageHeader title="Driver" back="/drivers" /><ErrorState error={error} onRetry={reload} /></>);
  if (!d) return null;

  const approve = can("drivers", "approve");
  const edit = can("drivers", "edit");
  const s = d.status;
  const live = d.onTrip ? ["On trip", "purple"] : d.isOnline ? ["Online", "success"] : ["Offline", "neutral"];

  const startReview = () => run(() => http.post(`/admin/drivers/${d.id}/start-review`), { success: "Review started", onDone: reload });
  const reinstate = async () => {
    const r = await confirm({ title: "Reinstate driver?", message: "The driver returns to active status.", prompt: { label: "Reason (optional)", type: "textarea" } });
    if (r.confirmed) run(() => http.post(`/admin/drivers/${d.id}/reinstate`, { reason: r.value || undefined }), { success: "Driver reinstated", onDone: reload });
  };

  const actions = (
    <>
      {edit && s === "APPLIED" && <Button icon="solar:play-outline" loading={busy} onClick={startReview}>Start review</Button>}
      {approve && ["DOCS_REVIEW", "BACKGROUND_CHECK", "TRAINING"].includes(s) && <Button variant="success" icon="solar:check-circle-outline" onClick={() => setModal("approve")}>Approve</Button>}
      {approve && s === "APPROVED" && <Button variant="success" icon="solar:rocket-2-outline" onClick={() => setModal("activate")}>Activate</Button>}
      {approve && ["APPLIED", "DOCS_REVIEW", "BACKGROUND_CHECK", "TRAINING", "APPROVED"].includes(s) && <Button variant="outline-danger" onClick={() => setModal("reject")}>Reject</Button>}
      {approve && s === "ACTIVE" && <Button variant="warning" icon="solar:pause-circle-outline" onClick={() => setModal("suspend")}>Suspend</Button>}
      {approve && ["ACTIVE", "SUSPENDED"].includes(s) && <Button variant="outline-danger" icon="solar:user-block-outline" onClick={() => setModal("deactivate")}>Deactivate</Button>}
      {approve && ["SUSPENDED", "DEACTIVATED"].includes(s) && <Button icon="solar:restart-outline" onClick={reinstate}>Reinstate</Button>}
    </>
  );

  return (
    <>
      <PageHeader title={d.name} subtitle={d.email} back="/drivers" crumbs={[{ label: "Drivers", to: "/drivers" }, { label: d.name }]} actions={actions} />
      <Card className="mb-24">
        <div className="d-flex flex-wrap align-items-center gap-3">
          <Avatar name={d.name} size={56} />
          <div className="flex-grow-1">
            <div className="d-flex flex-wrap align-items-center gap-2">
              <StatusBadge status={s} />
              <StatusBadge status={live[0]} tone={live[1]} />
              {d.rating != null && d.ratingCount >= 5 && <Badge tone="warning"><Icon icon="solar:star-bold" className="me-1" />{Number(d.rating).toFixed(2)}</Badge>}
            </div>
            {d.statusReason && <div className="text-secondary-light text-sm mt-8">Reason: {d.statusReason}</div>}
          </div>
          <div className="d-flex gap-4 flex-wrap text-center">
            <div><div className="text-secondary-light text-xs">Trips</div><div className="fw-semibold">{num(d.totalTrips)}</div></div>
            <div><div className="text-secondary-light text-xs">Unpaid</div><div className="fw-semibold">{money(d.earnings?.unpaidBalance)}</div></div>
            <div><div className="text-secondary-light text-xs">Last seen</div><div className="fw-semibold">{d.lastLocationAt ? timeAgo(d.lastLocationAt) : "—"}</div></div>
          </div>
        </div>
      </Card>
      <Tabs
        tabs={[
          { key: "overview", label: "Profile & onboarding", content: <Overview d={d} reload={reload} can={can} /> },
          { key: "docs", label: "Documents", badge: (d.documents || []).filter((x) => x.status === "PENDING").length, content: <Documents d={d} reload={reload} can={can} /> },
          { key: "perf", label: "Performance", content: <Performance d={d} /> },
          { key: "earn", label: "Earnings & trips", content: <Earnings d={d} /> },
          { key: "shifts", label: "Shifts", content: <ShiftsTab d={d} /> },
        ]}
      />
      {(modal === "approve" || modal === "activate") && <ActivateModal driver={d} mode={modal} onClose={close} onDone={done} />}
      {modal === "reject" && <ReasonModal title="Reject application" url={`/admin/drivers/${d.id}/reject`} confirmText="Reject" danger onClose={close} onDone={done} />}
      {modal === "suspend" && <ReasonModal title="Suspend driver" url={`/admin/drivers/${d.id}/suspend`} confirmText="Suspend" danger withDays onClose={close} onDone={done} />}
      {modal === "deactivate" && <ReasonModal title="Deactivate driver" url={`/admin/drivers/${d.id}/deactivate`} confirmText="Deactivate" danger withDays onClose={close} onDone={done} />}
    </>
  );
}
