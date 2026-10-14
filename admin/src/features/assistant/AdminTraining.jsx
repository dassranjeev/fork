import React, { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { toast } from "react-toastify";
import { http } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { fmtDateTime } from "../../lib/format";
import { useFetch, usePagedList } from "../../lib/hooks";
import { Badge, Button, Card, DataTable, EmptyState, ErrorState, ListToolbar, Loading, Modal, PageHeader, StatCard, Switch, useConfirm } from "../../ui";
import TrainingArea from "./training/TrainingArea";
import { pct, problem } from "./training/kit";

const BASE = "/admin/assistant/training";

function RequestDetail({ id, onClose }) {
  const { data, error } = useFetch(`${BASE}/requests/${id}`);
  return (
    <Modal open onClose={onClose} title="What changes if you approve" footer={<Button variant="light" onClick={onClose}>Close</Button>}>
      {error && <ErrorState error={error} />}
      {!data && !error && <Loading />}
      {data && (
        <>
          <div className="mb-8">
            <b>{data.restaurantName}</b> · requested by {data.requestedByName} · {fmtDateTime(data.createdAt)}
            {data.note ? <div className="text-secondary-light">"{data.note}"</div> : null}
          </div>
          <ul className="ps-20">
            <li>New answers: {data.diff.added.length ? data.diff.added.join(", ") : "none"}</li>
            <li>Changed answers: {data.diff.changed.length ? data.diff.changed.join(", ") : "none"}</li>
            <li>Removed answers: {data.diff.removed.length ? data.diff.removed.join(", ") : "none"}</li>
            <li>
              Nicknames {data.diff.aliases >= 0 ? "+" : ""}
              {data.diff.aliases}, documents {data.diff.documents >= 0 ? "+" : ""}
              {data.diff.documents}
            </li>
            {data.diff.held.length > 0 && <li className="text-warning-main">Held by guardrails (not live): {data.diff.held.join(", ")}</li>}
            {data.regressions > 0 && <li className="text-danger-main">{data.regressions} saved test case(s) would fail</li>}
          </ul>
        </>
      )}
    </Modal>
  );
}

/** Admin > Assistant > Training: approval queue, answers held by guardrails, platform numbers. */
export function AdminTrainingOverview() {
  const { can } = useAuth();
  const confirm = useConfirm();
  const canEdit = can("restaurants", "edit");
  const { data, loading, error, reload } = useFetch(`${BASE}/overview`);
  const [detail, setDetail] = useState(null);

  const decide = async (r, approve) => {
    const res = await confirm({
      title: approve ? `Approve ${r.restaurantName}?` : `Reject ${r.restaurantName}?`,
      message: approve ? "The requested version goes live at once." : "The restaurant sees your note.",
      confirmText: approve ? "Approve and publish" : "Reject",
      danger: !approve,
      prompt: { label: approve ? "Note (optional)" : "Why? (the restaurant sees this)", type: "textarea", required: !approve },
    });
    if (!res.confirmed) return;
    try {
      await http.post(`${BASE}/requests/${r.id}/${approve ? "approve" : "reject"}`, { note: res.value || undefined });
      toast.success(approve ? "Approved: the new version is live" : "Rejected");
      reload();
    } catch (e) {
      toast.error(problem(e).message);
    }
  };
  const held = async (h, release) => {
    const res = await confirm({ title: release ? `Release "${h.title}"?` : `Reject and remove "${h.title}"?`, message: release ? "You confirm this text is fine to show customers. The restaurant still has to publish." : "It is deleted from the restaurant's draft.", confirmText: release ? "Release" : "Remove", danger: !release });
    if (!res.confirmed) return;
    const base = h.restaurantId ? `${BASE}/restaurants/${h.restaurantId}` : `${BASE}/central`;
    try {
      await http.post(`${base}/held/${h.kind}/${h.id}/${release ? "release" : "reject"}`, {});
      toast.success(release ? "Released" : "Removed");
      reload();
    } catch (e) {
      toast.error(problem(e).message);
    }
  };
  const toggleApproval = async (v) => {
    try {
      await http.put("/admin/settings", { values: { "assistant.training.requireApproval": v } });
      toast.success(v ? "Restaurants now need approval to publish" : "Restaurants publish directly");
      reload();
    } catch (e) {
      toast.error(problem(e).message);
    }
  };

  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return null;
  const s = data.stats;

  return (
    <>
      <PageHeader title="Bot training" subtitle="Approvals, guardrail reviews and how well the bots answer" crumbs={[{ label: "Assistant", to: "/assistant" }, { label: "Training" }]} actions={<Link className="btn btn-outline-primary-600 btn-sm radius-8" to="/assistant/training/restaurants">Restaurant coverage</Link>} />
      <div className="row g-3 mb-20">
        <div className="col-6 col-xl-3"><StatCard label="Bots with training data" value={s.bots} icon="solar:chat-round-dots-outline" /></div>
        <div className="col-6 col-xl-3"><StatCard label="Live answers" value={s.liveEntries} icon="solar:book-outline" tone="success" /></div>
        <div className="col-6 col-xl-3"><StatCard label="Open unanswered" value={s.openUnanswered} icon="solar:question-circle-outline" tone="danger" /></div>
        <div className="col-6 col-xl-3"><StatCard label="Answer rate (30 days)" value={pct(s.answerRate30d)} icon="solar:chart-2-outline" tone="info" hint={`${s.questions30d} questions, thumbs ${s.up30d} up / ${s.down30d} down`} /></div>
      </div>

      <Card title="Approval" subtitle="When this is on, a restaurant's Publish becomes a request that staff approve or reject. Staff can always publish directly." className="mb-20">
        <Switch label="Restaurants need FORKY approval to publish bot training" checked={data.requireApproval} disabled={!can("settings", "edit")} onChange={toggleApproval} className="mb-0" />
        {!can("settings", "edit") && <div className="text-secondary-light text-sm mt-8">You need the "edit settings" permission to change this.</div>}
      </Card>

      <Card title={`Approval queue (${data.approvalQueue.length})`} subtitle="Restaurants waiting to go live" className="mb-20">
        {!data.approvalQueue.length ? (
          <EmptyState icon="solar:check-circle-outline" title="Nothing waiting" text="Requests appear here when approval is on and a restaurant publishes." />
        ) : (
          <div className="table-responsive">
            <table className="table bordered-table mb-0 align-middle">
              <thead>
                <tr>
                  <th>Restaurant</th>
                  <th>Requested</th>
                  <th>Answers</th>
                  <th>Note</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.approvalQueue.map((r) => (
                  <tr key={r.id} data-testid="approval-row">
                    <td>{r.restaurantName}</td>
                    <td>
                      {fmtDateTime(r.createdAt)} <div className="text-secondary-light text-xs">{r.requestedByName}</div>
                    </td>
                    <td>
                      {r.counts?.entries ?? 0} {r.regressions > 0 && <Badge tone="danger">{r.regressions} test failing</Badge>}
                    </td>
                    <td className="text-truncate" style={{ maxWidth: 240 }}>{r.note}</td>
                    <td className="text-end text-nowrap">
                      <Button variant="outline" onClick={() => setDetail(r.id)}>Review</Button>{" "}
                      {canEdit && <Button variant="success" onClick={() => decide(r, true)}>Approve</Button>}{" "}
                      {canEdit && <Button variant="outline-danger" onClick={() => decide(r, false)}>Reject</Button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title={`Held by guardrails (${data.heldQueue.length})`} subtitle="Answers that promise allergen safety or make medical claims. They are not used by the bot until you release them.">
        {!data.heldQueue.length ? (
          <EmptyState icon="solar:shield-check-outline" title="Nothing held" text="Entries that guarantee allergen safety or make medical claims wait here." />
        ) : (
          <div className="table-responsive">
            <table className="table bordered-table mb-0 align-middle">
              <thead>
                <tr>
                  <th>Restaurant</th>
                  <th>Answer</th>
                  <th>Why held</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.heldQueue.map((h) => (
                  <tr key={`${h.kind}-${h.id}`} data-testid="held-row">
                    <td>{h.restaurantName}</td>
                    <td style={{ maxWidth: 380 }}>
                      <div className="fw-semibold">{h.title} <Badge tone="neutral">{h.kind}</Badge></div>
                      <div className="text-secondary-light text-sm">{h.answer}</div>
                    </td>
                    <td className="text-sm text-warning-main">{(h.held?.messages || []).join(" ")}</td>
                    <td className="text-end text-nowrap">
                      {canEdit && <Button variant="success" onClick={() => held(h, true)}>Release</Button>}{" "}
                      {canEdit && <Button variant="outline-danger" onClick={() => held(h, false)}>Remove</Button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {detail && <RequestDetail id={detail} onClose={() => setDetail(null)} />}
    </>
  );
}

/** Admin > Assistant > Training > Restaurants: coverage table. */
export function AdminTrainingRestaurants() {
  const nav = useNavigate();
  const list = usePagedList(`${BASE}/restaurants`, { sortBy: "unanswered" });
  const columns = [
    { key: "name", title: "Restaurant", sortable: true, render: (r) => <Link to={`/assistant/training/restaurants/${r.id}`} className="fw-semibold text-primary-light" onClick={(e) => e.stopPropagation()}>{r.name}</Link> },
    { key: "entries", title: "Live answers", sortable: true, align: "end", render: (r) => r.liveEntries },
    { key: "liveVersion", title: "Live version", align: "end", render: (r) => (r.liveVersion ? `v${r.liveVersion}` : "none") },
    { key: "draft", title: "Draft", render: (r) => (r.draftBehind ? <Badge tone="warning">unpublished changes</Badge> : <span className="text-secondary-light">same as live</span>) },
    { key: "unanswered", title: "Unanswered", sortable: true, align: "end", render: (r) => (r.unanswered ? <Badge tone="danger">{r.unanswered}</Badge> : 0) },
    { key: "rate", title: "Answer rate 30d", sortable: true, align: "end", render: (r) => (r.answerRate === null ? "n/a" : `${r.answerRate}%`) },
    { key: "pending", title: "Pending approval", sortable: true, align: "end", render: (r) => (r.pending ? <Badge tone="info">{r.pending}</Badge> : 0) },
    { key: "open", title: "", render: (r) => <Button variant="outline" onClick={(e) => { e.stopPropagation(); nav(`/assistant/training/restaurants/${r.id}`); }}>Open training</Button> },
  ];
  return (
    <>
      <PageHeader title="Training coverage" subtitle="How much each restaurant has taught its bot, and how well it answers" crumbs={[{ label: "Assistant", to: "/assistant" }, { label: "Training", to: "/assistant/training" }, { label: "Restaurants" }]} />
      <Card>
        <ListToolbar list={list} placeholder="Search restaurant name or slug…" />
        <DataTable columns={columns} {...list.tableProps} error={list.error} onRetry={list.reload} onRowClick={(r) => nav(`/assistant/training/restaurants/${r.id}`)} emptyTitle="No restaurants match" />
      </Card>
    </>
  );
}

/** Admin: open ANY restaurant's training area. */
export function AdminTrainingEditor() {
  const { id } = useParams();
  const { can } = useAuth();
  const rest = useFetch(`/admin/restaurants/${id}`);
  return (
    <>
      <PageHeader
        title={`${rest.data?.name || "Restaurant"}: bot training`}
        subtitle="You are editing on behalf of the restaurant. Staff publish directly."
        crumbs={[{ label: "Assistant", to: "/assistant" }, { label: "Training", to: "/assistant/training" }, { label: "Restaurants", to: "/assistant/training/restaurants" }, { label: rest.data?.name || "Editor" }]}
        actions={<Link className="btn btn-outline-primary-600 btn-sm radius-8" to={`/assistant/restaurants/${id}`}>Look and settings</Link>}
      />
      <TrainingArea base={`${BASE}/restaurants/${id}`} canEdit={can("restaurants", "edit")} staff />
    </>
  );
}

/** Admin: the FORKY website bot's own knowledge base. */
export function AdminTrainingCentral() {
  const { can } = useAuth();
  return (
    <>
      <PageHeader title="Central bot: training" subtitle="Answers about FORKY itself (delivery areas, fees, how it works, support). Restaurants' answers are never mixed in." crumbs={[{ label: "Assistant", to: "/assistant" }, { label: "Training", to: "/assistant/training" }, { label: "Central bot" }]} actions={<Link className="btn btn-outline-primary-600 btn-sm radius-8" to="/assistant/central">Look and settings</Link>} />
      <TrainingArea base={`${BASE}/central`} canEdit={can("settings", "edit")} staff central />
    </>
  );
}
