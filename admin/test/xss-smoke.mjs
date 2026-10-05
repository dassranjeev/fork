#!/usr/bin/env node
/**
 * XSS / client-side-injection regression smoke test for the Admin Console and Restaurant Portal.
 *
 * What it does
 *  1. Logs in ONCE per account through the API (the login endpoint is throttled) and injects the tokens into the browser.
 *  2. Intercepts every API JSON response (page.route) and rewrites free-text fields (names, comments, messages, titles,
 *     descriptions, notes, addresses ...) to XSS payloads, URL fields to javascript: URLs and colour fields to CSS/HTML
 *     break-outs. This tests the UI regardless of whether the backend sanitises.
 *  3. Visits every sidebar link (+ a few detail pages reached from them), hovers charts (tooltips) and asserts:
 *       - window.__xss is still undefined (no payload executed)
 *       - no alert/confirm/prompt dialog fired
 *       - no element with an inline event handler attribute, no <a href="javascript:..."> reached the DOM
 *       - no page errors
 *  4. Runs everything twice: once with the real Content-Security-Policy and once with the CSP meta stripped
 *     ("CSP off") so sanitising/escaping is proven on its own, not just thanks to the CSP.
 *  5. Loads public/chat-demo.html with stubbed API responses full of payloads.
 *
 * Run:   node admin/test/xss-smoke.mjs
 * Env:   BASE_URL (http://localhost:3000)  API_URL (http://localhost:4000/api/v1)
 *        ADMIN_EMAIL / ADMIN_PASSWORD  OWNER_EMAIL / OWNER_PASSWORD
 *        PLAYWRIGHT_DIR  folder whose node_modules contains `playwright` (default: resolve normally, then CWD)
 *        HEADED=1 to watch it, MAX_DETAIL=2 detail pages per list page, CSP_ONLY=1 / NOCSP_ONLY=1
 * Exit code 0 = all clean, 1 = a payload executed / error found.
 */
import { createRequire } from "node:module";
import path from "node:path";

const env = (k, d) => process.env[k] ?? d;
const BASE = env("BASE_URL", "http://localhost:3000").replace(/\/$/, "");
const API = env("API_URL", "http://localhost:4000/api/v1").replace(/\/$/, "");
const ACCOUNTS = [
  { name: "admin", email: env("ADMIN_EMAIL", "admin@forksy.ca"), password: env("ADMIN_PASSWORD", "Admin@12345"), start: "/" },
  { name: "owner", email: env("OWNER_EMAIL", "owner1@demo-restaurant.ca"), password: env("OWNER_PASSWORD", "Demo@12345"), start: "/portal" },
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

const TEXT_KEYS = /^(name|firstName|lastName|fullName|title|body|message|comment|comments|description|notes?|address\d?|street|text|label|subject|reason|content|answer|question|summary|displayName|restaurantName|customerName|driverName|raterName|reportReason|brand|slug|code|businessName|city|unit|instructions|response|reply|feedback|excerpt|caption|before|after|details?|topic|tag|tags)$/i;
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

async function newContext(browser, session, { csp }) {
  const ctx = await browser.newContext();
  await ctx.addInitScript(([a, r]) => {
    try {
      localStorage.setItem("forksy.access", a);
      localStorage.setItem("forksy.refresh", r);
    } catch {}
  }, [session.accessToken, session.refreshToken]);
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

async function checkPage(page, url, label, state) {
  state.xss = false;
  const errsBefore = state.pageErrors.length;
  const dlgBefore = state.dialogs.length;
  try {
    await page.goto(BASE + url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(async () => {
      await page.waitForTimeout(1500);
      await page.goto(BASE + url, { waitUntil: "domcontentloaded", timeout: 30000 });
    });
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(700);
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
      document.querySelectorAll("iframe").forEach((e) => out.push("<iframe>" + where(e)));
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
    fail(`${state.mode}/${state.acct} ${label}: ${String(e).slice(0, 160)}`);
    return false;
  }
}

async function sweepAccount(browser, acc, session, mode) {
  const csp = mode === "csp";
  const ctx = await newContext(browser, session, { csp });
  const page = await ctx.newPage();
  const state = { mode, acct: acc.name, dialogs: [], pageErrors: [], csp: [], xss: false };
  page.on("dialog", async (d) => {
    state.dialogs.push(`${d.type()}:${d.message().slice(0, 40)}`);
    await d.dismiss().catch(() => {});
  });
  page.on("pageerror", (e) => state.pageErrors.push(String(e.message || e)));
  page.on("console", (m) => {
    const t = m.text();
    if (/Content Security Policy|Refused to/i.test(t)) state.csp.push(t.slice(0, 220));
  });
  const allowedHosts = new Set([new URL(BASE).host, new URL(API).host, "tile.openstreetmap.org"]);
  state.foreign = new Set();
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (!/^https?:|^wss?:/.test(u.protocol)) return;
    if (![...allowedHosts].some((h) => u.host === h || u.host.endsWith("." + h))) state.foreign.add(u.host);
  });
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
  page.on("dialog", (d) => (dialogs.push(d.message()), d.dismiss()));
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
  if (xss !== undefined || bad || dialogs.length) fail(`${mode} chat-demo.html: executed/dangerous DOM (xss=${xss}, bad=${bad}, dialogs=${dialogs.length})`);
  else pass(`${mode} chat-demo.html clean (payload text shown escaped: ${shown})`);
  await ctx.close();
}

// ------------------------------------------------------------------------------------------------ main
const browser = await chromium.launch({ headless: !env("HEADED", "") });
try {
  const sessions = {};
  for (const a of ACCOUNTS) sessions[a.name] = await login(a);
  const modes = env("CSP_ONLY") ? ["csp"] : env("NOCSP_ONLY") ? ["nocsp"] : ["nocsp", "csp"];
  for (const mode of modes) {
    for (const a of ACCOUNTS) await sweepAccount(browser, a, sessions[a.name], mode);
    await chatDemo(browser, mode);
  }
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
failed.forEach((f) => console.log(" -", f.msg));
process.exit(failed.length ? 1 : 0);
