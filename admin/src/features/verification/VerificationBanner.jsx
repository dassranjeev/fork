import React from "react";
import { Link } from "react-router-dom";
import { Icon } from "@iconify/react/offline";
import { fmtDate } from "../../lib/format";
import { deadlineInfo } from "./shared";

const LOOK = {
  UNVERIFIED: { cls: "alert-warning", icon: "solar:shield-warning-outline", title: "Not verified yet" },
  PENDING: { cls: "alert-info", icon: "solar:hourglass-outline", title: "Verification in progress" },
  NEEDS_REVIEW: { cls: "alert-warning", icon: "solar:eye-outline", title: "Verification needs a closer look" },
  REJECTED: { cls: "alert-danger", icon: "solar:close-circle-outline", title: "We could not verify your account" },
};

/**
 * What the account holder sees until they are verified: the plain "next step" sentence the API wrote for them and the deadline.
 * `verification` is the { status, method, dueAt, verifiedAt, nextStep } object the portal / apps receive. Renders nothing once verified.
 * `action` ({ label, to | onClick }) adds one button, used to send an owner to the documents they have to upload.
 */
export default function VerificationBanner({ verification, className = "", action }) {
  const v = verification;
  const look = v && LOOK[v.status];
  if (!look) return null;
  const due = deadlineInfo(v.dueAt);
  return (
    <div className={`alert ${look.cls} radius-8 d-flex align-items-start gap-3 ${className}`} role="status" data-testid="verification-banner">
      <Icon icon={look.icon} className="text-2xl flex-shrink-0 mt-1" />
      <div className="flex-grow-1">
        <div className="fw-semibold">{look.title}</div>
        {v.nextStep && <div className="text-sm">{v.nextStep}</div>}
        {due && (
          <div className="text-sm mt-1">
            Deadline: <strong>{fmtDate(v.dueAt)}</strong> ({due.text.charAt(0).toLowerCase() + due.text.slice(1)})
          </div>
        )}
        {action && (
          <div className="mt-8">
            {action.to ? (
              <Link to={action.to} className="btn btn-sm btn-primary-600 radius-8">
                {action.label}
              </Link>
            ) : (
              <button type="button" className="btn btn-sm btn-primary-600 radius-8" onClick={action.onClick}>
                {action.label}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
