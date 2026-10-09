import React from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useFetch } from "../../lib/hooks";
import { ServiceModeBadge } from "../portal/ServiceMode";
import { Avatar, Badge, ErrorState, Loading, PageHeader, StatusBadge, Tabs } from "../../ui";
import OpenPanelButton from "./OpenPanelButton";
import { MenuAccessCard, MenuAccessBadge } from "./MenuAccess";
import OrderAutomationCard from "../portal/Automation";
import AssistantCard from "./AssistantCard";
import { http } from "../../lib/api";
import { useAuth } from "../../lib/auth";

const adminHttp = { get: (u) => http.get(u), patch: (u, b) => http.patch(u, b) };
import { RestaurantActions, PRE_LIVE } from "./shared";
import PayoutAccountBadge from "../finance/PayoutAccountBadge";
import { CommissionTab, DocumentsTab, HoursTab, LocationTab, MembersTab, MenuTab, OverviewTab, PerformanceTab, ReviewsTab } from "./DetailTabs";

export default function RestaurantDetail() {
  const { id } = useParams();
  const [sp, setSp] = useSearchParams();
  const { can } = useAuth();
  const { data: r, loading, error, reload } = useFetch(`/admin/restaurants/${id}`);

  if (loading && !r) return <Loading />;
  if (error && !r)
    return (
      <>
        <PageHeader title="Restaurant" back="/restaurants" />
        <ErrorState error={error} onRetry={reload} />
      </>
    );
  if (!r) return null;

  const tab = sp.get("tab") || "overview";
  const tabs = [
    { key: "overview", label: "Overview", content: (
        <>
          {r.merchantId && can("finance", "view") && <div className="mb-16 d-flex align-items-center gap-2 flex-wrap"><span className="text-sm text-secondary-light">Payout account (Stripe Connect):</span><PayoutAccountBadge partyType="RESTAURANT" partyId={r.merchantId} /></div>}
          <OverviewTab r={r} reload={reload} />
          <OrderAutomationCard api={adminHttp} path={`/admin/restaurants/${r.id}/automation`} canEdit={can("restaurants", "edit")} className="mt-24" />
          <AssistantCard r={r} className="mt-24" />
        </>
      ),
    },
    { key: "hours", label: "Hours", content: <HoursTab r={r} reload={reload} /> },
    { key: "menu", label: "Menu", content: (
        <>
          <MenuAccessCard r={r} reload={reload} />
          <MenuTab r={r} />
        </>
      ),
    },
    { key: "members", label: "Members", content: <MembersTab r={r} /> },
    { key: "documents", label: "Documents", content: <DocumentsTab r={r} reload={reload} /> },
    { key: "commission", label: "Commission", content: <CommissionTab r={r} reload={reload} /> },
    { key: "location", label: "Location", content: <LocationTab r={r} reload={reload} /> },
    { key: "performance", label: "Performance", content: <PerformanceTab r={r} /> },
    { key: "reviews", label: "Reviews", content: <ReviewsTab r={r} /> },
  ];

  return (
    <>
      <PageHeader
        back="/restaurants"
        title={
          <span className="d-inline-flex align-items-center gap-3 flex-wrap">
            <Avatar name={r.name} src={r.logoUrl} size={40} /> {r.name} <StatusBadge status={r.status} />
            {r.status === "LIVE" && <ServiceModeBadge mode={r.serviceMode} />}
            {r.menuEditStatus === "REQUESTED" && <MenuAccessBadge status="REQUESTED" />}
            {r.openStatus && r.status === "LIVE" && <Badge tone={r.openStatus.open ? "info" : "neutral"}>{r.openStatus.open ? "Open now" : "Closed now"}</Badge>}
          </span>
        }
        subtitle={[r.addressLine1, r.city, r.zone?.name].filter(Boolean).join(" · ")}
        crumbs={[{ label: "Restaurants", to: "/restaurants" }, { label: r.name }]}
        actions={<OpenPanelButton restaurant={r} small={false} />}
      />
      {(r.statusReason || r.pausedUntil) && r.status !== "LIVE" && (
        <div className="alert alert-warning radius-8 mb-16">
          <strong>{r.status.replace(/_/g, " ")}</strong>
          {r.statusReason ? `: ${r.statusReason}` : ""}
          {r.pausedUntil ? ` (auto-resumes ${new Date(r.pausedUntil).toLocaleString()})` : ""}
        </div>
      )}
      {PRE_LIVE.includes(r.status) && (
        <div className="alert alert-info radius-8 mb-16">
          Onboarding in progress. Current step: <strong>{{ APPLIED: "Waiting for documents", DOCS_REVIEW: "Documents review", MENU_SETUP: "Menu review", TEST_ORDER: "Test order and go-live" }[r.status]}</strong>.
        </div>
      )}
      <div className="mb-24">
        <RestaurantActions restaurant={r} onChanged={reload} />
      </div>
      <div className="card radius-12 border-0 shadow-sm">
        <div className="card-body p-24">
          <Tabs tabs={tabs} active={tab} onChange={(k) => setSp({ tab: k }, { replace: true })} />
        </div>
      </div>
    </>
  );
}
