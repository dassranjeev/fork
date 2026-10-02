/* Clickjacking fallback for hosts that cannot send X-Frame-Options / CSP frame-ancestors (a <meta> CSP cannot set
 * frame-ancestors). Real protection is the response header, see docs/security-frontend.md. Loaded as an external
 * script so the CSP can stay free of 'unsafe-inline' for scripts. */
(function () {
  try {
    if (window.top !== window.self) {
      document.documentElement.style.display = "none";
      window.top.location = window.self.location;
    }
  } catch (e) {
    document.documentElement.style.display = "none";
  }
})();
