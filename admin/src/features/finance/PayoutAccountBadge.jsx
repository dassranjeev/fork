import React from "react";
import { Badge, Button } from "../../ui";
import { http } from "../../lib/api";
import { useFetch, useSubmit } from "../../lib/hooks";
import { useAuth } from "../../lib/auth";
import { fmtDateTime } from "../../lib/format";

const TONE = { ENABLED: "success", PENDING: "warning", RESTRICTED: "danger", NOT_STARTED: "neutral" };
const LABEL = { ENABLED: "Payout account ready", PENDING: "Payout account pending", RESTRICTED: "Payout account restricted", NOT_STARTED: "No payout account" };

export const PayoutStatusBadge = ({ status }) => <Badge tone={TONE[status] || "neutral"}>{LABEL[status] || status || "-"}</Badge>;

/** Stripe Connect payout-account status of a driver (partyId = driver profile id) or a restaurant business (partyId = merchant id), with a "Sync from Stripe" button. */
export default function PayoutAccountBadge({ partyType, partyId, compact = false }) {
  const { can } = useAuth();
  const { data, reload } = useFetch(partyId ? `/admin/finance/payout-accounts/${partyType}/${partyId}` : null);
  const { busy, run } = useSubmit();
  if (!data) return <span className="text-secondary-light">-</span>;
  const sync = () => run(() => http.post(`/admin/finance/payout-accounts/${partyType}/${partyId}/sync`), { success: "Synced from Stripe", onDone: reload });
  return (
    <span className="d-inline-flex flex-wrap align-items-center gap-2" data-testid="payout-account">
      <PayoutStatusBadge status={data.status} />
      {!compact && data.requirementsDue?.length > 0 && <span className="text-xs text-secondary-light">Needs: {data.requirementsDue.slice(0, 3).join(", ")}</span>}
      {!compact && data.bankLast4 && <span className="text-xs text-secondary-light">bank ****{data.bankLast4}</span>}
      {!compact && data.syncedAt && <span className="text-xs text-secondary-light">synced {fmtDateTime(data.syncedAt)}</span>}
      {can("finance", "edit") && data.status !== "NOT_STARTED" && <Button variant="light" loading={busy} onClick={sync} data-testid="payout-sync">Sync from Stripe</Button>}
    </span>
  );
}
