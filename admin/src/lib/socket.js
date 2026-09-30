import { useEffect, useRef } from "react";
import { io } from "socket.io-client";
import { WS_URL, tokens } from "./api";

let socket = null;

/** Shared Socket.IO connection (authenticated with the current access token). */
export function getSocket() {
  if (!tokens.access) return null;
  if (!socket) {
    socket = io(WS_URL, {
      auth: (cb) => cb({ token: tokens.access }),
      transports: ["websocket", "polling"],
      reconnectionDelayMax: 10000,
    });
  }
  return socket;
}

export function disconnectSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}

/**
 * Subscribe to realtime events.
 *   useSocketEvent('order.status', (payload) => ...)
 *   useSocketEvent(['order.updated', 'order.unassigned'], handler)
 * Rooms are joined server-side from the login token (admin:ops, restaurant:{id}, ...).
 */
export function useSocketEvent(events, handler, deps = []) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const s = getSocket();
    if (!s) return undefined;
    const list = Array.isArray(events) ? events : [events];
    const fn = (...args) => ref.current(...args);
    list.forEach((e) => s.on(e, fn));
    return () => list.forEach((e) => s.off(e, fn));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Array.isArray(events) ? events.join("|") : events, ...deps]);
}

/** Emit with ack promise. */
export function emit(event, payload) {
  const s = getSocket();
  return new Promise((resolve) => (s ? s.emit(event, payload, resolve) : resolve(null)));
}
