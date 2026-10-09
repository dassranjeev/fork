import React, { useCallback, useEffect, useState } from "react";
import { toast } from "react-toastify";
import { Badge, Button, Card, EmptyState, Select, TextInput } from "../../../ui";
import { problem } from "./kit";

const VERDICT = { answered: ["success", "Would answer"], ambiguous: ["warning", "Would ask 'Did you mean...?'"], document: ["info", "Would quote a document"], unanswered: ["danger", "Would NOT answer (goes to the inbox)"] };

/** Playground (against the DRAFT) + saved test cases with "Run all". */
export default function Bench({ api, canEdit }) {
  const [q, setQ] = useState("");
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [cases, setCases] = useState([]);
  const [run, setRun] = useState(null);
  const [entries, setEntries] = useState([]);
  const [nc, setNc] = useState({ question: "", kind: "entry", entryId: "", phrase: "" });
  const [err, setErr] = useState({});

  const loadCases = useCallback(() => {
    api.get("/test-cases").then(setCases).catch(() => undefined);
    api.get("/entries", { limit: 100 }).then((d) => setEntries(d.data)).catch(() => undefined);
  }, [api]);
  useEffect(loadCases, [loadCases]);

  const ask = async (e) => {
    e?.preventDefault();
    if (!q.trim()) return;
    setBusy(true);
    try {
      setRes(await api.post("/test", { question: q }));
    } catch (x) {
      toast.error(problem(x).message);
    } finally {
      setBusy(false);
    }
  };
  const addCase = async (body) => {
    setErr({});
    try {
      await api.post("/test-cases", body);
      toast.success("Test case saved");
      setNc({ question: "", kind: "entry", entryId: "", phrase: "" });
      loadCases();
    } catch (x) {
      const p = problem(x);
      setErr(p.fields);
      toast.error(p.message);
    }
  };
  const runAll = async () => {
    setBusy(true);
    try {
      setRun(await api.post("/test-cases/run"));
    } catch (x) {
      toast.error(problem(x).message);
    } finally {
      setBusy(false);
    }
  };
  const del = async (id) => {
    try {
      await api.del(`/test-cases/${id}`);
      setRun(null);
      loadCases();
    } catch (x) {
      toast.error(problem(x).message);
    }
  };

  return (
    <div className="row g-3">
      <div className="col-xl-6">
        <Card title="Try a question" subtitle="Runs against your DRAFT, so you can test before you publish.">
          <form onSubmit={ask} className="d-flex gap-2 mb-16">
            <input className="form-control radius-8" aria-label="Question to try" placeholder="e.g. do you cater weddings" value={q} maxLength={300} onChange={(e) => setQ(e.target.value)} />
            <Button type="submit" loading={busy}>
              Ask
            </Button>
          </form>
          {res && (
            <div data-testid="bench-result">
              <div className="mb-8">
                <Badge tone={VERDICT[res.verdict][0]}>{VERDICT[res.verdict][1]}</Badge> <span className="text-secondary-light text-sm ms-2">threshold {res.threshold}</span>
              </div>
              {res.answer && (
                <div className="bg-neutral-100 radius-8 p-12 mb-12" style={{ whiteSpace: "pre-wrap" }}>
                  {res.answer}
                </div>
              )}
              {res.entry && (
                <div className="text-sm mb-8">
                  Chosen answer: <b>{res.entry.title}</b> {res.entry.liveData && <Badge tone="info">live data wins</Badge>}
                </div>
              )}
              {res.note && <div className="text-secondary-light text-sm mb-8">{res.note}</div>}
              <div className="fw-semibold text-sm mb-4">Top 3 candidates</div>
              {!res.candidates.length ? (
                <div className="text-secondary-light text-sm">No answer has a word in common with this question.</div>
              ) : (
                <div className="table-responsive"><table className="table table-sm mb-8">
                  <tbody>
                    {res.candidates.map((c) => (
                      <tr key={c.entryId}>
                        <td>
                          <b>{c.title}</b>
                          <div className="text-secondary-light text-xs">{c.reasons.join(" · ")}</div>
                        </td>
                        <td className="text-end">
                          <Badge tone={c.score >= res.threshold ? "success" : "neutral"}>{Math.round(c.score * 100)}%</Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table></div>
              )}
              {res.passage && (
                <div className="text-sm mb-8">
                  Best document passage ({res.passage.documentTitle}, {Math.round(res.passage.score * 100)}%): <i>"{res.passage.text.slice(0, 160)}"</i>
                </div>
              )}
              {canEdit && (
                <div className="d-flex flex-wrap gap-2">
                  {res.entry && (
                    <Button variant="light" onClick={() => addCase({ question: res.question, expectEntryId: res.entry.id })}>
                      Save as a test case (expects this answer)
                    </Button>
                  )}
                  {res.verdict === "unanswered" && (
                    <Button variant="light" onClick={() => addCase({ question: res.question, expectUnanswered: true })}>
                      Save as a test case (expects no answer)
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}
        </Card>
      </div>
      <div className="col-xl-6">
        <Card title="Test set" subtitle="Questions that must keep working. Runs before every publish (up to 100)." actions={<Button onClick={runAll} loading={busy} disabled={!cases.length}>Run all</Button>}>
          {run && (
            <div className="mb-16" data-testid="bench-run">
              <Badge tone={run.failed ? "danger" : "success"}>
                {run.passed}/{run.total} passed
              </Badge>
              <div className="table-responsive"><table className="table table-sm mt-8 mb-0">
                <tbody>
                  {run.results.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <span className={r.pass ? "text-success-main" : "text-danger-main"}>{r.pass ? "PASS" : "FAIL"}</span> "{r.question}"
                        <div className="text-secondary-light text-xs">Expected {r.expected}: {r.reason}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            </div>
          )}
          {!cases.length ? (
            <EmptyState icon="solar:checklist-outline" title="No test cases yet" text="Save a question from the playground, or add one below." />
          ) : (
            <div className="table-responsive"><table className="table table-sm align-middle">
              <tbody>
                {cases.map((c) => (
                  <tr key={c.id}>
                    <td>
                      "{c.question}"
                      <div className="text-secondary-light text-xs">{c.expectEntryId ? `should be answered by "${c.expectTitle}"` : c.expectPhrase ? `answer must contain "${c.expectPhrase}"` : "should not be answered"}</div>
                    </td>
                    <td className="text-end">
                      {canEdit && (
                        <Button variant="outline-danger" onClick={() => del(c.id)}>
                          Remove
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
          {canEdit && (
            <div className="border-top pt-16">
              <TextInput label="Add a test case: question" aria-label="Test question" value={nc.question} maxLength={300} onChange={(v) => setNc({ ...nc, question: v })} error={err.question} />
              <div className="row">
                <Select col={5} label="Expect" aria-label="Expectation" allowEmpty={false} value={nc.kind} onChange={(v) => setNc({ ...nc, kind: v })} options={[{ value: "entry", label: "an answer" }, { value: "phrase", label: "a phrase in the answer" }, { value: "none", label: "no answer" }]} />
                {nc.kind === "entry" && <Select col={7} label="Answer" aria-label="Expected answer" value={nc.entryId} onChange={(v) => setNc({ ...nc, entryId: v })} options={entries.map((e) => ({ value: e.id, label: e.title }))} error={err.expectEntryId} />}
                {nc.kind === "phrase" && <TextInput col={7} label="Phrase" aria-label="Expected phrase" value={nc.phrase} onChange={(v) => setNc({ ...nc, phrase: v })} />}
              </div>
              {err.expect && <div className="text-danger-main text-sm mb-8">{err.expect}</div>}
              <Button variant="outline" onClick={() => addCase({ question: nc.question, ...(nc.kind === "entry" ? { expectEntryId: nc.entryId || null } : nc.kind === "phrase" ? { expectPhrase: nc.phrase } : { expectUnanswered: true }) })}>
                Add test case
              </Button>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
