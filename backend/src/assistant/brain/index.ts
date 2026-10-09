/**
 * Reusable, pure (no database, no Nest) text engine of the assistant: normaliser, tokenizer, stemmer, similarity scorers and the
 * menu matcher. Import from here when you need the same matching rules elsewhere (e.g. a training / test-set tool).
 */
export * from './nlp';
export * from './search';
export * from './reply';
export * from './brain.types';
