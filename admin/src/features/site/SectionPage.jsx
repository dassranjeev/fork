import React, { useEffect, useMemo, useState } from "react";
import { Icon } from "@iconify/react/offline";
import { Link, useParams } from "react-router-dom";
import { toast } from "react-toastify";
import { Badge, Button, Card, EmptyState, ErrorState, Loading, PageHeader, useConfirm } from "../../ui";
import { http } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { Branding, PICTURE_FIELDS } from "./Branding";
import { HistoryModal } from "./History";
import { SchemaForm } from "./SchemaForm";
import { GUIDE_URL, SECTION_BY_KEY, fmtWhen, messageOf, problemsOf, same, useSiteSection } from "./shared";

/** One section of the website settings: a form built from the API's field description, with save, discard, reset and history. */
export default function SectionPage() {
  const { section } = useParams();
  const meta = SECTION_BY_KEY[section];
  if (!meta) {
    return (
      <div className="card p-24">
        <EmptyState icon="solar:question-circle-outline" title="No such settings page" text={`"${section}" is not one of the website settings.`} action={<Link to="/site" className="btn btn-sm btn-primary-600 radius-8">Website settings overview</Link>} />
      </div>
    );
  }
  return <SectionEditor key={section} section={section} meta={meta} />;
}

function SectionEditor({ section, meta }) {
  const { user, can } = useAuth();
  const confirm = useConfirm();
  const isSuper = user?.type === "SUPER_ADMIN";
  const canEdit = can("site", "edit") && (section !== "scripts" || isSuper);
  const { loading, error, schema, options, saved, reload, setSaved } = useSiteSection(section);
  const [form, setForm] = useState(null);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(null);
  const [history, setHistory] = useState(false);

  useEffect(() => {
    if (saved) setForm(saved.value);
  }, [saved?.version]); // eslint-disable-line react-hooks/exhaustive-deps

  const changed = useMemo(() => (form && saved ? Object.keys(form).filter((k) => !same(form[k], saved.value[k])) : []), [form, saved]);
  const dirty = changed.length > 0;
  const problemCount = Object.keys(errors).length;

  if (loading && !saved) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!schema || !saved || !form) return <Loading />;

  const desc = schema[section];
  const hide = section === "branding" ? PICTURE_FIELDS : [];
  const shown = { ...desc, fields: Object.fromEntries(Object.entries(desc.fields).filter(([k]) => !hide.includes(k))) };

  const save = async () => {
    setBusy("save");
    setErrors({});
    try {
      const r = await http.patch(`/admin/site/${section}`, Object.fromEntries(changed.map((k) => [k, form[k]])));
      setSaved(r);
      setForm(r.value);
      toast.success(r.changed ? `Saved (version ${r.version})` : "Nothing needed saving");
    } catch (e) {
      const p = problemsOf(e);
      setErrors(p);
      toast.error(Object.keys(p).length ? `${Object.keys(p).length} field${Object.keys(p).length === 1 ? "" : "s"} need attention` : messageOf(e));
    } finally {
      setBusy(null);
    }
  };

  const reset = async () => {
    const c = await confirm({ title: `Reset "${meta.title}" to its defaults?`, message: "Everything saved on this page is replaced by the starting values. The old values stay in the history and can be restored.", danger: true, confirmText: "Reset" });
    if (!c.confirmed) return;
    setBusy("reset");
    try {
      const r = await http.post(`/admin/site/${section}/reset`);
      setSaved(r);
      setForm(r.value);
      setErrors({});
      toast.success("Back to the defaults");
    } catch (e) {
      toast.error(messageOf(e));
    } finally {
      setBusy(null);
    }
  };

  const onPictures = (branding, version) => {
    // only the picture fields come from the server: the other fields keep what is being typed
    const pics = Object.fromEntries(PICTURE_FIELDS.map((k) => [k, branding[k]]));
    setSaved({ ...saved, value: { ...saved.value, ...pics }, version: version ?? saved.version });
    setForm((f) => ({ ...f, ...pics }));
  };

  return (
    <>
      <PageHeader
        title={meta.title}
        subtitle={meta.subtitle}
        crumbs={[{ label: "Website settings", to: "/site" }, { label: meta.label }]}
        actions={
          <>
            <Button variant="light" icon="solar:history-outline" onClick={() => setHistory(true)} data-testid="open-history">History</Button>
            {canEdit && <Button variant="light" icon="solar:restart-outline" disabled={!!busy} onClick={reset} data-testid="reset">Reset to defaults</Button>}
            {canEdit && <Button variant="light" disabled={!dirty || !!busy} onClick={() => { setForm(saved.value); setErrors({}); }} data-testid="discard">Discard changes</Button>}
            {canEdit && <Button icon="solar:diskette-outline" loading={busy === "save"} disabled={!dirty || (!!busy && busy !== "save")} onClick={save} data-testid="save">Save</Button>}
          </>
        }
      />

      <div className="d-flex flex-wrap align-items-center gap-3 mb-16 text-sm text-secondary-light" data-testid="section-status">
        {saved.isDefault ? <Badge tone="neutral">Never saved: the starting values are shown</Badge> : <span>Version {saved.version}, saved {fmtWhen(saved.updatedAt)}{saved.updatedByName ? ` by ${saved.updatedByName}` : ""}</span>}
        {dirty && <Badge tone="warning">Unsaved changes: {changed.join(", ")}</Badge>}
        {!canEdit && <Badge tone="info">{section === "scripts" ? "Only a Super Admin can change custom code" : "You can look but not change (your role has no edit permission)"}</Badge>}
        <a href={GUIDE_URL} target="_blank" rel="noopener noreferrer" className="ms-auto text-primary-600">How this reaches the website <Icon icon="solar:arrow-right-up-outline" /></a>
      </div>

      {problemCount > 0 && (
        <div className="alert alert-danger radius-8" role="alert" data-testid="problems">
          <div className="fw-semibold mb-4">Nothing was saved: {problemCount} problem{problemCount === 1 ? "" : "s"}</div>
          <ul className="mb-0 ps-3">
            {Object.entries(errors).slice(0, 12).map(([p, m]) => (
              <li key={p}><span className="font-monospace">{p.replace(`${section}.`, "")}</span> {m}</li>
            ))}
          </ul>
        </div>
      )}

      {section === "scripts" && <CodeWarning canEdit={canEdit} enabled={form.enabled} />}
      {section === "branding" && <Branding options={options} value={form} canEdit={canEdit} onChange={onPictures} />}

      {Object.keys(shown.fields).length > 0 && (
        <Card title={section === "branding" ? "Names and colours" : undefined} className="mb-24">
          <SchemaForm section={section} desc={shown} value={form} onChange={setForm} errors={errors} options={options} readOnly={!canEdit} />
        </Card>
      )}

      <HistoryModal open={history} section={section} canRestore={canEdit} onClose={() => setHistory(false)} onRestored={() => { setHistory(false); reload(); }} />
    </>
  );
}

function CodeWarning({ canEdit, enabled }) {
  return (
    <div className="alert alert-warning radius-8 d-flex gap-3" role="alert" data-testid="code-warning">
      <Icon icon="solar:danger-triangle-outline" className="text-2xl flex-shrink-0" />
      <div className="text-sm">
        <div className="fw-semibold mb-4">This code runs on every page of the website, in every visitor's browser.</div>
        <ul className="mb-0 ps-3">
          <li>Only paste code you wrote or trust. A mistake here can break the website for everyone.</li>
          <li>It is checked when you save (CSS braces, JavaScript syntax), never run on the server.</li>
          <li>The <strong>Enabled</strong> switch is the kill switch: switched off, nothing is published and nothing is deleted. Every save is kept in History, so a bad change is one click to undo.</li>
          <li>The website's content security policy blocks inline and foreign scripts unless the front-end allows them (see the guide). {enabled ? "The code below is switched on." : "The code below is switched off."}</li>
          {!canEdit && <li><strong>You can read it, but only a Super Admin can change it.</strong></li>}
        </ul>
      </div>
    </div>
  );
}
