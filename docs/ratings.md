# FORKSY Ratings - policy and how it works

Plain-language description of the rating system. Code: `backend/src/ratings/`. API: see `docs/api/customers.md`, `drivers.md`, `restaurants.md`, `analytics.md`. Every number below is a setting under `ratings.*` (Admin Console > System > Settings) unless marked fixed.

## 1. Who rates whom

| Rater | Rates | Where it shows |
|---|---|---|
| Customer | the **restaurant** (delivery and pickup orders) | public restaurant page, search cards, restaurant portal |
| Customer | the **driver** (delivery orders completed by a FORKSY driver only; not pickup, not a restaurant's own driver) | driver app (aggregate + comments), admin driver page |
| Driver | the **customer** (private) | admin customer page only |
| Restaurant (owner, location manager, cashier) | the **customer** (private) | admin customer page only |

Drivers and restaurants never rate each other. Customers never see ratings of customers.

## 2. Rules for customer reviews

* Only the customer who placed the order, only after it is **DELIVERED / COLLECTED**.
* Window: `ratings.windowDays` = **7 days** after delivery.
* **One review per order.** The customer can **edit it once**, within `ratings.editWindowHours` = **24 hours** of posting. Earlier versions are kept (edit history) for staff.
* Stars are whole numbers 1-5. At least one of restaurant / driver must be rated.
* Tags come from fixed lists per target (positive and negative), published at `GET /public/rating-options` so the apps do not hard-code them. A rating of **2 stars or less needs at least one negative reason tag** (`ratings.requireReasonTag`, `ratings.lowRatingMax`).
* Comment: at most `ratings.commentMaxLength` = 500 characters; HTML is stripped by the platform input sanitiser.
* Not allowed: orders that were cancelled / rejected, and orders **refunded in full because they never arrived** (refund reason NEVER_ARRIVED and similar).
* The review endpoints are rate limited (10 writes / minute / user).

## 3. How the numbers are calculated

Only reviews with status **VISIBLE** count. Hidden and flagged reviews are excluded everywhere (aggregates, public lists, analytics).

**Smoothing (Bayesian average).** A raw average is unfair to new targets: one angry 1-star would make a new restaurant 1.0. So every rating is blended with a "prior":

```
smooth(sum, n, prior, m) = (m x prior + sum of stars) / (m + n)          m = ratings.priorWeight = 10
```

* **All-time rating** = smooth(all stars, n, platform prior), prior = **4.3** for restaurants, **4.7** for drivers (`ratings.restaurant.priorMean`, `ratings.driver.priorMean`).
* **Rolling rating** (the one shown and used for ranking) = smooth(stars in the last **90 days**, n in window, prior = the smoothed rating of the reviews *older* than the window). Recent reviews dominate when there are many; in a quiet period it falls back to the long-run record, never to zero.
* `Restaurant.rating` / `DriverProfile.rating` hold the **rolling smoothed** value; `ratingCount` is the all-time count of visible reviews. Existing readers (discovery sorting, analytics tables, dispatch scoring `performance` factor, SOP-08 detector) therefore use the smoothed value automatically.
* Examples: one 1-star on a 100-review 4.5 restaurant moves it by ~0.03 (4.50 -> 4.47); on a brand-new restaurant it shows **4.0** (not 1.0).
* Also stored: raw 30-day average and count (used for alerts), star distribution (1-5 counts), top positive and negative tags (last 90 days).
* Updated live (on create, edit, hide, flag, restore) and recomputed every night at 03:00 so the rolling windows slide.
* **Display rule:** no number until `ratings.minCountToShow` = **5** reviews. Before that the apps get `rating: null` and `ratingLabel: "New"`.

**Customer ratings** (from drivers/restaurants): smooth(sum, n, 4.5, 3) - three virtual 4.5s so one rating cannot swing the profile. Stored on the customer profile for staff only.

## 4. Consequences and alerts

Alerts use the raw **30-day** average and need enough ratings (a minimum count is the fairness guard).

| Target | Condition (defaults) | What happens |
|---|---|---|
| Driver | 30-day average < **4.5** with >= **20** ratings (`ratings.driver.warnBelow`, `minRatings`) | Coaching notification to the driver listing the three most common negative tags, plus an ops notification |
| Driver | 30-day average < **4.2** (`ratings.driver.reviewBelow`) | Same, and the **SOP-08 detector** proposes a performance review case (trigger LOW_RATING, status PROPOSED). Nothing is automatic: staff decide, with the written-notice process |
| Driver | any | The dispatch score already uses the rating via the `performance` factor (50 % on-time, 50 % rating/5, itself 6 % of the total weight); it now reads the smoothed value, so a new driver is not punished |
| Restaurant | 30-day average < **4.0** with >= **20** ratings (`ratings.restaurant.warnBelow`) | Notification to the owner and ops. Optional: `ratings.restaurant.discoveryPenalty` (default 0 = off, e.g. 0.9) multiplies the restaurant's score in rating/popularity sorts and "best" lists while in this state |
| Customer | a partner rates **<= 2 stars with UNSAFE or ABUSIVE** | `SAFETY_CONCERN` flag on the profile, a note in internal notes, an ops notification. **Never an automatic ban** |
| Customer | **3 low ratings in 30 days** (`ratings.customer.lowCountFlag`) | `LOW_RATING_PATTERN` flag + ops notification |

An alert fires once when the state gets worse; it does not repeat every night. Recovering clears the state silently.

## 5. Abuse protection

Suspicious reviews are **flagged, never deleted**. A flagged review disappears from public ratings until staff restore it. Rules (`ratings.fraud.*`):

1. **Fraud-flagged account** (customer profile has the fraud flag or is blocked).
2. **Review bomb:** 3 or more 1-star reviews on the same restaurant/driver within 24 hours from accounts younger than 14 days. The whole burst is flagged.
3. **Duplicate text:** the same comment (15+ characters) twice within 30 days from one customer or onto one restaurant.
4. **Retaliation:** a 1-2 star review after the customer's refund request on the same order was rejected, or a support dispute was closed without a refund.

Staff can **hide / flag / restore** each side of a review: restaurant side needs `restaurants:approve`, driver side `drivers:approve`. A **reason is required** and every action is audit-logged (`review.hide`, `review.flag`, `review.restore`). Once staff have restored a review the automatic rules leave it alone.

Restaurants can **report** an abusive review (once per review, with a reason, at most 10 per 30 days). The review is flagged for staff immediately. Restaurants cannot hide or delete reviews and can always reply publicly.

## 6. Prompts

* After DELIVERED/COLLECTED the customer gets one rating prompt after `ratings.promptDelayMinutes` = **10 min** and, if still unrated, **one reminder after 24 h** (`ratings.reminderDelayHours`). Nothing is sent if the order is rated, or refunded as not delivered.
* The driver (platform deliveries) and the restaurant get one private "rate the customer" prompt after `ratings.partnerPromptDelayMinutes` = 5 min. No reminder.
* Each prompt is claimed in the `rating_prompts` table first, so it is sent exactly once even across restarts. Prompts are only sent for orders completed in the last 24 h (customers) / 12 h (partners), so a deploy never spams old orders.

## 7. What each party can see

| Party | Sees |
|---|---|
| Public / customers browsing | restaurant rating (or "New"), count, star distribution, top positive tags, recent **visible** reviews with first name + initial and the restaurant's reply |
| Reviewing customer | their own review, whether it can still be edited, the restaurant reply. Never moderation status or flag reasons |
| Restaurant (OWNER / LOCATION_MANAGER) | all reviews of its locations (including held-back ones, labelled), summary, distribution, weekly trend, top tags, reply and report actions. Not who flagged what |
| Driver | own smoothed rating, 90-day and 30-day figures, distribution, top tags, recent comments with the customer's **first name only** (no contact details, no order ids). Not the internal alert state |
| Staff | everything: both sides, edit history, flag reasons, moderation log, customer ratings, analytics |
| Customers' ratings (from partners) | **staff only** (customer detail "Ratings received" tab; support can read the feedback on a disputed order). Not the customer, not drivers, not restaurants, not the public |

**Decision (default):** drivers and restaurants do **not** see a customer's average or any "good / caution" status. The coarse `new / good / caution` signal exists (staff API) so it can be offered to partners later for safety (e.g. "customer has safety notes"); turning that on is a product and privacy decision for the owner.

## 8. Scheduled jobs

| Job | When | What |
|---|---|---|
| Prompts / reminders | every minute | customer prompt, reminder, driver/restaurant prompts |
| Aggregates | on every review change + nightly 03:00 | recompute ratings, fire alerts |
| Customer aggregates | nightly 03:15 | refresh 30-day low-rating counts |
| SOP-08 detector | hourly (existing) | proposes review cases incl. the new rolling 30-day rating trigger |
