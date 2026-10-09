import React, { useCallback, useEffect, useState } from "react";
import { toast } from "react-toastify";
import { Badge, Button, Card, EmptyState, ErrorState, FormModal, Loading, Select, TagsInput, TextInput, useConfirm } from "../../../ui";
import { problem } from "./kit";

/** Restaurant nicknames for menu items / categories and groups of words that mean the same thing. */
export default function Aliases({ api, canEdit, onChanged, central }) {
  const confirm = useConfirm();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [menu, setMenu] = useState({ items: [], categories: [] });
  const [aliasOpen, setAliasOpen] = useState(false);
  const [a, setA] = useState({ kind: "item", alias: "", target: "" });
  const [synOpen, setSynOpen] = useState(null);
  const [s, setS] = useState({ term: "", alternates: [] });
  const [err, setErr] = useState({ fields: {} });
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.get("/aliases").then((d) => { setData(d); setError(null); }).catch(setError);
  }, [api]);
  useEffect(load, [load]);
  useEffect(() => {
    if (!central) api.get("/menu-options").then(setMenu).catch(() => undefined);
  }, [api, central]);
  const done = () => {
    load();
    onChanged?.();
  };

  const saveAlias = async () => {
    setBusy(true);
    setErr({ fields: {} });
    try {
      await api.post("/aliases", a.kind === "item" ? { kind: "item", alias: a.alias, targetId: a.target } : { kind: "category", alias: a.alias, targetName: a.target });
      toast.success("Nickname saved to your draft");
      setAliasOpen(false);
      done();
    } catch (e) {
      const p = problem(e);
      setErr({ fields: p.fields });
      if (!Object.keys(p.fields).length) toast.error(p.message);
    } finally {
      setBusy(false);
    }
  };
  const saveSyn = async () => {
    setBusy(true);
    setErr({ fields: {} });
    try {
      if (synOpen?.id) await api.patch(`/synonyms/${synOpen.id}`, s);
      else await api.post("/synonyms", s);
      toast.success("Synonyms saved to your draft");
      setSynOpen(null);
      done();
    } catch (e) {
      const p = problem(e);
      setErr({ fields: p.fields });
      if (!Object.keys(p.fields).length) toast.error(p.message);
    } finally {
      setBusy(false);
    }
  };
  const del = async (path, what) => {
    const r = await confirm({ title: `Remove ${what}?`, confirmText: "Remove", danger: true });
    if (!r.confirmed) return;
    try {
      await api.del(path);
      done();
    } catch (e) {
      toast.error(problem(e).message);
    }
  };

  if (error && !data) return <ErrorState error={error} onRetry={load} />;
  if (!data) return <Loading />;

  return (
    <div className="row g-3">
      {!central && (
        <div className="col-xl-6">
          <Card title="Nicknames" subtitle='Names guests use for your items: "marg" means Margherita. Only fixed nicknames, never guesses.' actions={canEdit && <Button onClick={() => { setA({ kind: "item", alias: "", target: "" }); setErr({ fields: {} }); setAliasOpen(true); }}>Add nickname</Button>}>
            {!data.aliases.length ? (
              <EmptyState icon="solar:tag-outline" title="No nicknames yet" text="Add the short names your regulars use for dishes or menu sections." />
            ) : (
              <div className="table-responsive"><table className="table table-sm align-middle mb-0">
                <tbody>
                  {data.aliases.map((x) => (
                    <tr key={x.id}>
                      <td>
                        <b>{x.alias}</b> <span className="text-secondary-light">means</span> {x.targetName} <Badge tone="neutral">{x.kind === "item" ? "item" : "category"}</Badge>
                      </td>
                      <td className="text-end">
                        {canEdit && (
                          <Button variant="outline-danger" onClick={() => del(`/aliases/${x.id}`, `the nickname "${x.alias}"`)}>
                            Remove
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            )}
          </Card>
        </div>
      )}
      <div className={central ? "col-12" : "col-xl-6"}>
        <Card title="Synonyms" subtitle='Words that mean the same: "soft drink" = "pop". Guests may use either.' actions={canEdit && <Button onClick={() => { setS({ term: "", alternates: [] }); setErr({ fields: {} }); setSynOpen({}); }}>Add synonyms</Button>}>
          {!data.synonyms.length ? (
            <EmptyState icon="solar:text-field-outline" title="No synonyms yet" text="Group the different words your guests use for the same thing." />
          ) : (
            <div className="table-responsive"><table className="table table-sm align-middle mb-0">
              <tbody>
                {data.synonyms.map((x) => (
                  <tr key={x.id}>
                    <td>
                      <b>{x.term}</b> <span className="text-secondary-light">=</span> {x.alternates.join(", ")}
                    </td>
                    <td className="text-end text-nowrap">
                      {canEdit && (
                        <>
                          <Button variant="outline" onClick={() => { setS({ term: x.term, alternates: x.alternates }); setErr({ fields: {} }); setSynOpen(x); }}>
                            Edit
                          </Button>{" "}
                          <Button variant="outline-danger" onClick={() => del(`/synonyms/${x.id}`, `the group "${x.term}"`)}>
                            Remove
                          </Button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
        </Card>
      </div>

      <FormModal open={aliasOpen} onClose={() => setAliasOpen(false)} title="Add a nickname" onSubmit={saveAlias} busy={busy} submitText="Save nickname">
        <Select label="What is it for?" aria-label="Nickname kind" allowEmpty={false} value={a.kind} onChange={(v) => setA({ ...a, kind: v, target: "" })} options={[{ value: "item", label: "A menu item" }, { value: "category", label: "A menu section" }]} />
        <TextInput label="The nickname" aria-label="Nickname" value={a.alias} maxLength={40} onChange={(v) => setA({ ...a, alias: v })} error={err.fields.alias} hint='What guests type, e.g. "marg"' />
        <Select
          label={a.kind === "item" ? "It means this item" : "It means this section"}
          aria-label="Nickname target"
          value={a.target}
          onChange={(v) => setA({ ...a, target: v })}
          options={a.kind === "item" ? menu.items.map((i) => ({ value: i.id, label: `${i.name}${i.category ? ` (${i.category})` : ""}` })) : menu.categories.map((c) => ({ value: c, label: c }))}
          error={err.fields.targetId || err.fields.targetName}
        />
      </FormModal>

      <FormModal open={!!synOpen} onClose={() => setSynOpen(null)} title={synOpen?.id ? "Edit synonyms" : "Add synonyms"} onSubmit={saveSyn} busy={busy} submitText="Save synonyms">
        <TextInput label="The main word" aria-label="Main word" value={s.term} maxLength={40} onChange={(v) => setS({ ...s, term: v })} error={err.fields.term} hint='e.g. "pop"' />
        <TagsInput label="Other ways to say it (press Enter after each)" value={s.alternates} onChange={(v) => setS({ ...s, alternates: v.slice(0, 10) })} placeholder='e.g. "soft drink"' />
        {(err.fields.alternates || err.fields.term) && <div className="text-danger-main text-sm" role="alert">{err.fields.alternates || err.fields.term}</div>}
      </FormModal>
    </div>
  );
}
