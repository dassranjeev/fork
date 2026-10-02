import axios from "axios";
import { http, tokens, WS_URL , validateUpload } from "../../lib/api";

/** Seconds -> "m:ss" (or "h:mm:ss"). */
export function clock(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
}

export const humanSec = (sec) => {
  const s = Math.round(Number(sec) || 0);
  if (!s) return "0s";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};

/**
 * Presence keeper: the heartbeat lives outside React so an agent who is Online keeps receiving chats while
 * working in other admin pages (e.g. the ticket page to issue a refund). Stops on Offline or logout.
 * The server flips an agent to OFFLINE after support.chat.presenceTimeoutSec without a heartbeat.
 */
let timer = null;
export const presenceKeeper = {
  start() {
    if (timer) return;
    timer = setInterval(() => http.post("/admin/support/chat/presence/heartbeat", {}).catch(() => undefined), 30000);
  },
  stop() {
    if (timer) clearInterval(timer);
    timer = null;
  },
};
if (typeof window !== "undefined") window.addEventListener("forksy:logout", () => presenceKeeper.stop());

/** Short two-tone chime (no asset needed). */
let audio = null;
export function chime(kind = "message") {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === "suspended") audio.resume();
    const t0 = audio.currentTime;
    const notes = kind === "new" ? [660, 880, 1100] : [880];
    notes.forEach((f, i) => {
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.type = "sine";
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0 + i * 0.14);
      g.gain.exponentialRampToValueAtTime(0.15, t0 + i * 0.14 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.14 + 0.2);
      o.connect(g);
      g.connect(audio.destination);
      o.start(t0 + i * 0.14);
      o.stop(t0 + i * 0.14 + 0.22);
    });
  } catch {
    /* autoplay blocked: ignore */
  }
}

/** Upload an image. POST /uploads is mounted at the server root in the current backend; fall back to it when /api/v1/uploads is 404. */
export async function uploadImage(file) {
  validateUpload(file);
  try {
    return await http.upload(file);
  } catch (e) {
    if (e?.response?.status !== 404) throw e;
    const fd = new FormData();
    fd.append("file", file);
    const r = await axios.post(`${WS_URL}/uploads`, fd, { headers: { Authorization: `Bearer ${tokens.access}` } });
    return r.data;
  }
}

export const STATUS_TONE = { WAITING: "warning", ACTIVE: "success", ENDED: "neutral", MISSED: "danger" };
export const STATUS_LABEL = { WAITING: "Waiting", ACTIVE: "Active", ENDED: "Ended", MISSED: "Converted to ticket" };
