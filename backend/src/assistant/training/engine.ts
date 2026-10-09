import { FILLER, normalize, stem, tokenize, trigramSim, wordSim } from '../brain/nlp';
import { KbContent, KbDocument, KbEntry, KbSynonym, LIMITS, TestCase } from './types';

/**
 * The in-house retrieval engine behind the bot's trained answers. Pure and deterministic: no database, no network, no language model.
 * It matches WORDING (it does not "understand"): normalise -> stop words -> stem -> BM25 over the restaurant's own phrasings, with fuzzy
 * (typo tolerant) word matching, a character trigram similarity and an exact-phrase boost.
 */

// ------------------------------------------------------------------ text preparation
/** words that carry no meaning for matching ("do you have a ...") */
const STOP = new Set([...FILLER, 'about', 'tell', 'know', 'there', 'would', 'should', 'please', 'ok', 'okay', 'hi', 'hello', 'hey', 'thanks', 'thank', 'much', 'many', 'also', 'any', 'some', 'available', 'possible', 'offer', 'offers', 'provide', 'provides', 'currently', 'exist', 'exists', 'anything', 'something', 'u', 'ur', 'r', 'pls', 'plz', 'thx', 'got']);
// question words keep a little meaning ("where" vs "when"): they are NOT stop words.
STOP.delete('when');
STOP.delete('where');
STOP.delete('what');
STOP.delete('how');
for (const w of ['which', 'who', 'whom', 'whose']) STOP.add(w);

/** strip a verb ending so "catering", "catered" and the typo "catring" meet "cater" (used only for the typo-tolerant word lookup) */
const lightStem = (w: string) => (/^[a-z]{6,}$/.test(w) ? w.replace(/(?:ing|ed)$/, '') : w);

/** stemmed, stop-word-free tokens ("do you have parking?" -> ["park"]); falls back to all tokens when everything was a stop word */
export function terms(text: string): string[] {
  const all = tokenize(text);
  const kept = all.filter((t) => !STOP.has(t));
  return (kept.length ? kept : all).map(stem);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Replace every alternate of a synonym group by its canonical term (word-boundary, longest first). Operates on normalised text. */
export function canonicalize(text: string, synonyms: KbSynonym[], extraPairs: { from: string; to: string }[] = []): string {
  let t = ` ${normalize(text)} `;
  const pairs: { from: string; to: string }[] = [...extraPairs];
  for (const s of synonyms) for (const a of s.alternates) pairs.push({ from: a, to: s.term });
  pairs.sort((a, b) => b.from.length - a.from.length);
  for (const p of pairs) {
    const f = normalize(p.from);
    if (!f) continue;
    t = t.replace(new RegExp(`(?<=\\s)${escapeRe(f)}(?=\\s)`, 'g'), normalize(p.to));
  }
  return t.trim();
}

// ------------------------------------------------------------------ chunking
/** Split a document into passages of about `size` characters with `overlap` characters carried over (sentence aware). */
export function chunkText(text: string, size = 300, overlap = 60): string[] {
  const clean = String(text ?? '').replace(/\r/g, '').replace(/[ \t]+/g, ' ').trim();
  if (!clean) return [];
  const sentences = clean
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .flatMap((s) => {
      if (s.length <= size) return [s];
      const parts: string[] = [];
      const words = s.split(' ');
      let cur = '';
      for (const w of words) {
        if ((cur + ' ' + w).trim().length > size && cur) {
          parts.push(cur);
          cur = w;
        } else cur = (cur + ' ' + w).trim();
      }
      if (cur) parts.push(cur);
      return parts;
    });
  const out: string[] = [];
  let cur = '';
  for (const s of sentences) {
    if (cur && cur.length + 1 + s.length > size) {
      out.push(cur);
      // carry the tail of the previous passage over (on a word boundary)
      const tail = cur.slice(-overlap);
      const sp = tail.indexOf(' ');
      cur = `${sp >= 0 ? tail.slice(sp + 1) : tail} ${s}`.trim();
      if (cur.length > size * 1.6) cur = s;
    } else cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) out.push(cur);
  return out;
}

// ------------------------------------------------------------------ index
interface Unit {
  /** entry id or document id */
  owner: string;
  text: string;
  norm: string;
  tokens: string[];
  tokenSet: Set<string>;
  tokenKey: string;
}

export interface Index {
  entries: KbEntry[];
  entryById: Map<string, KbEntry>;
  documents: KbDocument[];
  units: Unit[];
  passageUnits: Unit[];
  e: Stats;
  p: Stats;
  synonyms: KbSynonym[];
  categoryPairs: { from: string; to: string }[];
  threshold: number;
}

interface Stats {
  n: number;
  avgLen: number;
  df: Map<string, number>;
  vocab: string[];
  fuzzy: Map<string, { term: string; sim: number }[]>;
}

const stats = (units: Unit[]): Stats => {
  const df = new Map<string, number>();
  let total = 0;
  for (const u of units) {
    total += u.tokens.length;
    for (const t of u.tokenSet) df.set(t, (df.get(t) ?? 0) + 1);
  }
  return { n: Math.max(1, units.length), avgLen: units.length ? Math.max(1, total / units.length) : 1, df, vocab: [...df.keys()], fuzzy: new Map() };
};

const idf = (s: Stats, term: string) => {
  const n = s.df.get(term) ?? 0;
  return Math.log(1 + (s.n - n + 0.5) / (n + 0.5));
};

function makeUnit(owner: string, text: string, syn: KbSynonym[], pairs: { from: string; to: string }[]): Unit {
  const norm = canonicalize(text, syn, pairs);
  const tokens = terms(norm);
  return { owner, text, norm, tokens, tokenSet: new Set(tokens), tokenKey: [...new Set(tokens)].sort().join(' ') };
}

/** build the searchable index of a knowledge base (only active, non-held entries are searchable) */
export function buildIndex(content: KbContent): Index {
  const syn = content.synonyms;
  const categoryPairs = content.aliases.filter((a) => a.kind === 'category').map((a) => ({ from: a.alias, to: a.targetName }));
  const entries = content.entries.filter((e) => e.active && !e.held);
  const units: Unit[] = [];
  for (const e of entries) {
    const seen = new Set<string>();
    for (const q of [...e.questions, e.title]) {
      const u = makeUnit(e.id, q, syn, categoryPairs);
      if (!u.tokens.length || seen.has(u.norm)) continue;
      seen.add(u.norm);
      units.push(u);
    }
  }
  const passageUnits: Unit[] = [];
  for (const d of content.documents.filter((x) => !x.held)) {
    chunkText(d.text).forEach((chunk, i) => {
      const u = makeUnit(`${d.id}#${i}`, chunk, syn, categoryPairs);
      if (u.tokens.length) passageUnits.push(u);
    });
  }
  return {
    entries,
    entryById: new Map(entries.map((e) => [e.id, e])),
    documents: content.documents,
    units,
    passageUnits,
    e: stats(units),
    p: stats(passageUnits),
    synonyms: syn,
    categoryPairs,
    threshold: clampThreshold(content.settings?.threshold),
  };
}

export const clampThreshold = (t: unknown) => {
  const n = Number(t);
  return Number.isFinite(n) ? Math.min(LIMITS.thresholdMax, Math.max(LIMITS.thresholdMin, n)) : LIMITS.thresholdDefault;
};

// ------------------------------------------------------------------ scoring
/** "what is on the kids menu" asks the same as "kids menu": these filler question words count for much less than real words */
const LIGHT_WEIGHT = 0.25;
const LIGHT = new Set(['what', 'whats']);
const K1 = 1.2;
const B = 0.75;

type Resolved = { term: string; sim: number }[];

/** the vocabulary words a query word may stand for: itself, or the typo / abbreviation matches (best first, a few alternatives kept) */
function resolveTerm(s: Stats, q: string): Resolved {
  if (s.df.has(q)) return [{ term: q, sim: 1 }];
  const cached = s.fuzzy.get(q);
  if (cached) return cached;
  const found: Resolved = [];
  for (const v of s.vocab) {
    if (Math.abs(v.length - q.length) > 7) continue;
    let sim = Math.abs(v.length - q.length) <= 3 ? Math.max(wordSim(q, v), v.length >= 5 && q.length >= 5 ? 0.95 * wordSim(lightStem(q), lightStem(v)) : 0) : 0;
    if (q.length >= 4 && v.length > q.length && v.startsWith(q)) sim = Math.max(sim, 0.8); // an abbreviation ("info" -> "information")
    if (sim >= 0.78) found.push({ term: v, sim });
  }
  found.sort((a, b) => b.sim - a.sim);
  const out = found.filter((f) => f.sim >= found[0].sim - 0.12).slice(0, 4);
  if (s.fuzzy.size > 5000) s.fuzzy.clear();
  s.fuzzy.set(q, out);
  return out;
}

interface UnitScore {
  score: number;
  matched: string[];
  exact: boolean;
}

function scoreUnit(s: Stats, qTerms: string[], qText: string, u: Unit, resolved: Map<string, Resolved>, passage = false): UnitScore {
  if (!qTerms.length || !u.tokens.length) return { score: 0, matched: [], exact: false };
  const unseen = idf(s, '\u0000');
  let denomQ = 0;
  let matchedQ = 0;
  let bm25 = 0;
  let ideal = 0;
  const matched: string[] = [];
  let covW = 0;
  let totW = 0;
  const matchedUnit = new Set<string>();
  const lenNorm = (len: number) => 1 - B + (B * len) / s.avgLen;
  for (const q of qTerms) {
    const rs = resolved.get(q) ?? [];
    const lw = LIGHT.has(q) ? LIGHT_WEIGHT : 1;
    const w = (rs.length ? idf(s, rs[0].term) : unseen) * lw;
    denomQ += w;
    totW += lw;
    ideal += (w * (K1 + 1)) / (1 + K1 * lenNorm(qTerms.length));
    const r = rs.find((x) => u.tokenSet.has(x.term)); // best resolution that this phrasing actually contains
    if (r) {
      matchedQ += w * r.sim;
      const tf = u.tokens.filter((t) => t === r.term).length;
      bm25 += (w * r.sim * (tf * (K1 + 1))) / (tf + K1 * lenNorm(u.tokens.length));
      matched.push(q);
      covW += lw;
      matchedUnit.add(r.term);
    }
  }
  const QC = denomQ ? matchedQ / denomQ : 0;
  let uDen = 0;
  let uNum = 0;
  for (const t of new Set(u.tokens)) {
    const w = idf(s, t);
    uDen += w;
    if (matchedUnit.has(t)) uNum += w;
  }
  const UC = uDen ? uNum / uDen : 0;
  const bm = ideal ? Math.min(1, bm25 / ideal) : 0;
  const gram = trigramSim(qTerms.join(' '), u.tokens.join(' '));
  // a passage is a long text: only how well it covers the question counts (not how much of the passage the question covers)
  let score = passage ? 0.7 * QC + 0.3 * bm : 0.5 * QC + 0.2 * UC + 0.15 * bm + 0.15 * gram;
  // a query with words nobody ever used is a weaker match, however good the rest looks
  const coveredShare = covW / totW;
  score *= 0.55 + 0.45 * coveredShare;
  const exactText = normalize(qText) === u.norm;
  const sameSet = [...new Set(qTerms)].sort().join(' ') === u.tokenKey;
  if (exactText) score = 1;
  else if (sameSet) score = Math.max(score, 0.97);
  return { score: Math.min(1, score), matched, exact: exactText || sameSet };
}

export interface Candidate {
  entryId: string;
  title: string;
  /** confidence 0..1 */
  score: number;
  matchedPhrasing: string;
  matchedWords: string[];
  reasons: string[];
  exact: boolean;
}

export interface PassageHit {
  documentId: string;
  documentTitle: string;
  text: string;
  score: number;
  matchedWords: string[];
}

export type Outcome = 'answer' | 'ambiguous' | 'document' | 'none';

export interface SearchResult {
  query: string;
  normalized: string;
  threshold: number;
  /** confident enough to pre-empt the bot's built-in answers */
  strong: boolean;
  outcome: Outcome;
  best?: Candidate;
  /** top 3 entries (best first) */
  candidates: Candidate[];
  /** close competitors when outcome = ambiguous */
  ambiguous: Candidate[];
  passage?: PassageHit;
}

export const AMBIGUITY_GAP = 0.07;

function reasonsOf(c: { matched: string[]; phrasing: string; exact: boolean; score: number }): string[] {
  const out: string[] = [];
  if (c.exact) out.push('same wording as a taught phrasing');
  if (c.matched.length) out.push(`matched words: ${[...new Set(c.matched)].join(', ')}`);
  out.push(`closest phrasing: "${c.phrasing}"`);
  return out;
}

/** Rank the knowledge base for a question. `thresholdOverride` is used by the test bench. */
export function search(index: Index, query: string, opts: { thresholdOverride?: number } = {}): SearchResult {
  const threshold = clampThreshold(opts.thresholdOverride ?? index.threshold);
  const normalized = canonicalize(query, index.synonyms, index.categoryPairs);
  const qTerms = terms(normalized);
  const base: SearchResult = { query, normalized, threshold, strong: false, outcome: 'none', candidates: [], ambiguous: [] };
  if (!qTerms.length) return base;

  const resolveAll = (s: Stats) => new Map(qTerms.map((q) => [q, resolveTerm(s, q)] as const));

  // ---- entries
  if (index.units.length) {
    const r = resolveAll(index.e);
    const per = new Map<string, { s: UnitScore; phrasing: string }>();
    for (const u of index.units) {
      const s = scoreUnit(index.e, qTerms, normalized, u, r);
      const cur = per.get(u.owner);
      if (!cur || s.score > cur.s.score) per.set(u.owner, { s, phrasing: u.text });
    }
    const ranked = [...per.entries()]
      .map(([entryId, v]) => {
        const e = index.entryById.get(entryId)!;
        return { e, v, rank: v.s.score + 0.01 * (e.priority ?? 0) };
      })
      .filter((x) => x.v.s.score > 0.15)
      .sort((a, b) => b.rank - a.rank || a.e.title.localeCompare(b.e.title));
    const toCand = (x: (typeof ranked)[number]): Candidate => ({
      entryId: x.e.id,
      title: x.e.title,
      score: Math.round(x.v.s.score * 1000) / 1000,
      matchedPhrasing: x.v.phrasing,
      matchedWords: [...new Set(x.v.s.matched)],
      reasons: reasonsOf({ matched: x.v.s.matched, phrasing: x.v.phrasing, exact: x.v.s.exact, score: x.v.s.score }),
      exact: x.v.s.exact,
    });
    base.candidates = ranked.slice(0, 3).map(toCand);
    const best = base.candidates[0];
    if (best && best.score >= threshold) {
      const close = base.candidates.slice(1).filter((c) => c.score >= threshold && best.score - c.score < AMBIGUITY_GAP);
      if (close.length && !best.exact) {
        base.outcome = 'ambiguous';
        base.ambiguous = [best, ...close];
      } else {
        base.outcome = 'answer';
        base.best = best;
        base.strong = best.score >= Math.max(0.8, threshold) && !index.entryById.get(best.entryId)?.liveData;
      }
    }
    if (base.outcome === 'none' && best) base.best = best; // kept for the test bench ("closest but below the threshold")
  }

  // ---- documents (only when no entry answers; a higher bar, quoted)
  if (base.outcome === 'none' && index.passageUnits.length) {
    const r = resolveAll(index.p);
    let top: { u: Unit; s: UnitScore } | null = null;
    for (const u of index.passageUnits) {
      const s = scoreUnit(index.p, qTerms, normalized, u, r, true);
      if (!top || s.score > top.s.score) top = { u, s };
    }
    const docThreshold = Math.max(0.72, threshold + 0.1);
    if (top && top.s.score >= docThreshold && top.s.matched.length >= Math.min(2, qTerms.length)) {
      const docId = top.u.owner.split('#')[0];
      const doc = index.documents.find((d) => d.id === docId);
      if (doc) {
        base.outcome = 'document';
        base.passage = { documentId: doc.id, documentTitle: doc.title, text: top.u.text, score: Math.round(top.s.score * 1000) / 1000, matchedWords: [...new Set(top.s.matched)] };
      }
    } else if (top && top.s.score > 0.3) {
      base.passage = { documentId: top.u.owner.split('#')[0], documentTitle: index.documents.find((d) => d.id === top!.u.owner.split('#')[0])?.title ?? '', text: top.u.text, score: Math.round(top.s.score * 1000) / 1000, matchedWords: [...new Set(top.s.matched)] };
    }
  }
  return base;
}

// ------------------------------------------------------------------ test sets
export interface TestResult {
  id: string;
  question: string;
  pass: boolean;
  outcome: Outcome;
  answeredEntryId: string | null;
  answeredTitle: string | null;
  score: number | null;
  expected: string;
  reason: string;
}

/** What the bot would say from training for this question (null = nothing from training) */
export function answerOf(index: Index, res: SearchResult): { entryId: string | null; text: string | null } {
  if (res.outcome === 'answer' && res.best) return { entryId: res.best.entryId, text: index.entryById.get(res.best.entryId)?.answer ?? null };
  if (res.outcome === 'document' && res.passage) return { entryId: null, text: res.passage.text };
  return { entryId: null, text: null };
}

export function runTestCase(index: Index, tc: TestCase): TestResult {
  const res = search(index, tc.question);
  const a = answerOf(index, res);
  const title = a.entryId ? index.entryById.get(a.entryId)?.title ?? null : null;
  const base = { id: tc.id, question: tc.question, outcome: res.outcome, answeredEntryId: a.entryId, answeredTitle: title, score: res.best?.score ?? res.passage?.score ?? null };
  if (tc.expectUnanswered) {
    const pass = res.outcome === 'none' || res.outcome === 'ambiguous';
    return { ...base, pass, expected: 'no answer from training', reason: pass ? 'not answered, as expected' : `answered by "${title ?? 'a document'}"` };
  }
  if (tc.expectEntryId) {
    const pass = res.outcome === 'answer' && a.entryId === tc.expectEntryId;
    const exp = index.entryById.get(tc.expectEntryId)?.title ?? 'a removed entry';
    return { ...base, pass, expected: `answer "${exp}"`, reason: pass ? 'answered by the expected entry' : res.outcome === 'answer' ? `answered by "${title}" instead` : res.outcome === 'ambiguous' ? 'ambiguous between several entries' : 'no confident answer' };
  }
  if (tc.expectPhrase) {
    const pass = !!a.text && normalize(a.text).includes(normalize(tc.expectPhrase));
    return { ...base, pass, expected: `answer containing "${tc.expectPhrase}"`, reason: pass ? 'the answer contains the phrase' : a.text ? 'the answer does not contain the phrase' : 'no confident answer' };
  }
  return { ...base, pass: false, expected: 'nothing defined', reason: 'the test case has no expectation' };
}

export function runTestSet(index: Index, cases: TestCase[]): TestResult[] {
  return cases.map((c) => runTestCase(index, c));
}

/** cases that pass on `before` but fail on `after` */
export function regressions(before: Index, after: Index, cases: TestCase[]): TestResult[] {
  const b = runTestSet(before, cases);
  const a = runTestSet(after, cases);
  return a.filter((r, i) => !r.pass && b[i].pass);
}

// ------------------------------------------------------------------ similarity of free questions (inbox grouping)
export const questionKey = (text: string) => [...new Set(terms(text))].sort().join(' ');

export const questionSimilarity = (a: string, b: string) => {
  if (a === b) return 1;
  const ta = a.split(' ');
  const tb = b.split(' ');
  const inter = ta.filter((t) => tb.some((u) => wordSim(t, u) >= 0.85)).length;
  const union = ta.length + tb.length - inter || 1;
  return Math.max(inter / union, trigramSim(a, b) * 0.9);
};
