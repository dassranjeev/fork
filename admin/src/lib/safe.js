/**
 * Shared client-side output-safety helpers. Use these everywhere data from the API (which is user-controlled:
 * customer names, reviews, chat messages, CMS bodies, ...) reaches a place React does NOT auto-escape:
 * URLs (href/src), raw HTML, third-party libraries that build HTML strings (ApexCharts, Leaflet, window.open).
 *
 * Plain text in JSX ({value}) is already escaped by React: never replace that with dangerouslySetInnerHTML.
 */
import DOMPurify from "dompurify";

const HTML_ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;", "/": "&#47;" };

/** Escape a value for use inside an HTML string (for libraries that insert strings as HTML). */
export function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[&<>"'`/]/g, (c) => HTML_ESC[c]);
}

const SAFE_LINK = /^(https?:|mailto:|tel:)/i;

// strip control chars / whitespace browsers ignore inside a scheme ("java\tscript:") before testing
const normalise = (u) => String(u).replace(/[\u0000-\u0020\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g, "");

/**
 * Return `url` only if it is a relative internal path or http/https/mailto/tel; otherwise `fallback`.
 * Blocks javascript:, data:, vbscript:, file:, blob: and protocol-relative ("//evil") URLs.
 */
export function safeUrl(url, fallback = "#") {
  if (url === null || url === undefined || url === "") return fallback;
  const raw = String(url).trim();
  const n = normalise(raw);
  if (!n) return fallback;
  if (/^\/(?![/\\])/.test(n)) return raw; // "/path" (not "//host" or "/\host")
  if (/^(\.\.?\/|[?#])/.test(n)) return raw; // "./x", "../x", "?q", "#h"
  if (SAFE_LINK.test(n)) {
    try {
      new URL(raw); // must parse
      return raw;
    } catch {
      return fallback;
    }
  }
  // scheme-less relative like "uploads/a.png" (no colon before first slash)
  if (!/^[a-z][a-z0-9+.-]*:/i.test(n) && !n.startsWith("//") && !n.startsWith("\\")) return raw;
  return fallback;
}

/** Like safeUrl but for <img src>: additionally allows raster data:image URLs (QR codes) and blob: from our own code. */
export function safeImgUrl(url, fallback = undefined) {
  if (typeof url === "string" && /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=]+$/i.test(url.trim())) return url.trim();
  const out = safeUrl(url, "");
  return out || fallback;
}

/** Props for an external link: safe href + noopener noreferrer. Spread onto <a>. */
export function externalLink(url) {
  return { href: safeUrl(url), target: "_blank", rel: "noopener noreferrer nofollow" };
}

const ALLOWED_TAGS = [
  "p", "br", "hr", "div", "span", "b", "strong", "i", "em", "u", "s", "strike", "sub", "sup", "blockquote", "pre", "code",
  "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "a", "img", "table", "thead", "tbody", "tfoot", "tr", "th", "td",
];
const ALLOWED_ATTR = ["href", "src", "alt", "title", "width", "height", "colspan", "rowspan", "target", "rel", "class"];
const ALLOWED_URI = /^(?:(?:https?|mailto|tel):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i; // DOMPurify default shape: no javascript:/data:/vbscript:

let hooked = false;
function ensureHooks() {
  if (hooked) return;
  hooked = true;
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") {
      if (node.getAttribute("target")) {
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer nofollow");
      }
      const h = node.getAttribute("href");
      if (h !== null && safeUrl(h, "") === "") node.removeAttribute("href");
    }
    if (node.tagName === "IMG") {
      const s = node.getAttribute("src");
      if (s !== null && !safeImgUrl(s)) node.removeAttribute("src");
    }
  });
}

/**
 * Sanitise untrusted HTML (CMS pages, FAQ answers, campaign bodies, rich-text) with a strict allowlist:
 * no script/style/iframe/form/svg/math, no event handlers, no style attributes, no javascript:/data: URLs.
 */
export function sanitizeHtml(html) {
  if (html === null || html === undefined || html === "") return "";
  ensureHooks();
  return DOMPurify.sanitize(String(html), {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOWED_URI_REGEXP: ALLOWED_URI,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    FORBID_TAGS: ["style", "script", "iframe", "object", "embed", "form", "svg", "math", "link", "meta", "base"],
    FORBID_ATTR: ["style", "srcset", "onerror", "onload", "onclick"],
    USE_PROFILES: { html: true },
  });
}

/** Sanitised HTML in the shape React expects: <div dangerouslySetInnerHTML={safeHtml(body)} />. Only sanctioned use. */
export const safeHtml = (html) => ({ __html: sanitizeHtml(html) });

/** Strip everything to plain text. */
export function stripHtml(html) {
  if (!html) return "";
  return DOMPurify.sanitize(String(html), { ALLOWED_TAGS: [], ALLOWED_ATTR: [] });
}

/**
 * Full-document sanitiser for HTML we open in a new tab (e.g. invoices generated server side).
 * Scripts, event handlers, forms, frames and style are removed.
 */
export function sanitizeDocument(html) {
  ensureHooks();
  return DOMPurify.sanitize(String(html || ""), {
    WHOLE_DOCUMENT: true,
    ALLOWED_TAGS: [...ALLOWED_TAGS, "html", "head", "body", "title"],
    ALLOWED_ATTR,
    ALLOWED_URI_REGEXP: ALLOWED_URI,
    FORBID_TAGS: ["style", "script", "iframe", "object", "embed", "form", "svg", "math", "link", "meta", "base"],
    FORBID_ATTR: ["style"],
  });
}

/** Only allow a same-app relative path for post-login redirects (blocks //host, /\host, scheme:, backslashes). */
export function safeInternalPath(p, fallback = "/") {
  if (typeof p !== "string") return fallback;
  const n = normalise(p);
  if (!/^\/(?![/\\])/.test(n) || n.includes("\\") || /[\u0000-\u001f]/.test(p)) return fallback;
  return p;
}

/** Allow only simple CSS colours (#hex, rgb()/hsl() numbers, plain names) so a value is safe inside a style="" string. */
export function safeColor(c, fallback = "#64748b") {
  const v = String(c ?? "").trim();
  if (/^#[0-9a-f]{3,8}$/i.test(v)) return v;
  if (/^(rgb|hsl)a?\(\s*[\d.%\s,/-]+\)$/i.test(v)) return v;
  if (/^[a-z]{3,20}$/i.test(v)) return v;
  return fallback;
}

/**
 * ApexCharts builds its tooltips/legends with innerHTML from series names, categories and x values (verified: a
 * category of "<script>..." lands in .apexcharts-tooltip-title). Axis labels are SVG text, so entity-escaping would show
 * "&amp;" for honest data; instead neutralise the only character that can open a tag. Deep-maps strings, keeps numbers.
 */
export function chartSafe(v) {
  if (typeof v === "string") return v.replace(/</g, "‹");
  if (Array.isArray(v)) return v.map(chartSafe);
  if (v && typeof v === "object" && !(v instanceof Date)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, chartSafe(x)]));
  return v;
}
