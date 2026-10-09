import React from "react";
import { toast } from "react-toastify";
import { Badge, Button, Card, FileInput, StatCard, Switch, TagsInput, TextArea, TextInput } from "../../ui";
import { safeImgUrl } from "../../lib/safe";

/** Building blocks shared by the Admin "Assistant" pages and the restaurant portal's Assistant page. */

export const DEFAULT_COLOR = "#FF6917";
export const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const clone = (v) => JSON.parse(JSON.stringify(v));

/** Same rules as the server (which is the real check): https origins only, no path / wildcard; http://localhost[:port] for development. */
export function originProblem(raw) {
  const s = String(raw || "").trim();
  if (!s) return "empty";
  if (s === "http://localhost:*") return null;
  if (/[\s*]/.test(s)) return "no wildcards or spaces";
  let u;
  try {
    u = new URL(s);
  } catch {
    return "not a valid URL (example: https://www.mybistro.ca)";
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return "must start with https://";
  if (u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) return "origin only: no path, query or login";
  if (!local && !u.hostname.includes(".")) return "needs a full domain name";
  return null;
}

export function copyText(text) {
  const done = () => toast.success("Copied");
  try {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done, () => toast.error("Select the text and press Ctrl+C"));
      return;
    }
  } catch {
    /* fall through */
  }
  toast.error("Select the text and press Ctrl+C");
}

/** Question-and-answer editor (max 20 pairs). */
export function FaqEditor({ faqs, onChange, canEdit = true, title = "FAQs", help }) {
  const bad = faqs.some((f) => !f.q.trim() || !f.a.trim());
  return (
    <div>
      <div className="fw-semibold mb-8">{title}</div>
      <div className="text-secondary-light text-sm mb-12">{help || "The bot answers these when a guest asks something similar (up to 20)."}</div>
      {faqs.map((f, i) => (
        <div key={i} className="border radius-8 p-12 mb-12">
          <TextInput label={`Question ${i + 1}`} aria-label={`Question ${i + 1}`} value={f.q} maxLength={120} className="mb-8" disabled={!canEdit} onChange={(v) => onChange(faqs.map((x, j) => (j === i ? { ...x, q: v } : x)))} hint={`${f.q.length}/120`} />
          <TextArea label="Answer" aria-label={`Answer ${i + 1}`} rows={2} value={f.a} maxLength={500} className="mb-8" disabled={!canEdit} onChange={(v) => onChange(faqs.map((x, j) => (j === i ? { ...x, a: v } : x)))} hint={`${f.a.length}/500`} />
          {canEdit && (
            <Button variant="outline-danger" onClick={() => onChange(faqs.filter((_, j) => j !== i))}>
              Remove question
            </Button>
          )}
        </div>
      ))}
      {!faqs.length && !canEdit && <div className="text-secondary-light text-sm">No questions yet.</div>}
      {canEdit && faqs.length < 20 && (
        <Button variant="light" icon="solar:add-circle-outline" onClick={() => onChange([...faqs, { q: "", a: "" }])}>
          Add a question
        </Button>
      )}
      {bad && <div className="text-danger-main text-sm mt-8">Every question needs both a question and an answer.</div>}
    </div>
  );
}
export const faqsInvalid = (faqs) => faqs.some((f) => !f.q.trim() || !f.a.trim());

/** Allowed website origins with validation hints. */
export function OriginsEditor({ origins, onChange, disabled }) {
  const problems = origins.map((o) => [o, originProblem(o)]).filter(([, p]) => p);
  return (
    <>
      <TagsInput
        label="Websites that may show the assistant"
        value={origins}
        onChange={(v) => onChange(v.slice(0, 10))}
        placeholder="https://www.mybistro.ca, then Enter"
        hint="Only the website address (origin): https://www.mybistro.ca. No page path, no wildcards. Up to 10. Add both www and non-www if you use both."
      />
      {problems.length > 0 && (
        <div className="text-danger-main text-sm mb-12" role="alert">
          {problems.map(([o, p]) => (
            <div key={o}>
              "{o}": {p}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
export const originsInvalid = (origins) => origins.some((o) => originProblem(o));

/** The embed snippet in a copy box, with an optional "Rotate key". */
export function EmbedBox({ snippet, onRotate, rotating, id = "assistant-embed" }) {
  return (
    <>
      <label className="form-label fw-semibold text-sm" htmlFor={id}>
        Embed code
      </label>
      <textarea id={id} className="form-control radius-8 font-monospace text-sm" rows={4} readOnly value={snippet} onFocus={(e) => e.target.select()} />
      <div className="d-flex flex-wrap gap-2 mt-12">
        <Button icon="solar:copy-outline" onClick={() => copyText(snippet)}>
          Copy
        </Button>
        {onRotate && (
          <Button variant="outline-danger" loading={rotating} onClick={onRotate}>
            Rotate key
          </Button>
        )}
      </div>
      <ul className="text-secondary-light text-sm mt-16 mb-0 ps-20">
        <li>The assistant only loads on the websites in the allowed list; anywhere else it stays hidden.</li>
        <li>If the site uses a Content-Security-Policy, allow the FORKSY API address in <code>script-src</code> and <code>connect-src</code>.</li>
        <li>Rotate the key to shut off a copy of the code someone else is using.</li>
      </ul>
    </>
  );
}

/** Round logo (with a lettered fallback). */
export function Logo({ src, name, size = 56 }) {
  const url = safeImgUrl(src);
  return url ? (
    <img src={url} alt="" width={size} height={size} className="rounded-circle object-fit-cover border" style={{ width: size, height: size }} referrerPolicy="no-referrer" />
  ) : (
    <div className="rounded-circle d-flex align-items-center justify-content-center bg-primary-50 text-primary-600 fw-bold" style={{ width: size, height: size }} aria-hidden="true">
      {String(name || "F").trim().charAt(0).toUpperCase()}
    </div>
  );
}

/** Editable branding: name, greeting, accent colour, logo (upload). */
export function BrandingFields({ form, set, disabled, fallbackLogo, nameHint }) {
  return (
    <>
      <div className="row">
        <TextInput col={6} label="Assistant name" aria-label="Assistant name" value={form.name} maxLength={40} onChange={(v) => set({ name: v })} disabled={disabled} hint={nameHint || `${form.name.length}/40, shown in the chat header`} />
        <div className="col-md-6 mb-16">
          <label className="form-label fw-semibold text-sm" htmlFor="assistant-color">
            Accent colour
          </label>
          <div className="d-flex gap-2 align-items-center flex-wrap">
            <input id="assistant-color" type="color" className="form-control form-control-color" value={form.color || DEFAULT_COLOR} disabled={disabled} onChange={(e) => set({ color: e.target.value.toUpperCase() })} />
            <code>{form.color || `${DEFAULT_COLOR} (default)`}</code>
            {form.color && !disabled && (
              <Button variant="light" onClick={() => set({ color: null })}>
                Use default
              </Button>
            )}
          </div>
          <div className="text-secondary-light text-xs mt-4">Used for the chat button, header and message bubbles; the text colour is chosen automatically for contrast, and dark mode keeps the same accent.</div>
        </div>
      </div>
      <TextArea label="Greeting" aria-label="Greeting" rows={2} value={form.greeting} maxLength={200} onChange={(v) => set({ greeting: v })} disabled={disabled} hint={`${form.greeting.length}/200, the first thing a guest sees`} />
      <FileInput
        label="Logo"
        accept="image/png,image/jpeg,image/webp"
        value={form.logoUrl}
        onChange={(url) => set({ logoUrl: url || null })}
        hint={fallbackLogo ? "PNG, JPG or WebP. Leave empty to use the restaurant's own logo." : "PNG, JPG or WebP, shown in the chat header and next to messages."}
      />
      {!form.logoUrl && fallbackLogo && (
        <div className="d-flex align-items-center gap-2 text-secondary-light text-sm mb-16">
          <Logo src={fallbackLogo} name={form.name} size={32} /> Using the restaurant's own logo
        </div>
      )}
    </>
  );
}

/** Read-only look of the assistant (portal). */
export function BrandingPreview({ config, fallbackLogo, forcedOff, platformOff }) {
  const c = config.color || DEFAULT_COLOR;
  const on = config.enabled && !forcedOff && !platformOff;
  return (
    <Card title="How your assistant looks" subtitle="Set by FORKSY. Contact support to change the look of your assistant." className="mb-20">
      <div className="d-flex flex-wrap gap-4 align-items-start">
        <div className="radius-12 overflow-hidden border" style={{ width: 280, maxWidth: "100%" }} data-testid="assistant-preview">
          <div className="d-flex align-items-center gap-2 px-12 py-10" style={{ background: c, color: "#fff" }}>
            <Logo src={config.logoUrl || fallbackLogo} name={config.name} size={34} />
            <div className="fw-semibold">{config.name}</div>
          </div>
          <div className="p-12 text-sm bg-neutral-100">
            <div className="p-8 radius-8 bg-white d-inline-block">{config.greeting}</div>
          </div>
        </div>
        <dl className="mb-0 text-sm" style={{ minWidth: 220 }}>
          <dt className="text-secondary-light">Name</dt>
          <dd data-testid="ro-name">{config.name}</dd>
          <dt className="text-secondary-light">Accent colour</dt>
          <dd>
            <span className="d-inline-block align-middle me-2 radius-4" style={{ width: 16, height: 16, background: c }} /> {config.color || "Default"}
          </dd>
          <dt className="text-secondary-light">Logo</dt>
          <dd>{config.logoUrl ? "Custom logo" : fallbackLogo ? "Your restaurant logo" : "None"}</dd>
          <dt className="text-secondary-light">Status</dt>
          <dd>
            <Badge tone={on ? "success" : "neutral"}>{on ? "Active" : "Off"}</Badge>
          </dd>
        </dl>
      </div>
    </Card>
  );
}

export function StatsStrip({ stats }) {
  const s = stats || {};
  return (
    <div className="row g-3 mb-20">
      <div className="col-6 col-xl-3">
        <StatCard label="Chats (7 days)" value={s.chats7d ?? 0} icon="solar:chat-round-dots-outline" hint={`${s.messages7d ?? 0} messages`} />
      </div>
      <div className="col-6 col-xl-3">
        <StatCard label="Carts started" value={s.carts7d ?? 0} icon="solar:cart-large-2-outline" tone="info" />
      </div>
      <div className="col-6 col-xl-3">
        <StatCard label="Sent to checkout" value={s.handoffs7d ?? 0} icon="solar:link-round-outline" tone="warning" />
      </div>
      <div className="col-6 col-xl-3">
        <StatCard label="Carts imported on FORKSY" value={s.imported7d ?? 0} icon="solar:bag-check-outline" tone="success" hint="guest logged in and loaded the cart" />
      </div>
    </div>
  );
}

export const BotStatusBadge = ({ status }) =>
  status === "forced_off" ? <Badge tone="danger">Off (by FORKSY)</Badge> : status === "disabled" ? <Badge tone="neutral">Off (by restaurant)</Badge> : <Badge tone="success">Active</Badge>;

export { Switch };
