import { createHash } from 'crypto';
import { Quote, QuoteInput } from '../common/contracts';

/**
 * Fingerprint of a priced cart. It is stored on the Stripe PaymentIntent (metadata.quoteHash) and in stripe_intents when the
 * intent is created, and recomputed when the order is placed: if anything that affects the price changed in between (items, tip,
 * address, promo, wallet use, fees) the hashes differ and the order is refused with 409 PAYMENT_QUOTE_CHANGED, so the page
 * creates a fresh intent instead of charging an outdated amount.
 */
export function quoteFingerprint(input: Pick<QuoteInput, 'restaurantId' | 'items' | 'deliveryAddress' | 'scheduledFor'>, quote: Quote): string {
  const items = input.items
    .map((i) => `${i.menuItemId}x${i.quantity}[${[...(i.modifierOptionIds ?? [])].sort().join(',')}]`)
    .sort()
    .join('|');
  const addr = input.deliveryAddress ? `${Number(input.deliveryAddress.lat).toFixed(5)},${Number(input.deliveryAddress.lng).toFixed(5)}` : '-';
  const when = input.scheduledFor ? new Date(input.scheduledFor).toISOString() : '-';
  const raw = [input.restaurantId, quote.type, quote.fulfilment, items, addr, Number(quote.tip).toFixed(2), quote.promotion?.id ?? '-', Number(quote.walletUsed).toFixed(2), Number(quote.total).toFixed(2), when].join('#');
  return createHash('sha256').update(raw).digest('hex').slice(0, 32);
}
