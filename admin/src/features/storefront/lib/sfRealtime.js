/**
 * The customer website has its OWN session (sf.* tokens), so it has its own Socket.IO connection, authenticated with the
 * customer's access token (re-read on every reconnect). Created lazily (only while a token exists), closed on logout.
 * Used by the notification center (lib/SfNotify.jsx) and by live order tracking (pages/Track.jsx).
 */
import { createRealtime } from "../../../lib/notify/realtime";
import { WS_URL, sfTokens } from "./sfApi";

export const sfRealtime = createRealtime({ url: WS_URL, getToken: () => sfTokens.access });
export const closeSfRealtime = () => sfRealtime.close();
