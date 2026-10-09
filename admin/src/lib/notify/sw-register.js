import { support } from "./env";

/**
 * One service worker (/sw.js, scope "/") for every surface of this origin (Admin Console, Restaurant Portal, customer website,
 * driver demo). Registered once; registering never shows a permission prompt.
 */
let regP = null;
const listeners = new Set();
let bound = false;

export function registerServiceWorker() {
  if (regP) return regP;
  if (!support().ok && !("serviceWorker" in navigator)) return Promise.resolve(null);
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return Promise.resolve(null);
  regP = navigator.serviceWorker
    .register("/sw.js", { scope: "/" })
    .then((r) => {
      bindMessages();
      return r;
    })
    .catch(() => null);
  return regP;
}

/** The active registration (waits for the worker to be ready). */
export async function getRegistration() {
  const r = await registerServiceWorker();
  if (!r) return null;
  try {
    return await navigator.serviceWorker.ready;
  } catch {
    return r;
  }
}

function bindMessages() {
  if (bound) return;
  bound = true;
  navigator.serviceWorker.addEventListener("message", (e) => {
    const m = e.data;
    if (!m || typeof m !== "object" || !m.fk) return;
    listeners.forEach((fn) => {
      try {
        fn(m);
      } catch {
        /* ignore */
      }
    });
  });
}

/** Messages from the worker: { fk: 1, type: 'push' | 'notification-click' | 'subscription-change', ... }. Returns an unsubscribe function. */
export function onWorkerMessage(fn) {
  listeners.add(fn);
  if ("serviceWorker" in navigator) bindMessages();
  return () => listeners.delete(fn);
}
