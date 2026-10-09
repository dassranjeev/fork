/* FORKSY notifications for the static driver demo page (plain browser JS, no modules, no inline scripts: the page CSP is strict).
 * A small port of admin/src/lib/notify (push.js, sound.js, alerts.js, store.js, sw-register.js) for a page without a bundler.
 *
 *   FkNotify.init({ api: () => 'http://localhost:4000/api/v1', token: () => accessToken, onOfferAccepted: fn, onTripChange: fn })
 *   FkNotify.start(user)   after a login: silent re-subscribe, Socket.IO, inbox, a pending offer
 *   FkNotify.stop()        before a logout (the token is still valid): unsubscribes this browser from push, closes the socket
 *
 * Everything that comes from the API is rendered with textContent only. The browser permission is requested ONLY inside the click
 * handler of "Turn on notifications"; loading the page, logging in or receiving an offer never prompt.
 */
(function () {
  'use strict';

  var APP = 'driver';
  var DAY = 86400000;
  var cfg = { api: function () { return ''; }, token: function () { return null; }, onOfferAccepted: null, onTripChange: null };
  var user = null;

  var $ = function (id) { return document.getElementById(id); };
  var show = function (id, on) { var e = $(id); if (e) e.classList.toggle('hide', !on); };
  function setText(id, t) { var e = $(id); if (e) e.textContent = t == null ? '' : String(t); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; }

  // ------------------------------------------------------------------------------------------------ storage (never throws)
  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* private window */ } }
  function lsDel(k) { try { window.localStorage.removeItem(k); } catch (e) { /* ignore */ } }
  function optKey() { return 'fk.push.' + APP + '.optin.' + ((user && user.id) || 'anon'); }
  var optedIn = function () { return lsGet(optKey()) === '1'; };

  // ------------------------------------------------------------------------------------------------ http
  async function call(method, path, body) {
    var tok = cfg.token();
    var res = await fetch(cfg.api().replace(/\/$/, '') + path, {
      method: method,
      headers: Object.assign({ 'content-type': 'application/json' }, tok ? { authorization: 'Bearer ' + tok } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
    var j = null; try { j = await res.json(); } catch (e) { /* empty body */ }
    if (!res.ok) throw new Error((j && (Array.isArray(j.message) ? j.message.join('; ') : j.message)) || ('HTTP ' + res.status));
    return j;
  }
  var qs = function (o) { var p = Object.keys(o).filter(function (k) { return o[k] != null; }).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(o[k]); }); return p.length ? '?' + p.join('&') : ''; };

  // ------------------------------------------------------------------------------------------------ environment
  var ua = navigator.userAgent || '';
  var isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  function isStandalone() { try { return !!(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true; } catch (e) { return false; } }
  var IOS_MSG = 'On iPhone and iPad, add FORKSY to your Home Screen (Share > Add to Home Screen) and open it from there to turn on notifications.';
  function support() {
    if (!window.isSecureContext) return { ok: false, reason: 'insecure', message: 'Notifications need a secure (https) connection.' };
    if (isIOS && !isStandalone() && !('PushManager' in window)) return { ok: false, reason: 'ios-install', message: IOS_MSG };
    if (!('serviceWorker' in navigator)) return { ok: false, reason: 'no-service-worker', message: 'This browser does not support background notifications.' };
    if (!('PushManager' in window)) return { ok: false, reason: isIOS ? 'ios-install' : 'no-push', message: isIOS ? IOS_MSG : 'This browser does not support push notifications.' };
    if (!('Notification' in window)) return { ok: false, reason: 'no-notification', message: 'This browser does not support notifications.' };
    return { ok: true, reason: 'ok', message: '' };
  }
  function permission() { try { return 'Notification' in window ? Notification.permission : 'unsupported'; } catch (e) { return 'unsupported'; } }
  function safeUrl(u) { return typeof u === 'string' && u.charAt(0) === '/' && u.charAt(1) !== '/' && !/[\r\n\\]/.test(u) ? u : null; }
  function pageActive() { return document.visibilityState === 'visible' && (typeof document.hasFocus !== 'function' || document.hasFocus()); }

  // ------------------------------------------------------------------------------------------------ service worker
  var regP = null;
  function registerSW() {
    if (regP) return regP;
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return Promise.resolve(null);
    regP = navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(function () { return null; });
    return regP;
  }
  async function getReg() {
    var r = await registerSW();
    if (!r) return null;
    try { return await navigator.serviceWorker.ready; } catch (e) { return r; }
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', function (e) {
      var m = e.data;
      if (!m || typeof m !== 'object' || !m.fk) return;
      onWorkerMessage(m);
    });
  }

  // ------------------------------------------------------------------------------------------------ push
  function b64ToBytes(b64) {
    var pad = '='.repeat((4 - (b64.length % 4)) % 4);
    var raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  function sameKey(sub, bytes) {
    try {
      var cur = sub && sub.options && sub.options.applicationServerKey;
      if (!cur) return true;
      var a = new Uint8Array(cur);
      if (a.length !== bytes.length) return false;
      for (var i = 0; i < a.length; i++) if (a[i] !== bytes[i]) return false;
      return true;
    } catch (e) { return true; }
  }
  var pushConfig = null;
  async function getConfig(force) {
    if (pushConfig && !force) return pushConfig;
    try { pushConfig = await call('GET', '/notifications/push/config'); } catch (e) { pushConfig = { enabled: false, publicKey: null, failed: true }; }
    return pushConfig;
  }
  async function currentSub() { var r = await getReg(); return r ? r.pushManager.getSubscription() : null; }
  async function registerOnServer(sub) {
    var j = sub.toJSON();
    await call('POST', '/notifications/push/subscribe', { subscription: { endpoint: j.endpoint, expirationTime: j.expirationTime == null ? null : j.expirationTime, keys: { p256dh: j.keys.p256dh, auth: j.keys.auth } }, app: APP });
  }
  async function ensureSub(config) {
    var reg = await getReg();
    if (!reg) throw Object.assign(new Error('The notification service could not start.'), { code: 'failed' });
    var bytes = b64ToBytes(config.publicKey);
    var sub = await reg.pushManager.getSubscription();
    if (sub && !sameKey(sub, bytes)) { try { await sub.unsubscribe(); } catch (e) { /* ignore */ } sub = null; }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes });
    return sub;
  }

  /** Ask for the permission (only called from a click) and subscribe this browser. */
  async function pushEnable() {
    var sup = support();
    if (!sup.ok) throw Object.assign(new Error(sup.message), { code: 'unsupported' });
    var perm = permission();
    if (perm === 'denied') throw Object.assign(new Error('Notifications are blocked for this site. Allow them in the browser\'s site settings, then try again.'), { code: 'denied' });
    // the permission prompt comes first, straight from the click (Firefox and Safari need the gesture); the config was fetched earlier
    var ask = perm === 'default' ? Notification.requestPermission() : Promise.resolve(perm);
    var config = await getConfig(false);
    if (!config.enabled || !config.publicKey) config = await getConfig(true);
    perm = await ask;
    if (perm !== 'granted') throw Object.assign(new Error(perm === 'denied' ? 'Notifications are blocked for this site. Allow them in the browser\'s site settings, then try again.' : 'Notifications were not allowed.'), { code: 'denied' });
    if (!config.enabled || !config.publicKey) throw Object.assign(new Error('Push notifications are switched off by FORKSY right now.'), { code: 'disabled' });
    await registerSW();
    var sub = await ensureSub(config);
    await registerOnServer(sub);
    lsSet(optKey(), '1');
    return sub;
  }
  async function pushDisable() {
    var sub = await currentSub().catch(function () { return null; });
    if (sub) {
      await call('POST', '/notifications/push/unsubscribe', { endpoint: sub.endpoint }).catch(function () { /* already gone */ });
      await sub.unsubscribe().catch(function () { /* ignore */ });
    }
    lsDel(optKey());
  }
  /** Logout: this browser stops receiving this driver's notifications; the opt-in is kept for their next login. */
  async function pushTeardown() {
    try {
      var sub = await currentSub();
      if (sub) {
        await call('POST', '/notifications/push/unsubscribe', { endpoint: sub.endpoint }).catch(function () { /* ignore */ });
        await sub.unsubscribe().catch(function () { /* ignore */ });
      }
    } catch (e) { /* ignore */ }
  }
  /** After a login: silently repair the subscription of a driver who opted in. Never prompts. */
  async function pushSync() {
    try {
      var sup = support();
      if (!sup.ok) return;
      await registerSW();
      if (permission() !== 'granted' || !optedIn()) return;
      var config = await getConfig(true);
      if (!config.enabled || !config.publicKey) return;
      var sub = await ensureSub(config);
      var st = await call('GET', '/notifications/push/status' + qs({ endpoint: sub.endpoint })).catch(function () { return null; });
      if (!st || !st.subscribed) await registerOnServer(sub);
    } catch (e) { /* best effort */ }
  }

  async function renderPush() {
    var sup = support(), perm = permission();
    var on = $('btnPushOn'), off = $('btnPushOff'), test = $('btnPushTest'), msg = $('pushStatus');
    if (!on) return;
    on.classList.add('hide'); off.classList.add('hide'); test.classList.add('hide');
    if (!sup.ok) { msg.textContent = sup.message; return; }
    if (perm === 'denied') { msg.textContent = 'Notifications are blocked for this site. Allow them in the browser\'s site settings to turn them on.'; return; }
    var config = await getConfig(false);
    var sub = await currentSub().catch(function () { return null; });
    var status = null;
    if (sub && perm === 'granted') status = await call('GET', '/notifications/push/status' + qs({ endpoint: sub.endpoint })).catch(function () { return null; });
    var subscribed = !!(sub && perm === 'granted' && status && status.subscribed);
    if (subscribed) {
      msg.textContent = 'Notifications are ON for this device. New offers reach you even when this tab is closed.';
      off.classList.remove('hide'); test.classList.remove('hide');
    } else if (config.failed) {
      msg.textContent = 'Could not reach the server to check notifications.';
    } else if (!config.enabled) {
      msg.textContent = 'Push notifications are switched off by FORKSY right now.';
    } else {
      msg.textContent = 'Get new delivery offers even when this tab is in the background.';
      on.classList.remove('hide');
    }
    document.body.setAttribute('data-push', subscribed ? 'on' : 'off');
  }
  function pushNote(text, ok) { var e = $('pushMsg'); if (!e) return; e.textContent = text || ''; e.className = 'msg ' + (ok ? 'ok' : 'err') + (text ? '' : ' hide'); }

  // ------------------------------------------------------------------------------------------------ sound (Web Audio, no files)
  var Ctx = window.AudioContext || window.webkitAudioContext;
  var PATTERNS = { offer: { every: 2500, notes: [[1046, 0, 0.14, 'triangle'], [1318, 0.18, 0.14, 'triangle'], [1568, 0.36, 0.2, 'triangle']] }, chime: { every: 0, notes: [[988, 0, 0.18, 'sine'], [1318, 0.2, 0.3, 'sine']] } };
  var audio = { ctx: null, loop: null, volume: 0.8 };
  function actx() {
    if (!Ctx) return null;
    if (!audio.ctx) { try { audio.ctx = new Ctx(); audio.ctx.onstatechange = onSoundState; } catch (e) { audio.ctx = null; } }
    return audio.ctx;
  }
  function soundState() { if (!Ctx) return 'unsupported'; var c = actx(); if (!c) return 'unsupported'; return c.state === 'running' ? 'running' : 'blocked'; }
  async function unlockSound() {
    var c = actx();
    if (!c) return false;
    try {
      if (c.state !== 'running') await c.resume();
      var s = c.createBufferSource(); s.buffer = c.createBuffer(1, 1, 22050); s.connect(c.destination); s.start(0); // iOS Safari: a silent buffer unlocks it
    } catch (e) { /* still blocked */ }
    onSoundState();
    return c.state === 'running';
  }
  function playPattern(kind) {
    var c = actx(), p = PATTERNS[kind] || PATTERNS.chime;
    if (!c || c.state !== 'running') return false;
    var t0 = c.currentTime + 0.02, gain = audio.volume * 0.6;
    p.notes.forEach(function (n) {
      var o = c.createOscillator(), g = c.createGain();
      o.type = n[3]; o.frequency.value = n[0];
      g.gain.setValueAtTime(0.0001, t0 + n[1]);
      g.gain.exponentialRampToValueAtTime(gain, t0 + n[1] + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + n[1] + n[2]);
      o.connect(g); g.connect(c.destination);
      o.start(t0 + n[1]); o.stop(t0 + n[1] + n[2] + 0.05);
    });
    return true;
  }
  function startLoop(kind) {
    if (audio.loop && audio.loop.kind === kind) return;
    stopLoop();
    var p = PATTERNS[kind];
    playPattern(kind);
    audio.loop = { kind: kind, timer: p.every ? setInterval(function () { playPattern(kind); }, p.every) : null };
  }
  function stopLoop() { if (audio.loop) { if (audio.loop.timer) clearInterval(audio.loop.timer); audio.loop = null; } }
  // browsers refuse sound until the user touched the page: the first gesture unlocks the context
  (function armGestureUnlock() {
    var evs = ['pointerdown', 'keydown', 'touchstart', 'click'];
    function on() { unlockSound().then(function (ok) { if (ok) evs.forEach(function (e) { window.removeEventListener(e, on, true); }); }); }
    evs.forEach(function (e) { window.addEventListener(e, on, { capture: true, passive: true }); });
  })();
  function onSoundState() { syncRing(); renderSound(); }
  function renderSound() {
    var st = soundState(), ringing = !!current && !silenced;
    show('soundFix', !!current && st !== 'running');
    var s = $('soundState');
    if (s) s.textContent = st === 'running' ? 'Sound is on' : st === 'unsupported' ? 'This browser cannot play alert sounds' : 'Sound is blocked until you tap the page once';
    var oc = $('offerCard');
    if (oc) oc.setAttribute('data-ringing', ringing && audio.loop ? 'offer' : '');
  }

  // ------------------------------------------------------------------------------------------------ live offer alert
  var current = null;    // { id, orderId, code, restaurant, pickupKm, dropKm, pay, deadline, total }
  var silenced = false;
  var flash = { timer: null, on: false, base: document.title };
  var tick = null;

  function money(v) { var n = Number(v); return isFinite(n) ? '$' + n.toFixed(2) : '-'; }
  function km(v) { var n = Number(v); return isFinite(n) ? n.toFixed(1) + ' km' : '-'; }

  function offerFrom(p) {
    // p: a `driver.offer` socket payload, a notification's data, or GET /driver/offer/current
    var id = p.offerId || p.id;
    if (!id) return null;
    var total = Number(p.seconds);
    var left = null;
    if (p.secondsLeft != null && isFinite(Number(p.secondsLeft))) left = Number(p.secondsLeft);
    var exp = p.expiresAt ? Date.parse(p.expiresAt) : NaN;
    if (left == null && isFinite(exp)) left = (exp - Date.now()) / 1000;
    if (left == null && isFinite(total)) left = total;
    if (left == null) left = 30;
    // the client clock may differ from the server's: never trust a countdown longer than the offer window itself
    if (isFinite(total) && total > 0) left = Math.min(left, total + 2);
    var r = p.restaurant;
    return {
      id: String(id), orderId: p.orderId || null, code: p.code || '',
      restaurant: typeof r === 'string' ? r : (r && r.name) || '', pickupKm: p.pickupKm, dropKm: p.dropKm, pay: p.estimatedPay,
      deadline: Date.now() + Math.max(0, left) * 1000, total: isFinite(total) && total > 0 ? total : Math.max(1, Math.ceil(left)),
    };
  }

  function showOffer(o) {
    if (!o) return;
    if (current && current.id === o.id) {
      // same offer (socket + notification both arrive): only fill in details we did not have
      ['orderId', 'code', 'restaurant', 'pickupKm', 'dropKm', 'pay'].forEach(function (k) { if ((current[k] == null || current[k] === '') && o[k] != null && o[k] !== '') current[k] = o[k]; });
      renderOffer();
      return;
    }
    if (o.deadline <= Date.now()) return;
    current = o; silenced = false;
    setText('offerNote', '');
    renderOffer();
    startTick();
    startFlash();
    syncRing();
    renderSound();
  }
  function renderOffer() {
    var o = current;
    show('offerCard', !!o);
    if (!o) return;
    setText('offerRestaurant', o.restaurant || 'New delivery');
    setText('offerCode', o.code ? 'Order ' + o.code : '');
    setText('offerPickup', km(o.pickupKm));
    setText('offerDrop', km(o.dropKm));
    setText('offerPay', money(o.pay));
    $('offerCard').setAttribute('data-offer-id', o.id);
    renderCountdown();
  }
  function renderCountdown() {
    if (!current) return;
    var left = Math.max(0, Math.ceil((current.deadline - Date.now()) / 1000));
    setText('offerCountdown', left + 's');
    var bar = $('offerBar');
    if (bar) bar.style.width = Math.max(0, Math.min(100, ((current.deadline - Date.now()) / (current.total * 1000)) * 100)) + '%';
    if (left <= 0) endOffer('Offer expired. Stay online for the next one.');
  }
  function startTick() { if (!tick) tick = setInterval(renderCountdown, 250); }
  function endOffer(note, onlyId) {
    if (!current || (onlyId && current.id !== onlyId)) return;
    current = null; silenced = false;
    if (tick) { clearInterval(tick); tick = null; }
    stopLoop(); stopFlash();
    show('offerCard', false); show('soundFix', false);
    var oc = $('offerCard'); if (oc) { oc.setAttribute('data-ringing', ''); oc.classList.remove('hl'); }
    setText('offerNote', note || '');
    show('offerNote', !!note);
    renderSound();
  }
  function syncRing() {
    if (current && !silenced && soundState() === 'running') startLoop('offer'); else stopLoop();
  }
  // tab title: "(1) New offer | <page title>" alternating with the plain title once a second
  function startFlash() {
    if (flash.timer) return;
    flash.base = document.title.replace(/^\(\d+\)\s[^|]*\|\s/, '') || flash.base;
    var flip = function () { flash.on = !flash.on; document.title = flash.on && current ? '(1) New offer | ' + flash.base : flash.base; };
    flip();
    flash.timer = setInterval(flip, 1000);
  }
  function stopFlash() { if (flash.timer) { clearInterval(flash.timer); flash.timer = null; } flash.on = false; document.title = flash.base; }

  async function answerOffer(kind) {
    var o = current;
    if (!o) return;
    var btns = [$('offerAccept'), $('offerDecline')];
    btns.forEach(function (b) { b.disabled = true; });
    silenced = true; syncRing(); // answering the offer silences the ring straight away
    try {
      await call('POST', '/driver/offer/' + encodeURIComponent(o.id) + '/' + kind, kind === 'decline' ? {} : undefined);
      endOffer(kind === 'accept' ? 'Offer accepted. Your active trip is shown below.' : 'Offer declined.', o.id);
      if (kind === 'accept' && cfg.onOfferAccepted) cfg.onOfferAccepted(o);
    } catch (e) {
      // typically "offer expired / no longer available": it is over either way
      endOffer(e.message || 'The offer is no longer available.', o.id);
    } finally { btns.forEach(function (b) { b.disabled = false; }); }
  }

  async function highlightOffer(id) {
    if (!(current && current.id === id)) {
      try { var c = await call('GET', '/driver/offer/current'); if (c && c.id) showOffer(offerFrom(c)); } catch (e) { /* ignore */ }
    }
    var oc = $('offerCard');
    if (current && current.id === id && oc) {
      oc.classList.add('hl');
      if (oc.scrollIntoView) oc.scrollIntoView({ block: 'start', behavior: 'smooth' });
    } else {
      setText('offerNote', 'That offer is no longer available.'); show('offerNote', true);
    }
  }
  function offerIdFromUrl(u) { try { return new URL(u, location.origin).searchParams.get('offer'); } catch (e) { return null; } }

  // ------------------------------------------------------------------------------------------------ in-page notification list
  var items = [], unread = 0, seen = {};
  function ago(iso) {
    var t = Date.parse(iso); if (!isFinite(t)) return '';
    var s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s / 60) + ' min ago'; if (s < DAY / 1000) return Math.floor(s / 3600) + ' h ago';
    return new Date(t).toLocaleDateString();
  }
  function renderList() {
    var ul = $('notifList');
    if (!ul) return;
    ul.textContent = '';
    items.forEach(function (n) {
      var li = el('li', 'nitem' + (n.readAt ? '' : ' unread'));
      li.setAttribute('data-id', n.id);
      var top = el('div', 'ntop');
      top.appendChild(el('strong', null, n.title || 'Notification'));
      top.appendChild(el('span', 'muted', ago(n.createdAt)));
      li.appendChild(top);
      if (n.body) li.appendChild(el('div', 'nbody', n.body));
      li.addEventListener('click', function () { openItem(n); });
      ul.appendChild(li);
    });
    show('notifEmpty', items.length === 0);
    setText('notifUnread', String(unread));
    show('notifBadge', unread > 0);
    show('btnReadAll', unread > 0);
  }
  async function loadList() {
    try {
      var r = await call('GET', '/notifications' + qs({ limit: 20 }));
      items = (r.data || []).slice(0, 50);
      items.forEach(function (n) { seen[n.id] = 1; });
      unread = typeof r.unread === 'number' ? r.unread : items.filter(function (n) { return !n.readAt; }).length;
    } catch (e) { /* keep what we have */ }
    renderList();
  }
  var listTimer = null;
  function loadListSoon() { clearTimeout(listTimer); listTimer = setTimeout(loadList, 400); }
  function addIncoming(n) {
    if (!n || !n.id || seen[n.id]) return;
    seen[n.id] = 1;
    items = [{ id: n.id, title: n.title, body: n.body, event: n.event, data: n.data || null, url: n.url || null, readAt: null, createdAt: n.at || new Date().toISOString() }].concat(items).slice(0, 50);
    unread += 1;
    renderList();
  }
  async function markRead(id) {
    var it = items.filter(function (n) { return n.id === id; })[0];
    if (it && it.readAt) return;
    if (it) { it.readAt = new Date().toISOString(); unread = Math.max(0, unread - 1); renderList(); }
    try { var r = await call('POST', '/notifications/' + encodeURIComponent(id) + '/read', {}); if (r && typeof r.unread === 'number') { unread = r.unread; renderList(); } } catch (e) { /* next refresh corrects it */ }
  }
  async function markAll() {
    items.forEach(function (n) { if (!n.readAt) n.readAt = new Date().toISOString(); }); unread = 0; renderList();
    try { await call('POST', '/notifications/read-all', {}); } catch (e) { loadList(); }
  }
  function openItem(n) {
    markRead(n.id);
    var oid = (n.data && n.data.offerId) || offerIdFromUrl(n.url || '');
    if (oid && (n.event === 'driver.offer' || offerIdFromUrl(n.url || ''))) highlightOffer(String(oid));
  }

  // ------------------------------------------------------------------------------------------------ Socket.IO
  var sock = null;
  function socketOrigin() { return cfg.api().replace(/\/api\/v\d+\/?$/, '').replace(/\/$/, ''); }
  function connectSocket() {
    if (sock || typeof window.io !== 'function' || !cfg.token()) return;
    try {
      sock = window.io(socketOrigin(), { auth: function (cb) { cb({ token: cfg.token() }); }, transports: ['websocket', 'polling'], reconnectionDelayMax: 10000 });
    } catch (e) { sock = null; return; }
    sock.on('connect', function () { setText('liveState', 'Live'); document.body.setAttribute('data-live', '1'); loadList(); });
    sock.on('disconnect', function () { setText('liveState', 'Reconnecting...'); document.body.removeAttribute('data-live'); });
    sock.on('connect_error', function () { setText('liveState', 'Reconnecting...'); });
    sock.on('notification', onNotification);
    sock.on('driver.offer', function (p) { if (p) showOffer(offerFrom(p)); });
    sock.on('driver.offer.cancelled', function (p) { if (p && p.offerId) endOffer(p.reason === 'expired' ? 'Offer expired. Stay online for the next one.' : 'The offer is no longer available.', String(p.offerId)); });
    ['order.assigned', 'order.unassigned', 'order.status'].forEach(function (ev) { sock.on(ev, function () { if (cfg.onTripChange) cfg.onTripChange(ev); }); });
  }
  function closeSocket() { if (sock) { try { sock.off(); sock.disconnect(); } catch (e) { /* ignore */ } sock = null; } setText('liveState', 'Offline'); document.body.removeAttribute('data-live'); }

  function onNotification(n) {
    if (!n) return;
    addIncoming(n);
    var d = n.data || {};
    if (n.event === 'driver.offer' && d.offerId) showOffer(offerFrom(Object.assign({}, d, { id: d.offerId })));
    else if ((n.event === 'driver.offer_expired' || n.event === 'driver.offer_cancelled') && d.offerId) endOffer(n.event === 'driver.offer_expired' ? 'Offer expired. Stay online for the next one.' : 'The offer is no longer available.', String(d.offerId));
    // a short chime for everything else, only while this page is in front (the service worker shows the OS notification otherwise)
    else if (pageActive() && n.event !== 'notification.test') playPattern('chime');
  }

  function onWorkerMessage(m) {
    if (m.type === 'push') loadListSoon();
    else if (m.type === 'notification-click') {
      if (m.id) markRead(m.id);
      var oid = offerIdFromUrl(m.url || '');
      if (oid) highlightOffer(oid);
      loadListSoon();
    } else if (m.type === 'subscription-change') pushSync().then(renderPush);
  }

  // ------------------------------------------------------------------------------------------------ lifecycle
  function wire() {
    if (!$('notifyCard')) return;
    $('btnPushOn').addEventListener('click', async function () {
      var b = this; b.disabled = true; pushNote('');
      try { await pushEnable(); pushNote('Notifications are on for this device.', true); }
      catch (e) { pushNote(e.message || 'Could not turn notifications on.', false); }
      finally { b.disabled = false; await renderPush(); }
    });
    $('btnPushOff').addEventListener('click', async function () {
      var b = this; b.disabled = true; pushNote('');
      try { await pushDisable(); pushNote('Notifications are off for this device.', true); }
      catch (e) { pushNote(e.message || 'Could not turn notifications off.', false); }
      finally { b.disabled = false; await renderPush(); }
    });
    $('btnPushTest').addEventListener('click', async function () {
      var b = this; b.disabled = true; pushNote('');
      try {
        var r = await call('POST', '/notifications/push/test', {});
        pushNote(r && r.ok ? 'Test sent. With this tab in front it appears in the list below; with the tab in the background it shows as a system notification.' : 'The test was created, but the push could not be delivered to this device (it shows in the list below).', !!(r && r.ok));
      } catch (e) { pushNote(e.message || 'Could not send the test.', false); }
      finally { b.disabled = false; }
    });
    $('btnReadAll').addEventListener('click', markAll);
    $('offerAccept').addEventListener('click', function () { answerOffer('accept'); });
    $('offerDecline').addEventListener('click', function () { answerOffer('decline'); });
    $('offerSilence').addEventListener('click', function () { silenced = true; syncRing(); renderSound(); });
    $('soundFix').addEventListener('click', function () { unlockSound().then(function () { syncRing(); renderSound(); }); });
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && user) loadListSoon(); });
  }

  var started = false;
  window.FkNotify = {
    init: function (c) { Object.assign(cfg, c || {}); },
    /** after a login */
    start: async function (u) {
      user = u && u.id ? { id: u.id } : { id: 'anon' };
      started = true;
      show('notifyCard', true);
      renderList(); renderSound();
      connectSocket();
      loadList();
      await getConfig(true);
      await pushSync();
      renderPush();
      // an offer that is already pending (page opened late / from a push) and a `?offer=<id>` deep link
      try { var c = await call('GET', '/driver/offer/current'); if (c && c.id) showOffer(offerFrom(c)); } catch (e) { /* none */ }
      var deep = offerIdFromUrl(location.href);
      if (deep) highlightOffer(deep);
      try {
        var m = /[#&]fk-n=([^&]+)/.exec(location.hash || '');
        if (m) { markRead(decodeURIComponent(m[1])); history.replaceState(history.state, '', location.pathname + location.search); }
      } catch (e) { /* ignore */ }
    },
    /** before a logout: the token must still be valid to unsubscribe on the server */
    stop: async function () {
      if (!started) return;
      started = false;
      await pushTeardown();
      closeSocket();
      endOffer('');
      items = []; unread = 0; seen = {}; user = null;
      renderList(); show('notifyCard', false); pushNote('');
    },
    /** for tests */
    state: function () { return { ringing: audio.loop ? audio.loop.kind : null, offer: current ? current.id : null, sound: soundState(), silenced: silenced, unread: unread, live: !!(sock && sock.connected), optedIn: optedIn() }; },
  };

  // register the worker on load (never prompts) and learn whether push is available
  function boot() { wire(); registerSW(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
