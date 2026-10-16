import { useCallback, useEffect, useMemo, useState } from "react";
import { errorMessage, http } from "../../lib/api";

/** The sections of the website settings (backend/src/site/site.schema.ts), in the order of the sidebar. docs/site-settings.md */
export const SECTIONS = [
  { key: "general", label: "General", icon: "solar:settings-outline", title: "General", subtitle: "Name, address, languages, contact details, social profiles and the copyright line of the website" },
  { key: "branding", label: "Logo & icons", icon: "solar:gallery-outline", title: "Logo and icons", subtitle: "The logo, the favicon, the home screen and app icons and the picture shown when a link is shared" },
  { key: "seo", label: "Title, SEO & meta", icon: "solar:magnifer-outline", title: "Title, SEO and meta tags", subtitle: "Titles, descriptions, meta tags, share cards, robots.txt, the sitemap, structured data and rules for single pages" },
  { key: "geo", label: "GEO", icon: "solar:map-point-outline", title: "GEO: generative engines and local signals", subtitle: "Facts about the company for AI assistants, and where it operates (areas served, map position, hours)" },
  { key: "aeo", label: "AEO (answers)", icon: "solar:chat-round-dots-outline", title: "AEO: answer engines and voice assistants", subtitle: "Questions and answers, step-by-step guides and the parts of a page a voice assistant may read aloud" },
  { key: "aio", label: "AIO (AI search)", icon: "solar:cpu-outline", title: "AIO: AI search and AI overviews", subtitle: "What each AI crawler may do, the llms.txt summary, the licence statement and snippet limits" },
  { key: "footer", label: "Footer", icon: "solar:window-frame-outline", title: "Footer", subtitle: "Link columns, bottom links, legal text and which blocks the footer shows" },
  { key: "integrations", label: "Analytics", icon: "solar:chart-2-outline", title: "Analytics and ad pixels", subtitle: "Google Analytics, Tag Manager, Google Ads, Meta pixel, Clarity and TikTok ids" },
  { key: "scripts", label: "Custom CSS / JS", icon: "solar:code-outline", title: "Custom CSS and JavaScript", subtitle: "Code added to every page of the website (Super Admin only)" },
];
export const SECTION_BY_KEY = Object.fromEntries(SECTIONS.map((s) => [s.key, s]));
export const GUIDE_URL = "https://github.com/iwebkokri/fork/blob/main/docs/site-settings.md";

const WORDS = { url: "address", og: "Open Graph", seo: "SEO", faq: "FAQ", cms: "CMS", ios: "iOS", pwa: "app", llms: "llms.txt", css: "CSS", js: "JavaScript", id: "ID", ids: "IDs", ai: "AI", aio: "AIO", geo: "GEO", aeo: "AEO", html: "HTML", json: "JSON", ld: "LD", txt: "txt", x: "X", howto: "HowTo", noai: "noai", icbm: "ICBM", tiktok: "TikTok", lat: "latitude", lng: "longitude", km: "km", maxsnippet: "max snippet", hreflang: "language (hreflang)", newtab: "open in a new tab" };
/** a field name as a label: "siteName" -> "Site name", "logoUrl" -> "Logo address", "ogImageUrl" -> "Open Graph image address" */
export function humanize(key) {
  const parts = String(key).replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").split(/[\s_-]+/);
  const words = parts.map((w) => WORDS[w.toLowerCase()] ?? w.toLowerCase());
  const s = words.join(" ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** a new, empty entry of a list, built from the field description of the API */
export function emptyOf(d) {
  switch (d.type) {
    case "object": return Object.fromEntries(Object.entries(d.fields).map(([k, v]) => [k, emptyOf(v)]));
    case "array": return [];
    case "json": return null;
    case "boolean": return d.default;
    case "string": return d.nullable ? null : d.default ?? "";
    default: return d.default ?? null;
  }
}

/** The "details" of a refused save (400 SITE_SETTINGS_INVALID): { "seo.pages[1].path": "is listed twice" } */
export function problemsOf(err) {
  const list = err?.response?.data?.details;
  const out = {};
  if (Array.isArray(list)) for (const p of list) if (p && typeof p === "object" && p.path) out[p.path] = p.message;
  return out;
}
export const messageOf = errorMessage;

/** the field description, the options and one section; reload() reads the section again */
export function useSiteSection(section) {
  const [state, setState] = useState({ loading: true, error: null, schema: null, options: null, saved: null });
  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const [schema, options, saved] = await Promise.all([http.get("/admin/site/schema"), http.get("/admin/site/options"), http.get(`/admin/site/${section}`)]);
      setState({ loading: false, error: null, schema, options, saved });
    } catch (e) {
      setState((s) => ({ ...s, loading: false, error: errorMessage(e) }));
    }
  }, [section]);
  useEffect(() => {
    load();
  }, [load]);
  return useMemo(() => ({ ...state, reload: load, setSaved: (saved) => setState((s) => ({ ...s, saved })) }), [state, load]);
}

export const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const fmtWhen = (v) => (v ? new Date(v).toLocaleString() : "");
