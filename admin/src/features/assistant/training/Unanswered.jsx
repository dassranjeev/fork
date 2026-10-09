import React, { useCallback, useEffect, useState } from "react";
import { toast } from "react-toastify";
import { fmtDateTime } from "../../../lib/format";
import { Badge, Button, Card, EmptyState, ErrorState, FormModal, Loading, Select } from "../../../ui";
import EntryEditor from "./EntryEditor";
import { problem } from "./kit";

/** Questions the bot could not answer, grouped by similar wording, most asked first. Teach, add as a phrasing, or ignore. */
export default function Unanswered({ api, canEdit, onChanged }) {
  const [status, setStatus] = useState("OPEN");
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [teach, setTeach] = useState(null);
  const [merge, setMerge] = useState(null);
  const [target, setTarget] = useState("");
  const [entries, setEntries] = useState([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.get("/unanswered", { status }).then((d) => { setData(d); setError(null); }).catch(setError);
    api.get("/entries", { limit: 100 }).then((d) => setEntries(d.data)).catch(() => undefined);
  }, [api, status]);
  useEffect(load, [load]);
  const done = () => {
    load();
    onChanged?.();
  };

  const act = async (g, what) => {
    try {
      await api.post(`/unanswered/${g.id}/${what}`);
      toast.success(what === "ignore" ? "Ignored. You can find it under Ignored." : "Back in the inbox");
      done();
    } catch (e) {
      toast.error(problem(e).message);
    }
  };
  const doMerge = async () => {
    setBusy(true);
    try {
      await api.post(`/unanswered/${merge.id}/merge`, { entryId: target });
      toast.success("Added as another way to ask that answer (draft)");
      setMerge(null);
      done();
    } catch (e) {
      toast.error(problem(e).message);
    } finally {
      setBusy(false);
    }
  };

  if (error && !data) return <ErrorState error={error} onRetry={load} />;
  if (!data) return <Loading />;

  return (
    <>
      <Card
        title="Unanswered questions"
        subtitle="What guests asked and the bot could not answer. Same question, same wording: counted once. Teach it once and it is answered from then on."
        actions={
          <select className="form-select radius-8 w-auto" aria-label="Show" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="OPEN">Open</option>
            <option value="TAUGHT">Taught (waiting for publish or live)</option>
            <option value="IGNORED">Ignored</option>
          </select>
        }
      >
        {!data.data.length ? (
          <EmptyState icon="solar:inbox-outline" title={status === "OPEN" ? "Nothing to teach right now" : "Nothing here"} text={status === "OPEN" ? "When the bot cannot answer a question, it shows up here with how often it was asked. No personal data is stored." : ""} />
        ) : (
          <div className="d-flex flex-column gap-3">
            {data.data.map((g) => (
              <div key={g.id} className="border radius-8 p-16" data-testid="unanswered-group">
                <div className="d-flex flex-wrap justify-content-between gap-2">
                  <div>
                    <div className="fw-semibold">"{g.text}"</div>
                    <div className="text-secondary-light text-sm">
                      Asked {g.count} time{g.count === 1 ? "" : "s"} · last {fmtDateTime(g.lastSeenAt)}
                    </div>
                    {g.examples.length > 1 && <div className="text-secondary-light text-xs mt-4">Also asked as: {g.examples.filter((x) => x !== g.text).slice(0, 4).map((x) => `"${x}"`).join(", ")}</div>}
                  </div>
                  <Badge tone={status === "OPEN" ? "danger" : "neutral"}>{g.count}×</Badge>
                </div>
                {status === "OPEN" && g.suggestions.answer && (
                  <div className="bg-neutral-100 radius-8 p-8 mt-8 text-sm">
                    <div className="text-secondary-light text-xs">Suggested from {g.suggestions.answer.source}</div>
                    <div>{g.suggestions.answer.text}</div>
                  </div>
                )}
                {status === "OPEN" && g.suggestions.entries.length > 0 && <div className="text-secondary-light text-xs mt-8">Closest answers: {g.suggestions.entries.map((e) => `${e.title} (${Math.round(e.score * 100)}%)`).join(", ")}</div>}
                {canEdit && (
                  <div className="d-flex flex-wrap gap-2 mt-12">
                    {status === "OPEN" && (
                      <>
                        <Button onClick={() => setTeach(g)}>Teach an answer</Button>
                        <Button variant="outline" onClick={() => { setMerge(g); setTarget(g.suggestions.entries[0]?.id || ""); }} disabled={!entries.length}>
                          Add as another phrasing
                        </Button>
                        <Button variant="light" onClick={() => act(g, "ignore")}>
                          Ignore
                        </Button>
                      </>
                    )}
                    {status === "IGNORED" && (
                      <Button variant="light" onClick={() => act(g, "restore")}>
                        Move back to the inbox
                      </Button>
                    )}
                    {status === "TAUGHT" && <span className="text-secondary-light text-sm">Taught: answered once published.</span>}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
      <EntryEditor open={!!teach} onClose={() => setTeach(null)} api={api} teachFrom={teach?.id} preset={teach ? { title: teach.text.slice(0, 80), questionsText: [teach.text, ...teach.examples.filter((x) => x !== teach.text)].slice(0, 8).join("\n"), answer: teach.suggestions.answer?.text || "" } : undefined} entries={entries} onSaved={done} canEdit={canEdit} />
      <FormModal open={!!merge} onClose={() => setMerge(null)} title="Add as another way to ask" onSubmit={doMerge} busy={busy} submitText="Add to answer" disabled={!target}>
        <p className="text-secondary-light">"{merge?.text}" will be added to the phrasings of the answer you choose.</p>
        <Select label="Answer" aria-label="Answer to extend" value={target} onChange={setTarget} options={entries.map((e) => ({ value: e.id, label: e.title }))} />
      </FormModal>
    </>
  );
}
