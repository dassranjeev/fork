import React, { useCallback, useEffect, useState } from "react";
import { toast } from "react-toastify";
import { fmtDateTime } from "../../../lib/format";
import { Badge, Button, Card, EmptyState, ErrorState, Loading, Modal, TextInput, useConfirm } from "../../../ui";
import { problem } from "./kit";

const SOURCE = { migration: "Created from FAQs", publish: "Published", rollback: "Rollback", faq: "FAQ editor", approval: "Approved by FORKSY" };

/** Draft vs live, publish (with regression warning / approval), rollback, version history. */
export default function Versions({ api, canEdit, staff, onChanged }) {
  const confirm = useConfirm();
  const [v, setV] = useState(null);
  const [reqs, setReqs] = useState([]);
  const [error, setError] = useState(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [regs, setRegs] = useState(null);
  const [detail, setDetail] = useState(null);

  const load = useCallback(() => {
    api.get("/versions").then((d) => { setV(d); setError(null); }).catch(setError);
    api.get("/requests").then(setReqs).catch(() => undefined);
  }, [api]);
  useEffect(load, [load]);
  const done = () => {
    load();
    onChanged?.();
  };

  const publish = async (confirmRegressions = false) => {
    setBusy(true);
    try {
      const res = await api.post("/versions/publish", { note: note || undefined, confirmRegressions });
      setRegs(null);
      setNote("");
      toast.success(res.status === "REQUESTED" ? "Sent to FORKSY for approval. The live bot does not change until it is approved." : `Published as version ${res.version}. The bot uses it now.`);
      done();
    } catch (e) {
      const p = problem(e);
      if (p.code === "REGRESSIONS") setRegs({ message: p.message, list: e.response.data.details });
      else toast.error(p.message);
    } finally {
      setBusy(false);
    }
  };
  const rollback = async (ver) => {
    const r = await confirm({ title: `Restore version ${ver.version}?`, message: "This creates a NEW version with that content and makes it live. Your current draft is replaced by it.", confirmText: "Restore", prompt: { label: "Note (optional)", type: "text", required: false } });
    if (!r.confirmed) return;
    try {
      const res = await api.post(`/versions/${ver.version}/rollback`, { note: r.value || undefined });
      toast.success(res.status === "REQUESTED" ? "Sent to FORKSY for approval" : `Restored: now live as version ${res.version}`);
      done();
    } catch (e) {
      toast.error(problem(e).message);
    }
  };
  const discard = async () => {
    const r = await confirm({ title: "Discard all unpublished changes?", message: "Your draft goes back to exactly what is live.", confirmText: "Discard draft", danger: true });
    if (!r.confirmed) return;
    try {
      await api.post("/draft/discard");
      toast.success("Draft reset to the live version");
      done();
    } catch (e) {
      toast.error(problem(e).message);
    }
  };
  const cancel = async (id) => {
    try {
      await api.post(`/requests/${id}/cancel`);
      done();
    } catch (e) {
      toast.error(problem(e).message);
    }
  };
  const view = async (ver) => {
    try {
      setDetail(await api.get(`/versions/${ver.version}`));
    } catch (e) {
      toast.error(problem(e).message);
    }
  };

  if (error && !v) return <ErrorState error={error} onRetry={load} />;
  if (!v) return <Loading />;
  const needsApproval = v.requireApproval && !staff;

  return (
    <>
      <Card title="Publish" subtitle={`Live right now: version ${v.live}. Customers only ever see published versions.`} className="mb-20">
        {v.pendingRequest ? (
          <div className="alert alert-info radius-8 d-flex flex-wrap justify-content-between align-items-center gap-2">
            <span>Waiting for FORKSY approval since {fmtDateTime(v.pendingRequest.createdAt)} ({v.pendingRequest.counts?.entries ?? 0} answers).</span>
            {canEdit && !staff && (
              <Button variant="light" onClick={() => cancel(v.pendingRequest.id)}>
                Withdraw request
              </Button>
            )}
          </div>
        ) : null}
        {v.dirty ? <div className="alert alert-warning radius-8">You have unpublished changes in your draft.</div> : <div className="text-secondary-light mb-12">Your draft is the same as the live version. Nothing to publish.</div>}
        {needsApproval && <div className="text-secondary-light text-sm mb-12">FORKSY reviews changes before they go live: pressing Publish sends a request.</div>}
        {canEdit && (
          <div className="row align-items-end">
            <TextInput col={6} label="What changed? (optional note)" aria-label="Publish note" value={note} maxLength={300} onChange={setNote} />
            <div className="col-md-6 mb-16 d-flex gap-2 flex-wrap">
              <Button loading={busy} disabled={!v.dirty} onClick={() => publish(false)}>
                {needsApproval ? "Request publish" : "Publish"}
              </Button>
              <Button variant="outline-danger" disabled={!v.dirty} onClick={discard}>
                Discard draft changes
              </Button>
            </div>
          </div>
        )}
      </Card>
      <Card title="Versions" subtitle="Every publish is saved. Restoring one creates a new version, nothing is ever overwritten.">
        {!v.data.length ? (
          <EmptyState title="No versions yet" />
        ) : (
          <div className="table-responsive">
            <table className="table bordered-table mb-0 align-middle">
              <thead>
                <tr>
                  <th>Version</th>
                  <th>When</th>
                  <th>Who</th>
                  <th>What</th>
                  <th>Answers</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {v.data.map((x) => (
                  <tr key={x.id}>
                    <td>
                      v{x.version} {x.live && <Badge tone="success">Live</Badge>}
                    </td>
                    <td>{fmtDateTime(x.createdAt)}</td>
                    <td>{x.publishedByName || "FORKSY"}</td>
                    <td>
                      {SOURCE[x.source] || x.source}
                      {x.restoredFrom ? ` (v${x.restoredFrom})` : ""}
                      {x.note ? <div className="text-secondary-light text-xs">{x.note}</div> : null}
                    </td>
                    <td>
                      {x.counts?.active ?? 0}
                      {x.counts?.held ? ` (+${x.counts.held} held)` : ""}
                    </td>
                    <td className="text-end text-nowrap">
                      <Button variant="outline" onClick={() => view(x)}>
                        View
                      </Button>{" "}
                      {canEdit && !x.live && (
                        <Button variant="outline-danger" onClick={() => rollback(x)}>
                          Restore
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {reqs.length > 0 && (
        <Card title="Approval requests" className="mt-20">
          <div className="table-responsive"><table className="table table-sm mb-0">
            <tbody>
              {reqs.map((r) => (
                <tr key={r.id}>
                  <td>{fmtDateTime(r.createdAt)}</td>
                  <td>{r.kind}</td>
                  <td>
                    <Badge tone={r.status === "APPROVED" ? "success" : r.status === "REJECTED" ? "danger" : r.status === "PENDING" ? "info" : "neutral"}>{r.status}</Badge>
                  </td>
                  <td>{r.decisionNote || ""}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </Card>
      )}
      <Modal open={!!regs} onClose={() => setRegs(null)} title="Some test cases would stop working" footer={<><Button variant="light" onClick={() => setRegs(null)}>Go back and check</Button><Button variant="warning" loading={busy} onClick={() => publish(true)}>Publish anyway</Button></>}>
        <p>{regs?.message}</p>
        <ul className="ps-20">
          {(regs?.list || []).map((r) => (
            <li key={r.id}>
              "{r.question}": {r.reason}
            </li>
          ))}
        </ul>
      </Modal>
      <Modal open={!!detail} onClose={() => setDetail(null)} title={detail ? `Version ${detail.version}` : ""} footer={<Button variant="light" onClick={() => setDetail(null)}>Close</Button>}>
        {detail && (
          <>
            <div className="text-secondary-light mb-8">
              {fmtDateTime(detail.createdAt)} · {SOURCE[detail.source] || detail.source} · {detail.counts.entries} answers, {detail.counts.aliases} nicknames, {detail.counts.synonyms} synonym groups, {detail.counts.documents} documents
            </div>
            <ul className="ps-20 mb-0">
              {detail.entries.map((e) => (
                <li key={e.id}>
                  {e.title} ({e.questions} phrasing{e.questions === 1 ? "" : "s"}) {!e.active && <Badge tone="neutral">off</Badge>} {e.held && <Badge tone="warning">held</Badge>}
                </li>
              ))}
            </ul>
          </>
        )}
      </Modal>
    </>
  );
}
