import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { AliasResolver, AssistantBrain, BotChip, BotResult, BrainContext, KnowledgeAnswer, KnowledgeProvider } from './brain.types';
import { DeterministicBrain } from './deterministic.brain';
import { ALIAS_RESOLVER, ASSISTANT_UNANSWERED, AssistantUnansweredEvent, KNOWLEDGE_PROVIDER } from './hooks';
import { LlmBrain } from './llm.brain';

/** an answer from training below this confidence is never used (the per-restaurant threshold, 0.4 - 0.9, is applied inside the engine) */
export const KNOWLEDGE_MIN_CONFIDENCE = 0.4;

/** built-in answers that a well matching document passage may replace (informational, never cart actions) */
const DOC_OVERRIDES = new Set(['allergen', 'allergy', 'search-empty', 'help']);
/** the bot did not understand: 'unknown' (restaurant bots) and 'find-empty' (the central bot found no restaurant) */
const UNANSWERED = new Set(['unknown', 'find-empty']);

const HOME: BotChip[] = [
  { label: 'Menu', payload: 'menu' },
  { label: 'View cart', payload: 'cart' },
];

const CENTRAL_HOME: BotChip[] = [
  { label: 'Open now', payload: 'find:open now' },
  { label: 'Pizza', payload: 'find:pizza' },
  { label: 'Vegetarian', payload: 'find:vegetarian' },
];

/**
 * Answer pipeline (every step is optional except the deterministic brain):
 *   0. synonyms / category nicknames of the restaurant rewrite the customer's words; a chip "kb:<entry>" opens that taught answer
 *   1. KnowledgeProvider: a STRONG match of a taught entry answers first (never for entries about prices / hours: those stay live data)
 *   2. LlmBrain (optional stub; returns null unless ANTHROPIC_API_KEY is set)
 *   3. DeterministicBrain (menu, cart, hours, delivery ... ; flags "I did not understand" with intent 'unknown')
 *   4. when step 3 would say "I don't know": a weaker taught match, a "Did you mean ...?" question or a quoted passage of the restaurant's documents
 *   5. still nothing -> event 'assistant.unanswered' {restaurantId, sessionId, text, at}; the "I don't know" reply stands
 * AliasResolver (restaurant nicknames for menu items) is handed to the item matcher through ctx.hooks.
 */
@Injectable()
export class AssistantBrains {
  private readonly logger = new Logger('AssistantBrains');
  private readonly brains: AssistantBrain[];

  constructor(
    llm: LlmBrain,
    private events: EventEmitter2,
    @Inject(KNOWLEDGE_PROVIDER) private knowledge: KnowledgeProvider,
    @Inject(ALIAS_RESOLVER) private aliases: AliasResolver,
  ) {
    this.brains = [llm, new DeterministicBrain()];
  }

  private asResult(a: KnowledgeAnswer, intent = 'knowledge', ctx?: BrainContext): BotResult {
    const chips = [...(a.chips ?? [])];
    // a restaurant bot offers Menu / View cart next; the central bot offers its configured starter chips (find a restaurant)
    const home = ctx?.scope === 'central' ? (ctx.starterChips?.length ? ctx.starterChips : CENTRAL_HOME) : HOME;
    if (a.source !== 'ambiguous') for (const h of home) if (chips.length < 5 && !chips.some((c) => c.payload === h.payload)) chips.push(h);
    return { text: a.text, cards: a.cards, chips: chips.slice(0, 6), intent: a.source === 'ambiguous' ? 'knowledge-ambiguous' : intent, entryId: a.entryId ?? null, feedback: a.source !== 'ambiguous' };
  }

  private outcomeOf(a: KnowledgeAnswer) {
    return a.source === 'ambiguous' ? 'AMBIGUOUS' : a.source === 'document' ? 'DOCUMENT' : 'TRAINING';
  }

  async respond(ctx: BrainContext): Promise<BotResult> {
    ctx.hooks = { ...(ctx.hooks ?? {}), aliases: this.aliases };
    const rid = ctx.kb?.restaurant.id ?? null;
    const scoped = !!ctx.kb || ctx.scope === 'central';
    const typed = !ctx.quick && !!ctx.message && !ctx.draft.pending;
    let known: KnowledgeAnswer | null = null;

    if (scoped) {
      try {
        await this.knowledge.prepare?.(rid);
        if (!ctx.quick && this.knowledge.rewrite) ctx.message = this.knowledge.rewrite(rid, ctx.message);
        if (ctx.quick?.startsWith('kb:') && this.knowledge.entry) {
          const a = await this.knowledge.entry(rid, ctx.quick.slice(3));
          if (a) {
            this.knowledge.record?.(rid, 'TRAINING', ctx.message, a.entryId);
            return this.asResult(a, 'knowledge', ctx);
          }
        }
        if (typed) {
          known = await this.knowledge.lookup(rid, ctx.message, ctx);
          if (known?.strong && known.source === 'entry') {
            this.knowledge.record?.(rid, 'TRAINING', ctx.message, known.entryId);
            return this.asResult(known, 'knowledge', ctx);
          }
        }
      } catch (e) {
        this.logger.warn(`knowledge provider failed: ${(e as Error).message}`);
        known = null;
      }
    }

    let result: BotResult | null = null;
    for (const b of this.brains) {
      // a brain that returns null / throws must not leave half-applied changes behind
      const snapshot = JSON.stringify(ctx.draft);
      try {
        const out = await b.respond(ctx);
        if (out) {
          result = out;
          break;
        }
      } catch (e) {
        this.logger.warn(`brain ${b.name} failed: ${(e as Error).message}`);
      }
      Object.assign(ctx.draft, JSON.parse(snapshot));
    }
    if (!result) return { text: "Sorry, I couldn't process that. Please try again.", chips: [{ label: 'Menu', payload: 'menu' }] };

    // a quoted passage of the restaurant's own documents beats a generic built-in information answer when it matches well
    if (known?.source === 'document' && known.confidence >= 0.8 && !ctx.quick && DOC_OVERRIDES.has(result.intent ?? '')) {
      this.knowledge.record?.(rid, 'DOCUMENT', ctx.message, null);
      return this.asResult(known, 'knowledge', ctx);
    }
    if (UNANSWERED.has(result.intent ?? '') && !ctx.quick) {
      if (known && known.confidence >= KNOWLEDGE_MIN_CONFIDENCE && known.text) {
        this.knowledge.record?.(rid, this.outcomeOf(known), ctx.message, known.entryId);
        return this.asResult(known, 'knowledge', ctx);
      }
      const ev: AssistantUnansweredEvent = { restaurantId: rid, sessionId: ctx.sessionId ?? null, text: ctx.message.slice(0, 500), at: new Date().toISOString() };
      this.events.emit(ASSISTANT_UNANSWERED, ev);
    } else if (scoped && typed) {
      this.knowledge.record?.(rid, 'BUILTIN', ctx.message);
    }
    return result;
  }
}
