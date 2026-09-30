import React from "react";
import { Link } from "react-router-dom";
import { Icon } from "@iconify/react";
import { useFetch } from "../../lib/hooks";
import { timeAgo } from "../../lib/format";
import { Badge, Card, EmptyState, ErrorState, Loading, PageHeader, StatusBadge } from "../../ui";
import { RestaurantActions, listOf } from "./shared";

const STAGES = [
  { status: "APPLIED", label: "1. Applied", icon: "solar:document-add-outline", hint: "Waiting for documents" },
  { status: "DOCS_REVIEW", label: "2. Documents review", icon: "solar:documents-outline", hint: "Approve each required document" },
  { status: "MENU_SETUP", label: "3. Menu review", icon: "solar:chef-hat-outline", hint: "Check the menu, prices and tax classes" },
  { status: "TEST_ORDER", label: "4. Test order & go-live", icon: "solar:rocket-2-outline", hint: "Run a test order, then go live" },
];

export default function Onboarding() {
  const { data, loading, error, reload } = useFetch("/admin/restaurants", { limit: 100, sortBy: "createdAt", sortDir: "ASC" });
  const rows = listOf(data);
  const rejected = rows.filter((r) => r.status === "REJECTED");
  const total = rows.filter((r) => STAGES.some((s) => s.status === r.status)).length;

  return (
    <>
      <PageHeader title="Onboarding pipeline" subtitle="SOP-01: documents review, menu review, test order, go-live" crumbs={[{ label: "Restaurants", to: "/restaurants" }, { label: "Onboarding" }]} />
      {error && <ErrorState error={error} onRetry={reload} />}
      {loading && !data ? (
        <Loading />
      ) : (
        <>
          {total === 0 && (
            <Card className="mb-24">
              <EmptyState icon="solar:check-circle-outline" title="No restaurants are waiting for onboarding" text="New applications appear here as soon as a restaurant applies or is added by the team." />
            </Card>
          )}
          <div className="row gy-4">
            {STAGES.map((stage) => {
              const items = rows.filter((r) => r.status === stage.status);
              return (
                <div className="col-xl-3 col-md-6" key={stage.status}>
                  <div className="card radius-12 border-0 shadow-sm h-100">
                    <div className="card-header py-16 px-20 border-bottom">
                      <div className="d-flex align-items-center justify-content-between gap-2">
                        <h6 className="text-md fw-semibold mb-0 d-flex align-items-center gap-2">
                          <Icon icon={stage.icon} className="text-primary-600 text-xl" /> {stage.label}
                        </h6>
                        <Badge tone={items.length ? "warning" : "neutral"}>{items.length}</Badge>
                      </div>
                      <div className="text-secondary-light text-xs mt-4">{stage.hint}</div>
                    </div>
                    <div className="card-body p-16 d-flex flex-column gap-3">
                      {items.length === 0 && <div className="text-secondary-light text-sm text-center py-24">Nothing in this stage</div>}
                      {items.map((r) => (
                        <div key={r.id} className="border radius-8 p-12">
                          <Link to={`/restaurants/${r.id}`} className="fw-semibold text-primary-light d-block">
                            {r.name}
                          </Link>
                          <div className="text-secondary-light text-xs mb-8">
                            {[r.city, r.phone, `applied ${timeAgo(r.createdAt)}`].filter(Boolean).join(" · ")}
                          </div>
                          {stage.status === "APPLIED" || stage.status === "DOCS_REVIEW" ? (
                            <Link to={`/restaurants/${r.id}?tab=documents`} className="btn btn-primary-600 btn-sm radius-8 px-12 py-6">
                              Review documents
                            </Link>
                          ) : (
                            <RestaurantActions restaurant={r} onChanged={reload} />
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          {rejected.length > 0 && (
            <Card title="Rejected applications" className="mt-24">
              <ul className="list-unstyled mb-0">
                {rejected.map((r) => (
                  <li key={r.id} className="d-flex justify-content-between align-items-center py-8 border-bottom">
                    <Link to={`/restaurants/${r.id}`} className="fw-medium">
                      {r.name}
                    </Link>
                    <span className="d-flex align-items-center gap-3">
                      <span className="text-secondary-light text-sm">{r.statusReason}</span>
                      <StatusBadge status={r.status} />
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}
    </>
  );
}
