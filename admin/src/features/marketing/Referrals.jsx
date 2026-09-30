import React, { useEffect } from "react";
import { http } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useFetch, useForm, usePagedList, useSubmit } from "../../lib/hooks";
import { fmtDateTime, money } from "../../lib/format";
import { Button, Card, DataTable, FilterSelect, FormRow, IconButton, ListToolbar, Loading, MoneyInput, PageHeader, StatCard, StatusBadge, Switch, useConfirm } from "../../ui";

function Settings() {
  const { can } = useAuth();
  const { busy, run } = useSubmit();
  const { data, loading, error, reload } = useFetch("/admin/referrals/settings");
  const f = useForm({ enabled: true, referrerReward: 0, refereeReward: 0, minSubtotal: 0 });
  useEffect(() => { if (data) f.reset(data); }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  const canEdit = can("promotions", "edit");
  return (
    <Card title="Referral program" subtitle="Both customers get wallet credit once the referred customer's first order is delivered.">
      {loading && !data && <Loading minHeight={80} />}
      {error && <div className="alert alert-danger">{error}</div>}
      {data && (
        <>
          <Switch label="Program enabled" disabled={!canEdit} {...f.bindCheck("enabled")} />
          <FormRow>
            <MoneyInput col={4} label="Referrer reward" disabled={!canEdit} {...f.bind("referrerReward")} />
            <MoneyInput col={4} label="New customer reward" disabled={!canEdit} {...f.bind("refereeReward")} />
            <MoneyInput col={4} label="Min. first-order subtotal" disabled={!canEdit} {...f.bind("minSubtotal")} />
          </FormRow>
          {canEdit && (
            <Button
              loading={busy}
              onClick={() =>
                run(
                  () =>
                    http.patch("/admin/referrals/settings", {
                      enabled: !!f.values.enabled,
                      referrerReward: Number(f.values.referrerReward) || 0,
                      refereeReward: Number(f.values.refereeReward) || 0,
                      minSubtotal: Number(f.values.minSubtotal) || 0,
                    }),
                  { success: "Referral settings saved", onDone: reload }
                )
              }
            >
              Save settings
            </Button>
          )}
        </>
      )}
    </Card>
  );
}

export default function Referrals() {
  const { can } = useAuth();
  const confirm = useConfirm();
  const { run } = useSubmit();
  const list = usePagedList("/admin/referrals", { filters: { status: "" } });
  const { data: st, reload: reloadStats } = useFetch("/admin/referrals/stats");
  const voidRef = async (r) => {
    const c = await confirm({ title: "Void this referral?", message: "No reward will be paid for it.", danger: true, confirmText: "Void" });
    if (c.confirmed)
      run(() => http.post(`/admin/referrals/${r.id}/void`), {
        success: "Referral voided",
        onDone: () => {
          list.reload();
          reloadStats();
        },
      });
  };
  return (
    <>
      <PageHeader title="Referrals" subtitle="Customer referral program settings and activity." crumbs={[{ label: "Referrals" }]} />
      <div className="row gy-3 mb-24">
        <div className="col-md-3 col-6"><StatCard label="Total referrals" value={st ? st.total : "…"} icon="solar:users-group-two-rounded-outline" /></div>
        <div className="col-md-3 col-6"><StatCard label="Pending" value={st ? st.pending : "…"} icon="solar:clock-circle-outline" tone="warning" /></div>
        <div className="col-md-3 col-6"><StatCard label="Rewarded" value={st ? st.rewarded : "…"} icon="solar:check-circle-outline" tone="success" hint={st ? `${st.void} voided` : undefined} /></div>
        <div className="col-md-3 col-6"><StatCard label="Total paid out" value={st ? money(st.totalPaidOut) : "…"} icon="solar:wallet-money-outline" tone="purple" /></div>
      </div>
      <div className="mb-24"><Settings /></div>
      <Card title="Referral activity">
        <ListToolbar list={list} placeholder="Search names…" filters={<FilterSelect value={list.filters.status} onChange={(v) => list.setFilter("status", v)} options={["PENDING", "REWARDED", "VOID"]} placeholder="All statuses" />} />
        <DataTable
          {...list.tableProps}
          error={list.error}
          onRetry={list.reload}
          emptyTitle="No referrals yet"
          emptyText="Referrals appear when a new customer signs up with a friend's code."
          columns={[
            { key: "referrerName", title: "Referrer", render: (r) => <span className="fw-semibold">{r.referrerName || "—"}</span> },
            { key: "refereeName", title: "Referred customer", render: (r) => r.refereeName || "—" },
            { key: "status", title: "Status", render: (r) => <StatusBadge status={r.status} tone={r.status === "REWARDED" ? "success" : r.status === "VOID" ? "neutral" : "warning"} /> },
            { key: "reward", title: "Reward", render: (r) => `${money(r.referrerReward)} + ${money(r.refereeReward)}` },
            { key: "createdAt", title: "Signed up", render: (r) => fmtDateTime(r.createdAt) },
            { key: "rewardedAt", title: "Rewarded", render: (r) => fmtDateTime(r.rewardedAt) },
            { key: "a", title: "", align: "right", render: (r) => can("promotions", "edit") && r.status !== "REWARDED" && r.status !== "VOID" && <IconButton icon="solar:forbidden-circle-outline" title="Void" tone="danger" onClick={() => voidRef(r)} /> },
          ]}
        />
      </Card>
    </>
  );
}
