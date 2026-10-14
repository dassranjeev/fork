import React, { useState } from "react";
import { Icon } from "@iconify/react/offline";
import { toast } from "react-toastify";
import { Button, Card, ErrorState, Loading, PageHeader, StatCard } from "../../ui";
import { errorMessage, http } from "../../lib/api";
import { useFetch } from "../../lib/hooks";
import AccountsSection from "./AccountsSection";
import CertnBanner from "./CertnBanner";
import ForcePanel from "./ForcePanel";
import PolicyCard from "./PolicyCard";
import { AUDIENCE, REFRESH_MS, plural } from "./shared";

const AUDIENCES = ["DRIVER", "BUSINESS"];

/** One row of numbers for an audience: five states, then the two numbers that need attention. */
function CountsRow({ audience, counts }) {
  const a = AUDIENCE[audience];
  const states = [
    { label: "Unverified", value: counts.UNVERIFIED, icon: "solar:shield-warning-outline", tone: counts.UNVERIFIED ? "warning" : "neutral", hint: "Admitted without verification" },
    { label: "Pending", value: counts.PENDING, icon: "solar:hourglass-outline", tone: "info", hint: "Going through a check" },
    { label: "Needs review", value: counts.NEEDS_REVIEW, icon: "solar:eye-outline", tone: counts.NEEDS_REVIEW ? "danger" : "neutral", hint: "Waiting for a person to decide" },
    { label: "Verified", value: counts.VERIFIED, icon: "solar:shield-check-outline", tone: "success", hint: "Checked and approved" },
    { label: "Rejected", value: counts.REJECTED, icon: "solar:close-circle-outline", tone: "neutral", hint: "Not accepted" },
  ];
  return (
    <div className="mb-24" data-testid={`counts-${audience}`}>
      <h6 className="text-md fw-semibold d-flex align-items-center gap-2 mb-12">
        <Icon icon={a.icon} className="text-primary-600 text-xl" /> {a.title}: {counts.total} in total
      </h6>
      <div className="row gy-3">
        {states.map((s) => (
          <div key={s.label} className="col-xl col-md-4 col-6">
            <StatCard {...s} />
          </div>
        ))}
        <div className="col-xl-6 col-md-6">
          <StatCard
            label="Working without verification"
            value={counts.operatingUnverified}
            icon="solar:user-check-rounded-outline"
            tone={counts.operatingUnverified ? "warning" : "success"}
            hint={`${a.many} that can work right now and are not verified yet`}
          />
        </div>
        <div className="col-xl-6 col-md-6">
          <StatCard label="Waiting for a deadline" value={counts.withDeadline} icon="solar:calendar-outline" tone="primary" hint="Must verify by their deadline or are taken off until they do" />
        </div>
      </div>
    </div>
  );
}

/**
 * System > Verification (Super Admin only): how new drivers and businesses are admitted and verified, the numbers behind it, Force
 * verification, and the list of accounts with their verification state. All data comes from /admin/verification.
 */
export default function Verification() {
  const overview = useFetch("/admin/verification", null, { refreshMs: REFRESH_MS });
  const [tick, setTick] = useState(0); // bumps when the accounts table has to reload
  const [sweeping, setSweeping] = useState(false);
  const crumbs = [{ label: "System" }, { label: "Verification" }];
  const ov = overview.data;

  const refresh = () => {
    overview.reload();
    setTick((t) => t + 1);
  };

  const runChecks = async () => {
    setSweeping(true);
    try {
      const r = await http.post("/admin/verification/sweep");
      toast.success(`Checks done: ${plural(r.blocked, "account")} taken off the road or off line, ${plural(r.checksStarted, "Certn check")} started, ${plural(r.reminded, "reminder")} sent.`);
      refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSweeping(false);
    }
  };

  if (overview.loading && !ov) {
    return (
      <>
        <PageHeader title="Verification" subtitle="Registration and verification of drivers and businesses" crumbs={crumbs} />
        <Loading />
      </>
    );
  }
  if (!ov) {
    return (
      <>
        <PageHeader title="Verification" crumbs={crumbs} />
        <ErrorState error={overview.error || "No data"} onRetry={overview.reload} />
      </>
    );
  }

  const section = (audience) => ov[AUDIENCE[audience].key];
  const policies = { DRIVER: section("DRIVER").policy, BUSINESS: section("BUSINESS").policy };

  return (
    <>
      <PageHeader
        title="Verification"
        subtitle="Registration and verification of drivers and businesses. Super Admin only."
        crumbs={crumbs}
        actions={
          <>
            <Button variant="outline" icon="solar:play-circle-outline" loading={sweeping} onClick={runChecks} title="Runs what the server runs every minute: takes accounts past their deadline off the road or off line, starts Certn checks that could not start, and sends reminders">
              Run checks now
            </Button>
            <Button variant="outline" icon="solar:refresh-outline" onClick={refresh}>
              Refresh
            </Button>
          </>
        }
      />
      {overview.error && (
        <div className="alert alert-warning radius-8 mb-24" role="alert">
          Could not refresh: {overview.error}. Showing the last data received.
        </div>
      )}

      <Card className="mb-24" bodyClassName="p-16">
        <p className="mb-0 text-secondary-light text-sm d-flex align-items-start gap-2">
          <Icon icon="solar:info-circle-outline" className="text-lg flex-shrink-0 mt-1" />
          <span>
            For drivers and for businesses separately, choose whether a new account works the moment it signs up (<strong>instant registration</strong>) or is checked first, and how it is checked: by our staff (<strong>manual review</strong>) or automatically with a{" "}
            <strong>Certn</strong> identity and criminal-record check. Accounts admitted without a check are recorded as <strong>Unverified</strong>; <strong>Force verification</strong> puts them through the check, with a deadline. A business is a merchant with its restaurants, and its Certn
            check is run on the owner. Staff can verify, reject or start a check on a single account from its driver or restaurant page.
          </span>
        </p>
      </Card>

      <CertnBanner certn={ov.certn} />

      <div className="row gy-4 mb-24">
        {AUDIENCES.map((aud) => (
          <div key={aud} className="col-xl-6">
            <PolicyCard audience={aud} policy={section(aud).policy} certn={ov.certn} onSaved={refresh} />
          </div>
        ))}
      </div>

      {AUDIENCES.map((aud) => (
        <CountsRow key={aud} audience={aud} counts={section(aud).counts} />
      ))}

      <div className="row gy-4 mb-24">
        {AUDIENCES.map((aud) => (
          <div key={aud} className="col-xl-6">
            <ForcePanel audience={aud} policy={section(aud).policy} counts={section(aud).counts} certn={ov.certn} onDone={refresh} />
          </div>
        ))}
      </div>

      <AccountsSection certn={ov.certn} policies={policies} tick={tick} onChanged={refresh} />
    </>
  );
}
