/*!
 * FORKY ordering assistant - embeddable chat widget.
 *
 *   <script src="https://api.forky.ca/assistant/widget.js" data-key="bk_XXXXXXXXXXXXXXXXXXXXXXXX" async></script>
 *
 * Attributes:  data-key (restaurant bot key)  |  data-mode="site" [data-restaurant="slug"] (FORKY website bots)
 *              data-position="left|right" (default right)
 * No dependencies, ES2015, one IIFE. Style isolation with Shadow DOM. Everything the server sends is inserted with textContent
 * (never innerHTML) and images are only loaded from http(s) URLs.
 * Public API: window.ForkyAssistant = { open(), close(), version }.
 */
(function () {
  'use strict';
  if (window.ForkyAssistant) return;

  var VERSION = '1.0.0';
  var script = document.currentScript;
  if (!script) {
    var all = document.getElementsByTagName('script');
    for (var i = all.length - 1; i >= 0; i--) {
      if (/assistant\/widget\.js/.test(all[i].src || '')) { script = all[i]; break; }
    }
  }
  if (!script || !script.src) return;

  var botKey = script.getAttribute('data-key') || '';
  var siteMode = script.getAttribute('data-mode') === 'site';
  var restaurantSlug = script.getAttribute('data-restaurant') || '';
  var position = script.getAttribute('data-position') === 'left' ? 'left' : 'right';
  if (!botKey && !siteMode) { try { console.warn('[FORKY assistant] data-key is missing'); } catch (e) {} return; }

  var apiBase;
  try { apiBase = new URL(script.src).origin + '/api/v1'; } catch (e) { return; }

  var storeKey = 'forky-assistant:' + (botKey || restaurantSlug || 'central');
  var state = {
    config: null, sessionId: null, cart: { items: [], count: 0, subtotalEstimate: 0 }, orderNote: null, canCheckout: false,
    restaurant: null, busy: false, open: false, started: false, cartOpen: false, lastQuick: null
  };

  // ---------------------------------------------------------------- storage (may throw in private mode / blocked storage)
  function loadSession() { try { return window.localStorage.getItem(storeKey) || null; } catch (e) { return null; } }
  function saveSession(id) { try { if (id) window.localStorage.setItem(storeKey, id); else window.localStorage.removeItem(storeKey); } catch (e) {} }

  // ---------------------------------------------------------------- tiny DOM helpers (textContent only)
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function attr(n, k, v) { n.setAttribute(k, v); return n; }
  function money(v) { var x = Number(v); return '$' + (isFinite(x) ? x : 0).toFixed(2); }
  function safeImg(u) { return typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null; }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function validColor(c) { return typeof c === 'string' && /^#([0-9a-f]{6}|[0-9a-f]{3})$/i.test(c) ? c : null; }
  function readableOn(hex) {
    var h = hex.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var r = parseInt(h.substr(0, 2), 16), g = parseInt(h.substr(2, 2), 16), b = parseInt(h.substr(4, 2), 16);
    return (0.299 * r + 0.587 * g + 0.114 * b) > 160 ? '#111111' : '#ffffff';
  }

  // ---------------------------------------------------------------- network
  function api(method, path, body) {
    var opts = { method: method, headers: { 'Accept': 'application/json' }, mode: 'cors', credentials: 'omit' };
    if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch(apiBase + path, opts).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (j) {
        if (!res.ok) { var err = new Error((j && j.message) || ('HTTP ' + res.status)); err.status = res.status; err.code = j && j.code; throw err; }
        return j;
      });
    });
  }
  function scopeParams() {
    var p = {};
    if (botKey) p.botKey = botKey; else if (restaurantSlug) p.restaurantSlug = restaurantSlug;
    return p;
  }

  // ---------------------------------------------------------------- build UI
  var host = document.createElement('div');
  host.id = 'forky-assistant-root';
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483000;bottom:0;' + position + ':0;';
  var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : null;
  if (!root) return;

  var css = [
    ':host{all:initial}',
    '*{box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}',
    '.wrap{--accent:#FF6917;--accent-fg:#fff;--bg:#fff;--fg:#1f2430;--muted:#667085;--border:#e4e7ec;--bubble:#f2f4f7;--bot:#f2f4f7;--shadow:0 12px 40px rgba(16,24,40,.25);position:fixed;bottom:16px;' + position + ':16px;font-size:14px;line-height:1.45;color:var(--fg)}',
    '@media (prefers-color-scheme:dark){.wrap{--bg:#1b1f27;--fg:#eceff4;--muted:#9aa3b2;--border:#323846;--bubble:#2a303c;--bot:#2a303c;--shadow:0 12px 40px rgba(0,0,0,.6)}}',
    'button{font:inherit;cursor:pointer;color:inherit}',
    'button:focus-visible,input:focus-visible{outline:3px solid var(--accent);outline-offset:2px}',
    '.launcher{width:58px;height:58px;border-radius:50%;border:0;background:var(--accent);color:var(--accent-fg);box-shadow:var(--shadow);display:flex;align-items:center;justify-content:center;position:relative}',
    '.launcher svg{width:28px;height:28px;fill:currentColor}',
    '.badge{position:absolute;top:-4px;right:-4px;min-width:20px;height:20px;border-radius:10px;background:#111;color:#fff;font-size:11px;display:flex;align-items:center;justify-content:center;padding:0 5px}',
    '.badge[hidden]{display:none}',
    '.panel{position:absolute;bottom:72px;' + position + ':0;width:380px;max-width:calc(100vw - 24px);height:600px;max-height:calc(100vh - 100px);background:var(--bg);border:1px solid var(--border);border-radius:16px;box-shadow:var(--shadow);display:flex;flex-direction:column;overflow:hidden}',
    '.panel[hidden]{display:none}',
    '.head{display:flex;align-items:center;gap:8px;padding:12px 14px;background:var(--accent);color:var(--accent-fg)}',
    '.head .t{flex:1;min-width:0}',
    '.hlogo{width:36px;height:36px;border-radius:50%;object-fit:cover;background:#fff;flex:0 0 36px}',
    '.hlogo[hidden]{display:none}',
    '.head .t b{display:block;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.head .t span{display:block;font-size:12px;opacity:.85;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.hbtn{background:transparent;border:0;color:inherit;width:34px;height:34px;border-radius:8px;display:flex;align-items:center;justify-content:center;position:relative;font-size:18px}',
    '.hbtn:hover{background:rgba(255,255,255,.18)}',
    '.hbtn svg{width:20px;height:20px;fill:currentColor}',
    '.hbtn .badge{top:0;right:0;background:#fff;color:#111}',
    '.log{flex:1;overflow-y:auto;padding:12px 12px 4px;display:flex;flex-direction:column;gap:8px;scroll-behavior:smooth}',
    '.msg{max-width:88%;padding:8px 11px;border-radius:14px;white-space:pre-wrap;word-wrap:break-word;overflow-wrap:anywhere}',
    '.msg.bot{background:var(--bot);align-self:flex-start;border-bottom-left-radius:4px}',
    '.msg.user{background:var(--accent);color:var(--accent-fg);align-self:flex-end;border-bottom-right-radius:4px}',
    '.msg.err{background:#fef3f2;color:#912018;align-self:flex-start}',
    '@media (prefers-color-scheme:dark){.msg.err{background:#4a1d1a;color:#fecdca}}',
    '.typing{align-self:flex-start;color:var(--muted);padding:4px 10px;font-size:13px}',
    '.cards{display:flex;gap:8px;overflow-x:auto;padding:2px 0 6px;align-self:stretch;scroll-snap-type:x proximity}',
    '.card{flex:0 0 190px;scroll-snap-align:start;border:1px solid var(--border);border-radius:12px;overflow:hidden;background:var(--bg);display:flex;flex-direction:column}',
    '.card img{width:100%;height:92px;object-fit:cover;display:block;background:var(--bubble)}',
    '.card .b{padding:8px 10px;display:flex;flex-direction:column;gap:3px;flex:1}',
    '.card .n{font-weight:600}',
    '.card .d{font-size:12px;color:var(--muted);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
    '.card .tags{font-size:11px;color:var(--muted)}',
    '.card .p{display:flex;align-items:center;justify-content:space-between;margin-top:auto;padding-top:6px}',
    '.abtn{border:0;background:var(--accent);color:var(--accent-fg);border-radius:8px;padding:5px 12px;font-weight:600}',
    '.abtn[disabled]{opacity:.45;cursor:not-allowed}',
    '.sub{font-size:12px;color:var(--muted)}',
    '.chips{display:flex;flex-wrap:wrap;gap:6px;padding:6px 12px}',
    '.chip{border:1px solid var(--accent);color:var(--accent);background:transparent;border-radius:999px;padding:5px 12px;font-size:13px}',
    '.chip:hover{background:var(--accent);color:var(--accent-fg)}',
    '@media (prefers-color-scheme:dark){.chip{color:var(--fg)}}',
    '.foot{border-top:1px solid var(--border);padding:8px 10px;display:flex;flex-direction:column;gap:6px}',
    '.row{display:flex;gap:6px}',
    '.in{flex:1;min-width:0;border:1px solid var(--border);border-radius:10px;padding:9px 11px;background:var(--bg);color:var(--fg);font-size:14px}',
    '.send{border:0;background:var(--accent);color:var(--accent-fg);border-radius:10px;padding:0 14px;font-weight:600}',
    '.send[disabled]{opacity:.5}',
    '.co{width:100%;border:0;background:#12b76a;color:#052e1a;border-radius:10px;padding:10px;font-weight:700;font-size:14px}',
    '.co[disabled]{opacity:.5;cursor:not-allowed}',
    '.co[hidden]{display:none}',
    '.pw{font-size:11px;color:var(--muted);text-align:center}',
    '.drawer{position:absolute;inset:0;background:var(--bg);display:flex;flex-direction:column;z-index:2}',
    '.drawer[hidden]{display:none}',
    '.drawer .dh{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--border);font-weight:700}',
    '.drawer .dh span{flex:1}',
    '.drawer .dh button{border:0;background:transparent;font-size:20px;width:34px;height:34px;border-radius:8px}',
    '.drawer .dh button:hover{background:var(--bubble)}',
    '.lines{flex:1;overflow-y:auto;padding:8px 14px}',
    '.line{display:flex;gap:8px;padding:10px 0;border-bottom:1px solid var(--border);align-items:flex-start}',
    '.line .li{flex:1;min-width:0}',
    '.line .ln{font-weight:600}',
    '.line .lo{font-size:12px;color:var(--muted)}',
    '.qty{display:flex;align-items:center;gap:6px;margin-top:6px}',
    '.qty button{width:28px;height:28px;border-radius:8px;border:1px solid var(--border);background:var(--bg)}',
    '.qty .rm{width:auto;padding:0 8px;font-size:12px;color:#b42318}',
    '.lt{font-weight:600;white-space:nowrap}',
    '.empty{color:var(--muted);padding:24px 0;text-align:center}',
    '.dnote{padding:8px 14px;border-top:1px solid var(--border);display:flex;flex-direction:column;gap:6px}',
    '.dnote .cur{font-size:12px;color:var(--muted);white-space:pre-wrap}',
    '.tot{display:flex;justify-content:space-between;font-weight:700;padding:8px 14px 0}',
    '.fine{font-size:12px;color:var(--muted);padding:0 14px 8px}',
    '.dfoot{padding:8px 14px 12px}',
    '@media (max-width:480px){.wrap{bottom:12px;' + position + ':12px}.panel{position:fixed;inset:0;width:100vw;max-width:none;height:100%;max-height:none;border-radius:0;border:0}.launcher[data-open="1"]{display:none}}',
    '@media (prefers-reduced-motion:reduce){.log{scroll-behavior:auto}}'
  ].join('\n');
  // constructable stylesheet first: it is not blocked by a strict page CSP (style-src without 'unsafe-inline'); <style> element as fallback
  try {
    if (typeof CSSStyleSheet === 'function' && 'adoptedStyleSheets' in root) {
      var sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      root.adoptedStyleSheets = [sheet];
    } else { throw new Error('unsupported'); }
  } catch (e) {
    var style = document.createElement('style');
    style.textContent = css;
    root.appendChild(style);
  }

  var wrap = el('div', 'wrap');
  root.appendChild(wrap);

  // launcher
  var launcher = el('button', 'launcher');
  attr(launcher, 'type', 'button');
  attr(launcher, 'aria-label', 'Open ordering assistant');
  attr(launcher, 'aria-haspopup', 'dialog');
  attr(launcher, 'aria-expanded', 'false');
  var svgNS = 'http://www.w3.org/2000/svg';
  function icon(pathD) {
    var s = document.createElementNS(svgNS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('aria-hidden', 'true');
    var p = document.createElementNS(svgNS, 'path');
    p.setAttribute('d', pathD);
    s.appendChild(p);
    return s;
  }
  var ICON_CHAT = 'M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 4v-4H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z';
  var ICON_CART = 'M7 18a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm10 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM1 2v2h2l3.6 7.6-1.4 2.4A2 2 0 0 0 7 17h12v-2H7.4l1.1-2h7.5a2 2 0 0 0 1.7-1l3.6-6.5A1 1 0 0 0 20.4 4H5.2L4.3 2H1z';
  launcher.appendChild(icon(ICON_CHAT));
  var launchBadge = el('span', 'badge', '0');
  launchBadge.hidden = true;
  launcher.appendChild(launchBadge);
  wrap.appendChild(launcher);

  // panel
  var panel = el('div', 'panel');
  attr(panel, 'role', 'dialog');
  attr(panel, 'aria-label', 'Ordering assistant');
  panel.hidden = true;
  wrap.appendChild(panel);

  var head = el('div', 'head');
  var htitle = el('div', 't');
  var hname = el('b', null, 'Assistant');
  var hsub = el('span', null, '');
  htitle.appendChild(hname); htitle.appendChild(hsub);
  var cartBtn = el('button', 'hbtn');
  attr(cartBtn, 'type', 'button'); attr(cartBtn, 'aria-label', 'Open cart');
  cartBtn.appendChild(icon(ICON_CART));
  var cartBadge = el('span', 'badge', '0'); cartBadge.hidden = true;
  cartBtn.appendChild(cartBadge);
  var closeBtn = el('button', 'hbtn', '×');
  attr(closeBtn, 'type', 'button'); attr(closeBtn, 'aria-label', 'Close assistant');
  var hlogo = document.createElement('img');
  hlogo.className = 'hlogo'; hlogo.alt = ''; hlogo.referrerPolicy = 'no-referrer'; hlogo.hidden = true;
  hlogo.addEventListener('error', function () { hlogo.hidden = true; });
  head.appendChild(hlogo); head.appendChild(htitle); head.appendChild(cartBtn); head.appendChild(closeBtn);
  panel.appendChild(head);

  var log = el('div', 'log');
  attr(log, 'role', 'log'); attr(log, 'aria-live', 'polite'); attr(log, 'aria-label', 'Conversation');
  panel.appendChild(log);
  var chipsBox = el('div', 'chips');
  panel.appendChild(chipsBox);

  var foot = el('div', 'foot');
  var checkoutBtn = el('button', 'co', 'Checkout on FORKY');
  attr(checkoutBtn, 'type', 'button');
  checkoutBtn.hidden = true;
  var form = el('form', 'row');
  var input = el('input', 'in');
  attr(input, 'type', 'text'); attr(input, 'maxlength', '500'); attr(input, 'autocomplete', 'off');
  attr(input, 'aria-label', 'Type your message'); attr(input, 'placeholder', 'Ask about the menu or add an item…');
  var sendBtn = el('button', 'send', 'Send');
  attr(sendBtn, 'type', 'submit');
  form.appendChild(input); form.appendChild(sendBtn);
  var pw = el('div', 'pw', 'Powered by FORKY');
  foot.appendChild(checkoutBtn); foot.appendChild(form); foot.appendChild(pw);
  panel.appendChild(foot);

  // cart drawer
  var drawer = el('div', 'drawer');
  drawer.hidden = true;
  attr(drawer, 'role', 'region'); attr(drawer, 'aria-label', 'Your cart');
  var dh = el('div', 'dh');
  var dtitle = el('span', null, 'Your cart');
  var dclose = el('button', null, '×');
  attr(dclose, 'type', 'button'); attr(dclose, 'aria-label', 'Close cart');
  dh.appendChild(dtitle); dh.appendChild(dclose);
  var lines = el('div', 'lines');
  var dnote = el('form', 'dnote');
  var noteCur = el('div', 'cur');
  var noteRow = el('div', 'row');
  var noteIn = el('input', 'in');
  attr(noteIn, 'type', 'text'); attr(noteIn, 'maxlength', '200'); attr(noteIn, 'aria-label', 'Note for the kitchen'); attr(noteIn, 'placeholder', 'Note for the kitchen (e.g. no onions)');
  var noteBtn = el('button', 'send', 'Add note');
  attr(noteBtn, 'type', 'submit');
  noteRow.appendChild(noteIn); noteRow.appendChild(noteBtn);
  dnote.appendChild(noteCur); dnote.appendChild(noteRow);
  var tot = el('div', 'tot');
  var totL = el('span', null, 'Estimated subtotal'); var totV = el('span', null, '$0.00');
  tot.appendChild(totL); tot.appendChild(totV);
  var fine = el('div', 'fine', 'Estimate from menu prices. The final price is shown at checkout.');
  var dfoot = el('div', 'dfoot');
  var dco = el('button', 'co', 'Checkout on FORKY');
  attr(dco, 'type', 'button');
  dfoot.appendChild(dco);
  drawer.appendChild(dh); drawer.appendChild(lines); drawer.appendChild(dnote); drawer.appendChild(tot); drawer.appendChild(fine); drawer.appendChild(dfoot);
  panel.appendChild(drawer);

  document.body ? document.body.appendChild(host) : document.addEventListener('DOMContentLoaded', function () { document.body.appendChild(host); });

  // ---------------------------------------------------------------- theming
  function applyTheme() {
    var c = validColor(state.config && state.config.color) || '#FF6917';
    wrap.style.setProperty('--accent', c);
    wrap.style.setProperty('--accent-fg', readableOn(c));
  }

  // ---------------------------------------------------------------- rendering
  function scrollDown() { log.scrollTop = log.scrollHeight; }

  function addMsg(role, text) {
    var m = el('div', 'msg ' + role, text);
    log.appendChild(m);
    scrollDown();
    return m;
  }

  function renderCards(cards) {
    if (!cards || !cards.length) return;
    var box = el('div', 'cards');
    cards.slice(0, 6).forEach(function (c) {
      var card = el('div', 'card');
      var img = safeImg(c.imageUrl);
      if (img) {
        var im = document.createElement('img');
        im.src = img; im.alt = ''; im.loading = 'lazy'; im.referrerPolicy = 'no-referrer';
        im.addEventListener('error', function () { if (im.parentNode) im.parentNode.removeChild(im); });
        card.appendChild(im);
      }
      var b = el('div', 'b');
      b.appendChild(el('div', 'n', c.name));
      if (c.description) b.appendChild(el('div', 'd', c.description));
      if (c.tags && c.tags.length) b.appendChild(el('div', 'tags', c.tags.join(' · ')));
      var p = el('div', 'p');
      p.appendChild(el('b', null, money(c.price)));
      var add = el('button', 'abtn', c.available ? 'Add' : 'Unavailable');
      attr(add, 'type', 'button');
      attr(add, 'aria-label', (c.available ? 'Add ' : 'Unavailable: ') + c.name);
      if (!c.available) add.disabled = true;
      else add.addEventListener('click', function () { send('Add ' + c.name, 'add:' + c.menuItemId); });
      p.appendChild(add);
      b.appendChild(p);
      card.appendChild(b);
      box.appendChild(card);
    });
    log.appendChild(box);
  }

  function renderRestaurants(list) {
    if (!list || !list.length) return;
    var box = el('div', 'cards');
    list.slice(0, 6).forEach(function (r) {
      var card = el('div', 'card');
      var img = safeImg(r.logoUrl);
      if (img) {
        var im = document.createElement('img');
        im.src = img; im.alt = ''; im.loading = 'lazy'; im.referrerPolicy = 'no-referrer';
        im.addEventListener('error', function () { if (im.parentNode) im.parentNode.removeChild(im); });
        card.appendChild(im);
      }
      var b = el('div', 'b');
      b.appendChild(el('div', 'n', r.name));
      var meta = [];
      if (r.cuisine) meta.push(r.cuisine);
      meta.push(r.openNow ? 'Open now' : 'Closed now');
      if (r.rating) meta.push('★ ' + r.rating);
      b.appendChild(el('div', 'd', meta.join(' · ')));
      var svc = [];
      if (r.deliveryAvailable) svc.push('Delivery');
      if (r.pickupAvailable) svc.push('Pickup');
      if (svc.length) b.appendChild(el('div', 'tags', svc.join(' · ')));
      var p = el('div', 'p');
      var go = el('button', 'abtn', 'Order here');
      attr(go, 'type', 'button'); attr(go, 'aria-label', 'Order from ' + r.name);
      go.addEventListener('click', function () { send('Order from ' + r.name, 'restaurant:' + r.slug); });
      p.appendChild(go);
      b.appendChild(p);
      card.appendChild(b);
      box.appendChild(card);
    });
    log.appendChild(box);
  }

  function renderChips(chips) {
    clear(chipsBox);
    (chips || []).slice(0, 6).forEach(function (c) {
      var b = el('button', 'chip', c.label);
      attr(b, 'type', 'button');
      b.addEventListener('click', function () {
        if (c.payload === 'checkout' && state.canCheckout) { checkout(); return; }
        send(c.label, c.payload);
      });
      chipsBox.appendChild(b);
    });
  }

  function renderCart() {
    var n = state.cart.count || 0;
    [launchBadge, cartBadge].forEach(function (b) { b.textContent = String(n); b.hidden = n < 1; });
    cartBtn.setAttribute('aria-label', 'Open cart (' + n + ' item' + (n === 1 ? '' : 's') + ')');
    checkoutBtn.hidden = n < 1;
    checkoutBtn.disabled = !state.canCheckout || state.busy;
    checkoutBtn.title = state.canCheckout ? '' : 'Add more to meet the minimum order or wait until the restaurant is open';
    dco.disabled = !state.canCheckout || state.busy;
    clear(lines);
    if (!state.cart.items.length) lines.appendChild(el('div', 'empty', 'Your cart is empty.'));
    state.cart.items.forEach(function (l) {
      var row = el('div', 'line');
      var li = el('div', 'li');
      li.appendChild(el('div', 'ln', l.name));
      var det = [];
      (l.options || []).forEach(function (o) { det.push(o.name); });
      if (l.notes) det.push('Note: ' + l.notes);
      if (det.length) li.appendChild(el('div', 'lo', det.join(' · ')));
      var q = el('div', 'qty');
      var minus = el('button', null, '−'); attr(minus, 'type', 'button'); attr(minus, 'aria-label', 'One less ' + l.name);
      var qv = el('span', null, String(l.quantity)); attr(qv, 'aria-label', 'Quantity');
      var plus = el('button', null, '+'); attr(plus, 'type', 'button'); attr(plus, 'aria-label', 'One more ' + l.name);
      var rm = el('button', 'rm', 'Remove'); attr(rm, 'type', 'button'); attr(rm, 'aria-label', 'Remove ' + l.name);
      minus.addEventListener('click', function () { send('', 'dec:' + l.lineId, true); });
      plus.addEventListener('click', function () { send('', 'inc:' + l.lineId, true); });
      rm.addEventListener('click', function () { send('', 'remove:' + l.lineId, true); });
      q.appendChild(minus); q.appendChild(qv); q.appendChild(plus); q.appendChild(rm);
      li.appendChild(q);
      row.appendChild(li);
      row.appendChild(el('div', 'lt', money(l.lineTotal)));
      lines.appendChild(row);
    });
    noteCur.textContent = state.orderNote ? 'Kitchen note: ' + state.orderNote : '';
    totV.textContent = money(state.cart.subtotalEstimate);
  }

  function renderHeader() {
    hname.textContent = (state.config && state.config.name) || 'Assistant';
    var r = state.restaurant || (state.config && state.config.restaurant);
    hsub.textContent = r && r.name ? r.name : 'FORKY';
    var logo = safeImg(state.config && state.config.logoUrl) || safeImg(r && r.logoUrl);
    if (logo) { if (hlogo.getAttribute('src') !== logo) hlogo.src = logo; hlogo.hidden = false; } else { hlogo.hidden = true; }
    panel.setAttribute('aria-label', hname.textContent + (r && r.name ? ' for ' + r.name : ''));
  }

  function setBusy(b) {
    state.busy = b;
    input.disabled = b; sendBtn.disabled = b;
    renderCartButtonsOnly();
  }
  function renderCartButtonsOnly() {
    checkoutBtn.disabled = !state.canCheckout || state.busy;
    dco.disabled = !state.canCheckout || state.busy;
  }

  // ---------------------------------------------------------------- conversation
  function apply(res, silent) {
    if (res.sessionId) { state.sessionId = res.sessionId; saveSession(res.sessionId); }
    if (res.restaurant !== undefined) state.restaurant = res.restaurant;
    if (res.cart) state.cart = res.cart;
    state.orderNote = res.orderNote || null;
    state.canCheckout = !!res.canCheckout;
    renderHeader();
    renderCart();
    if (silent) return;
    var r = res.reply || {};
    if (r.text) addMsg('bot', r.text);
    renderCards(r.cards);
    renderRestaurants(r.restaurants);
    renderChips(r.chips);
    scrollDown();
  }

  function showError(e) {
    var text;
    if (e && e.code === 'SESSION_LIMIT') {
      state.sessionId = null; saveSession(null);
      text = 'This chat reached its message limit, so I started fresh. Send your message again.';
    } else if (e && e.status === 429) {
      text = 'You are sending messages too quickly. Please wait a few seconds and try again.';
    } else if (e && (e.status === 403 || e.status === 404)) {
      text = 'The assistant is not available on this website right now.';
    } else {
      text = "I can't reach the assistant right now. Please check your connection and try again.";
    }
    addMsg('err', text);
    if (state.lastQuick || state.lastText) {
      clear(chipsBox);
      var retry = el('button', 'chip', 'Try again');
      attr(retry, 'type', 'button');
      retry.addEventListener('click', function () { send(state.lastText || '', state.lastQuick, state.lastSilent); });
      chipsBox.appendChild(retry);
    }
  }

  function send(text, quick, silent) {
    if (state.busy) return;
    var msg = (text || '').trim();
    if (!msg && !quick) return;
    state.lastText = msg; state.lastQuick = quick || null; state.lastSilent = !!silent;
    if (!silent && msg) addMsg('user', msg);
    clear(chipsBox);
    setBusy(true);
    var typing = silent ? null : el('div', 'typing', 'Typing…');
    if (typing) { log.appendChild(typing); scrollDown(); }
    var body = scopeParams();
    if (state.sessionId) body.sessionId = state.sessionId;
    body.message = msg || (quick ? quick.split(':')[0] : '');
    if (quick) body.quick = quick;
    return api('POST', '/public/assistant/chat', body)
      .then(function (res) { if (typing && typing.parentNode) typing.parentNode.removeChild(typing); apply(res, silent); })
      .catch(function (e) { if (typing && typing.parentNode) typing.parentNode.removeChild(typing); showError(e); })
      .then(function () { setBusy(false); if (!state.cartOpen) { try { input.focus(); } catch (e) {} } });
  }

  function checkout() {
    if (state.busy || !state.sessionId) return;
    setBusy(true);
    var body = { sessionId: state.sessionId };
    if (botKey) body.botKey = botKey;
    api('POST', '/public/assistant/handoff', body)
      .then(function (res) {
        if (!res || typeof res.url !== 'string' || !/^https?:\/\//i.test(res.url)) throw new Error('bad url');
        addMsg('bot', 'Taking you to FORKY to finish your order…');
        // top-level navigation so the FORKY login / checkout runs in the whole window (not inside a frame)
        try { (window.top || window).location.assign(res.url); }
        catch (e) { var w = window.open(res.url, '_blank', 'noopener'); if (!w) window.location.assign(res.url); }
      })
      .catch(function (e) {
        if (e && e.status === 400) addMsg('err', e.message || 'Add something to your cart first.');
        else showError(e);
      })
      .then(function () { setBusy(false); });
  }

  // ---------------------------------------------------------------- open / close / focus trap
  function focusables() {
    var sel = 'button:not([disabled]),input:not([disabled])';
    var nodes = Array.prototype.slice.call(panel.querySelectorAll(sel));
    return nodes.filter(function (n) {
      for (var p = n; p && p !== panel; p = p.parentNode) { if (p.hidden) return false; }
      return true;
    });
  }
  function openPanel() {
    if (!state.config || state.open) return;
    state.open = true;
    panel.hidden = false;
    launcher.setAttribute('aria-expanded', 'true');
    launcher.setAttribute('data-open', '1');
    if (!state.started) { state.started = true; start(); }
    setTimeout(function () { try { input.focus(); } catch (e) {} }, 0);
  }
  function closePanel() {
    if (!state.open) return;
    state.open = false;
    closeCart(true);
    panel.hidden = true;
    launcher.setAttribute('aria-expanded', 'false');
    launcher.removeAttribute('data-open');
    try { launcher.focus(); } catch (e) {}
  }
  function openCart() { state.cartOpen = true; drawer.hidden = false; cartBtn.setAttribute('aria-expanded', 'true'); renderCart(); try { dclose.focus(); } catch (e) {} }
  function closeCart(silentFocus) { if (!state.cartOpen) return; state.cartOpen = false; drawer.hidden = true; cartBtn.setAttribute('aria-expanded', 'false'); if (!silentFocus) { try { cartBtn.focus(); } catch (e) {} } }

  launcher.addEventListener('click', function () { state.open ? closePanel() : openPanel(); });
  closeBtn.addEventListener('click', closePanel);
  cartBtn.addEventListener('click', function () { state.cartOpen ? closeCart() : openCart(); });
  dclose.addEventListener('click', function () { closeCart(); });
  checkoutBtn.addEventListener('click', checkout);
  dco.addEventListener('click', checkout);
  form.addEventListener('submit', function (e) { e.preventDefault(); var v = input.value; input.value = ''; send(v); });
  dnote.addEventListener('submit', function (e) {
    e.preventDefault();
    var v = noteIn.value.trim();
    if (!v) return;
    noteIn.value = '';
    send('', 'note:' + v.slice(0, 100), true);
  });
  root.addEventListener('keydown', function (e) {
    if (!state.open) return;
    if (e.key === 'Escape' || e.key === 'Esc') {
      e.stopPropagation();
      if (state.cartOpen) closeCart(); else closePanel();
      return;
    }
    if (e.key === 'Tab') {
      var f = focusables();
      var scope = state.cartOpen ? f.filter(function (n) { return drawer.contains(n); }) : f.filter(function (n) { return !drawer.contains(n); });
      if (!scope.length) return;
      var first = scope[0], last = scope[scope.length - 1];
      var active = root.activeElement;
      if (e.shiftKey && (active === first || !active || !panel.contains(active))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (active === last || !active || !panel.contains(active))) { e.preventDefault(); first.focus(); }
    }
  });

  // ---------------------------------------------------------------- start
  function start() {
    var r = (state.config && state.config.restaurant) ? state.config.restaurant.name : null;
    addMsg('bot', (state.config && state.config.greeting) || ('Hi! I can help you order' + (r ? ' from ' + r : '') + '.'));
    var chips = [{ label: 'Menu', payload: 'menu' }, { label: 'Popular', payload: 'popular' }, { label: 'Hours', payload: 'hours' }];
    if (!state.config.restaurant && !restaurantSlug && !botKey) chips = (state.config.chips && state.config.chips.length ? state.config.chips : [{ label: 'Open now', payload: 'find:open now' }, { label: 'Pizza', payload: 'find:pizza' }, { label: 'Vegetarian', payload: 'find:vegetarian' }, { label: 'Delivery', payload: 'find:delivery' }]);
    renderChips(chips);
    // returning visitor: quietly refresh the cart of the saved session
    if (state.sessionId) send('', 'cart', true);
  }

  function init() {
    state.sessionId = loadSession();
    var qs = [];
    var p = scopeParams();
    for (var k in p) if (Object.prototype.hasOwnProperty.call(p, k)) qs.push(encodeURIComponent(k) + '=' + encodeURIComponent(p[k]));
    api('GET', '/public/assistant/config' + (qs.length ? '?' + qs.join('&') : ''))
      .then(function (cfg) {
        if (!cfg || cfg.enabled === false) return;
        state.config = cfg;
        state.restaurant = cfg.restaurant || null;
        applyTheme();
        renderHeader();
        renderCart();
        wrap.hidden = false;
      })
      .catch(function (e) {
        // not enabled / origin not allowed / offline: stay invisible instead of showing a broken button
        wrap.hidden = true;
        try { console.warn('[FORKY assistant] not started: ' + (e && e.message)); } catch (x) {}
      });
  }

  window.ForkyAssistant = { open: openPanel, close: closePanel, version: VERSION };
  wrap.hidden = true; // shown once the configuration was loaded
  init();
})();
