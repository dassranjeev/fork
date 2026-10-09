import React, { useEffect, useState } from "react";
import { toast } from "react-toastify";
import { Badge, FormModal, Select, Switch, TagsInput, TextArea, TextInput } from "../../../ui";
import { ProblemList, problem } from "./kit";

const empty = { title: "", questionsText: "", answer: "", chips: [], tags: [], active: true, priority: 0 };

const fromEntry = (e) => (e ? { title: e.title, questionsText: e.questions.join("\n"), answer: e.answer, chips: e.chips || [], tags: e.tags || [], active: e.active, priority: e.priority || 0 } : empty);

/** Create / edit one taught answer: phrasings, answer, follow-up buttons, tags, priority. Server-side guardrails answer with per-field messages. */
export default function EntryEditor({ open, onClose, api, entry, preset, entries = [], onSaved, canEdit = true, teachFrom }) {
  const [f, setF] = useState(empty);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState({ fields: {}, list: [] });
  const [notes, setNotes] = useState([]);

  useEffect(() => {
    if (open) {
      setF(entry ? fromEntry(entry) : preset ? { ...empty, ...preset } : empty);
      setErr({ fields: {}, list: [] });
      setNotes([]);
    }
  }, [open, entry, preset]);

  const set = (patch) => setF((x) => ({ ...x, ...patch }));
  const questions = f.questionsText.split("\n").map((s) => s.trim()).filter(Boolean);
  const others = entries.filter((e) => !entry || e.id !== entry.id);

  const save = async () => {
    setBusy(true);
    setErr({ fields: {}, list: [] });
    const body = { title: f.title, questions, answer: f.answer, chips: f.chips.filter((c) => c.label && c.entryId), tags: f.tags, active: f.active, priority: Number(f.priority) };
    try {
      const res = teachFrom ? await api.post(`/unanswered/${teachFrom}/teach`, body) : entry ? await api.patch(`/entries/${entry.id}`, body) : await api.post("/entries", body);
      const issues = res.issues || [];
      if (res.entry?.held) toast.warning("Saved, but FORKSY has to review this answer before the bot can use it.");
      else toast.success("Answer saved to your draft. Publish it when you are ready.");
      if (issues.some((i) => i.severity === "warn")) setNotes(issues.filter((i) => i.severity === "warn"));
      onSaved?.(res.entry, issues);
      if (!issues.some((i) => i.severity === "warn" || i.severity === "hold")) onClose();
      else setErr({ fields: {}, list: issues });
    } catch (e) {
      const p = problem(e);
      setErr({ fields: p.fields, list: p.list });
      if (!p.list.length) toast.error(p.message);
    } finally {
      setBusy(false);
    }
  };

  const e = err.fields;
  const shown = ["title", "questions", "answer", "priority"];
  const done = notes.length || err.list.some((i) => i.severity !== "block");

  return (
    <FormModal open={open} onClose={onClose} title={entry ? "Edit answer" : teachFrom ? "Teach an answer" : "New answer"} onSubmit={save} busy={busy} submitText={done && !err.list.some((i) => i.severity === "block") ? "Save again" : "Save to draft"} size="lg" disabled={!canEdit}>
      <TextInput label="Title" aria-label="Title" hint="A short name only you see, e.g. Parking" value={f.title} maxLength={80} onChange={(v) => set({ title: v })} error={e.title} disabled={!canEdit} />
      <TextArea
        label="Ways customers ask this (one per line, up to 15)"
        aria-label="Phrasings"
        rows={5}
        value={f.questionsText}
        onChange={(v) => set({ questionsText: v })}
        error={e.questions || Object.entries(e).find(([k]) => k.startsWith("questions["))?.[1]}
        hint={`${questions.length}/15 phrasings. Use the words your guests use ("is there parking", "where do I park"). Typos and small rewordings are matched automatically.`}
        disabled={!canEdit}
      />
      <TextArea label="Answer the bot gives" aria-label="Answer" rows={4} value={f.answer} maxLength={800} onChange={(v) => set({ answer: v })} error={e.answer} hint={`${f.answer.length}/800. Plain text. Never promise a dish is safe for an allergy; contact details come from your profile.`} disabled={!canEdit} />
      <div className="mb-16">
        <div className="fw-semibold text-sm mb-8">Follow-up buttons (optional, up to 3)</div>
        {f.chips.map((c, i) => (
          <div key={i} className="row g-2 align-items-end mb-8">
            <TextInput col={5} label={i === 0 ? "Button label" : undefined} aria-label={`Button ${i + 1} label`} value={c.label} maxLength={30} className="mb-0" onChange={(v) => set({ chips: f.chips.map((x, j) => (j === i ? { ...x, label: v } : x)) })} error={e[`chips[${i}]`]} disabled={!canEdit} />
            <Select col={5} label={i === 0 ? "Opens this answer" : undefined} aria-label={`Button ${i + 1} target`} className="mb-0" value={c.entryId} options={others.map((o) => ({ value: o.id, label: o.title }))} onChange={(v) => set({ chips: f.chips.map((x, j) => (j === i ? { ...x, entryId: v } : x)) })} disabled={!canEdit} />
            {canEdit && (
              <div className="col-2">
                <button type="button" className="btn btn-sm btn-outline-danger radius-8" onClick={() => set({ chips: f.chips.filter((_, j) => j !== i) })}>
                  Remove
                </button>
              </div>
            )}
          </div>
        ))}
        {canEdit && f.chips.length < 3 && others.length > 0 && (
          <button type="button" className="btn btn-sm btn-light radius-8" onClick={() => set({ chips: [...f.chips, { label: "", entryId: "" }] })}>
            Add a button
          </button>
        )}
      </div>
      <div className="row">
        <div className="col-md-6">
          <TagsInput label="Tags (optional)" value={f.tags} onChange={(v) => set({ tags: v.slice(0, 8) })} placeholder="e.g. facilities, then Enter" />
        </div>
        <Select col={3} label="Priority" aria-label="Priority" allowEmpty={false} value={String(f.priority)} onChange={(v) => set({ priority: Number(v) })} options={[0, 1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: n === 0 ? "Normal" : `+${n}` }))} hint="Wins when two answers are equally close" error={e.priority} disabled={!canEdit} />
        <div className="col-md-3 pt-24">
          <Switch label="Active" checked={f.active} onChange={(v) => set({ active: v })} disabled={!canEdit} />
        </div>
      </div>
      <ProblemList list={err.list} skip={shown} />
      {err.list.filter((i) => ["hold", "warn"].includes(i.severity)).length > 0 && (
        <div className="mb-12">
          {err.list.some((i) => i.severity === "hold") && <Badge tone="warning">Held for FORKSY review</Badge>} {err.list.some((i) => i.code === "live_data") && <Badge tone="info">Live data is used instead</Badge>}
        </div>
      )}
      {f.answer && (
        <div className="border radius-8 p-12 bg-neutral-100" aria-label="Preview">
          <div className="text-secondary-light text-xs mb-4">How the bot answers</div>
          <div className="bg-white radius-8 p-8 d-inline-block" style={{ whiteSpace: "pre-wrap", maxWidth: "100%" }}>
            {f.answer}
          </div>
          <div className="d-flex gap-2 flex-wrap mt-8">
            {f.chips.filter((c) => c.label).map((c, i) => (
              <span key={i} className="badge bg-primary-50 text-primary-600 px-12 py-6">
                {c.label}
              </span>
            ))}
            <span className="badge bg-neutral-200 text-neutral-600 px-12 py-6">Menu</span>
            <span className="badge bg-neutral-200 text-neutral-600 px-12 py-6">View cart</span>
          </div>
        </div>
      )}
    </FormModal>
  );
}
