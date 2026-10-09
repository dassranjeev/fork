const TZ = "America/Toronto";
export function fmtTime(iso, tz = TZ) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  try {
    return d.toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit", timeZone: tz });
  } catch {
    return d.toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" });
  }
}
export function fmtDateTime(iso, tz = TZ) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  try {
    return d.toLocaleString("en-CA", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: tz });
  } catch {
    return d.toLocaleString("en-CA");
  }
}
/** "today 9:00 AM" or "Thu 9:00 AM" for a next-opening timestamp */
export function fmtOpens(iso, tz = TZ) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const sameDay = d.toDateString() === new Date().toDateString();
  try {
    return sameDay ? fmtTime(iso, tz) : d.toLocaleString("en-CA", { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: tz });
  } catch {
    return fmtTime(iso, tz);
  }
}
export const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** "00:00".."23:59" -> "9:30 AM" */
export function fmtClock(hhmm) {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm || "");
  if (!m) return hhmm || "";
  const h = Number(m[1]);
  return `${((h + 11) % 12) + 1}:${m[2]} ${h >= 12 ? "PM" : "AM"}`;
}
/** hours row -> text; open 00:00-00:00 means open all day */
export function hoursText(row) {
  if (!row || row.closed) return "Closed";
  if (row.openTime === "00:00" && (row.closeTime === "00:00" || row.closeTime === "23:59")) return "Open 24 hours";
  return `${fmtClock(row.openTime)} - ${fmtClock(row.closeTime)}`;
}
