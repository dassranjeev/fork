import React, { useState } from "react";
import { Badge, Button, Card, EmptyState, ErrorState, FormModal, FormRow, IconButton, Loading, NumberInput, PageHeader, Switch, TextArea, TextInput, useConfirm } from "../../ui";
import { act, http } from "../../lib/api";
import { useFetch, useForm, useSubmit } from "../../lib/hooks";
import { useAuth } from "../../lib/auth";

function ModuleModal({ item, onClose, onDone }) {
  const f = useForm(item ? { title: item.title, content: item.content, sortOrder: item.sortOrder ?? 0, passMark: item.passMark ?? 80, active: item.active, quiz: item.quiz || [] } : { title: "", content: "", sortOrder: 0, passMark: 80, active: true, quiz: [] });
  const { busy, run } = useSubmit();
  const v = f.values;
  const setQ = (i, patch) => f.set("quiz", v.quiz.map((q, idx) => (idx === i ? { ...q, ...patch } : q)));
  const valid = v.title && v.content && v.quiz.every((q) => q.question && q.options.length >= 2 && q.options.every(Boolean) && q.correctIndex < q.options.length);
  const submit = () => {
    const body = { ...v, sortOrder: Number(v.sortOrder) || 0, passMark: Number(v.passMark) };
    return run(() => (item ? http.patch(`/admin/drivers/training-modules/${item.id}`, body) : http.post("/admin/drivers/training-modules", body)), { success: item ? "Module updated" : "Module created", onDone });
  };
  return (
    <FormModal open onClose={onClose} title={item ? "Edit training module" : "New training module"} size="lg" onSubmit={submit} busy={busy} disabled={!valid}>
      <FormRow>
        <TextInput col={8} label="Title" required {...f.bind("title")} />
        <NumberInput col={2} label="Order" step={1} {...f.bind("sortOrder")} />
        <NumberInput col={2} label="Pass mark" suffix="%" min={0} max={100} {...f.bind("passMark")} />
        <TextArea col={12} label="Content" rows={4} required {...f.bind("content")} />
      </FormRow>
      <div className="d-flex justify-content-between align-items-center mb-8">
        <h6 className="mb-0 text-md">Quiz questions</h6>
        <Button variant="light" icon="solar:add-circle-outline" onClick={() => f.set("quiz", [...v.quiz, { question: "", options: ["", ""], correctIndex: 0 }])}>Add question</Button>
      </div>
      {v.quiz.length === 0 && <div className="text-secondary-light text-sm mb-16">No questions. Drivers will pass automatically after reading.</div>}
      {v.quiz.map((q, i) => (
        <div key={i} className="border radius-8 p-12 mb-12">
          <div className="d-flex gap-2 align-items-start">
            <div className="flex-grow-1"><TextInput label={`Question ${i + 1}`} value={q.question} onChange={(x) => setQ(i, { question: x })} className="mb-8" /></div>
            <IconButton icon="solar:trash-bin-minimalistic-outline" tone="danger" title="Remove" onClick={() => f.set("quiz", v.quiz.filter((_, idx) => idx !== i))} />
          </div>
          {q.options.map((o, oi) => (
            <div key={oi} className="d-flex align-items-center gap-2 mb-8">
              <input type="radio" className="form-check-input mt-0" checked={q.correctIndex === oi} onChange={() => setQ(i, { correctIndex: oi })} title="Correct answer" />
              <input className="form-control radius-8" placeholder={`Option ${oi + 1}`} value={o} onChange={(e) => setQ(i, { options: q.options.map((x, xi) => (xi === oi ? e.target.value : x)) })} />
              {q.options.length > 2 && <IconButton icon="solar:close-circle-outline" title="Remove option" onClick={() => setQ(i, { options: q.options.filter((_, xi) => xi !== oi), correctIndex: q.correctIndex >= oi && q.correctIndex > 0 ? q.correctIndex - 1 : q.correctIndex })} />}
            </div>
          ))}
          <Button variant="link" onClick={() => setQ(i, { options: [...q.options, ""] })}>+ Add option</Button>
        </div>
      ))}
      <Switch label="Active" checked={v.active} onChange={(x) => f.set("active", x)} />
    </FormModal>
  );
}

export default function Training() {
  const { can } = useAuth();
  const confirm = useConfirm();
  const { data, loading, error, reload } = useFetch("/admin/drivers/training-modules");
  const [modal, setModal] = useState(undefined);
  const rows = Array.isArray(data) ? data : data?.data || [];
  const remove = async (m) => {
    const r = await confirm({ title: `Delete "${m.title}"?`, danger: true, confirmText: "Delete" });
    if (r.confirmed && (await act(() => http.del(`/admin/drivers/training-modules/${m.id}`), { success: "Module deleted" })) !== undefined) reload();
  };
  return (
    <>
      <PageHeader
        title="Training modules"
        subtitle="Content and quizzes drivers complete during onboarding"
        crumbs={[{ label: "Drivers", to: "/drivers" }, { label: "Training" }]}
        actions={can("drivers", "create") && <Button icon="solar:add-circle-outline" onClick={() => setModal(null)}>New module</Button>}
      />
      {error && <ErrorState error={error} onRetry={reload} />}
      {loading && !data && <Loading />}
      {!loading && !error && rows.length === 0 && <Card><EmptyState icon="solar:square-academic-cap-outline" title="No training modules" text="Create a module so new drivers can complete training." /></Card>}
      <div className="row gy-3">
        {[...rows].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)).map((m) => (
          <div key={m.id} className="col-lg-6">
            <Card
              title={`${m.sortOrder ?? 0}. ${m.title}`}
              subtitle={`${m.quiz?.length || 0} question(s) · pass mark ${m.passMark}%`}
              actions={
                <>
                  <Badge tone={m.active ? "success" : "neutral"}>{m.active ? "Active" : "Inactive"}</Badge>
                  {can("drivers", "edit") && <IconButton icon="solar:pen-outline" tone="primary" title="Edit" onClick={() => setModal(m)} />}
                  {can("drivers", "delete") && <IconButton icon="solar:trash-bin-minimalistic-outline" tone="danger" title="Delete" onClick={() => remove(m)} />}
                </>
              }
            >
              <p className="text-secondary-light mb-0" style={{ whiteSpace: "pre-wrap" }}>{m.content}</p>
            </Card>
          </div>
        ))}
      </div>
      {modal !== undefined && <ModuleModal item={modal} onClose={() => setModal(undefined)} onDone={() => { setModal(undefined); reload(); }} />}
    </>
  );
}
