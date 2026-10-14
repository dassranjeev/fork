(function () {
  'use strict';
  // Everything from the API is untrusted: only textContent / value is used, never innerHTML.
  var $ = function (id) { return document.getElementById(id); };
  var show = function (id, on) { $(id).classList.toggle('hide', !on); };
  var state = { token: null, trip: null, action: null, loc: null, photoFile: null };

  function base() { return $('api').value.replace(/\/$/, ''); }
  async function api(method, path, body) {
    var res = await fetch(base() + path, { method: method, headers: Object.assign({ 'content-type': 'application/json' }, state.token ? { authorization: 'Bearer ' + state.token } : {}), body: body ? JSON.stringify(body) : undefined });
    var j = null; try { j = await res.json(); } catch (e) { /* empty body */ }
    if (!res.ok) throw new Error((j && (Array.isArray(j.message) ? j.message.join('; ') : j.message)) || ('HTTP ' + res.status));
    return j;
  }
  function say(text, ok) { var el = $('result'); el.textContent = text; el.className = 'msg ' + (ok ? 'ok' : 'err'); }
  function kv(dl, rows) {
    dl.textContent = '';
    rows.forEach(function (r) { var dt = document.createElement('dt'); dt.textContent = r[0]; var dd = document.createElement('dd'); dd.textContent = r[1] == null ? '-' : String(r[1]); dl.appendChild(dt); dl.appendChild(dd); });
  }

  // ---- 4 PIN boxes
  var boxes = [];
  (function buildBoxes() {
    var wrap = $('pinBoxes');
    for (var i = 0; i < 4; i++) {
      (function (i) {
        var b = document.createElement('input');
        b.type = 'text'; b.inputMode = 'numeric'; b.maxLength = 1; b.autocomplete = 'off'; b.setAttribute('aria-label', 'PIN digit ' + (i + 1));
        b.addEventListener('input', function () { b.value = b.value.replace(/\D/g, '').slice(0, 1); if (b.value && boxes[i + 1]) boxes[i + 1].focus(); });
        b.addEventListener('keydown', function (e) { if (e.key === 'Backspace' && !b.value && boxes[i - 1]) boxes[i - 1].focus(); });
        b.addEventListener('paste', function (e) {
          var t = ((e.clipboardData && e.clipboardData.getData('text')) || '').replace(/\D/g, '').slice(0, 4);
          if (!t) return; e.preventDefault(); boxes.forEach(function (x, k) { x.value = t[k] || ''; }); (boxes[Math.min(t.length, 3)] || b).focus();
        });
        boxes.push(b); wrap.appendChild(b);
      })(i);
    }
  })();
  var pinValue = function () { return boxes.map(function (b) { return b.value; }).join(''); };

  // ---- verification: until the driver is verified the app tells them what to do next (the sentence comes from the API)
  async function loadVerification() {
    try {
      var p = await api('GET', '/driver/profile');
      var v = p && p.verification;
      var text = v && v.status !== 'VERIFIED' && v.nextStep ? v.nextStep : '';
      $('verify').textContent = text;
      show('verify', !!text);
    } catch (e) { show('verify', false); /* the hint is optional */ }
  }

  // ---- login / trip
  $('btnLogin').onclick = async function () {
    try {
      var r = await api('POST', '/auth/login', { identifier: $('email').value, password: $('password').value, app: 'driver' });
      state.token = r.accessToken; state.refresh = r.refreshToken; $('who').textContent = 'Logged in as ' + ((r.user && (r.user.firstName || r.user.email)) || $('email').value);
      show('btnOnline', true); show('btnLogout', true); show('btnLogin', false);
      if (window.FkNotify) window.FkNotify.start(r.user || {}).catch(function () { /* notifications are optional */ });
      loadVerification();
      await loadTrip();
    } catch (e) { $('who').textContent = e.message; }
  };
  $('btnOnline').onclick = async function () {
    var b = this; b.disabled = true;
    try {
      var online = b.textContent === 'Go offline';
      if (online) await api('POST', '/driver/offline'); else await api('POST', '/driver/online', {});
      b.textContent = online ? 'Go online' : 'Go offline'; b.classList.toggle('on', !online);
    } catch (e) { $('who').textContent = e.message; } finally { b.disabled = false; }
  };
  // log out: this browser stops receiving this driver's pushes first (needs the token), then the session is closed
  $('btnLogout').onclick = async function () {
    this.disabled = true;
    try { if (window.FkNotify) await window.FkNotify.stop(); } catch (e) { /* ignore */ }
    try { if (state.refresh) await api('POST', '/auth/logout', { refreshToken: state.refresh }); } catch (e) { /* the token may already be expired */ }
    state.token = null; state.refresh = null; state.trip = null;
    show('tripCard', false); show('deliverCard', false); show('btnOnline', false); show('btnLogout', false); show('btnLogin', true); show('verify', false);
    $('btnOnline').textContent = 'Go online'; $('btnOnline').classList.remove('on'); this.disabled = false;
    $('who').textContent = 'Logged out.';
  };
  if (window.FkNotify) window.FkNotify.init({
    api: base, token: function () { return state.token; },
    onOfferAccepted: function () { loadTrip().catch(function () { /* shown on refresh */ }); },
    onTripChange: function () { if (state.token) loadTrip().catch(function () { /* ignore */ }); },
  });
  $('btnReload').onclick = function () { loadTrip().catch(function (e) { say(e.message, false); }); };

  async function loadTrip() {
    var t = await api('GET', '/driver/trip/active');
    state.trip = t && t.id ? t : null;
    show('tripCard', true);
    if (!state.trip) { kv($('tripInfo'), [['Trip', 'No active trip. Accept an offer and pick the order up first.']]); show('deliverCard', false); return; }
    var d = state.trip.dropoff || {}, a = state.trip.deliveryAddress;
    kv($('tripInfo'), [['Order', state.trip.code], ['Status', state.trip.status], ['Handoff', d.method], ['Address', a ? (a.line1 + ', ' + a.city) : 'shown after pickup'], ['Instructions', d.notes], ['Proof', d.proofLabel]]);
    var ready = ['PICKED_UP', 'ON_THE_WAY'].indexOf(state.trip.status) >= 0;
    show('deliverCard', ready);
    if (ready) renderDeliver();
  }

  $('btnArrived').onclick = async function () {
    try { var l = await getLoc(); await api('POST', '/driver/trip/' + state.trip.id + '/arrived-customer', { lat: l.lat, lng: l.lng }); say('Marked as arrived. The customer was notified.', true); show('result', true); await loadTrip(); }
    catch (e) { show('deliverCard', true); say(e.message, false); show('result', true); }
  };

  // ---- the delivery form, driven by the server's rule for this order
  function renderDeliver() {
    var d = state.trip.dropoff || {}, pin = d.pinInput && d.pinInput.required, actions = d.deliveryActions, photo = !!d.photoRequired;
    state.action = null; boxes.forEach(function (b) { b.value = ''; });
    $('rule').textContent = d.proofLabel || '';
    show('pinBox', !!pin); show('choiceBox', !pin && !!actions && actions.length > 0);
    $('optHanded').classList.remove('on'); $('optLeft').classList.remove('on');
    if (!pin && actions && actions.length) { state.action = null; photo = false; }
    applyPhoto(photo, true);
    show('result', false);
  }
  function applyPhoto(on, compulsory) {
    show('photoBox', on);
    $('photoLabel').textContent = compulsory ? 'Photo of the delivered order (compulsory)' : 'Photo (optional)';
  }
  $('optHanded').onclick = function () { state.action = 'HANDED_TO_CUSTOMER'; this.classList.add('on'); $('optLeft').classList.remove('on'); applyPhoto(true, false); };
  $('optLeft').onclick = function () { state.action = 'LEFT_AT_LOCATION'; this.classList.add('on'); $('optHanded').classList.remove('on'); applyPhoto(true, true); };
  $('photo').onchange = function () {
    state.photoFile = this.files && this.files[0] || null;
    var img = $('preview'); if (state.photoFile) { img.src = URL.createObjectURL(state.photoFile); img.classList.remove('hide'); } else img.classList.add('hide');
  };

  // ---- location
  function setLoc(l, label) { state.loc = l; $('loc').textContent = label + ': ' + l.lat.toFixed(5) + ', ' + l.lng.toFixed(5) + (l.accuracy != null ? ' (+/- ' + Math.round(l.accuracy) + ' m)' : ''); }
  function getLoc() {
    return new Promise(function (resolve, reject) {
      if (state.loc) return resolve(state.loc);
      if (!navigator.geolocation) return reject(new Error('No GPS available - use the drop-off point button for testing'));
      navigator.geolocation.getCurrentPosition(function (p) { var l = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }; setLoc(l, 'GPS'); resolve(l); }, function () { reject(new Error('Could not read your GPS - allow location, or use the drop-off point button for testing')); }, { enableHighAccuracy: true, timeout: 10000 });
    });
  }
  $('btnGps').onclick = function () { state.loc = null; getLoc().catch(function (e) { say(e.message, false); show('result', true); }); };
  $('btnDrop').onclick = async function () {
    var a = state.trip && state.trip.deliveryAddress;
    if (!a || a.lat == null) { say('Drop-off coordinates are not available yet (shown after pickup).', false); show('result', true); return; }
    var l = { lat: Number(a.lat), lng: Number(a.lng), accuracy: 8 }; setLoc(l, 'Drop-off point (testing)');
    try { await api('POST', '/driver/location', { lat: l.lat, lng: l.lng }); } catch (e) { /* not fatal */ }
  };

  // ---- complete
  async function uploadPhoto(file) {
    var fd = new FormData(); fd.append('file', file);
    var res = await fetch(base() + '/uploads', { method: 'POST', headers: { authorization: 'Bearer ' + state.token }, body: fd });
    var j = null; try { j = await res.json(); } catch (e) { /* ignore */ }
    if (res.status === 404) { res = await fetch(base().replace(/\/api\/v1$/, '') + '/uploads', { method: 'POST', headers: { authorization: 'Bearer ' + state.token }, body: fd }); try { j = await res.json(); } catch (e) { /* ignore */ } }
    if (!res.ok) throw new Error((j && j.message) || 'Photo upload failed');
    return j.url;
  }
  $('btnDeliver').onclick = async function () {
    var btn = this; btn.disabled = true; show('result', true);
    try {
      var d = state.trip.dropoff || {}, pin = d.pinInput && d.pinInput.required, actions = d.deliveryActions;
      var l = await getLoc();
      var body = { lat: l.lat, lng: l.lng };
      if (pin) {
        var p = pinValue(); if (!/^\d{4}$/.test(p)) throw new Error('Enter all 4 digits of the customer PIN');
        body.pin = p;
      } else {
        if (actions && actions.length) { if (!state.action) throw new Error('Choose: handed to the customer, or delivered (left at the location)'); body.deliveryAction = state.action; }
        var photoCompulsory = d.photoRequired && (!actions || state.action === 'LEFT_AT_LOCATION');
        if (state.photoFile) {
          if (!state.photoFile.type.match(/^image\/(jpeg|png)$/)) throw new Error('Use a JPEG or PNG photo');
          body.proofPhotoUrl = await uploadPhoto(state.photoFile); body.accuracy = l.accuracy == null ? 10 : l.accuracy; body.capturedAt = new Date().toISOString();
        } else if (photoCompulsory) throw new Error('Take a photo of the delivered order and upload it to complete the delivery');
      }
      var r = await api('POST', '/driver/trip/' + state.trip.id + '/delivered', body);
      say('Delivery completed (' + ((r && r.status) || 'DELIVERED') + ').', true);
      await loadTrip();
    } catch (e) { say(e.message, false); } finally { btn.disabled = false; }
  };
})();
