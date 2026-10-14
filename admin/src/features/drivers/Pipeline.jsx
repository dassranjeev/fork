import React from "react";
import { Link } from "react-router-dom";
import { Avatar, ErrorState, Loading, PageHeader, StatusBadge } from "../../ui";
import { useFetch } from "../../lib/hooks";
import { fmtDate, timeAgo, titleCase } from "../../lib/format";
import { VerificationChips } from "../verification/shared";

const STAGES = [
  { key: "APPLIED", hint: "New sign-ups" },
  { key: "DOCS_REVIEW", hint: "Review documents" },
  { key: "BACKGROUND_CHECK", hint: "Check in progress" },
  { key: "TRAINING", hint: "Quiz and modules" },
  { key: "APPROVED", hint: "Ready to activate" },
];

function Column({ stage }) {
  const { data, loading, error, reload } = useFetch("/admin/drivers", { status: stage.key, limit: 50, sortBy: "createdAt", sortDir: "ASC" });
  const rows = data?.data || [];
  return (
    <div className="col-12 col-md-6 col-xl">
      <div className="radius-12 bg-neutral-50 p-12 h-100" style={{ minHeight: 240 }}>
        <div className="d-flex justify-content-between align-items-center px-4 pb-12">
          <div>
            <div className="fw-semibold">{titleCase(stage.key)}</div>
            <div className="text-secondary-light text-xs">{stage.hint}</div>
          </div>
          <span className="badge bg-primary-100 text-primary-600">{data?.meta?.total ?? 0}</span>
        </div>
        {error && <ErrorState error={error} onRetry={reload} />}
        {loading && !data && <Loading minHeight={80} />}
        {!loading && !error && rows.length === 0 && <div className="text-center text-secondary-light text-sm py-24">No drivers</div>}
        <div className="d-flex flex-column gap-2">
          {rows.map((d) => (
            <Link key={d.id} to={`/drivers/${d.id}`} className="card radius-8 border-0 shadow-sm text-decoration-none">
              <div className="card-body p-12">
                <div className="d-flex align-items-center gap-2 mb-2">
                  <Avatar name={d.name} size={30} />
                  <div className="text-truncate">
                    <div className="fw-semibold text-sm text-primary-light text-truncate">{d.name}</div>
                    <div className="text-secondary-light text-xs text-truncate">{d.email}</div>
                  </div>
                </div>
                <div className="d-flex flex-wrap gap-2 align-items-center text-xs text-secondary-light">
                  <span>{titleCase(d.vehicleType)}</span>
                  <span>·</span>
                  <span>Applied {timeAgo(d.createdAt)}</span>
                </div>
                <div className="d-flex flex-wrap gap-2 mt-2 align-items-center">
                  {stage.key === "BACKGROUND_CHECK" && <StatusBadge status={d.backgroundCheckStatus} />}
                  {stage.key === "TRAINING" && <StatusBadge status={d.trainingCompleted ? "Training done" : "Training pending"} tone={d.trainingCompleted ? "success" : "warning"} />}
                  {d.nextDocExpiry && <span className="text-xs text-secondary-light">Doc expiry {fmtDate(d.nextDocExpiry)}</span>}
                  <VerificationChips status={d.verificationStatus} method={d.verificationMethod} dueAt={d.verificationDueAt} />
                </div>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function Pipeline() {
  return (
    <>
      <PageHeader title="Application pipeline" subtitle="SOP-02: docs review, background check, training, approval, activation" crumbs={[{ label: "Drivers", to: "/drivers" }, { label: "Pipeline" }]} />
      <div className="row g-3">
        {STAGES.map((s) => (
          <Column key={s.key} stage={s} />
        ))}
      </div>
    </>
  );
}
