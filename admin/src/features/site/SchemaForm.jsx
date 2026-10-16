import React from "react";
import { Icon } from "@iconify/react/offline";
import { Button, Field, FileInput, JsonInput, MultiCheck, NumberInput, Select, Switch, TagsInput, TextArea, TextInput } from "../../ui";
import { emptyOf, humanize } from "./shared";

/**
 * A form built from the field description of the API (GET /admin/site/schema): every field of every section of the website settings is drawn from it,
 * so a field added in the backend shows up here without a code change. Special cases: colours, pictures, code, lists of objects, JSON-LD blocks.
 * `errors` is the list of problems of a refused save, keyed by path ("seo.pages[1].path"); `section` is the section name in front of those paths.
 */
export function SchemaForm({ section, desc, value, onChange, errors = {}, options, readOnly = false }) {
  const ctx = { section, errors, options, readOnly };
  return (
    <fieldset disabled={readOnly} className="border-0 p-0 m-0">
      <div className="row">{renderFields(desc.fields, value ?? {}, (k, v) => onChange({ ...(value ?? {}), [k]: v }), "", ctx)}</div>
    </fieldset>
  );
}

export const colOf = (d) => {
  if (d.type === "object" || d.type === "array" || d.type === "json") return 12;
  if (d.type === "string") return d.format === "code" || d.multiline ? 12 : d.max <= 40 ? 4 : d.max <= 160 ? 6 : 12;
  if (d.type === "boolean") return 6;
  return 4;
};

export function renderFields(fields, value, set, path, ctx) {
  return Object.entries(fields).map(([k, d]) => {
    const p = path ? `${path}.${k}` : k;
    return (
      <div key={k} className={`col-12 col-md-${colOf(d)}`}>
        <FieldView name={k} desc={d} value={value?.[k]} onChange={(v) => set(k, v)} path={p} ctx={ctx} />
      </div>
    );
  });
}

const ErrorText = ({ text }) => (text ? <div className="text-danger-600 text-sm mt-4 mb-8">{text}</div> : null);
const errorAt = (ctx, path) => ctx.errors[`${ctx.section}.${path}`];

function FieldView({ name, desc: d, value, onChange, path, ctx }) {
  const label = humanize(name);
  const err = errorAt(ctx, path);
  switch (d.type) {
    case "string": return <StringField label={label} d={d} value={value} onChange={onChange} error={err} />;
    case "boolean": return (<><Switch label={label} hint={d.help} checked={!!value} onChange={onChange} className="mb-8" /><ErrorText text={err} /></>);
    case "int":
    case "number":
      return (
        <NumberInput
          label={label}
          hint={d.help ?? (d.nullable ? `${d.min} to ${d.max}, empty = not set` : `${d.min} to ${d.max}`)}
          value={value}
          min={d.min}
          max={d.max}
          step={d.type === "int" ? 1 : "any"}
          error={err}
          onChange={(v) => onChange(v === "" || v === null || v === undefined ? (d.nullable ? null : d.default) : Number(v))}
        />
      );
    case "enum":
      return <Select label={label} hint={d.help} value={value ?? ""} allowEmpty={!!d.nullable} options={d.values.map((v) => ({ value: v, label: ENUM_LABELS[v] ?? humanize(v) }))} error={err} onChange={(v) => onChange(v === "" ? null : v)} />;
    case "object":
      return (
        <div className="border radius-8 p-16 mb-16">
          <div className="fw-semibold mb-4">{label}</div>
          {d.help && <div className="text-secondary-light text-sm mb-12">{d.help}</div>}
          <div className="row">{renderFields(d.fields, value ?? {}, (k, v) => onChange({ ...(value ?? {}), [k]: v }), path, ctx)}</div>
          <ErrorText text={err} />
        </div>
      );
    case "array": return <ArrayField label={label} d={d} value={value ?? []} onChange={onChange} path={path} ctx={ctx} error={err} />;
    case "json":
      return (
        <>
          <JsonInput label={label} hint={d.help} value={value ?? {}} onChange={onChange} rows={6} />
          <ErrorText text={err} />
        </>
      );
    default: return null;
  }
}

const ENUM_LABELS = { x: "X (Twitter)", GPTBot: "GPTBot", default: "Say nothing (default)", allow: "Allow", disallow: "Disallow", summary_large_image: "Large picture", summary: "Small picture", "business.business": "Business", "restaurant.restaurant": "Restaurant", always: "Always", hourly: "Hourly", daily: "Daily", weekly: "Weekly", monthly: "Monthly", yearly: "Yearly", never: "Never", none: "None", standard: "Standard", large: "Large", "attribution-required": "Attribution required", "search-only": "Search only (no training)", "not-allowed": "Not allowed", allowed: "Allowed", FoodEstablishment: "Food establishment", LocalBusiness: "Local business", GroceryStore: "Grocery store" };

function StringField({ label, d, value, onChange, error }) {
  const required = (d.min ?? 0) > 0 && !d.nullable;
  const commit = (v) => onChange(v === "" && d.nullable ? null : v);
  const hint = d.help;
  if (d.format === "code") {
    const len = (value ?? "").length;
    return <TextArea label={label} hint={`${hint ?? ""} ${len.toLocaleString()} of ${d.max.toLocaleString()} characters`.trim()} value={value} rows={16} spellCheck={false} style={{ fontFamily: "monospace", fontSize: 13 }} error={error} onChange={commit} />;
  }
  if (d.format === "color") {
    const v = value ?? "";
    return (
      <Field label={label} hint={hint} error={error}>
        <div className="d-flex gap-2 align-items-center">
          <input type="color" aria-label={`${label} picker`} value={/^#[0-9a-f]{6}$/i.test(v) ? v : "#000000"} onChange={(e) => commit(e.target.value)} style={{ width: 44, height: 38, padding: 2 }} className="form-control form-control-color radius-8" />
          <input className={`form-control radius-8 ${error ? "is-invalid" : ""}`} value={v} placeholder="#ff6917" maxLength={7} onChange={(e) => commit(e.target.value)} />
        </div>
      </Field>
    );
  }
  if (d.format === "image") return (<><FileInput label={label} hint={hint ?? "JPG, PNG, WebP or GIF"} value={value} onChange={(u) => commit(u ?? null)} /><ErrorText text={error} /></>);
  if (d.multiline) return <TextArea label={label} hint={hint} value={value} rows={4} maxLength={d.max} required={required} error={error} onChange={commit} />;
  const type = { email: "email", phone: "tel", date: "date", time: "time" }[d.format] ?? "text";
  return <TextInput label={label} hint={hint} type={type} value={value} maxLength={d.max} required={required} error={error} onChange={commit} />;
}

function ArrayField({ label, d, value, onChange, path, ctx, error }) {
  const of = d.of;
  if (of.type === "string") {
    return (
      <>
        <TagsInput label={label} hint={d.help ?? `Press Enter to add (up to ${d.max})`} value={value} onChange={(v) => onChange(v.slice(0, d.max))} />
        <ErrorText text={error} />
        {value.map((_, i) => (errorAt(ctx, `${path}[${i}]`) ? <ErrorText key={i} text={`${value[i]}: ${errorAt(ctx, `${path}[${i}]`)}`} /> : null))}
      </>
    );
  }
  if (of.type === "enum") {
    return (
      <>
        <MultiCheck label={label} hint={d.help} cols={4} options={of.values.map((v) => ({ value: v, label: ENUM_LABELS[v] ?? v }))} value={value} onChange={onChange} />
        <ErrorText text={error} />
      </>
    );
  }
  if (path === "crawlers" && ctx.section === "aio") return <CrawlerList label={label} d={d} value={value} onChange={onChange} ctx={ctx} />;
  const items = value;
  const max = d.max;
  const move = (i, step) => {
    const j = i + step;
    if (j < 0 || j >= items.length) return;
    const next = [...items];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  return (
    <div className="mb-16">
      <div className="d-flex justify-content-between align-items-baseline mb-8">
        <label className="form-label fw-semibold text-primary-light text-sm mb-0">{label}</label>
        <span className="text-secondary-light text-xs">{items.length} of {max}</span>
      </div>
      {d.help && <div className="text-secondary-light text-sm mb-8">{d.help}</div>}
      <ErrorText text={error} />
      {items.map((it, i) => (
        <div key={i} className="border radius-8 p-16 mb-12" data-testid="list-item">
          <div className="d-flex justify-content-between align-items-center mb-12">
            <span className="fw-semibold text-sm">{of.type === "object" ? itemTitle(of, it, i) : `#${i + 1}`}</span>
            <div className="d-flex gap-1">
              {of.type !== "json" && <MiniButton icon="solar:arrow-up-outline" title="Move up" disabled={i === 0} onClick={() => move(i, -1)} />}
              {of.type !== "json" && <MiniButton icon="solar:arrow-down-outline" title="Move down" disabled={i === items.length - 1} onClick={() => move(i, 1)} />}
              <MiniButton icon="solar:trash-bin-trash-outline" title="Remove" danger onClick={() => onChange(items.filter((_, k) => k !== i))} />
            </div>
          </div>
          {of.type === "object" ? (
            <div className="row">{renderFields(of.fields, it ?? {}, (k, v) => onChange(items.map((x, n) => (n === i ? { ...x, [k]: v } : x))), `${path}[${i}]`, ctx)}</div>
          ) : (
            <>
              <JsonInput key={`${i}-${items.length}`} label="Structured data (JSON-LD)" hint={of.help} value={it ?? {}} onChange={(v) => onChange(items.map((x, n) => (n === i ? v : x)))} rows={8} />
              <ErrorText text={errorAt(ctx, `${path}[${i}]`)} />
            </>
          )}
        </div>
      ))}
      <Button variant="outline" icon="solar:add-circle-outline" disabled={items.length >= max} onClick={() => onChange([...items, of.type === "json" ? { "@context": "https://schema.org", "@type": "Thing", name: "" } : emptyOf(of)])}>
        Add {humanize(singular(label)).toLowerCase()}
      </Button>
    </div>
  );
}

const singular = (s) => String(s).replace(/ies$/i, "y").replace(/s$/i, "");

/** a short name for a list entry: its first filled text field */
function itemTitle(of, it, i) {
  for (const k of ["name", "title", "question", "label", "path", "bot", "network", "term", "key", "userAgent"]) if (of.fields[k] && it?.[k]) return `${it[k]}`.slice(0, 70);
  return `#${i + 1}`;
}

function MiniButton({ icon, title, onClick, disabled, danger }) {
  return (
    <button type="button" title={title} aria-label={title} onClick={onClick} disabled={disabled} className={`btn btn-sm border radius-4 p-0 d-inline-flex align-items-center justify-content-center ${danger ? "text-danger-600" : ""}`} style={{ width: 28, height: 28 }}>
      <Icon icon={icon} />
    </button>
  );
}

/** the AI crawlers: one row per known crawler with what it is, and a choice of what it may do */
function CrawlerList({ label, d, value, onChange, ctx }) {
  const known = ctx.options?.aiCrawlers ?? [];
  const byBot = new Map(value.map((c) => [String(c.bot).toLowerCase(), c]));
  const rows = [...known.map((k) => ({ bot: k.bot, owner: k.owner, purpose: k.purpose })), ...value.filter((c) => !known.some((k) => k.bot.toLowerCase() === String(c.bot).toLowerCase())).map((c) => ({ bot: c.bot, owner: "Other", purpose: "" }))];
  const setPolicy = (bot, policy) => {
    const rest = value.filter((c) => String(c.bot).toLowerCase() !== bot.toLowerCase());
    onChange(policy === "default" ? rest : [...rest, { bot, policy }].sort((a, b) => known.findIndex((k) => k.bot === a.bot) - known.findIndex((k) => k.bot === b.bot)));
  };
  return (
    <div className="mb-16">
      <label className="form-label fw-semibold text-primary-light text-sm mb-4">{label}</label>
      <div className="text-secondary-light text-sm mb-8">{d.help} Written into robots.txt. "Say nothing" leaves the crawler out of robots.txt.</div>
      <div className="table-responsive border radius-8">
        <table className="table mb-0 align-middle">
          <thead><tr><th>Crawler</th><th>Company</th><th>What it does</th><th style={{ width: 200 }}>Policy</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.bot} data-testid="crawler-row">
                <td className="fw-semibold font-monospace">{r.bot}</td>
                <td>{r.owner}</td>
                <td className="text-secondary-light text-sm">{r.purpose}</td>
                <td>
                  <select className="form-select radius-8" aria-label={`Policy for ${r.bot}`} value={byBot.get(r.bot.toLowerCase())?.policy ?? "default"} onChange={(e) => setPolicy(r.bot, e.target.value)}>
                    <option value="default">Say nothing (default)</option>
                    <option value="allow">Allow</option>
                    <option value="disallow">Disallow</option>
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
