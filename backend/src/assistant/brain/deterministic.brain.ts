import { FILLER, bestWordSim, money, normalize, parsePriceCap, parseQuantity, tokenize, wordSim } from './nlp';
import type { AddResult, AssistantBrain, BotCard, BotChip, BotResult, BrainContext, KItem, Knowledge } from './brain.types';
import { ALLERGY_WARNING, MAX_CARDS, allergenText, cardOf, cardsOf, chip, dowIn, DAY_NAMES, fmtTime, hoursForDay, hoursLines, uniqChips } from './reply';
import { MAX_LINES, MAX_QTY, MAX_NOTE } from './tools';
import { contentTokens, detectDiet, hasTag, matchCategory, matchOptions, rankItems, residueAfterItem, resolveItem, scoreItem } from './search';
import type { Resolution } from './search';
import { CentralRun } from './central.brain';

// ------------------------------------------------------------------ shared guards (also used by the central bot)
const INJECTION = new RegExp(
  [
    'ignore (all |any |the |your |previous |prior |above |earlier )+(instructions?|rules?|prompts?|messages?|guidelines)',
    'disregard (all |any |the |your |previous )*(instructions?|rules?|prompts?)',
    'forget (everything|all|your|the)',
    'system prompt|developer message|developer mode|jailbreak|\\bdan mode\\b|do anything now',
    '(your|the) (hidden |secret |initial |original )?(instructions?|prompt|rules|guidelines|programming|configuration)',
    '(reveal|show|print|repeat|leak|tell me|output|display|dump) .{0,30}(prompt|instructions?|rules|secret|password|api ?key|bot ?key|token|config|environment|env\\b|source code)',
    'you are now|act as (?!a customer)|pretend (to be|you are|that)|roleplay|role play|from now on you',
    '(other|another|all|every) restaurants?s? (data|menus?|orders?|customers?|info|secrets?|database|keys?)',
    '(database|sql|select \\* |drop table|union select|\\bexec\\b|<script|\\bsudo\\b|\\brm -rf\\b|process\\.env|\\$\\{)',
    "(customer|user|owner|admin|staff|driver)s? (list|data|emails?|phones?|passwords?|addresses|info|details)",
    'bot ?key|api ?key|admin password',
  ].join('|'),
  'i',
);

const OFF_TOPIC = /\b(poem|poetry|essay|joke|jokes|riddle|story|homework|python|javascript|typescript|java\b|c\+\+|program(ming)?|write (me )?(a |an )?(code|script|function|email|letter|song)|weather|forecast|stock|stocks|bitcoin|crypto|president|prime minister|election|politic\w*|translate|capital of|who (is|was) (the )?(president|king|queen)|meaning of life|sing|song|movie|netflix|sports? score|horoscope|calculate|solve|equation|math|trivia|chatgpt|openai|gpt|llm|language model|are you (an? )?(ai|robot|human|real)|your name is)\b/i;

export const isInjection = (m: string) => INJECTION.test(m);
export const isOffTopic = (m: string) => OFF_TOPIC.test(m);

const GREETING = /^(hi|hii|hello|hey|heya|hiya|yo|howdy|hola|bonjour|good (morning|afternoon|evening)|sup|whats up)\b[\s!.,]*$/;
const THANKS = /^(thanks|thank you|thankyou|thx|ty|cheers|much appreciated|great thanks|ok thanks|okay thanks|perfect thanks|awesome thanks)\b/;
const BYE = /^(bye|goodbye|see you|see ya|cya|later|good night|have a good (day|one)|talk later)\b/;
const DONE = /^(that s (all|it)|thats (all|it)|that is (all|it)|nothing else|no(pe)? that s (all|it)|i m done|im done|all done|nope|no thanks|no thank you|no more|im good|i m good|that will be all|thats everything)\b/;
const HELP = /\b(help|what can you do|how does this work|how do (i|you)|commands|what do you do|how to order|instructions for ordering)\b/;
const CANCEL_WORDS = /^(cancel|never ?mind|forget it|skip( it)?|stop|no|none|nothing|no thanks|nah)$/;

const SUPPORT_ORDER = /\b(where is my order|where s my order|order status|track(ing)? (my|the) order|my order (is )?(late|cold|wrong|missing|cancel\w*)|refund|charged|chargeback|wrong order|missing item|cancel (my )?(order|delivery)|driver|courier|late order|order (number|id)|existing order|previous order|past order|reorder|re-order|receipt|invoice)\b/;
const HUMAN = /\b(human|real person|agent|representative|customer (service|support|care)|support|complain\w*|manager|speak to|talk to (a |an |the )?(person|someone|human|owner|manager))\b/;

const CART_WORDS = /\b(cart|basket|bag|tray)\b/;
const CART_VIEW = /\b(my cart|my basket|what s in (my|the) (cart|basket|order)|whats in (my|the) (cart|basket|order)|show (me )?(the |my )?(cart|basket|order)|view (my |the )?(cart|basket|order)|see (my |the )?(cart|basket|order)|cart total|order summary|what have i (ordered|added|got)|what do i have|how much (is|will|does) (my|the) (cart|order|total)|so far|total so far|subtotal)\b/;
const CLEAR = /\b(clear|empty|reset|wipe|flush)\b.*\b(cart|basket|order|everything|all)\b|\b(start over|start again|start fresh|remove (everything|all)|delete (everything|all)|cancel (everything|all)|cancel (my )?(cart|basket))\b|^(clear|empty|reset)( it)?$/;
const REMOVE = /^(please )?(remove|delete|drop|take off|take out|get rid of|cancel|undo|scratch|ditch|no more|i don t want|i dont want|i no longer want)\b/;
const CHECKOUT = /\b(check ?out|place (my |the )?order|ready to (order|pay)|pay now|pay for (it|this)|proceed|complete (my |the )?order|finish (my |the )?order|submit (my |the )?order|confirm (my |the )?order|let me pay|send it|buy now|go to payment|order now|i m ready|im ready)\b|^(done|finish|finished|pay)$/;

const NOTE_LEAD = /^(?:please |pls )?(?:add |put |leave |write |include |attach )?(?:a |an |the )?(?:kitchen |special |order |delivery |cooking |extra )?(?:note|notes|instruction|instructions|request|comment|remark)s?(?: for the (?:kitchen|restaurant|chef|cook)| to the (?:kitchen|restaurant|chef))?\s*[:\-]?\s*(.*)$/;
const NOTE_START = /^(no|without|hold|skip|dont|do not|leave out|leave off|light|easy|go easy|less|well done|extra|make it|make them|make sure|please make|can (?:you|i|we) (?:have|get|please)|on the side|sauce on|allergic|allergy|i m allergic|im allergic)\b/;
const NOTE_MARKERS = ['no', 'without', 'hold', 'skip', 'light', 'easy', 'well', 'crispy', 'mild', 'hot', 'spicy', 'extra', 'less', 'dont'];
const ALLERGY = /\b(allerg\w*|intoleran\w*|celiac|coeliac|anaphyla\w*|epipen)\b/;
const ALLERGY_STATEMENT = /\b(i|im|i m|we|my|someone|somebody|he|she|they)\b.*\b(allerg\w*|intoleran\w*|celiac|coeliac)|\b(allerg\w*|intoleran\w*)\s*[:\-]|^allerg\w*|^(no|without) (any )?(nuts?|peanuts?|shellfish|gluten|dairy|eggs?)\b.*(allerg|please|serious)/;
const ALLERGEN_WORDS = ['peanut', 'tree nut', 'nut', 'almond', 'cashew', 'walnut', 'pistachio', 'hazelnut', 'pecan', 'milk', 'dairy', 'lactose', 'egg', 'wheat', 'gluten', 'soy', 'soya', 'sesame', 'fish', 'shellfish', 'shrimp', 'prawn', 'crab', 'lobster', 'mustard', 'sulphite', 'sulfite', 'celery', 'lupin', 'mollusc', 'corn', 'coconut', 'mushroom', 'garlic', 'onion'];

const HOURS = /\b(hours?|open|opens|opening|close|closes|closing|closed|till what time|until when|what time)\b/;
const PREP = /\b(how long|wait(ing)? time|prep(aration)? time|ready in|how fast|how quick(ly)?|eta|time to (make|prepare|cook)|take to (make|prepare|cook)|delivery time|how soon)\b/;
const DELIVERY = /\b(deliver\w*|pick ?up|pick-up|take ?out|take ?away|collect\w*|curbside|dine ?in|eat in)\b/;
const MINIMUM = /\b(minimum|min\.? order|min spend|smallest order)\b/;
const ADDRESS = /\b(address|where are you|where is the (restaurant|store|shop)|located|location|directions|parking|find you|how do i get)\b/;
const PHONE = /\b(phone|call|telephone|number|contact|email|reach (you|the))\b/;
const PAYMENT = /\b(pay|payment|cash|credit|debit|visa|mastercard|apple pay|google pay|tip|tipping|promo\w*|coupon|discount|voucher|gift ?card|deal|offers?|tax|hst|fee|fees|surcharge|service charge)\b/;
const RECOMMEND = /\b(recommend\w*|suggest\w*|popular|best ?sell\w*|bestsellers?|favou?rites?|whats good|what s good|what should (i|we)|surprise me|top (items|picks|sellers)|signature|must try|specials?|good here|what do people (get|order)|can t decide|cant decide|not sure what|dont know what|don t know what|your pick|chef s)\b/;
const PAIRING = /\b(goes? (well )?with|go with|pair\w*|go(es)? well|complement\w*|what (else )?(should|can|could) i (add|get|have|order)|anything (else|to go with)|something to go with|to go with|(sides?|drinks?|dessert|desserts|beverages?) (for|with|to go)|what (drink|side|dessert|beverage)s? (go|goes|should)|(add|any) (a )?(side|drink|dessert)s?)\b/;
const CHEAP = /\b(cheap\w*|budget|affordable|inexpensive|least expensive|lowest price|low price|bargain|value)\b/;
const LISTING = /\b(menu|categor(y|ies)|what (do|can|could) (you|i|we)|whats (on|good|there|available)|what s (on|good|there|available)|show( me)?|list|options?|do you (have|serve|sell|offer|do)|have you got|got any|any |anything|looking for|looking to|sell|serve|offer|available|choices?|selection|section)\b/;
const PRICE_Q = /\b(how much|price|prices|cost|costs|priced|what s the price|whats the price)\b/;
const INFO_Q = /\b(what s in|whats in|what is in|what is|whats|tell me (more )?about|describe|description|ingredients?|made (of|with|from)|calories|contain\w*|come with|comes with|include\w*|how big|size|serves?|portion)\b/;
const PROMO_Q = /\b(promo\w*|coupon|discount|voucher|gift ?card|code)\b/;

const DOW_WORDS: [RegExp, number][] = [
  [/\b(sun|sunday)\b/, 0],
  [/\b(mon|monday)\b/, 1],
  [/\b(tue|tues|tuesday)\b/, 2],
  [/\b(wed|weds|wednesday)\b/, 3],
  [/\b(thu|thur|thurs|thursday)\b/, 4],
  [/\b(fri|friday)\b/, 5],
  [/\b(sat|saturday)\b/, 6],
];

const DRINK_CLASS = /drink|beverage|\bpop\b|soda|juice|shake|coffee|\btea\b|water|smoothie|lemonade|beer|wine|cola|latte|espresso|milkshake|refresh/i;
const SIDE_CLASS = /\bsides?\b|starter|appetizer|appetiser|snack|fries|salad|wings|bread|soup|extras?|small plates?|dips?/i;
const DESSERT_CLASS = /dessert|sweet|cake|ice cream|bakery|treat|cookie|pastry|brownie|pie\b|donut|doughnut|candy|chocolate/i;
type FoodClass = 'drink' | 'side' | 'dessert';
const CLASS_RE: Record<FoodClass, RegExp> = { drink: DRINK_CLASS, side: SIDE_CLASS, dessert: DESSERT_CLASS };
const CLASS_LABEL: Record<FoodClass, string> = { drink: 'drinks', side: 'sides', dessert: 'desserts' };

const classOf = (i: KItem): FoodClass | null => {
  const hay = `${i.category ?? ''} ${i.name}`;
  if (DRINK_CLASS.test(i.category ?? '') || (!i.category && DRINK_CLASS.test(i.name))) return 'drink';
  if (SIDE_CLASS.test(i.category ?? '')) return 'side';
  if (DESSERT_CLASS.test(i.category ?? '')) return 'dessert';
  if (DRINK_CLASS.test(hay)) return 'drink';
  if (SIDE_CLASS.test(hay)) return 'side';
  if (DESSERT_CLASS.test(hay)) return 'dessert';
  return null;
};

const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** Quick-reply payload grammar. Anything else is refused. */
const QUICK = /^(add|pick|opt|cat|remove|inc|dec|chg|kb|note|restaurant|pair|faq|find|more):?[A-Za-z0-9_\-:.,' ]{0,120}$|^(menu|cart|checkout|popular|recommend|clear|cancel|hours|delivery|help|faq|confirm|cheapest|veg|open)$/;
export const isValidQuick = (q: string) => q.length <= 160 && QUICK.test(q);

export class DeterministicBrain implements AssistantBrain {
  readonly name = 'deterministic';

  async respond(ctx: BrainContext): Promise<BotResult> {
    if (ctx.scope === 'central' && !ctx.kb) return new CentralRun(ctx).run();
    return new RestaurantRun(ctx).run();
  }
}

// ====================================================================================================================
class RestaurantRun {
  private kb: Knowledge;
  private m: string;
  private saved: BrainContext['draft']['pending'] = null;

  constructor(private c: BrainContext) {
    this.kb = c.kb!;
    this.m = normalize(c.message);
  }

  private get draft() {
    return this.c.draft;
  }
  private get tools() {
    return this.c.tools!;
  }
  private get r() {
    return this.kb.restaurant;
  }

  // ------------------------------------------------------------------ router
  run(): BotResult {
    const { quick } = this.c;
    if (quick) return this.handleQuick(quick);
    const m = this.m;
    if (!m) return this.fallback();
    if (isInjection(m)) return this.refuseInjection();

    // an unanswered question comes first (e.g. "which size?" -> "large")
    const pr = this.handlePending();
    if (pr) return pr;

    if (GREETING.test(m)) return this.greeting();
    if (THANKS.test(m)) return this.reply(`You're welcome! Anything else from ${this.r.name}?`, this.homeChips());
    if (BYE.test(m)) return this.reply(this.draft.cart.length ? 'Bye for now! Your cart will be waiting here for a while, and you can check out any time.' : 'Bye! Come back any time.', this.draft.cart.length ? this.cartChips() : []);
    if (DONE.test(m)) return this.draft.cart.length ? this.checkout() : this.reply(`No problem. Let me know if you would like to see the menu.`, this.homeChips());
    if (isOffTopic(m) && !this.mentionsMenu(m)) return this.offTopic();

    if (SUPPORT_ORDER.test(m)) return this.supportOrder();
    if (CLEAR.test(m)) return this.clear();
    if (REMOVE.test(m)) {
      const r = this.remove();
      if (r) return r;
    }
    const qty = this.changeQuantity();
    if (qty) return qty;
    const mk = this.makeIt();
    if (mk) return mk;
    if (CHECKOUT.test(m) && !/\b(can|do|does|how|what|where|which)\b/.test(m)) return this.checkout();
    if (CART_VIEW.test(m) || /^(cart|basket|my order)$/.test(m)) return this.viewCart();

    // notes and allergies
    const note = this.noteIntent();
    if (note) return note;

    // restaurant-written FAQ with a strong match beats the built-in answers
    const faq = this.matchFaq();
    if (faq && faq.score >= 0.75) return this.faqAnswer(faq.index);

    // explicit add
    const add = this.addIntent();
    if (add) return add;

    if (ALLERGY.test(m) || /\b(contain\w*|gluten|nuts?|peanuts?|dairy|lactose|shellfish|egg|eggs|soy|sesame)\b/.test(m)) {
      const a = this.allergenQuestion();
      if (a) return a;
    }
    if (PRICE_Q.test(m)) {
      const p = this.priceQuestion();
      if (p) return p;
    }
    if (INFO_Q.test(m)) {
      const p = this.infoQuestion();
      if (p) return p;
    }
    if (HUMAN.test(m)) return this.human();
    if (PREP.test(m)) return this.prep();
    if (MINIMUM.test(m)) return this.minimum();
    if (HOURS.test(m) && !/\b(open the menu|opening menu)\b/.test(m)) return this.hours();
    if (DELIVERY.test(m)) return this.delivery();
    if (ADDRESS.test(m)) return this.address();
    if (PHONE.test(m) && !/\b(phone number for|my phone|my number)\b/.test(m)) return this.contact();
    if (PROMO_Q.test(m) || PAYMENT.test(m)) return this.payment();
    if (HELP.test(m)) return this.help();
    if (PAIRING.test(m)) return this.pairing();
    if (RECOMMEND.test(m)) return this.recommend();

    const found = this.search();
    if (found) return found;

    if (faq && faq.score >= 0.5) return this.faqAnswer(faq.index);

    const implicit = this.implicitItem();
    if (implicit) return implicit;

    return this.fallback();
  }

  /** item lookup: restaurant-specific aliases (training hook) first, then the fuzzy matcher */
  private resolve(phrase: string, kb: Knowledge): Resolution {
    const id = this.c.hooks?.aliases?.resolve(kb.restaurant.id, contentTokens(phrase).join(' '));
    const hit = id ? kb.items.find((i) => i.id === id) : undefined;
    if (hit) return { kind: 'one', match: { item: hit, score: 1 }, fuzzy: false };
    return resolveItem(phrase, kb);
  }

  // ------------------------------------------------------------------ small builders
  private reply(text: string, chips: BotChip[] = [], extra: Partial<BotResult> = {}): BotResult {
    return { text, chips: uniqChips(chips), ...extra };
  }

  private mentionsMenu(m: string): boolean {
    const q = contentTokens(m);
    return rankItems(q, this.kb).some((x) => x.score >= 0.8);
  }

  private subtotalLine(): string {
    const s = this.c.cart();
    return s.count ? `Cart: ${s.count} item${s.count > 1 ? 's' : ''}, about ${money(s.subtotal)} (final price is shown at checkout).` : '';
  }

  private homeChips(): BotChip[] {
    const chips = [chip('Menu', 'menu'), chip('Popular', 'popular')];
    if (this.draft.cart.length) chips.push(chip('View cart', 'cart'), chip('Checkout', 'checkout'));
    chips.push(chip('Hours', 'hours'));
    if (this.kb.faqs.length) chips.push(chip('Questions', 'faq'));
    return chips;
  }

  private cartChips(): BotChip[] {
    return [chip('Checkout', 'checkout'), chip('View cart', 'cart'), chip('Menu', 'menu'), chip('Popular', 'popular')];
  }

  /** chips offered after something was added: view cart, checkout, and a pairing the cart is missing */
  private afterAddChips(): BotChip[] {
    const have = new Set(this.draft.cart.map((l) => this.kb.items.find((i) => i.id === l.menuItemId)).filter((i): i is KItem => !!i).map(classOf));
    const chips: BotChip[] = [chip('View cart', 'cart'), chip('Checkout', 'checkout')];
    for (const k of ['drink', 'side', 'dessert'] as FoodClass[]) {
      if (!have.has(k) && this.kb.items.some((i) => i.available && classOf(i) === k)) chips.push(chip(`Add ${CLASS_LABEL[k]}?`, `pair:${k}`));
    }
    chips.push(chip('Menu', 'menu'));
    return chips;
  }

  // ------------------------------------------------------------------ refusals / small talk
  private refuseInjection(): BotResult {
    return this.reply(`I can't help with that. I'm ${this.kb.assistantName}, and I only help with ordering from ${this.r.name}: the menu, prices, hours, delivery and your cart.`, this.homeChips(), { intent: 'refuse' });
  }

  private offTopic(): BotResult {
    return this.reply(`That's outside what I can help with. I can answer questions about ${this.r.name} and help you build an order.`, this.homeChips(), { intent: 'off-topic' });
  }

  private greeting(): BotResult {
    const g = this.kb.greeting?.trim();
    return this.reply(g || `Hi! I'm ${this.kb.assistantName}. I can show the menu, suggest dishes, answer questions about ${this.r.name} and add things to your cart.`, this.homeChips(), { intent: 'greeting' });
  }

  private help(): BotResult {
    return this.reply(
      `I can show the menu and categories, recommend dishes, filter by diet or budget ("vegetarian under $12"), answer questions about hours, delivery and pickup, and build your cart ("add 2 margherita and a pop", "remove the pop", "no onions"). When you are ready, tap Checkout and I will take you to FORKSY to pay.`,
      this.homeChips(),
      { intent: 'help' },
    );
  }

  private fallback(): BotResult {
    if (this.saved) {
      this.draft.pending = this.saved;
      return this.reAsk(this.saved);
    }
    const chips = this.homeChips();
    return this.reply(`I'm not sure I understood that. I can only help with ordering from ${this.r.name}. Try "show the menu", "what's popular", "add a margherita", or ask about hours or delivery.`, chips, { intent: 'unknown' });
  }

  private supportOrder(): BotResult {
    const phone = this.r.phone ? ` or call ${this.r.name} at ${this.r.phone}` : '';
    return this.reply(
      `I can only help you put together a new order. I can't see or change an order that has already been placed. For help with an existing order, open it in your FORKSY account and use Help${phone}.`,
      this.homeChips(),
      { intent: 'support' },
    );
  }

  private human(): BotResult {
    const phone = this.r.phone ? ` You can also call ${this.r.name} at ${this.r.phone}.` : '';
    const chips = this.kb.faqs.length ? [chip('Common questions', 'faq')] : [];
    return this.reply(`I'm an automated assistant, so I can't connect you to a person from here. For account or order problems, use Help in your FORKSY account.${phone}`, [...chips, ...this.homeChips()], { intent: 'human' });
  }

  // ------------------------------------------------------------------ quick replies (chips)
  private handleQuick(q: string): BotResult {
    if (!isValidQuick(q)) return this.reply("I didn't understand that button. Here is what I can do.", this.homeChips(), { intent: 'bad-quick' });
    const [verb, ...restParts] = q.split(':');
    const arg = restParts.join(':');
    switch (verb) {
      case 'menu':
        return this.menuOverview();
      case 'cart':
        return this.viewCart();
      case 'checkout':
        return this.checkout();
      case 'popular':
      case 'recommend':
        return this.recommend();
      case 'clear':
        return this.clear();
      case 'cancel':
        this.tools.cancelPending();
        return this.reply('No problem, I cancelled that.', this.homeChips(), { intent: 'cancel' });
      case 'hours':
        return this.hours();
      case 'delivery':
        return this.delivery();
      case 'help':
        return this.help();
      case 'cheapest':
        return this.listItems(this.cheapest(), 'The lowest-priced items on the menu');
      case 'veg':
        return this.searchTags(['vegetarian']);
      case 'open':
      case 'confirm':
      case 'restaurant':
        return this.reply(this.c.scope === 'central' ? 'Tell me what you are in the mood for.' : `I'm already set up for ${this.r.name}. What would you like?`, this.homeChips());
      case 'faq': {
        if (!arg) return this.faqList();
        const n = Number(arg);
        return Number.isInteger(n) && this.kb.faqs[n] ? this.faqAnswer(n) : this.faqList();
      }
      case 'pair':
        return arg === 'drink' || arg === 'side' || arg === 'dessert' ? this.pairingFor(arg) : this.pairing();
      case 'cat':
        return this.showCategory(arg);
      case 'add': {
        const [id, qtyRaw] = arg.split(':');
        const qty = qtyRaw ? Number(qtyRaw) : 1;
        return this.fromAdd(this.tools.addItem({ menuItemId: id, quantity: qty }), qty);
      }
      case 'pick':
        return this.pick(arg);
      case 'opt':
        return this.answerOption(arg);
      case 'remove': {
        const line = this.draft.cart.find((l) => l.lineId === arg);
        const name = line ? this.kb.items.find((i) => i.id === line.menuItemId)?.name : null;
        const res = this.tools.removeLine(arg);
        return res.ok ? this.reply(`Removed ${name ?? 'the item'} from your cart.`, this.cartViewChips(), { intent: 'remove' }) : this.reply("I couldn't find that item in your cart.", this.cartViewChips());
      }
      case 'inc':
      case 'dec': {
        const line = this.draft.cart.find((l) => l.lineId === arg);
        if (!line) return this.reply("I couldn't find that item in your cart.", this.cartViewChips());
        const next = verb === 'inc' ? line.quantity + 1 : line.quantity - 1;
        if (next < 1) {
          this.tools.removeLine(arg);
          return this.viewCart(true);
        }
        const res = this.tools.setLineQuantity(arg, next);
        if (!res.ok) return this.reply(`The most I can hold on one line is ${MAX_QTY}.`, this.cartViewChips());
        return this.viewCart(true);
      }
      case 'chg': {
        const [lineId, optionId] = arg.split(':');
        return this.applyOption(lineId, optionId);
      }
      case 'note':
        return this.saveNote(arg, true);
      case 'find':
      case 'more':
      default:
        return this.reply('Tell me what you would like.', this.homeChips());
    }
  }

  private cartViewChips(): BotChip[] {
    return this.draft.cart.length ? [chip('Checkout', 'checkout'), chip('Menu', 'menu'), chip('Clear cart', 'clear')] : [chip('Menu', 'menu'), chip('Popular', 'popular')];
  }

  // ------------------------------------------------------------------ pending questions
  private handlePending(): BotResult | null {
    const p = this.draft.pending;
    if (!p) return null;
    const m = this.m;
    if (CANCEL_WORDS.test(m)) {
      this.tools.cancelPending();
      return this.reply('No problem, I cancelled that.', this.homeChips(), { intent: 'cancel' });
    }
    if (p.kind === 'modifiers') {
      const item = this.kb.items.find((i) => i.id === p.menuItemId);
      if (item) {
        const group = item.groups.find((g) => this.groupNeeds(g, p.chosen));
        if (group) {
          const nth = /^(?:option |number |no\.? |#)?(\d{1,2})$/.exec(m);
          const byNumber = nth ? group.options.filter((o) => o.available)[Number(nth[1]) - 1] : undefined;
          const tokens = tokenize(this.c.message).filter((t) => !FILLER.has(t) || t === 'extra');
          const hit = byNumber ? [byNumber] : matchOptions(tokens, item).filter((o) => group.options.some((x) => x.id === o.id));
          if (hit.length) return this.fromAdd(this.tools.answerOption(hit[0].id), p.quantity);
        }
      }
    } else if (p.kind === 'choose') {
      const nth = /^(?:option |number |no\.? |#)?(\d{1,2})$/.exec(m);
      const ids = p.menuItemIds;
      if (nth && ids[Number(nth[1]) - 1]) return this.pick(ids[Number(nth[1]) - 1]);
      if (/^(yes|yeah|yep|yup|sure|ok|okay|correct|that one|please)\b/.test(m) && ids.length === 1) return this.pick(ids[0]);
      const candidates = ids.map((id) => this.kb.items.find((i) => i.id === id)).filter((i): i is KItem => !!i);
      const q = contentTokens(m);
      const ranked = candidates.map((item) => ({ item, score: scoreItem(q, item) })).filter((x) => x.score >= 0.7).sort((a, b) => b.score - a.score);
      if (ranked.length && (ranked.length === 1 || ranked[0].score - ranked[1].score >= 0.1)) return this.pick(ranked[0].item.id);
    } else if (p.kind === 'switch') {
      // only the central bot creates this; the service handles it, but be safe
      this.draft.pending = null;
    }
    // not an answer: remember the question, process the message normally and re-ask if nothing else matches
    this.saved = p;
    this.draft.pending = null;
    return null;
  }

  private groupNeeds(g: { id: string; required: boolean; min: number; options: { id: string }[] }, chosen: string[]): boolean {
    const need = g.required ? Math.max(1, g.min) : g.min;
    return chosen.filter((id) => g.options.some((o) => o.id === id)).length < need;
  }

  private reAsk(p: NonNullable<BrainContext['draft']['pending']>): BotResult {
    if (p.kind === 'modifiers') {
      const item = this.kb.items.find((i) => i.id === p.menuItemId);
      const g = item?.groups.find((x) => this.groupNeeds(x, p.chosen));
      if (item && g) return this.askGroup(item, g, p.quantity);
    }
    if (p.kind === 'choose') return this.askWhich(p.menuItemIds.map((id) => this.kb.items.find((i) => i.id === id)).filter((i): i is KItem => !!i), p.quantity);
    return this.fallback();
  }

  private pick(itemId: string): BotResult {
    const p = this.draft.pending;
    if (p && p.kind === 'choose' && !p.menuItemIds.includes(itemId)) return this.reply("That wasn't one of the choices. Which one did you mean?", [chip('Cancel', 'cancel')]);
    const qty = p && p.kind === 'choose' ? p.quantity : 1;
    const notes = p && p.kind === 'choose' ? p.notes : undefined;
    const queue = p && p.kind === 'choose' ? p.queue : undefined;
    this.tools.cancelPending();
    return this.fromAdd(this.tools.addItem({ menuItemId: itemId, quantity: qty, note: notes, queue }), qty);
  }

  private answerOption(optionId: string): BotResult {
    const p = this.draft.pending;
    if (!p || p.kind !== 'modifiers') return this.reply('There is nothing to choose right now.', this.homeChips());
    return this.fromAdd(this.tools.answerOption(optionId), p.quantity);
  }

  // ------------------------------------------------------------------ add flow
  private askGroup(item: KItem, g: KItem['groups'][number], qty: number): BotResult {
    const opts = g.options.filter((o) => o.available);
    const more = g.max > 1 ? ` (choose up to ${g.max})` : '';
    const txt = `${qty > 1 ? `${qty} × ` : ''}${item.name}: which ${g.name.toLowerCase()}${more}?\n` + opts.map((o, i) => `${i + 1}. ${o.name}${o.priceDelta ? ` (${o.priceDelta > 0 ? '+' : '-'}${money(Math.abs(o.priceDelta))})` : ''}`).join('\n');
    return this.reply(
      txt,
      [...opts.slice(0, 5).map((o) => chip(`${o.name}${o.priceDelta ? ` ${o.priceDelta > 0 ? '+' : '-'}${money(Math.abs(o.priceDelta))}` : ''}`, `opt:${o.id}`)), chip('Cancel', 'cancel')],
      { cards: [cardOf(item)], intent: 'ask-option' },
    );
  }

  private askWhich(items: KItem[], qty: number, said?: string): BotResult {
    const txt =
      (said ? `I found a few matches for "${said}". ` : '') +
      `Which one${qty > 1 ? ` (${qty} of them)` : ''}?\n` +
      items.map((i, n) => `${n + 1}. ${i.name} — ${money(i.price)}${i.available ? '' : ' (not available now)'}`).join('\n');
    return this.reply(txt, [...items.filter((i) => i.available).slice(0, 5).map((i) => chip(i.name, `pick:${i.id}`)), chip('Cancel', 'cancel')], { cards: cardsOf(items), intent: 'ask-which' });
  }

  private optionNames(optionIds: string[], item: KItem): string[] {
    return item.groups.flatMap((g) => g.options).filter((o) => optionIds.includes(o.id)).map((o) => o.name);
  }

  private addedText(res: AddResult): string {
    const item = res.item!;
    const n = res.added ?? res.line?.quantity ?? 1;
    const opts = this.optionNames(res.line?.modifierOptionIds ?? [], item);
    const note = res.line?.notes ? `, note: "${res.line.notes}"` : '';
    return `${n} × ${item.name}${opts.length ? ` (${opts.join(', ')})` : ''}${note}`;
  }

  /** turn the outcome of ONE add into a reply (and continue with the rest of a multi-item request) */
  private fromAdd(res: AddResult, qty: number, already: string[] = [], missing: string[] = []): BotResult {
    if (res.ok && res.ask && res.item) {
      const lead = already.length ? `Added ${list(already)}. ` : '';
      const miss = missing.length ? `I couldn't find ${list(missing.map((x) => `"${x}"`))} on the menu. ` : '';
      const q = this.askGroup(res.item, res.ask.group, qty);
      return { ...q, text: lead + miss + q.text };
    }
    if (!res.ok) {
      const lead = already.length ? `Added ${list(already)}. ` : '';
      const miss = missing.length ? `I couldn't find ${list(missing.map((x) => `"${x}"`))} on the menu. ` : '';
      return this.reply(`${lead}${miss}${res.message ?? "I couldn't add that."}`, this.draft.cart.length ? this.afterAddChips() : this.homeChips(), { intent: 'add-failed' });
    }
    const added = [...already, this.addedText(res)];
    if (res.queue?.length) return this.addClauses(res.queue, added, missing);
    return this.addedReply(added, missing, res.defaulted?.map((o) => o.name), this.swapChips(res));
  }

  /** after a default was applied ("Regular"), offer the other options of that group as one-tap swaps */
  private swapChips(res: AddResult): BotChip[] {
    if (!res.line || !res.item || !res.defaulted?.length) return [];
    const out: BotChip[] = [];
    for (const d of res.defaulted) {
      const g = res.item.groups.find((x) => x.options.some((o) => o.id === d.id));
      if (!g) continue;
      for (const o of g.options.filter((x) => x.available && x.id !== d.id).slice(0, 2)) {
        out.push(chip(`${o.name}${o.priceDelta ? ` ${o.priceDelta > 0 ? '+' : '-'}${money(Math.abs(o.priceDelta))}` : ''}`, `chg:${res.line.lineId}:${o.id}`));
      }
    }
    return out.slice(0, 3);
  }

  private addedReply(added: string[], missing: string[], defaulted?: string[], swap: BotChip[] = []): BotResult {
    let text = `Added ${list(added)}.`;
    if (defaulted?.length) text += ` (I picked the standard ${list(defaulted)}.)`;
    if (missing.length) text += ` I couldn't find ${list(missing.map((x) => `"${x}"`))} on the menu.`;
    const sub = this.subtotalLine();
    if (sub) text += `\n${sub}`;
    if (!this.r.open && this.r.orderable) text += `\n${this.r.name} is closed right now${this.r.opensAtText ? ` (opens ${this.r.opensAtText})` : ''}; you can still build your order.`;
    const min = this.r.minimumOrder;
    const s = this.c.cart();
    if (min > 0 && s.subtotal < min) text += `\nMinimum order is ${money(min)}; add ${money(min - s.subtotal)} more to check out.`;
    return this.reply(text, [...swap, ...this.afterAddChips()], { intent: 'add' });
  }

  private addIntent(): BotResult | null {
    const m = this.m;
    const ADD_VERB = /^(?:please |pls |ok |okay |and |also |yes |yeah |sure )*(?:(?:can|could|may|might) (?:i|we) (?:please )?(?:get|have|order|add|grab|do)|(?:i|we)(?: ?ll| will| would| d|d) (?:like|take|have|get|order|go for|do|start with)|(?:i|we) (?:want|need|wanna)|(?:id|we d) like|lets? (?:get|have|order)|let me (?:get|have|order)|lemme (?:get|have)|add|adding|order|get|give me|gimme|grab|put|throw in|buy|i ll have|ill have|bring me|make it|include|another|one more|more|extra)\b/;
    const lead = ADD_VERB.exec(m);
    const startsQty = /^(\d{1,3}\b|x\d|a |an |one |two |three |four |five |six |seven |eight |nine |ten |a couple|a dozen|half a dozen|couple |dozen )/.test(m);
    if (!lead && !startsQty) return null;
    // "add a note..." / "add extra napkins" etc. are handled earlier; here we need menu content
    let body = lead ? m.slice(lead[0].length).trim() : m;
    body = body.replace(/\b(to|into|in|onto) (my |the |your )?(cart|basket|order|bag|tray)\b/g, ' ').replace(/\b(please|pls|thanks|thank you)\b/g, ' ').replace(/\s+/g, ' ').trim();
    if (lead && !body) return this.reply('What would you like to add? Try "add 2 margherita" or open the menu.', [chip('Menu', 'menu'), chip('Popular', 'popular')]);
    const clauses = this.splitClauses(body);
    // a message that starts with a number or "a" but names nothing on the menu is probably a question, not an order
    if (!lead) {
      const probe = clauses.map((cl) => this.resolve(contentTokens(parseQuantity(cl).rest.join(' ')).join(' '), this.kb).kind);
      if (!probe.some((k) => k === 'one' || k === 'many')) return null;
      if (/\?$/.test(this.c.message.trim()) || /^(a|an) (lot|bit|few)\b/.test(m)) return null;
    }
    return this.addClauses(clauses);
  }

  private splitClauses(body: string): string[] {
    // whole phrase first: "mac and cheese" is one dish, not two
    const q = contentTokens(parseQuantity(body).rest.join(' ')).join(' ');
    if (q) {
      const whole = this.resolve(q, this.kb);
      if (whole.kind === 'one' && whole.match.score >= 0.92 && /\band\b|&/.test(body)) return [body];
    }
    return body
      .split(/\s*(?:,|;|\band\b|\bplus\b|\bthen\b|\balso\b|\+|\bwith a side of\b)\s*/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /** process a list of clauses ("2 margherita", "a pop", "no olives") one by one; stops at the first question */
  private addClauses(clauses: string[], added: string[] = [], missing: string[] = []): BotResult {
    const out = [...added];
    const miss = [...missing];
    let defaulted: string[] = [];
    let swap: BotChip[] = [];
    for (let i = 0; i < clauses.length; i++) {
      const clause = clauses[i];
      const rest = clauses.slice(i + 1);
      const qp = parseQuantity(clause);
      let tokens = qp.rest;
      // note-only clause ("no onions") -> applies to the previous add of this message, else the whole order
      const mk = tokens.findIndex((t) => ['no', 'without', 'hold', 'skip', 'dont'].includes(t));
      let noteText: string | undefined;
      if (mk === 0) {
        const t = tokens.join(' ');
        const lastLine = this.draft.cart[this.draft.cart.length - 1];
        if (out.length && lastLine) this.tools.setLineNote(lastLine.lineId, [lastLine.notes, t].filter(Boolean).join('; '));
        else this.tools.addOrderNote(t);
        continue;
      }
      if (mk > 0) {
        noteText = tokens.slice(mk).join(' ');
        tokens = tokens.slice(0, mk);
      }
      const phrase = tokens.filter((t) => !FILLER.has(t) || t === 'extra');
      const content = tokens.filter((t) => !FILLER.has(t));
      if (!content.length) continue;
      const res = this.resolve(content.join(' '), this.kb);
      if (res.kind === 'none') {
        // maybe an option / note for the previous item ("with extra cheese")
        const prev = this.draft.cart[this.draft.cart.length - 1];
        const prevItem = prev ? this.kb.items.find((x) => x.id === prev.menuItemId) : undefined;
        if (out.length && prev && prevItem) {
          const ex = matchOptions(tokens, prevItem);
          if (ex.length) {
            const r2 = this.tools.addItem({ menuItemId: prev.menuItemId, quantity: 1, optionIds: [...prev.modifierOptionIds, ...ex.map((o) => o.id)], note: prev.notes });
            if (r2.ok && r2.line) {
              // fold the extra single into the line: move one unit to the customised line
              if (prev.quantity > 1) this.tools.removeLine(prev.lineId, 1);
              else this.tools.removeLine(prev.lineId);
              out.push(`${ex.map((o) => o.name).join(', ')} on the ${prevItem.name}`);
              continue;
            }
          }
        }
        miss.push(content.join(' '));
        continue;
      }
      const qty = qp.qty ?? 1;
      if (res.kind === 'many') {
        this.draft.pending = { kind: 'choose', menuItemIds: res.matches.map((x) => x.item.id), quantity: qty, ...(noteText ? { notes: noteText } : {}), ...(rest.length ? { queue: rest } : {}) };
        const q = this.askWhich(res.matches.map((x) => x.item), qty, content.join(' '));
        const lead = out.length ? `Added ${list(out)}. ` : '';
        return { ...q, text: lead + q.text };
      }
      if (res.kind === 'maybe') {
        const it = res.match.item;
        this.draft.pending = { kind: 'choose', menuItemIds: [it.id], quantity: qty, ...(noteText ? { notes: noteText } : {}), ...(rest.length ? { queue: rest } : {}) };
        const lead = out.length ? `Added ${list(out)}. ` : '';
        return this.reply(`${lead}Did you mean ${it.name} (${money(it.price)})?`, [chip(`Yes, add ${it.name}`.slice(0, 40), `pick:${it.id}`), chip('No', 'cancel')], { cards: [cardOf(it)], intent: 'confirm-item' });
      }
      // exactly one item
      const item = res.match.item;
      // options named in the same clause (words that are not part of the item's own name)
      const optionWords = residueAfterItem(phrase, item);
      let optionIds = matchOptions(optionWords, item).map((o) => o.id);
      // look ahead: following clauses that are only options ("with extra cheese and mushrooms") or notes ("no olives")
      let j = i + 1;
      const notes: string[] = noteText ? [noteText] : [];
      while (j < clauses.length) {
        const nq = parseQuantity(clauses[j]);
        const ntok = nq.rest;
        const head = ntok[0];
        if (['no', 'without', 'hold', 'skip', 'dont'].includes(head)) {
          notes.push(ntok.join(' '));
          j++;
          continue;
        }
        const ncontent = ntok.filter((t) => !FILLER.has(t));
        if (!ncontent.length) {
          j++;
          continue;
        }
        const asItem = this.resolve(ncontent.join(' '), this.kb);
        const asOpt = matchOptions(ntok, item);
        if (asOpt.length && (asItem.kind === 'none' || asItem.kind === 'maybe' || (asItem.kind !== 'one' && asItem.kind !== 'many'))) {
          optionIds = [...new Set([...optionIds, ...asOpt.map((o) => o.id)])];
          j++;
          continue;
        }
        break;
      }
      // leftover words that start with a note marker ("extra spicy", "well done") become an item note
      const named = new Set(content.filter((w) => bestWordSim(w, tokenize(item.name)) >= 0.8 || bestWordSim(w, tokenize(item.category ?? '')) >= 0.85));
      const optTokens = new Set(item.groups.flatMap((g) => g.options.filter((o) => optionIds.includes(o.id)).flatMap((o) => tokenize(o.name))));
      const leftover = tokens.filter((t) => !FILLER.has(t) && !named.has(t) && ![...optTokens].some((ot) => wordSim(t, ot) >= 0.88));
      const mark = leftover.findIndex((t) => NOTE_MARKERS.includes(t));
      if (mark >= 0) notes.push(leftover.slice(mark).join(' '));
      i = j - 1;
      const queue = clauses.slice(j);
      const note = notes.length ? notes.join('; ').slice(0, 300) : undefined;
      const r = this.tools.addItem({ menuItemId: item.id, quantity: qty, optionIds, note, queue });
      if (!r.ok) {
        return this.fromAdd(r, qty, out, miss);
      }
      if (r.ask) return this.fromAdd(r, qty, out, miss);
      out.push(this.addedText(r));
      if (r.defaulted?.length) defaulted = defaulted.concat(r.defaulted.map((o) => o.name));
      swap = this.swapChips(r);
    }
    if (!out.length) {
      if (miss.length) {
        const maybe = rankItems(contentTokens(miss.join(' ')), this.kb)[0];
        const chips = maybe ? [chip(`Add ${maybe.item.name}`.slice(0, 40), `add:${maybe.item.id}`)] : [];
        return this.reply(`I couldn't find ${list(miss.map((x) => `"${x}"`))} on ${this.r.name}'s menu. I only offer what is on the menu${maybe ? `; the closest I have is ${maybe.item.name} (${money(maybe.item.price)})` : ''}.`, [...chips, chip('Menu', 'menu'), chip('Popular', 'popular')], { intent: 'item-not-found', ...(maybe ? { cards: [cardOf(maybe.item)] } : {}) });
      }
      return this.reply('What would you like to add? Try "add 2 margherita" or open the menu.', [chip('Menu', 'menu'), chip('Popular', 'popular')]);
    }
    return this.addedReply(out, miss, defaulted, out.length === 1 + added.length && swap.length ? swap : []);
  }

  /** a bare dish name ("margherita"): show it with an Add button instead of changing the cart on a guess */
  private implicitItem(): BotResult | null {
    const q = contentTokens(this.m);
    if (!q.length || q.length > 5) return null;
    const res = this.resolve(q.join(' '), this.kb);
    if (res.kind === 'one') {
      const i = res.match.item;
      return this.reply(`${i.name} is ${money(i.price)}${i.description ? `. ${i.description}` : ''}${i.available ? '' : ' (not available right now)'}`, [chip(`Add ${i.name}`.slice(0, 40), `add:${i.id}`), chip('Menu', 'menu'), chip('View cart', 'cart')], { cards: [cardOf(i)], intent: 'item' });
    }
    if (res.kind === 'many') return this.reply(`Here are the closest matches for "${this.c.message.trim().slice(0, 40)}":`, [...res.matches.filter((x) => x.item.available).slice(0, 4).map((x) => chip(`Add ${x.item.name}`.slice(0, 40), `add:${x.item.id}`)), chip('Menu', 'menu')], { cards: cardsOf(res.matches.map((x) => x.item)), intent: 'items' });
    return null;
  }

  /** "make it large", "change the margherita to extra cheese", "upgrade to large": change an option on a line already in the cart */
  private makeIt(): BotResult | null {
    if (!this.draft.cart.length) return null;
    const m = this.m;
    let target: string | null = null;
    let rest: string | null = null;
    const a = /^(?:please |actually |and |ok |okay )*(?:make|change|switch|swap|turn|set)\s+(it|that|them|this|those|the .+?|my .+?)\s+(?:to |into |a |an )?(.+)$/.exec(m);
    if (a) {
      target = a[1];
      rest = a[2];
    } else {
      const b = /^(?:please |actually |and |ok |okay )*(?:upgrade|go|switch|change) (?:it )?to (.+)$/.exec(m);
      if (b) {
        target = 'it';
        rest = b[1];
      }
    }
    if (!target || !rest) return null;
    let line = this.draft.cart[this.draft.cart.length - 1];
    if (!/^(it|that|them|this|those)$/.test(target)) {
      const q = contentTokens(target.replace(/^(the|my) /, ''));
      const hit = this.draft.cart
        .map((l) => ({ l, item: this.kb.items.find((i) => i.id === l.menuItemId) }))
        .filter((x): x is { l: (typeof this.draft.cart)[number]; item: KItem } => !!x.item)
        .map((x) => ({ ...x, score: scoreItem(q, x.item) }))
        .filter((x) => x.score >= 0.6)
        .sort((x, y) => y.score - x.score)[0];
      if (!hit) return null;
      line = hit.l;
    }
    const item = this.kb.items.find((i) => i.id === line.menuItemId);
    if (!item) return null;
    const opts = matchOptions(tokenize(rest), item);
    if (!opts.length) return null;
    return this.applyOption(line.lineId, opts[0].id);
  }

  private applyOption(lineId: string, optionId: string): BotResult {
    const res = this.tools.changeOption(lineId, optionId);
    if (!res.ok || !res.line || !res.item || !res.option) return this.reply("I couldn't change that option.", this.cartViewChips(), { intent: 'option-failed' });
    const names = this.optionNames(res.line.modifierOptionIds, res.item);
    return this.reply(`Updated ${res.item.name}: ${names.join(', ')}${res.option.priceDelta ? ` (${res.option.priceDelta > 0 ? '+' : '-'}${money(Math.abs(res.option.priceDelta))} each)` : ''}.
${this.subtotalLine()}`, this.afterAddChips(), { intent: 'option' });
  }

  /** "what's in the margherita", "tell me about the wings": description, tags and the allergens the restaurant recorded */
  private infoQuestion(): BotResult | null {
    const q = contentTokens(this.m.replace(INFO_Q, ' ').replace(/\b(is|are|the|a|an|of|in|on|it|this|that|does|do|have|has|there|for|with|me)\b/g, ' '));
    if (!q.length) return null;
    const res = this.resolve(q.join(' '), this.kb);
    if (res.kind !== 'one' && res.kind !== 'maybe') return null;
    const i = res.match.item;
    const desc = i.description ? ` ${i.description.replace(/[.]+$/, '')}.` : '';
    const text = `${i.name} is ${money(i.price)}.${desc} ${cap(allergenText(i))}.${i.available ? '' : ' It is not available right now.'}`;
    return this.reply(text, [chip(`Add ${i.name}`.slice(0, 40), `add:${i.id}`), chip('Menu', 'menu')], { cards: [cardOf(i)], intent: 'item-info' });
  }

  // ------------------------------------------------------------------ cart
  viewCart(afterChange = false): BotResult {
    const s = this.c.cart();
    if (!s.lines.length) return this.reply(afterChange ? 'Your cart is empty now.' : 'Your cart is empty. Want to see the menu or what is popular?', [chip('Menu', 'menu'), chip('Popular', 'popular')], { intent: 'cart' });
    const lines = s.lines.map((l) => `${l.quantity} × ${l.name}${l.options.length ? ` (${l.options.map((o) => o.name).join(', ')})` : ''}${l.notes ? ` — note: ${l.notes}` : ''} — ${money(l.lineTotal)}`);
    let text = `Your cart:\n${lines.join('\n')}\nEstimated subtotal: ${money(s.subtotal)} (final price is shown at checkout).`;
    if (this.draft.orderNote) text += `\nKitchen note: ${this.draft.orderNote}`;
    const min = this.r.minimumOrder;
    if (min > 0 && s.subtotal < min) text += `\nMinimum order is ${money(min)}; add ${money(min - s.subtotal)} more to check out.`;
    const chips = [chip('Checkout', 'checkout'), chip('Menu', 'menu'), chip('Clear cart', 'clear')];
    if (s.lines.length === 1) chips.splice(1, 0, chip('+1', `inc:${s.lines[0].lineId}`), chip('-1', `dec:${s.lines[0].lineId}`));
    return this.reply(text, chips, { intent: 'cart' });
  }

  private clear(): BotResult {
    const had = this.draft.cart.length;
    this.tools.clearCart();
    this.tools.clearOrderNote();
    return this.reply(had ? 'Done, I cleared your cart and kitchen note.' : 'Your cart was already empty.', [chip('Menu', 'menu'), chip('Popular', 'popular')], { intent: 'clear' });
  }

  private remove(): BotResult | null {
    const body = this.m.replace(REMOVE, '').replace(/\b(from|out of|off) (my |the )?(cart|basket|order|bag|tray)\b/g, ' ').replace(/\s+/g, ' ').trim();
    if (!body || /^(everything|all|it all|all of it)$/.test(body)) return this.clear();
    if (/^(the )?(note|notes|kitchen note|instructions?)$/.test(body)) {
      this.tools.clearOrderNote();
      return this.reply('I removed your kitchen note.', this.cartViewChips(), { intent: 'note' });
    }
    if (!this.draft.cart.length) return this.reply('Your cart is empty, so there is nothing to remove.', [chip('Menu', 'menu')], { intent: 'remove' });
    const qp = parseQuantity(body);
    const q = qp.rest.filter((t) => !FILLER.has(t));
    if (!q.length) return null;
    const scored = this.draft.cart
      .map((l) => ({ l, item: this.kb.items.find((i) => i.id === l.menuItemId) }))
      .filter((x): x is { l: (typeof this.draft.cart)[number]; item: KItem } => !!x.item)
      .map((x) => ({ ...x, score: scoreItem(q, x.item) }))
      .filter((x) => x.score >= 0.55)
      .sort((a, b) => b.score - a.score);
    if (!scored.length) {
      const phrase = q.join(' ');
      return this.reply(`I don't see "${phrase}" in your cart. If you meant to leave an ingredient out, say "no ${phrase}" and I will add it as a kitchen note.`, [chip(`Note: no ${phrase}`.slice(0, 40), `note:no ${phrase}`.slice(0, 120)), chip('View cart', 'cart')], { intent: 'remove' });
    }
    const top = scored.filter((x) => x.score >= scored[0].score - 0.05);
    const names: string[] = [];
    for (const x of top) {
      const res = this.tools.removeLine(x.l.lineId, qp.explicit ? qp.qty ?? undefined : undefined);
      if (res.ok) names.push(`${res.removed} × ${x.item.name}`);
    }
    const s = this.c.cart();
    return this.reply(`Removed ${list(names)}.${s.count ? `\n${this.subtotalLine()}` : ' Your cart is empty now.'}`, this.cartViewChips(), { intent: 'remove' });
  }

  private changeQuantity(): BotResult | null {
    const m = /^(?:please )?(?:make|change|set|update|switch)\s+(?:the |my )?(.+?)\s+(?:to|x|into|=)\s*(\d{1,2}|\w+)$/.exec(this.m) || /^(?:please )?(?:make|set|update)\s+(?:the |my )?(.+?)\s+(\d{1,2})$/.exec(this.m);
    if (!m || !this.draft.cart.length) return null;
    const qn = parseQuantity(m[2]).qty ?? (Number.isFinite(Number(m[2])) ? Number(m[2]) : null);
    if (!qn) return null;
    const q = contentTokens(m[1]);
    const hit = this.draft.cart
      .map((l) => ({ l, item: this.kb.items.find((i) => i.id === l.menuItemId) }))
      .filter((x): x is { l: (typeof this.draft.cart)[number]; item: KItem } => !!x.item)
      .map((x) => ({ ...x, score: scoreItem(q, x.item) }))
      .filter((x) => x.score >= 0.55)
      .sort((a, b) => b.score - a.score)[0];
    if (!hit) return null;
    const res = this.tools.setLineQuantity(hit.l.lineId, qn);
    if (!res.ok) return this.reply(`I can hold between 1 and ${MAX_QTY} of an item on one line.`, this.cartViewChips());
    return this.reply(`Updated: ${qn} × ${hit.item.name}.\n${this.subtotalLine()}`, this.afterAddChips(), { intent: 'quantity' });
  }

  private checkout(): BotResult {
    const s = this.c.cart();
    if (!s.lines.length) return this.reply('Your cart is empty. Add something first.', [chip('Menu', 'menu'), chip('Popular', 'popular')], { intent: 'checkout' });
    if (!this.r.orderable) return this.reply(`${this.r.name} is not taking orders right now, so I can't send you to checkout yet.`, [chip('Hours', 'hours'), chip('View cart', 'cart')], { intent: 'checkout' });
    const min = this.r.minimumOrder;
    if (min > 0 && s.subtotal < min) return this.reply(`The minimum order at ${this.r.name} is ${money(min)}. Your cart is ${money(s.subtotal)}, so please add ${money(min - s.subtotal)} more.`, [chip('Menu', 'menu'), chip('Popular', 'popular'), chip('View cart', 'cart')], { intent: 'checkout' });
    const where = this.c.loggedIn ? 'Your cart is already on your FORKSY account, so you can go straight to checkout there.' : 'Tap "Checkout on FORKSY" to log in or register and pay securely; your items and notes come with you.';
    return this.reply(`Your order is ready: ${s.count} item${s.count > 1 ? 's' : ''}, about ${money(s.subtotal)}. ${where}${this.draft.orderNote ? `\nKitchen note: ${this.draft.orderNote}` : ''}`, [chip('Checkout', 'checkout'), chip('View cart', 'cart'), chip('Menu', 'menu')], { intent: 'checkout' });
  }

  // ------------------------------------------------------------------ notes / allergies
  private noteIntent(): BotResult | null {
    const m = this.m;
    // 1. allergy statements
    if (ALLERGY_STATEMENT.test(m) || (ALLERGY.test(m) && /\b(i|im|i m|my|we)\b/.test(m) && !/\?$/.test(this.c.message.trim()) && !/\b(do|does|is|are|which|what|any)\b/.test(m))) return this.allergyStatement();
    // 2. explicit "note ..." / "kitchen note: ..." / "special instructions ..."
    const lead = NOTE_LEAD.exec(m);
    if (lead && /\b(note|notes|instruction|instructions|request|comment|remark)s?\b/.test(m) && !/^(add|put) .*\b(to|into) (my |the )?(cart|order)\b/.test(m) || (lead && /^(kitchen|special|order) /.test(m))) {
      const body = (lead![1] ?? '').trim();
      if (!body) return this.reply('What should I tell the kitchen? For example: "no onions" or "extra spicy".', [chip('No onions', 'note:no onions'), chip('Extra spicy', 'note:extra spicy'), chip('Sauce on the side', 'note:sauce on the side')]);
      // "note for the margherita: no olives" -> item note
      const forItem = /^(?:for|on|about)\s+(?:the |my )?(.+?)\s*[:\-]\s*(.+)$/.exec(body);
      if (forItem) {
        const r = this.itemNote(forItem[1], forItem[2]);
        if (r) return r;
      }
      return this.saveNote(body.replace(/^(?:for the (?:kitchen|restaurant)|to the kitchen)\s*[:\-]?\s*/, ''));
    }
    // 3. "no onions", "extra spicy", "without cheese", "make it mild" (not "no thanks", "no more", plain "no")
    if (NOTE_START.test(m) && !DONE.test(m) && !/^(no|without) (thanks|thank you|problem|worries|more|need|rush)\b/.test(m)) {
      const body = m.replace(/^(?:please |pls )?(?:can (?:you|i|we) (?:please )?(?:have|get) |make sure |please make )/, '').trim();
      const content = tokenize(body).filter((t) => !FILLER.has(t));
      if (content.length) {
        // "extra fries", "extra pepperoni": an item wins over a note when it names a menu item and nothing is being left out
        if (/^(extra|more|another)\b/.test(m)) {
          const it = this.resolve(contentTokens(m.replace(/^(extra|more|another)\s+/, '')).join(' '), this.kb);
          if (it.kind === 'one' || it.kind === 'many') return null;
        }
        // "no onions on the margherita" -> that item's note
        const on = /^(.+?)\s+(?:on|for|in|from)\s+(?:the |my )?(.+)$/.exec(body);
        if (on) {
          const r = this.itemNote(on[2], on[1]);
          if (r) return r;
        }
        return this.saveNote(body);
      }
    }
    // 4. "<item>, no onions" / "margherita without olives" with no add verb: item note when the item is in the cart
    const m2 = /^(.+?)\s+(no|without|hold|skip)\s+(.+)$/.exec(m);
    if (m2 && this.draft.cart.length) {
      const r = this.itemNote(m2[1], `${m2[2]} ${m2[3]}`);
      if (r) return r;
    }
    return null;
  }

  /** item-level note: applies to a line already in the cart */
  private itemNote(itemPhrase: string, note: string): BotResult | null {
    const q = contentTokens(itemPhrase);
    if (!q.length) return null;
    const hit = this.draft.cart
      .map((l) => ({ l, item: this.kb.items.find((i) => i.id === l.menuItemId) }))
      .filter((x): x is { l: (typeof this.draft.cart)[number]; item: KItem } => !!x.item)
      .map((x) => ({ ...x, score: scoreItem(q, x.item) }))
      .filter((x) => x.score >= 0.6)
      .sort((a, b) => b.score - a.score)[0];
    if (!hit) return null;
    const merged = [hit.l.notes, note].filter(Boolean).join('; ');
    const res = this.tools.setLineNote(hit.l.lineId, merged);
    if (!res.ok) return this.reply('That note is too long. Please keep item notes short.', this.cartViewChips());
    const warn = this.allergyHint(note);
    return this.reply(`Noted for ${hit.item.name}: "${note}".${warn}`, [chip('View cart', 'cart'), chip('Checkout', 'checkout'), chip('Menu', 'menu')], { intent: 'item-note' });
  }

  private allergyHint(text: string): string {
    return ALLERGY.test(normalize(text)) ? ` ${ALLERGY_WARNING(this.kb)}` : '';
  }

  private saveNote(textIn: string, fromChip = false): BotResult {
    const text = cap(textIn.trim().replace(/\s+/g, ' ').slice(0, 200));
    if (!text) return this.reply('What should I tell the kitchen?', this.homeChips());
    const res = this.tools.addOrderNote(text);
    if (!res.ok) return this.reply(res.error === 'NOTE_TOO_LONG' ? `Your kitchen note is getting too long (max ${MAX_NOTE} characters). Say "remove note" to start again.` : 'I could not save that note.', this.homeChips());
    const hasItems = this.draft.cart.length > 0;
    return this.reply(
      `Noted for the kitchen: "${text}". ${hasItems ? 'It will travel with your order to checkout.' : 'It will travel with your order once you add something.'} The restaurant decides whether it can honour a request.${this.allergyHint(text)}`,
      hasItems ? [chip('View cart', 'cart'), chip('Checkout', 'checkout'), chip('Menu', 'menu')] : this.homeChips(),
      { intent: fromChip ? 'note-chip' : 'note' },
    );
  }

  private allergyStatement(): BotResult {
    const m = this.m;
    const after = /(?:allergic to|allergy to|allergies to|allergy|allergic|intolerant to|intolerance to|intolerance|celiac|coeliac)\s*[:\-]?\s*(.*)$/.exec(m);
    const found = ALLERGEN_WORDS.filter((w) => new RegExp(`\\b${w}s?\\b`).test(m));
    let what = after && after[1] ? after[1].replace(/\b(please|thanks|thank you|pls)\b/g, '').replace(/[.,;:!]+$/g, '').trim() : '';
    if (!what || what.length > 80) what = found.join(', ');
    if (!what) what = this.c.message.trim().slice(0, 80);
    const noteText = `ALLERGY: ${what}`;
    this.tools.addOrderNote(noteText);
    const terms = found.length ? found : tokenize(what).filter((t) => !FILLER.has(t));
    const listing = this.kb.items
      .filter((i) => i.allergens.some((a) => terms.some((t) => wordSim(t, a.toLowerCase()) >= 0.8 || a.toLowerCase().includes(t) || t.includes(a.toLowerCase()))))
      .map((i) => i.name);
    const inCart = this.draft.cart
      .map((l) => this.kb.items.find((i) => i.id === l.menuItemId))
      .filter((i): i is KItem => !!i && i.allergens.some((a) => terms.some((t) => a.toLowerCase().includes(t) || t.includes(a.toLowerCase()))));
    let text = `Thanks for telling me. I added "${noteText}" to your kitchen note so the restaurant sees it. I can't guarantee that any item is free of an allergen. ${ALLERGY_WARNING(this.kb)}`;
    if (inCart.length) text += `\nHeads-up: ${list([...new Set(inCart.map((i) => i.name))])} in your cart list${inCart.length === 1 ? 's' : ''} a matching allergen.`;
    if (listing.length) text += `\nItems that list a matching allergen: ${list(listing.slice(0, 8))}${listing.length > 8 ? ' and more' : ''}.`;
    return this.reply(text, [chip('View cart', 'cart'), chip('Menu', 'menu'), chip('Call/Contact info', 'hours')].slice(0, 3), { intent: 'allergy' });
  }

  private allergenQuestion(): BotResult | null {
    const m = this.m;
    // which item is being asked about?
    const q = contentTokens(m.replace(/\b(does|do|is|are|contain\w*|allerg\w*|gluten|nuts?|peanuts?|dairy|lactose|shellfish|eggs?|soy|sesame|free|any|in|the|have|has|there|listed|allergens?|for|with)\b/g, ' '));
    const terms = ALLERGEN_WORDS.filter((w) => new RegExp(`\\b${w}s?\\b`).test(m));
    const res = q.length ? this.resolve(q.join(' '), this.kb) : ({ kind: 'none' } as const);
    if (res.kind === 'one' || res.kind === 'maybe') {
      const i = res.kind === 'one' ? res.match.item : res.match.item;
      let ans = `${i.name}: ${allergenText(i)}.`;
      if (terms.length) {
        const listed = terms.filter((t) => i.allergens.some((a) => a.toLowerCase().includes(t) || t.includes(a.toLowerCase())));
        ans += listed.length ? ` It lists ${list(listed)}.` : ` ${list(terms)} ${terms.length > 1 ? 'are' : 'is'} not in that list, but I can't guarantee it is absent.`;
      }
      return this.reply(`${ans} ${ALLERGY_WARNING(this.kb)}`, [chip(`Add ${i.name}`.slice(0, 40), `add:${i.id}`), chip('Menu', 'menu')], { cards: [cardOf(i)], intent: 'allergen' });
    }
    if (terms.length) {
      const listing = this.kb.items.filter((i) => i.allergens.some((a) => terms.some((t) => a.toLowerCase().includes(t) || t.includes(a.toLowerCase()))));
      const txt = listing.length
        ? `Items that list ${list(terms)} as an allergen: ${list(listing.slice(0, 10).map((i) => i.name))}${listing.length > 10 ? ' and more' : ''}.`
        : `No item on the menu lists ${list(terms)} as an allergen in the information I have.`;
      return this.reply(`${txt} I can't guarantee that any item is free of an allergen. ${ALLERGY_WARNING(this.kb)}`, [chip('Menu', 'menu'), chip('Hours', 'hours')], { cards: cardsOf(listing), intent: 'allergen' });
    }
    return null;
  }

  // ------------------------------------------------------------------ price / info
  private priceQuestion(): BotResult | null {
    const q = contentTokens(this.m.replace(PRICE_Q, ' ').replace(/\b(is|are|the|a|an|of|for|does|do|it|this|that|cost|costs|much)\b/g, ' '));
    if (/\b(delivery|service|tip|tax|fee|fees)\b/.test(this.m)) return this.payment();
    if (!q.length) return null;
    const res = this.resolve(q.join(' '), this.kb);
    if (res.kind === 'one' || res.kind === 'maybe') {
      const i = res.match.item;
      const extra = i.groups.flatMap((g) => g.options.filter((o) => o.priceDelta !== 0)).slice(0, 4).map((o) => `${o.name} ${o.priceDelta > 0 ? '+' : '-'}${money(Math.abs(o.priceDelta))}`);
      return this.reply(`${i.name} is ${money(i.price)}${extra.length ? ` (options: ${extra.join(', ')})` : ''}.${i.available ? '' : ' It is not available right now.'}`, [chip(`Add ${i.name}`.slice(0, 40), `add:${i.id}`), chip('Menu', 'menu')], { cards: [cardOf(i)], intent: 'price' });
    }
    if (res.kind === 'many') return this.listItems(res.matches.map((x) => x.item), `Prices for "${q.join(' ')}"`);
    return null;
  }

  // ------------------------------------------------------------------ restaurant facts
  private hours(): BotResult {
    const r = this.r;
    const m = this.m;
    const lines = hoursLines(this.kb.hours);
    let text: string;
    let dow: number | null = null;
    for (const [re, d] of DOW_WORDS) if (re.test(m)) dow = d;
    if (/\btomorrow\b/.test(m)) dow = (dowIn(this.c.now, r.timezone) + 1) % 7;
    if (/\b(today|tonight)\b/.test(m)) dow = dowIn(this.c.now, r.timezone);
    if (!this.kb.hours.length) text = `${r.name} has no fixed opening hours on file. ${r.open ? 'It is open for orders now.' : 'It is not taking orders right now.'}`;
    else if (dow !== null) text = `${DAY_NAMES[dow]}: ${hoursForDay(this.kb.hours, dow)}.${this.statusLine()}`;
    else text = `${r.open ? `${r.name} is open now${r.closesAtText ? ` until ${r.closesAtText}` : ''}.` : `${r.name} is closed right now${r.opensAtText ? `; it opens ${r.opensAtText}` : ''}.`}\nHours: ${lines.join('; ')}.`;
    if (!r.orderable) text += ' It is not accepting orders at the moment.';
    return this.reply(text, this.homeChips(), { intent: 'hours' });
  }

  private statusLine(): string {
    const r = this.r;
    return r.open ? ` Open now${r.closesAtText ? ` until ${r.closesAtText}` : ''}.` : r.opensAtText ? ` Closed now; opens ${r.opensAtText}.` : ' Closed now.';
  }

  private delivery(): BotResult {
    const r = this.r;
    const m = this.m;
    const parts: string[] = [];
    const wantsPickup = /\b(pick ?up|pick-up|take ?out|take ?away|collect\w*)\b/.test(m);
    const wantsDelivery = /\bdeliver\w*\b/.test(m);
    if (!r.orderable) parts.push(`${r.name} is not taking orders right now (${r.serviceModeLabel}).`);
    else {
      if (wantsPickup || !wantsDelivery) parts.push(r.pickupAvailable ? 'Pickup is available.' : 'Pickup is not available right now.');
      if (wantsDelivery || !wantsPickup) parts.push(r.deliveryAvailable ? 'Delivery is available (the fee and arrival time are shown at checkout for your address).' : 'Delivery is not available right now.');
      parts.push(`Current mode: ${r.serviceModeLabel}.`);
    }
    if (r.pickupInstructions && (wantsPickup || !wantsDelivery)) parts.push(`Pickup notes: ${r.pickupInstructions}`);
    if (!r.open && r.orderable) parts.push(`The restaurant is closed now${r.opensAtText ? `; opens ${r.opensAtText}` : ''}.`);
    return this.reply(parts.join(' '), this.homeChips(), { intent: 'delivery' });
  }

  private prep(): BotResult {
    const r = this.r;
    return this.reply(`Typical preparation time is about ${r.prepTimeMin} minutes for delivery orders and ${r.pickupPrepTimeMin} minutes for pickup. Busy periods can add time; the checkout page shows the estimate for your order.`, this.homeChips(), { intent: 'prep' });
  }

  private minimum(): BotResult {
    const min = this.r.minimumOrder;
    return this.reply(min > 0 ? `The minimum order at ${this.r.name} is ${money(min)}.` : `${this.r.name} has no minimum order.`, this.homeChips(), { intent: 'minimum' });
  }

  private address(): BotResult {
    const r = this.r;
    return this.reply(`${r.name} is at ${r.address || 'an address shown on its FORKSY page'}.${r.pickupInstructions ? ` Pickup notes: ${r.pickupInstructions}` : ''}`, this.homeChips(), { intent: 'address' });
  }

  private contact(): BotResult {
    const r = this.r;
    return this.reply(r.phone ? `You can call ${r.name} at ${r.phone}.` : `I don't have a phone number for ${r.name}. Please use the FORKSY website for contact details.`, this.homeChips(), { intent: 'contact' });
  }

  private payment(): BotResult {
    return this.reply('Payment, tip, taxes, delivery fees and promo codes are all handled on the FORKSY checkout page, so the final total is shown there before you pay. The totals I show here are estimates from menu prices.', this.cartChipsOrHome(), { intent: 'payment' });
  }

  private cartChipsOrHome(): BotChip[] {
    return this.draft.cart.length ? this.cartChips() : this.homeChips();
  }

  // ------------------------------------------------------------------ FAQ
  private matchFaq(): { index: number; score: number } | null {
    if (!this.kb.faqs.length) return null;
    const q = contentTokens(this.m);
    if (!q.length) return null;
    let best: { index: number; score: number } | null = null;
    this.kb.faqs.forEach((f, index) => {
      const ft = contentTokens(f.q);
      if (!ft.length) return;
      const cov = (a: string[], b: string[]) => a.reduce((s, w) => s + Math.max(0, ...b.map((x) => wordSim(w, x))), 0) / a.length;
      const score = (cov(q, ft) + cov(ft, q)) / 2;
      if (!best || score > best.score) best = { index, score };
    });
    return best;
  }

  private faqAnswer(i: number): BotResult {
    const f = this.kb.faqs[i];
    return this.reply(f.a, [...(this.kb.faqs.length > 1 ? [chip('More questions', 'faq')] : []), ...this.homeChips()], { intent: 'faq' });
  }

  private faqList(): BotResult {
    if (!this.kb.faqs.length) return this.reply(`${this.r.name} has not added any common questions yet. Ask me about the menu, hours or delivery.`, this.homeChips());
    return this.reply('Here are some common questions. Tap one to see the answer.', [...this.kb.faqs.slice(0, 6).map((f, n) => chip(f.q.slice(0, 40), `faq:${n}`))], { intent: 'faq-list' });
  }

  // ------------------------------------------------------------------ menu browsing
  private menuOverview(): BotResult {
    const cats = this.kb.categories.filter((c) => c.itemIds.some((id) => this.kb.items.find((i) => i.id === id)));
    if (!cats.length) return this.reply(`${this.r.name} has no menu items right now.`, [chip('Hours', 'hours')]);
    const text = `${this.r.name} menu: ${cats.map((c) => `${c.name} (${c.itemIds.length})`).join(', ')}. Tap a section to see its items.`;
    return this.reply(text, [...cats.slice(0, 5).map((c) => chip(`${c.name}`.slice(0, 40), `cat:${c.id ?? 'none'}`)), chip('Popular', 'popular')], { intent: 'menu' });
  }

  private showCategory(idOrName: string): BotResult {
    const c = this.kb.categories.find((x) => (x.id ?? 'none') === idOrName);
    if (!c) return this.menuOverview();
    const items = c.itemIds.map((id) => this.kb.items.find((i) => i.id === id)).filter((i): i is KItem => !!i);
    return this.listItems(items, `${c.name}`, true);
  }

  /** cards for the first 6, a compact text line for the rest, so nothing on the menu is hidden */
  private listItems(items: KItem[], title: string, offerMenu = false, hint = ''): BotResult {
    const sorted = [...items].sort((a, b) => Number(b.available) - Number(a.available));
    if (!sorted.length) return this.reply(`${title}: nothing to show right now.`, this.homeChips());
    const shown = sorted.slice(0, MAX_CARDS);
    const rest = sorted.slice(MAX_CARDS);
    let text = `${title}:\n` + shown.map((i) => `• ${i.name} — ${money(i.price)}${i.dietaryTags.length ? ` [${i.dietaryTags.join(', ')}]` : ''}${i.available ? '' : ' (not available now)'}`).join('\n');
    if (rest.length) text += `\nAlso: ${rest.slice(0, 12).map((i) => `${i.name} (${money(i.price)})`).join(', ')}${rest.length > 12 ? ` and ${rest.length - 12} more` : ''}.`;
    if (hint) text += `\n${hint}`;
    const chips = shown.filter((i) => i.available).slice(0, 4).map((i) => chip(`Add ${i.name}`.slice(0, 40), `add:${i.id}`));
    if (offerMenu) chips.push(chip('Menu', 'menu'));
    else chips.push(chip('Menu', 'menu'), chip('View cart', 'cart'));
    return this.reply(text, chips, { cards: cardsOf(sorted), intent: 'list' });
  }

  private recommend(): BotResult {
    const diet = detectDiet(this.c.message, this.kb);
    let pool = this.kb.items.filter((i) => i.available && diet.every((t) => hasTag(i, t)));
    const popular = pool.filter((i) => i.isPopular);
    if (!pool.length) return this.reply(`I couldn't find ${diet.length ? list(diet) + ' ' : ''}items to recommend right now.`, this.homeChips());
    if (/\bsurprise\b/.test(this.m)) {
      const src = popular.length ? popular : pool;
      const pick = src[(this.draft.messageCount * 7 + 3) % src.length];
      return this.reply(`How about ${pick.name} (${money(pick.price)})?${pick.description ? ` ${pick.description}` : ''}`, [chip(`Add ${pick.name}`.slice(0, 40), `add:${pick.id}`), chip('Another idea', 'recommend'), chip('Menu', 'menu')], { cards: [cardOf(pick)], intent: 'recommend' });
    }
    if (popular.length) pool = popular;
    else {
      // no popularity data: one item from each section, no claims about what sells best
      const seen = new Set<string | null>();
      pool = pool.filter((i) => (seen.has(i.categoryId) ? false : (seen.add(i.categoryId), true)));
    }
    const title = popular.length ? `Popular at ${this.r.name}${diet.length ? ` (${list(diet)})` : ''}` : `A few picks from ${this.r.name}'s menu`;
    return { ...this.listItems(pool, title), intent: 'recommend' };
  }

  private cheapest(): KItem[] {
    return this.kb.items.filter((i) => i.available).sort((a, b) => a.price - b.price).slice(0, 6);
  }

  private searchTags(tags: string[]): BotResult {
    const items = this.kb.items.filter((i) => i.available && tags.every((t) => hasTag(i, t)));
    if (!items.length) return this.reply(`No items are tagged ${list(tags)} on this menu right now. Dietary tags are set by the restaurant.`, this.homeChips(), { intent: 'diet' });
    return this.listItems(items, `Items tagged ${list(tags)} by the restaurant`, false, 'Dietary tags are set by the restaurant; ask them to confirm if it matters for your health.');
  }

  /** menu search: category / dietary tag / budget / keywords, any combination */
  private search(): BotResult | null {
    const m = this.m;
    const tags = detectDiet(this.c.message, this.kb);
    const cap = parsePriceCap(this.m);
    const wantsCheap = CHEAP.test(m);
    const words = contentTokens(m).filter((w) => !SEARCH_NOISE.has(w));
    const cat = matchCategory(words, this.kb);
    const catWords = new Set(cat ? tokenize(cat.name) : []);
    const tagWords = new Set(tags.flatMap((t) => tokenize(t)).concat(['gluten', 'free', 'veg', 'vegetarian', 'vegan', 'halal', 'veggie']));
    const keywords = words.filter((w) => !catWords.has(w) && ![...catWords].some((c) => wordSim(w, c) >= 0.8) && !tagWords.has(w) && !/^\$?\d+(\.\d+)?$/.test(w) && !PRICE_WORDS.has(w));
    const hasFilter = tags.length || cap !== null || wantsCheap || !!cat;
    const wantsMenu = /\bmenu\b|\bwhat (do|can) (you|i|we)\b|\bwhat s (on|good|there|available)\b|\bwhats (on|good|there|available)\b|\bcategor/.test(m);
    if (wantsMenu && !hasFilter && !keywords.length) return this.menuOverview();
    if (!hasFilter && !keywords.length) return wantsMenu ? this.menuOverview() : null;
    if (!hasFilter && keywords.length && !LISTING.test(m)) return null; // handled as implicit item / fallback

    let pool = this.kb.items.filter((i) => i.available);
    const bits: string[] = [];
    if (cat) {
      pool = pool.filter((i) => cat.itemIds.includes(i.id));
      bits.push(cat.name);
    }
    for (const t of tags) {
      pool = pool.filter((i) => hasTag(i, t));
      bits.push(t);
    }
    if (cap !== null) {
      pool = pool.filter((i) => i.price <= cap);
      bits.push(`under ${money(cap)}`);
    }
    if (keywords.length) {
      const scored = pool.map((i) => ({ i, s: scoreItem(keywords, i) })).filter((x) => x.s >= 0.6).sort((a, b) => b.s - a.s);
      if (scored.length) pool = scored.map((x) => x.i);
      else if (!hasFilter) return null;
      else pool = [];
      bits.push(`matching "${keywords.join(' ')}"`);
    } else {
      pool = pool.sort((a, b) => (wantsCheap ? a.price - b.price : Number(b.isPopular) - Number(a.isPopular) || a.price - b.price));
    }
    if (wantsCheap && !keywords.length) pool = pool.sort((a, b) => a.price - b.price);
    const label = bits.length ? cap_(bits.join(' ')) : 'Matches';
    if (!pool.length) {
      const alt = this.kb.items.filter((i) => i.available && i.isPopular).slice(0, 4);
      return this.reply(`I couldn't find anything on the menu for: ${bits.join(', ')}. Dietary tags and prices come straight from the restaurant's menu.`, [chip('Menu', 'menu'), chip('Popular', 'popular'), chip('Cheapest', 'cheapest')], { cards: cardsOf(alt), intent: 'search-empty' });
    }
    const dietNote = tags.length ? 'Dietary tags are set by the restaurant; ask them to confirm if it matters for your health.' : '';
    return { ...this.listItems(pool, `${label} (${pool.length} found)`, false, dietNote), intent: 'search' };
  }

  // ------------------------------------------------------------------ pairing
  private pairing(): BotResult {
    const m = this.m;
    const wanted: FoodClass | null = /\b(drink|drinks|beverage|beverages|pop|soda)\b/.test(m) ? 'drink' : /\b(side|sides|starter|appetizer)\b/.test(m) ? 'side' : /\b(dessert|desserts|sweet)\b/.test(m) ? 'dessert' : null;
    return this.pairingFor(wanted);
  }

  private pairingFor(wanted: FoodClass | null): BotResult {
    // anchor: an item named in the message, else what is in the cart
    const named = rankItems(contentTokens(this.m).filter((w) => !SEARCH_NOISE.has(w)), this.kb).filter((x) => x.score >= 0.8 && !classOf(x.item))[0]?.item;
    const inCart = this.draft.cart.map((l) => this.kb.items.find((i) => i.id === l.menuItemId)).filter((i): i is KItem => !!i);
    const have = new Set(inCart.map(classOf));
    const order: FoodClass[] = wanted ? [wanted] : (['drink', 'side', 'dessert'] as FoodClass[]).filter((k) => !have.has(k));
    for (const k of order) {
      const pool = this.kb.items.filter((i) => i.available && classOf(i) === k).sort((a, b) => Number(b.isPopular) - Number(a.isPopular) || a.price - b.price);
      if (!pool.length) continue;
      const anchor = named ? named.name : inCart[0]?.name;
      const title = anchor ? `To go with ${anchor}, here are some ${CLASS_LABEL[k]}` : `Here are some ${CLASS_LABEL[k]} from ${this.r.name}`;
      return { ...this.listItems(pool, title), intent: 'pairing' };
    }
    return this.reply(`I don't have specific pairing suggestions here, but I can show what's popular.`, [chip('Popular', 'popular'), chip('Menu', 'menu')], { intent: 'pairing' });
  }
}

const cap_ = (s: string) => cap(s);

const SEARCH_NOISE = new Set(['show', 'list', 'menu', 'what', 'whats', 'which', 'do', 'you', 'have', 'serve', 'sell', 'offer', 'options', 'option', 'anything', 'any', 'got', 'looking', 'want', 'need', 'find', 'see', 'items', 'item', 'dishes', 'dish', 'food', 'stuff', 'things', 'available', 'good', 'tell', 'about', 'can', 'get', 'give', 'is', 'are', 'there', 'some', 'something', 'choices', 'selection', 'section']);
const PRICE_WORDS = new Set(['under', 'below', 'less', 'than', 'cheaper', 'most', 'max', 'maximum', 'dollars', 'dollar', 'bucks', 'budget', 'cheap', 'cheapest', 'affordable', 'inexpensive', 'price', 'priced', 'value', 'within', 'up', 'to', 'or']);

export type { BotCard };
