import { money } from './nlp';
import type { BotCard, BotChip, KHours, KItem, Knowledge } from './brain.types';

/** Small helpers that shape replies. The bot only ever quotes values it was given by the restaurant's own data. */

export const MAX_CARDS = 6;
export const MAX_CHIPS = 6;

export const chip = (label: string, payload: string): BotChip => ({ label: label.slice(0, 40), payload });

export const uniqChips = (chips: BotChip[]): BotChip[] => {
  const seen = new Set<string>();
  const out: BotChip[] = [];
  for (const c of chips) {
    if (seen.has(c.payload)) continue;
    seen.add(c.payload);
    out.push(c);
    if (out.length >= MAX_CHIPS) break;
  }
  return out;
};

export function cardOf(i: KItem): BotCard {
  return {
    menuItemId: i.id,
    name: i.name,
    ...(i.description ? { description: i.description.slice(0, 160) } : {}),
    price: i.price,
    ...(i.imageUrl ? { imageUrl: i.imageUrl } : {}),
    ...(i.dietaryTags.length ? { tags: i.dietaryTags.slice(0, 5) } : {}),
    available: i.available,
  };
}

export const cardsOf = (items: KItem[]) => items.slice(0, MAX_CARDS).map(cardOf);

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "17:00" -> "5:00 PM" */
export function fmtTime(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const ap = h >= 12 ? 'PM' : 'AM';
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh}:${String(m || 0).padStart(2, '0')} ${ap}`;
}

/** Group a week of opening hours into short lines: "Mon-Fri 9:00 AM - 9:00 PM", "Sun closed". Order starts on Monday. */
export function hoursLines(hours: KHours[]): string[] {
  if (!hours.length) return [];
  const order = [1, 2, 3, 4, 5, 6, 0];
  const byDay = new Map<number, string>();
  for (const d of order) {
    const rows = hours.filter((h) => h.dayOfWeek === d).sort((a, b) => a.openTime.localeCompare(b.openTime));
    const live = rows.filter((r) => !r.closed);
    byDay.set(d, live.length ? live.map((r) => `${fmtTime(r.openTime)} - ${fmtTime(r.closeTime)}`).join(', ') : 'closed');
  }
  const lines: string[] = [];
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && byDay.get(order[j + 1]) === byDay.get(order[i])) j++;
    const a = DAY_SHORT[order[i]];
    const b = DAY_SHORT[order[j]];
    lines.push(`${i === j ? a : j === i + 1 ? `${a}, ${b}` : `${a}-${b}`} ${byDay.get(order[i])}`);
    i = j + 1;
  }
  return lines;
}

export function hoursForDay(hours: KHours[], dow: number): string {
  const rows = hours.filter((h) => h.dayOfWeek === dow && !h.closed).sort((a, b) => a.openTime.localeCompare(b.openTime));
  return rows.length ? rows.map((r) => `${fmtTime(r.openTime)} - ${fmtTime(r.closeTime)}`).join(', ') : 'closed';
}

/** day of week (0 = Sunday) of `at` in a time zone */
export function dowIn(at: Date, tz: string): number {
  const w = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(at);
  return DAY_SHORT.indexOf(w);
}

/** "$12.00" or "$12.00 (from)" if the item has priced options */
export const priceText = (i: KItem) => money(i.price);

export function allergenText(i: KItem): string {
  const parts: string[] = [];
  parts.push(i.allergens.length ? `listed allergens: ${i.allergens.join(', ')}` : 'no allergens are listed for it');
  if (i.dietaryTags.length) parts.push(`dietary tags: ${i.dietaryTags.join(', ')}`);
  return parts.join('; ');
}

export const ALLERGY_WARNING = (kb: Knowledge | null) =>
  `Allergen details come from what the restaurant recorded and may be incomplete, so please confirm with ${kb?.restaurant.name ?? 'the restaurant'}${kb?.restaurant.phone ? ` (${kb.restaurant.phone})` : ''} before you order.`;
