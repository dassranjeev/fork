import React, { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button, Card, DataTable, FilterSelect, ListToolbar, Segmented, StatusBadge, useConfirm } from "../../ui";
import { usePagedList } from "../../lib/hooks";
import { fmtDate } from "../../lib/format";
import { ForceOneModal } from "./ForcePanel";
import { VerificationDialog } from "./VerificationCard";
import { CheckBadge, Deadline, OPEN_STATUSES, REFRESH_MS, STATUS_OPTIONS, VerificationBadge, methodLabel, plural, startCheckFlow } from "./shared";

const AUDIENCE_OPTIONS = [
  { value: "DRIVER", label: "Drivers" },
  { value: "BUSINESS", label: "Businesses" },
];

const Muted = ({ children }) => <div className="text-secondary-light text-xs text-break">{children}</div>;

// the actions column stays in view while the other columns scroll sideways (not on a phone, where it would cover half of the table)
const STICKY_CSS = "@media (min-width:600px){.bordered-table th.fk-ver-actions,.bordered-table td.fk-ver-actions{position:sticky;right:0;z-index:1;box-shadow:-10px 0 8px -8px rgba(0,0,0,.14)}}";

/** The name (a link to the driver / restaurant page) with the contact details under it. */
function NameCell({ r }) {
  const to = r.audience === "DRIVER" ? `/drivers/${r.id}` : r.restaurantId ? `/restaurants/${r.restaurantId}` : null;
  const business = r.audience === "BUSINESS";
  return (
    <div style={{ maxWidth: 270 }}>
      {to ? (
        <Link to={to} className="fw-semibold text-primary-light text-break" onClick={(e) => e.stopPropagation()}>
          {r.name}
        </Link>
      ) : (
        <span className="fw-semibold text-break">{r.name}</span>
      )}
      {business ? (
        <>
          <Muted>{r.owner ? `Owner: ${r.owner}` : "No owner account"}</Muted>
          <Muted>{[r.ownerEmail || r.email, plural(r.locations || 0, "location")].filter(Boolean).join(" · ")}</Muted>
        </>
      ) : (
        <>
          <Muted>{r.email || "—"}</Muted>
          {r.phone && <Muted>{r.phone}</Muted>}
        </>
      )}
    </div>
  );
}

/**
 * The accounts of one audience with their verification state: audience switch, status filter, search and the row actions
 * Review (the verification card in a dialog), Force (one unverified account) and Start Certn check.
 * `tick` changes when something elsewhere on the page changed the data; `onChanged` tells the page that this table changed something.
 */
export default function AccountsSection({ certn, policies, tick, onChanged }) {
  const confirm = useConfirm();
  const list = usePagedList("/admin/verification/subjects", { filters: { audience: "DRIVER", status: "" }, refreshMs: REFRESH_MS });
  const audience = list.filters.audience;
  const [review, setReview] = useState(null);
  const [forceOne, setForceOne] = useState(null);
  const [busyId, setBusyId] = useState("");

  // reload when the page says something changed elsewhere (not on the first render: the list loads itself)
  const reloadRef = useRef(list.reload);
  reloadRef.current = list.reload;
  useEffect(() => {
    if (tick > 0) reloadRef.current();
  }, [tick]);

  const check = async (r) => {
    setBusyId(r.id);
    try {
      if (await startCheckFlow({ confirm, audience: r.audience, id: r.id, name: r.name })) onChanged();
    } finally {
      setBusyId("");
    }
  };

  const columns = [
    { key: "name", title: audience === "DRIVER" ? "Driver" : "Business", render: (r) => <NameCell r={r} /> },
    {
      key: "account",
      title: "Account",
      render: (r) => (
        <div>
          <StatusBadge status={r.accountStatus} />
          <Muted>{r.operating ? "Working now" : "Not working"}</Muted>
        </div>
      ),
    },
    {
      key: "verification",
      title: "Verification",
      render: (r) => (
        <div>
          <VerificationBadge status={r.verificationStatus} />
          {r.verificationMethod && <Muted>{methodLabel(r.verificationMethod)}</Muted>}
        </div>
      ),
    },
    { key: "due", title: "Deadline", render: (r) => <Deadline value={r.verificationDueAt} /> },
    { key: "check", title: "Certn check", render: (r) => <CheckBadge status={r.backgroundCheckStatus || "NOT_STARTED"} /> },
    { key: "createdAt", title: "Created", render: (r) => fmtDate(r.createdAt) },
    {
      key: "actions",
      title: "",
      align: "right",
      className: "fk-ver-actions",
      render: (r) => (
        <div className="d-flex flex-column align-items-stretch gap-1" onClick={(e) => e.stopPropagation()}>
          <Button variant="outline" icon="solar:eye-outline" onClick={() => setReview(r)}>
            Review
          </Button>
          {r.verificationStatus === "UNVERIFIED" && (
            <Button variant="light" icon="solar:shield-warning-outline" disabled={!!busyId} onClick={() => setForceOne(r)}>
              Force
            </Button>
          )}
          {OPEN_STATUSES.includes(r.verificationStatus) && r.backgroundCheckStatus !== "IN_PROGRESS" && (
            <Button variant="light" icon="solar:play-circle-outline" loading={busyId === r.id} disabled={!!busyId || !certn.ready} title={certn.ready ? undefined : certn.reason || "Certn is not ready"} onClick={() => check(r)}>
              Start Certn check
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <Card title="Accounts" subtitle="Every driver or business with its verification state. Click a row to review it.">
      <style>{STICKY_CSS}</style>
      <ListToolbar
        list={list}
        placeholder={audience === "DRIVER" ? "Search name, email, phone…" : "Search business, email…"}
        filters={
          <>
            <Segmented options={AUDIENCE_OPTIONS} value={audience} onChange={(v) => list.setFilter("audience", v)} />
            <FilterSelect value={list.filters.status} onChange={(v) => list.setFilter("status", v)} options={STATUS_OPTIONS} placeholder="All verification states" />
          </>
        }
      />
      <DataTable
        columns={columns}
        {...list.tableProps}
        error={list.error}
        onRetry={list.reload}
        onRowClick={setReview}
        emptyTitle={`No ${audience === "DRIVER" ? "drivers" : "businesses"} match these filters`}
        emptyText="Try another verification state or clear the search."
      />
      <VerificationDialog account={review} onClose={() => setReview(null)} onChanged={onChanged} />
      {forceOne && (
        <ForceOneModal
          account={forceOne}
          policy={policies[forceOne.audience]}
          certn={certn}
          onClose={() => setForceOne(null)}
          onDone={() => {
            setForceOne(null);
            onChanged();
          }}
        />
      )}
    </Card>
  );
}
