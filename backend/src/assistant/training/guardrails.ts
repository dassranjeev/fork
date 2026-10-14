import { sanitizePlain } from '../../common/security';
import { isInjection } from '../brain/deterministic.brain';
import { normalize } from '../brain/nlp';
import { FieldIssue, KbChip, KbEntry, LIMITS } from './types';

/**
 * Guardrails for everything a restaurant teaches its bot. Pure functions (no I/O), run on the server for every save / import.
 *
 *  BLOCK  (400, nothing saved)   pasted personal data (email, phone, card number), links that are not https, javascript: / data: URLs,
 *                                prompt-injection phrasing, profanity / abuse, size limits.
 *  HOLD   (saved, kept OUT of the live bot until FORKY staff release it)   allergen-safety guarantees and medical claims.
 *  WARN   (saved)                prices / opening hours: the live menu and hours are always used for those, the entry is only a fallback.
 */

export interface GuardrailConfig {
  /** extra phrases (case-insensitive substring) that hold an entry for review, on top of the built-in patterns */
  holdPhrases: string[];
  /** extra phrases that are refused (profanity / abuse), on top of the built-in list */
  blockPhrases: string[];
}

export const DEFAULT_HOLD_PHRASES = [
  '100% safe',
  '100 percent safe',
  'completely safe',
  'totally safe',
  'guaranteed nut free',
  'guaranteed gluten free',
  'guaranteed dairy free',
  'guaranteed allergen free',
  'no allergens',
  'allergen free',
  'allergy safe',
  'safe for celiacs',
  'safe for coeliacs',
  'safe for people with allergies',
  'safe for diabetics',
  'no cross contamination',
  'no cross-contamination',
  'cure for',
  'clinically proven',
  'doctor approved',
];

export const DEFAULT_BLOCK_PHRASES = ['fuck', 'shit', 'bitch', 'asshole', 'bastard', 'cunt', 'dickhead', 'slut', 'whore', 'retard', 'faggot', 'nigger', 'nigga'];

export const DEFAULT_GUARDRAILS: GuardrailConfig = { holdPhrases: DEFAULT_HOLD_PHRASES, blockPhrases: DEFAULT_BLOCK_PHRASES };

const ALLERGENS = '(?:nuts?|peanuts?|tree ?nuts?|gluten|dairy|lactose|eggs?|soy|wheat|sesame|shellfish|fish|allerg\\w*)';
const HOLD_PATTERNS: [RegExp, string][] = [
  [/\b(?:100\s*%|completely|totally|absolutely|entirely|perfectly)\s*(?:safe|free)\b/i, 'allergen-safety guarantee'],
  [new RegExp(`\\bguarantee[sd]?\\b.{0,40}\\b${ALLERGENS}`, 'i'), 'allergen guarantee'],
  [new RegExp(`\\b${ALLERGENS}[- ]?free\\b.{0,30}\\bguarantee`, 'i'), 'allergen guarantee'],
  [/\bno allergens?\b/i, 'allergen claim'],
  [/\ballergen[- ]?free\b/i, 'allergen claim'],
  [new RegExp(`\\bsafe\\b.{0,30}\\b(?:celiacs?|coeliacs?|allerg\\w*|intoleran\\w*|${ALLERGENS})`, 'i'), 'allergen-safety claim'],
  [/\b(?:celiacs?|coeliacs?)\b.{0,25}\bsafe\b/i, 'allergen-safety claim'],
  [/\b(?:won'?t|will not|cannot|can'?t) (?:cause|trigger) (?:an? )?(?:allergic|reaction)/i, 'allergen-safety claim'],
  [/\bno (?:risk|chance) of (?:cross[- ]?contamination|allerg\w*)/i, 'allergen-safety claim'],
  [/\b(?:cures?|cured|treats?|heals?|prevents?|reverses?)\b.{0,30}\b(?:cancer|diabetes|disease|illness|infection|covid|anxiety|depression|arthritis|obesity)/i, 'medical claim'],
  [/\b(?:medically|clinically) (?:proven|tested|approved)\b|\bdoctor[- ]approved\b|\bmedical (?:advice|benefit|grade)\b/i, 'medical claim'],
  [/\bsafe for (?:diabetics?|pregnan\w*|babies|infants)\b/i, 'medical claim'],
];

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE_LIKE = /(?:\+?\d[\d\s().-]{7,}\d)/g;
const CARD_LIKE = /\b(?:\d[ -]?){13,19}\b/;
const URL_ANY = /\b(?:https?|ftp|javascript|data|vbscript|file):[^\s]*/gi;
const PRICE = /\$\s?\d|\b\d+(?:\.\d{1,2})?\s*(?:dollars?|bucks|cad)\b/i;
const HOURS = /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\bopen(?:s|ing)?\b.{0,25}\b(?:until|till|from|at|on)\b|\bclos(?:e|es|ing)\b.{0,25}\b(?:at|by)\b|\b(?:mon|tues|wednes|thurs|fri|satur|sun)day\b.{0,20}\d/i;

/** "we cannot guarantee ...", "not safe for ...": a negated statement is a warning to guests, not a promise, so it is allowed */
const NEGATION = /\b(?:cannot|can'?t|can not|cant|do not|don'?t|dont|does not|doesn'?t|not|never|unable to|no one can|make no|without|neither)\b[^.!?]{0,60}$/i;
const negated = (text: string, at: number) => NEGATION.test(text.slice(Math.max(0, at - 75), at + 8));

const digits = (s: string) => s.replace(/\D/g, '');

/** remove personal data from text that is stored for analytics (unanswered questions, feedback): emails, phone numbers, card-like numbers, URLs */
export function stripPii(text: string): string {
  return sanitizePlain(String(text ?? ''))
    .replace(EMAIL, ' ')
    .replace(URL_ANY, ' ')
    .replace(PHONE_LIKE, (m) => (digits(m).length >= 7 ? ' ' : m))
    .replace(/\b(?:\d[ -]?){13,19}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** one text field; `kind` decides which checks apply */
export function checkText(text: string, field: string, cfg: GuardrailConfig = DEFAULT_GUARDRAILS, opts: { checkLive?: boolean } = {}): FieldIssue[] {
  const out: FieldIssue[] = [];
  const t = String(text ?? '');
  const n = normalize(t);
  if (EMAIL.test(t)) out.push({ field, code: 'pii_email', severity: 'block', message: 'Remove the email address. Contact details come from your restaurant profile, never from the bot text.' });
  if ((t.match(PHONE_LIKE) ?? []).some((m) => digits(m).length >= 9)) out.push({ field, code: 'pii_phone', severity: 'block', message: 'Remove the phone number. The bot shares your profile phone number by itself when customers ask.' });
  if (CARD_LIKE.test(t) && digits(t).length >= 13) out.push({ field, code: 'pii_card', severity: 'block', message: 'This looks like a card number. Never put payment details in the bot.' });
  for (const m of t.match(URL_ANY) ?? []) {
    if (!/^https:\/\/[^\s/?#]+/i.test(m)) out.push({ field, code: 'link_unsafe', severity: 'block', message: `Links must start with https:// ("${m.slice(0, 30)}" is not allowed).` });
  }
  if (isInjection(n) || /\b(?:system prompt|you are now|ignore (?:all |any |the )?(?:previous|prior|above)|developer mode|jailbreak|act as (?:a|an) )/i.test(t) || /<\s*script/i.test(t)) {
    out.push({ field, code: 'injection', severity: 'block', message: 'This text looks like an instruction to the bot (or code), not an answer for customers.' });
  }
  const words = n.split(' ');
  for (const bad of cfg.blockPhrases) {
    const b = normalize(bad);
    if (b && (b.includes(' ') ? n.includes(b) : words.some((w) => w === b || (b.length >= 5 && w.startsWith(b))))) {
      out.push({ field, code: 'abuse', severity: 'block', message: 'Please remove the offensive wording.' });
      break;
    }
  }
  const held = new Set<string>();
  for (const [re, label] of HOLD_PATTERNS) {
    const m = re.exec(t);
    if (m && !negated(t, m.index)) held.add(label);
  }
  for (const p of cfg.holdPhrases) {
    const q = normalize(p);
    const at = q ? n.indexOf(q) : -1;
    if (at >= 0 && !negated(n, at)) held.add('flagged phrase');
  }
  if (held.size) {
    out.push({ field, code: 'hold_claim', severity: 'hold', message: `${[...held].join(', ')}: statements that guarantee allergen safety or make medical claims need FORKY review before the bot can use them. The bot never promises safety; point guests to the restaurant staff instead.` });
  }
  if (opts.checkLive && (PRICE.test(t) || HOURS.test(t))) {
    out.push({ field, code: 'live_data', severity: 'warn', message: 'This mentions prices or opening hours. The bot always uses the live menu prices and hours for those questions, so this answer is only a fallback and will not override them.' });
  }
  return out;
}

export interface EntryInput {
  title?: unknown;
  questions?: unknown;
  answer?: unknown;
  chips?: unknown;
  tags?: unknown;
  active?: unknown;
  priority?: unknown;
}

export interface CleanEntry {
  title: string;
  questions: string[];
  answer: string;
  chips: KbChip[];
  tags: string[];
  active: boolean;
  priority: number;
}

const clean = (v: unknown, max: number) => sanitizePlain(typeof v === 'string' ? v : '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max + 1);

/**
 * Validate + normalise an entry. `issues` contains every problem with a per-field message. `ok` = nothing blocks it.
 * `existingEntryIds` is used to validate follow-up chips.
 */
export function validateEntry(input: EntryInput, cfg: GuardrailConfig, existingEntryIds: Set<string>, selfId?: string): { ok: boolean; entry: CleanEntry; issues: FieldIssue[] } {
  const issues: FieldIssue[] = [];
  const add = (field: string, message: string, code = 'invalid') => issues.push({ field, code, severity: 'block', message });

  const answer = clean(input.answer, LIMITS.answerChars);
  if (!answer) add('answer', 'Write the answer the bot should give.', 'required');
  else if (answer.length > LIMITS.answerChars) add('answer', `The answer is too long (max ${LIMITS.answerChars} characters).`, 'too_long');

  const rawQs = Array.isArray(input.questions) ? input.questions : typeof input.questions === 'string' ? [input.questions] : [];
  if (rawQs.length > LIMITS.questionsPerEntry) add('questions', `At most ${LIMITS.questionsPerEntry} phrasings per answer.`, 'too_many');
  const seen = new Set<string>();
  const questions: string[] = [];
  rawQs.slice(0, LIMITS.questionsPerEntry).forEach((q, i) => {
    const t = clean(q, LIMITS.questionChars);
    if (!t) return;
    if (t.length > LIMITS.questionChars) add(`questions[${i}]`, `Phrasing ${i + 1} is too long (max ${LIMITS.questionChars} characters).`, 'too_long');
    const key = normalize(t);
    if (seen.has(key)) return;
    seen.add(key);
    questions.push(t.slice(0, LIMITS.questionChars));
  });

  let title = clean(input.title, LIMITS.titleChars);
  if (title.length > LIMITS.titleChars) add('title', `The title is too long (max ${LIMITS.titleChars} characters).`, 'too_long');
  if (!title && questions.length) title = questions[0].slice(0, LIMITS.titleChars);
  if (!title) add('title', 'Give the answer a short title (for example "Parking").', 'required');
  if (!questions.length) add('questions', 'Add at least one way a customer might ask this.', 'required');

  const rawTags = Array.isArray(input.tags) ? input.tags : [];
  const tags = [...new Set(rawTags.map((t) => clean(t, LIMITS.tagChars).toLowerCase()).filter(Boolean))].slice(0, LIMITS.tagsPerEntry);

  const rawChips = Array.isArray(input.chips) ? input.chips : [];
  if (rawChips.length > LIMITS.chipsPerEntry) add('chips', `At most ${LIMITS.chipsPerEntry} follow-up buttons.`, 'too_many');
  const chips: KbChip[] = [];
  rawChips.slice(0, LIMITS.chipsPerEntry).forEach((c: any, i) => {
    const label = clean(c?.label, LIMITS.chipLabelChars);
    const entryId = typeof c?.entryId === 'string' ? c.entryId : '';
    if (!label) return add(`chips[${i}]`, 'A follow-up button needs a label.', 'required');
    if (label.length > LIMITS.chipLabelChars) return add(`chips[${i}]`, `Button label too long (max ${LIMITS.chipLabelChars}).`, 'too_long');
    if (!existingEntryIds.has(entryId) || entryId === selfId) return add(`chips[${i}]`, 'A follow-up button must open another existing answer.', 'invalid_target');
    chips.push({ label, entryId });
  });

  let priority = 0;
  if (input.priority !== undefined && input.priority !== null) {
    const p = Number(input.priority);
    if (!Number.isInteger(p) || p < 0 || p > 5) add('priority', 'Priority is a whole number from 0 to 5.');
    else priority = p;
  }
  if (input.active !== undefined && typeof input.active !== 'boolean') add('active', 'active must be true or false.');
  const active = input.active === undefined ? true : input.active === true;

  // content guardrails over every free-text field
  // a phrasing / title / button is what a CUSTOMER might type ("is it nut free?"), so only the answer is held for safety claims; everything is checked for personal data, links, injection and abuse
  const check = (text: string, field: string, answerText = false) => issues.push(...checkText(text, field, cfg, { checkLive: answerText }).filter((i) => answerText || i.severity !== 'hold'));
  check(title, 'title');
  questions.forEach((q, i) => check(q, `questions[${i}]`));
  check(answer, 'answer', true);
  chips.forEach((c, i) => check(c.label, `chips[${i}]`));

  return { ok: !issues.some((i) => i.severity === 'block'), entry: { title, questions, answer, chips, tags, active, priority }, issues };
}

export const heldCodes = (issues: FieldIssue[]) => issues.filter((i) => i.severity === 'hold');
export const liveDataFlag = (issues: FieldIssue[]) => issues.some((i) => i.code === 'live_data');

export function toHeld(issues: FieldIssue[]): KbEntry['held'] {
  const h = heldCodes(issues);
  return h.length ? { codes: [...new Set(h.map((i) => i.code))], messages: [...new Set(h.map((i) => i.message))].slice(0, 3), at: new Date().toISOString() } : null;
}
