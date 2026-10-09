import { csvSafe } from '../../common/security';
import { KbEntry } from './types';

/** RFC 4180 style CSV parser (quotes, doubled quotes, commas and newlines inside quotes). Returns raw rows. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let q = false;
  const s = String(text ?? '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      row.push(cur);
      cur = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cur);
      cur = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else cur += c;
  }
  row.push(cur);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}

export interface CsvImport {
  entries: { title: string; questions: string[]; answer: string; tags: string[]; active?: boolean; line: number }[];
  errors: { line: number; message: string }[];
}

/**
 * Q&A rows -> entry inputs. Accepted headers (case-insensitive): `title, questions, answer, tags, active` (questions separated by " | ")
 * or the simple `question, answer`. The first row must be the header.
 */
export function entriesFromCsv(csv: string): CsvImport {
  const rows = parseCsv(csv);
  const out: CsvImport = { entries: [], errors: [] };
  if (!rows.length) return out;
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const has = (n: string) => head.indexOf(n);
  const headerRow = true; // the first row must name the columns (a guess at headerless files would import the wrong thing)
  const col = { title: has('title'), q: has('questions') >= 0 ? has('questions') : has('question'), a: has('answer'), tags: has('tags'), active: has('active') };
  if (col.q < 0 || col.a < 0) {
    out.errors.push({ line: 1, message: 'The first row must name the columns: question (or questions) and answer. Optional: title, tags, active.' });
    return out;
  }
  rows.slice(headerRow ? 1 : 0).forEach((r, i) => {
    const line = i + (headerRow ? 2 : 1);
    const questions = (r[col.q] ?? '').split('|').map((x) => x.trim()).filter(Boolean);
    const answer = (r[col.a] ?? '').trim();
    if (!questions.length) return out.errors.push({ line, message: 'Row has no question.' });
    if (!answer) return out.errors.push({ line, message: 'Row has no answer.' });
    const title = col.title >= 0 ? (r[col.title] ?? '').trim() : '';
    out.entries.push({
      title: title || questions[0],
      questions,
      answer,
      tags: col.tags >= 0 ? (r[col.tags] ?? '').split(/[|;]/).map((x) => x.trim()).filter(Boolean) : [],
      ...(col.active >= 0 && r[col.active] !== undefined && r[col.active].trim() !== '' ? { active: !/^(false|0|no)$/i.test(r[col.active].trim()) } : {}),
      line,
    });
  });
  return out;
}

const cell = (v: unknown) => {
  const s = csvSafe(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function entriesToCsv(entries: Pick<KbEntry, 'title' | 'questions' | 'answer' | 'tags' | 'active'>[]): string {
  const lines = ['title,questions,answer,tags,active'];
  for (const e of entries) lines.push([e.title, e.questions.join(' | '), e.answer, e.tags.join('; '), e.active ? 'true' : 'false'].map(cell).join(','));
  return lines.join('\n') + '\n';
}
