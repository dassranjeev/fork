/**
 * Rating system constants and pure helpers (no Nest/TypeORM) - shared by the services, the seeds and the tests.
 * Policy in plain language: docs/ratings.md.
 */

export type RatingTarget = 'RESTAURANT' | 'DRIVER';

export interface TagDef {
  code: string;
  label: string;
}

/** Predefined tags a customer can attach to a rating (GET /public/rating-options). */
export const REVIEW_TAGS: Record<'restaurant' | 'driver', { positive: TagDef[]; negative: TagDef[] }> = {
  restaurant: {
    positive: [
      { code: 'GREAT_FOOD', label: 'Great food' },
      { code: 'FRESH', label: 'Fresh' },
      { code: 'HOT_AND_READY', label: 'Hot and ready' },
      { code: 'GOOD_PORTION', label: 'Generous portions' },
      { code: 'GOOD_PACKAGING', label: 'Well packaged' },
      { code: 'ACCURATE_ORDER', label: 'Order was accurate' },
      { code: 'GOOD_VALUE', label: 'Good value' },
      { code: 'FAST_PREP', label: 'Fast preparation' },
    ],
    negative: [
      { code: 'COLD_FOOD', label: 'Food was cold' },
      { code: 'WRONG_ITEMS', label: 'Wrong items' },
      { code: 'MISSING_ITEMS', label: 'Missing items' },
      { code: 'POOR_QUALITY', label: 'Poor quality' },
      { code: 'SMALL_PORTION', label: 'Small portions' },
      { code: 'BAD_PACKAGING', label: 'Bad packaging / spilled' },
      { code: 'SLOW_PREPARATION', label: 'Took too long to prepare' },
      { code: 'ALLERGEN_CONCERN', label: 'Allergen or hygiene concern' },
    ],
  },
  driver: {
    positive: [
      { code: 'FRIENDLY', label: 'Friendly' },
      { code: 'ON_TIME', label: 'On time' },
      { code: 'CAREFUL_HANDLING', label: 'Handled the food carefully' },
      { code: 'FOLLOWED_INSTRUCTIONS', label: 'Followed my instructions' },
      { code: 'GOOD_COMMUNICATION', label: 'Good communication' },
      { code: 'PROFESSIONAL', label: 'Professional' },
    ],
    negative: [
      { code: 'LATE', label: 'Late' },
      { code: 'RUDE', label: 'Rude' },
      { code: 'UNPROFESSIONAL', label: 'Unprofessional' },
      { code: 'FOOD_SPILLED', label: 'Food spilled or damaged' },
      { code: 'WRONG_ADDRESS', label: 'Went to the wrong place' },
      { code: 'IGNORED_INSTRUCTIONS', label: 'Ignored my instructions' },
      { code: 'POOR_COMMUNICATION', label: 'Poor communication' },
      { code: 'UNSAFE_DRIVING', label: 'Unsafe driving' },
    ],
  },
};

/** Tags a driver or a restaurant can attach to a customer rating. */
export const CUSTOMER_TAGS: { positive: TagDef[]; negative: TagDef[]; safety: string[] } = {
  positive: [
    { code: 'FRIENDLY', label: 'Friendly' },
    { code: 'GOOD_TIPPER', label: 'Good tipper' },
    { code: 'CLEAR_INSTRUCTIONS', label: 'Clear instructions' },
    { code: 'EASY_HANDOFF', label: 'Easy handoff' },
  ],
  negative: [
    { code: 'ADDRESS_HARD_TO_FIND', label: 'Address hard to find' },
    { code: 'NO_ANSWER', label: 'No answer' },
    { code: 'RUDE', label: 'Rude' },
    { code: 'ABUSIVE', label: 'Abusive' },
    { code: 'UNSAFE', label: 'Felt unsafe' },
    { code: 'LONG_WAIT', label: 'Made the driver / staff wait' },
  ],
  safety: ['UNSAFE', 'ABUSIVE'],
};

export const tagCodes = (defs: TagDef[]) => defs.map((t) => t.code);
export const REVIEW_TAG_SETS = {
  restaurant: { positive: new Set(tagCodes(REVIEW_TAGS.restaurant.positive)), negative: new Set(tagCodes(REVIEW_TAGS.restaurant.negative)) },
  driver: { positive: new Set(tagCodes(REVIEW_TAGS.driver.positive)), negative: new Set(tagCodes(REVIEW_TAGS.driver.negative)) },
};
export const CUSTOMER_TAG_SETS = {
  positive: new Set(tagCodes(CUSTOMER_TAGS.positive)),
  negative: new Set(tagCodes(CUSTOMER_TAGS.negative)),
};

/** Flag reasons written to Review.flagReasons. */
export const FLAG = {
  FRAUD_ACCOUNT: 'FRAUD_ACCOUNT',
  REVIEW_BOMB: 'REVIEW_BOMB',
  DUPLICATE_TEXT: 'DUPLICATE_TEXT',
  REFUND_RETALIATION: 'REFUND_RETALIATION',
  REPORTED: 'REPORTED_BY_RESTAURANT',
  STAFF: 'STAFF_FLAGGED',
} as const;

/** Tunables read from settings (`ratings.*`); the defaults are the documented policy. */
export interface RatingConfig {
  priorWeight: number;
  restaurantPriorMean: number;
  driverPriorMean: number;
  rollingDays: number;
  minCountToShow: number;
}
export const DEFAULT_RATING_CONFIG: RatingConfig = { priorWeight: 10, restaurantPriorMean: 4.3, driverPriorMean: 4.7, rollingDays: 90, minCountToShow: 5 };

/**
 * Bayesian (shrinkage) average: (m x priorMean + sum of stars) / (m + n).
 * With m = 10 virtual reviews, one 1-star on a 100-review 4.5 target moves it by about 0.03,
 * and on a brand-new target it gives 4.0 (not 1.0).
 */
export function smooth(sum: number, n: number, priorMean: number, m: number): number {
  return (m * priorMean + sum) / (m + n);
}

export const round = (v: number, dp = 2) => Math.round(v * 10 ** dp) / 10 ** dp;

/** Public display rule: no numeric rating until minCountToShow reviews exist. */
export function ratingDisplay(rating: number | null | undefined, count: number | null | undefined, minCount = DEFAULT_RATING_CONFIG.minCountToShow) {
  const n = count ?? 0;
  if (rating == null || n < minCount) return { rating: null as number | null, ratingCount: n, ratingLabel: 'New' as string | null };
  return { rating: round(rating, 1), ratingCount: n, ratingLabel: null as string | null };
}

export interface TagCount {
  tag: string;
  label: string;
  count: number;
}

const LABELS = new Map<string, string>();
for (const k of ['restaurant', 'driver'] as const) for (const t of [...REVIEW_TAGS[k].positive, ...REVIEW_TAGS[k].negative]) LABELS.set(`${k}:${t.code}`, t.label);
for (const t of [...CUSTOMER_TAGS.positive, ...CUSTOMER_TAGS.negative]) LABELS.set(`customer:${t.code}`, t.label);
export const tagLabel = (kind: 'restaurant' | 'driver' | 'customer', code: string) => LABELS.get(`${kind}:${code}`) ?? code.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

/** Normalised comment text used for duplicate detection. */
export const normaliseText = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

/** 'Great food' | 'great_food' -> 'GREAT_FOOD' (legacy seeded tags were free text). */
export const canonTag = (s: string) => String(s ?? '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
