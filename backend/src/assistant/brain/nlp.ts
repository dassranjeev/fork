/**
 * Tiny, dependency-free text toolkit for the deterministic assistant brain:
 * normalising, tokenising, light English stemming, edit distance / trigram similarity, quantity words, price words.
 * Everything here is pure (no I/O) so it can be unit-tested in isolation.
 */

/** lower-case, strip accents and apostrophes, keep letters / digits / a few symbols */
export function normalize(s: string): string {
  return (s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9$.,;:%+<>=\-/ ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** words only (letters + digits); "coca-cola" -> coca, cola ; "355ml" stays one token */
export function tokenize(s: string): string[] {
  return normalize(s)
    .replace(/(\d)\.(\d)/g, '$1_$2') // keep decimals together while splitting
    .split(/[^a-z0-9_]+/)
    .map((t) => t.replace(/_/g, '.'))
    .filter(Boolean);
}

const IRREGULAR: Record<string, string> = {
  fries: 'fry',
  chips: 'chip',
  men: 'man',
  leaves: 'leaf',
  loaves: 'loaf',
  knives: 'knife',
  boxes: 'box',
  sandwiches: 'sandwich',
  tomatoes: 'tomato',
  potatoes: 'potato',
  cheeses: 'cheese',
  juices: 'juice',
  sauces: 'sauce',
  slices: 'slice',
  pieces: 'piece',
  pizzas: 'pizza',
  wings: 'wing',
  nuggets: 'nugget',
  berries: 'berry',
  cookies: 'cookie',
  veggies: 'veggie',
  veggie: 'veg',
  vegetables: 'veg',
  vegetable: 'veg',
  buns: 'bun',
  gas: 'gas',
  glass: 'glass',
  dress: 'dress',
  bass: 'bass',
  hummus: 'hummus',
  couscous: 'couscous',
  asparagus: 'asparagus',
};

/** crude plural / suffix stemmer: good enough to equate burger/burgers, fry/fries, sandwich/sandwiches */
export function stem(w: string): string {
  if (w.length <= 3 || /\d/.test(w)) return w;
  if (IRREGULAR[w]) return IRREGULAR[w];
  if (/(ss|us|is)$/.test(w)) return w;
  if (/ies$/.test(w) && w.length > 4) return w.slice(0, -3) + 'y';
  if (/(ches|shes|xes|zes|sses)$/.test(w)) return w.slice(0, -2);
  if (/s$/.test(w)) return w.slice(0, -1);
  return w;
}

export function stems(s: string): string[] {
  return tokenize(s).map(stem);
}

/** Damerau-Levenshtein (optimal string alignment); returns max+1 as soon as the distance must exceed `max` */
export function levenshtein(a: string, b: string, max = 3): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const m = a.length;
  const n = b.length;
  const d: number[][] = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      // adjacent transposition counts as one edit (margherita / margeritha)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return Math.min(d[m][n], max + 1);
}

function trigrams(s: string): Set<string> {
  const p = `  ${s} `;
  const out = new Set<string>();
  for (let i = 0; i < p.length - 2; i++) out.add(p.slice(i, i + 3));
  return out;
}

/** Dice coefficient over character trigrams (0..1) */
export function trigramSim(a: string, b: string): number {
  if (!a || !b) return 0;
  const A = trigrams(a);
  const B = trigrams(b);
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return (2 * inter) / (A.size + B.size);
}

/** words that mean "something in this group" - used to expand a query word to related menu words */
export const SYNONYMS: Record<string, string[]> = {
  pop: ['soda', 'cola', 'coke', 'pepsi', 'drink', 'beverage'],
  soda: ['pop', 'cola', 'coke', 'pepsi', 'drink'],
  coke: ['cola', 'coca'],
  drink: ['beverage', 'pop', 'soda', 'juice', 'water'],
  beverage: ['drink', 'pop', 'soda', 'juice'],
  burger: ['hamburger', 'cheeseburger'],
  hamburger: ['burger'],
  fry: ['fries'],
  chip: ['chips', 'crisps'],
  dessert: ['sweet', 'cake', 'cookie', 'ice'],
  coffee: ['latte', 'espresso', 'cappuccino', 'americano'],
  tea: ['chai', 'latte'],
  wing: ['wings'],
  veg: ['vegetarian', 'veggie', 'vegan'],
  sub: ['sandwich', 'hoagie'],
  sandwich: ['sub', 'wrap'],
  pasta: ['spaghetti', 'penne', 'noodle'],
  noodle: ['pasta', 'ramen'],
  rice: ['biryani', 'pilaf'],
  starter: ['appetizer', 'side'],
  appetizer: ['starter', 'side'],
};

/** common filler / politeness / command words that never name a menu item */
export const FILLER = new Set(
  (
    'a an the of some any please pls plz me my i id ill im ive we us our you your can could would will shall may might ' +
    'like want wanna need get give have has had take put make let lets to for from on in at by it its this that these those there here ' +
    'add adding added order ordering ordered buy grab throw include with without and also plus just then too as is are be do does did ' +
    'cart basket bag tray list another more extra additional item items thing things piece pieces portion portions serving servings ' +
    'hi hello hey thanks thank ok okay sure yes yeah yep cool great awesome now today tonight right actually maybe kindly one'
  ).split(' '),
);

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  couple: 2, pair: 2, dozen: 12, single: 1, double: 2, triple: 3,
};

export interface QuantityParse {
  qty: number | null;
  /** tokens that remain once the quantity words were removed */
  rest: string[];
  /** quantity written explicitly (digits / words / x2) rather than defaulted */
  explicit: boolean;
}

/**
 * Pull a quantity out of a clause: "2 margherita", "two margheritas", "x2 pop", "pop x 2", "2x fries", "a couple of pops",
 * "a dozen wings", "half a dozen", "an order of fries". Returns qty null when none was written.
 */
export function parseQuantity(clause: string): QuantityParse {
  let s = normalize(clause);
  let qty: number | null = null;
  const take = (re: RegExp, fn: (m: RegExpExecArray) => number | null) => {
    const m = re.exec(s);
    if (!m) return false;
    const v = fn(m);
    if (v === null) return false;
    qty = v;
    s = (s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim();
    return true;
  };
  // half a dozen / half dozen
  if (!take(/\bhalf (?:a )?dozen\b/, () => 6)) {
    // "2x", "x2", "x 2", "2 x"
    if (!take(/(?:^|\s)(\d{1,3})\s*x(?=\s|$)/, (m) => +m[1])) {
      if (!take(/(?:^|\s)x\s*(\d{1,3})(?=\s|$)/, (m) => +m[1])) {
        // leading / standalone digits ("2 margherita", "pop 2"); never a digit glued to letters ("355ml") or a price ("$5")
        if (!take(/(?:^|\s)(\d{1,3})(?=\s|$)(?!\s*(?:ml|l|g|kg|lb|oz|pack|inch|in|cm)\b)/, (m) => +m[1])) {
          // "a couple of", "a dozen", "a pair of", words
          if (!take(/\b(?:a )?(couple|dozen|pair)(?: of)?\b/, (m) => NUMBER_WORDS[m[1]])) {
            take(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|single|double|triple)\b/, (m) => NUMBER_WORDS[m[1]]);
          }
        }
      }
    }
  }
  const explicit = qty !== null;
  if (qty === null && /(?:^|\s)(?:a|an)(?=\s)/.test(` ${s} `)) qty = 1;
  return { qty, rest: tokenize(s), explicit };
}

/** "under $10", "less than 12.50", "below 8 dollars", "max $15", "<10", "cheaper than 9" */
export function parsePriceCap(text: string): number | null {
  const s = normalize(text);
  const m =
    /\b(?:under|below|less than|cheaper than|at most|no more than|up to|max(?:imum)?|within|not over|not above|budget(?: of)?)\s*\$?\s*(\d{1,4}(?:\.\d{1,2})?)/.exec(s) ||
    /<\s*=?\s*\$?(\d{1,4}(?:\.\d{1,2})?)/.exec(s) ||
    /\$\s*(\d{1,4}(?:\.\d{1,2})?)\s*(?:or less|or under|or below|and under|max|tops)/.exec(s) ||
    /\b(\d{1,4}(?:\.\d{1,2})?)\s*(?:dollars?|bucks)\s*(?:or less|or under|max|tops|and under)?\b/.exec(s);
  if (!m) return null;
  const v = parseFloat(m[1]);
  return Number.isFinite(v) && v > 0 ? v : null;
}

export const money = (n: number) => `$${(Math.round((n + Number.EPSILON) * 100) / 100).toFixed(2)}`;

// ------------------------------------------------------------------ similarity

/** similarity of two single words, 0..1 (short words must match exactly after stemming) */
export function wordSim(a: string, b: string): number {
  if (a === b) return 1;
  const sa = stem(a);
  const sb = stem(b);
  if (sa === sb) return 0.98;
  const la = Math.min(sa.length, sb.length);
  const L = Math.max(sa.length, sb.length);
  if (la < 4) return 0; // pop != pot, tea != ten
  if (la >= 4 && (sa.startsWith(sb) || sb.startsWith(sa)) && la / L >= 0.5) return 0.8;
  const d = levenshtein(sa, sb, 3);
  if (L >= 5 && d <= 1) return 0.9;
  if (L >= 8 && d <= 2) return 0.82;
  if (L >= 11 && d <= 3) return 0.75;
  if (L >= 6) {
    const t = trigramSim(sa, sb);
    if (t >= 0.62) return Math.min(0.78, t);
  }
  return 0;
}

/** best similarity of `q` against a bag of target words, also trying synonyms of `q` at a discount */
export function bestWordSim(q: string, targets: string[]): number {
  let best = 0;
  for (const t of targets) best = Math.max(best, wordSim(q, t));
  if (best >= 0.98) return best;
  const syn = SYNONYMS[stem(q)];
  if (syn) for (const sy of syn) for (const t of targets) best = Math.max(best, 0.8 * wordSim(sy, t));
  return best;
}
