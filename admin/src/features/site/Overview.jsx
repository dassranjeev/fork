import React, { useState } from "react";
import { Icon } from "@iconify/react/offline";
import { Link } from "react-router-dom";
import { Badge, Button, Card, EmptyState, ErrorState, Loading, PageHeader, Segmented, TextInput } from "../../ui";
import { API_URL, http } from "../../lib/api";
import { useFetch } from "../../lib/hooks";
import { GUIDE_URL, SECTIONS, messageOf } from "./shared";

const TONE = { error: "danger", warning: "warning", info: "info" };
const ICON = { error: "solar:close-circle-outline", warning: "solar:danger-triangle-outline", info: "solar:info-circle-outline" };

/** Website settings: what is missing or wrong, how a page looks to search engines and AI assistants, and the files the website serves. */
export default function Overview() {
  const checks = useFetch("/admin/site/checks");
  const files = useFetch("/public/site", { sections: "site" });
  return (
    <>
      <PageHeader
        title="Website settings"
        subtitle="Logo and icons, title, footer, meta tags, SEO, GEO, AEO, AIO and custom code for the customer website: change them here, the website picks them up without a new release"
        crumbs={[{ label: "Website settings" }]}
        actions={<a className="btn btn-sm btn-outline-neutral-300 text-primary-light radius-8" href={GUIDE_URL} target="_blank" rel="noopener noreferrer">Guide for the front-end <Icon icon="solar:arrow-right-up-outline" /></a>}
      />
      <div className="row g-3 mb-24" data-testid="section-links">
        {SECTIONS.map((s) => (
          <div key={s.key} className="col-12 col-md-6 col-xl-4">
            <Link to={`/site/${s.key}`} className="card radius-12 p-16 h-100 text-decoration-none hover-border-primary" data-testid={`link-${s.key}`}>
              <div className="d-flex gap-3 align-items-start">
                <span className="w-40-px h-40-px bg-primary-100 text-primary-600 rounded-circle d-inline-flex align-items-center justify-content-center flex-shrink-0"><Icon icon={s.icon} className="text-xl" /></span>
                <span>
                  <span className="d-block fw-semibold text-primary-light">{s.title}</span>
                  <span className="d-block text-secondary-light text-sm">{s.subtitle}</span>
                </span>
              </div>
            </Link>
          </div>
        ))}
      </div>
      <div className="row">
        <div className="col-12 col-xl-6">
          <Health checks={checks} />
          <FilesCard files={files.data} />
        </div>
        <div className="col-12 col-xl-6">
          <Preview />
        </div>
      </div>
    </>
  );
}

function Health({ checks }) {
  const { data, loading, error, reload } = checks;
  return (
    <Card title="Health check" subtitle="What is missing or wrong, errors first" className="mb-24" actions={<Button variant="light" icon="solar:refresh-outline" onClick={reload}>Check again</Button>}>
      {loading && !data && <Loading minHeight={80} />}
      {error && <ErrorState error={error} onRetry={reload} />}
      {data && (
        <>
          <div className="d-flex gap-2 mb-12" data-testid="check-summary">
            <Badge tone={data.summary.errors ? "danger" : "success"}>{data.summary.errors} error{data.summary.errors === 1 ? "" : "s"}</Badge>
            <Badge tone={data.summary.warnings ? "warning" : "success"}>{data.summary.warnings} warning{data.summary.warnings === 1 ? "" : "s"}</Badge>
            <Badge tone="info">{data.summary.infos} suggestion{data.summary.infos === 1 ? "" : "s"}</Badge>
          </div>
          {data.checks.length === 0 && <EmptyState icon="solar:check-circle-outline" title="Everything looks good" />}
          <ul className="list-unstyled mb-0" data-testid="checks">
            {data.checks.map((c) => (
              <li key={c.id} className="d-flex gap-3 align-items-start py-8 border-bottom">
                <Icon icon={ICON[c.level]} className={`text-xl mt-2 text-${TONE[c.level]}-600`} />
                <div className="flex-grow-1 text-sm">
                  <span className="text-secondary-light text-xs text-uppercase me-2">{c.area}</span>
                  {c.message}
                </div>
                <Link to={`/site/${c.section}`} className="text-primary-600 text-sm text-nowrap">Open</Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

function FilesCard({ files }) {
  const base = API_URL.replace(/\/$/, "");
  const rows = [
    ["Settings the website reads", `${base}/public/site`],
    ["robots.txt", `${base}/public/site/robots.txt`],
    ["sitemap.xml", `${base}/public/site/sitemap.xml`],
    ["llms.txt (for AI assistants)", `${base}/public/site/llms.txt`],
    ["llms-full.txt", `${base}/public/site/llms-full.txt`],
    ["Web app manifest", `${base}/public/site/manifest.webmanifest`],
    ["Questions and answers", `${base}/public/site/faq`],
  ];
  return (
    <Card title="Files the website serves" subtitle="Open one to see what search engines and AI assistants get (a 404 means it is switched off)" className="mb-24">
      <ul className="list-unstyled mb-0">
        {rows.map(([label, url]) => (
          <li key={url} className="d-flex justify-content-between gap-3 py-6 border-bottom text-sm">
            <span>{label}</span>
            <a href={url} target="_blank" rel="noopener noreferrer" className="text-primary-600 font-monospace text-truncate" style={{ maxWidth: "60%" }}>{url.replace(base, "")}</a>
          </li>
        ))}
      </ul>
      {files?.site?.url && <div className="text-secondary-light text-xs mt-12">The website address used in links is <span className="font-monospace">{files.site.url}</span> (General &gt; Site address).</div>}
    </Card>
  );
}

function Preview() {
  const [path, setPath] = useState("/order");
  const [lang, setLang] = useState("en-CA");
  const [res, setRes] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState("summary");
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      setRes(await http.get("/public/site/head", { path: path.startsWith("/") ? path : `/${path}`, lang }));
    } catch (e) {
      setRes(null);
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Preview a page" subtitle="Type a page of the customer website and see exactly what the website puts in its head: title, description, meta tags and structured data" className="mb-24">
      <form onSubmit={(e) => { e.preventDefault(); go(); }} className="row g-2 align-items-end mb-12">
        <div className="col-12 col-md-6"><TextInput label="Page" hint="/order, /order/r/fresh-basket-supermarket, /order?t=GROCERY" value={path} onChange={setPath} data-testid="preview-path" /></div>
        <div className="col-6 col-md-3"><TextInput label="Language" value={lang} onChange={setLang} /></div>
        <div className="col-6 col-md-3 mb-16"><Button loading={busy} onClick={go} data-testid="preview-go" icon="solar:eye-outline">Preview</Button></div>
      </form>
      {error && <ErrorState error={error} />}
      {res && (
        <div data-testid="preview-result">
          <div className="mb-12">
            <div className="text-primary-600 fw-semibold" style={{ fontSize: 18 }} data-testid="preview-title">{res.title}</div>
            <div className="text-success-main text-sm text-truncate">{res.canonical}</div>
            <div className="text-sm">{res.description}</div>
          </div>
          <div className="d-flex gap-2 flex-wrap mb-12">
            <Badge tone={/^noindex/.test(res.robots) ? "danger" : "success"}>{/^noindex/.test(res.robots) ? "Not indexed" : "Indexed"}</Badge>
            <Badge tone="neutral">{res.source}</Badge>
            <Badge tone="info">{res.jsonLd.length} structured data block{res.jsonLd.length === 1 ? "" : "s"}</Badge>
            <Badge tone="neutral">{res.meta.length} meta tags</Badge>
          </div>
          <div className="mb-12"><Segmented options={[{ value: "summary", label: "Meta tags" }, { value: "jsonld", label: "Structured data" }, { value: "html", label: "HTML" }]} value={tab} onChange={setTab} /></div>
          {tab === "summary" && (
            <div className="table-responsive" style={{ maxHeight: 360, overflow: "auto" }}>
              <table className="table table-sm mb-0">
                <tbody>
                  <tr><td className="fw-semibold">robots</td><td className="font-monospace text-xs">{res.robots}</td></tr>
                  {res.meta.map((m, i) => (
                    <tr key={i}><td className="fw-semibold text-nowrap">{m.name || m.property || m.httpEquiv}</td><td className="text-xs">{m.content}</td></tr>
                  ))}
                  {res.link.map((l, i) => (
                    <tr key={`l${i}`}><td className="fw-semibold text-nowrap">link {l.rel}</td><td className="text-xs text-break">{l.href}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {tab === "jsonld" && (res.jsonLd.length ? <pre className="bg-neutral-100 radius-8 p-12 text-xs" style={{ maxHeight: 360, overflow: "auto" }}>{JSON.stringify(res.jsonLd, null, 2)}</pre> : <div className="text-secondary-light text-sm">This page has no structured data.</div>)}
          {tab === "html" && <pre className="bg-neutral-100 radius-8 p-12 text-xs" style={{ maxHeight: 360, overflow: "auto" }}>{res.html}</pre>}
        </div>
      )}
    </Card>
  );
}
