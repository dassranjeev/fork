// XSS check of the bot Training screens (portal tabs + admin pages): every string the training API returns is rewritten to a payload. Needs: playwright resolvable (NODE_PATH), API :4000, admin :3000, demo seed with some training data (the sidebar sweep covers the rest).
const { chromium } = require('playwright');
const API = 'http://localhost:4000/api/v1';
const X = 'window.__xss=1';
const P = [`<img src=x onerror=${X}>`, `"><svg onload=${X}>`, `<script>${X}</script>`, `<a href="javascript:${X}">x</a>`, `<details open ontoggle=${X}>`];
let c = 0;
const mut = (v, k = '') => typeof v === 'string' ? (/id$|Id$|^(status|kind|outcome|source|type|day|createdAt|updatedAt|at|hash|scopeKey|state|code|severity|field|date)$/i.test(k) || /^\d{4}-\d\d|^[0-9a-f-]{36}$/.test(v) ? v : v.slice(0, 12) + P[c++ % P.length]) : Array.isArray(v) ? v.map((x) => mut(x, k)) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([kk, x]) => [kk, mut(x, kk)])) : v;
let n = 0, bad = 0; const ck = (m, ok, d) => { n++; if (!ok) bad++; console.log((ok ? 'PASS ' : 'FAIL ') + m + (!ok && d !== undefined ? ' -> ' + JSON.stringify(d).slice(0, 300) : '')); };
(async () => {
  const J = async (p, b) => (await fetch(API + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })).json();
  const lo = await J('/auth/login', { identifier: 'owner2@demo-restaurant.ca', password: 'Demo@12345', app: 'restaurant' });
  await new Promise((r) => setTimeout(r, 1500));
  const la = await J('/auth/login', { identifier: 'admin@forky.ca', password: 'Admin@12345' });
  const rid = lo.user.restaurantIds[0];
  const b = await chromium.launch();
  const run = async (tokens, url, open, label) => {
    const ctx = await b.newContext({ viewport: { width: 1440, height: 1000 } });
    await ctx.addInitScript(([a, r]) => { localStorage.setItem('forky.access', a); localStorage.setItem('forky.refresh', r); }, [tokens.accessToken, tokens.refreshToken]);
    await ctx.route(/\/api\/v1\/(restaurant|admin)\/assistant\/training\//, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const res = await route.fetch();
      let j; try { j = await res.json(); } catch (e) { return route.fulfill({ response: res }); }
      route.fulfill({ response: res, json: mut(j) });
    });
    const page = await ctx.newPage();
    const dialogs = []; const errs = [];
    page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });
    page.on('pageerror', (e) => errs.push(e.message));
    await page.goto(url);
    if (open) await open(page);
    await page.getByTestId('training-area').waitFor({ timeout: 20000 });
    for (const t of ['Overview', 'Knowledge', 'Nicknames|Synonyms', 'Documents', 'Unanswered inbox', 'Test bench', 'Versions & publish']) {
      await page.getByTestId('training-area').getByRole('button', { name: new RegExp(t) }).first().click();
      await page.waitForTimeout(1200);
      if (t === 'Knowledge') { const e = page.getByRole('button', { name: 'Edit' }).first(); if (await e.count()) { await e.click(); await page.waitForTimeout(600); await page.keyboard.press('Escape'); await page.locator('.modal.show').getByRole('button', { name: /Cancel|Close/ }).first().click().catch(() => {}); } }
      if (t === 'Versions & publish') { const v = page.getByRole('button', { name: 'View' }).first(); if (await v.count()) { await v.click(); await page.waitForTimeout(600); await page.locator('.modal.show').getByRole('button', { name: 'Close' }).first().click().catch(() => {}); } }
    }
    const state = await page.evaluate(() => ({ xss: window.__xss, inline: document.querySelectorAll('[onerror],[onload],[onclick],[ontoggle],[onmouseover]').length, js: document.querySelectorAll('a[href^="javascript:" i]').length, scripts: [...document.querySelectorAll('script')].filter((s) => /__xss/.test(s.textContent)).length, text: document.body.innerText.includes('<img src=x') }));
    ck(label + ': no payload executed, no inline handlers, no javascript: links', state.xss === undefined && !state.inline && !state.js && !state.scripts && !dialogs.length && !errs.length, { state, dialogs, errs: errs.slice(0, 2) });
    await ctx.close();
  };
  try {
    await run(lo, 'http://localhost:3000/portal/assistant', async (p) => { await p.getByRole('button', { name: 'Training' }).first().click(); }, 'portal training tabs');
    await run(la, `http://localhost:3000/assistant/training/restaurants/${rid}`, null, 'admin per-restaurant training');
    await run(la, 'http://localhost:3000/assistant/training/central', null, 'admin central training');
    const ctx = await b.newContext({ viewport: { width: 1440, height: 1000 } });
    await ctx.addInitScript(([a, r]) => { localStorage.setItem('forky.access', a); localStorage.setItem('forky.refresh', r); }, [la.accessToken, la.refreshToken]);
    await ctx.route(/\/api\/v1\/admin\/assistant\/training\/(overview|restaurants\?|requests)/, async (route) => { const res = await route.fetch(); let j; try { j = await res.json(); } catch (e) { return route.fulfill({ response: res }); } route.fulfill({ response: res, json: mut(j) }); });
    const page = await ctx.newPage(); const dialogs = []; page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });
    for (const u of ['/assistant/training', '/assistant/training/restaurants']) { await page.goto('http://localhost:3000' + u); await page.waitForTimeout(2500); }
    const s = await page.evaluate(() => ({ xss: window.__xss, inline: document.querySelectorAll('[onerror],[onload],[ontoggle]').length }));
    ck('admin training overview + coverage: payloads rendered as text', s.xss === undefined && !s.inline && !dialogs.length, { s, dialogs });
  } catch (e) { ck('script error ' + e.message.split('\n')[0], false); }
  await b.close();
  console.log(`${n - bad}/${n} training XSS checks passed`);
  process.exit(bad ? 1 : 0);
})();
