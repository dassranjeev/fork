import React, { useEffect, useState } from "react";
import { toast } from "react-toastify";
import { Badge, Button, Card, EmptyState, NumberInput, Progress, StatCard } from "../../../ui";
import { pct, problem } from "./kit";

const OUTCOME_LABEL = { TRAINING: "Answered from your answers", DOCUMENT: "Answered from documents", BUILTIN: "Menu, cart and hours", AMBIGUOUS: "Asked which one", UNANSWERED: "Could not answer" };
const OUTCOME_TONE = { TRAINING: "success", DOCUMENT: "info", BUILTIN: "primary", AMBIGUOUS: "warning", UNANSWERED: "danger" };

function Rates({ title, d }) {
  const total = d.total || 0;
  return (
    <Card title={title} subtitle={total ? `${total} customer messages` : "No customer questions yet"} className="h-100">
      {!total ? (
        <div className="text-secondary-light text-sm">Questions appear here once guests start chatting.</div>
      ) : (
        <>
          <div className="d-flex gap-4 flex-wrap mb-12">
            <div>
              <div className="text-secondary-light text-xs">Answer rate</div>
              <div className="h5 mb-0" data-testid={`rate-${title}`}>{pct(d.answerRate)}</div>
            </div>
            <div>
              <div className="text-secondary-light text-xs">From your training</div>
              <div className="h5 mb-0">{pct(d.trainedRate)}</div>
            </div>
          </div>
          {["TRAINING", "DOCUMENT", "BUILTIN", "AMBIGUOUS", "UNANSWERED"].map((k) => (
            <div key={k} className="mb-8">
              <div className="d-flex justify-content-between text-sm">
                <span>{OUTCOME_LABEL[k]}</span>
                <span>{d[k] ?? 0}</span>
              </div>
              <Progress value={d[k] ?? 0} max={total} tone={OUTCOME_TONE[k]} height={6} />
            </div>
          ))}
        </>
      )}
    </Card>
  );
}

export default function Overview({ api, ov, canEdit, reload, goTo, teach }) {
  const [threshold, setThreshold] = useState(0.6);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (ov) setThreshold(ov.threshold);
  }, [ov]);
  if (!ov) return null;
  const a = ov.analytics;
  const maxTrend = Math.max(1, ...a.trend.map((t) => t.answered + t.unanswered));

  const saveThreshold = async () => {
    setSaving(true);
    try {
      await api.patch("/settings", { threshold: Number(threshold) });
      toast.success("Confidence threshold saved to your draft. Publish to use it.");
      reload();
    } catch (e) {
      toast.error(problem(e).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {ov.starters.length > 0 && (
        <Card title="Teach your bot your first 5 answers" subtitle="Guests ask these all the time. Tap one, write the answer in your own words, then publish." className="mb-20">
          <div className="row g-3">
            {ov.starters.slice(0, 6).map((s) => (
              <div key={s.key} className="col-md-6 col-xl-4">
                <div className="border radius-8 p-12 h-100 d-flex flex-column">
                  <div className="fw-semibold">{s.title}</div>
                  <div className="text-secondary-light text-sm mb-8">"{s.question}"</div>
                  <div className="text-secondary-light text-xs mb-12">{s.hint}</div>
                  {canEdit && (
                    <Button className="mt-auto" variant="outline" onClick={() => teach({ title: s.title, questionsText: s.question })}>
                      Teach this answer
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <div className="row g-3 mb-20">
        <div className="col-6 col-xl-3">
          <StatCard label="Live version" value={`v${ov.liveVersion}`} icon="solar:upload-outline" hint={`${ov.counts.live.active} live answers`} />
        </div>
        <div className="col-6 col-xl-3">
          <StatCard label="Unanswered questions" value={ov.unanswered.groups} icon="solar:question-circle-outline" tone="danger" hint={`${ov.unanswered.asks} times asked`} to={null} />
        </div>
        <div className="col-6 col-xl-3">
          <StatCard label="Needs review" value={ov.needsReview} icon="solar:dislike-outline" tone="warning" hint="answers with thumbs down" />
        </div>
        <div className="col-6 col-xl-3">
          <StatCard label="Thumbs up" value={a.thumbs.ratio === null ? "n/a" : `${a.thumbs.ratio}%`} icon="solar:like-outline" tone="success" hint={`${a.thumbs.up} up, ${a.thumbs.down} down`} />
        </div>
      </div>

      {(ov.dirty || ov.pendingRequest || ov.held > 0) && (
        <div className="d-flex flex-column gap-2 mb-20">
          {ov.dirty && (
            <div className="alert alert-warning radius-8 mb-0 d-flex flex-wrap justify-content-between align-items-center gap-2">
              <span>You have unpublished changes. Customers still get the live version (v{ov.liveVersion}).</span>
              <Button variant="warning" onClick={() => goTo("versions")}>
                Review and publish
              </Button>
            </div>
          )}
          {ov.pendingRequest && <div className="alert alert-info radius-8 mb-0">Your publish request is waiting for FORKY approval ({ov.pendingRequest.counts?.entries ?? 0} answers).</div>}
          {ov.held > 0 && <div className="alert alert-danger radius-8 mb-0">{ov.held} item{ov.held === 1 ? " is" : "s are"} held for FORKY review (for example a guarantee about allergens). The bot does not use them until FORKY releases them.</div>}
        </div>
      )}

      <div className="row g-3 mb-20">
        <div className="col-lg-6">
          <Rates title="Last 7 days" d={a.d7} />
        </div>
        <div className="col-lg-6">
          <Rates title="Last 30 days" d={a.d30} />
        </div>
      </div>

      <div className="row g-3 mb-20">
        <div className="col-lg-7">
          <Card title="Coverage hints" subtitle="Questions guests keep asking that the bot could not answer" className="h-100">
            {!a.coverageHints.length ? (
              <EmptyState icon="solar:check-circle-outline" title="No gaps found" text="When the same unanswered question is asked 3 times, it shows up here." />
            ) : (
              <ul className="ps-20 mb-0">
                {a.coverageHints.map((h, i) => (
                  <li key={i} className="mb-8">
                    {h.hint}{" "}
                    <Button variant="link" onClick={() => goTo("unanswered")}>
                      Open inbox
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
        <div className="col-lg-5">
          <Card title="Last 14 days" subtitle="Answered (green) and unanswered (red) per day" className="h-100">
            <div className="d-flex align-items-end gap-1" style={{ height: 90 }} role="img" aria-label="Questions per day">
              {a.trend.map((t) => (
                <div key={t.day} className="flex-fill d-flex flex-column justify-content-end" title={`${t.day}: ${t.answered} answered, ${t.unanswered} unanswered`}>
                  <div style={{ height: `${(t.unanswered / maxTrend) * 80}px`, background: "#ef4444", minHeight: t.unanswered ? 2 : 0 }} />
                  <div style={{ height: `${(t.answered / maxTrend) * 80}px`, background: "#22c55e", minHeight: t.answered ? 2 : 0 }} />
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>

      <div className="row g-3 mb-20">
        <div className="col-lg-6">
          <Card title="Top questions (30 days)" className="h-100">
            {!a.topQuestions.length ? (
              <div className="text-secondary-light text-sm">Nothing yet.</div>
            ) : (
              <div className="table-responsive"><table className="table table-sm mb-0">
                <tbody>
                  {a.topQuestions.map((t, i) => (
                    <tr key={i}>
                      <td>{t.text}</td>
                      <td className="text-end">
                        <Badge tone={t.outcome === "UNANSWERED" ? "danger" : "success"}>{t.outcome === "UNANSWERED" ? "unanswered" : "answered"}</Badge> {t.count}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            )}
          </Card>
        </div>
        <div className="col-lg-6">
          <Card title="Answers never used" subtitle={`${a.neverUsedCount} live answer${a.neverUsedCount === 1 ? "" : "s"} no guest has triggered yet`} className="h-100">
            {!a.neverUsed.length ? <div className="text-secondary-light text-sm">Every live answer has been used.</div> : <ul className="ps-20 mb-0">{a.neverUsed.slice(0, 8).map((n) => <li key={n.id}>{n.title}</li>)}</ul>}
          </Card>
        </div>
      </div>

      <Card title="Training settings" subtitle="How sure the bot must be before it answers from your answers">
        <div className="row align-items-end">
          <NumberInput col={4} label="Confidence threshold (0.4 to 0.9)" aria-label="Confidence threshold" min={0.4} max={0.9} step={0.05} value={threshold} onChange={(v) => setThreshold(v)} disabled={!canEdit} hint="Lower: answers more, with more wrong guesses. Higher: answers fewer questions, more precisely. Default 0.6." />
          <div className="col-md-4 mb-16">
            {canEdit && (
              <Button loading={saving} disabled={Number(threshold) === ov.threshold || Number(threshold) < 0.4 || Number(threshold) > 0.9} onClick={saveThreshold}>
                Save threshold
              </Button>
            )}
          </div>
        </div>
      </Card>
    </>
  );
}
