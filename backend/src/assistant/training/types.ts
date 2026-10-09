/** Shapes of the trainable knowledge base ("training"). Pure data: no database, no Nest. */

export interface KbChip {
  label: string;
  /** another entry of the same knowledge base that this chip opens */
  entryId: string;
}

export interface KbEntry {
  id: string;
  title: string;
  /** phrasings a customer might use (the title is matched too) */
  questions: string[];
  answer: string;
  chips: KbChip[];
  tags: string[];
  active: boolean;
  /** 0..5: wins ties between close candidates */
  priority: number;
  /** created by the FAQ editor (kept in sync with the old "FAQs" screens) */
  legacyFaq?: boolean;
  /** the text talks about prices / hours: it is never allowed to override the live menu / hours answers */
  liveData?: boolean;
  /** set while a guardrail holds the entry back for staff review (it is NOT part of the published bot) */
  held?: { codes: string[]; messages: string[]; at: string } | null;
  /** staff released a held entry: stays released as long as the text is unchanged (hash of title, phrasings and answer) */
  released?: { by: string; at: string; hash: string } | null;
  createdBy?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface KbAlias {
  id: string;
  kind: 'item' | 'category';
  alias: string;
  /** menu item id (kind=item) */
  targetId?: string;
  /** item or category name (shown in screens, used as the rewrite target for categories) */
  targetName: string;
}

export interface KbSynonym {
  id: string;
  /** the canonical word / phrase */
  term: string;
  alternates: string[];
}

export interface KbDocument {
  id: string;
  title: string;
  text: string;
  /** a guardrail holds the document back for staff review (it is not searched) */
  held?: { codes: string[]; messages: string[]; at: string } | null;
  released?: { by: string; at: string; hash: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface KbSettings {
  /** confidence needed for the bot to answer from an entry (0.4 .. 0.9) */
  threshold: number;
}

export interface KbContent {
  entries: KbEntry[];
  aliases: KbAlias[];
  synonyms: KbSynonym[];
  documents: KbDocument[];
  settings: KbSettings;
}

export interface TestCase {
  id: string;
  question: string;
  /** passes when this entry answers */
  expectEntryId?: string | null;
  /** passes when the answer text contains this phrase */
  expectPhrase?: string | null;
  /** passes when the bot would NOT answer from training */
  expectUnanswered?: boolean;
  createdAt: string;
}

export const LIMITS = {
  entries: 500,
  questionsPerEntry: 15,
  titleChars: 80,
  questionChars: 200,
  answerChars: 800,
  chipsPerEntry: 3,
  chipLabelChars: 30,
  tagsPerEntry: 8,
  tagChars: 24,
  aliases: 200,
  aliasChars: 40,
  synonyms: 100,
  alternatesPerSynonym: 10,
  documents: 20,
  documentChars: 20_000,
  documentTitleChars: 80,
  testCases: 100,
  thresholdMin: 0.4,
  thresholdMax: 0.9,
  thresholdDefault: 0.6,
} as const;

export const emptyContent = (): KbContent => ({ entries: [], aliases: [], synonyms: [], documents: [], settings: { threshold: LIMITS.thresholdDefault } });

export interface FieldIssue {
  /** e.g. "answer", "questions[2]", "alias" */
  field: string;
  code: string;
  /** block = refused, hold = saved but kept out of the live bot until staff approve it, warn = saved with a note */
  severity: 'block' | 'hold' | 'warn';
  message: string;
}
