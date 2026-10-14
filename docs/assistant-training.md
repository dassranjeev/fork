# Bot training tool

The in-house tool that lets a restaurant (and FORKY, for the website bot) **teach** the ordering assistant its own answers, without any language model. It is a small, trainable *retrieval* engine that plugs into the hooks described in [assistant.md](assistant.md) ("Extension points"): `KnowledgeProvider`, `AliasResolver`, the `assistant.unanswered` event and the `assistant.feedback` event.

Related: [assistant.md](assistant.md) (the bot itself), [api/assistant.md](api/assistant.md) (endpoint list).

---

## 1. Concepts

| Word | Meaning |
|---|---|
| **Knowledge base** | One per restaurant, plus one **central** one for the FORKY website bot. Scope keys `r:<restaurantId>` and `central`. They are never mixed: a restaurant's answers are only ever used for that restaurant. |
| **Answer (entry)** | A title (only staff see it), up to **15 phrasings** (ways guests ask it), an **answer** of up to **800** characters, up to 3 **buttons** (chips) that open another answer, up to 8 tags, an on/off switch and a priority 0..5 that wins ties. |
| **Nickname** | A fixed name for a menu item or menu section ("marg" = Margherita, "the usual" = a given dish). Only exact nicknames, never guesses. Restaurant bots only. |
| **Synonyms** | Words that mean the same ("pop" = "soda" = "soft drink"). The customer may use either; matching treats them as one word. |
| **Document** | Pasted text (allergy policy, catering terms ...), up to **20 documents x 20,000 characters**. The bot never invents from it: it only **quotes** the best passage ("From our info: ...") and only above a higher confidence bar. |
| **Draft** | What you are editing. Customers never see it. The test bench runs against it. |
| **Version** | An immutable numbered snapshot made by **Publish**. The **highest number is live**. Versions are never edited; restoring an old one creates a *new* version (so history is never lost) and resets the draft to it. |
| **Unanswered inbox** | Questions the bot could not answer, grouped by similarity, with personal data stripped. Teach, add as another phrasing of an existing answer, or ignore. |
| **Threshold** | How sure the bot must be before it uses a taught answer: 0.4 to 0.9, default **0.6**. Stored in the draft (publish to apply). |

Existing FAQs (the old "Your FAQs" lists of the restaurant portal, admin editor and central bot) are **migrated automatically** the first time a bot's knowledge base is opened: they become answers (flagged "from FAQs"), version 1. The old FAQ endpoints (`PATCH /restaurant/assistant { faqs }`, `PATCH /admin/restaurants/:id/assistant { faqs }`, `PATCH /admin/assistant/central { faqs }`) keep working on the **same store**: saving FAQs there edits the same entries (same ids) in the draft and in the live version and publishes immediately (or creates an approval request when approval is required). `config.faqs` in the GET responses is read from the live version.

---

## 2. How the engine works (in plain words)

No AI model is involved. For every question the bot does this:

1. **Clean up**: lower-case, remove punctuation, apply your synonyms ("soft drink" becomes "pop") and menu-section nicknames.
2. **Drop filler words**: "do you have a ...", "is there ...", "please", "got a ..." carry no meaning. "what" counts for very little, "where" and "when" still count.
3. **Compare with every phrasing you taught** (each answer's title and phrasings) using three measures that are blended into one confidence between 0 and 1:
   * **word match (BM25)**: rare words count more than common ones ("gluten" tells more than "menu"); a word the bot has never seen anywhere counts against the match;
   * **spelling closeness (trigrams)**: so "parkin", "glutten" or "catring" still meet "parking", "gluten", "catering"; short forms ("info" for "information") and simple word endings are tolerated;
   * **exact phrase**: the very same words as a taught phrasing score 1.0.
4. **Pick**: the best answer above the threshold wins. Ties go to the higher priority. The top 3 candidates are ranked with a **reason** ("same wording as a taught phrasing", "matched words: ...", "closest phrasing: ...").
5. **Ambiguous?** If a second answer is within 0.07 of the best, the bot asks **"Did you mean ...?"** with buttons instead of guessing. Choosing a button opens that answer (and counts as a normal answer in the statistics).
6. **Documents** are only used when no answer matched (or for allergy / information questions where a document is much more confident); the passage is quoted, never paraphrased.
7. **Nothing matched**: the normal "I'm not sure" reply stands and the question goes to the **unanswered inbox**.

Built-in knowledge always comes first for live data: menu, prices, opening hours, delivery and cart questions are answered from the live restaurant data, **never** from a taught answer. Answers that mention prices or hours are flagged "live data" and never pre-empt the built-in answer (see guardrails).

Order of the answer pipeline (`brain.registry.ts`): synonyms/nicknames rewrite -> `kb:<entry>` button -> **strong** taught match (>= max(0.8, threshold), not live-data) -> LLM slot (stub) -> deterministic brain -> weaker taught match / "Did you mean" / document passage -> `assistant.unanswered`.

---

## 3. For restaurant owners (portal: Assistant > Training)

The page has two tabs: **Settings & embed code** (website list, embed code; the look is set by FORKY) and **Training**. Inside Training:

1. **Overview**: live version, answer rate (7 and 30 days), unanswered count, thumbs-down count, top questions, "never used" answers and coverage hints. A new bot shows **"Teach your bot your first 5 answers"**: tap a card (parking, allergies, catering, payment, kids menu ...), write the answer in your own words, save.
2. **Knowledge**: add, edit, switch on/off, delete (also several at once), search and filter, import / export (see 6). The editor shows a live preview, the character counters and guardrail messages as you type.
3. **Nicknames & synonyms**.
4. **Documents**.
5. **Unanswered inbox** (the tab shows a badge) and **Needs review** (answers a guest gave a thumbs-down). For a question: **Teach an answer**, **Add as another way to ask** an existing answer, or **Ignore** (restorable). Similar questions are shown once with a count; suggestions point to the answer that is closest.
6. **Test bench**: type any question and see which answer wins and **why**, against your **draft**. Save good ones as **test cases** (up to 100; "must answer with X", "must contain ...", or "must stay unanswered"). **Run all** shows pass / fail with reasons.
7. **Versions & publish**: write a note, **Publish**. Before anything goes live all test cases run; if a case that used to pass would now fail you get a warning with the list and must explicitly confirm ("Publish anyway"). Restore any older version with **Restore**. **Discard changes** throws the draft away.

Who may do what: the **owner** and **location managers** can change things; every other restaurant role can look but not change (buttons are hidden, the API returns 403).

Typical routine: teach 5 answers, test with questions in your own words, publish, check the inbox once a week.

---

## 4. For FORKY staff (Admin Console > Assistant)

Sidebar entries (group "Assistant"): **Training** (`/assistant/training`), **Training coverage** (`/assistant/training/restaurants`), **Central bot training** (`/assistant/training/central`); the bot editor and the central bot page have a **Train this bot** button.

* **Training (overview)**: platform numbers (bots with training, live answers, open unanswered questions, answer rate and thumbs for 30 days), the **approval switch**, the **approval queue** and the **held queue**.
* **Approval**: setting `assistant.training.requireApproval` (Admin > Settings > Assistant, or the switch on the overview; needs `settings:edit`). When on, a restaurant's *Publish* becomes a **request** that stores the exact content; staff see what changes (new / changed / removed answers, nickname and document counts, failing test cases), then **Approve** (publishes it as the next version, restaurant notified) or **Reject** (a note is required; the restaurant sees it). Staff publishing directly is never held back. Needs `restaurants:edit`.
* **Held queue**: answers and documents the guardrails kept out of the live bot (allergen-safety guarantees, medical claims). **Release** (you confirm the text is fine; the restaurant still has to publish) or **Remove**. A released answer stays released as long as its text is unchanged.
* **Training coverage**: every restaurant with live answers, live version, "unpublished changes", unanswered count, answer rate (30 days) and pending requests; click a row to open that restaurant's training area (full editor, "staff" mode: Publish is always direct).
* **Central bot training**: the same area for the FORKY website bot, permission `settings:view` / `settings:edit`. Tab "Synonyms" (no menu nicknames).

Everything is audit-logged with **counts only** (never the text): `assistant.training.{entry,aliases,documents,import,publish,rollback,request,approve,reject,held.release,held.reject,faq,settings,...}`.

---

## 5. Guardrails

Applied when saving an answer or document (the editor shows the message; the API returns `400` with `details: [{field, code, severity, message}]`).

| Severity | What | Rule |
|---|---|---|
| **Block** (refused) | Personal data | email addresses, phone numbers, card-like numbers (contact details come from the restaurant profile, never from the bot text) |
| | Links | any link that is not `https://` (and bare `javascript:` etc.) |
| | Prompt-injection text | "ignore previous instructions", "you are now ..." and similar |
| | Profanity / abuse | built-in patterns plus the editable `assistant.training.blockPhrases` setting |
| | Size | phrasing 200 characters, answer 800, title 80, 15 phrasings, 500 answers, document 20,000 characters |
| **Hold** (saved, **not live** until staff release) | Allergen-safety promises and medical claims | "100% safe", "guaranteed allergen free", "cures ...", "safe for celiacs" ... (built-in patterns plus `assistant.training.holdPhrases`). Negations are understood: "we cannot guarantee it is allergen free" is fine. Only **answers** are held, not customer phrasings. |
| **Warn** (saved, with a note) | Prices and opening hours | "Live data is used instead": the bot keeps answering price / hours questions from the live restaurant data, so the answer is flagged and never overrides it. |
| Always | HTML | stripped from everything (also by the platform-wide input sanitiser) |

Stored unanswered questions have personal data stripped before they are saved (emails, phone numbers, long digit strings), carry no session id, and follow the retention above.

---

## 6. Import / export

* **Export**: `GET .../export` (JSON, whole knowledge base: answers, nicknames, synonyms, documents, threshold) and `GET .../export.csv` (answers: `title,questions,answer,tags,priority,active`; questions separated by ` | `).
* **Import**: `POST .../import` (JSON) and `POST .../import-csv` (`{ csv }`, header row required). `mode: "preview"` (default) validates every row and returns a report (`ok`, `held`, `error` with reasons) **without saving anything**; `mode: "apply"` adds the valid rows to the **draft** (`replace: true` replaces all answers). Same guardrails as manual entry. Bodies up to 2 MB are accepted on these two routes only. Nothing becomes live until published.

---

## 7. API summary

Same paths under three bases (every route below is relative to a base):

| Base | Who | Notes |
|---|---|---|
| `/restaurant/assistant/training` | restaurant portal; `?restaurantId=` for multi-location accounts | read: any role of the restaurant; write: OWNER, LOCATION_MANAGER (403 otherwise) |
| `/admin/assistant/training/restaurants/:rid` | staff | read `restaurants:view`, write `restaurants:edit` |
| `/admin/assistant/training/central` | staff | read `settings:view`, write `settings:edit` |

| Method + path | Purpose |
|---|---|
| `GET /overview` | live version, dirty flag, counts, analytics (7 / 30 days, top questions, never used, coverage hints, thumbs), unanswered groups, needs-review count, starter suggestions, threshold, `requireApproval`, pending request |
| `GET /entries?search&status&page&limit`, `POST /entries`, `GET/PATCH/DELETE /entries/:id`, `POST /entries/check` (validate without saving), `POST /entries/bulk {ids, action: activate\|deactivate\|delete}` | answers (draft) |
| `GET /aliases`, `GET /menu-options`, `POST /aliases {kind: item\|category, alias, targetId}`, `DELETE /aliases/:id`, `POST/PATCH/DELETE /synonyms[/:id] {term, alternates}` | nicknames and synonyms; conflicts (same nickname twice, nickname = another item's name, synonym already in another group) are rejected with a clear message |
| `GET/POST /documents`, `PATCH/DELETE /documents/:id {title, text}` | documents |
| `GET /unanswered?status=OPEN\|IGNORED\|TAUGHT`, `POST /unanswered/:id/teach`, `/merge {entryId}`, `/ignore`, `/restore`; `GET /feedback-review`, `POST /feedback-review/:entryId/dismiss` | learning loop |
| `POST /test {question}` | playground against the draft: outcome, ranked top 3 with reasons, ambiguity, document passage |
| `GET/POST /test-cases`, `DELETE /test-cases/:id`, `POST /test-cases/run` | test set (max 100) |
| `GET /versions`, `GET /versions/:n`, `POST /versions/publish {note?, confirmRegressions?}`, `POST /versions/:n/rollback {note?}`, `POST /draft/discard` | publish. `409 {code: "REGRESSIONS", details}` until `confirmRegressions: true`. With approval on, a restaurant gets `{status: "REQUESTED", request}`. |
| `GET /requests`, `POST /requests/:id/cancel` | the restaurant's own approval requests |
| `GET/PATCH /settings {threshold}` | confidence threshold (draft) |
| `GET /export`, `GET /export.csv`, `POST /import`, `POST /import-csv` | see 6 |
| `POST /held/:kind(entry\|document)/:id/release` and `/reject` | **staff only** (also on the restaurant base: 403 for restaurant users) |

Platform routes (`/admin/assistant/training`): `GET /overview` (stats, approval queue, held queue, approval switch), `GET /restaurants` (coverage table; `search, page, limit, sortBy=name\|entries\|unanswered\|rate\|pending, sortDir`), `GET /requests?status=PENDING\|APPROVED\|REJECTED\|ALL`, `GET /requests/:id` (with diff), `POST /requests/:id/approve|reject {note}` (`restaurants:edit`), `GET /held`.

Public chat is unchanged except that replies from taught answers carry `feedback: true` and `entryId`; `POST /public/assistant/feedback { sessionId, messageId?, rating: up|down, comment? }` records thumbs (counted per answer; question and comment are stored with personal data stripped; an answer with at least one thumbs-down and no more thumbs-up than thumbs-down appears under "Needs review" until dismissed).

Settings (group `assistant`): `assistant.training.requireApproval` (bool, default false), `assistant.training.holdPhrases`, `assistant.training.blockPhrases` (lists, extend the built-in patterns).

Notifications (copy in `DEFAULT_MESSAGES`): `assistant.training.requested` (to staff) and `assistant.training.decided` (to the restaurant).

---

## 8. Data and retention

Tables (TypeORM, `assistant-training.entities.ts`): `assistant_kb_drafts` (one row per scope: content, test cases, base version), `assistant_kb_versions` (immutable snapshots), `assistant_kb_requests` (approval requests with the exact content), `assistant_questions` (unanswered / answered question groups: normalised text, count, status; no session id), `assistant_daily` (daily counters per outcome), `assistant_kb_stats` (per-answer used counts, thumbs), `assistant_feedback`. Published knowledge is cached in memory for up to 10 seconds per instance (a publish is visible to guests within that time). The daily cleanup removes handled (taught / ignored) question groups after 90 days, any question group after 365 days feedback rows after 180 days, daily counters after 400 days and cancels approval requests that nobody decided (see `training.store.ts`); unanswered questions never contain a session id, and the chat sessions themselves keep the existing 24 h content / 35 day row retention. If the rows of a scope are ever deleted behind the API's back (restore, manual clean-up) they are re-created from the old FAQs on the next access.

---

## 9. Limits and honest limitations

| Limit | Value |
|---|---|
| Answers per bot | 500 |
| Phrasings per answer | 15 (each up to 200 characters) |
| Answer text | 800 characters; title 80; buttons 3 per answer (label 30); tags 8 |
| Nicknames / synonym groups | 200 / 100 (up to 10 alternates per group) |
| Documents | 20 x 20,000 characters (chunked into ~300-character passages with overlap) |
| Test cases | 100 |
| Threshold | 0.4 to 0.9 (default 0.6) |

**The engine matches wording, it does not understand.** It works well when guests ask about things you taught in similar words, with typos, different word order or extra filler. It cannot reason ("is it good for a child's birthday?"), combine two answers, do arithmetic, follow context from earlier messages, or answer in other languages unless you teach phrasings in that language. It will sometimes miss a rephrasing (add it from the inbox: one tap) and, rarely, match a short question to a wrong answer when two answers share the same rare word (the test bench shows why; raise the threshold, add priority, or add phrasings). A low threshold answers more but risks wrong answers; a high one is safer but sends more questions to the inbox. Allergen and medical promises are never published without staff approval, and the bot never certifies that food is safe.

**Optional LLM slot.** `brain/llm.brain.ts` remains an untested adapter stub (it returns nothing unless `ANTHROPIC_API_KEY` is set). It is not part of the training tool, is not covered by tests and has no guardrails of its own; do not enable it without a separate review.

---

## 10. Tests

```bash
cd backend
npx tsc --noEmit -p tsconfig.json
npx ts-node --transpile-only test/assistant-training.test.ts   # engine, guardrails, chunking, CSV, index rebuild, versions, regression runner (73 checks, >60 labelled phrasing variants)
npx ts-node --transpile-only test/assistant-brain.test.ts       # brain (125 checks)
node test/assistant-training-integration.mjs                    # HTTP: teach loop through the public chat, draft isolation, rollback, approval, permission matrix, isolation, guardrails, import/export, central (153 checks, ~1.5 min)
node test/assistant-integration.mjs                             # existing assistant integration (needs the demo restaurant to be open now)
# UI (Playwright, API :4000 + admin :3000 running)
node admin/test/xss-smoke.mjs                                   # sidebar sweep incl. the Training pages
node admin/test/xss-training.cjs                                # payload-rewriting check of every Training tab
```
