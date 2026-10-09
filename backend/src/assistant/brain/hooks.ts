import { Injectable } from '@nestjs/common';
import type { AliasResolver, BrainContext, KnowledgeAnswer, KnowledgeProvider } from './brain.types';

/** DI tokens: a training module can provide its own implementations (e.g. { provide: KNOWLEDGE_PROVIDER, useClass: TrainedKnowledge }). */
export const KNOWLEDGE_PROVIDER = 'ASSISTANT_KNOWLEDGE_PROVIDER';
export const ALIAS_RESOLVER = 'ASSISTANT_ALIAS_RESOLVER';

/** Event names emitted in-process (EventEmitter2). Payloads below. */
export const ASSISTANT_UNANSWERED = 'assistant.unanswered';
export const ASSISTANT_FEEDBACK = 'assistant.feedback';
export interface AssistantUnansweredEvent {
  restaurantId: string | null;
  sessionId: string | null;
  text: string;
  at: string;
}
export interface AssistantFeedbackEvent {
  restaurantId: string | null;
  /** the taught entry that gave the rated answer (null when the answer did not come from training) */
  entryId?: string | null;
  /** the customer's question that was answered (personal data is stripped before it is stored) */
  question?: string | null;
  sessionId: string;
  messageId?: string;
  rating: 'up' | 'down';
  comment?: string;
  at: string;
}

/** Default: nothing is learned, so the pipeline continues to "I don't know". */
@Injectable()
export class NullKnowledgeProvider implements KnowledgeProvider {
  async lookup(_restaurantId: string | null, _query: string, _ctx: BrainContext): Promise<KnowledgeAnswer | null> {
    return null;
  }
}

/** Default: no restaurant-specific nicknames. */
@Injectable()
export class NullAliasResolver implements AliasResolver {
  resolve(): string | null {
    return null;
  }
}
