#!/usr/bin/env node
/**
 * XSS / client-side-injection regression smoke test for the Admin Console and Restaurant Portal.
 *
 * What it does
 *  1. Logs in ONCE per account through the API (the login endpoint is throttled) and injects the tokens into the browser.
 *  2. Intercepts every API JSON response (page.route) and rewrites free-text fields (names, comments, messages, titles,
 *     descriptions, notes, addresses ...) to XSS payloads, URL fields to javascript: URLs and colour fields to CSS/HTML
 *     break-outs. This tests the UI regardless of whether the backend sanitises.
 *     (the Assistant pages incl. the bot Training pages are covered by the sidebar sweep: greeting / botName / FAQ q+a / training title, questions, answer, alias, term, document text ... fields are rewritten too)
 *  3. Visits every sidebar link (+ a few detail pages reached from them), hovers charts (tooltips) and asserts:
 *       - window.__xss is still undefined (no payload executed)
 *       - no alert/confirm/prompt dialog fired
 *       - no element with an inline event handler attribute, no <a href="javascript:..."> reached the DOM
 *       - no page errors
 *  4. Runs everything twice: once with the real Content-Security-Policy and once with the CSP meta stripped
 *     ("CSP off") so sanitising/escaping is proven on its own, not just thanks to the CSP.
 *  5. Loads public/chat-demo.html with stubbed API responses full of payloads.
 *  6. Customer website (/order): home, restaurant pages, checkout, orders, tracking, login, hand-off screens and the assistant
 *     chat, with every API field rewritten to payloads (the assistant API is stubbed with payload-laden replies). Logs in as a
 *     demo customer (CUSTOMER_EMAIL / CUSTOMER_PASSWORD) and injects the storefront session ("sf.*" keys in sessionStorage).
 *
 * Run:   node admin/test/xss-smoke.mjs
 * Env:   BASE_URL (http://localhost:3000)  API_URL (http://localhost:4000/api/v1)
 *        ADMIN_EMAIL / ADMIN_PASSWORD  OWNER_EMAIL / OWNER_PASSWORD  CUSTOMER_EMAIL / CUSTOMER_PASSWORD (storefront)  NO_STOREFRONT=1 to skip it
 *        PLAYWRIGHT_DIR  folder whose node_modules contains `playwright` (default: resolve normally, then CWD)
 *        HEADED=1 to watch it, MAX_DETAIL=2 detail pages per list page, CSP_ONLY=1 / NOCSP_ONLY=1
 *        STOREFRONT_ONLY=1 / CHAT_ONLY=1 to run just that part, SF_URLS=/order/wallet,/order/account to limit the storefront pages
 * Robustness: every sweep gets its own freshly launched browser (a long-lived headless Chromium on a memory-starved machine
 * gets its renderers killed: "Page crashed"); if a renderer still dies, the page is re-opened and that URL retried once (WARN).
 * Exit code 0 = all clean, 1 = a payload executed / error found.
 */
import { createRequire } from "node:module";
import path from "node:path";

const env = (k, d) => process.env[k] ?? d;
const BASE = env("BASE_URL", "http://localhost:3000").replace(/\/$/, "");
const API = env("API_URL", "http://localhost:4000/api/v1").replace(/\/$/, "");
const ACCOUNTS = [
  { name: "admin", email: env("ADMIN_EMAIL", "admin@forksy.ca"), password: env("ADMIN_PASSWORD", "Admin@12345"), start: "/", extra: ["/inbox", "/notification-settings"] },
  { name: "owner", email: env("OWNER_EMAIL", "owner1@demo-restaurant.ca"), password: env("OWNER_PASSWORD", "Demo@12345"), start: "/portal", extra: ["/portal/notifications", "/portal/notification-settings"] },
];
const MAX_DETAIL = Number(env("MAX_DETAIL", "2"));

function loadPlaywright() {
  const tries = [env("PLAYWRIGHT_DIR", ""), process.cwd(), path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1"))].filter(Boolean);
  for (const dir of tries) {
    try {
      return createRequire(path.join(dir, "noop.js"))("playwright");
    } catch {
      /* next */
    }
  }
  throw new Error("playwright not found. Set PLAYWRIGHT_DIR to a folder whose node_modules has it (npm i playwright).");
}
const { chromium } = loadPlaywright();

// ------------------------------------------------------------------------------------------------ payloads
const X = "window.__xss=1";
const TEXT_PAYLOADS = [
  `<img src=x onerror="${X}">`,
  `<script>${X}</script>`,
  `"><svg/onload=${X}>`,
  `'><iframe srcdoc="<script>parent.${X}</script>">`,
  `{{constructor.constructor('${X}')()}}`,
  `<a href="javascript:${X}">click</a>`,
  `</script><script>${X}</script>`,
  `<details open ontoggle=${X}>`,
];
const URL_PAYLOADS = [`javascript:${X}`, ` jav\tascript:${X}`, `data:text/html,<script>${X}</script>`, `//evil.example/x.png`, `vbscript:${X}`];
const COLOR_PAYLOAD = `#f00;" onmouseover="${X}" x="`;

const TEXT_KEYS = /^(greeting|botName|q|a|name|firstName|lastName|fullName|title|body|message|comment|comments|description|notes?|address\d?|street|text|label|subject|reason|content|answer|question|summary|displayName|restaurantName|customerName|driverName|raterName|reportReason|brand|slug|code|businessName|city|unit|instructions|response|reply|feedback|excerpt|caption|before|after|details?|topic|tag|tags|questions|alias|alternates|term|phrase|matchedPhrasing|requestedByName|publishedByName|updatedByName|decidedByName|decisionNote|createdBy)$/i;
const URL_KEYS = /(url|href|link|image|logo|avatar|icon|photo|banner|attachments?)$/i;
const COLOR_KEYS = /^(color|colour)$/i;
const SKIP_KEYS = /(token|password|secret|expires|id$|Id$|status|type|currency|^email$|phone)/i;

let counter = 0;
function mutate(v, key = "", depth = 0) {
  if (depth > 12) return v;
  if (Array.isArray(v)) return v.map((x) => mutate(x, key, depth + 1));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mutate(x, k, depth + 1)]));
  if (typeof v === "string" && v) {
    if (COLOR_KEYS.test(key)) return COLOR_PAYLOAD;
    if (URL_KEYS.test(key) && !SKIP_KEYS.test(key)) return URL_PAYLOADS[counter++ % URL_PAYLOADS.length];
    if (TEXT_KEYS.test(key) && !SKIP_KEYS.test(key)) return `${v.slice(0, 20)}${TEXT_PAYLOADS[counter++ % TEXT_PAYLOADS.length]}`;
  }
  return v;
}

// ------------------------------------------------------------------------------------------------ helpers
async function login(acc) {
  const r = await fetch(`${API}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identifier: acc.email, password: acc.password }) });
  const j = await r.json();
  if (!r.ok || !j.accessToken) throw new Error(`login failed for ${acc.name}: ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  return j;
}

const results = [];
const fail = (msg) => {
  results.push({ ok: false, msg });
  console.log("  FAIL", msg);
};
const pass = (msg) => results.push({ ok: true, msg });

async function newContext(browser, session, { csp, store = "admin" }) {
  const ctx = await browser.newContext();
  if (store === "storefront") {
    await ctx.addInitScript(([a, r]) => {
      try {
        sessionStorage.setItem("sf.access", a);
        sessionStorage.setItem("sf.refresh", r);
      } catch {}
    }, [session.accessToken, session.refreshToken]);
  } else {
    await ctx.addInitScript(([a, r]) => {
      try {
        localStorage.setItem("forksy.access", a);
        localStorage.setItem("forksy.refresh", r);
      } catch {}
    }, [session.accessToken, session.refreshToken]);
  }
  if (!csp) {
    // strip the CSP meta so only escaping/sanitising protects us
    await ctx.route(`${BASE}/**`, async (route) => {
      const req = route.request();
      if (req.resourceType() !== "document") return route.fallback();
      const resp = await route.fetch();
      const html = (await resp.text()).replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/i, "");
      return route.fulfill({ response: resp, body: html });
    });
  }
  await ctx.route(`${API}/**`, async (route) => {
    const req = route.request();
    if (req.method() !== "GET") return route.fallback();
    try {
      const resp = await route.fetch();
      const ct = resp.headers()["content-type"] || "";
      if (!ct.includes("json") || /\/auth\//.test(req.url())) return route.fulfill({ response: resp });
      const json = await resp.json();
      return route.fulfill({ response: resp, json: mutate(json) });
    } catch {
      return route.fallback();
    }
  });
  return ctx;
}

/** Opens a page and wires the listeners the checks read. Returns a stand-in that always points at the CURRENT page, so a crashed renderer can be replaced without the callers noticing. */
async function openPage(ctx, state, wire = () => {}) {
  const open = async () => {
    const p = await ctx.newPage();
    state.crashed = false;
    p.on("crash", () => {
      state.crashed = true;
      state.crashes = (state.crashes || 0) + 1;
      console.log("  WARN renderer crashed (" + state.mode + "/" + state.acct + ")");
    });
    p.on("dialog", async (d) => {
      state.dialogs.push(d.type() + ":" + d.message().slice(0, 40));
      await d.dismiss().catch(() => {});
    });
    p.on("pageerror", (e) => state.pageErrors.push(String(e.message || e)));
    p.on("console", (m) => {
      const t = m.text();
      if (/Content Security Policy|Refused to/i.test(t)) state.csp.push(t.slice(0, 220));
    });
    wire(p);
    state.page = p;
  };
  state.reopen = async () => {
    await state.page?.close({ runBeforeUnload: false }).catch(() => {});
    await open();
  };
  await open();
  return new Proxy({}, { get: (_, k) => { const p = state.page; const v = p[k]; return typeof v === "function" ? v.bind(p) : v; } });
}

async function checkPage(page, url, label, state, opts = {}) {
  if (state.crashed) await state.reopen();
  state.xss = false;
  const errsBefore = state.pageErrors.length;
  const dlgBefore = state.dialogs.length;
  try {
    if (!opts.stay) {
      await page.goto(BASE + url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(async () => {
        await page.waitForTimeout(1500);
        await page.goto(BASE + url, { waitUntil: "domcontentloaded", timeout: 30000 });
      });
      await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(700);
    }
    // hover charts to open ApexCharts tooltips (they build HTML strings)
    for (const c of await page.$$(".apexcharts-canvas")) {
      const b = await c.boundingBox();
      if (b) {
        for (const f of [0.2, 0.5, 0.8]) {
          await page.mouse.move(b.x + b.width * f, b.y + b.height * 0.5).catch(() => {});
          await page.waitForTimeout(80);
        }
      }
    }
    // try opening the first modal-style actions? keep to passive: click every javascript: link that might exist
    const bad = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll("a[href]").forEach((a) => /^\s*(javascript|data|vbscript):/i.test(a.getAttribute("href")) && out.push(`a[href=${a.getAttribute("href").slice(0, 40)}]`));
      document.querySelectorAll("img[src],iframe[src],script[src]").forEach((e) => /^\s*(javascript|vbscript):/i.test(e.getAttribute("src")) && out.push(`${e.tagName}[src=javascript]`));
      const attrs = ["onerror", "onload", "onclick", "onmouseover", "ontoggle", "onfocus", "onmouseenter"];
      attrs.forEach((at) => document.querySelectorAll(`[${at}]`).forEach((e) => out.push(`<${e.tagName.toLowerCase()} ${at}>`)));
      const where = (e) => ` in .${(e.parentElement?.className || "").toString().slice(0, 40)} <<${e.outerHTML.slice(0, 90)}`;
      // the Stripe Payment Element (the one deliberate exception, see docs/security-frontend.md) injects its own frames: only those from js.stripe.com are tolerated
      document.querySelectorAll("iframe").forEach((e) => !(/^__privateStripe/.test(e.getAttribute("name") || "") || /^https:\/\/(js|hooks|checkout)\.stripe\.com\//.test(e.getAttribute("src") || "")) && out.push("<iframe>" + where(e)));
      document.querySelectorAll("script:not([src])").forEach((s) => /__xss/.test(s.textContent) && out.push("inline script with payload" + where(s)));
      return out;
    });
    const xss = await page.evaluate(() => window.__xss);
    // click any link pointing at a (possibly) dangerous URL if it exists and check nothing runs
    const text = await page.evaluate(() => document.body.innerText.length);
    const escaped = await page.evaluate(() => /<img src=x onerror|<script>|<svg\/onload|javascript:/.test(document.body.innerText));
    if (xss !== undefined || state.xss) fail(`${state.mode}/${state.acct} ${label}: payload EXECUTED (window.__xss=${xss})`);
    else if (bad.length) fail(`${state.mode}/${state.acct} ${label}: dangerous DOM: ${bad.slice(0, 5).join(", ")}`);
    else if (state.dialogs.length > dlgBefore) fail(`${state.mode}/${state.acct} ${label}: dialog fired: ${state.dialogs.slice(dlgBefore).join("|")}`);
    else if (state.pageErrors.length > errsBefore) fail(`${state.mode}/${state.acct} ${label}: pageerror ${state.pageErrors.slice(errsBefore).join(" | ").slice(0, 200)}`);
    else pass(`${state.mode}/${state.acct} ${label}${escaped ? " (payload text shown escaped)" : ""} len=${text}`);
    return escaped;
  } catch (e) {
    if ((state.crashed || /crash/i.test(String(e))) && !opts.stay && !opts.retried) {
      // a renderer died (not a page bug: the same URL passes on a fresh page): replace the page and retry once
      await state.reopen();
      console.log("  WARN retrying " + label + " on a fresh page");
      return checkPage(page, url, label, state, { ...opts, retried: true });
    }
    fail(`${state.mode}/${state.acct} ${label}: ${String(e).slice(0, 160)}`);
    return false;
  }
}

async function sweepAccount(browser, acc, session, mode) {
  const csp = mode === "csp";
  const ctx = await newContext(browser, session, { csp });
  const state = { mode, acct: acc.name, dialogs: [], pageErrors: [], csp: [], xss: false };
  const allowedHosts = new Set([new URL(BASE).host, new URL(API).host, "tile.openstreetmap.org"]);
  state.foreign = new Set();
  const page = await openPage(ctx, state, (p) =>
    p.on("request", (r) => {
      const u = new URL(r.url());
      if (!/^https?:|^wss?:/.test(u.protocol)) return;
      if (![...allowedHosts].some((h) => u.host === h || u.host.endsWith("." + h))) state.foreign.add(u.host);
    })
  );
  await page.goto(BASE + acc.start, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelectorAll("a[href^='/']").length > 6, null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(500);
  const links = await page.evaluate((start) => {
    const out = new Set([start]);
    document.querySelectorAll("a[href^='/']").forEach((a) => {
      const h = a.getAttribute("href");
      if (h && !h.startsWith("//") && !/logout/.test(h)) out.add(h.split("#")[0]);
    });
    return [...out];
  }, acc.start);
  // pages that are reached from menus / dropdowns but may not be in the sidebar DOM (notification center + settings)
  (acc.extra || []).forEach((x) => links.includes(x) || links.push(x));
  console.log(`[${mode}/${acc.name}] ${links.length} sidebar/start links`);
  if (links.length < 6) fail(`${mode}/${acc.name}: sidebar did not render (${links.length} links) - API throttled or session rejected? coverage would be too weak`);
  const details = new Set();
  for (const l of links) {
    await checkPage(page, l, l, state);
    const found = await page.evaluate(([cur, max]) => {
      const out = [];
      document.querySelectorAll("main a[href^='/'], .dashboard-main-body a[href^='/'], table a[href^='/']").forEach((a) => {
        const h = a.getAttribute("href").split("#")[0];
        if (h.startsWith(cur + "/") && /\/[0-9a-f-]{6,}|\/\d+/.test(h) && out.length < max) out.push(h);
      });
      return out;
    }, [l === "/" ? "" : l, MAX_DETAIL]).catch(() => []);
    found.forEach((f) => details.add(f));
  }
  // ratings screens that live on tabs: customer "Ratings received"
  for (const d of [...details]) if (/^\/customers\/[0-9a-f-]{8,}$/.test(d)) details.add(`${d}?tab=ratings`);
  for (const d of [...details].slice(0, 40)) await checkPage(page, d, `${d} (detail)`, state);
  // System > Notifications: the delivery log (user, title, error, event), the expanded row, the test form and the coverage table render API text
  if (acc.name === "admin") {
    await checkPage(page, "/notifications", "/notifications (Push health)", state);
    for (const tab of ["Delivery log", "Send a test", "Coverage"]) {
      await page.click(`button:has-text("${tab}")`).catch(() => {});
      await page.waitForTimeout(900);
      if (tab === "Delivery log") await page.locator("[data-testid=delivery-log] tbody tr").first().click().catch(() => {});
      await checkPage(page, "/notifications", `/notifications (${tab})`, state, { stay: true });
    }
  }
  if (state.crashes) console.log(`  [${mode}/${acc.name}] renderer crashes recovered: ${state.crashes}`);
  if (state.foreign.size) fail(`${mode}/${acc.name}: requests to third-party hosts: ${[...state.foreign].join(", ")}`);
  else pass(`${mode}/${acc.name}: no third-party network requests`);
  if (state.csp.length) {
    // violations are expected only for injected payloads; report unique ones for review
    const uniq = [...new Set(state.csp)];
    console.log(`  [${mode}/${acc.name}] CSP console reports: ${uniq.length}`);
    uniq.slice(0, 5).forEach((u) => console.log("    ", u));
    if (csp) {
      const real = uniq.filter((u) => !/inline (event handler|script)|javascript:|'unsafe-inline'|frame|srcdoc|data:text\/html|evil\.example/i.test(u));
      if (real.length) fail(`${mode}/${acc.name}: unexpected CSP violations (policy too tight for the app): ${real[0]}`);
    }
  }
  await ctx.close();
}

// ------------------------------------------------------------------------------------------------ chat-demo.html
async function chatDemo(browser, mode) {
  const ctx = await browser.newContext();
  if (mode !== "csp") {
    await ctx.route(`${BASE}/chat-demo.html`, async (route) => {
      const resp = await route.fetch();
      return route.fulfill({ response: resp, body: (await resp.text()).replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/i, "") });
    });
  }
  const P = TEXT_PAYLOADS;
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });
  await ctx.route(`${API}/**`, async (route) => {
    const u = route.request().url();
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" } });
    if (u.includes("/auth/login")) return json(route, { accessToken: "t", user: { id: "u1", firstName: P[0] } });
    if (u.includes("/availability")) return json(route, { available: true, agentsOnline: P[1], estimatedWaitSec: 60, reason: P[2], topics: [{ code: P[2], label: P[3] }] });
    if (u.includes("/active"))
      return json(route, { session: { id: "s1", status: "ACTIVE", agent: { firstName: P[4] }, ticketNumber: P[5], queue: { position: P[6], estimatedWaitSec: 60 } } });
    if (u.includes("/messages"))
      return json(route, { messages: [{ id: "m1", senderType: "AGENT", senderName: P[0], body: P[1], createdAt: new Date().toISOString(), attachments: [`javascript:${X}`, `x" onerror="${X}`] }] });
    if (u.includes("/customer/orders")) return json(route, { data: [{ id: P[0], code: P[1], status: P[2] }] });
    return json(route, {});
  });
  await ctx.route("http://localhost:4000/socket.io/**", (r) => r.abort());
  const page = await ctx.newPage();
  const dialogs = [];
  const errs = [];
  page.on("dialog", (d) => (dialogs.push(d.message()), d.dismiss().catch(() => {})));
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.goto(`${BASE}/chat-demo.html`);
  await page.fill("#password", "x").catch(() => {});
  await page.click("#btnLogin");
  await page.waitForTimeout(1200);
  await page.click("#btnOrders").catch(() => {});
  await page.waitForTimeout(600);
  const xss = await page.evaluate(() => window.__xss);
  const bad = await page.evaluate(() => document.querySelectorAll("[onerror],[onload],[ontoggle],script:not([src]),iframe,svg[onload]").length);
  const shown = await page.evaluate(() => document.body.innerText.includes("<img src=x onerror"));
  if (xss !== undefined || bad || dialogs.length) fail(`${mode} chat-demo.html: executed/dangerous DOM (xss=${xss}, bad=${bad}, dialogs=${dialogs.length}${dialogs.length ? " [" + dialogs.join(" | ").slice(0, 160) + "]" : ""}, errs=${errs.join(" | ").slice(0, 160)})`);
  else pass(`${mode} chat-demo.html clean (payload text shown escaped: ${shown})`);
  await ctx.close();
}

// ------------------------------------------------------------------------------------------------ customer website (/order)
async function storefrontSweep(browser, session, mode) {
  const csp = mode === "csp";
  const ctx = await newContext(browser, session, { csp, store: "storefront" });
  const P = TEXT_PAYLOADS;
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: { "access-control-allow-origin": BASE }, body: JSON.stringify(body) });
  const pre = (route) => route.fulfill({ status: 204, headers: { "access-control-allow-origin": BASE, "access-control-allow-headers": "*", "access-control-allow-methods": "*" } });
  // the assistant API (stubbed, full of payloads): config, chat, hand-off, import
  await ctx.route(API + "/public/assistant/**", async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return pre(route);
    const u = req.url();
    if (u.includes("/config")) return json(route, { enabled: true, name: P[0], greeting: P[1], color: COLOR_PAYLOAD, restaurant: { id: "r", slug: "x", name: P[2], logoUrl: URL_PAYLOADS[0] }, mode: "site" });
    if (u.includes("/handoff")) return json(route, { token: "t".repeat(40), url: "javascript:" + X, expiresAt: new Date().toISOString() });
    return json(route, {
      sessionId: "11111111-2222-4333-8444-555555555555",
      restaurant: { id: "r", slug: "maple-corner-convenience", name: P[3], logoUrl: URL_PAYLOADS[1] },
      reply: {
        text: P[4] + " " + P[5],
        cards: [{ menuItemId: "m1", name: P[6], description: P[7], price: 4.99, imageUrl: URL_PAYLOADS[2], tags: [P[0], P[1]], available: true }],
        restaurants: [{ id: "r1", slug: "evil/../../x", name: P[2], cuisine: P[3], openNow: true, deliveryAvailable: true, pickupAvailable: true, rating: 4, logoUrl: URL_PAYLOADS[3] }],
        chips: [{ label: P[5], payload: "menu" }],
      },
      cart: { items: [{ lineId: "l1", menuItemId: "m1", name: P[6], quantity: 1, unitPrice: 4.99, options: [{ id: "o", name: P[7], priceDelta: 0 }], notes: P[0], lineTotal: 4.99 }], count: 1, subtotalEstimate: 4.99 },
      orderNote: P[1], canCheckout: true, loggedIn: true,
    });
  });
  await ctx.route(API + "/customer/assistant/import-handoff", async (route) => {
    if (route.request().method() === "OPTIONS") return pre(route);
    return json(route, { restaurant: { id: "r", slug: "maple-corner-convenience", name: P[0] }, cartCount: 2, orderNote: P[1], skipped: [{ name: P[2], reason: P[3] }] });
  });
  // the notification centre and preferences (stubbed, full of payloads: titles, bodies, links, device labels)
  const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  await ctx.route(new RegExp("^" + reEsc(API) + "/notifications(\\?.*)?$"), async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return pre(route);
    if (req.method() !== "GET") return route.continue();
    const now = new Date().toISOString();
    return json(route, {
      data: P.slice(0, 5).map((t, i) => ({ id: "00000000-0000-4000-8000-00000000000" + i, title: t, body: P[(i + 1) % P.length], event: "order.status", category: i % 2 ? "orders" : P[2], data: null, url: i % 2 ? "javascript:" + X : "//evil.example/x", readAt: i % 3 ? now : null, createdAt: now })),
      nextCursor: null, unread: 2, meta: { page: 1, limit: 20, total: 5 },
    });
  });
  await ctx.route(API + "/notifications/push/devices**", async (route) => {
    if (route.request().method() === "OPTIONS") return pre(route);
    return json(route, { data: [{ id: "00000000-0000-4000-8000-0000000000aa", kind: "web", app: "customer", platform: "web", label: P[0], createdAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), current: false }] });
  });
  // the real Stripe.js must never be fetched by this test (no network dependence, nothing third-party to stall a page)
  await ctx.route(/^https:\/\/([a-z0-9-]+\.)*stripe\.(com|network)\//, (route) => route.abort());
  const state = { mode, acct: "customer", dialogs: [], pageErrors: [], csp: [], xss: false };
  const page = await openPage(ctx, state);
  // real ids for the pages that need one
  const hdr = { authorization: "Bearer " + session.accessToken };
  const orders = await (await fetch(API + "/customer/orders?limit=1", { headers: hdr })).json().catch(() => ({}));
  const orderId = orders && orders.data && orders.data[0] && orders.data[0].id;
  let urls = ["/order", "/order?q=pizza", "/order/r/maple-corner-convenience", "/order/r/napoli-wood-fired-pizza-city-centre", "/order/orders", "/order/login", "/order/login?tab=register", "/order/checkout", "/order/wallet", "/order/notifications", "/order/account", "/order/payouts/return?status=complete&for=driver", "/order/handoff"];
  if (orderId) urls.push("/order/track/" + orderId);
  if (env("SF_URLS", "")) urls = env("SF_URLS", "").split(",");
  for (const u of urls) {
    const escaped = await checkPage(page, u, u, state);
    void escaped;
  }
  // the hand-off result screen (token + restaurant param), then the assistant panel with payload replies
  await checkPage(page, "/order/handoff?token=" + "z".repeat(40) + "&restaurant=maple-corner-convenience", "/order/handoff?token=... (summary screen)", state);
  if (state.crashed) await state.reopen();
  await page.goto(BASE + "/order/r/maple-corner-convenience", { waitUntil: "domcontentloaded" }).catch(async () => {
    await state.reopen();
    await page.goto(BASE + "/order/r/maple-corner-convenience", { waitUntil: "domcontentloaded" });
  });
  await page.waitForSelector("[data-testid=bot-bubble]", { timeout: 10000 }).catch(() => {});
  await page.click("[data-testid=bot-bubble]").catch(() => {});
  await page.fill("[data-testid=bot-input]", "hello").catch(() => {});
  await page.click("[data-testid=bot-send]").catch(() => {});
  await page.waitForTimeout(1500);
  const before = state.pageErrors.length;
  const xss = await page.evaluate(() => window.__xss);
  const bad = await page.evaluate(() => document.querySelectorAll("[onerror],[onload],[ontoggle],iframe,svg[onload],a[href^='javascript'],img[src^='javascript']").length);
  const panelText = await page.evaluate(() => (document.querySelector("[data-testid=bot-panel]") || document.body).innerText);
  const hasCards = await page.locator("[data-testid=bot-card]").count();
  if (xss !== undefined || bad || state.dialogs.length) fail(mode + "/customer assistant panel: executed/dangerous DOM (xss=" + xss + ", bad=" + bad + ", dialogs=" + state.dialogs.length + ")");
  else if (!hasCards) fail(mode + "/customer assistant panel: stubbed reply did not render (cards=0), coverage too weak");
  else pass(mode + "/customer assistant panel clean (payload text shown escaped: " + /<img src=x onerror/.test(panelText) + ")");
  if (state.pageErrors.length > before) fail(mode + "/customer assistant: pageerror " + state.pageErrors.slice(before).join(" | ").slice(0, 160));
  // a guest checkout tap with a javascript: url from the API must stay inside the site
  await page.click("[data-testid=bot-checkout]").catch(() => {});
  await page.waitForTimeout(600);
  const path = new URL(page.url()).pathname;
  if (path !== "/order/handoff" && !path.startsWith("/order")) fail(mode + "/customer: hand-off url from the API navigated away: " + page.url());
  else pass(mode + "/customer: hand-off url from the API stays on /order (" + path + ")");
  if (state.crashes) console.log("  [" + mode + "/customer] renderer crashes recovered: " + state.crashes);
  if (csp && state.csp.length) {
    const uniq = [...new Set(state.csp)];
    console.log("  [" + mode + "/customer] CSP console reports: " + uniq.length);
    uniq.slice(0, 5).forEach((u) => console.log("    ", u));
    const real = uniq.filter((u) => !/inline (event handler|script)|javascript:|'unsafe-inline'|frame|srcdoc|data:text\/html|evil\.example/i.test(u));
    if (real.length) fail(mode + "/customer: unexpected CSP violations (policy too tight for the storefront): " + real[0]);
  }
  await ctx.close();
}

// ------------------------------------------------------------------------------------------------ main
// the CSP <meta> itself: the only third-party origins allowed are Stripe's (the Payment Element needs them); nothing is unsafe
async function cspPolicyCheck() {
  const html = await (await fetch(BASE + "/")).text();
  const m = /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/i.exec(html);
  if (!m) return fail("CSP meta tag is missing from index.html");
  const dir = Object.fromEntries(m[1].split(";").map((s) => s.trim()).filter(Boolean).map((s) => { const [k, ...v] = s.split(/\s+/); return [k, v]; }));
  if (/%REACT_APP_/.test(m[1])) fail("CSP still contains an unreplaced %REACT_APP_...% placeholder (define REACT_APP_CSP_SCRIPT / REACT_APP_CSP_FRAME)");
  const stripeScript = ["'self'", "https://js.stripe.com"];
  const bad = (dir["script-src"] || []).filter((s) => !stripeScript.includes(s));
  if (bad.length) fail("script-src has unexpected sources: " + bad.join(" "));
  else pass("script-src allows only 'self' and Stripe.js (https://js.stripe.com)");
  const frames = dir["frame-src"] || [];
  const badF = frames.filter((s) => !/^https:\/\/(js|hooks|checkout)\.stripe\.com$/.test(s));
  if (badF.length) fail("frame-src has unexpected sources: " + badF.join(" "));
  else pass("frame-src allows only Stripe frames (" + (frames.join(" ") || "none") + ")");
  if (/unsafe-eval|unsafe-inline/.test((dir["script-src"] || []).join(" "))) fail("script-src must not allow unsafe-inline / unsafe-eval");
  if ((dir["default-src"] || []).join(" ") !== "'self'") fail("default-src must stay 'self'");
  if ((dir["object-src"] || []).join(" ") !== "'none'") fail("object-src must stay 'none'");
  const conn = (dir["connect-src"] || []).filter((s) => /^https?:\/\//.test(s) && !/localhost|stripe\.(com|network)$/.test(s) && !/forksy\.ca$/.test(s));
  if (conn.length) fail("connect-src has unexpected third-party origins: " + conn.join(" "));
  else pass("connect-src: only the API, websocket and Stripe origins");
}

// one freshly launched browser per sweep (see the header note about long-lived headless Chromium)
const launch = () => chromium.launch({ headless: !env("HEADED", ""), args: ["--disable-gpu", "--disable-extensions"] });
const withBrowser = async (fn) => {
  const b = await launch();
  try {
    return await fn(b);
  } catch (e) {
    fail("sweep aborted: " + String(e).slice(0, 200));
  } finally {
    await b.close().catch(() => {});
  }
};
try {
  await cspPolicyCheck();
  const sessions = {};
  for (const a of ACCOUNTS) sessions[a.name] = await login(a);
  if (!env("NO_STOREFRONT", "")) sessions.customer = await login({ name: "customer", email: env("CUSTOMER_EMAIL", "customer1@demo.forksy.ca"), password: env("CUSTOMER_PASSWORD", "Demo@12345") });
  const modes = env("CSP_ONLY") ? ["csp"] : env("NOCSP_ONLY") ? ["nocsp"] : ["nocsp", "csp"];
  for (const mode of modes) {
    const only = env("STOREFRONT_ONLY", "") ? "storefront" : env("CHAT_ONLY", "") ? "chat" : "";
    if (!only) for (const a of ACCOUNTS) await withBrowser((b) => sweepAccount(b, a, sessions[a.name], mode));
    if (!only || only === "chat") await withBrowser((b) => chatDemo(b, mode));
    if (sessions.customer && (!only || only === "storefront")) await withBrowser((b) => storefrontSweep(b, sessions.customer, mode));
  }
} catch (e) {
  fail("fatal: " + String(e).slice(0, 200));
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
failed.forEach((f) => console.log(" -", f.msg));
process.exit(failed.length ? 1 : 0);
