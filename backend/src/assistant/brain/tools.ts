import { randomUUID } from 'crypto';
import type { AssistantCartLine } from '../../database/entities/assistant.entities';
import type { AddResult, AssistantTools, CartSummary, KGroup, KItem, KOption, Knowledge, SessionDraft } from './brain.types';

export const MAX_LINES = 40;
export const MAX_QTY = 20;
export const MAX_NOTE = 1000;
export const MAX_LINE_NOTE = 300;

/** options a required group still needs (required groups need at least max(1, min); optional ones need `min`) */
export const groupMin = (g: KGroup) => (g.required ? Math.max(1, g.min) : g.min);

const roundMoney = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

const cleanNote = (s: string) => s.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();

/** Priced view of a cart, computed ONLY from the restaurant's own menu (the bot never invents a price). */
export function summarizeCart(kb: Knowledge | null, cart: AssistantCartLine[]): CartSummary {
  const lines: CartSummary['lines'] = [];
  let subtotal = 0;
  let count = 0;
  for (const l of cart) {
    const item = kb?.items.find((i) => i.id === l.menuItemId);
    if (!item) continue;
    const options: { id: string; name: string; priceDelta: number }[] = [];
    for (const g of item.groups) for (const o of g.options) if (l.modifierOptionIds.includes(o.id)) options.push({ id: o.id, name: o.name, priceDelta: o.priceDelta });
    const unitPrice = roundMoney(item.price + options.reduce((s, o) => s + o.priceDelta, 0));
    const lineTotal = roundMoney(unitPrice * l.quantity);
    subtotal += lineTotal;
    count += l.quantity;
    lines.push({ lineId: l.lineId, menuItemId: item.id, name: item.name, quantity: l.quantity, unitPrice, lineTotal, options, ...(l.notes ? { notes: l.notes } : {}) });
  }
  return { lines, count, subtotal: roundMoney(subtotal) };
}

const sameLine = (a: AssistantCartLine, b: AssistantCartLine) =>
  a.menuItemId === b.menuItemId && JSON.stringify(a.modifierOptionIds) === JSON.stringify(b.modifierOptionIds) && (a.notes ?? '') === (b.notes ?? '');

/**
 * The ONLY code that changes a bot cart. Every call is validated against the restaurant's menu snapshot, so free text can
 * never add an item that is not on THIS menu, is switched off, is out of stock, or has an invalid option / quantity.
 */
export class DeterministicTools implements AssistantTools {
  constructor(private kb: Knowledge | null, private draft: SessionDraft) {}

  private item(id: string): KItem | undefined {
    return this.kb?.items.find((i) => i.id === id);
  }

  addItem(input: { menuItemId: string; quantity: number; optionIds?: string[]; note?: string; queue?: string[] }): AddResult {
    if (!this.kb) return { ok: false, error: 'NO_RESTAURANT', message: 'Pick a restaurant first.' };
    if (!this.kb.restaurant.orderable) return { ok: false, error: 'NOT_ORDERABLE', message: `${this.kb.restaurant.name} is not taking orders right now.` };
    const q = Math.floor(Number(input.quantity));
    if (!Number.isFinite(q) || q < 1 || q > MAX_QTY) return { ok: false, error: 'BAD_QUANTITY', message: `I can add between 1 and ${MAX_QTY} of an item at a time.` };
    const item = this.item(String(input.menuItemId));
    if (!item) return { ok: false, error: 'NOT_FOUND', message: 'That item is not on this menu.' };
    if (!item.available) return { ok: false, error: 'UNAVAILABLE', item, message: `${item.name} is not available right now.` };

    // ---- options: unique, belong to this item, available, within each group's maximum
    const chosen = [...new Set((input.optionIds ?? []).map(String))];
    const known = new Map<string, { g: KGroup; o: KOption }>();
    for (const g of item.groups) for (const o of g.options) known.set(o.id, { g, o });
    for (const id of chosen) {
      const k = known.get(id);
      if (!k) return { ok: false, error: 'BAD_OPTION', item, message: 'That option does not belong to this item.' };
      if (!k.o.available) return { ok: false, error: 'BAD_OPTION', item, message: `${k.o.name} is not available right now.` };
    }
    for (const g of item.groups) {
      const n = chosen.filter((id) => known.get(id)!.g.id === g.id).length;
      if (g.max > 0 && n > g.max) return { ok: false, error: 'BAD_OPTION', item, message: `You can choose at most ${g.max} for ${g.name}.` };
    }

    // ---- fill defaults where the customer chose nothing, then ask about required groups that are still short
    const defaulted: KOption[] = [];
    for (const g of item.groups) {
      const have = chosen.filter((id) => known.get(id)!.g.id === g.id).length;
      if (have > 0) continue;
      const defaults = g.options.filter((o) => o.isDefault && o.available);
      if (!defaults.length) continue;
      const take = g.max > 0 ? defaults.slice(0, g.max) : defaults;
      // defaults are pre-selected on the website too, so the bot applies them whenever the customer chose nothing in that group
      for (const o of take) {
        chosen.push(o.id);
        defaulted.push(o);
      }
    }
    for (const g of item.groups) {
      const have = chosen.filter((id) => known.get(id)!.g.id === g.id).length;
      const need = groupMin(g);
      if (have < need) {
        const options = g.options.filter((o) => o.available && !chosen.includes(o.id));
        if (!options.length) return { ok: false, error: 'BAD_OPTION', item, message: `${item.name} cannot be ordered right now (no ${g.name} option is available).` };
        this.draft.pending = { kind: 'modifiers', menuItemId: item.id, quantity: q, chosen: [...chosen], ...(input.note ? { notes: input.note } : {}), ...(input.queue?.length ? { queue: input.queue } : {}) };
        return { ok: true, ask: { group: g, remaining: need - have }, item };
      }
    }

    // ---- write the line (merge with an identical one)
    const note = input.note ? cleanNote(input.note).slice(0, MAX_LINE_NOTE) : undefined;
    const line: AssistantCartLine = { lineId: randomUUID(), menuItemId: item.id, quantity: q, modifierOptionIds: [...new Set(chosen)].sort(), ...(note ? { notes: note } : {}) };
    const existing = this.draft.cart.find((l) => sameLine(l, line));
    if (existing) {
      if (existing.quantity + q > MAX_QTY) return { ok: false, error: 'LINE_FULL', item, message: `You already have ${existing.quantity} of ${item.name}; the most I can hold on one line is ${MAX_QTY}.` };
      existing.quantity += q;
      this.draft.pending = null;
      return { ok: true, line: existing, item, defaulted, added: q, queue: input.queue };
    }
    if (this.draft.cart.length >= MAX_LINES) return { ok: false, error: 'CART_FULL', item, message: `Your cart is full (${MAX_LINES} different lines). Remove something to add more.` };
    this.draft.cart.push(line);
    this.draft.pending = null;
    return { ok: true, line, item, defaulted, added: q, queue: input.queue };
  }

  answerOption(optionId: string): AddResult {
    const p = this.draft.pending;
    if (!p || p.kind !== 'modifiers') return { ok: false, error: 'NOT_FOUND', message: 'There is nothing to choose right now.' };
    const item = this.item(p.menuItemId);
    if (!item) {
      this.draft.pending = null;
      return { ok: false, error: 'NOT_FOUND', message: 'That item is not on this menu.' };
    }
    let target: { g: KGroup; o: KOption } | null = null;
    for (const g of item.groups) for (const o of g.options) if (o.id === optionId) target = { g, o };
    if (!target || !target.o.available) return { ok: false, error: 'BAD_OPTION', item, message: 'That option is not available.' };
    // single-choice groups replace an earlier pick
    let chosen = p.chosen.slice();
    if (target.g.max === 1) chosen = chosen.filter((id) => !target!.g.options.some((o) => o.id === id));
    if (!chosen.includes(optionId)) chosen.push(optionId);
    this.draft.pending = null;
    return this.addItem({ menuItemId: p.menuItemId, quantity: p.quantity, optionIds: chosen, note: p.notes, queue: p.queue });
  }

  removeLine(lineId: string, quantity?: number) {
    const idx = this.draft.cart.findIndex((l) => l.lineId === lineId);
    if (idx < 0) return { ok: false, error: 'NOT_FOUND' as const };
    const line = this.draft.cart[idx];
    if (quantity && quantity > 0 && quantity < line.quantity) {
      line.quantity -= Math.floor(quantity);
      return { ok: true, removed: Math.floor(quantity), line };
    }
    this.draft.cart.splice(idx, 1);
    return { ok: true, removed: line.quantity, line };
  }

  setLineQuantity(lineId: string, quantity: number) {
    const q = Math.floor(Number(quantity));
    const line = this.draft.cart.find((l) => l.lineId === lineId);
    if (!line) return { ok: false, error: 'NOT_FOUND' as const };
    if (!Number.isFinite(q) || q < 1 || q > MAX_QTY) return { ok: false, error: 'BAD_QUANTITY' as const };
    line.quantity = q;
    return { ok: true };
  }

  changeOption(lineId: string, optionId: string) {
    const line = this.draft.cart.find((l) => l.lineId === lineId);
    if (!line) return { ok: false, error: 'NOT_FOUND' as const };
    const item = this.item(line.menuItemId);
    if (!item) return { ok: false, error: 'NOT_FOUND' as const };
    let hit: { g: KGroup; o: KOption } | null = null;
    for (const g of item.groups) for (const o of g.options) if (o.id === optionId) hit = { g, o };
    if (!hit || !hit.o.available) return { ok: false, error: 'BAD_OPTION' as const, item };
    let ids = line.modifierOptionIds.slice();
    const inGroup = ids.filter((id) => hit!.g.options.some((o) => o.id === id));
    if (hit.g.max === 1) ids = ids.filter((id) => !inGroup.includes(id));
    else if (hit.g.max > 0 && inGroup.length >= hit.g.max && !inGroup.includes(optionId)) return { ok: false, error: 'BAD_OPTION' as const, item };
    if (!ids.includes(optionId)) ids.push(optionId);
    const next: AssistantCartLine = { ...line, modifierOptionIds: [...new Set(ids)].sort() };
    // merge with an identical line if the change made them equal
    const dup = this.draft.cart.find((l) => l.lineId !== line.lineId && sameLine(l, next));
    if (dup) {
      if (dup.quantity + next.quantity > MAX_QTY) return { ok: false, error: 'LINE_FULL' as const, item };
      dup.quantity += next.quantity;
      this.draft.cart = this.draft.cart.filter((l) => l.lineId !== line.lineId);
      return { ok: true, line: dup, item, option: hit.o };
    }
    line.modifierOptionIds = next.modifierOptionIds;
    return { ok: true, line, item, option: hit.o };
  }

  setLineNote(lineId: string, note: string | null) {
    const line = this.draft.cart.find((l) => l.lineId === lineId);
    if (!line) return { ok: false, error: 'NOT_FOUND' as const };
    const n = note ? cleanNote(note) : '';
    if (n.length > MAX_LINE_NOTE) return { ok: false, error: 'NOTE_TOO_LONG' as const };
    if (n) line.notes = n;
    else delete line.notes;
    return { ok: true };
  }

  clearCart() {
    this.draft.cart = [];
    this.draft.pending = null;
  }

  addOrderNote(text: string) {
    const t = cleanNote(text);
    if (!t) return { ok: false, error: 'EMPTY' as const, note: this.draft.orderNote };
    const parts = (this.draft.orderNote ?? '').split(/;\s*/).filter(Boolean);
    if (!parts.some((p) => p.toLowerCase() === t.toLowerCase())) parts.push(t);
    const joined = parts.join('; ');
    if (joined.length > MAX_NOTE) return { ok: false, error: 'NOTE_TOO_LONG' as const, note: this.draft.orderNote };
    this.draft.orderNote = joined;
    return { ok: true, note: joined };
  }

  clearOrderNote() {
    this.draft.orderNote = null;
  }

  cancelPending() {
    this.draft.pending = null;
  }
}
