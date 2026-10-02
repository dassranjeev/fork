(function () {
  'use strict';
  // Every value coming from the API/socket is untrusted: build HTML only through esc(), prefer textContent.
  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };
  function esc(v) { return String(v === null || v === undefined ? '' : v).replace(/[&<>"'`]/g, function (c) { return ESC[c]; }); }
  function safeSrc(u) { u = String(u || ""); return /^(https?:\/\/|\/(?![/\\]))/i.test(u) ? u : ""; }
  var $ = function (id) { return document.getElementById(id); };
  var state = { token: null, app: 'customer', userId: null, socket: null, session: null, messages: [], seen: {}, rating: 0, startFile: null };

  // ---------------------------------------------------------------- helpers
  function log(kind, text, data) {
    var el = $('log'); var d = document.createElement('div'); d.className = kind;
    d.textContent = new Date().toLocaleTimeString() + ' ' + text + (data !== undefined ? ' ' + JSON.stringify(data) : '');
    el.appendChild(d); el.scrollTop = el.scrollHeight;
  }
  function base() { return $('api').value.replace(/\/$/, ''); }
  function root() { return base().replace(/\/api\/v1$/, ''); }
  function prefix() { return '/' + state.app + '/support/chat'; }
  async function api(method, path, body) {
    var res = await fetch(base() + path, { method: method, headers: Object.assign({ 'content-type': 'application/json' }, state.token ? { authorization: 'Bearer ' + state.token } : {}), body: body ? JSON.stringify(body) : undefined });
    var j = null; try { j = await res.json(); } catch (e) {}
    log(res.ok ? 'out' : 'err', method + ' ' + path + ' -> ' + res.status, path.indexOf('/auth/') >= 0 ? undefined : (j && Object.keys(j).slice(0, 8)));
    if (!res.ok) throw new Error((j && j.message) || ('HTTP ' + res.status));
    return j;
  }
  async function upload(file) {
    var fd = new FormData(); fd.append('file', file);
    var urls = [base() + '/uploads', root() + '/uploads'];
    for (var i = 0; i < urls.length; i++) {
      var r = await fetch(urls[i], { method: 'POST', headers: { authorization: 'Bearer ' + state.token }, body: fd });
      if (r.status !== 404) { var j = await r.json(); if (!r.ok) throw new Error(j.message || 'upload failed'); log('out', 'POST uploads -> ' + r.status); return j.url; }
    }
    throw new Error('upload endpoint not found');
  }
  var show = function (id, on) { $(id).classList.toggle('hide', !on); };

  // ---------------------------------------------------------------- login
  $('app').onchange = function () { $('email').value = this.value === 'driver' ? 'driver1@demo.forksy.ca' : 'customer1@demo.forksy.ca'; };
  $('btnLogin').onclick = async function () {
    try {
      state.app = $('app').value;
      var r = await api('POST', '/auth/login', { identifier: $('email').value, password: $('password').value, app: state.app });
      state.token = r.accessToken; state.userId = r.user && r.user.id;
      $('who').textContent = 'Logged in as ' + ((r.user && (r.user.firstName || r.user.email)) || $('email').value);
      show('startCard', true); connect(); await loadAvailability(); await resumeActive();
    } catch (e) { alert(e.message); }
  };

  // ---------------------------------------------------------------- socket
  function connect() {
    if (state.socket) state.socket.close();
    var s = io(root(), { auth: { token: state.token }, transports: ['websocket', 'polling'] });
    state.socket = s;
    s.on('connect', function () { $('sock').textContent = 'socket: connected'; log('in', 'socket connect'); if (state.session) resumeActive(true); });
    s.on('disconnect', function () { $('sock').textContent = 'socket: disconnected'; });
    s.onAny(function (ev, p) { log('in', 'EVENT ' + ev, p); });
    // payloads are documented in docs/api/live-chat.md
    s.on('chat.queued', function (p) { setSession(p.session); });
    s.on('chat.queue_position', function (p) { if (state.session && state.session.id === p.sessionId) { state.session.queue = p; render(); } });
    s.on('chat.accepted', function (p) { if (!mine(p)) return; state.session.status = 'ACTIVE'; state.session.agent = p.agent; state.session.queue = null; render(); api('POST', prefix() + '/' + p.sessionId + '/read', {}).catch(function () {}); });
    s.on('chat.message', function (p) { if (!mine(p)) return; addMessage(p.message); if (p.message.senderType !== state.app.toUpperCase()) api('POST', prefix() + '/' + p.sessionId + '/read', {}).catch(function () {}); });
    s.on('chat.typing', function (p) { if (!mine(p)) return; $('typing').textContent = p.typing ? ((state.session.agent && state.session.agent.firstName) || 'Agent') + ' is typing...' : ''; clearTimeout(state.tt); state.tt = setTimeout(function () { $('typing').textContent = ''; }, 4000); });
    s.on('chat.read', function (p) { if (!mine(p)) return; state.messages.forEach(function (m) { if (m.senderType === state.app.toUpperCase() && !m.readAt) m.readAt = p.at; }); render(); });
    s.on('chat.transferred', function (p) { if (!mine(p)) return; if (p.agent) state.session.agent = p.agent; if (p.status) state.session.status = p.status; if (p.queue) state.session.queue = p.queue; render(); });
    s.on('chat.ended', function (p) { if (!mine(p)) return; state.session.status = p.status; state.session.canRate = p.canRate; state.session.endedBy = p.endedBy; state.session.endReason = p.reason; state.session.convertedToTicket = p.convertedToTicket; state.session.ticketNumber = p.ticketNumber || state.session.ticketNumber; render(); });
    s.on('chat.converted', function (p) { if (!mine(p)) return; state.session.status = 'MISSED'; state.session.ticketNumber = p.ticketNumber; render(); });
  }
  function mine(p) { return state.session && p.sessionId === state.session.id; }

  // ---------------------------------------------------------------- availability / orders
  async function loadAvailability() {
    var a = await api('GET', prefix() + '/availability');
    $('avail').innerHTML = a.available ? '<span class="pill ACTIVE">agents available: ' + esc(a.agentsOnline) + '</span> est. wait ~' + esc(Math.round(a.estimatedWaitSec / 60)) + ' min' : '<span class="pill MISSED">offline (' + esc(a.reason) + ')</span> your message will become a support ticket';
    $('topic').innerHTML = a.topics.map(function (t) { return '<option value="' + esc(t.code) + '">' + esc(t.label) + '</option>'; }).join('');
  }
  $('btnOrders').onclick = async function () {
    try {
      var r = await api('GET', state.app === 'customer' ? '/customer/orders?limit=10' : '/driver/trips?limit=10');
      var rows = r.data || r.trips || r.items || (Array.isArray(r) ? r : []);
      $('orderSel').innerHTML = '<option value="">No order</option>' + rows.map(function (o) { var id = o.orderId || (o.order && o.order.id) || o.id; var code = o.code || o.orderCode || (o.order && o.order.code) || id.slice(0, 8); return '<option value="' + esc(id) + '">' + esc(code) + ' - ' + esc(o.status || (o.order && o.order.status) || '') + '</option>'; }).join('');
    } catch (e) { alert(e.message); }
  };
  $('orderSel').onchange = function () { $('orderId').value = this.value; };
  $('startFile').onchange = function () { state.startFile = this.files[0] || null; $('startFileName').textContent = state.startFile ? state.startFile.name : ''; };

  // ---------------------------------------------------------------- start / resume
  $('btnStart').onclick = async function () {
    try {
      var body = { topic: $('topic').value, message: $('firstMsg').value };
      if ($('orderId').value.trim()) body.orderId = $('orderId').value.trim();
      if (state.startFile) body.attachments = [await upload(state.startFile)];
      var r = await api('POST', prefix() + '/start', body);
      state.messages = []; state.seen = {};
      if (r.mode === 'ticket') {
        setSession(r.session);
        state.offline = { ticketNumber: r.ticketNumber, reason: r.reason, message: r.message, appended: r.appended };
        var m = await api('GET', prefix() + '/' + r.session.id + '/messages'); state.messages = []; m.messages.forEach(addMessage);
      } else {
        state.offline = null; setSession(r.session); r.messages.forEach(addMessage);
      }
      show('startCard', false); show('chatCard', true); render();
    } catch (e) { alert(e.message); }
  };
  async function resumeActive(refetchOnly) {
    var r = await api('GET', prefix() + '/active');
    if (r.session) {
      if (!refetchOnly) { state.messages = []; state.seen = {}; }
      setSession(r.session);
      var m = await api('GET', prefix() + '/' + r.session.id + '/messages'); m.messages.forEach(addMessage);
      show('startCard', false); show('chatCard', true); render();
    }
  }
  function setSession(s) { state.session = s; show('chatCard', true); show('startCard', false); render(); }
  function addMessage(m) {
    var key = m.id || (m.senderType + m.body + m.createdAt);
    if (state.seen[key]) return; state.seen[key] = 1; state.messages.push(m); render();
  }

  // ---------------------------------------------------------------- render
  function render() {
    var s = state.session; if (!s) return;
    $('stPill').textContent = s.status; $('stPill').className = 'pill ' + s.status;
    var b = '';
    if (s.status === 'MISSED' && (state.offline || s.convertedToTicket)) {
      var num = (state.offline && state.offline.ticketNumber) || s.ticketNumber;
      b = '<div class="banner off"><b>Our team is offline right now.</b><br>We created support ticket <b>' + esc(num) + '</b> from your message' + (state.offline && state.offline.appended ? ' (added to your open ticket)' : '') + '. We will reply by notification and email. You can keep writing here: new messages are added to the same ticket.</div>';
    } else if (s.status === 'WAITING') {
      b = '<div class="banner q">In the queue' + (s.queue ? ': position <b>' + esc(s.queue.position) + '</b>, about ' + esc(Math.max(1, Math.round(s.queue.estimatedWaitSec / 60))) + ' min' : '') + '. Hang on, an agent will join shortly.</div>';
    } else if (s.status === 'ACTIVE') {
      b = '<div class="banner ok">Chatting with <b>' + esc((s.agent && s.agent.firstName) || 'an agent') + '</b> from FORKSY Support</div>';
    } else if (s.status === 'ENDED') {
      b = '<div class="banner">Chat ended' + (s.endedBy ? ' by ' + esc(String(s.endedBy).toLowerCase()) : '') + '. The transcript stays on ticket ' + esc(s.ticketNumber || '') + '.</div>';
    }
    $('banner').innerHTML = b;
    var t = $('thread'); t.innerHTML = '';
    var me = state.app.toUpperCase();
    state.messages.forEach(function (m) {
      var d = document.createElement('div'); var sys = m.senderType === 'SYSTEM';
      d.className = 'msg ' + (sys ? 'system' : m.senderType === me ? 'me' : '');
      var txt = document.createElement('div'); txt.textContent = m.body; d.appendChild(txt);
      (m.attachments || []).forEach(function (u) { var i = document.createElement('img'); i.src = safeSrc(u); i.referrerPolicy = 'no-referrer'; d.appendChild(i); });
      if (!sys) { var sm = document.createElement('small'); sm.textContent = (m.senderType === 'AGENT' ? (m.senderName || 'Agent') : 'You') + ' - ' + new Date(m.createdAt).toLocaleTimeString() + (m.senderType === me ? (m.readAt ? ' - read' : ' - sent') : ''); d.appendChild(sm); }
      t.appendChild(d);
    });
    t.scrollTop = t.scrollHeight;
    var open = s.status === 'WAITING' || s.status === 'ACTIVE';
    var canWrite = open || s.status === 'MISSED';
    $('btnSend').disabled = !canWrite; $('msg').disabled = !canWrite; $('file').disabled = !canWrite;
    show('btnEnd', open); show('btnNew', !open);
    show('rateBox', s.status === 'ENDED' && !!s.canRate && !s.rating);
  }

  // ---------------------------------------------------------------- send / typing / read / end / rate
  var pendingFile = null;
  $('file').onchange = function () { pendingFile = this.files[0] || null; $('pending').textContent = pendingFile ? 'Attached: ' + pendingFile.name : ''; };
  async function send() {
    var s = state.session; var body = $('msg').value.trim(); if (!s || (!body && !pendingFile)) return;
    try {
      var p = { body: body };
      if (pendingFile) p.attachments = [await upload(pendingFile)];
      var m = await api('POST', prefix() + '/' + s.id + '/messages', p);
      $('msg').value = ''; pendingFile = null; $('file').value = ''; $('pending').textContent = '';
      addMessage(m);
    } catch (e) { alert(e.message); }
  }
  $('btnSend').onclick = send;
  $('msg').onkeydown = function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };
  var lastTyping = 0;
  $('msg').oninput = function () {
    var s = state.session; if (!s || Date.now() - lastTyping < 2500) return; lastTyping = Date.now();
    // either REST ... or the socket event: state.socket.emit('chat.typing', { sessionId: s.id, typing: true })
    if (state.socket && state.socket.connected) state.socket.emit('chat.typing', { sessionId: s.id, typing: true });
    else api('POST', prefix() + '/' + s.id + '/typing', { typing: true }).catch(function () {});
  };
  $('btnEnd').onclick = async function () { try { var v = await api('POST', prefix() + '/' + state.session.id + '/end', {}); Object.assign(state.session, v); render(); } catch (e) { alert(e.message); } };
  $('btnNew').onclick = async function () { state.session = null; state.messages = []; state.seen = {}; state.offline = null; show('chatCard', false); show('startCard', true); await loadAvailability(); };
  Array.prototype.forEach.call(document.querySelectorAll('#stars button'), function (b) { b.onclick = function () { state.rating = Number(b.dataset.v); Array.prototype.forEach.call(document.querySelectorAll('#stars button'), function (x) { x.classList.toggle('on', Number(x.dataset.v) <= state.rating); }); }; });
  $('btnRate').onclick = async function () {
    if (!state.rating) return alert('Pick 1-5 stars');
    try { var v = await api('POST', prefix() + '/' + state.session.id + '/rate', { rating: state.rating, feedback: $('feedback').value }); Object.assign(state.session, v); $('rateDone').textContent = 'Thanks! Rated ' + v.rating + '/5'; render(); show('rateBox', true); } catch (e) { alert(e.message); }
  };
  $('btnClear').onclick = function () { $('log').innerHTML = ''; };
})();
