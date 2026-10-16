# Website settings (General settings API)

Control of the website from the Admin Console: **logo and icons, title, footer, meta tags and descriptions, SEO, GEO, AEO, AIO, analytics ids, custom CSS and JavaScript.**
Everything is data in the database, changed through the API below; the customer website reads it through one public API (no rebuild, no deploy).

* Admin API: `/api/v1/admin/site/*` (sign in as staff, permission **site**: `view` to read, `edit` to change). **Custom CSS / JavaScript can only be changed by a Super Admin.**
* Public API: `/api/v1/public/site/*` (no sign-in, cached, CORS as the rest of the API).
* Interactive reference: Swagger `/docs` (on the live server `https://api.forky.ca/docs`, behind the docs password; type "website settings" in its filter box). The endpoints are under the tags **Admin / website settings** and **Public / website settings**, each with a description that links to this guide; the same document is `docs/openapi/openapi.json`.
* Code: `backend/src/site/` (`site.schema.ts` = the fields, `site.render.ts` = the generators, `site.service.ts`, `site.controller.ts`), tables `site_settings` and `site_setting_revisions`.
* Tests: `backend/test/site.test.ts` (unit, in CI) and `backend/test/site-e2e.mjs` (real HTTP).

## The Admin Console screens

Admin Console > sidebar **MARKETING & CONTENT > Website settings** (staff need the `site` permission; the Super Admin always has it). Ten pages:

| Page | What you do there |
|---|---|
| **Overview & health** | the health check (what is missing or wrong, errors first, each with an *Open* link to the page that fixes it), **Preview a page** (type `/order`, a store page or any path and see the title, description, meta tags, structured data and HTML the website will use, and whether it is indexed), and links to the files the website serves (robots.txt, sitemap.xml, llms.txt, manifest) |
| **General** | name, tagline, site address, languages, theme colours, copyright line, contact details, social profiles, app store links |
| **Logo & icons** | one tile for each picture (logo, dark logo, square logo, favicon, iPhone icon, two app icons, share pictures): *Upload* / *Replace* / *Remove*; the server checks the picture and tells you what is wrong ("must be square (this one is 64 x 32)") |
| **Title, SEO & meta** | default title and title template, description, robots rules, Open Graph and X cards, verification codes, extra meta and link tags, templates for store pages, rules for single pages, robots.txt, sitemap, structured data |
| **GEO**, **AEO (answers)**, **AIO (AI search)** | the facts for AI assistants and where you operate; questions and answers, HowTo guides, speakable; a table of AI crawlers with *Allow / Disallow / Say nothing* each, llms.txt, the licence statement |
| **Footer**, **Analytics** | link columns and bottom links; Google Analytics / Tag Manager / Ads, Meta pixel, Clarity, TikTok ids |
| **Custom CSS / JS** | the code fields with a warning and the *Enabled* kill switch; read only unless you are a Super Admin |

Every page has **Save** (only the changed fields are sent; a refused save lists every problem and marks the fields), **Discard changes**, **Reset to defaults** and **History** (every saved version with who and when, *View* and *Restore*). The forms are drawn from `GET /admin/site/schema`, so a field added in the backend shows up in the screens without a front-end change. Code: `admin/src/features/site/`.

## What the sections hold

| Section | Holds |
|---|---|
| `general` | site name, tagline, legal name, **site address** (`siteUrl`, empty = the server's `WEB_URL`), languages, time zone, theme / background colour, **copyright line**, contact (email, phone, address), **social profiles**, app store links |
| `branding` | **logo** (light / dark / square), **favicon**, iPhone icon, installable-app icons (192 / 512), **share pictures** (Open Graph, X), logo alt text, brand colours |
| `seo` | **default title and title template**, **meta description**, keywords, the robots meta tag, canonical rules, Open Graph, X (Twitter) card, search engine **verification codes**, **extra meta and link tags**, **title / description templates for store pages**, **rules for particular pages**, private (never indexed) pages, **robots.txt**, **sitemap**, structured-data switches + your own JSON-LD |
| `geo` | **GEO**. `generative`: facts about the company for AI assistants (preferred name, description, key facts, terminology, sources, last reviewed). `local`: geographic signals (business type, region, place name, map position, price range, **areas served**, opening hours) |
| `aeo` | **AEO**. FAQ (own entries + the customer FAQ of Content > FAQ), HowTo guides, speakable parts |
| `aio` | **AIO**. Per-crawler policy for GPTBot, ClaudeBot, PerplexityBot, Google-Extended... (written into robots.txt), **llms.txt** (what AI assistants read about the site), the licence statement, `noai` / `nosnippet` switches |
| `footer` | link columns, bottom links, legal text, which blocks show (social, app links, contact, language switcher) |
| `integrations` | Google Analytics / Tag Manager / Ads, Meta pixel, Clarity, TikTok pixel ids and whether the visitor must agree first |
| `scripts` | **custom CSS and JavaScript** (`customCss`, `headJs`, `bodyJs`), a kill switch (`enabled`) and notes |

The field list, limits, allowed values, defaults and help text of every section are served by **`GET /admin/site/schema`**: build the forms from it. **`GET /admin/site/options`** has the dropdown lists (social networks, AI crawlers, placeholders, picture slots with their size rules).
A reading of the abbreviations used here: SEO = search engines; GEO = generative engines (ChatGPT, Gemini, Perplexity...) plus the geographic / local signals; AEO = answer engines and voice assistants (FAQ, HowTo, speakable); AIO = AI search and AI overviews (crawler policy, llms.txt).

## Admin API

All calls need `Authorization: Bearer <staff token>`.

| Call | What it does |
|---|---|
| `GET /admin/site` | every section with `value`, `version`, `updatedAt`, `updatedByName`, `isDefault` (never saved = the defaults) |
| `GET /admin/site/schema` / `GET /admin/site/options` | the fields / the dropdown lists |
| `GET /admin/site/checks` | what is missing or wrong, errors first: `{summary:{errors,warnings,infos}, checks:[{id,area,level,message,section,field}]}` |
| `GET /admin/site/:section` | one section |
| `PATCH /admin/site/:section` | change some fields: send only the top-level fields that change (a field that holds an object or a list is replaced as a whole) |
| `PUT /admin/site/:section` | replace the section: the body is the whole section, fields left out go back to their defaults |
| `POST /admin/site/:section/reset` | back to the defaults |
| `POST /admin/site/branding/:slot` | upload a logo / icon (multipart, field `file`), see below |
| `DELETE /admin/site/branding/:slot` | remove a logo / icon from the settings |
| `GET /admin/site/:section/revisions` | the last saved versions (newest first, 50 are kept): `[{version, createdAt, createdByName, note}]` |
| `GET /admin/site/:section/revisions/:version` | one version with its values |
| `POST /admin/site/:section/revisions/:version/restore` | put it back (saved as a new version) |

`:section` is `general | branding | seo | geo | aeo | aio | footer | integrations | scripts`; `:slot` is `logo | logo-dark | logo-square | favicon | apple-touch-icon | pwa-icon-192 | pwa-icon-512 | og-image | twitter-image`.

**Saving.** The result is validated as a whole; **nothing is saved when any field is wrong** and the answer lists every problem:

```json
400 { "code": "SITE_SETTINGS_INVALID", "message": "The settings are not valid: general.siteName must be text; ...",
      "details": [ { "path": "general.siteName", "message": "must be text" }, { "path": "general.social[0].network", "message": "must be one of: facebook, instagram, ..." } ] }
```

A successful save answers `{section, value, version, updatedAt, updatedByName, isDefault, changed}`; `changed:false` means the values were the same (no new version). Every save is a **revision** and an **audit log** entry (`site.<section>.update`; for `scripts` the audit entry holds sizes and fingerprints, not the code).
Texts are plain text: markup in a text is stripped on the way in. Addresses must be `http(s)://...` or a path of the site (`/order/about`). A field left empty or `null` means "not set".

### Logo and icons

`POST /admin/site/branding/<slot>` with a `multipart/form-data` body, field `file`. The server checks what the picture really is (not the file name), reads its size, stores it and writes its address into the branding section in one call:

```
curl -H "Authorization: Bearer $TOKEN" -F file=@logo.png https://api.example.ca/api/v1/admin/site/branding/logo
-> 201 { "slot":"logo", "field":"logoUrl", "url":"https://api.example.ca/uploads/6f1c....png", "width":480, "height":160, "bytes":9120, "version":4, "branding":{...} }
```

| slot | field | rule |
|---|---|---|
| `logo`, `logo-dark` | `logoUrl`, `logoDarkUrl` | PNG / JPEG / WebP, 2 MB, at least 64 x 24 |
| `logo-square` | `logoSquareUrl` | square, at least 128 px |
| `favicon` | `faviconUrl` | square PNG / WebP, 512 KB, at least 32 px |
| `apple-touch-icon` | `appleTouchIconUrl` | square PNG, at least 180 px |
| `pwa-icon-192`, `pwa-icon-512` | `pwaIcon192Url`, `pwaIcon512Url` | square PNG / WebP, at least 192 / 512 px |
| `og-image` | `ogImageUrl` | wide (about 1.91 : 1, 1200 x 630 is best), at least 600 x 315, 5 MB |
| `twitter-image` | `twitterImageUrl` | wide (1.3 to 2.2 : 1), at least 300 x 157 |

A refused picture is `400 {code:"SITE_IMAGE_REJECTED", message:"Favicon: must be square (this one is 64 x 32)"}`. SVG is not accepted (an SVG can carry script). You can also upload with `POST /uploads` and send the address in a `PATCH` (`logoUrl` accepts our own uploads or an `https://` picture).

### Custom CSS and JavaScript (Super Admin)

`PATCH /admin/site/scripts` `{ "enabled": true, "customCss": "...", "headJs": "...", "bodyJs": "..." }` (up to 60 000 characters each; this route takes bodies up to 400 KB).
The text is stored **exactly as sent**. A save is refused (400, with the path) when: the CSS contains `<style>`, `<script>`, `expression(`, `javascript:` or an `@import` that is not `https://`, has unbalanced `{ }` or an unclosed comment; the JavaScript contains `<script>` or `<!--`, or **does not compile** (it is only compiled to find syntax errors, never run). Any other staff member gets `403 SITE_CODE_SUPER_ADMIN_ONLY`.
`enabled: false` is a **kill switch**: nothing is published, nothing is deleted. A bad change is undone with `POST /admin/site/scripts/revisions/<version>/restore`.

**Custom code runs on every page: only paste code you trust.** The website's Content-Security-Policy (`script-src 'self' https://js.stripe.com`) blocks inline and foreign scripts, so the front-end must either allow the code explicitly (see below) or not load it.

## Public API (what the website reads)

| Call | Answer |
|---|---|
| `GET /public/site` | the settings in website shape (below). `?sections=site,branding,seo` returns only those parts. Cached 60 s, `ETag`, `304` supported. |
| `GET /public/site/head?path=/order/r/some-store&lang=en-CA` | **everything for the `<head>` of one page** (below) |
| `GET /public/site/faq?lang=en` | the questions and answers (own entries + the customer FAQ of Content > FAQ) |
| `GET /public/site/robots.txt` | robots.txt (404 when `seo.robotsTxt.enabled` is off) |
| `GET /public/site/sitemap.xml` | the home page, the kinds of store that have stores, every live store (404 when off) |
| `GET /public/site/llms.txt` and `/llms-full.txt` | the Markdown summary for AI assistants (404 when off); the full one holds the whole FAQ, terms and store descriptions |
| `GET /public/site/manifest.webmanifest` | the web app manifest (name, colours, the 192 / 512 icons) |
| `GET /public/site/custom.css`, `/head.js`, `/body.js` | the custom code as files (404 when switched off or empty) |

### `GET /public/site`

```json
{ "version": "9fb3a1c20d4e",
  "site": { "name": "FORKY", "tagline": "...", "legalName": null, "url": "https://app.example.ca", "language": "en-CA", "languages": ["en-CA","fr-CA"], "timezone": "America/Toronto",
            "themeColor": "#ff6917", "backgroundColor": "#ffffff", "copyright": "© 2026 FORKY. All rights reserved." },
  "contact": { "email": null, "supportEmail": null, "phone": null, "address": { "line1": "", "city": "Mississauga", ... } },
  "social": [ { "network": "instagram", "url": "https://instagram.com/..." } ], "appLinks": { "iosUrl": null, "androidUrl": null },
  "branding": { "logo": "https://api.example.ca/uploads/....png", "logoDark": null, "logoSquare": null, "logoAlt": "FORKY", "favicon": "...", "appleTouchIcon": "...", "pwaIcon192": "...", "pwaIcon512": "...", "ogImage": "...", "twitterImage": "...", "colors": { "primary": null, "secondary": null, "accent": null } },
  "seo": { "title": "...", "titleTemplate": "%s | {siteName}", "description": "...", "keywords": [], "robots": "index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1", "openGraph": {...}, "twitter": {...}, "verification": {...}, "extraMetaTags": [], "extraLinkTags": [], "privatePaths": [...], "pages": [...] },
  "footer": { "columns": [ { "title": "Company", "links": [ { "label": "About", "url": "/order/about", "newTab": false } ] } ], "bottomLinks": [...], "legalText": "", "copyright": "© 2026 ...", "showSocial": true, "showAppLinks": true, "showContact": true, "showLanguageSwitcher": true },
  "geo": { "generative": {...} | null, "local": {...} | null },
  "aeo": { "faq": { "enabled": true, "pages": ["/order"], "items": [ { "question": "...", "answer": "..." } ] }, "howTo": [], "speakable": {...} },
  "aio": { "llmsTxt": { "enabled": true, "url": "...", "fullUrl": "..." }, "license": {...}, "crawlers": [ { "bot": "GPTBot", "policy": "disallow" } ], "snippets": {...} },
  "integrations": { "googleAnalyticsId": "G-XXXX", "googleTagManagerId": null, "metaPixelId": null, "consentRequired": true, ... },
  "scripts": { "enabled": true, "customCss": { "url": ".../custom.css?v=ab12cd34ef", "bytes": 1200, "sha256": "sha256-...", "sha384": "sha384-..." }, "headJs": null, "bodyJs": null },
  "files": { "robots": "...", "sitemap": "...", "llms": "...", "llmsFull": "...", "manifest": "...", "customCss": "...", "headJs": "...", "bodyJs": "...", "head": "...", "faq": "..." } }
```

`version` changes with every save: use it as a cache key. Pictures are full addresses.

### `GET /public/site/head`

`path` (required, a path of the customer website, with an optional query: `/order`, `/order/r/fresh-basket-supermarket`, `/order?t=GROCERY`) and `lang` (optional). It answers:

```json
{ "path": "/order/r/fresh-basket-supermarket", "lang": "en-CA", "htmlLang": "en-CA",
  "title": "Fresh Basket Supermarket - grocery store delivery in Mississauga | FORKY",
  "description": "Order from Fresh Basket Supermarket, a grocery store in Mississauga, ...",
  "canonical": "https://app.example.ca/order/r/fresh-basket-supermarket",
  "robots": "index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1", "themeColor": "#ff6917",
  "meta": [ { "name": "description", "content": "..." }, { "property": "og:title", "content": "..." }, { "name": "twitter:card", "content": "..." } ],
  "link": [ { "rel": "canonical", "href": "..." }, { "rel": "icon", "href": "...", "type": "image/png" }, { "rel": "manifest", "href": "..." } ],
  "jsonLd": [ { "@context": "https://schema.org", "@type": "GroceryStore", ... }, { "@type": "BreadcrumbList", ... } ],
  "html": "<title>...</title>\n<meta name=\"description\" content=\"...\">\n...",
  "source": "store" }
```

* Use the structured parts (`title`, `meta`, `link`, `jsonLd`) with a head manager such as react-helmet, or insert `html` as it is when the page is rendered on a server / pre-rendered. A script tag for each `jsonLd` object is `<script type="application/ld+json">` + the JSON (escape `<` as `<`; `html` already does).
* `source` says why the page looks like this: `home`, `store`, `store-type`, `page-rule`, `private` (never indexed), `not-found` (a store that does not exist or is not live: `noindex`), `default`.
* What decides it: the page rules of `seo.pages` (exact path first, then patterns ending in `*`), then the store / kind-of-store templates (`seo.templates`), then the defaults. Titles use `seo.titleTemplate`; a canonical address drops the query except the parameters in `seo.canonicalKeepParams` (default `t`, the kind of store).
* Structured data (switch each in `seo.structuredData`, `aeo`, `geo`): Organization + WebSite (with a search box) + a store list on the home page; a LocalBusiness of the right type (Restaurant, CafeOrCoffeeShop, Bakery, GroceryStore, ConvenienceStore...) with address, geo, opening hours, rating (only when there are ratings) and an order link on every store page; BreadcrumbList; FAQPage, HowTo and speakable on the pages you choose.
* Private pages (`seo.privatePaths`: sign-in, checkout, orders, tracking, wallet, account..., the Admin Console and the portal) are always `noindex, nofollow` with no structured data.
* The head is cached for a minute per page, so a changed store shows up within about a minute.

## Serving the files from the website's own address

Search engines expect `robots.txt`, `sitemap.xml` and `llms.txt` on the website's own address (`https://app.example.ca/robots.txt`). The API generates them; let the web server pass the three paths on. With Caddy (a file in `deploy/caddy.d/`, which is git-ignored and imported by the proxy):

```
@siteFiles path /robots.txt /sitemap.xml /llms.txt /llms-full.txt /manifest.webmanifest
handle @siteFiles {
    rewrite * /api/v1/public/site{path}
    reverse_proxy api:4000
}
```

(put it inside the `app.example.ca { ... }` block, before the `web` catch-all; the manifest address in `<link rel="manifest">` from `/public/site/head` already points at the API.)

## Wiring the front-end (suggested)

1. At start-up `GET /public/site` once (cache by `version`): logo, favicon, footer, copyright, theme colour, analytics ids.
2. On every route change `GET /public/site/head?path=<route>&lang=<language>` and apply `title`, `meta`, `link`, `jsonLd`. Keep a last-known-good copy for when the call fails.
3. Footer: build from `footer`, `social`, `contact`, `appLinks` (`showSocial`, `showAppLinks`, `showContact` say what to show).
4. Analytics: load the ids in `integrations` only after the visitor agreed when `consentRequired` is true.
5. Custom CSS: fetch `scripts.customCss.url` and put the text in a `<style>`, or link it (`style-src` allows inline styles).
6. Custom JavaScript: the Content-Security-Policy of the website blocks it unless you allow it. Two ways: (a) add the `sha256-...` value from `scripts.headJs.sha256` / `bodyJs.sha256` to `script-src` (`REACT_APP_CSP_SCRIPT` at build time) and inject the fetched text in an inline `<script>`; the hash changes with every edit, so this needs a rebuild per change; or (b) allow the API origin in `script-src` and load `scripts.headJs.url` / `bodyJs.url` with `<script src>` (then any change is live at once, and a script served by the API can run on the website). Choose deliberately.
7. The Admin Console form: `GET /admin/site/schema` for the fields, `GET /admin/site` for the values, `PATCH /admin/site/<section>` to save, `GET /admin/site/checks` for the health card, `POST /admin/site/branding/<slot>` for the pictures, `.../revisions` for the history.

## Defaults and limits

* A section that was never saved is served with its defaults (`isDefault:true`); the first save writes it. A new field added in a later version appears with its default in older saved sections.
* `seo.privatePaths` and `seo.robotsTxt.rules` start with the paths of this website's private pages; `aio.crawlers` lists the known AI crawlers with policy `default` (nothing written to robots.txt).
* The `site` permission is new: the demo **Marketing Manager** role has it on a fresh install; a database that already had that role needs the permission added in Roles & Permissions (the Super Admin always has it).
* Language: the settings hold one text per field (the site's default language). Per-language titles are not modelled; `lang` selects the language of FAQ entries and the `htmlLang` / `og:locale`.
* Not in this version: scheduled changes, drafts that are previewed before publishing (every save is live; use revisions to go back), per-store SEO overrides (stores use the templates; a store's own description feeds them), automatic image resizing, hreflang per language URL (the website switches language without a different address).
