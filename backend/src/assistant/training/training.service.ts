import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash, randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { AuditService } from '../../audit/audit.service';
import { AssistantKbRequest } from '../../database/entities';
import { NotificationsService } from '../../notifications/notifications.service';
import { AssistantKnowledgeService } from '../assistant-knowledge.service';
import { matchCategory, resolveItem } from '../brain/search';
import { contentTokens } from '../brain/search';
import { Index, answerOf, buildIndex, clampThreshold, questionKey, questionSimilarity, regressions, runTestCase, runTestSet, search, terms } from './engine';
import { entriesFromCsv, entriesToCsv } from './csv';
import { CleanEntry, EntryInput, checkText, stripPii, toHeld, validateEntry } from './guardrails';
import { CENTRAL_SCOPE, TrainingStore, countsOf, hashOf, normContent, restaurantIdOf, restaurantScope } from './training.store';
import { FieldIssue, KbAlias, KbContent, KbDocument, KbEntry, KbSynonym, LIMITS, TestCase, emptyContent } from './types';

export interface TScope {
  key: string;
  restaurantId: string | null;
  central: boolean;
  label: string;
}

export interface TActor {
  id: string;
  name: string;
  /** a restaurant user (publishing may need approval) or FORKY staff (always allowed to publish) */
  type: 'restaurant' | 'staff';
  req?: any;
}

/** Starter questions suggested to a restaurant with an empty knowledge base. */
export const STARTERS = [
  { key: 'parking', title: 'Parking', question: 'Do you have parking?', hint: 'Where guests can park, free or paid, how many spots.' },
  { key: 'allergies', title: 'Allergies', question: 'I have a food allergy, what should I do?', hint: 'Tell guests to speak to staff before ordering. Never promise a dish is allergen free.' },
  { key: 'catering', title: 'Catering', question: 'Do you do catering?', hint: 'Group sizes, how far ahead to order, who to contact.' },
  { key: 'hours-holiday', title: 'Holiday hours', question: 'Are you open on holidays?', hint: 'Your holiday schedule (normal opening hours are answered from your profile).' },
  { key: 'payment', title: 'Payment methods', question: 'What payment methods do you accept?', hint: 'Payment happens online at checkout on FORKY.' },
  { key: 'dietary', title: 'Dietary options', question: 'Do you have vegetarian or vegan options?', hint: 'What you offer; the menu tags are used for details.' },
  { key: 'wifi', title: 'Wi-Fi', question: 'Do you have wifi?', hint: 'Whether dine-in guests get Wi-Fi.' },
];

const MAX_ENTRIES = LIMITS.entries;

function fail(issues: FieldIssue[], status: 'bad' | 'conflict' = 'bad'): never {
  const body = { statusCode: status === 'bad' ? 400 : 409, message: issues[0]?.message ?? 'Invalid input', details: issues };
  throw status === 'bad' ? new BadRequestException(body) : new ConflictException(body);
}

const pick = (e: KbEntry) => JSON.stringify([e.title, e.questions, e.answer, e.chips, e.active, e.priority]);
const textHash = (e: { title: string; questions: string[]; answer: string }) => createHash('sha1').update(JSON.stringify([e.title, e.questions, e.answer])).digest('hex');

@Injectable()
export class TrainingService {
  private readonly logger = new Logger('AssistantTrainingApi');

  constructor(
    @InjectDataSource() private ds: DataSource,
    private store: TrainingStore,
    private menu: AssistantKnowledgeService,
    private audit: AuditService,
    private notifications: NotificationsService,
  ) {}

  // ================================================================== scopes
  async scopeOfRestaurant(restaurantId: string): Promise<TScope> {
    const rows: { name: string }[] = await this.ds.query(`SELECT name FROM restaurants WHERE id = $1`, [restaurantId]);
    if (!rows.length) throw new NotFoundException('Restaurant not found');
    return { key: restaurantScope(restaurantId), restaurantId, central: false, label: rows[0].name };
  }

  centralScope(): TScope {
    return { key: CENTRAL_SCOPE, restaurantId: null, central: true, label: 'FORKY website bot' };
  }

  private async log(actor: TActor, scope: TScope, action: string, after: Record<string, unknown>) {
    // counts only, never the texts a restaurant taught
    await this.audit.log({ actor: actor.req?.user ?? { id: actor.id, type: actor.type === 'staff' ? 'STAFF' : 'RESTAURANT' } as any, action: `assistant.training.${action}`, entity: scope.central ? 'settings' : 'restaurant', entityId: scope.restaurantId ?? undefined, after: { scope: scope.key, ...after }, ip: actor.req?.ip, path: actor.req?.originalUrl, method: actor.req?.method }).catch(() => undefined);
  }

  private guard() {
    return this.store.guardrails();
  }

  // ================================================================== entries
  private entryView(e: KbEntry, published: Map<string, KbEntry>, stats: Map<string, any>) {
    const live = published.get(e.id);
    const s = stats.get(e.id);
    return {
      ...e,
      state: e.held ? 'held' : !live ? 'new' : pick(live) === pick(e) ? 'live' : 'changed',
      stats: { answered: s?.answered ?? 0, up: s?.up ?? 0, down: s?.down ?? 0, lastAnsweredAt: s?.lastAnsweredAt ?? null },
    };
  }

  async listEntries(scope: TScope, q: { search?: string; status?: string; page?: number; limit?: number }) {
    const [draft, pub, stats] = await Promise.all([this.store.getDraft(scope.key), this.store.published(scope.key), this.store.statsOf(scope.key)]);
    const published = new Map(pub.content.entries.map((e) => [e.id, e]));
    let rows = draft.content.entries.map((e) => this.entryView(e, published, stats));
    const s = (q.search ?? '').trim().toLowerCase();
    if (s) rows = rows.filter((e) => `${e.title} ${e.questions.join(' ')} ${e.answer} ${e.tags.join(' ')}`.toLowerCase().includes(s));
    if (q.status === 'active') rows = rows.filter((e) => e.active && !e.held);
    else if (q.status === 'inactive') rows = rows.filter((e) => !e.active);
    else if (q.status === 'held') rows = rows.filter((e) => !!e.held);
    else if (q.status === 'review') rows = rows.filter((e) => e.stats.down > 0 && e.stats.down >= e.stats.up);
    else if (q.status === 'unpublished') rows = rows.filter((e) => e.state !== 'live');
    rows.sort((a, b) => a.title.localeCompare(b.title));
    const limit = Math.min(100, Math.max(1, q.limit ?? 20));
    const page = Math.max(1, q.page ?? 1);
    return { data: rows.slice((page - 1) * limit, page * limit), meta: { page, limit, total: rows.length, totalPages: Math.max(1, Math.ceil(rows.length / limit)) } };
  }

  async getEntry(scope: TScope, id: string) {
    const [draft, pub, stats] = await Promise.all([this.store.getDraft(scope.key), this.store.published(scope.key), this.store.statsOf(scope.key)]);
    const e = draft.content.entries.find((x) => x.id === id);
    if (!e) throw new NotFoundException('Answer not found');
    return this.entryView(e, new Map(pub.content.entries.map((x) => [x.id, x])), stats);
  }

  /** validate + normalise an entry against the rest of the base; returns what to store plus the per-field warnings */
  private prepare(content: KbContent, input: EntryInput, selfId?: string): { clean: CleanEntry; issues: FieldIssue[] } {
    const ids = new Set(content.entries.map((e) => e.id));
    const v = validateEntry(input, this.guard(), ids, selfId);
    const issues = [...v.issues];
    // the same wording in two different answers makes the bot unsure which to give: warn
    const seen = new Map<string, string>();
    for (const e of content.entries) if (e.id !== selfId) for (const q of [...e.questions]) seen.set(questionKey(q), e.title);
    v.entry.questions.forEach((q, i) => {
      const other = seen.get(questionKey(q));
      if (other) issues.push({ field: `questions[${i}]`, code: 'duplicate_phrasing', severity: 'warn', message: `"${q}" is also taught under "${other}". The bot will ask "Did you mean...?" when it cannot tell them apart.` });
    });
    if (issues.some((i) => i.severity === 'block')) fail(issues.filter((i) => i.severity === 'block').concat(issues.filter((i) => i.severity !== 'block')));
    return { clean: v.entry, issues };
  }

  async createEntry(scope: TScope, actor: TActor, body: EntryInput) {
    let issues: FieldIssue[] = [];
    const entry = await this.store.mutateDraft(scope.key, actor.name, (d) => {
      if (d.content.entries.length >= MAX_ENTRIES) fail([{ field: 'entries', code: 'too_many', severity: 'block', message: `A bot can hold at most ${MAX_ENTRIES} answers. Remove ones you do not need.` }]);
      const p = this.prepare(d.content, body);
      issues = p.issues;
      const now = new Date().toISOString();
      const e: KbEntry = { id: randomUUID(), ...p.clean, legacyFaq: false, liveData: p.issues.some((i) => i.code === 'live_data'), held: toHeld(p.issues), released: null, createdBy: actor.name, createdAt: now, updatedAt: now };
      d.content.entries.push(e);
      return e;
    });
    await this.log(actor, scope, 'entry.create', { entries: 1 });
    return { entry, issues };
  }

  async updateEntry(scope: TScope, actor: TActor, id: string, body: EntryInput) {
    let issues: FieldIssue[] = [];
    const entry = await this.store.mutateDraft(scope.key, actor.name, (d) => {
      const cur = d.content.entries.find((e) => e.id === id);
      if (!cur) throw new NotFoundException('Answer not found');
      const merged: EntryInput = { title: cur.title, questions: cur.questions, answer: cur.answer, chips: cur.chips, tags: cur.tags, active: cur.active, priority: cur.priority, ...Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)) };
      const p = this.prepare(d.content, merged, id);
      issues = p.issues;
      const held = toHeld(p.issues);
      // staff released this exact text before: it stays released until somebody changes it
      const sameText = cur.released && cur.released.hash === textHash(p.clean);
      Object.assign(cur, p.clean, { liveData: p.issues.some((i) => i.code === 'live_data'), held: sameText ? null : held, released: sameText ? cur.released : null, updatedAt: new Date().toISOString() });
      return cur;
    });
    await this.log(actor, scope, 'entry.update', { entries: 1 });
    return { entry, issues };
  }

  async deleteEntry(scope: TScope, actor: TActor, id: string) {
    await this.store.mutateDraft(scope.key, actor.name, (d) => {
      if (!d.content.entries.some((e) => e.id === id)) throw new NotFoundException('Answer not found');
      d.content.entries = d.content.entries.filter((e) => e.id !== id);
      for (const e of d.content.entries) e.chips = e.chips.filter((c) => c.entryId !== id);
    });
    await this.log(actor, scope, 'entry.delete', { entries: 1 });
    return { ok: true };
  }

  async bulk(scope: TScope, actor: TActor, action: string, ids: string[]) {
    if (!['activate', 'deactivate', 'delete'].includes(action)) fail([{ field: 'action', code: 'invalid', severity: 'block', message: 'action must be activate, deactivate or delete' }]);
    const set = new Set(ids);
    const n = await this.store.mutateDraft(scope.key, actor.name, (d) => {
      let changed = 0;
      if (action === 'delete') {
        const before = d.content.entries.length;
        d.content.entries = d.content.entries.filter((e) => !set.has(e.id));
        for (const e of d.content.entries) e.chips = e.chips.filter((c) => !set.has(c.entryId));
        changed = before - d.content.entries.length;
      } else
        for (const e of d.content.entries)
          if (set.has(e.id) && e.active !== (action === 'activate')) {
            e.active = action === 'activate';
            e.updatedAt = new Date().toISOString();
            changed++;
          }
      return changed;
    });
    await this.log(actor, scope, `entry.bulk-${action}`, { entries: n });
    return { changed: n };
  }

  // ================================================================== nicknames (aliases) + synonyms
  async aliasesAndSynonyms(scope: TScope) {
    const d = await this.store.getDraft(scope.key);
    return { aliases: d.content.aliases, synonyms: d.content.synonyms };
  }

  /** the menu items / categories a nickname can point to (restaurant bots only) */
  async menuOptions(scope: TScope) {
    if (!scope.restaurantId) return { items: [], categories: [] };
    const kb = await this.menu.forRestaurant(scope.restaurantId);
    return { items: (kb?.items ?? []).map((i) => ({ id: i.id, name: i.name, category: i.category })), categories: (kb?.categories ?? []).map((c) => c.name) };
  }

  async addAlias(scope: TScope, actor: TActor, body: { kind: 'item' | 'category'; alias: string; targetId?: string; targetName?: string }) {
    if (scope.central || !scope.restaurantId) fail([{ field: 'kind', code: 'invalid', severity: 'block', message: 'Nicknames belong to a restaurant menu. The FORKY website bot has no menu.' }]);
    const rawAlias = String(body.alias ?? '');
    const alias = stripPii(rawAlias).trim().slice(0, LIMITS.aliasChars + 1);
    const issues: FieldIssue[] = [];
    if (!alias) issues.push({ field: 'alias', code: 'required', severity: 'block', message: 'Type the nickname customers use.' });
    if (alias.length > LIMITS.aliasChars) issues.push({ field: 'alias', code: 'too_long', severity: 'block', message: `A nickname can have at most ${LIMITS.aliasChars} characters.` });
    issues.push(...checkText(rawAlias.slice(0, 200), 'alias', this.guard()).filter((i) => i.severity === 'block')); // the RAW text: personal data must be refused, not silently removed
    if (issues.length) fail(issues);
    const key = contentTokens(alias).join(' ');
    if (!key) fail([{ field: 'alias', code: 'invalid', severity: 'block', message: 'That nickname has no usable word.' }]);
    const kb = await this.menu.forRestaurant(scope.restaurantId);
    if (!kb) fail([{ field: 'kind', code: 'unavailable', severity: 'block', message: 'The menu is not available right now, try again later.' }]);
    let targetName = '';
    let targetId: string | undefined;
    if (body.kind === 'item') {
      const item = kb!.items.find((i) => i.id === body.targetId);
      if (!item) fail([{ field: 'targetId', code: 'invalid_target', severity: 'block', message: 'Choose one of the items on your menu.' }]);
      targetId = item!.id;
      targetName = item!.name;
      const r = resolveItem(alias, kb!);
      if (r.kind === 'one' && r.match.item.id !== item!.id) fail([{ field: 'alias', code: 'conflict', severity: 'block', message: `"${alias}" already means "${r.match.item.name}" on your menu, so it cannot also point to "${item!.name}".` }], 'conflict');
      if (r.kind === 'many') fail([{ field: 'alias', code: 'conflict', severity: 'block', message: `"${alias}" matches several items (${r.matches.slice(0, 3).map((m) => m.item.name).join(', ')}). Pick a more specific nickname.` }], 'conflict');
      if (r.kind === 'one' && r.match.item.id === item!.id && r.match.score >= 0.97) fail([{ field: 'alias', code: 'redundant', severity: 'block', message: `"${alias}" already finds "${item!.name}" without a nickname.` }]);
    } else if (body.kind === 'category') {
      const cat = kb!.categories.find((c) => c.name === body.targetName || c.id === body.targetId);
      if (!cat) fail([{ field: 'targetName', code: 'invalid_target', severity: 'block', message: 'Choose one of the categories on your menu.' }]);
      targetName = cat!.name;
      targetId = cat!.id ?? undefined;
      const m = matchCategory(contentTokens(alias), kb!);
      if (m && m.name !== cat!.name) fail([{ field: 'alias', code: 'conflict', severity: 'block', message: `"${alias}" already means the category "${m.name}".` }], 'conflict');
    } else fail([{ field: 'kind', code: 'invalid', severity: 'block', message: 'kind must be item or category' }]);
    const created = await this.store.mutateDraft(scope.key, actor.name, (d) => {
      if (d.content.aliases.length >= LIMITS.aliases) fail([{ field: 'alias', code: 'too_many', severity: 'block', message: `At most ${LIMITS.aliases} nicknames.` }]);
      const dup = d.content.aliases.find((a) => contentTokens(a.alias).join(' ') === key);
      if (dup) fail([{ field: 'alias', code: 'conflict', severity: 'block', message: `"${alias}" is already a nickname for "${dup.targetName}".` }], 'conflict');
      const a: KbAlias = { id: randomUUID(), kind: body.kind, alias, targetId, targetName };
      d.content.aliases.push(a);
      return a;
    });
    await this.log(actor, scope, 'alias.add', { aliases: 1 });
    return created;
  }

  async deleteAlias(scope: TScope, actor: TActor, id: string) {
    await this.store.mutateDraft(scope.key, actor.name, (d) => {
      if (!d.content.aliases.some((a) => a.id === id)) throw new NotFoundException('Nickname not found');
      d.content.aliases = d.content.aliases.filter((a) => a.id !== id);
    });
    await this.log(actor, scope, 'alias.delete', { aliases: 1 });
    return { ok: true };
  }

  private cleanSynonym(content: KbContent, body: { term: string; alternates: string[] }, selfId?: string): { term: string; alternates: string[] } {
    const issues: FieldIssue[] = [];
    const term = stripPii(String(body.term ?? '')).trim().toLowerCase().slice(0, LIMITS.aliasChars + 1);
    const alts = [...new Set((Array.isArray(body.alternates) ? body.alternates : []).map((a) => stripPii(String(a ?? '')).trim().toLowerCase().slice(0, LIMITS.aliasChars + 1)).filter(Boolean))];
    if (!term) issues.push({ field: 'term', code: 'required', severity: 'block', message: 'Type the main word, for example "pop".' });
    if (term.length > LIMITS.aliasChars) issues.push({ field: 'term', code: 'too_long', severity: 'block', message: `At most ${LIMITS.aliasChars} characters.` });
    if (!alts.length) issues.push({ field: 'alternates', code: 'required', severity: 'block', message: 'Add at least one other way to say it, for example "soft drink".' });
    if (alts.length > LIMITS.alternatesPerSynonym) issues.push({ field: 'alternates', code: 'too_many', severity: 'block', message: `At most ${LIMITS.alternatesPerSynonym} alternatives.` });
    alts.forEach((a, i) => {
      if (a.length > LIMITS.aliasChars) issues.push({ field: `alternates[${i}]`, code: 'too_long', severity: 'block', message: `"${a.slice(0, 20)}..." is too long (max ${LIMITS.aliasChars}).` });
      if (normalizeKey(a) === normalizeKey(term)) issues.push({ field: `alternates[${i}]`, code: 'same_as_term', severity: 'block', message: `"${a}" is the same as the main word.` });
    });
    issues.push(...checkText(`${String(body.term ?? '')} ${(Array.isArray(body.alternates) ? body.alternates : []).map(String).join(' ')}`.slice(0, 600), 'term', this.guard()).filter((i) => i.severity === 'block'));
    for (const g of content.synonyms) {
      if (g.id === selfId) continue;
      const all = [g.term, ...g.alternates].map(normalizeKey);
      for (const w of [term, ...alts]) if (all.includes(normalizeKey(w))) issues.push({ field: 'alternates', code: 'conflict', severity: 'block', message: `"${w}" is already used in the group "${g.term}". A word can only belong to one group.` });
    }
    if (issues.length) fail(issues, issues.some((i) => i.code === 'conflict') ? 'conflict' : 'bad');
    return { term, alternates: alts.slice(0, LIMITS.alternatesPerSynonym) };
  }

  async addSynonym(scope: TScope, actor: TActor, body: { term: string; alternates: string[] }) {
    const s = await this.store.mutateDraft(scope.key, actor.name, (d) => {
      if (d.content.synonyms.length >= LIMITS.synonyms) fail([{ field: 'term', code: 'too_many', severity: 'block', message: `At most ${LIMITS.synonyms} synonym groups.` }]);
      const c = this.cleanSynonym(d.content, body);
      const g: KbSynonym = { id: randomUUID(), ...c };
      d.content.synonyms.push(g);
      return g;
    });
    await this.log(actor, scope, 'synonym.add', { synonyms: 1 });
    return s;
  }

  async updateSynonym(scope: TScope, actor: TActor, id: string, body: { term: string; alternates: string[] }) {
    const s = await this.store.mutateDraft(scope.key, actor.name, (d) => {
      const g = d.content.synonyms.find((x) => x.id === id);
      if (!g) throw new NotFoundException('Synonym group not found');
      Object.assign(g, this.cleanSynonym(d.content, body, id));
      return g;
    });
    await this.log(actor, scope, 'synonym.update', { synonyms: 1 });
    return s;
  }

  async deleteSynonym(scope: TScope, actor: TActor, id: string) {
    await this.store.mutateDraft(scope.key, actor.name, (d) => {
      if (!d.content.synonyms.some((x) => x.id === id)) throw new NotFoundException('Synonym group not found');
      d.content.synonyms = d.content.synonyms.filter((x) => x.id !== id);
    });
    await this.log(actor, scope, 'synonym.delete', { synonyms: 1 });
    return { ok: true };
  }

  // ================================================================== documents
  private docIssues(title: string, text: string): FieldIssue[] {
    const issues: FieldIssue[] = [];
    if (!title) issues.push({ field: 'title', code: 'required', severity: 'block', message: 'Give the document a title (for example "Allergy policy").' });
    if (title.length > LIMITS.documentTitleChars) issues.push({ field: 'title', code: 'too_long', severity: 'block', message: `Title: at most ${LIMITS.documentTitleChars} characters.` });
    if (!text.trim()) issues.push({ field: 'text', code: 'required', severity: 'block', message: 'Paste the text of the document.' });
    if (text.length > LIMITS.documentChars) issues.push({ field: 'text', code: 'too_long', severity: 'block', message: `A document can have at most ${LIMITS.documentChars.toLocaleString('en-CA')} characters (this one has ${text.length.toLocaleString('en-CA')}). Split it into several documents.` });
    issues.push(...checkText(text.slice(0, LIMITS.documentChars), 'text', this.guard()));
    issues.push(...checkText(title, 'title', this.guard()));
    return issues;
  }

  private cleanDoc(body: { title?: string; text?: string }) {
    const clean = (s: unknown, max: number) => stripHtmlPlain(typeof s === 'string' ? s : '').slice(0, max + 1);
    return { title: clean(body.title, LIMITS.documentTitleChars).trim(), text: clean(body.text, LIMITS.documentChars + 1).replace(/\r/g, '').trim() };
  }

  async listDocuments(scope: TScope) {
    const d = await this.store.getDraft(scope.key);
    return d.content.documents.map((x) => ({ ...x, chars: x.text.length, passages: Math.max(1, Math.ceil(x.text.length / 240)) }));
  }

  async saveDocument(scope: TScope, actor: TActor, id: string | null, body: { title?: string; text?: string }) {
    const { title, text } = this.cleanDoc(body);
    const issues = this.docIssues(title, text);
    if (issues.some((i) => i.severity === 'block')) fail(issues);
    const doc = await this.store.mutateDraft(scope.key, actor.name, (d) => {
      const now = new Date().toISOString();
      const held = toHeld(issues);
      if (id) {
        const cur = d.content.documents.find((x) => x.id === id);
        if (!cur) throw new NotFoundException('Document not found');
        const same = cur.released && cur.released.hash === textHash({ title, questions: [], answer: text });
        Object.assign(cur, { title, text, held: same ? null : held, updatedAt: now });
        return cur;
      }
      if (d.content.documents.length >= LIMITS.documents) fail([{ field: 'title', code: 'too_many', severity: 'block', message: `At most ${LIMITS.documents} documents.` }]);
      const doc: KbDocument = { id: randomUUID(), title, text, held, released: null, createdAt: now, updatedAt: now };
      d.content.documents.push(doc);
      return doc;
    });
    await this.log(actor, scope, id ? 'document.update' : 'document.add', { documents: 1, chars: text.length });
    return { document: doc, issues };
  }

  async deleteDocument(scope: TScope, actor: TActor, id: string) {
    await this.store.mutateDraft(scope.key, actor.name, (d) => {
      if (!d.content.documents.some((x) => x.id === id)) throw new NotFoundException('Document not found');
      d.content.documents = d.content.documents.filter((x) => x.id !== id);
    });
    await this.log(actor, scope, 'document.delete', { documents: 1 });
    return { ok: true };
  }

  // ================================================================== unanswered inbox
  /** OPEN unanswered questions grouped by similar wording, most asked first */
  private async groups(scope: TScope, status: string) {
    const rows: any[] = await this.ds.query(`SELECT id, "normKey", text, count, "firstSeenAt", "lastSeenAt", examples, status, "resolvedEntryId" FROM assistant_questions WHERE "scopeKey" = $1 AND outcome = 'UNANSWERED' AND status = $2 ORDER BY count DESC, "lastSeenAt" DESC LIMIT 400`, [scope.key, status]);
    const groups: { rep: any; rows: any[]; count: number; last: Date; first: Date }[] = [];
    for (const r of rows) {
      const g = groups.find((x) => questionSimilarity(x.rep.normKey, r.normKey) >= 0.75);
      if (g) {
        g.rows.push(r);
        g.count += r.count;
        if (new Date(r.lastSeenAt) > g.last) g.last = new Date(r.lastSeenAt);
        if (new Date(r.firstSeenAt) < g.first) g.first = new Date(r.firstSeenAt);
      } else groups.push({ rep: r, rows: [r], count: r.count, last: new Date(r.lastSeenAt), first: new Date(r.firstSeenAt) });
    }
    return groups.sort((a, b) => b.count - a.count || b.last.getTime() - a.last.getTime());
  }

  private phrasingsOf(g: { rep: any; rows: any[] }): string[] {
    const out: string[] = [];
    for (const r of g.rows) for (const t of [r.text, ...(r.examples ?? [])]) if (t && !out.some((o) => questionKey(o) === questionKey(t))) out.push(t);
    return out.slice(0, 8);
  }

  async unanswered(scope: TScope, status = 'OPEN') {
    const st = ['OPEN', 'TAUGHT', 'IGNORED'].includes(status) ? status : 'OPEN';
    const [groups, draft] = await Promise.all([this.groups(scope, st), this.store.getDraft(scope.key)]);
    const index = buildIndex(draft.content);
    const data = groups.slice(0, 60).map((g) => {
      const examples = this.phrasingsOf(g);
      const res = search(index, g.rep.text);
      return {
        id: g.rep.id,
        text: g.rep.text,
        examples,
        count: g.count,
        firstSeenAt: g.first,
        lastSeenAt: g.last,
        status: st,
        resolvedEntryId: g.rep.resolvedEntryId ?? null,
        suggestions: {
          /** the closest existing answers: "add as another phrasing of ..." */
          entries: res.candidates.slice(0, 3).map((c) => ({ id: c.entryId, title: c.title, score: c.score })),
          /** an auto-suggested answer: the closest passage of your documents, or the closest answer's text */
          answer: res.passage ? { source: `Document: ${res.passage.documentTitle}`, text: res.passage.text.slice(0, LIMITS.answerChars) } : null,
        },
      };
    });
    return { data, total: groups.length, totalAsks: groups.reduce((n, g) => n + g.count, 0) };
  }

  private async groupOf(scope: TScope, id: string, status = 'OPEN') {
    const groups = await this.groups(scope, status);
    const g = groups.find((x) => x.rows.some((r) => r.id === id));
    if (!g) throw new NotFoundException('That question was not found (it may already be handled).');
    return g;
  }

  private async mark(scope: TScope, ids: string[], status: string, entryId: string | null) {
    if (ids.length) await this.ds.query(`UPDATE assistant_questions SET status = $1, "resolvedEntryId" = $2, "updatedAt" = now() WHERE "scopeKey" = $3 AND id = ANY($4::uuid[])`, [status, entryId, scope.key, ids]);
  }

  async teachFromUnanswered(scope: TScope, actor: TActor, id: string, body: { title?: string; answer?: string; questions?: string[]; chips?: any[]; tags?: string[] }) {
    const g = await this.groupOf(scope, id);
    const questions = [...new Set([...(Array.isArray(body.questions) ? body.questions : []), ...this.phrasingsOf(g)])].slice(0, LIMITS.questionsPerEntry);
    const { entry, issues } = await this.createEntry(scope, actor, { title: body.title || g.rep.text, questions, answer: body.answer, chips: body.chips, tags: body.tags });
    await this.mark(scope, g.rows.map((r) => r.id), 'TAUGHT', entry.id);
    await this.log(actor, scope, 'unanswered.teach', { questions: g.count });
    return { entry, issues };
  }

  async mergeUnanswered(scope: TScope, actor: TActor, id: string, entryId: string) {
    const g = await this.groupOf(scope, id);
    const phr = this.phrasingsOf(g);
    const entry = await this.store.mutateDraft(scope.key, actor.name, (d) => {
      const e = d.content.entries.find((x) => x.id === entryId);
      if (!e) throw new NotFoundException('Answer not found');
      const have = new Set(e.questions.map(questionKey));
      for (const p of phr) if (!have.has(questionKey(p)) && e.questions.length < LIMITS.questionsPerEntry) e.questions.push(p.slice(0, LIMITS.questionChars));
      // the new wording must pass the same guardrails
      const bad = e.questions.flatMap((q, i) => checkText(q, `questions[${i}]`, this.guard()).filter((x) => x.severity === 'block'));
      if (bad.length) fail(bad);
      e.updatedAt = new Date().toISOString();
      return e;
    });
    await this.mark(scope, g.rows.map((r) => r.id), 'TAUGHT', entryId);
    await this.log(actor, scope, 'unanswered.merge', { questions: g.count });
    return entry;
  }

  async ignoreUnanswered(scope: TScope, actor: TActor, id: string, restore = false) {
    const g = await this.groupOf(scope, id, restore ? 'IGNORED' : 'OPEN');
    await this.mark(scope, g.rows.map((r) => r.id), restore ? 'OPEN' : 'IGNORED', null);
    await this.log(actor, scope, restore ? 'unanswered.restore' : 'unanswered.ignore', { questions: g.count });
    return { ok: true };
  }

  // ================================================================== feedback review
  async feedbackReview(scope: TScope) {
    const [draft, stats] = await Promise.all([this.store.getDraft(scope.key), this.store.statsOf(scope.key)]);
    const rows: any[] = await this.ds.query(`SELECT "entryId", question, comment, "createdAt" FROM assistant_feedback WHERE "scopeKey" = $1 AND rating = 'down' AND reviewed = false ORDER BY "createdAt" DESC LIMIT 300`, [scope.key]);
    const byEntry = new Map<string, any[]>();
    for (const r of rows) if (r.entryId) (byEntry.get(r.entryId) ?? byEntry.set(r.entryId, []).get(r.entryId)!).push(r);
    const data = [...byEntry.entries()]
      .map(([entryId, fb]) => {
        const e = draft.content.entries.find((x) => x.id === entryId);
        const s = stats.get(entryId);
        return { entryId, title: e?.title ?? '(removed answer)', answer: e?.answer ?? '', exists: !!e, up: s?.up ?? 0, down: s?.down ?? 0, recent: fb.slice(0, 5).map((f) => ({ question: f.question, comment: f.comment, at: f.createdAt })), pending: fb.length };
      })
      .sort((a, b) => b.pending - a.pending);
    return { data, total: data.length };
  }

  async dismissReview(scope: TScope, actor: TActor, entryId: string) {
    await this.ds.query(`UPDATE assistant_feedback SET reviewed = true WHERE "scopeKey" = $1 AND "entryId" = $2`, [scope.key, entryId]);
    await this.log(actor, scope, 'feedback.dismiss', {});
    return { ok: true };
  }

  // ================================================================== test bench
  async playground(scope: TScope, question: string) {
    const q = stripPii(String(question ?? '')).slice(0, 300);
    if (!q) fail([{ field: 'question', code: 'required', severity: 'block', message: 'Type a question to try.' }]);
    const draft = await this.store.getDraft(scope.key);
    const index = buildIndex(draft.content);
    const res = search(index, q);
    const a = answerOf(index, res);
    const entry = res.best && res.outcome === 'answer' ? index.entryById.get(res.best.entryId) : null;
    return {
      question: q,
      against: 'draft',
      verdict: res.outcome === 'answer' ? 'answered' : res.outcome === 'ambiguous' ? 'ambiguous' : res.outcome === 'document' ? 'document' : 'unanswered',
      threshold: res.threshold,
      strong: res.strong,
      answer: res.outcome === 'ambiguous' ? 'Did you mean one of these?' : res.outcome === 'document' ? `From our info: "${res.passage!.text}"` : a.text,
      entry: entry ? { id: entry.id, title: entry.title, liveData: !!entry.liveData } : null,
      candidates: res.candidates,
      ambiguous: res.ambiguous,
      passage: res.passage ?? null,
      normalized: res.normalized,
      note: res.outcome === 'answer' && !res.strong ? 'The live bot uses this answer when its built-in menu / hours / cart answers do not understand the question.' : res.strong ? 'A strong match: the live bot answers with this before its built-in answers.' : null,
    };
  }

  async testCases(scope: TScope) {
    const d = await this.store.getDraft(scope.key);
    return d.testCases.map((t) => ({ ...t, expectTitle: t.expectEntryId ? d.content.entries.find((e) => e.id === t.expectEntryId)?.title ?? '(removed)' : null }));
  }

  async addTestCase(scope: TScope, actor: TActor, body: { question?: string; expectEntryId?: string | null; expectPhrase?: string | null; expectUnanswered?: boolean }) {
    const question = stripPii(String(body.question ?? '')).slice(0, 300).trim();
    const phrase = body.expectPhrase ? stripPii(String(body.expectPhrase)).slice(0, 200).trim() : null;
    const issues: FieldIssue[] = [];
    if (!question) issues.push({ field: 'question', code: 'required', severity: 'block', message: 'Type the question to test.' });
    const kinds = [!!body.expectEntryId, !!phrase, body.expectUnanswered === true].filter(Boolean).length;
    if (kinds !== 1) issues.push({ field: 'expect', code: 'invalid', severity: 'block', message: 'Choose exactly one expectation: an expected answer, a phrase the answer must contain, or "no answer".' });
    if (issues.length) fail(issues);
    const tc = await this.store.mutateDraft(scope.key, actor.name, (d) => {
      if (d.testCases.length >= LIMITS.testCases) fail([{ field: 'question', code: 'too_many', severity: 'block', message: `At most ${LIMITS.testCases} test cases.` }]);
      if (body.expectEntryId && !d.content.entries.some((e) => e.id === body.expectEntryId)) fail([{ field: 'expectEntryId', code: 'invalid_target', severity: 'block', message: 'Choose an existing answer.' }]);
      const t: TestCase = { id: randomUUID(), question, expectEntryId: body.expectEntryId || null, expectPhrase: phrase, expectUnanswered: body.expectUnanswered === true, createdAt: new Date().toISOString() };
      d.testCases.push(t);
      return t;
    });
    return tc;
  }

  async deleteTestCase(scope: TScope, actor: TActor, id: string) {
    await this.store.mutateDraft(scope.key, actor.name, (d) => {
      if (!d.testCases.some((t) => t.id === id)) throw new NotFoundException('Test case not found');
      d.testCases = d.testCases.filter((t) => t.id !== id);
    });
    return { ok: true };
  }

  async runTests(scope: TScope) {
    const d = await this.store.getDraft(scope.key);
    const index = buildIndex(d.content);
    const results = runTestSet(index, d.testCases);
    return { total: results.length, passed: results.filter((r) => r.pass).length, failed: results.filter((r) => !r.pass).length, results };
  }

  // ================================================================== settings (threshold)
  async getSettings(scope: TScope) {
    const d = await this.store.getDraft(scope.key);
    return { threshold: d.content.settings.threshold, min: LIMITS.thresholdMin, max: LIMITS.thresholdMax, default: LIMITS.thresholdDefault, requireApproval: this.store.requireApproval() };
  }

  async setSettings(scope: TScope, actor: TActor, body: { threshold?: number }) {
    const t = Number(body.threshold);
    if (!Number.isFinite(t) || t < LIMITS.thresholdMin || t > LIMITS.thresholdMax) fail([{ field: 'threshold', code: 'range', severity: 'block', message: `The confidence threshold must be between ${LIMITS.thresholdMin} and ${LIMITS.thresholdMax}.` }]);
    await this.store.mutateDraft(scope.key, actor.name, (d) => {
      d.content.settings.threshold = clampThreshold(t);
    });
    await this.log(actor, scope, 'settings', { threshold: t });
    return this.getSettings(scope);
  }

  // ================================================================== versions, publish, approval
  private async dirty(scope: TScope) {
    const [d, p] = await Promise.all([this.store.getDraft(scope.key), this.store.published(scope.key)]);
    return hashOf(d.content) !== hashOf(p.content);
  }

  async versions(scope: TScope) {
    const [rows, live, dirty, pending] = await Promise.all([this.store.listVersions(scope.key), this.store.published(scope.key), this.dirty(scope), this.pendingRequest(scope)]);
    return { live: live.version, dirty, pendingRequest: pending, requireApproval: this.store.requireApproval(), data: rows.map((v) => ({ id: v.id, version: v.version, note: v.note, source: v.source, publishedByName: v.publishedByName, counts: v.counts, restoredFrom: v.restoredFrom, createdAt: v.createdAt, live: v.version === live.version })) };
  }

  async versionDetail(scope: TScope, version: number) {
    const v = await this.store.getVersion(scope.key, version);
    if (!v) throw new NotFoundException('Version not found');
    const c = normContent(v.content);
    return { version: v.version, note: v.note, source: v.source, publishedByName: v.publishedByName, createdAt: v.createdAt, counts: v.counts, entries: c.entries.map((e) => ({ id: e.id, title: e.title, questions: e.questions.length, active: e.active, held: !!e.held })) };
  }

  private async pendingRequest(scope: TScope) {
    const r = await this.ds.getRepository(AssistantKbRequest).findOne({ where: { scopeKey: scope.key, status: 'PENDING' }, order: { createdAt: 'DESC' } });
    return r ? this.requestView(r) : null;
  }

  private requestView(r: AssistantKbRequest) {
    return { id: r.id, scopeKey: r.scopeKey, restaurantId: r.restaurantId, kind: r.kind, note: r.note, status: r.status, requestedByName: r.requestedByName, counts: r.counts, regressions: r.regressions, decidedByName: r.decidedByName, decidedAt: r.decidedAt, decisionNote: r.decisionNote, resultVersion: r.resultVersion, createdAt: r.createdAt };
  }

  async myRequests(scope: TScope) {
    const rows = await this.ds.getRepository(AssistantKbRequest).find({ where: { scopeKey: scope.key }, order: { createdAt: 'DESC' }, take: 20 });
    return rows.map((r) => this.requestView(r));
  }

  private async goLive(scope: TScope, actor: TActor, content: KbContent, meta: { note?: string | null; source: string; restoredFrom?: number | null }, alsoDraft: boolean) {
    const v = await this.store.createVersion(scope.key, content, { ...meta, actorId: actor.id, actorName: actor.name });
    if (alsoDraft) await this.store.replaceDraft(scope.key, normContent(JSON.parse(JSON.stringify(content))), v.version, actor.name);
    else await this.ds.query(`UPDATE assistant_kb_drafts SET "baseVersion" = $1 WHERE "scopeKey" = $2`, [v.version, scope.key]);
    this.store.invalidate(scope.key);
    return v;
  }

  /** publish the draft (or, with approval switched on, ask staff to publish it) */
  async publish(scope: TScope, actor: TActor, body: { note?: string; confirmRegressions?: boolean }) {
    const [draft, pub] = await Promise.all([this.store.getDraft(scope.key), this.store.published(scope.key)]);
    if (hashOf(draft.content) === hashOf(pub.content)) fail([{ field: 'publish', code: 'nothing', severity: 'block', message: 'There is nothing new to publish: the live bot already uses this version.' }]);
    const reg = regressions(pub.index, buildIndex(draft.content), draft.testCases);
    if (reg.length && !body.confirmRegressions) {
      throw new ConflictException({ statusCode: 409, code: 'REGRESSIONS', message: `${reg.length} saved test case${reg.length > 1 ? 's' : ''} passed before and would fail after this publish. Review them, or publish anyway.`, details: reg });
    }
    const note = body.note ? stripPii(String(body.note)).slice(0, 300) : null;
    const counts = countsOf(draft.content);
    if (this.store.requireApproval() && actor.type === 'restaurant') {
      const req = await this.createRequest(scope, actor, 'publish', draft.content, note, counts, reg.length);
      return { status: 'REQUESTED', request: this.requestView(req), regressions: reg.length };
    }
    const v = await this.goLive(scope, actor, draft.content, { note, source: 'publish' }, false);
    await this.log(actor, scope, 'publish', { version: v.version, ...counts, regressions: reg.length });
    return { status: 'PUBLISHED', version: v.version, counts, regressions: reg.length };
  }

  private async createRequest(scope: TScope, actor: TActor, kind: string, content: KbContent, note: string | null, counts: Record<string, number>, regressionCount: number) {
    const repo = this.ds.getRepository(AssistantKbRequest);
    await repo.update({ scopeKey: scope.key, status: 'PENDING' }, { status: 'CANCELLED', decisionNote: 'Replaced by a newer request' });
    const req = await repo.save(repo.create({ scopeKey: scope.key, restaurantId: scope.restaurantId, kind, content: JSON.parse(JSON.stringify(content)), note, status: 'PENDING', requestedById: actor.id, requestedByName: actor.name, counts, regressions: regressionCount }));
    await this.log(actor, scope, 'request', { requestId: req.id, kind, ...counts });
    try {
      await this.notifications.notifyOps('assistant.training.requested', { name: scope.label, kind, entries: counts.entries ?? 0 }, { requestId: req.id, restaurantId: scope.restaurantId }, { title: `Bot training approval: ${scope.label}`, body: `${scope.label} asks to publish its trained bot (${counts.entries ?? 0} answers). Review it in Assistant > Training.` });
    } catch (e) {
      this.logger.warn(`could not notify staff: ${(e as Error).message}`);
    }
    return req;
  }

  async cancelRequest(scope: TScope, actor: TActor, id: string) {
    const repo = this.ds.getRepository(AssistantKbRequest);
    const r = await repo.findOne({ where: { id, scopeKey: scope.key } });
    if (!r) throw new NotFoundException('Request not found');
    if (r.status !== 'PENDING') fail([{ field: 'request', code: 'state', severity: 'block', message: 'Only a pending request can be withdrawn.' }]);
    r.status = 'CANCELLED';
    r.decisionNote = 'Withdrawn by the restaurant';
    await repo.save(r);
    await this.log(actor, scope, 'request.cancel', { requestId: id });
    return this.requestView(r);
  }

  async rollback(scope: TScope, actor: TActor, version: number, body: { note?: string }) {
    const target = await this.store.getVersion(scope.key, version);
    if (!target) throw new NotFoundException('Version not found');
    const live = await this.store.published(scope.key);
    if (live.version === version) fail([{ field: 'version', code: 'state', severity: 'block', message: 'That version is already live.' }]);
    const content = normContent(target.content);
    const note = (body.note ? stripPii(String(body.note)).slice(0, 260) : `Restored version ${version}`).slice(0, 300);
    if (this.store.requireApproval() && actor.type === 'restaurant') {
      const req = await this.createRequest(scope, actor, 'rollback', content, note, countsOf(content), 0);
      return { status: 'REQUESTED', request: this.requestView(req) };
    }
    const v = await this.goLive(scope, actor, content, { note, source: 'rollback', restoredFrom: version }, true);
    await this.log(actor, scope, 'rollback', { version: v.version, restoredFrom: version, ...countsOf(content) });
    return { status: 'PUBLISHED', version: v.version, restoredFrom: version };
  }

  async discardDraft(scope: TScope, actor: TActor) {
    const pub = await this.store.published(scope.key);
    const cur = await this.store.getDraft(scope.key);
    await this.store.replaceDraft(scope.key, normContent(JSON.parse(JSON.stringify(pub.content))), pub.version, actor.name);
    await this.log(actor, scope, 'draft.discard', { ...countsOf(cur.content) });
    return { ok: true, version: pub.version };
  }

  /** The FAQ screens (portal, admin, central) edit only "FAQ" entries, in the draft AND in the live version, without touching other draft work. */
  async setFaqs(scope: TScope, actor: TActor, faqs: { q: string; a: string }[]): Promise<{ status: 'PUBLISHED' | 'REQUESTED'; version?: number }> {
    const cfg = this.guard();
    const clean: { q: string; a: string }[] = [];
    const issues: FieldIssue[] = [];
    faqs.forEach((f, i) => {
      const v = validateEntry({ title: f.q.slice(0, LIMITS.titleChars), questions: [f.q], answer: f.a }, cfg, new Set());
      for (const x of v.issues.filter((x) => x.severity !== 'warn')) issues.push({ ...x, field: `faqs[${i}].${x.field.startsWith('questions') ? 'q' : x.field === 'answer' ? 'a' : x.field}`, severity: 'block', message: x.severity === 'hold' ? `${x.message} Add it in Training instead, where FORKY staff can review it.` : x.message });
      clean.push({ q: v.entry.questions[0] ?? f.q, a: v.entry.answer });
    });
    if (issues.length) fail(issues);
    let produced: KbEntry[] = [];
    const apply = (c: KbContent) => {
      const now = new Date().toISOString();
      const fits = (e: KbEntry) => e.legacyFaq && e.questions.length === 1 && e.questions[0].length <= 120 && e.answer.length <= 500;
      const mine = c.entries.filter(fits);
      const keep = c.entries.filter((e) => !fits(e));
      const next: KbEntry[] = [];
      clean.forEach((f, i) => {
        const cur = mine[i];
        const changed = cur && (cur.questions[0] !== f.q || cur.answer !== f.a);
        next.push(cur ? { ...cur, title: changed ? f.q.slice(0, LIMITS.titleChars) : cur.title, questions: [f.q], answer: f.a, active: true, held: null, liveData: cur.liveData, updatedAt: changed ? now : cur.updatedAt } : { id: randomUUID(), title: f.q.slice(0, LIMITS.titleChars), questions: [f.q], answer: f.a, chips: [], tags: [], active: true, priority: 0, legacyFaq: true, liveData: checkText(f.a, 'a', cfg, { checkLive: true }).some((x) => x.code === 'live_data'), held: null, released: null, createdBy: actor.name, createdAt: now, updatedAt: now });
      });
      const ids = new Set(next.map((e) => e.id));
      for (const e of keep) e.chips = e.chips.filter((ch) => ids.has(ch.entryId) || keep.some((k) => k.id === ch.entryId));
      c.entries = [...keep, ...next];
      produced = next;
      return c;
    };
    if (c_total(clean) > 20) fail([{ field: 'faqs', code: 'too_many', severity: 'block', message: 'At most 20 questions.' }]);
    await this.store.mutateDraft(scope.key, actor.name, (d) => {
      apply(d.content);
    });
    const pub = await this.store.published(scope.key);
    // the live version gets the SAME FAQ entries (same ids) as the draft, so the two stay comparable
    const live = normContent(JSON.parse(JSON.stringify(pub.content)));
    const fitsLive = (e: KbEntry) => e.legacyFaq && e.questions.length === 1 && e.questions[0].length <= 120 && e.answer.length <= 500;
    live.entries = [...live.entries.filter((e) => !fitsLive(e)), ...JSON.parse(JSON.stringify(produced))];
    if (hashOf(live) === hashOf(pub.content)) return { status: 'PUBLISHED', version: pub.version };
    if (this.store.requireApproval() && actor.type === 'restaurant') {
      await this.createRequest(scope, actor, 'faq', live, 'FAQ change', countsOf(live), 0);
      return { status: 'REQUESTED' };
    }
    const v = await this.goLive(scope, actor, live, { note: 'FAQ editor', source: 'faq' }, false);
    await this.log(actor, scope, 'faq', { version: v.version, faqs: clean.length });
    return { status: 'PUBLISHED', version: v.version };
  }

  /** the FAQ list the FAQ screens show (live version) */
  async faqs(scope: TScope): Promise<{ q: string; a: string }[]> {
    const pub = await this.store.published(scope.key);
    return pub.content.entries.filter((e) => e.legacyFaq && !e.held && e.questions.length === 1 && e.questions[0].length <= 120 && e.answer.length <= 500).map((e) => ({ q: e.questions[0], a: e.answer }));
  }

  // ================================================================== admin: approvals, held queue, coverage
  async listRequests(status = 'PENDING', page = 1, limit = 20) {
    const st = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'ALL'].includes(status) ? status : 'PENDING';
    const where = st === 'ALL' ? '' : `WHERE r.status = '${st}'`;
    const rows: any[] = await this.ds.query(
      `SELECT r.id, r."scopeKey", r."restaurantId", r.kind, r.note, r.status, r."requestedByName", r.counts, r.regressions, r."decidedByName", r."decidedAt", r."decisionNote", r."resultVersion", r."createdAt", COALESCE(x.name, 'FORKY website bot') AS "restaurantName"
       FROM assistant_kb_requests r LEFT JOIN restaurants x ON x.id = r."restaurantId" ${where} ORDER BY r."createdAt" DESC LIMIT $1 OFFSET $2`,
      [limit, (page - 1) * limit],
    );
    return rows;
  }

  async requestDetail(id: string) {
    const r = await this.ds.getRepository(AssistantKbRequest).findOne({ where: { id } });
    if (!r) throw new NotFoundException('Request not found');
    const scope = r.restaurantId ? await this.scopeOfRestaurant(r.restaurantId) : this.centralScope();
    const [pub, draftless] = await Promise.all([this.store.published(r.scopeKey), Promise.resolve(null)]);
    void draftless;
    const next = normContent(r.content);
    const cur = new Map(pub.content.entries.map((e) => [e.id, e]));
    const added = next.entries.filter((e) => !cur.has(e.id)).map((e) => e.title);
    const removed = pub.content.entries.filter((e) => !next.entries.some((x) => x.id === e.id)).map((e) => e.title);
    const changed = next.entries.filter((e) => cur.has(e.id) && pick(cur.get(e.id)!) !== pick(e)).map((e) => e.title);
    return { ...this.requestView(r), restaurantName: scope.label, diff: { added, removed, changed, aliases: next.aliases.length - pub.content.aliases.length, documents: next.documents.length - pub.content.documents.length, held: next.entries.filter((e) => e.held).map((e) => e.title) } };
  }

  async decide(id: string, actor: TActor, approve: boolean, note: string | null) {
    const repo = this.ds.getRepository(AssistantKbRequest);
    const r = await repo.findOne({ where: { id } });
    if (!r) throw new NotFoundException('Request not found');
    if (r.status !== 'PENDING') fail([{ field: 'request', code: 'state', severity: 'block', message: `This request was already ${r.status.toLowerCase()}.` }]);
    const dn = note ? stripPii(note).slice(0, 300) : null;
    if (!approve && !dn) fail([{ field: 'note', code: 'required', severity: 'block', message: 'Tell the restaurant why the request was rejected.' }]);
    const scope = r.restaurantId ? await this.scopeOfRestaurant(r.restaurantId) : this.centralScope();
    let version: number | null = null;
    if (approve) {
      const content = normContent(r.content);
      const draft = await this.store.getDraft(scope.key);
      const same = hashOf(draft.content) === hashOf(content);
      const v = await this.goLive(scope, actor, content, { note: r.note ? `${r.note} (approved by ${actor.name})` : `Approved by ${actor.name}`, source: 'approval' }, same);
      version = v.version;
    }
    r.status = approve ? 'APPROVED' : 'REJECTED';
    r.decidedById = actor.id;
    r.decidedByName = actor.name;
    r.decidedAt = new Date();
    r.decisionNote = dn;
    r.resultVersion = version;
    await repo.save(r);
    await this.log(actor, scope, approve ? 'approve' : 'reject', { requestId: id, version, ...(r.counts ?? {}) });
    if (r.restaurantId) {
      try {
        await this.notifications.notifyRestaurant(r.restaurantId, 'assistant.training.decided', { decision: approve ? 'approved' : 'rejected', note: dn ?? '' }, { requestId: id, decision: approve ? 'APPROVED' : 'REJECTED' });
      } catch (e) {
        this.logger.warn(`could not notify the restaurant: ${(e as Error).message}`);
      }
    }
    return this.requestView(r);
  }

  /** entries / documents held by a guardrail, across all bots */
  async heldQueue() {
    const rows: any[] = await this.ds.query(
      `SELECT d."scopeKey", d."restaurantId", COALESCE(x.name, 'FORKY website bot') AS "restaurantName", 'entry' AS kind, e ->> 'id' AS id, e ->> 'title' AS title, e ->> 'answer' AS answer, e -> 'questions' AS questions, e -> 'held' AS held
       FROM assistant_kb_drafts d LEFT JOIN restaurants x ON x.id = d."restaurantId", jsonb_array_elements(d.content -> 'entries') e WHERE jsonb_typeof(e -> 'held') = 'object'
       UNION ALL
       SELECT d."scopeKey", d."restaurantId", COALESCE(x.name, 'FORKY website bot'), 'document', e ->> 'id', e ->> 'title', left(e ->> 'text', 800), '[]'::jsonb, e -> 'held'
       FROM assistant_kb_drafts d LEFT JOIN restaurants x ON x.id = d."restaurantId", jsonb_array_elements(d.content -> 'documents') e WHERE jsonb_typeof(e -> 'held') = 'object'
       LIMIT 200`,
    );
    return rows;
  }

  async releaseHeld(scope: TScope, actor: TActor, kind: 'entry' | 'document', id: string, release: boolean) {
    await this.store.mutateDraft(scope.key, actor.name, (d) => {
      if (kind === 'entry') {
        const e = d.content.entries.find((x) => x.id === id);
        if (!e) throw new NotFoundException('Answer not found');
        if (release) {
          e.held = null;
          e.released = { by: actor.name, at: new Date().toISOString(), hash: textHash(e) };
        } else d.content.entries = d.content.entries.filter((x) => x.id !== id);
      } else {
        const e = d.content.documents.find((x) => x.id === id);
        if (!e) throw new NotFoundException('Document not found');
        if (release) {
          e.held = null;
          e.released = { by: actor.name, at: new Date().toISOString(), hash: textHash({ title: e.title, questions: [], answer: e.text }) };
        } else d.content.documents = d.content.documents.filter((x) => x.id !== id);
      }
    });
    await this.log(actor, scope, release ? 'held.release' : 'held.reject', { kind });
    if (scope.restaurantId) {
      try {
        await this.notifications.notifyRestaurant(scope.restaurantId, 'assistant.training.decided', { decision: release ? 'approved (held answer released - publish to make it live)' : 'rejected (held answer removed)', note: '' }, { kind });
      } catch {
        /* best effort */
      }
    }
    return { ok: true };
  }

  async coverage(q: { search?: string; page?: number; limit?: number; sortBy?: string; sortDir?: string }) {
    const page = Math.max(1, q.page ?? 1);
    const limit = Math.min(100, Math.max(1, q.limit ?? 20));
    const params: unknown[] = [];
    let where = '';
    if (q.search?.trim()) {
      params.push(`%${q.search.trim().replace(/[\\%_]/g, (c) => '\\' + c)}%`);
      where = `WHERE (r.name ILIKE $1 OR r.slug ILIKE $1)`;
    }
    const sort = ({ name: 'r.name', entries: 'COALESCE(v.active, 0)', unanswered: 'COALESCE(u.n, 0)', rate: 'CASE WHEN COALESCE(a.total, 0) = 0 THEN NULL ELSE a.ok::float / a.total END', pending: 'COALESCE(p.n, 0)' } as Record<string, string>)[q.sortBy ?? 'unanswered'] ?? 'COALESCE(u.n, 0)';
    const dir = String(q.sortDir ?? 'DESC').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    params.push(limit, (page - 1) * limit);
    const rows: any[] = await this.ds.query(
      `SELECT r.id, r.name, r.slug,
              COALESCE(v.version, 0)::int AS "liveVersion", COALESCE((v.counts ->> 'active')::int, 0) AS "liveEntries", COALESCE(jsonb_array_length(d.content -> 'entries'), 0)::int AS "draftEntries",
              (d."scopeKey" IS NOT NULL AND d."baseVersion" <> COALESCE(v.version, 0)) AS "draftBehind",
              COALESCE(u.n, 0)::int AS "unanswered", COALESCE(u.asks, 0)::int AS "unansweredAsks", COALESCE(p.n, 0)::int AS "pending",
              CASE WHEN COALESCE(a.total, 0) = 0 THEN NULL ELSE round(a.ok::numeric * 100 / a.total, 1) END AS "answerRate", COALESCE(a.total, 0)::int AS "questions30d",
              COUNT(*) OVER()::int AS "_total"
       FROM restaurants r
       LEFT JOIN assistant_kb_drafts d ON d."scopeKey" = 'r:' || r.id
       LEFT JOIN (SELECT DISTINCT ON ("scopeKey") "scopeKey", version, counts FROM assistant_kb_versions ORDER BY "scopeKey", version DESC) v ON v."scopeKey" = 'r:' || r.id
       LEFT JOIN (SELECT "scopeKey", COUNT(*) AS n, SUM(count) AS asks FROM assistant_questions WHERE outcome = 'UNANSWERED' AND status = 'OPEN' GROUP BY 1) u ON u."scopeKey" = 'r:' || r.id
       LEFT JOIN (SELECT "scopeKey", COUNT(*) AS n FROM assistant_kb_requests WHERE status = 'PENDING' GROUP BY 1) p ON p."scopeKey" = 'r:' || r.id
       LEFT JOIN (SELECT "scopeKey", SUM(count) FILTER (WHERE outcome IN ('TRAINING', 'DOCUMENT', 'BUILTIN')) AS ok, SUM(count) AS total FROM assistant_daily WHERE day >= CURRENT_DATE - 30 GROUP BY 1) a ON a."scopeKey" = 'r:' || r.id
       ${where}
       ORDER BY ${sort} ${dir} NULLS LAST, r.name ASC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    const total = rows[0]?._total ?? 0;
    return { data: rows.map(({ _total, ...r }) => r), meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } };
  }

  async platformOverview() {
    const [pending, held, totals] = await Promise.all([
      this.listRequests('PENDING', 1, 50),
      this.heldQueue(),
      this.ds.query(
        `SELECT (SELECT COUNT(*) FROM assistant_kb_drafts WHERE "restaurantId" IS NOT NULL)::int AS "bots",
                (SELECT COALESCE(SUM((counts ->> 'active')::int), 0) FROM (SELECT DISTINCT ON ("scopeKey") counts FROM assistant_kb_versions ORDER BY "scopeKey", version DESC) x)::int AS "liveEntries",
                (SELECT COUNT(*) FROM assistant_questions WHERE outcome = 'UNANSWERED' AND status = 'OPEN')::int AS "openUnanswered",
                (SELECT COALESCE(SUM(count) FILTER (WHERE outcome IN ('TRAINING','DOCUMENT','BUILTIN')), 0) FROM assistant_daily WHERE day >= CURRENT_DATE - 30)::int AS "answered30d",
                (SELECT COALESCE(SUM(count), 0) FROM assistant_daily WHERE day >= CURRENT_DATE - 30)::int AS "questions30d",
                (SELECT COALESCE(SUM(count) FILTER (WHERE outcome IN ('TRAINING','DOCUMENT')), 0) FROM assistant_daily WHERE day >= CURRENT_DATE - 30)::int AS "trained30d",
                (SELECT COUNT(*) FROM assistant_feedback WHERE rating = 'up' AND "createdAt" > now() - interval '30 days')::int AS "up30d",
                (SELECT COUNT(*) FROM assistant_feedback WHERE rating = 'down' AND "createdAt" > now() - interval '30 days')::int AS "down30d"`,
      ),
    ]);
    const t = totals[0];
    return { requireApproval: this.store.requireApproval(), approvalQueue: pending, heldQueue: held, stats: { ...t, answerRate30d: t.questions30d ? Math.round((t.answered30d * 1000) / t.questions30d) / 10 : null } };
  }

  // ================================================================== overview / analytics
  async overview(scope: TScope) {
    const [draft, pub, stats, dirty, pending] = await Promise.all([this.store.getDraft(scope.key), this.store.published(scope.key), this.store.statsOf(scope.key), this.dirty(scope), this.pendingRequest(scope)]);
    const daily: any[] = await this.ds.query(`SELECT day::text AS day, outcome, count FROM assistant_daily WHERE "scopeKey" = $1 AND day >= CURRENT_DATE - 30 ORDER BY day`, [scope.key]);
    const sum = (days: number) => {
      const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
      const o: Record<string, number> = { TRAINING: 0, DOCUMENT: 0, AMBIGUOUS: 0, BUILTIN: 0, UNANSWERED: 0 };
      for (const r of daily) if (r.day > cutoff) o[r.outcome] = (o[r.outcome] ?? 0) + r.count;
      const total = Object.values(o).reduce((a, b) => a + b, 0);
      return { ...o, total, answerRate: total ? Math.round(((o.TRAINING + o.DOCUMENT + o.BUILTIN) * 1000) / total) / 10 : null, trainedRate: total ? Math.round(((o.TRAINING + o.DOCUMENT) * 1000) / total) / 10 : null };
    };
    const trend: { day: string; unanswered: number; answered: number }[] = [];
    for (let i = 13; i >= 0; i--) {
      const day = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
      const rows = daily.filter((r) => r.day === day);
      trend.push({ day, unanswered: rows.filter((r) => r.outcome === 'UNANSWERED').reduce((n, r) => n + r.count, 0), answered: rows.filter((r) => r.outcome !== 'UNANSWERED').reduce((n, r) => n + r.count, 0) });
    }
    const top: any[] = await this.ds.query(`SELECT text, outcome, count, "entryId" FROM assistant_questions WHERE "scopeKey" = $1 AND outcome IN ('TRAINING','DOCUMENT','UNANSWERED') AND "lastSeenAt" > now() - interval '30 days' ORDER BY count DESC LIMIT 10`, [scope.key]);
    const un = await this.groups(scope, 'OPEN');
    let up = 0;
    let down = 0;
    for (const s of stats.values()) {
      up += s.up;
      down += s.down;
    }
    const liveEntries = pub.content.entries.filter((e) => e.active && !e.held);
    const neverUsed = liveEntries.filter((e) => !(stats.get(e.id)?.answered > 0)).map((e) => ({ id: e.id, title: e.title }));
    const hints = un.filter((g) => g.count >= 3).slice(0, 5).map((g) => ({ question: g.rep.text, asks: g.count, hint: `Customers ask "${g.rep.text}" often (${g.count} times). Add an answer.` }));
    const activeDraft = draft.content.entries.filter((e) => e.active && !e.held).length;
    const done = new Set(draft.content.entries.map((e) => questionKey(e.title)));
    return {
      scope: { key: scope.key, label: scope.label, central: scope.central },
      counts: { draft: countsOf(draft.content), live: countsOf(pub.content), activeDraft },
      liveVersion: pub.version,
      dirty,
      pendingRequest: pending,
      requireApproval: this.store.requireApproval(),
      threshold: draft.content.settings.threshold,
      unanswered: { groups: un.length, asks: un.reduce((n, g) => n + g.count, 0) },
      needsReview: (await this.feedbackReview(scope)).total,
      held: draft.content.entries.filter((e) => e.held).length + draft.content.documents.filter((d) => d.held).length,
      testCases: draft.testCases.length,
      analytics: { d7: sum(7), d30: sum(30), trend, topQuestions: top, thumbs: { up, down, ratio: up + down ? Math.round((up * 1000) / (up + down)) / 10 : null }, neverUsed: neverUsed.slice(0, 20), neverUsedCount: neverUsed.length, coverageHints: hints },
      starters: draft.content.entries.length < 5 ? STARTERS.filter((s) => !done.has(questionKey(s.title)) && !draft.content.entries.some((e) => questionKey(e.questions[0] ?? '') === questionKey(s.question))) : [],
    };
  }

  // ================================================================== import / export
  async exportJson(scope: TScope) {
    const d = await this.store.getDraft(scope.key);
    const { settings, entries, aliases, synonyms, documents } = d.content;
    return { format: 'forky-assistant-kb', version: 1, exportedAt: new Date().toISOString(), scope: scope.central ? 'central' : 'restaurant', settings, entries: entries.map(({ held, released, createdBy, ...e }) => e), aliases, synonyms, documents: documents.map(({ held, released, ...x }) => x) };
  }

  async exportCsv(scope: TScope) {
    const d = await this.store.getDraft(scope.key);
    return entriesToCsv(d.content.entries);
  }

  /** shared by JSON and CSV import: validates every row with the normal guardrails; applies nothing unless mode = apply */
  private async importEntries(scope: TScope, actor: TActor, rows: { index: number; label: string; input: EntryInput }[], opts: { mode: 'preview' | 'apply'; replace: boolean; extra?: (c: KbContent) => void }) {
    const draft = await this.store.getDraft(scope.key);
    const base: KbContent = opts.replace ? { ...draft.content, entries: [] } : draft.content;
    const probe = JSON.parse(JSON.stringify(base)) as KbContent;
    const report: { row: number; title: string; status: 'ok' | 'held' | 'error'; issues: FieldIssue[] }[] = [];
    const accepted: KbEntry[] = [];
    const now = new Date().toISOString();
    for (const r of rows) {
      const v = validateEntry(r.input, this.guard(), new Set(probe.entries.map((e) => e.id)));
      const issues = v.issues.filter((i) => i.field !== 'chips' || true);
      const dup = [...probe.entries, ...accepted].find((e) => questionKey(e.title) === questionKey(v.entry.title));
      if (dup) issues.push({ field: 'title', code: 'duplicate', severity: 'warn', message: `An answer titled "${dup.title}" already exists; this row is added as a separate answer.` });
      if (!v.ok) {
        report.push({ row: r.index, title: r.label, status: 'error', issues });
        continue;
      }
      if (probe.entries.length + accepted.length >= MAX_ENTRIES) {
        report.push({ row: r.index, title: r.label, status: 'error', issues: [...issues, { field: 'entries', code: 'too_many', severity: 'block', message: `The bot would exceed ${MAX_ENTRIES} answers.` }] });
        continue;
      }
      const held = toHeld(issues);
      accepted.push({ id: randomUUID(), ...v.entry, chips: [], legacyFaq: false, liveData: issues.some((i) => i.code === 'live_data'), held, released: null, createdBy: actor.name, createdAt: now, updatedAt: now });
      report.push({ row: r.index, title: r.label, status: held ? 'held' : 'ok', issues });
    }
    const summary = { rows: rows.length, valid: accepted.length, held: accepted.filter((e) => e.held).length, errors: report.filter((r) => r.status === 'error').length, replace: opts.replace };
    if (opts.mode === 'apply') {
      if (!accepted.length && !opts.extra) fail([{ field: 'import', code: 'nothing', severity: 'block', message: 'Nothing valid to import.' }]);
      await this.store.mutateDraft(scope.key, actor.name, (d) => {
        if (opts.replace) d.content.entries = [];
        d.content.entries.push(...accepted);
        opts.extra?.(d.content);
      });
      await this.log(actor, scope, 'import', { imported: accepted.length, held: summary.held, errors: summary.errors, replace: opts.replace });
    }
    return { mode: opts.mode, applied: opts.mode === 'apply', summary, report };
  }

  async importJson(scope: TScope, actor: TActor, body: { data: any; mode?: string; replace?: boolean }) {
    const data = body.data;
    if (!data || typeof data !== 'object' || data.format !== 'forky-assistant-kb' || !Array.isArray(data.entries)) fail([{ field: 'data', code: 'invalid', severity: 'block', message: 'This is not a FORKY bot export (format "forky-assistant-kb"). Export your bot first and edit that file.' }]);
    if (data.entries.length > MAX_ENTRIES) fail([{ field: 'data.entries', code: 'too_many', severity: 'block', message: `At most ${MAX_ENTRIES} answers per import.` }]);
    const mode = body.mode === 'apply' ? 'apply' : 'preview';
    const rows = data.entries.map((e: any, i: number) => ({ index: i + 1, label: String(e?.title ?? `Answer ${i + 1}`).slice(0, 80), input: { title: e?.title, questions: e?.questions, answer: e?.answer, tags: e?.tags, active: e?.active, priority: e?.priority } }));
    const synonyms = Array.isArray(data.synonyms) ? data.synonyms.slice(0, LIMITS.synonyms) : [];
    const documents = Array.isArray(data.documents) ? data.documents.slice(0, LIMITS.documents) : [];
    const docErrors: { row: number; title: string; status: 'error'; issues: FieldIssue[] }[] = [];
    const goodDocs: { title: string; text: string; held: KbDocument['held'] }[] = [];
    documents.forEach((x: any, i: number) => {
      const { title, text } = this.cleanDoc(x ?? {});
      const issues = this.docIssues(title, text);
      if (issues.some((s) => s.severity === 'block')) docErrors.push({ row: i + 1, title: `Document: ${title || i + 1}`, status: 'error', issues });
      else goodDocs.push({ title, text, held: toHeld(issues) });
    });
    const goodSyn: { term: string; alternates: string[] }[] = [];
    const tmp = emptyContent();
    for (const s of synonyms) {
      try {
        const c = this.cleanSynonym(tmp, s ?? {});
        tmp.synonyms.push({ id: 'x', ...c });
        goodSyn.push(c);
      } catch {
        /* skipped: reported through the summary count */
      }
    }
    const res = await this.importEntries(scope, actor, rows, {
      mode,
      replace: body.replace === true,
      extra: (c) => {
        if (body.replace === true) {
          c.synonyms = [];
          c.documents = [];
        }
        const now = new Date().toISOString();
        for (const s of goodSyn) if (!c.synonyms.some((g) => [g.term, ...g.alternates].some((w) => [s.term, ...s.alternates].includes(w)))) c.synonyms.push({ id: randomUUID(), ...s });
        for (const dd of goodDocs) if (c.documents.length < LIMITS.documents) c.documents.push({ id: randomUUID(), title: dd.title, text: dd.text, held: dd.held, released: null, createdAt: now, updatedAt: now });
        if (data.settings?.threshold !== undefined) c.settings.threshold = clampThreshold(data.settings.threshold);
      },
    });
    res.report.push(...docErrors);
    (res.summary as any).synonyms = goodSyn.length;
    (res.summary as any).documents = goodDocs.length;
    (res.summary as any).errors += docErrors.length;
    return res;
  }

  async importCsv(scope: TScope, actor: TActor, body: { csv: string; mode?: string; replace?: boolean }) {
    const parsed = entriesFromCsv(String(body.csv ?? ''));
    if (parsed.errors.length && !parsed.entries.length && parsed.errors[0].line === 1) fail([{ field: 'csv', code: 'invalid', severity: 'block', message: parsed.errors[0].message }]);
    if (parsed.entries.length > MAX_ENTRIES) fail([{ field: 'csv', code: 'too_many', severity: 'block', message: `At most ${MAX_ENTRIES} rows per import.` }]);
    const rows = parsed.entries.map((e) => ({ index: e.line, label: e.title, input: { title: e.title, questions: e.questions, answer: e.answer, tags: e.tags, active: e.active } }));
    const res = await this.importEntries(scope, actor, rows, { mode: body.mode === 'apply' ? 'apply' : 'preview', replace: body.replace === true });
    for (const e of parsed.errors) res.report.push({ row: e.line, title: '(row skipped)', status: 'error', issues: [{ field: 'row', code: 'invalid', severity: 'block', message: e.message }] });
    res.summary.errors += parsed.errors.length;
    res.summary.rows += parsed.errors.length;
    return res;
  }

  // ================================================================== guardrail check (live validation while typing)
  checkEntryDraft(body: EntryInput) {
    const v = validateEntry(body, this.guard(), new Set());
    return { ok: v.ok, issues: v.issues.filter((i) => !(i.field === 'chips')) };
  }
}

const normalizeKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const c_total = (x: unknown[]) => x.length;
const stripHtmlPlain = (s: string) => stripPii('x') && s.replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/[ \t]+/g, ' ');

export type { Index };
export { runTestCase, terms };
