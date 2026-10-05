import { DataSource } from 'typeorm';
import { SeedOptions } from '../database/seed-types';
import { recomputeRatingAggregates } from './rating-aggregates.service';
import { CUSTOMER_TAGS, REVIEW_TAGS, canonTag, round, smooth } from './ratings.constants';

/**
 * Demo ratings: gives every restaurant and driver that has orders its own "personality" (target average) so the
 * distributions, trends and leaderboards look real, then re-rates the existing seeded reviews, reviews the remaining
 * completed orders, adds partner feedback about customers, a few flagged/hidden/reported reviews, and recomputes
 * the aggregates. Idempotent: skipped when any restaurant already carries `meta.ratingsSeeded`. Logins are untouched.
 */
const RESTAURANT_MEANS = [4.85, 4.7, 4.55, 4.4, 4.25, 4.1, 3.9, 3.55, 4.8, 4.5, 4.3, 3.3, 4.65, 4.0, 4.9, 3.75];
const DRIVER_MEANS = [4.9, 4.75, 4.6, 4.45, 4.1, 4.8, 4.3, 4.65, 4.95, 4.55, 4.7, 4.2];

const REST_COMMENTS: Record<number, string[]> = {
  5: ['Delicious, arrived hot and on time!', 'Best in the neighbourhood, will order again.', 'Generous portions and great flavour.', 'Perfect as always.', 'Fresh ingredients and well packed.'],
  4: ['Really good, just a little salty.', 'Tasty food, packaging could be better.', 'Great meal, slightly longer wait than quoted.', 'Solid choice for a weeknight.'],
  3: ['Average. Food was lukewarm.', 'Okay but portions were small.', 'Fine, nothing special.'],
  2: ['Order was missing an item.', 'Food arrived cold and soggy.', 'Not what I ordered, and tasted stale.'],
  1: ['Wrong order, very disappointed.', 'Terrible quality, would not recommend.', 'Missing half the order and no apology.'],
};
const DRIVER_COMMENTS: Record<number, string[]> = {
  5: ['Super friendly driver!', 'Fast and careful delivery.', 'Great communication.', 'Left it exactly where I asked.'],
  4: ['Good delivery, a bit late.', 'Polite and quick.'],
  3: ['Okay, had to call for directions.', 'Took longer than expected.'],
  2: ['Late and did not follow my instructions.', 'Bag was tipped over.'],
  1: ['Very late and rude when I asked.', 'Never found my address.'],
};
const NOTES_NEG = ['Waited several minutes at the door.', 'Phone was off, could not reach customer.', 'Entrance hard to find, no unit number.', 'Customer was impatient.'];
const NOTES_POS = ['Waiting at the door, very easy.', 'Clear instructions and tipped well.', 'Friendly handoff.'];

function rng(seed: string) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 3432918353), (h = (h << 13) | (h >>> 19));
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}
const draw = (mean: number, r: () => number) => Math.min(5, Math.max(1, Math.round(mean + (r() + r() + r() - 1.5) * 1.5 + (mean > 4.4 ? 0.35 : 0))));
const pick = <T>(arr: T[], r: () => number) => arr[Math.floor(r() * arr.length)];
const codes = (d: { code: string }[]) => d.map((x) => x.code);

function tagsFor(kind: 'restaurant' | 'driver', rating: number, r: () => number): string[] {
  const set = REVIEW_TAGS[kind];
  const pos = codes(set.positive);
  const neg = codes(set.negative);
  if (rating >= 4) return r() < 0.75 ? [...new Set([pick(pos, r), ...(r() < 0.4 ? [pick(pos, r)] : [])])] : [];
  if (rating <= 2) return [...new Set([pick(neg, r), ...(r() < 0.35 ? [pick(neg, r)] : [])])];
  return r() < 0.5 ? [pick(neg, r)] : [];
}

export async function seedRatings(ds: DataSource, opts: SeedOptions): Promise<void> {
  if (!opts.demo) return;
  const [seeded] = await ds.query(`SELECT COUNT(*)::int n FROM restaurants WHERE meta ? 'ratingsSeeded'`);
  if (seeded.n > 0) {
    console.log('  = ratings already seeded');
    return;
  }
  const now = Date.now();
  const restaurants: { id: string }[] = await ds.query(`SELECT id FROM restaurants ORDER BY "createdAt", id`);
  const drivers: { id: string }[] = await ds.query(`SELECT id FROM driver_profiles ORDER BY "createdAt", id`);
  const rMean = new Map(restaurants.map((r, i) => [r.id, RESTAURANT_MEANS[i % RESTAURANT_MEANS.length]]));
  const dMean = new Map(drivers.map((d, i) => [d.id, DRIVER_MEANS[i % DRIVER_MEANS.length]]));

  const orders: any[] = await ds.query(
    `SELECT o.id, o."customerId", o."restaurantId", o."driverId", o.fulfilment, o.type, COALESCE(o."deliveredAt", o."updatedAt") AS done, rv.id AS "reviewId", rv.reply, rv."repliedAt"
     FROM orders o LEFT JOIN reviews rv ON rv."orderId" = o.id WHERE o.status IN ('DELIVERED','COLLECTED') ORDER BY o.id`,
  );
  let created = 0;
  let rerated = 0;
  for (const o of orders) {
    const r = rng(o.id);
    const hasReview = !!o.reviewId;
    if (!hasReview && r() > 0.82) continue; // not every customer reviews
    const restaurantRating = draw(rMean.get(o.restaurantId) ?? 4.3, r);
    const canDriver = o.driverId && o.fulfilment === 'PLATFORM_DRIVER';
    const driverRating = canDriver ? draw(dMean.get(o.driverId) ?? 4.6, r) : null;
    const comment = r() < 0.7 ? pick(REST_COMMENTS[restaurantRating], r) : null;
    const driverComment = driverRating && r() < 0.45 ? pick(DRIVER_COMMENTS[driverRating], r) : null;
    const reply = restaurantRating <= 3 && (o.reply || r() < 0.5) ? o.reply ?? `Thanks for the feedback - we have shared it with the kitchen and hope to make it right next time.` : null;
    const createdAt = new Date(Math.min(new Date(o.done).getTime() + (20 + Math.floor(r() * 600)) * 60_000, now - 30_000));
    const params = [JSON.stringify(tagsFor('restaurant', restaurantRating, r)), JSON.stringify(driverRating ? tagsFor('driver', driverRating, r) : []), restaurantRating, driverRating, comment, driverComment, reply];
    if (hasReview) {
      await ds.query(
        `UPDATE reviews SET "restaurantTags" = $1::jsonb, "driverTags" = $2::jsonb, "restaurantRating" = $3, "driverRating" = $4, comment = $5, "driverComment" = $6, reply = $7, "repliedAt" = CASE WHEN $7::text IS NULL THEN NULL ELSE COALESCE("repliedAt", "createdAt" + interval '3 hours') END, status = 'VISIBLE', "driverStatus" = 'VISIBLE' WHERE id = $8`,
        [...params, o.reviewId],
      );
      rerated++;
    } else {
      await ds.query(
        `INSERT INTO reviews (id, "orderId", "customerId", "restaurantId", "driverId", "restaurantTags", "driverTags", "restaurantRating", "driverRating", comment, "driverComment", reply, "repliedAt", status, "driverStatus", "createdAt", "updatedAt")
         VALUES (gen_random_uuid(), $8, $9, $10, $11, $1::jsonb, $2::jsonb, $3, $4, $5, $6, $7, CASE WHEN $7::text IS NULL THEN NULL ELSE $12::timestamptz + interval '3 hours' END, 'VISIBLE', 'VISIBLE', $12, $12)`,
        [...params, o.id, o.customerId, o.restaurantId, canDriver ? o.driverId : null, createdAt],
      );
      created++;
    }
  }

  // a few moderation examples so the queues are not empty
  const sample = async (cond: string, n: number) => ds.query(`SELECT id FROM reviews WHERE ${cond} ORDER BY id LIMIT ${n}`);
  const bad = await sample(`"restaurantRating" <= 2 AND comment IS NOT NULL`, 6);
  if (bad[0]) await ds.query(`UPDATE reviews SET status = 'FLAGGED', "flagReasons" = '["REVIEW_BOMB"]'::jsonb WHERE id = $1`, [bad[0].id]);
  if (bad[1]) await ds.query(`UPDATE reviews SET status = 'FLAGGED', "flagReasons" = '["DUPLICATE_TEXT"]'::jsonb WHERE id = $1`, [bad[1].id]);
  if (bad[2]) await ds.query(`UPDATE reviews SET status = 'FLAGGED', "flagReasons" = '["REPORTED_BY_RESTAURANT"]'::jsonb, "reportedAt" = now() - interval '2 days', "reportReason" = 'Review describes a different restaurant and uses abusive language.' WHERE id = $1`, [bad[2].id]);
  if (bad[3]) {
    await ds.query(
      `UPDATE reviews SET status = 'HIDDEN', moderation = $2::jsonb WHERE id = $1`,
      [bad[3].id, JSON.stringify([{ side: 'RESTAURANT', action: 'HIDE', reason: 'Contains personal information about a staff member', byId: null, byName: 'Seed', at: new Date(now - 86400_000).toISOString() }])],
    );
  }
  const badDrv = await sample(`"driverRating" <= 2 AND "driverComment" IS NOT NULL`, 2);
  if (badDrv[0]) await ds.query(`UPDATE reviews SET "driverStatus" = 'FLAGGED', "flagReasons" = '["FRAUD_ACCOUNT"]'::jsonb WHERE id = $1`, [badDrv[0].id]);

  // private partner feedback about customers
  let rated = 0;
  const custIds: string[] = (await ds.query(`SELECT DISTINCT "customerId" FROM orders WHERE status IN ('DELIVERED','COLLECTED') ORDER BY 1`)).map((x: any) => x.customerId);
  const custMean = new Map(custIds.map((id, i) => [id, i % 11 === 3 ? 2.6 : i % 7 === 2 ? 3.6 : 4.8]));
  let unsafeBudget = 2;
  for (const o of orders) {
    const r = rng('cr' + o.id);
    if (r() > 0.45) continue;
    const mean = custMean.get(o.customerId) ?? 4.7;
    const make = async (raterType: 'DRIVER' | 'RESTAURANT', raterRefId: string, raterId: string) => {
      let rating = draw(mean, r);
      let tags: string[];
      let note: string | null = null;
      if (rating >= 4) {
        tags = r() < 0.6 ? [pick(codes(CUSTOMER_TAGS.positive), r)] : [];
        if (r() < 0.2) note = pick(NOTES_POS, r);
      } else {
        const neg = codes(CUSTOMER_TAGS.negative).filter((t) => !CUSTOMER_TAGS.safety.includes(t));
        tags = rating <= 3 ? [pick(neg, r)] : [];
        if (rating <= 2 && unsafeBudget > 0 && mean < 3 && r() < 0.25) {
          unsafeBudget--;
          rating = 1;
          tags = [pick(CUSTOMER_TAGS.safety, r)];
          note = 'Customer shouted at the driver at the door and refused to take the order.';
          await ds.query(`UPDATE customer_profiles SET flags = (SELECT COALESCE(jsonb_agg(DISTINCT x), '[]'::jsonb) FROM jsonb_array_elements_text(flags || '["SAFETY_CONCERN"]'::jsonb) x) WHERE "userId" = $1`, [o.customerId]);
        } else if (rating <= 3 && r() < 0.5) note = pick(NOTES_NEG, r);
      }
      await ds.query(
        `INSERT INTO customer_ratings (id, "orderId", "customerId", "raterType", "raterId", "raterRefId", rating, tags, note, "createdAt", "updatedAt")
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $9) ON CONFLICT DO NOTHING`,
        [o.id, o.customerId, raterType, raterId, raterRefId, rating, JSON.stringify(tags.map(canonTag)), note, new Date(Math.min(new Date(o.done).getTime() + 15 * 60_000, now - 1000))],
      );
      rated++;
    };
    if (o.driverId && o.fulfilment === 'PLATFORM_DRIVER' && r() < 0.6) {
      const [d] = await ds.query(`SELECT "userId" FROM driver_profiles WHERE id = $1`, [o.driverId]);
      if (d) await make('DRIVER', o.driverId, d.userId);
    }
    if (r() < 0.5) {
      const [m] = await ds.query(`SELECT m."userId" FROM restaurant_members m JOIN restaurants r ON r."merchantId" = m."merchantId" WHERE r.id = $1 AND m.role = 'OWNER' LIMIT 1`, [o.restaurantId]);
      if (m) await make('RESTAURANT', o.restaurantId, m.userId);
    }
  }
  // customer aggregates (same formula as CustomerRatingsService.recomputeCustomer)
  const agg: any[] = await ds.query(`SELECT "customerId" id, COUNT(*)::int n, SUM(rating)::int s, COUNT(*) FILTER (WHERE rating <= 2 AND "createdAt" >= now() - interval '30 days')::int low FROM customer_ratings GROUP BY 1`);
  for (const a of agg) {
    await ds.query(`UPDATE customer_profiles SET "ratingAvg" = $2, "ratingCount" = $3, "lowRatingCount30d" = $4, "ratingUpdatedAt" = now() WHERE "userId" = $1`, [a.id, round(smooth(a.s, a.n, 4.5, 3), 3), a.n, a.low]);
  }

  await recomputeRatingAggregates(ds);
  await ds.query(`UPDATE restaurants SET meta = meta || '{"ratingsSeeded": true}'::jsonb`);
  await ds.query(`UPDATE driver_profiles SET meta = meta || '{"ratingsSeeded": true}'::jsonb`);
  console.log(`  + ratings: ${created} reviews added, ${rerated} existing re-rated, ${rated} customer ratings, aggregates recomputed`);
}
