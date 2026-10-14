(function () {
  'use strict';
  // loads the widget exactly like a merchant would paste it; the bot key comes from ?key= so no secret is in this file
  var q = new URLSearchParams(window.location.search);
  var key = q.get('key') || '';
  var mode = q.get('mode');
  var status = document.getElementById('status');
  if (!key && mode !== 'site') return;
  var s = document.createElement('script');
  s.src = 'http://localhost:4000/assistant/widget.js';
  s.async = true;
  if (key) s.setAttribute('data-key', key);
  if (mode === 'site') {
    s.setAttribute('data-mode', 'site');
    if (q.get('restaurant')) s.setAttribute('data-restaurant', q.get('restaurant'));
  }
  if (q.get('position') === 'left') s.setAttribute('data-position', 'left');
  s.addEventListener('load', function () { status.textContent = 'Widget script loaded (version ' + (window.ForkyAssistant ? window.ForkyAssistant.version : '?') + ').'; });
  s.addEventListener('error', function () { status.textContent = 'Could not load the widget script from http://localhost:4000.'; });
  document.body.appendChild(s);
})();
