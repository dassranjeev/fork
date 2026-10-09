import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash, randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { AssistantKbDraft, AssistantKbVersion } from '../../database/entities';
import { SettingsService } from '../../settings/settings.service';
import { Index, buildIndex, questionKey } from './engine';
import { DEFAULT_BLOCK_PHRASES, DEFAULT_HOLD_PHRASES, GuardrailConfig, stripPii, toHeld, validateEntry } from './guardrails';
import { KbContent, KbEntry, LIMITS, TestCase, emptyContent } from './types';

export const CENTRAL_SCOPE = 'central';
export const restaurantScope = (restaurantId: string) => `r:${restaurantId}`;
export const restaurantIdOf = (scopeKey: string) => (scopeKey.startsWith('r:') ? scopeKey.slice(2) : null);

const INDEX_TTL_MS = 10_000;

export interface DraftState {
  content: KbContent;
  testCases: TestCase[];
  baseVersion: number;
  updatedAt: Date;
  updatedByName: string | null;
}

export interface PublishedState {
  version: number;
  content: KbContent;
  index: Index;
}

/** make sure content read from the database has every part (older rows / hand edits never crash the bot) */
export function normContent(raw: any): KbContent {
  const c = emptyContent();
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    entries: Array.isArray(r.entries) ? r.entries.filter((e: any) => e && typeof e.id === 'string' && typeof e.answer === 'string') : c.entries,
    aliases: Array.isArray(r.aliases) ? r.aliases : c.aliases,
    synonyms: Array.isArray(r.synonyms) ? r.synonyms : c.synonyms,
    documents: Array.isArray(r.documents) ? r.documents : c.documents,
    settings: { threshold: Number.isFinite(Number(r.settings?.threshold)) ? Number(r.settings.threshold) : LIMITS.thresholdDefault },
  };
}

export const countsOf = (c: KbContent) => ({
  entries: c.entries.length,
  active: c.entries.filter((e) => e.active && !e.held).length,
  held: c.entries.filter((e) => !!e.held).length,
  aliases: c.aliases.length,
  synonyms: c.synonyms.length,
  documents: c.documents.length,
});

export const hashOf = (c: KbContent) => createHash('sha1').update(JSON.stringify(c)).digest('hex');

/**
 * Persistence of the training data: drafts, immutable versions, the cached published index, statistics. Depends only on the database and the
 * platform settings (no other assistant service), so the configuration service can use it for the FAQ screens.
 */
@Injectable()
export class TrainingStore {
  private readonly logger = new Logger('AssistantTraining');
  private cache = new Map<string, { at: number; state: PublishedState }>();
  private ensured = new Set<string>();

  constructor(
    @InjectDataSource() private ds: DataSource,
    private settings: SettingsService,
  ) {}

  // ------------------------------------------------------------------ settings
  requireApproval(): boolean {
    return this.settings.get<boolean>('assistant.training.requireApproval', false) === true;
  }

  guardrails(): GuardrailConfig {
    const list = (k: string, d: string[]) => {
      const v = this.settings.get<unknown>(k, d);
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).slice(0, 500) : d;
    };
    return { holdPhrases: list('assistant.training.holdPhrases', DEFAULT_HOLD_PHRASES), blockPhrases: list('assistant.training.blockPhrases', DEFAULT_BLOCK_PHRASES) };
  }

  // ------------------------------------------------------------------ scope bootstrap (idempotent migration of the old FAQ lists)
  private async legacyFaqs(scopeKey: string): Promise<{ q: string; a: string }[]> {
    let raw: unknown = [];
    if (scopeKey === CENTRAL_SCOPE) raw = this.settings.get<unknown>('assistant.central.faqs', []);
    else {
      const rid = restaurantIdOf(scopeKey);
      const rows: { f: unknown }[] = rid ? await this.ds.query(`SELECT meta -> 'assistant' -> 'faqs' AS f FROM restaurants WHERE id = $1`, [rid]) : [];
      raw = rows[0]?.f ?? [];
    }
    return (Array.isArray(raw) ? raw : []).filter((f: any) => f && typeof f.q === 'string' && typeof f.a === 'string' && f.q.trim() && f.a.trim()).slice(0, 20).map((f: any) => ({ q: f.q.trim(), a: f.a.trim() }));
  }

  /** Create the draft + version 1 of a scope, turning the old FAQs into knowledge entries. Safe to call any number of times. */
  async ensureScope(scopeKey: string): Promise<void> {
    if (this.ensured.has(scopeKey)) return;
    const exists = await this.ds.getRepository(AssistantKbDraft).exist({ where: { scopeKey } });
    if (!exists) {
      const faqs = await this.legacyFaqs(scopeKey);
      const now = new Date().toISOString();
      const cfg = this.guardrails();
      const ids = new Set<string>();
      const content = emptyContent();
      for (const f of faqs) {
        const v = validateEntry({ title: f.q.slice(0, LIMITS.titleChars), questions: [f.q], answer: f.a }, cfg, ids);
        const held = !v.ok ? { codes: v.issues.map((i) => i.code), messages: v.issues.map((i) => i.message).slice(0, 3), at: now } : toHeld(v.issues);
        content.entries.push({
          id: randomUUID(),
          title: v.entry.title || f.q.slice(0, LIMITS.titleChars),
          questions: v.entry.questions.length ? v.entry.questions : [f.q.slice(0, LIMITS.questionChars)],
          answer: (v.entry.answer || f.a).slice(0, LIMITS.answerChars),
          chips: [],
          tags: [],
          active: true,
          priority: 0,
          legacyFaq: true,
          liveData: v.issues.some((i) => i.code === 'live_data'),
          held,
          createdBy: null,
          createdAt: now,
          updatedAt: now,
        });
      }
      try {
        await this.ds.transaction(async (m) => {
          await m.getRepository(AssistantKbVersion).insert({ scopeKey, version: 1, content: content as any, note: faqs.length ? 'Created from your existing FAQs' : 'Initial empty knowledge base', source: 'migration', counts: countsOf(content) });
          await m.getRepository(AssistantKbDraft).insert({ scopeKey, restaurantId: restaurantIdOf(scopeKey), content: content as any, testCases: [], baseVersion: 1, updatedByName: null });
        });
        this.logger.log(`knowledge base created for ${scopeKey} (${faqs.length} FAQs migrated)`);
      } catch (e: any) {
        if (e?.code !== '23505') throw e; // someone else created it a moment ago: fine
      }
    }
    this.ensured.add(scopeKey);
  }

  /** the rows of a scope can disappear behind our back (database restore, manual clean-up): re-create them once and try again */
  private async healing<T>(scopeKey: string, fn: () => Promise<T>): Promise<T> {
    await this.ensureScope(scopeKey);
    try {
      return await fn();
    } catch (e: any) {
      if (e?.name !== 'EntityNotFoundError') throw e;
      this.ensured.delete(scopeKey);
      this.cache.delete(scopeKey);
      await this.ensureScope(scopeKey);
      return fn();
    }
  }

  // ------------------------------------------------------------------ draft
  async getDraft(scopeKey: string): Promise<DraftState> {
    const d = await this.healing(scopeKey, () => this.ds.getRepository(AssistantKbDraft).findOneOrFail({ where: { scopeKey } }));
    return { content: normContent(d.content), testCases: (Array.isArray(d.testCases) ? d.testCases : []) as TestCase[], baseVersion: d.baseVersion, updatedAt: d.updatedAt, updatedByName: d.updatedByName };
  }

  /** read-modify-write of the draft under a row lock (two editors never overwrite each other's change) */
  async mutateDraft<T>(scopeKey: string, actorName: string | null, fn: (d: { content: KbContent; testCases: TestCase[] }) => T | Promise<T>): Promise<T> {
    return this.healing(scopeKey, () => this.ds.transaction(async (m) => {
      const row = await m.getRepository(AssistantKbDraft).findOneOrFail({ where: { scopeKey }, lock: { mode: 'pessimistic_write' } });
      const state = { content: normContent(row.content), testCases: (Array.isArray(row.testCases) ? row.testCases : []) as TestCase[] };
      const out = await fn(state);
      row.content = state.content as any;
      row.testCases = state.testCases as any;
      row.updatedByName = actorName;
      await m.getRepository(AssistantKbDraft).save(row);
      return out;
    }));
  }

  async replaceDraft(scopeKey: string, content: KbContent, baseVersion: number, actorName: string | null) {
    await this.mutateDraft(scopeKey, actorName, (d) => {
      d.content = content;
    });
    await this.ds.getRepository(AssistantKbDraft).update({ scopeKey }, { content: content as any, baseVersion, updatedByName: actorName });
  }

  // ------------------------------------------------------------------ versions
  async latestVersion(scopeKey: string): Promise<AssistantKbVersion> {
    return this.healing(scopeKey, () => this.ds.getRepository(AssistantKbVersion).findOneOrFail({ where: { scopeKey }, order: { version: 'DESC' } }));
  }

  async listVersions(scopeKey: string) {
    await this.ensureScope(scopeKey);
    const rows = await this.ds.getRepository(AssistantKbVersion).find({ where: { scopeKey }, order: { version: 'DESC' }, select: ['id', 'version', 'note', 'source', 'publishedByName', 'publishedById', 'counts', 'restoredFrom', 'createdAt'] });
    return rows;
  }

  async getVersion(scopeKey: string, version: number): Promise<AssistantKbVersion | null> {
    return this.ds.getRepository(AssistantKbVersion).findOne({ where: { scopeKey, version } });
  }

  /** the immutable snapshot that goes live. Held entries stay in the snapshot (flagged) but are never searched. */
  async createVersion(scopeKey: string, content: KbContent, meta: { note?: string | null; source: string; actorId?: string | null; actorName?: string | null; restoredFrom?: number | null }): Promise<AssistantKbVersion> {
    await this.ensureScope(scopeKey);
    for (let attempt = 0; attempt < 3; attempt++) {
      const latest = await this.latestVersion(scopeKey);
      try {
        const row = await this.ds.getRepository(AssistantKbVersion).save(
          this.ds.getRepository(AssistantKbVersion).create({
            scopeKey,
            version: latest.version + 1,
            content: JSON.parse(JSON.stringify(content)),
            note: meta.note ? meta.note.slice(0, 300) : null,
            source: meta.source,
            publishedById: meta.actorId ?? null,
            publishedByName: meta.actorName ?? null,
            counts: countsOf(content),
            restoredFrom: meta.restoredFrom ?? null,
          }),
        );
        this.cache.delete(scopeKey);
        return row;
      } catch (e: any) {
        if (e?.code !== '23505') throw e;
      }
    }
    throw new Error('could not create a new version, please retry');
  }

  /** the live (published) state, with its search index (cached 10 s, dropped at once by a publish on this instance) */
  async published(scopeKey: string): Promise<PublishedState> {
    const hit = this.cache.get(scopeKey);
    if (hit && Date.now() - hit.at < INDEX_TTL_MS) return hit.state;
    const v = await this.latestVersion(scopeKey);
    if (hit && hit.state.version === v.version) {
      hit.at = Date.now();
      return hit.state;
    }
    const content = normContent(v.content);
    const state = { version: v.version, content, index: buildIndex(content) };
    if (this.cache.size > 300) this.cache.clear();
    this.cache.set(scopeKey, { at: Date.now(), state });
    return state;
  }

  /** the cached live state if it is loaded (synchronous; used by the rewrite hook after published() ran) */
  peek(scopeKey: string): PublishedState | null {
    return this.cache.get(scopeKey)?.state ?? null;
  }

  invalidate(scopeKey?: string) {
    if (scopeKey) this.cache.delete(scopeKey);
    else this.cache.clear();
  }

  // ------------------------------------------------------------------ statistics (best effort: a failure never reaches a customer)
  async bumpDaily(scopeKey: string, outcome: string) {
    await this.ds.query(`INSERT INTO assistant_daily ("scopeKey", day, outcome, count) VALUES ($1, CURRENT_DATE, $2, 1) ON CONFLICT ("scopeKey", day, outcome) DO UPDATE SET count = assistant_daily.count + 1, "updatedAt" = now()`, [scopeKey, outcome]);
  }

  /** a question customers asked (sanitised, grouped by wording). outcome: UNANSWERED | AMBIGUOUS | TRAINING | DOCUMENT */
  async recordQuestion(scopeKey: string, outcome: string, rawText: string, entryId: string | null) {
    const text = stripPii(rawText).slice(0, 240);
    if (text.length < 2) return;
    const key = (questionKey(text) || text.toLowerCase()).slice(0, 240);
    await this.ds.query(
      `INSERT INTO assistant_questions ("scopeKey", "normKey", text, outcome, "entryId", count, examples, status)
       VALUES ($1, $2, $3, $4, $5, 1, '[]'::jsonb, 'OPEN')
       ON CONFLICT ("scopeKey", "normKey", outcome) DO UPDATE SET
         count = assistant_questions.count + 1, "lastSeenAt" = now(), "updatedAt" = now(),
         "entryId" = COALESCE($5, assistant_questions."entryId"),
         examples = CASE WHEN assistant_questions.text <> $3 AND jsonb_array_length(assistant_questions.examples) < 5 AND NOT (assistant_questions.examples @> to_jsonb($3::text)) THEN assistant_questions.examples || to_jsonb($3::text) ELSE assistant_questions.examples END`,
      [scopeKey, key, text, outcome, entryId],
    );
  }

  async recordAnswered(scopeKey: string, entryId: string) {
    await this.ds.query(`INSERT INTO assistant_kb_stats ("scopeKey", "entryId", answered, "lastAnsweredAt") VALUES ($1, $2, 1, now()) ON CONFLICT ("scopeKey", "entryId") DO UPDATE SET answered = assistant_kb_stats.answered + 1, "lastAnsweredAt" = now(), "updatedAt" = now()`, [scopeKey, entryId]);
  }

  async recordFeedback(scopeKey: string, entryId: string | null, rating: 'up' | 'down', question: string | null, comment: string | null) {
    await this.ds.query(`INSERT INTO assistant_feedback ("scopeKey", "entryId", rating, question, comment) VALUES ($1, $2, $3, $4, $5)`, [scopeKey, entryId, rating, question ? stripPii(question).slice(0, 240) : null, comment ? stripPii(comment).slice(0, 500) : null]);
    if (entryId) {
      const col = rating === 'up' ? 'up' : 'down';
      await this.ds.query(`INSERT INTO assistant_kb_stats ("scopeKey", "entryId", ${col}) VALUES ($1, $2, 1) ON CONFLICT ("scopeKey", "entryId") DO UPDATE SET ${col} = assistant_kb_stats.${col} + 1, "updatedAt" = now()`, [scopeKey, entryId]);
    }
  }

  /** entry statistics for one scope: entryId -> {answered, up, down, lastAnsweredAt} */
  async statsOf(scopeKey: string): Promise<Map<string, { answered: number; up: number; down: number; lastAnsweredAt: Date | null }>> {
    const rows: any[] = await this.ds.query(`SELECT "entryId", answered, up, down, "lastAnsweredAt" FROM assistant_kb_stats WHERE "scopeKey" = $1`, [scopeKey]);
    return new Map(rows.map((r) => [r.entryId, { answered: r.answered, up: r.up, down: r.down, lastAnsweredAt: r.lastAnsweredAt }]));
  }

  /** housekeeping (daily): old questions / feedback / daily counters */
  @Cron('27 4 * * *')
  async cleanup() {
    try {
      await this.runCleanup();
    } catch (e) {
      this.logger.warn(`training cleanup failed: ${(e as Error).message}`);
    }
  }

  private async runCleanup() {
    await this.ds.query(`DELETE FROM assistant_questions WHERE ("lastSeenAt" < now() - interval '90 days' AND status <> 'OPEN') OR "lastSeenAt" < now() - interval '365 days'`);
    await this.ds.query(`DELETE FROM assistant_feedback WHERE "createdAt" < now() - interval '180 days'`);
    await this.ds.query(`DELETE FROM assistant_daily WHERE day < CURRENT_DATE - 400`);
    await this.ds.query(`UPDATE assistant_kb_requests SET status = 'CANCELLED', "decisionNote" = 'Expired without a decision' WHERE status = 'PENDING' AND "createdAt" < now() - interval '60 days'`);
  }
}

export type { KbEntry };
