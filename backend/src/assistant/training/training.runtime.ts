import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { AliasResolver, BrainContext, KnowledgeAnswer, KnowledgeProvider, TrainingOutcome } from '../brain/brain.types';
import { ASSISTANT_FEEDBACK, ASSISTANT_UNANSWERED, AssistantFeedbackEvent, AssistantUnansweredEvent } from '../brain/hooks';
import { contentTokens } from '../brain/search';
import { canonicalize, search } from './engine';
import { CENTRAL_SCOPE, TrainingStore, restaurantScope } from './training.store';

const scopeOf = (restaurantId: string | null) => (restaurantId ? restaurantScope(restaurantId) : CENTRAL_SCOPE);

/**
 * Plugs the trained knowledge base into the answer pipeline (AssistantBrains):
 *  - KnowledgeProvider: matches the customer's question against the PUBLISHED entries / documents of this bot only
 *    (a restaurant bot never sees another restaurant's training; the central bot has its own).
 *  - AliasResolver: restaurant nicknames for menu items ("marg" -> Margherita).
 *  - statistics: records answered / unanswered / ambiguous outcomes and thumbs (no session ids, personal data stripped).
 */
@Injectable()
export class TrainedKnowledge implements KnowledgeProvider, AliasResolver {
  private readonly logger = new Logger('TrainedKnowledge');
  /** restaurantId -> normalised alias -> menu item id (filled by prepare() from the published version) */
  private aliasMaps = new Map<string, { version: number; map: Map<string, string> }>();

  constructor(private store: TrainingStore) {}

  // ------------------------------------------------------------------ hooks
  async prepare(restaurantId: string | null): Promise<void> {
    const key = scopeOf(restaurantId);
    const pub = await this.store.published(key);
    if (restaurantId) {
      const cur = this.aliasMaps.get(restaurantId);
      if (!cur || cur.version !== pub.version) {
        const map = new Map<string, string>();
        for (const a of pub.content.aliases) if (a.kind === 'item' && a.targetId) map.set(contentTokens(a.alias).join(' '), a.targetId);
        if (this.aliasMaps.size > 500) this.aliasMaps.clear();
        this.aliasMaps.set(restaurantId, { version: pub.version, map });
      }
    }
  }

  resolve(restaurantId: string, normalisedPhrase: string): string | null {
    return this.aliasMaps.get(restaurantId)?.map.get(normalisedPhrase) ?? null;
  }

  rewrite(restaurantId: string | null, text: string): string {
    const state = this.peek(restaurantId);
    if (!state) return text;
    const { synonyms, aliases } = state;
    if (!synonyms.length && !aliases.length) return text;
    return canonicalize(text, synonyms, aliases.filter((a) => a.kind === 'category').map((a) => ({ from: a.alias, to: a.targetName })));
  }

  /** synchronous peek at the already prepared (cached) published content */
  private peek(restaurantId: string | null) {
    return this.store.peek(scopeOf(restaurantId))?.content ?? null;
  }

  async lookup(restaurantId: string | null, _normalisedQuery: string, ctx: BrainContext): Promise<KnowledgeAnswer | null> {
    const pub = await this.store.published(scopeOf(restaurantId));
    const res = search(pub.index, ctx.message);
    if (res.outcome === 'answer' && res.best) {
      const e = pub.index.entryById.get(res.best.entryId)!;
      return { text: e.answer, confidence: res.best.score, strong: res.strong, entryId: e.id, source: 'entry', chips: e.chips.filter((c) => pub.index.entryById.has(c.entryId)).map((c) => ({ label: c.label, payload: `kb:${c.entryId}` })) };
    }
    if (res.outcome === 'ambiguous') {
      return { text: 'Did you mean one of these?', confidence: res.ambiguous[0].score, source: 'ambiguous', chips: res.ambiguous.slice(0, 3).map((c) => ({ label: c.title.slice(0, 40), payload: `kb:${c.entryId}` })) };
    }
    if (res.outcome === 'document' && res.passage) {
      return { text: `From our info: "${res.passage.text}"`, confidence: res.passage.score, source: 'document', entryId: null };
    }
    return null;
  }

  async entry(restaurantId: string | null, entryId: string): Promise<KnowledgeAnswer | null> {
    const pub = await this.store.published(scopeOf(restaurantId));
    const e = pub.index.entryById.get(entryId);
    if (!e) return null;
    return { text: e.answer, confidence: 1, strong: true, entryId: e.id, source: 'entry', chips: e.chips.filter((c) => pub.index.entryById.has(c.entryId)).map((c) => ({ label: c.label, payload: `kb:${c.entryId}` })) };
  }

  record(restaurantId: string | null, outcome: TrainingOutcome, text: string, entryId?: string | null): void {
    const key = scopeOf(restaurantId);
    void (async () => {
      try {
        if (outcome !== 'UNANSWERED') await this.store.bumpDaily(key, outcome); // UNANSWERED is counted by the event listener below
        if (outcome === 'TRAINING' && entryId) await this.store.recordAnswered(key, entryId);
        if (outcome === 'TRAINING' || outcome === 'DOCUMENT' || outcome === 'AMBIGUOUS') await this.store.recordQuestion(key, outcome, text, entryId ?? null);
      } catch (e) {
        this.logger.warn(`could not record ${outcome}: ${(e as Error).message}`);
      }
    })();
  }

  // ------------------------------------------------------------------ events
  /** the bot could not answer: store the (sanitised, grouped) question for the unanswered inbox */
  @OnEvent(ASSISTANT_UNANSWERED, { async: true })
  async onUnanswered(ev: AssistantUnansweredEvent) {
    try {
      const key = scopeOf(ev.restaurantId);
      await this.store.bumpDaily(key, 'UNANSWERED');
      await this.store.recordQuestion(key, 'UNANSWERED', ev.text, null);
    } catch (e) {
      this.logger.warn(`could not store an unanswered question: ${(e as Error).message}`);
    }
  }

  @OnEvent(ASSISTANT_FEEDBACK, { async: true })
  async onFeedback(ev: AssistantFeedbackEvent) {
    try {
      await this.store.recordFeedback(scopeOf(ev.restaurantId), ev.entryId ?? null, ev.rating, ev.question ?? null, ev.comment ?? null);
    } catch (e) {
      this.logger.warn(`could not store feedback: ${(e as Error).message}`);
    }
  }
}
