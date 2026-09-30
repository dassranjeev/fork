import React from "react";
import { http } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useSubmit } from "../../lib/hooks";
import { fmtDate, titleCase } from "../../lib/format";
import { BoolBadge, Badge, DateInput, FileInput, FormRow, IconButton, NumberInput, Select, StatusBadge, Switch, TextArea, TextInput } from "../../ui";
import { CrudPage, numOrU, useCityOptions } from "../platform/crud";

const ACTIVE_FILTER = { name: "active", placeholder: "All statuses", options: [{ value: "true", label: "Active" }, { value: "false", label: "Inactive" }] };

// ------------------------------------------------------------------ Banners
const PLACEMENTS = ["HOME", "RESTAURANT_LIST", "CHECKOUT", "DRIVER_APP", "RESTAURANT_PORTAL"];

export function Banners() {
  const { options: cityOpts } = useCityOptions();
  return (
    <CrudPage
      title="Banners"
      subtitle="Promotional banners shown in the customer, driver and restaurant apps."
      path="/admin/banners"
      module="content"
      itemName="banner"
      modalSize="lg"
      sortBy="sortOrder"
      sortDir="ASC"
      searchPlaceholder="Search banners…"
      filterDefs={[{ name: "placement", placeholder: "All placements", options: PLACEMENTS }, { name: "cityId", placeholder: "All cities", options: cityOpts }, ACTIVE_FILTER]}
      initial={{ title: "", subtitle: "", imageUrl: "", linkKind: "none", linkValue: "", placement: "HOME", cityId: "", sortOrder: 1, startsAt: null, endsAt: null, active: true }}
      toForm={(b) => {
        const m = /^(restaurant|promo|url):(.*)$/.exec(b.link || "");
        return { title: b.title, subtitle: b.subtitle || "", imageUrl: b.imageUrl || "", linkKind: m ? m[1] : "none", linkValue: m ? m[2] : "", placement: b.placement, cityId: b.cityId || "", sortOrder: b.sortOrder ?? 1, startsAt: b.startsAt, endsAt: b.endsAt, active: !!b.active };
      }}
      toPayload={(v) => ({
        title: v.title,
        subtitle: v.subtitle || undefined,
        imageUrl: v.imageUrl,
        link: v.linkKind !== "none" && v.linkValue ? `${v.linkKind}:${v.linkValue}` : undefined,
        placement: v.placement,
        cityId: v.cityId || undefined,
        sortOrder: numOrU(v.sortOrder),
        startsAt: v.startsAt || undefined,
        endsAt: v.endsAt || undefined,
        active: !!v.active,
      })}
      columns={[
        {
          key: "imageUrl",
          title: "Banner",
          render: (b) => (
            <div className="d-flex align-items-center gap-3">
              <img src={b.imageUrl} alt="" width={80} height={44} className="radius-8 object-fit-cover bg-neutral-200" onError={(e) => (e.currentTarget.style.visibility = "hidden")} />
              <div>
                <div className="fw-semibold">{b.title}</div>
                <div className="text-secondary-light text-xs">{b.subtitle}</div>
              </div>
            </div>
          ),
        },
        { key: "placement", title: "Placement", render: (b) => <Badge tone="info">{titleCase(b.placement)}</Badge> },
        { key: "link", title: "Link", render: (b) => <span className="text-secondary-light text-sm">{b.link || "—"}</span> },
        { key: "sortOrder", title: "Order", sortable: true },
        { key: "dates", title: "Runs", render: (b) => (b.startsAt || b.endsAt ? `${fmtDate(b.startsAt)} → ${fmtDate(b.endsAt)}` : "Always") },
        { key: "active", title: "Status", render: (b) => <BoolBadge value={b.active} yes="Active" no="Inactive" /> },
      ]}
      renderForm={({ f }) => (
        <>
          <TextInput label="Title" required {...f.bind("title")} />
          <TextInput label="Subtitle" {...f.bind("subtitle")} />
          <FileInput label="Image" value={f.values.imageUrl} onChange={(u) => f.set("imageUrl", u || "")} />
          <TextInput label="Or image URL" required placeholder="https://…" {...f.bind("imageUrl")} />
          <FormRow>
            <Select col={4} label="Link to" allowEmpty={false} options={[{ value: "none", label: "No link" }, { value: "restaurant", label: "Restaurant" }, { value: "promo", label: "Promo code" }, { value: "url", label: "Web URL" }]} {...f.bind("linkKind")} />
            {f.values.linkKind !== "none" && (
              <TextInput col={8} label={f.values.linkKind === "restaurant" ? "Restaurant ID" : f.values.linkKind === "promo" ? "Promo code" : "URL"} {...f.bind("linkValue")} />
            )}
            <Select col={4} label="Placement" allowEmpty={false} options={PLACEMENTS} {...f.bind("placement")} />
            <Select col={4} label="City" options={cityOpts} placeholder="All cities" {...f.bind("cityId")} />
            <NumberInput col={4} label="Sort order" step="1" {...f.bind("sortOrder")} />
            <DateInput col={6} label="Starts" withTime value={f.values.startsAt} onChange={(v) => f.set("startsAt", v)} />
            <DateInput col={6} label="Ends" withTime value={f.values.endsAt} onChange={(v) => f.set("endsAt", v)} />
          </FormRow>
          <Switch label="Active" {...f.bindCheck("active")} />
        </>
      )}
    />
  );
}

// ------------------------------------------------------------------ CMS pages
const LANGS = [{ value: "en", label: "English" }, { value: "fr", label: "Français" }];

export function CmsPages() {
  const { can } = useAuth();
  const { run } = useSubmit();
  return (
    <CrudPage
      title="CMS Pages"
      subtitle="Legal, help and marketing pages (terms, privacy, agreements) in each language."
      path="/admin/cms-pages"
      module="content"
      itemName="page"
      modalSize="lg"
      searchPlaceholder="Search title or slug…"
      filterDefs={[
        { name: "category", placeholder: "All categories", options: ["LEGAL", "HELP", "MARKETING"] },
        { name: "language", placeholder: "All languages", options: LANGS },
        { name: "published", placeholder: "Any state", options: [{ value: "true", label: "Published" }, { value: "false", label: "Draft" }] },
      ]}
      initial={{ slug: "", language: "en", title: "", body: "", category: "LEGAL", published: false }}
      loadRow={(r) => http.get(`/admin/cms-pages/${r.id}`)}
      toForm={(p) => ({ slug: p.slug, language: p.language, title: p.title, body: p.body || "", category: p.category, published: !!p.published })}
      toPayload={(v, editing) => ({
        title: v.title,
        body: v.body,
        category: v.category,
        published: !!v.published,
        ...(editing ? {} : { slug: v.slug, language: v.language }),
      })}
      columns={[
        { key: "title", title: "Page", render: (p) => <div><div className="fw-semibold">{p.title}</div><div className="text-secondary-light text-xs font-monospace">/{p.slug}</div></div> },
        { key: "language", title: "Language", render: (p) => <Badge tone="neutral">{p.language.toUpperCase()}</Badge> },
        { key: "category", title: "Category", render: (p) => titleCase(p.category) },
        { key: "updatedAt", title: "Updated", render: (p) => fmtDate(p.updatedAt) },
        { key: "published", title: "Status", render: (p) => <StatusBadge status={p.published ? "LIVE" : "DRAFT"} /> },
      ]}
      rowActions={(p, reload) =>
        can("content", "edit") && (
          <IconButton
            icon={p.published ? "solar:eye-closed-outline" : "solar:eye-outline"}
            title={p.published ? "Unpublish" : "Publish"}
            tone={p.published ? "warning" : "success"}
            onClick={() => run(() => http.post(`/admin/cms-pages/${p.id}/${p.published ? "unpublish" : "publish"}`), { success: p.published ? "Unpublished" : "Published", onDone: reload })}
          />
        )
      }
      renderForm={({ f, editing }) => (
        <>
          <FormRow>
            <TextInput col={6} label="Slug" required disabled={editing} hint="kebab-case, e.g. refund-policy" {...f.bind("slug")} />
            <Select col={3} label="Language" allowEmpty={false} disabled={editing} options={LANGS} {...f.bind("language")} />
            <Select col={3} label="Category" allowEmpty={false} options={["LEGAL", "HELP", "MARKETING"]} {...f.bind("category")} />
          </FormRow>
          <TextInput label="Title" required {...f.bind("title")} />
          <TextArea label="Body" required rows={14} hint="HTML or Markdown" {...f.bind("body")} />
          <Switch label="Published" {...f.bindCheck("published")} />
        </>
      )}
    />
  );
}

// ------------------------------------------------------------------ FAQs
export function Faqs() {
  return (
    <CrudPage
      title="FAQs"
      subtitle="Help-centre questions for customers, drivers and restaurants."
      path="/admin/faqs"
      module="content"
      itemName="FAQ"
      modalSize="lg"
      searchPlaceholder="Search questions…"
      filterDefs={[
        { name: "audience", placeholder: "All audiences", options: ["CUSTOMER", "DRIVER", "RESTAURANT"] },
        { name: "language", placeholder: "All languages", options: LANGS },
        ACTIVE_FILTER,
      ]}
      initial={{ question: "", answer: "", audience: "CUSTOMER", category: "General", language: "en", sortOrder: 1, active: true }}
      toPayload={(v) => ({ question: v.question, answer: v.answer, audience: v.audience, category: v.category || undefined, language: v.language, sortOrder: numOrU(v.sortOrder), active: !!v.active })}
      columns={[
        { key: "question", title: "Question", render: (q) => <div style={{ maxWidth: 480 }}><div className="fw-semibold">{q.question}</div><div className="text-secondary-light text-xs text-truncate">{q.answer}</div></div> },
        { key: "audience", title: "Audience", render: (q) => <Badge tone="info">{titleCase(q.audience)}</Badge> },
        { key: "category", title: "Category" },
        { key: "language", title: "Lang", render: (q) => q.language.toUpperCase() },
        { key: "sortOrder", title: "Order" },
        { key: "active", title: "Status", render: (q) => <BoolBadge value={q.active} yes="Active" no="Hidden" /> },
      ]}
      renderForm={({ f }) => (
        <>
          <TextInput label="Question" required {...f.bind("question")} />
          <TextArea label="Answer" required rows={5} {...f.bind("answer")} />
          <FormRow>
            <Select col={4} label="Audience" allowEmpty={false} options={["CUSTOMER", "DRIVER", "RESTAURANT"]} {...f.bind("audience")} />
            <TextInput col={4} label="Category" {...f.bind("category")} />
            <Select col={2} label="Language" allowEmpty={false} options={LANGS} {...f.bind("language")} />
            <NumberInput col={2} label="Order" step="1" {...f.bind("sortOrder")} />
          </FormRow>
          <Switch label="Active" {...f.bindCheck("active")} />
        </>
      )}
    />
  );
}
