import React, { useCallback, useEffect, useState } from "react";
import { toast } from "react-toastify";
import { Badge, Button, Card, EmptyState, ErrorState, FormModal, Loading, TextArea, TextInput, useConfirm } from "../../../ui";
import { ProblemList, problem, readTextFile } from "./kit";

const MAX = 20000;

/** Policies, allergy statements, catering info ... The bot quotes the best matching passage ("From our info: ...") when no answer matches. */
export default function Documents({ api, canEdit, onChanged }) {
  const confirm = useConfirm();
  const [docs, setDocs] = useState(null);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(null);
  const [f, setF] = useState({ title: "", text: "" });
  const [err, setErr] = useState({ fields: {}, list: [] });
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.get("/documents").then((d) => { setDocs(d); setError(null); }).catch(setError);
  }, [api]);
  useEffect(load, [load]);

  const edit = (d) => {
    setF(d ? { title: d.title, text: d.text } : { title: "", text: "" });
    setErr({ fields: {}, list: [] });
    setOpen(d || {});
  };
  const save = async () => {
    setBusy(true);
    setErr({ fields: {}, list: [] });
    try {
      const res = open?.id ? await api.patch(`/documents/${open.id}`, f) : await api.post("/documents", f);
      if (res.document?.held) toast.warning("Saved, but FORKY has to review this document before the bot can quote it.");
      else toast.success("Document saved to your draft. Publish to use it.");
      setOpen(null);
      load();
      onChanged?.();
    } catch (e) {
      const p = problem(e);
      setErr({ fields: p.fields, list: p.list });
      if (!p.list.length) toast.error(p.message);
    } finally {
      setBusy(false);
    }
  };
  const pickFile = async (e) => {
    try {
      const t = await readTextFile(e.target.files?.[0]);
      setF((x) => ({ title: x.title || (e.target.files?.[0]?.name || "").replace(/\.[a-z0-9]+$/i, ""), text: t }));
    } catch (x) {
      toast.error(x.message);
    }
    e.target.value = "";
  };
  const remove = async (d) => {
    const r = await confirm({ title: `Delete "${d.title}"?`, confirmText: "Delete", danger: true });
    if (!r.confirmed) return;
    try {
      await api.del(`/documents/${d.id}`);
      load();
      onChanged?.();
    } catch (x) {
      toast.error(problem(x).message);
    }
  };

  if (error && !docs) return <ErrorState error={error} onRetry={load} />;
  if (!docs) return <Loading />;
  return (
    <>
      <Card title="Documents" subtitle="Paste or upload text (policies, allergy statements, catering info, parking, history). Up to 20 documents of 20,000 characters. The bot never invents: it only quotes your text, and only when it matches well." actions={canEdit && docs.length < 20 && <Button onClick={() => edit(null)}>Add a document</Button>}>
        {!docs.length ? (
          <EmptyState icon="solar:document-text-outline" title="No documents yet" text="Add your allergy policy or catering terms and the bot can quote them when guests ask." action={canEdit && <Button onClick={() => edit(null)}>Add a document</Button>} />
        ) : (
          <div className="table-responsive"><table className="table bordered-table align-middle mb-0">
            <thead>
              <tr>
                <th>Title</th>
                <th>Size</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d.id}>
                  <td>
                    <div className="fw-semibold">{d.title}</div>
                    <div className="text-secondary-light text-sm text-truncate" style={{ maxWidth: 420 }}>{d.text}</div>
                  </td>
                  <td>{d.chars.toLocaleString("en-CA")} characters</td>
                  <td>{d.held ? <Badge tone="warning">Held for FORKY review</Badge> : <Badge tone="success">Searchable</Badge>}</td>
                  <td className="text-end text-nowrap">
                    <Button variant="outline" onClick={() => edit(d)}>
                      {canEdit ? "Edit" : "View"}
                    </Button>{" "}
                    {canEdit && (
                      <Button variant="outline-danger" onClick={() => remove(d)}>
                        Delete
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </Card>
      <FormModal open={!!open} onClose={() => setOpen(null)} title={open?.id ? "Edit document" : "Add a document"} onSubmit={save} busy={busy} size="lg" submitText="Save to draft" disabled={!canEdit}>
        <TextInput label="Title" aria-label="Document title" value={f.title} maxLength={80} onChange={(v) => setF({ ...f, title: v })} error={err.fields.title} disabled={!canEdit} />
        <div className="mb-8">
          <label className="btn btn-outline-primary-600 btn-sm radius-8 mb-0">
            Load from a .txt / .md file
            <input type="file" hidden accept=".txt,.md,.markdown,text/plain,text/markdown" onChange={pickFile} disabled={!canEdit} />
          </label>
        </div>
        <TextArea label="Text" aria-label="Document text" rows={12} value={f.text} onChange={(v) => setF({ ...f, text: v })} error={err.fields.text} hint={`${f.text.length.toLocaleString("en-CA")} / ${MAX.toLocaleString("en-CA")} characters. Plain text or Markdown. Do not paste personal data.`} disabled={!canEdit} />
        {f.text.length > MAX && <div className="text-danger-main text-sm mb-8">Too long: split this into several documents.</div>}
        <ProblemList list={err.list} skip={["title", "text"]} />
      </FormModal>
    </>
  );
}
