import { io } from "socket.io-client";

/**
 * A Socket.IO connection authenticated with the CURRENT access token of one surface. The Admin Console / Restaurant Portal already
 * have `getSocket()` (lib/socket.js) and pass it to the notification store; the customer website has its own session, so it creates
 * its own connection here:
 *
 *   const rt = createRealtime({ url: WS_URL, getToken: () => sfTokens.access });
 *   rt.get()  -> the socket (or null without a token)   rt.close()
 *
 * The connection is created lazily (only with a token), reconnects with back-off and re-reads the token on every attempt.
 */
export function createRealtime({ url, getToken }) {
  let socket = null;
  return {
    get() {
      if (!getToken()) return null;
      if (!socket) {
        socket = io(url, { auth: (cb) => cb({ token: getToken() }), transports: ["websocket", "polling"], reconnectionDelayMax: 10000 });
      }
      return socket;
    },
    close() {
      if (socket) {
        socket.disconnect();
        socket = null;
      }
    },
  };
}
