/**
 * Shared notification client for every web surface (Admin Console, Restaurant Portal, customer website, driver demo).
 * See docs/notifications.md ("Clients").
 */
export { createRealtime } from "./realtime";
export { createNotificationStore } from "./store";
export { createPush } from "./push";
export { createSound } from "./sound";
export { createAlerts } from "./alerts";
export { registerServiceWorker, getRegistration, onWorkerMessage } from "./sw-register";
export { support, permission, isIOS, isStandalone, safeUrl, pageActive } from "./env";
export { NotifyProvider, teardownActivePush, useNotify, useNotifications, useAlerts, usePushState, useStore } from "./react";
