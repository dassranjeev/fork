/**
 * Alert sounds with the Web Audio API (no audio files). Browsers refuse to play sound before the user has interacted with the page
 * (autoplay policy), so the AudioContext starts "suspended". `unlock()` is wired to the first pointer / key / touch gesture and the
 * state is exposed so the UI can show "Sound is blocked - click to enable":
 *
 *   sound.state()      -> "running" (can ring) | "blocked" (needs a click) | "unsupported"
 *   sound.subscribe(f) -> called when the state / volume changes
 *   sound.unlock()     -> resume the context (call from any click)
 *   sound.setVolume(0..100) / sound.setEnabled(bool)
 *   sound.play(kind)   -> one pattern now ("order" | "cancel" | "offer" | "chime" | "test")
 *   sound.startLoop(kind) / sound.stopLoop() -> repeat the pattern until stopped
 */
const PATTERNS = {
  // [frequency Hz, start s, duration s, wave]
  order: { every: 4200, notes: [[880, 0, 0.22, "sine"], [1175, 0.26, 0.22, "sine"], [1568, 0.52, 0.34, "sine"], [880, 1.0, 0.22, "sine"], [1175, 1.26, 0.22, "sine"], [1568, 1.52, 0.34, "sine"]] },
  cancel: { every: 3200, notes: [[520, 0, 0.28, "square"], [390, 0.34, 0.28, "square"], [520, 0.68, 0.28, "square"], [390, 1.02, 0.28, "square"]] },
  offer: { every: 2500, notes: [[1046, 0, 0.14, "triangle"], [1318, 0.18, 0.14, "triangle"], [1568, 0.36, 0.2, "triangle"]] },
  chime: { every: 0, notes: [[988, 0, 0.18, "sine"], [1318, 0.2, 0.3, "sine"]] },
  test: { every: 0, notes: [[784, 0, 0.18, "sine"], [988, 0.22, 0.18, "sine"], [1175, 0.44, 0.3, "sine"]] },
};

export function createSound() {
  const Ctx = typeof window !== "undefined" ? window.AudioContext || window.webkitAudioContext : null;
  let ctx = null;
  let volume = 80;
  let enabled = true;
  let loop = null; // { kind, timer }
  let gesture = false;
  const subs = new Set();
  const emit = () => subs.forEach((f) => f());

  function ensure() {
    if (!Ctx) return null;
    if (!ctx) {
      try {
        ctx = new Ctx();
        ctx.onstatechange = emit;
      } catch {
        ctx = null;
      }
    }
    return ctx;
  }

  const api = {
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    supported: () => !!Ctx,
    /** "running" | "blocked" | "unsupported" */
    state() {
      if (!Ctx) return "unsupported";
      const c = ensure();
      if (!c) return "unsupported";
      return c.state === "running" ? "running" : "blocked";
    },
    volume: () => volume,
    enabled: () => enabled,
    setVolume(v) {
      volume = Math.max(0, Math.min(100, Number(v) || 0));
      emit();
    },
    setEnabled(b) {
      enabled = !!b;
      if (!enabled) api.stopLoop();
      emit();
    },
    /** resume the audio context; must run inside a user gesture the first time */
    async unlock() {
      const c = ensure();
      if (!c) return false;
      try {
        if (c.state !== "running") await c.resume();
        // a silent buffer makes iOS Safari treat the context as unlocked
        const b = c.createBuffer(1, 1, 22050);
        const s = c.createBufferSource();
        s.buffer = b;
        s.connect(c.destination);
        s.start(0);
      } catch {
        /* still blocked */
      }
      emit();
      return c.state === "running";
    },
    /** install a one-time gesture listener that unlocks audio */
    armGestureUnlock() {
      if (gesture || typeof window === "undefined") return () => undefined;
      gesture = true;
      ensure();
      const on = () => {
        api.unlock().then((ok) => {
          if (ok) off();
        });
      };
      const evs = ["pointerdown", "keydown", "touchstart", "click"];
      const off = () => evs.forEach((e) => window.removeEventListener(e, on, true));
      evs.forEach((e) => window.addEventListener(e, on, { capture: true, passive: true }));
      return off;
    },
    /** play one pattern; returns false when the browser blocks sound / sound is off */
    play(kind = "chime", opts = {}) {
      const c = ensure();
      const p = PATTERNS[kind] || PATTERNS.chime;
      if (!c || c.state !== "running" || (!enabled && !opts.force)) return false;
      const gain = Math.max(0, Math.min(1, (volume / 100) * (opts.volumeScale ?? 1))) * 0.6;
      if (gain <= 0) return false;
      const t0 = c.currentTime + 0.02;
      for (const [freq, at, dur, wave] of p.notes) {
        const o = c.createOscillator();
        const g = c.createGain();
        o.type = wave;
        o.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, t0 + at);
        g.gain.exponentialRampToValueAtTime(gain, t0 + at + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur);
        o.connect(g);
        g.connect(c.destination);
        o.start(t0 + at);
        o.stop(t0 + at + dur + 0.05);
      }
      return true;
    },
    startLoop(kind = "order") {
      if (loop && loop.kind === kind) return;
      api.stopLoop();
      const p = PATTERNS[kind] || PATTERNS.order;
      const tick = () => api.play(kind);
      tick();
      loop = { kind, timer: p.every ? setInterval(tick, p.every) : null };
      emit();
    },
    stopLoop() {
      if (loop) {
        if (loop.timer) clearInterval(loop.timer);
        loop = null;
        emit();
      }
    },
    looping: () => loop?.kind || null,
  };
  return api;
}
