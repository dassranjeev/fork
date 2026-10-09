import { haversineKm } from '../../common/geo.util';
import { FILLER, bestWordSim, normalize, parseQuantity, tokenize, wordSim } from './nlp';
import type { BotChip, BotResult, BotRestaurantCard, BrainContext, DirectoryEntry } from './brain.types';
import { chip, uniqChips } from './reply';
import { contentTokens } from './search';
import { isInjection, isOffTopic } from './deterministic.brain';

const NOISE = new Set([
  'find', 'show', 'list', 'search', 'looking', 'look', 'want', 'need', 'any', 'some', 'something', 'anything', 'restaurant', 'restaurants', 'place', 'places', 'food', 'spot', 'spots', 'near', 'nearby', 'me', 'close', 'closest', 'around', 'here',
  'open', 'now', 'right', 'currently', 'today', 'tonight', 'delivery', 'deliver', 'delivers', 'pickup', 'takeout', 'order', 'ordering', 'eat', 'eating', 'hungry', 'craving', 'dinner', 'lunch', 'breakfast', 'get', 'good', 'best', 'top', 'rated', 'cheap', 'cheapest',
  'what', 'whats', 'which', 'where', 'can', 'could', 'you', 'recommend', 'suggest', 'give', 'tell', 'about', 'is', 'are', 'there', 'do', 'have', 'serve', 'serving', 'offer', 'sell', 'selling', 'options', 'option', 'around', 'in', 'on', 'for', 'to', 'with', 'that', 'who', 'vegetarian', 'vegan', 'halal', 'gluten', 'free', 'dishes', 'dish', 'menu',
]);
const DIET_TERMS: [RegExp, string][] = [
  [/\b(vegetarian|veggie|veg)\b/, 'vegetarian'],
  [/\bvegan\b/, 'vegan'],
  [/\bhalal\b/, 'halal'],
  [/\bkosher\b/, 'kosher'],
  [/\b(gluten ?free|gf)\b/, 'gluten-free'],
  [/\bdairy ?free\b/, 'dairy-free'],
];
const tagKey = (t: string) => normalize(t).replace(/[^a-z0-9]/g, '');

const toCard = (e: DirectoryEntry): BotRestaurantCard => ({
  id: e.id,
  slug: e.slug,
  name: e.name,
  ...(e.cuisines.length ? { cuisine: e.cuisines.slice(0, 3).join(', ') } : {}),
  openNow: e.openNow,
  deliveryAvailable: e.deliveryAvailable,
  pickupAvailable: e.pickupAvailable,
  ...(e.rating ? { rating: e.rating } : {}),
  ...(e.logoUrl ? { logoUrl: e.logoUrl } : {}),
});

const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** The central FORKSY bot: finds restaurants (name, cuisine, dish, diet, open now, delivery / pickup) and scopes the chat to one. */
export class CentralRun {
  private m: string;
  private dir: DirectoryEntry[];

  constructor(private c: BrainContext) {
    this.m = normalize(c.message);
    this.dir = c.directory ?? [];
  }

  run(): BotResult {
    const { quick } = this.c;
    if (quick) return this.quickReply(quick);
    const m = this.m;
    if (!m) return this.help();
    if (isInjection(m)) return this.reply("I can't help with that. I'm the FORKSY ordering assistant: I help you find a restaurant and start an order.", this.starterChips(), 'refuse');
    if (/^(hi|hii|hello|hey|heya|hiya|yo|howdy|hola|bonjour|good (morning|afternoon|evening))\b[\s!.,]*$/.test(m)) return this.help(true);
    if (/^(thanks|thank you|thx|ty|cheers)\b/.test(m)) return this.reply("You're welcome! Tell me what you are craving and I'll find a restaurant.", this.starterChips(), 'thanks');
    if (/^(bye|goodbye|see you|cya)\b/.test(m)) return this.reply('Bye! Come back any time.', [], 'bye');
    const faq = this.matchFaq();
    if (faq) return this.reply(faq.a, this.starterChips(), 'faq');
    if (isOffTopic(m)) return this.reply("That is outside what I can help with. I can find restaurants on FORKSY and help you order.", this.starterChips(), 'off-topic');
    if (/\b(where is my order|order status|refund|cancel my order|track(ing)? (my|the) order|my order (is )?(late|cold|wrong|missing)|existing order|past order|receipt)\b/.test(m)) {
      return this.reply("I can only help you start a new order. For an order you already placed, open it in your FORKSY account and use Help.", this.starterChips(), 'support');
    }
    if (/\b(human|real person|support|customer service|complain\w*|manager)\b/.test(m)) return this.reply("I'm an automated assistant. For account or order problems, use Help in your FORKSY account.", this.starterChips(), 'human');
    if (/^(help|what can you do|how does this work)\b|\b(what can you do|how do i order|how does this work)\b/.test(m)) return this.help();
    if (/\b(cart|basket|checkout|check out|my order|clear|remove|add)\b/.test(m) && !/\b(from|at)\b/.test(m)) {
      const dish = this.dishSearch(m);
      if (dish) return dish;
      return this.reply('Pick a restaurant first and then I can build your order. Which restaurant, or what are you craving?', this.starterChips(), 'need-restaurant');
    }

    // "order from X", "take me to X", "I want to order at X"
    const scope = /\b(?:order|get|buy|eat|go|switch|open|take me|start|continue|use)\b.*?\b(?:from|at|to|with|in)\s+(.+)$/.exec(m) || /^(?:at|from)\s+(.+)$/.exec(m);
    if (scope) {
      const target = this.byName(scope[1]);
      if (target.kind === 'one') return this.scope(target.e);
      if (target.kind === 'many') return this.chooseRestaurant(target.list, scope[1]);
    }
    // a bare restaurant name ("napoli pizza city centre") scopes too when it is an exact-ish match
    const bare = this.byName(m, 0.95, true); // a bare cuisine word ("pizza") must not pick a restaurant: the whole name has to be typed
    if (bare.kind === 'one') return this.scope(bare.e);

    return this.find();
  }

  private reply(text: string, chips: BotChip[] = [], intent?: string, extra: Partial<BotResult> = {}): BotResult {
    return { text, chips: uniqChips(chips), ...(intent ? { intent } : {}), ...extra };
  }

  /** FAQ about FORKSY itself, written by FORKSY staff: fuzzy match of the question */
  private matchFaq(): { q: string; a: string } | null {
    const faqs = this.c.centralFaqs ?? [];
    const q = tokenize(this.m).filter((t) => !FILLER.has(t));
    if (!faqs.length || !q.length) return null;
    let best: { f: { q: string; a: string }; s: number } | null = null;
    for (const f of faqs) {
      const ft = tokenize(f.q).filter((t) => !FILLER.has(t));
      if (!ft.length) continue;
      const cov = (a: string[], b: string[]) => a.reduce((s, w) => s + Math.max(0, ...b.map((x) => wordSim(w, x))), 0) / a.length;
      const s = (cov(q, ft) + cov(ft, q)) / 2;
      if (!best || s > best.s) best = { f, s };
    }
    return best && best.s >= 0.7 ? best.f : null;
  }

  private starterChips(): BotChip[] {
    if (this.c.starterChips?.length) return this.c.starterChips;
    return [chip('Open now', 'find:open now'), chip('Pizza', 'find:pizza'), chip('Vegetarian', 'find:vegetarian'), chip('Burgers', 'find:burgers'), chip('Indian', 'find:indian'), chip('Delivery', 'find:delivery')];
  }

  private help(greeting = false): BotResult {
    return this.reply(
      `${greeting ? 'Hi! ' : ''}I'm the FORKSY ordering assistant. Tell me what you are craving ("pizza near me", "vegetarian, open now", "halal delivery") or a restaurant name, and I'll find it. Say "order from <restaurant>" and I'll build your cart with you.`,
      this.starterChips(),
      'help',
    );
  }

  private quickReply(q: string): BotResult {
    const [verb, ...rest] = q.split(':');
    const arg = rest.join(':');
    if (verb === 'restaurant') {
      const e = this.dir.find((x) => x.slug === arg);
      if (!e) return this.reply("I couldn't find that restaurant. Let me search again — what are you craving?", this.starterChips(), 'unknown-restaurant');
      return this.scope(e);
    }
    if (verb === 'find') return this.find(arg);
    if (verb === 'open') return this.find('open now');
    if (verb === 'veg') return this.find('vegetarian');
    if (verb === 'help') return this.help();
    return this.reply('Pick a restaurant first and then I can help with the menu and your cart. What are you craving?', this.starterChips(), 'need-restaurant');
  }

  private scope(e: DirectoryEntry): BotResult {
    return this.reply(`Great, let's order from ${e.name}.`, [chip('Menu', 'menu'), chip('Popular', 'popular')], 'scope', { scopeTo: e.slug });
  }

  private chooseRestaurant(es: DirectoryEntry[], said: string): BotResult {
    return this.reply(`I found a few places for "${said.trim().slice(0, 40)}". Which one?`, es.slice(0, 5).map((e) => chip(e.name, `restaurant:${e.slug}`)), 'choose-restaurant', { restaurants: es.slice(0, 6).map(toCard) });
  }

  // ------------------------------------------------------------------ name lookup
  private byName(phrase: string, minScore = 0.82, wholeName = false): { kind: 'one'; e: DirectoryEntry } | { kind: 'many'; list: DirectoryEntry[] } | { kind: 'none' } {
    const q = tokenize(phrase).filter((t) => !FILLER.has(t) && !['restaurant', 'restaurants', 'please', 'menu', 'location'].includes(t));
    if (!q.length) return { kind: 'none' };
    const scored = this.dir
      .map((e) => {
        const nt = tokenize(e.name).filter((t) => !FILLER.has(t));
        const sims = q.map((w) => bestWordSim(w, nt));
        const qcov = sims.reduce((a, b) => a + b, 0) / q.length;
        const tcov = nt.filter((t) => q.some((w) => wordSim(w, t) >= 0.8)).length / (nt.length || 1);
        return { e, score: Math.min(...sims) >= 0.8 && (!wholeName || tcov >= 0.99) ? qcov * (0.7 + 0.3 * tcov) : 0 };
      })
      .filter((x) => x.score >= minScore * 0.8 && x.score > 0)
      .sort((a, b) => b.score - a.score);
    if (!scored.length || scored[0].score < minScore * 0.8) return { kind: 'none' };
    const exactish = scored.filter((x) => x.score >= scored[0].score - 0.02);
    if (exactish.length === 1 && scored[0].score >= minScore * 0.85) return { kind: 'one', e: scored[0].e };
    if (scored[0].score >= 0.98 && exactish.length === 1) return { kind: 'one', e: scored[0].e };
    return { kind: 'many', list: (exactish.length > 1 ? exactish : scored).map((x) => x.e) };
  }

  // ------------------------------------------------------------------ discovery
  private dishSearch(m: string): BotResult | null {
    const body = parseQuantity(m.replace(/^(?:please |can i |could i |i(?:ll| will| would) (?:like|have|get|take) |i want |i need |add |order |get )+/, '')).rest.filter((t) => !FILLER.has(t) && !NOISE.has(t));
    if (!body.length) return null;
    const hit = this.dir.filter((e) => body.every((w) => bestWordSim(w, e.dishNames.flatMap(tokenize)) >= 0.85));
    if (!hit.length) return null;
    return this.reply(`${list(hit.slice(0, 3).map((e) => e.name))}${hit.length > 3 ? ` and ${hit.length - 3} more` : ''} ${hit.length === 1 ? 'has' : 'have'} "${body.join(' ')}". Which restaurant would you like to order from?`, hit.slice(0, 5).map((e) => chip(e.name, `restaurant:${e.slug}`)), 'dish-search', { restaurants: hit.slice(0, 6).map(toCard) });
  }

  private find(textIn?: string): BotResult {
    const m = textIn !== undefined ? normalize(textIn) : this.m;
    const wantsOpen = /\b(open now|open right now|currently open|open today|open tonight|open late|is open|that are open|which are open|open)\b/.test(m);
    const wantsDelivery = /\bdeliver\w*\b/.test(m);
    const wantsPickup = /\b(pick ?up|take ?out|takeaway|collect)\b/.test(m);
    const near = /\b(near me|nearby|close to me|closest|near by|around me|in my area|near here)\b/.test(m);
    const diets = DIET_TERMS.filter(([re]) => re.test(m)).map(([, t]) => t);
    const q = tokenize(m).filter((t) => !FILLER.has(t) && !NOISE.has(t));

    let pool = this.dir.slice();
    const bits: string[] = [];
    if (wantsOpen) {
      pool = pool.filter((e) => e.openNow);
      bits.push('open now');
    }
    if (wantsDelivery) {
      pool = pool.filter((e) => e.deliveryAvailable);
      bits.push('delivering');
    }
    if (wantsPickup) {
      pool = pool.filter((e) => e.pickupAvailable);
      bits.push('with pickup');
    }
    for (const d of diets) {
      pool = pool.filter((e) => e.dietaryTags.some((t) => tagKey(t) === tagKey(d) || (d === 'vegetarian' && tagKey(t) === 'vegan')));
      bits.push(d);
    }
    let scored = pool.map((e) => ({ e, s: 1 }));
    if (q.length) {
      scored = pool
        .map((e) => {
          const fields: [string[], number][] = [
            [tokenize(e.name), 1],
            [e.cuisines.flatMap(tokenize), 0.95],
            [e.dishNames.flatMap(tokenize), 0.75],
            [e.categoryNames.flatMap(tokenize), 0.65],
          ];
          const per = q.map((w) => Math.max(...fields.map(([ts, wt]) => wt * bestWordSim(w, ts))));
          return { e, s: Math.min(...per) >= 0.6 ? per.reduce((a, b) => a + b, 0) / per.length : 0 };
        })
        .filter((x) => x.s > 0);
      bits.unshift(q.join(' '));
    }
    const dist = (e: DirectoryEntry) => (this.c.geo && e.lat != null && e.lng != null ? haversineKm(this.c.geo.lat, this.c.geo.lng, e.lat, e.lng) : null);
    scored.sort((a, b) => {
      const da = dist(a.e);
      const db = dist(b.e);
      if (near && da !== null && db !== null && Math.abs(da - db) > 0.05) return da - db;
      return b.s - a.s || Number(b.e.openNow) - Number(a.e.openNow) || (b.e.rating ?? 0) - (a.e.rating ?? 0) || a.e.name.localeCompare(b.e.name);
    });

    if (!scored.length) {
      return this.reply(`I couldn't find a restaurant for ${bits.length ? `"${bits.join(', ')}"` : 'that'}. Try a cuisine ("pizza", "indian"), a dish, or a restaurant name.`, this.starterChips(), 'find-empty');
    }
    const top = scored.slice(0, 6).map((x) => x.e);
    const noGeo = near && !this.c.geo ? " I can't see your location, so I'm showing the best matches instead of the closest." : '';
    const text = `${scored.length} restaurant${scored.length > 1 ? 's' : ''} ${bits.length ? `for ${bits.join(', ')}` : 'on FORKSY'}${scored.length > 6 ? ' (showing 6)' : ''}: ${list(top.map((e) => `${e.name}${e.openNow ? '' : ' (closed now)'}`))}.${noGeo} Tap one to start an order.`;
    return this.reply(text, top.slice(0, 5).map((e) => chip(e.name, `restaurant:${e.slug}`)), 'find', { restaurants: top.map(toCard) });
  }
}
