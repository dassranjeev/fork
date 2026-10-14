import type { AssistantCartLine, AssistantPending } from '../../database/entities/assistant.entities';

// ------------------------------------------------------------------ knowledge (what the bot may talk about)
// Built ONLY from the public restaurant page (menu, hours, fulfilment, minimum) plus the restaurant-written FAQs.

export interface KOption {
  id: string;
  name: string;
  priceDelta: number;
  isDefault: boolean;
  available: boolean;
}

export interface KGroup {
  id: string;
  name: string;
  required: boolean;
  min: number;
  /** 0 = unlimited */
  max: number;
  options: KOption[];
}

export interface KItem {
  id: string;
  name: string;
  description: string | null;
  price: number;
  imageUrl: string | null;
  dietaryTags: string[];
  allergens: string[];
  calories: number | null;
  isPopular: boolean;
  /** orderable right now (in stock and inside its daypart) */
  available: boolean;
  categoryId: string | null;
  category: string | null;
  groups: KGroup[];
}

export interface KCategory {
  id: string | null;
  name: string;
  description: string | null;
  itemIds: string[];
}

export interface KHours {
  dayOfWeek: number;
  openTime: string;
  closeTime: string;
  closed: boolean;
}

export interface Knowledge {
  restaurant: {
    id: string;
    slug: string;
    name: string;
    description: string | null;
    phone: string | null;
    address: string;
    logoUrl: string | null;
    cuisines: string[];
    minimumOrder: number;
    prepTimeMin: number;
    pickupPrepTimeMin: number;
    serviceMode: string;
    serviceModeLabel: string;
    deliveryAvailable: boolean;
    pickupAvailable: boolean;
    /** accepts orders at all (LIVE and not CLOSED service mode) */
    orderable: boolean;
    open: boolean;
    /** human text such as "Tue 5:00 PM" (restaurant time zone) or null */
    opensAtText: string | null;
    closesAtText: string | null;
    timezone: string;
    pickupInstructions: string | null;
    rating: number | null;
  };
  hours: KHours[];
  categories: KCategory[];
  items: KItem[];
  faqs: { q: string; a: string }[];
  assistantName: string;
  greeting: string | null;
}

/** One row of the central bot's restaurant directory (public data only). */
export interface DirectoryEntry {
  id: string;
  slug: string;
  name: string;
  cuisines: string[];
  logoUrl: string | null;
  rating: number | null;
  openNow: boolean;
  deliveryAvailable: boolean;
  pickupAvailable: boolean;
  /** lower-cased active dish names, category names and dietary tags used for search (never shown verbatim) */
  dishNames: string[];
  categoryNames: string[];
  dietaryTags: string[];
  lat: number | null;
  lng: number | null;
}

// ------------------------------------------------------------------ replies
export interface BotCard {
  menuItemId: string;
  name: string;
  description?: string;
  price: number;
  imageUrl?: string;
  tags?: string[];
  available: boolean;
}

export interface BotRestaurantCard {
  id: string;
  slug: string;
  name: string;
  cuisine?: string;
  openNow: boolean;
  deliveryAvailable: boolean;
  pickupAvailable: boolean;
  rating?: number;
  logoUrl?: string;
}

export interface BotChip {
  label: string;
  payload: string;
}

export interface BotResult {
  text: string;
  cards?: BotCard[];
  restaurants?: BotRestaurantCard[];
  chips?: BotChip[];
  /** central bot only: scope the session to this restaurant slug (the service validates it) */
  scopeTo?: string;
  /** what the brain understood (for statistics / tests) */
  intent?: string;
  /** the taught entry that produced this answer (thumbs up / down are attributed to it) */
  entryId?: string | null;
  /** the customer may rate this answer */
  feedback?: boolean;
}

// ------------------------------------------------------------------ session draft + tools
/** Mutable copy of the persisted session state. Only the TOOLS below may change it. */
export interface SessionDraft {
  restaurantId: string | null;
  cart: AssistantCartLine[];
  orderNote: string | null;
  pending: AssistantPending | null;
  /** number of messages so far (used for deterministic "surprise me") */
  messageCount: number;
}

export type ToolError =
  | 'NOT_FOUND'
  | 'UNAVAILABLE'
  | 'BAD_QUANTITY'
  | 'CART_FULL'
  | 'LINE_FULL'
  | 'BAD_OPTION'
  | 'NO_RESTAURANT'
  | 'NOT_ORDERABLE'
  | 'NOTE_TOO_LONG'
  | 'EMPTY';

export interface AddResult {
  ok: boolean;
  error?: ToolError;
  message?: string;
  line?: AssistantCartLine;
  item?: KItem;
  /** a required modifier group still needs an answer (the pending question has been recorded) */
  ask?: { group: KGroup; remaining: number };
  /** options that were filled in from the item's defaults */
  defaulted?: KOption[];
  /** quantity this call added (the line may hold more after merging) */
  added?: number;
  /** clauses of the original request that still have to be processed after a pending question is answered */
  queue?: string[];
}

export interface AssistantTools {
  /** strict add: item must belong to THIS restaurant's menu, be active + available, quantity 1-20, <= 40 lines, valid options */
  addItem(input: { menuItemId: string; quantity: number; optionIds?: string[]; note?: string; queue?: string[] }): AddResult;
  /** continue a pending modifier question with the chosen option id */
  answerOption(optionId: string): AddResult;
  removeLine(lineId: string, quantity?: number): { ok: boolean; removed?: number; line?: AssistantCartLine; error?: ToolError };
  setLineNote(lineId: string, note: string | null): { ok: boolean; error?: ToolError };
  setLineQuantity(lineId: string, quantity: number): { ok: boolean; error?: ToolError };
  /** swap / add an option on an existing line ("make it large"); single-choice groups replace the earlier pick */
  changeOption(lineId: string, optionId: string): { ok: boolean; error?: ToolError; line?: AssistantCartLine; item?: KItem; option?: KOption };
  clearCart(): void;
  addOrderNote(text: string): { ok: boolean; error?: ToolError; note: string | null };
  clearOrderNote(): void;
  cancelPending(): void;
}

export interface CartSummary {
  lines: { lineId: string; menuItemId: string; name: string; quantity: number; unitPrice: number; lineTotal: number; options: { id: string; name: string; priceDelta: number }[]; notes?: string }[];
  count: number;
  subtotal: number;
}

// ------------------------------------------------------------------ extension points (see docs/assistant.md, "Extension points")
/** An answer from learned / uploaded knowledge (restaurant training). Confidence 0..1; the pipeline uses answers >= 0.6. */
export interface KnowledgeAnswer {
  text: string;
  confidence: number;
  cards?: BotCard[];
  chips?: BotChip[];
  /** confident enough to answer BEFORE the built-in menu / hours / cart intents (never set for entries that talk about prices or hours) */
  strong?: boolean;
  /** which taught entry answered (internal id, for statistics and thumbs) */
  entryId?: string | null;
  source?: 'entry' | 'document' | 'ambiguous';
}

export type TrainingOutcome = 'TRAINING' | 'DOCUMENT' | 'AMBIGUOUS' | 'BUILTIN' | 'UNANSWERED';

/** Asked BEFORE the bot says "I don't know". The default implementation returns null. */
export interface KnowledgeProvider {
  lookup(restaurantId: string | null, normalisedQuery: string, ctx: BrainContext): Promise<KnowledgeAnswer | null>;
  /** load the published knowledge of this bot (restaurantId null = the central bot) so the synchronous hooks can use it */
  prepare?(restaurantId: string | null): Promise<void>;
  /** restaurant synonyms / category nicknames applied to the customer's words before anything else */
  rewrite?(restaurantId: string | null, text: string): string;
  /** a follow-up / "did you mean" chip (payload kb:<entryId>) */
  entry?(restaurantId: string | null, entryId: string): Promise<KnowledgeAnswer | null>;
  /** statistics: what happened to a customer question (never throws, never stores session ids) */
  record?(restaurantId: string | null, outcome: TrainingOutcome, text: string, entryId?: string | null): void;
}

/** Restaurant-specific nicknames for menu items ("the usual", "marg") -> menuItemId. The phrase is lower-cased with filler words removed ("the usual" arrives as "usual"). Synchronous: implementations keep an in-memory cache. */
export interface AliasResolver {
  resolve(restaurantId: string, normalisedPhrase: string): string | null;
}

export interface BrainHooks {
  aliases?: AliasResolver | null;
}

export interface BrainContext {
  /** central bot only: FAQs about FORKY itself and the configured starter chips (Admin > Assistant > Central bot) */
  centralFaqs?: { q: string; a: string }[];
  starterChips?: BotChip[];
  sessionId?: string | null;
  hooks?: BrainHooks;
  message: string;
  quick: string | null;
  now: Date;
  scope: 'restaurant' | 'central';
  mode: 'embedded' | 'site';
  /** the session may still switch restaurant (central bot) */
  canScope: boolean;
  loggedIn: boolean;
  kb: Knowledge | null;
  directory: DirectoryEntry[] | null;
  /** optional visitor position (central bot "near me") */
  geo: { lat: number; lng: number } | null;
  draft: SessionDraft;
  tools: AssistantTools | null;
  /** priced view of the current cart (computed from the knowledge base) */
  cart(): CartSummary;
}

export interface AssistantBrain {
  readonly name: string;
  /** Return null to let the next brain (the deterministic one) answer. */
  respond(ctx: BrainContext): Promise<BotResult | null>;
}
