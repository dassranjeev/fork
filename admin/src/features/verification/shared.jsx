import React from "react";
import { toast } from "react-toastify";
import { Badge, StatusBadge } from "../../ui";
import { errorMessage, http } from "../../lib/api";
import { fmtDate, fmtDateTime, titleCase } from "../../lib/format";

/**
 * Words, colours and small helpers shared by the Verification page, the verification card and the lists that show a verification badge.
 * The API speaks in codes (UNVERIFIED, NEEDS_REVIEW, AUTOMATIC ...); people only ever see the plain words defined here.
 */

// ------------------------------------------------------------------ the two audiences
export const AUDIENCE = {
  DRIVER: {
    key: "drivers", // key in the overview payload and in the policy PUT body
    path: "drivers", // /admin/verification/<path>/:id
    perm: "drivers", // staff permission module that gates the account card
    title: "Drivers",
    one: "driver",
    many: "drivers",
    word: "DRIVERS", // typed to confirm a bulk action
    blurb: "Couriers who deliver orders.",
    offWork: "off the road",
    icon: "solar:scooter-outline",
  },
  BUSINESS: {
    key: "businesses",
    path: "businesses",
    perm: "restaurants",
    title: "Businesses",
    one: "business",
    many: "businesses",
    word: "BUSINESSES",
    blurb: "A business is a merchant with its restaurants. The Certn check is run on the owner.",
    offWork: "off line",
    icon: "solar:shop-2-outline",
  },
};

// ------------------------------------------------------------------ statuses, methods, Certn check
export const VERIFICATION_STATUSES = ["UNVERIFIED", "PENDING", "NEEDS_REVIEW", "VERIFIED", "REJECTED"];
export const STATUS_LABEL = { UNVERIFIED: "Unverified", PENDING: "Pending", NEEDS_REVIEW: "Needs review", VERIFIED: "Verified", REJECTED: "Rejected" };
export const STATUS_TONE = { UNVERIFIED: "warning", PENDING: "info", NEEDS_REVIEW: "danger", VERIFIED: "success", REJECTED: "neutral" };
export const STATUS_OPTIONS = VERIFICATION_STATUSES.map((value) => ({ value, label: STATUS_LABEL[value] }));
/** the states in which an account can still be verified */
export const OPEN_STATUSES = ["UNVERIFIED", "PENDING", "NEEDS_REVIEW"];

export const METHOD_LABEL = { INSTANT: "Instant", MANUAL: "Manual review", AUTOMATIC: "Certn (automatic)" };
export const methodLabel = (m) => METHOD_LABEL[m] || "—";

/** the server takes accounts past their deadline off the road every minute: the page keeps its numbers and table fresh at that pace */
export const REFRESH_MS = 60000;

export const CHECK_LABEL = { NOT_STARTED: "Not started", IN_PROGRESS: "In progress", CLEAR: "Clear", CONSIDER: "Flagged", FAILED: "Failed" };
export const CHECK_TONE = { NOT_STARTED: "neutral", IN_PROGRESS: "info", CLEAR: "success", CONSIDER: "warning", FAILED: "danger" };

export function VerificationBadge({ status }) {
  return <StatusBadge status={status} label={STATUS_LABEL[status] || titleCase(status)} tone={STATUS_TONE[status] || "neutral"} />;
}

export function CheckBadge({ status }) {
  return <StatusBadge status={status} label={CHECK_LABEL[status] || titleCase(status)} tone={CHECK_TONE[status] || "neutral"} />;
}

// ------------------------------------------------------------------ deadlines
const HOUR = 3600e3;
const DAY = 24 * HOUR;
export const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
/** "1 driver" / "3 businesses" */
export const countOf = (n, audience) => `${n} ${n === 1 ? AUDIENCE[audience].one : AUDIENCE[audience].many}`;

/** the template resets list styles: lists that should show bullets say so */
export const BULLETS = { listStyleType: "disc" };

/** "Overdue by 2 days" / "In 3 days" for a verification deadline, with a tone to colour it. null when there is no deadline. */
export function deadlineInfo(dueAt, now = Date.now()) {
  if (!dueAt) return null;
  const t = new Date(dueAt).getTime();
  if (Number.isNaN(t)) return null;
  const diff = t - now;
  const abs = Math.abs(diff);
  // rounded, so a deadline set to "7 days" reads "In 7 days" right after it was set
  const span = abs < HOUR ? "less than an hour" : abs < DAY ? plural(Math.max(1, Math.round(abs / HOUR)), "hour") : plural(Math.max(1, Math.round(abs / DAY)), "day");
  if (diff <= 0) return { overdue: true, text: abs < HOUR ? "Overdue (less than an hour)" : `Overdue by ${span}`, short: "Overdue", tone: "danger" };
  return { overdue: false, text: `In ${span}`, short: `Due in ${span}`, tone: diff < 2 * DAY ? "warning" : "neutral" };
}

const DEADLINE_CLASS = { danger: "text-danger-600 fw-medium", warning: "text-warning-600 fw-medium", neutral: "text-primary-light" };

/** The deadline as two lines: the wording ("Overdue by 2 days") and the date. */
export function Deadline({ value, className = "" }) {
  const d = deadlineInfo(value);
  if (!d) return <span className="text-secondary-light">—</span>;
  return (
    <div className={className}>
      <div className={DEADLINE_CLASS[d.tone]}>{d.text}</div>
      <div className="text-secondary-light text-xs" title={fmtDateTime(value)}>
        {fmtDate(value)}
      </div>
    </div>
  );
}

/** The verification badge with the deadline wording under it while the account is being verified (for the list tables). */
export function VerificationCell({ status, dueAt }) {
  const due = status === "PENDING" || status === "NEEDS_REVIEW" ? deadlineInfo(dueAt) : null;
  return (
    <div>
      <VerificationBadge status={status} />
      {due && <div className={`text-xs mt-1 ${due.overdue ? "text-danger-600 fw-medium" : "text-secondary-light"}`}>{due.text}</div>}
    </div>
  );
}

/**
 * Small chips for the application pipelines: "Certn" for the automatic check, "Needs review", and the deadline when there is one.
 * `wrap` (a class name) puts them in a <div>, only when there is something to show.
 */
export function VerificationChips({ status, method, dueAt, wrap }) {
  const open = status === "PENDING" || status === "NEEDS_REVIEW";
  const due = open ? deadlineInfo(dueAt) : null;
  const chips = [];
  if (status === "NEEDS_REVIEW") chips.push(<Badge key="r" tone="danger">Needs review</Badge>);
  if (open && method === "AUTOMATIC") chips.push(<Badge key="c" tone="info">Certn</Badge>);
  if (status === "UNVERIFIED") chips.push(<Badge key="u" tone="warning">Unverified</Badge>);
  if (due) chips.push(<Badge key="d" tone={due.overdue ? "danger" : due.tone === "warning" ? "warning" : "neutral"}>{due.short}</Badge>);
  if (!chips.length) return null;
  return wrap ? <div className={wrap}>{chips}</div> : <>{chips}</>;
}

// ------------------------------------------------------------------ plain words for codes the API sends inside sentences
const WORDS = { CONSIDER: "flagged for review", NOT_STARTED: "not started", IN_PROGRESS: "in progress" };
// single-word codes the checklist and the force results can contain (document types and states). Business names are left alone.
const CODES = new Set(["LICENCE", "INSURANCE", "PHOTO", "PHOTOS", "AGREEMENT", "MENU", "OTHER", "PENDING", "APPROVED", "REJECTED", "MISSING", "CLEAR", "CONSIDER", "FAILED", "EXPIRED", "VERIFIED", "UNVERIFIED"]);

/**
 * The API describes open checklist items with raw codes ("LICENCE: missing, VEHICLE_REGISTRATION: missing", "NOT_STARTED", "already PENDING").
 * Turn those codes into words: "Licence: missing, Vehicle registration: missing", "Not started", "already pending".
 */
export function humanize(text) {
  if (text === null || text === undefined) return "";
  return String(text).replace(/(^|[,:]\s+|\s)([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*)\b/g, (all, before, code) => {
    if (!code.includes("_") && !CODES.has(code)) return all;
    const words = WORDS[code] || code.toLowerCase().replace(/_/g, " ");
    const startsPhrase = before === "" || before.includes(",") || before.includes(":");
    return `${before}${startsPhrase ? words.charAt(0).toUpperCase() + words.slice(1) : words}`;
  });
}

// ------------------------------------------------------------------ Force verification wording
export const GRACE_OPTIONS = [
  { value: 0, label: "Immediately" },
  { value: 1, label: "1 day" },
  { value: 3, label: "3 days" },
  { value: 7, label: "7 days" },
  { value: 14, label: "14 days" },
  { value: 30, label: "30 days" },
];

/** What each result of Force verification means: `label` for the summary, `short` for the table of accounts. */
export const FORCE_OUTCOMES = {
  GRACE: { tone: "info", short: "Working until the deadline", label: () => "Keep working until their deadline" },
  BLOCKED: { tone: "danger", short: "Taken off now", label: (a) => `Taken ${AUDIENCE[a].offWork} now` },
  DEFERRED: {
    tone: "warning",
    short: "Will be taken off later",
    label: (a) => (a === "DRIVER" ? "Will be taken off the road when the trip ends (or by the next check)" : "Will be taken off line when the orders in progress end (or by the next check)"),
  },
  VERIFIED: { tone: "success", short: "Already verified", label: () => "Already verified (a clear Certn result was on file)" },
  SKIPPED: { tone: "neutral", short: "Skipped", label: () => "Skipped (not unverified, or not found)" },
  FAILED: { tone: "danger", short: "Failed", label: () => "Could not be processed" },
};

export const dueDateFor = (graceDays) => new Date(Date.now() + graceDays * DAY);

/**
 * What forcing verification does, as short plain sentences, for the confirmation dialogs. `single`: the sentences are about one account.
 */
export function forceConsequences({ audience, method, graceDays, single = false }) {
  const a = AUDIENCE[audience];
  const holder = audience === "DRIVER" ? "driver" : "owner";
  const lines = [];
  lines.push(`${single ? `This ${a.one} is` : `Each ${a.one} is`} told that they must verify${graceDays ? ` by ${fmtDate(dueDateFor(graceDays))}` : ""}.`);
  if (method === "AUTOMATIC") {
    lines.push(
      `Certn emails ${single ? `the ${holder}` : `each ${holder}`} a secure link for an identity and criminal-record check. A clear result verifies the account automatically; a flagged or failed result goes to staff, and nobody is rejected automatically.`
    );
  } else {
    lines.push(
      `Staff review ${single ? `the ${a.one}` : `each ${a.one}`} (${audience === "DRIVER" ? "documents, insurance and background check" : "documents of every location"}) and verify them from this page or from the ${audience === "DRIVER" ? "driver" : "restaurant"} page.`
    );
  }
  if (graceDays === 0) {
    lines.push(`There is no grace period: ${single ? `the ${a.one}, if working, is` : `every ${a.one} that is working is`} taken ${a.offWork} straight away and stays that way until verified.`);
  } else {
    lines.push(`Until the deadline they keep working. At the deadline an account that is still not verified is taken ${a.offWork} until it is verified, and then comes back by itself.`);
  }
  lines.push(audience === "DRIVER" ? "A driver who is on a trip is taken off the road only when that trip ends." : "A business with orders in progress is taken off line only when those orders are finished.");
  return lines;
}

/** What "Start Certn check" does, for the confirmation. */
export const checkMessage = (audience) =>
  `Certn emails ${audience === "DRIVER" ? "the driver" : "the business owner"} a secure link for an identity and criminal-record check. An unverified ${AUDIENCE[audience].one} goes onto the automatic method: a clear result verifies the account, and anything else goes to staff.`;

/**
 * "Start Certn check" on one account (the accounts table): asks first, then calls the API and toasts the outcome. `confirm` is the function
 * from useConfirm(). Resolves true when the check was started (so the caller reloads its data).
 */
export async function startCheckFlow({ confirm, audience, id, name }) {
  const r = await confirm({ title: `Start a Certn check for ${name}?`, message: checkMessage(audience), confirmText: "Start check" });
  if (!r.confirmed) return false;
  try {
    await http.post(`/admin/verification/${AUDIENCE[audience].path}/${id}/start-check`);
    toast.success(`Certn check started for ${name}`);
    return true;
  } catch (e) {
    toast.error(errorMessage(e));
    return false;
  }
}

/** Copy text to the clipboard; resolves true when it worked. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}
