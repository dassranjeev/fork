import { FILLER, bestWordSim, normalize, stem, tokenize, wordSim } from './nlp';
import type { KGroup, KItem, KOption, Knowledge } from './brain.types';

/** Fuzzy matching of free text against ONE restaurant's menu (items, categories, tags, options). Pure functions. */

interface ItemIndex {
  name: string[];
  cat: string[];
  tag: string[];
  desc: string[];
  option: string[];
}

const cache = new WeakMap<KItem, ItemIndex>();
const toks = (s: string | null | undefined) => (s ? tokenize(s).filter((t) => t.length > 0) : []);

function index(item: KItem): ItemIndex {
  let ix = cache.get(item);
  if (!ix) {
    ix = {
      name: toks(item.name),
      cat: toks(item.category),
      tag: item.dietaryTags.flatMap(toks),
      desc: toks(item.description),
      option: item.groups.flatMap((g) => g.options.flatMap((o) => toks(o.name))),
    };
    cache.set(item, ix);
  }
  return ix;
}

/** content words of a phrase (filler removed) */
export function contentTokens(s: string): string[] {
  return tokenize(s).filter((t) => !FILLER.has(t));
}

export interface ItemMatch {
  item: KItem;
  score: number;
}

/**
 * 0..1 score of how well the words in `q` describe `item`.
 *  - each query word takes its best similarity against the item name (1.0), category (0.85), dietary tags (0.8), description (0.55)
 *  - words that are really option names of this item ("large", "extra cheese") do not count against it
 *  - items whose name is covered more completely score slightly higher ("margherita" -> Margherita over Margherita Deluxe)
 */
export function scoreItem(q: string[], item: KItem): number {
  if (!q.length) return 0;
  const ix = index(item);
  let sum = 0;
  let n = 0;
  let missed = 0;
  const hit = new Set<number>();
  for (const w of q) {
    const sName = bestWordSim(w, ix.name);
    const s = Math.max(sName, 0.85 * bestWordSim(w, ix.cat), 0.8 * bestWordSim(w, ix.tag), 0.55 * bestWordSim(w, ix.desc));
    if (s < 0.5 && bestWordSim(w, ix.option) >= 0.88) continue; // an option word of this item: neutral
    n++;
    sum += s;
    if (s < 0.5) missed++;
    if (sName >= 0.8) ix.name.forEach((t, i) => wordSim(w, t) >= 0.8 && hit.add(i));
  }
  if (!n) return 0;
  let qcov = sum / n;
  if (missed) qcov *= 0.6;
  const tcov = ix.name.length ? hit.size / ix.name.length : 0;
  return qcov * (0.8 + 0.2 * tcov);
}

export function rankItems(q: string[], kb: Knowledge, opts: { onlyAvailable?: boolean } = {}): ItemMatch[] {
  const out: ItemMatch[] = [];
  for (const item of kb.items) {
    if (opts.onlyAvailable && !item.available) continue;
    const score = scoreItem(q, item);
    if (score >= 0.5) out.push({ item, score });
  }
  // available items first on ties; then popularity; then name for determinism
  return out.sort((a, b) => b.score - a.score || Number(b.item.available) - Number(a.item.available) || Number(b.item.isPopular) - Number(a.item.isPopular) || a.item.name.localeCompare(b.item.name));
}

export type Resolution =
  | { kind: 'one'; match: ItemMatch; fuzzy: boolean }
  | { kind: 'many'; matches: ItemMatch[] }
  | { kind: 'maybe'; match: ItemMatch }
  | { kind: 'none' };

/** decide whether a phrase names exactly one item, several (ask which), or nothing */
export function resolveItem(phrase: string, kb: Knowledge): Resolution {
  const q = contentTokens(phrase);
  if (!q.length) return { kind: 'none' };
  const ranked = rankItems(q, kb);
  if (!ranked.length) return { kind: 'none' };
  const top = ranked[0];
  const second = ranked[1];
  const exact = normalize(phrase).replace(/\b(a|an|the|of|some|please)\b/g, '').replace(/\s+/g, ' ').trim() === normalize(top.item.name);
  if (top.score >= 0.78 && (exact || !second || top.score - second.score >= 0.08)) return { kind: 'one', match: top, fuzzy: top.score < 0.97 };
  const close = ranked.filter((m) => m.score >= Math.max(0.5, top.score - 0.25)).slice(0, 5);
  if (close.length === 1) return { kind: 'maybe', match: close[0] };
  return { kind: 'many', matches: close };
}

/** options of `item` named in `tokens` (name words already used for the item itself are excluded by the caller) */
export function matchOptions(tokens: string[], item: KItem): KOption[] {
  const picked: { g: KGroup; o: KOption; len: number }[] = [];
  for (const g of item.groups) {
    for (const o of g.options) {
      const ot = toks(o.name).filter((t) => !FILLER.has(t) || t === 'extra');
      if (!ot.length) continue;
      if (ot.every((t) => tokens.some((w) => wordSim(w, t) >= 0.88))) picked.push({ g, o, len: ot.length });
    }
  }
  // a longer option name wins over a shorter one that is part of it ("extra cheese" vs "cheese")
  picked.sort((a, b) => b.len - a.len);
  const out: KOption[] = [];
  const perGroup = new Map<string, number>();
  const usedWords = new Set<string>();
  for (const p of picked) {
    const words = toks(p.o.name);
    if (words.some((w) => usedWords.has(w)) && p.len === 1) continue;
    const n = perGroup.get(p.g.id) ?? 0;
    if (p.g.max > 0 && n >= p.g.max) continue;
    perGroup.set(p.g.id, n + 1);
    words.forEach((w) => usedWords.add(w));
    out.push(p.o);
  }
  return out;
}

/** query tokens that were NOT consumed by the item's own name / category (candidates for option words) */
export function residueAfterItem(q: string[], item: KItem): string[] {
  const ix = index(item);
  return q.filter((w) => !(bestWordSim(w, ix.name) >= 0.8 || bestWordSim(w, ix.cat) >= 0.85));
}

// ------------------------------------------------------------------ categories
export interface CategoryMatch {
  id: string | null;
  name: string;
  score: number;
  itemIds: string[];
}

export function matchCategory(q: string[], kb: Knowledge): CategoryMatch | null {
  if (!q.length) return null;
  let best: CategoryMatch | null = null;
  for (const c of kb.categories) {
    const ct = toks(c.name).filter((t) => !FILLER.has(t));
    if (!ct.length) continue;
    // every meaningful word of the category name must be matched by a query word (so "dairy" does not select "Dairy, Bread & Eggs")
    const sims = ct.map((t) => Math.max(0, ...q.map((w) => wordSim(w, t))));
    const covered = sims.filter((s) => s >= 0.8).length;
    const score = covered === 0 ? 0 : (covered / ct.length) * Math.min(...sims.filter((s) => s >= 0.8));
    // "pizzas" -> Pizzas ; "drinks" -> Cold Drinks (one of its words is enough when the category name has 2 words)
    const eff = ct.length > 1 && covered >= 1 ? Math.max(score, 0.82) : score;
    if (eff >= 0.8 && (!best || eff > best.score)) best = { id: c.id, name: c.name, score: eff, itemIds: c.itemIds };
  }
  return best;
}

// ------------------------------------------------------------------ dietary tags
const DIET_ALIASES: [RegExp, string][] = [
  [/\b(vegetarian|veggie|veg)\b/, 'vegetarian'],
  [/\bvegan\b/, 'vegan'],
  [/\bhalal\b/, 'halal'],
  [/\bkosher\b/, 'kosher'],
  [/\b(gluten ?free|gf)\b/, 'gluten-free'],
  [/\bdairy ?free\b/, 'dairy-free'],
  [/\bnut ?free\b/, 'nut-free'],
  [/\bketo\b/, 'keto'],
  [/\bspicy\b/, 'spicy'],
];

const tagKey = (t: string) => normalize(t).replace(/[^a-z0-9]/g, '');

/** dietary tags (as recorded on THIS menu) the message asks for */
export function detectDiet(message: string, kb: Knowledge | null): string[] {
  const m = normalize(message);
  const wanted = new Set<string>();
  for (const [re, tag] of DIET_ALIASES) if (re.test(m)) wanted.add(tag);
  if (kb) {
    const all = new Set(kb.items.flatMap((i) => i.dietaryTags));
    for (const t of all) {
      const n = normalize(t);
      if (n && new RegExp(`\\b${n.replace(/[^a-z0-9 ]/g, '.')}\\b`).test(m)) wanted.add(t);
    }
  }
  return [...wanted];
}

/** does the item carry this tag (vegan items satisfy "vegetarian")? */
export function hasTag(item: KItem, tag: string): boolean {
  const want = tagKey(tag);
  const have = item.dietaryTags.map(tagKey);
  if (have.includes(want)) return true;
  return want === 'vegetarian' && have.includes('vegan');
}

export function priceOf(item: KItem): number {
  return item.price;
}

export const stemSet = (s: string) => new Set(tokenize(s).map(stem));
