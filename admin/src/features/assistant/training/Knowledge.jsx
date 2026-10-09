import React, { useCallback, useEffect, useState } from "react";
import { toast } from "react-toastify";
import { Badge, Button, Card, EmptyState, ErrorState, Loading, Modal, Select, Switch, useConfirm } from "../../../ui";
import { useDebounced } from "../../../lib/hooks";
import EntryEditor from "./EntryEditor";
import { problem, readTextFile, saveJson } from "./kit";

const STATE_TONE = { live: "success", changed: "warning", new: "info", held: "danger" };
const STATE_LABEL = { live: "Live", changed: "Edited (not live)", new: "New (not live)", held: "Held for review" };

function ImportModal({ open, onClose, api, onDone }) {
  const [kind, setKind] = useState("csv");
  const [text, setText] = useState("");
  const [replace, setReplace] = useState(false);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setText("");
      setPreview(null);
      setReplace(false);
    }
  }, [open]);

  const body = (mode) => {
    if (kind === "csv") return { csv: text, mode, replace };
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("That is not valid JSON. Use a file exported from this page.");
    }
    return { data, mode, replace };
  };
  const run = async (mode) => {
    setBusy(true);
    try {
      const res = await api.post(kind === "csv" ? "/import-csv" : "/import", body(mode));
      setPreview(res);
      if (mode === "apply") {
        toast.success(`Imported ${res.summary.valid} answer${res.summary.valid === 1 ? "" : "s"} into your draft`);
        onDone?.();
        onClose();
      }
    } catch (e) {
      setPreview(null);
      toast.error(e?.response ? problem(e).message : e.message);
    } finally {
      setBusy(false);
    }
  };
  const pick = async (e) => {
    try {
      setText(await readTextFile(e.target.files?.[0]));
      setPreview(null);
    } catch (x) {
      toast.error(x.message);
    }
    e.target.value = "";
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Import answers"
      size="lg"
      footer={
        <>
          <Button variant="light" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="outline" loading={busy} disabled={!text.trim()} onClick={() => run("preview")}>
            Check file
          </Button>
          <Button loading={busy} disabled={!preview || preview.summary.valid === 0} onClick={() => run("apply")}>
            Import {preview ? preview.summary.valid : ""} valid answers
          </Button>
        </>
      }
    >
      <div className="d-flex gap-3 flex-wrap align-items-end mb-12">
        <Select label="Format" allowEmpty={false} value={kind} onChange={(v) => { setKind(v); setPreview(null); }} options={[{ value: "csv", label: "CSV: title, questions, answer (questions separated by |)" }, { value: "json", label: "JSON export of a whole bot" }]} className="mb-0" />
        <label className="btn btn-outline-primary-600 btn-sm radius-8 mb-0">
          Choose a file
          <input type="file" hidden accept=".csv,.json,text/csv,application/json,text/plain" onChange={pick} />
        </label>
        <Switch label="Replace all current answers" checked={replace} onChange={(v) => { setReplace(v); setPreview(null); }} className="mb-0" />
      </div>
      <textarea className="form-control radius-8 font-monospace text-sm mb-12" rows={7} aria-label="File content" value={text} onChange={(e) => { setText(e.target.value); setPreview(null); }} placeholder={kind === "csv" ? "title,questions,answer\nParking,do you have parking | where do I park,Free parking behind the building." : '{ "format": "forksy-assistant-kb", ... }'} />
      <div className="text-secondary-light text-sm mb-12">Every row goes through the same checks as a typed answer (no emails, phone numbers or card numbers; no allergen-safety guarantees; at most 500 answers). Nothing is changed until you press Import, and imported answers land in your DRAFT.</div>
      {preview && (
        <div>
          <div className="mb-8">
            <Badge tone="success">{preview.summary.valid} valid</Badge> <Badge tone={preview.summary.errors ? "danger" : "neutral"}>{preview.summary.errors} with errors</Badge> {preview.summary.held > 0 && <Badge tone="warning">{preview.summary.held} held for review</Badge>}
          </div>
          <div className="table-responsive" style={{ maxHeight: 220, overflow: "auto" }}>
            <table className="table table-sm mb-0">
              <thead>
                <tr>
                  <th>Row</th>
                  <th>Answer</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {preview.report.filter((r) => r.status !== 'ok' || preview.report.length < 30).map((r, i) => (
                  <tr key={i}>
                    <td>{r.row}</td>
                    <td>{r.title}</td>
                    <td className={r.status === "error" ? "text-danger-main" : r.status === "held" ? "text-warning-main" : ""}>{r.status === "ok" ? "OK" : r.issues.filter((x) => x.severity !== "warn").map((x) => x.message).join(" ") || "Warning"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Modal>
  );
}

export default function Knowledge({ api, canEdit, onChanged, preset, onPresetUsed }) {
  const confirm = useConfirm();
  const [q, setQ] = useState("");
  const dq = useDebounced(q);
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [edit, setEdit] = useState(null);
  const [creating, setCreating] = useState(false);
  const [picked, setPicked] = useState({});
  const [importing, setImporting] = useState(false);
  const [all, setAll] = useState([]);

  const load = useCallback(() => {
    api.get("/entries", { search: dq || undefined, status: status || undefined, page, limit: 15 }).then((d) => { setData(d); setError(null); }).catch(setError);
    api.get("/entries", { limit: 100 }).then((d) => setAll(d.data)).catch(() => undefined);
  }, [api, dq, status, page]);
  useEffect(load, [load]);
  useEffect(() => setPage(1), [dq, status]);
  useEffect(() => {
    if (preset) setCreating(true);
  }, [preset]);

  const changed = () => {
    load();
    onChanged?.();
  };
  const toggle = async (e, active) => {
    try {
      await api.patch(`/entries/${e.id}`, { active });
      changed();
    } catch (x) {
      toast.error(problem(x).message);
    }
  };
  const remove = async (e) => {
    const r = await confirm({ title: `Delete "${e.title}"?`, message: "It disappears from your draft. The live bot keeps using it until you publish.", confirmText: "Delete", danger: true });
    if (!r.confirmed) return;
    try {
      await api.del(`/entries/${e.id}`);
      changed();
    } catch (x) {
      toast.error(problem(x).message);
    }
  };
  const bulk = async (action) => {
    const ids = Object.keys(picked).filter((k) => picked[k]);
    if (!ids.length) return;
    if (action === "delete") {
      const r = await confirm({ title: `Delete ${ids.length} answers?`, confirmText: "Delete", danger: true });
      if (!r.confirmed) return;
    }
    try {
      await api.post("/entries/bulk", { action, ids });
      setPicked({});
      changed();
    } catch (x) {
      toast.error(problem(x).message);
    }
  };
  const exportJson = async () => {
    try {
      saveJson(await api.get("/export"), "assistant-answers.json");
    } catch (x) {
      toast.error(problem(x).message);
    }
  };

  if (error && !data) return <ErrorState error={error} onRetry={load} />;
  if (!data) return <Loading />;
  const rows = data.data;
  const nPicked = Object.values(picked).filter(Boolean).length;

  return (
    <>
      <Card
        title="Knowledge: the answers your bot knows"
        subtitle="Edits are saved to a draft. The live bot only changes when you publish (Versions & publish tab)."
        actions={
          <div className="d-flex gap-2 flex-wrap">
            {canEdit && <Button onClick={() => setCreating(true)}>Add an answer</Button>}
            {canEdit && (
              <Button variant="light" onClick={() => setImporting(true)}>
                Import
              </Button>
            )}
            <Button variant="light" onClick={exportJson}>
              Export JSON
            </Button>
            <Button variant="light" onClick={() => api.download("/export.csv", "assistant-answers.csv").catch((x) => toast.error(problem(x).message))}>
              Export CSV
            </Button>
          </div>
        }
      >
        <div className="d-flex flex-wrap gap-3 mb-16 align-items-center">
          <input className="form-control radius-8 w-auto" style={{ minWidth: 220 }} placeholder="Search answers…" aria-label="Search answers" value={q} onChange={(e) => setQ(e.target.value)} />
          <select className="form-select radius-8 w-auto" aria-label="Filter" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All answers</option>
            <option value="active">Active</option>
            <option value="inactive">Switched off</option>
            <option value="unpublished">Not live yet</option>
            <option value="held">Held for review</option>
            <option value="review">Needs review (thumbs down)</option>
          </select>
          {canEdit && nPicked > 0 && (
            <div className="d-flex gap-2 align-items-center">
              <span className="text-sm text-secondary-light">{nPicked} selected</span>
              <Button variant="light" onClick={() => bulk("activate")}>Switch on</Button>
              <Button variant="light" onClick={() => bulk("deactivate")}>Switch off</Button>
              <Button variant="outline-danger" onClick={() => bulk("delete")}>Delete</Button>
            </div>
          )}
        </div>
        {!rows.length ? (
          <EmptyState icon="solar:chat-square-like-outline" title={q || status ? "No answers match" : "No answers yet"} text={q || status ? "Try another search or filter." : "Teach the bot its first answers from the Overview tab, or add one here."} action={canEdit && !q && !status ? <Button onClick={() => setCreating(true)}>Add an answer</Button> : null} />
        ) : (
          <div className="table-responsive">
            <table className="table bordered-table mb-0 align-middle">
              <thead>
                <tr>
                  {canEdit && <th style={{ width: 32 }} />}
                  <th>Answer</th>
                  <th>Phrasings</th>
                  <th>Status</th>
                  <th className="text-end">Used</th>
                  <th className="text-end">Thumbs</th>
                  <th>On</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.id}>
                    {canEdit && (
                      <td>
                        <input type="checkbox" className="form-check-input" aria-label={`Select ${e.title}`} checked={!!picked[e.id]} onChange={(ev) => setPicked({ ...picked, [e.id]: ev.target.checked })} />
                      </td>
                    )}
                    <td style={{ maxWidth: 380 }}>
                      <div className="fw-semibold">
                        {e.title} {e.legacyFaq && <Badge tone="neutral">FAQ</Badge>} {e.liveData && <Badge tone="info">live data wins</Badge>}
                      </div>
                      <div className="text-secondary-light text-sm text-truncate">{e.answer}</div>
                    </td>
                    <td>{e.questions.length}</td>
                    <td>
                      <Badge tone={STATE_TONE[e.state] || "neutral"}>{STATE_LABEL[e.state] || e.state}</Badge>
                      {e.held && <div className="text-warning-main text-xs mt-4">FORKSY reviews this before it can go live</div>}
                    </td>
                    <td className="text-end">{e.stats.answered}</td>
                    <td className="text-end text-nowrap">
                      {e.stats.up}/{e.stats.down}
                    </td>
                    <td>
                      <div className="form-check form-switch switch-primary mb-0">
                        <input className="form-check-input" type="checkbox" role="switch" aria-label={`${e.title} active`} checked={e.active} disabled={!canEdit} onChange={(ev) => toggle(e, ev.target.checked)} />
                      </div>
                    </td>
                    <td className="text-end text-nowrap">
                      <Button variant="outline" onClick={() => setEdit(e)}>
                        {canEdit ? "Edit" : "View"}
                      </Button>{" "}
                      {canEdit && (
                        <Button variant="outline-danger" onClick={() => remove(e)}>
                          Delete
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data.meta.totalPages > 1 && (
          <div className="d-flex justify-content-between align-items-center mt-16">
            <span className="text-secondary-light text-sm">
              Page {data.meta.page} of {data.meta.totalPages} ({data.meta.total} answers)
            </span>
            <div className="d-flex gap-2">
              <Button variant="light" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                Previous
              </Button>
              <Button variant="light" disabled={page >= data.meta.totalPages} onClick={() => setPage(page + 1)}>
                Next
              </Button>
            </div>
          </div>
        )}
      </Card>
      <EntryEditor open={creating} onClose={() => { setCreating(false); onPresetUsed?.(); }} api={api} preset={preset} entries={all} onSaved={changed} canEdit={canEdit} />
      <EntryEditor open={!!edit} onClose={() => setEdit(null)} api={api} entry={edit} entries={all} onSaved={changed} canEdit={canEdit} />
      <ImportModal open={importing} onClose={() => setImporting(false)} api={api} onDone={changed} />
    </>
  );
}

export { EntryEditor };
