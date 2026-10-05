import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';
import { Order, Review } from '../database/entities';
import { FulfilmentMode, OrderStatus } from '../common/enums';
import { Events } from '../common/contracts';
import { SettingsService } from '../settings/settings.service';
import { CUSTOMER_TAGS, REVIEW_TAGS, REVIEW_TAG_SETS, canonTag } from './ratings.constants';
import { CreateReviewDto, EditReviewDto } from './ratings.dto';
import { RatingFraudService, commentHashOf } from './rating-fraud.service';

const DONE = [OrderStatus.DELIVERED, OrderStatus.COLLECTED];
const NON_DELIVERY = /NEVER|NOT_DELIVERED|NOT_RECEIVED|NO_DELIVERY/i;

@Injectable()
export class RatingsService {
  constructor(
    @InjectDataSource() private ds: DataSource,
    private settings: SettingsService,
    private emitter: EventEmitter2,
    private fraud: RatingFraudService,
  ) {}

  private cfg() {
    const s = this.settings;
    return {
      windowDays: s.get<number>('ratings.windowDays', 7),
      editHours: s.get<number>('ratings.editWindowHours', 24),
      maxLen: s.get<number>('ratings.commentMaxLength', 500),
      requireReason: s.get<boolean>('ratings.requireReasonTag', true),
      lowMax: s.get<number>('ratings.lowRatingMax', 2),
      minCount: s.get<number>('ratings.minCountToShow', 5),
    };
  }

  /** GET /public/rating-options */
  options() {
    const c = this.cfg();
    return {
      restaurant: REVIEW_TAGS.restaurant,
      driver: REVIEW_TAGS.driver,
      stars: [1, 2, 3, 4, 5],
      rules: { windowDays: c.windowDays, editWindowHours: c.editHours, commentMaxLength: c.maxLen, requireReasonTagAtOrBelow: c.requireReason ? c.lowMax : null, minCountToShow: c.minCount },
    };
  }

  /** Customer feedback tags (driver + restaurant apps). */
  customerOptions() {
    return { positive: CUSTOMER_TAGS.positive, negative: CUSTOMER_TAGS.negative, stars: [1, 2, 3, 4, 5] };
  }

  private async ownOrder(customerId: string, orderId: string): Promise<Order> {
    if (!/^[0-9a-f-]{36}$/i.test(orderId)) throw new NotFoundException('Order not found');
    const o = await this.ds.getRepository(Order).findOne({ where: { id: orderId, customerId }, relations: { restaurant: true } });
    if (!o) throw new NotFoundException('Order not found');
    return o;
  }

  private completedAt(o: Order): Date {
    return o.deliveredAt ?? o.updatedAt;
  }

  /** Why this order cannot be reviewed (null = it can). */
  private async blocker(o: Order, now = new Date()): Promise<string | null> {
    if (!DONE.includes(o.status)) return 'You can only review a completed order';
    const until = new Date(this.completedAt(o).getTime() + this.cfg().windowDays * 86400_000);
    if (now > until) return `The rating window (${this.cfg().windowDays} days) has closed for this order`;
    const refunds: { amount: string; reasonCode: string }[] = await this.ds.query(
      `SELECT amount, "reasonCode" FROM refunds WHERE "orderId" = $1 AND status IN ('PROCESSED','APPROVED')`,
      [o.id],
    );
    const total = refunds.reduce((a, r) => a + Number(r.amount), 0);
    if (refunds.some((r) => NON_DELIVERY.test(r.reasonCode)) && total >= Number(o.total) * 0.99) return 'This order was refunded because it was not delivered, so it cannot be rated';
    return null;
  }

  private caps(o: Order) {
    return {
      rateRestaurant: true,
      rateDriver: o.type === 'DELIVERY' && o.fulfilment === FulfilmentMode.PLATFORM_DRIVER && !!o.driverId,
    };
  }

  // ------------------------------------------------------------------ customer reads
  async getReview(customerId: string, orderId: string) {
    const o = await this.ownOrder(customerId, orderId);
    const rv = await this.ds.getRepository(Review).findOne({ where: { orderId } });
    const c = this.cfg();
    const block = rv ? null : await this.blocker(o);
    const editableUntil = rv ? new Date(rv.createdAt.getTime() + c.editHours * 3600_000) : null;
    const canEdit = !!rv && rv.editCount < 1 && !!editableUntil && new Date() <= editableUntil;
    let driver: any = null;
    if (o.driverId && this.caps(o).rateDriver) {
      const [d] = await this.ds.query(`SELECT u."firstName" FROM driver_profiles d JOIN users u ON u.id = d."userId" WHERE d.id = $1`, [o.driverId]);
      driver = d ? { firstName: d.firstName } : null;
    }
    return {
      orderId,
      order: { code: o.code, type: o.type, status: o.status, deliveredAt: this.completedAt(o), restaurant: { id: o.restaurantId, name: o.restaurant?.name }, driver },
      ...this.caps(o),
      review: rv ? this.shapeOwn(rv) : null,
      canReview: !rv && !block,
      canEdit,
      editableUntil,
      reviewableUntil: new Date(this.completedAt(o).getTime() + c.windowDays * 86400_000),
      reason: rv ? (canEdit ? null : rv.editCount >= 1 ? 'You already edited this review' : 'The edit window has closed') : block,
    };
  }

  /** What the author sees: never moderation state or flag reasons. */
  private shapeOwn(rv: Review) {
    return {
      id: rv.id,
      restaurantRating: rv.restaurantRating,
      driverRating: rv.driverRating,
      restaurantTags: rv.restaurantTags,
      driverTags: rv.driverTags,
      comment: rv.comment,
      driverComment: rv.driverComment,
      reply: rv.reply,
      repliedAt: rv.repliedAt,
      editCount: rv.editCount,
      editedAt: rv.editedAt,
      createdAt: rv.createdAt,
    };
  }

  async pending(customerId: string) {
    const c = this.cfg();
    const since = new Date(Date.now() - c.windowDays * 86400_000);
    const rows: any[] = await this.ds.query(
      `SELECT o.id, o.code, o.type, o.fulfilment, o."driverId", o."restaurantId", r.name AS "restaurantName", r."logoUrl" AS "restaurantLogo",
              COALESCE(o."deliveredAt", o."updatedAt") AS "deliveredAt"
       FROM orders o JOIN restaurants r ON r.id = o."restaurantId"
       WHERE o."customerId" = $1 AND o.status IN ('DELIVERED','COLLECTED') AND COALESCE(o."deliveredAt", o."updatedAt") >= $2
         AND NOT EXISTS (SELECT 1 FROM reviews rv WHERE rv."orderId" = o.id)
         AND NOT EXISTS (SELECT 1 FROM refunds f WHERE f."orderId" = o.id AND f.status IN ('PROCESSED','APPROVED') AND f."reasonCode" ~* 'NEVER|NOT_DELIVERED|NOT_RECEIVED|NO_DELIVERY' AND f.amount >= o.total * 0.99)
       ORDER BY 7 DESC LIMIT 20`,
      [customerId, since],
    );
    return {
      windowDays: c.windowDays,
      data: rows.map((r) => ({
        orderId: r.id,
        code: r.code,
        type: r.type,
        restaurant: { id: r.restaurantId, name: r.restaurantName, logoUrl: r.restaurantLogo },
        rateDriver: r.type === 'DELIVERY' && r.fulfilment === FulfilmentMode.PLATFORM_DRIVER && !!r.driverId,
        deliveredAt: r.deliveredAt,
        closesAt: new Date(new Date(r.deliveredAt).getTime() + c.windowDays * 86400_000),
      })),
    };
  }

  // ------------------------------------------------------------------ validation
  private checkTags(side: 'restaurant' | 'driver', rating: number | null | undefined, tags: string[] | undefined, c: ReturnType<RatingsService['cfg']>): string[] {
    const list = tags ?? [];
    if (!list.length) {
      if (rating != null && c.requireReason && rating <= c.lowMax) throw new BadRequestException(`Please pick at least one reason for a ${rating}-star ${side} rating`);
      return [];
    }
    if (rating == null) throw new BadRequestException(`Tags for the ${side} need a ${side} rating`);
    const sets = REVIEW_TAG_SETS[side];
    const out: string[] = [];
    for (const t of list) {
      const code = canonTag(t);
      if (!sets.positive.has(code) && !sets.negative.has(code)) throw new BadRequestException(`Unknown ${side} tag "${String(t).slice(0, 40)}"`);
      if (!out.includes(code)) out.push(code);
    }
    if (c.requireReason && rating <= c.lowMax && !out.some((t) => sets.negative.has(t))) throw new BadRequestException(`Please pick at least one reason for a ${rating}-star ${side} rating`);
    return out;
  }

  private clean(text: string | undefined | null, max: number, label: string): string | null | undefined {
    if (text === undefined) return undefined;
    const t = (text ?? '').trim();
    if (t.length > max) throw new BadRequestException(`${label} must be at most ${max} characters`);
    return t || null;
  }

  // ------------------------------------------------------------------ create / edit
  async create(customerId: string, orderId: string, dto: CreateReviewDto) {
    const o = await this.ownOrder(customerId, orderId);
    const block = await this.blocker(o);
    if (block) throw new BadRequestException(block);
    const repo = this.ds.getRepository(Review);
    if (await repo.exist({ where: { orderId } })) throw new ConflictException('This order already has a review. You can edit it once within the edit window.');
    const caps = this.caps(o);
    if (dto.restaurantRating === undefined && dto.driverRating === undefined) throw new BadRequestException('Provide a restaurant or driver rating');
    if (dto.driverRating !== undefined && !caps.rateDriver) throw new BadRequestException('This order was not delivered by a FORKSY driver, so there is no driver to rate');
    if ((dto.driverTags?.length || dto.driverComment) && dto.driverRating === undefined) throw new BadRequestException('Driver tags and comments need a driver rating');
    if ((dto.restaurantTags?.length || dto.comment) && dto.restaurantRating === undefined) throw new BadRequestException('Restaurant tags and comments need a restaurant rating');
    const c = this.cfg();
    const rt = this.checkTags('restaurant', dto.restaurantRating, dto.restaurantTags, c);
    const dt = this.checkTags('driver', dto.driverRating, dto.driverTags, c);
    const comment = this.clean(dto.comment, c.maxLen, 'Comment') ?? null;
    const driverComment = this.clean(dto.driverComment, c.maxLen, 'Driver comment') ?? null;
    let saved: Review;
    try {
      saved = await repo.save(
        repo.create({
          orderId,
          customerId,
          restaurantId: o.restaurantId,
          driverId: caps.rateDriver ? o.driverId : null,
          restaurantRating: dto.restaurantRating ?? null,
          driverRating: dto.driverRating ?? null,
          restaurantTags: rt,
          driverTags: dt,
          comment,
          driverComment,
          commentHash: commentHashOf(comment, this.settings.get<number>('ratings.fraud.duplicateMinLength', 15)),
          status: 'VISIBLE',
          driverStatus: 'VISIBLE',
        }),
      );
    } catch (e: any) {
      if (e?.code === '23505') throw new ConflictException('This order already has a review.');
      throw e;
    }
    await this.fraud.evaluate(saved);
    this.emitter.emit(Events.REVIEW_CREATED, { reviewId: saved.id, orderId, restaurantId: o.restaurantId, driverId: saved.driverId, restaurantRating: saved.restaurantRating, driverRating: saved.driverRating });
    return this.shapeOwn((await repo.findOne({ where: { id: saved.id } }))!);
  }

  async edit(customerId: string, orderId: string, dto: EditReviewDto) {
    const o = await this.ownOrder(customerId, orderId);
    const repo = this.ds.getRepository(Review);
    const rv = await repo.findOne({ where: { orderId, customerId } });
    if (!rv) throw new NotFoundException('You have not reviewed this order yet');
    const c = this.cfg();
    if (rv.editCount >= 1) throw new BadRequestException('A review can only be edited once');
    if (new Date() > new Date(rv.createdAt.getTime() + c.editHours * 3600_000)) throw new BadRequestException(`The edit window (${c.editHours} hours) has closed`);
    const caps = this.caps(o);
    if (dto.driverRating !== undefined && !caps.rateDriver) throw new BadRequestException('There is no FORKSY driver to rate on this order');
    const has = (k: keyof EditReviewDto) => dto[k] !== undefined;
    if (!Object.keys(dto).length) throw new BadRequestException('Nothing to change');
    const next = {
      restaurantRating: has('restaurantRating') ? dto.restaurantRating! : rv.restaurantRating,
      driverRating: has('driverRating') ? dto.driverRating! : rv.driverRating,
      restaurantTags: has('restaurantTags') || has('restaurantRating') ? dto.restaurantTags ?? (has('restaurantRating') ? [] : rv.restaurantTags) : rv.restaurantTags,
      driverTags: has('driverTags') || has('driverRating') ? dto.driverTags ?? (has('driverRating') ? [] : rv.driverTags) : rv.driverTags,
      comment: has('comment') ? this.clean(dto.comment, c.maxLen, 'Comment') ?? null : rv.comment,
      driverComment: has('driverComment') ? this.clean(dto.driverComment, c.maxLen, 'Driver comment') ?? null : rv.driverComment,
    };
    // keep the old tags when only the rating changes and they still satisfy the rules; otherwise the caller must send tags
    const rt = this.checkTags('restaurant', next.restaurantRating, next.restaurantTags as string[], c);
    const dt = this.checkTags('driver', next.driverRating, next.driverTags as string[], c);
    const prev = { at: new Date().toISOString(), restaurantRating: rv.restaurantRating, driverRating: rv.driverRating, restaurantTags: rv.restaurantTags, driverTags: rv.driverTags, comment: rv.comment, driverComment: rv.driverComment };
    Object.assign(rv, next, {
      restaurantTags: rt,
      driverTags: dt,
      driverId: next.driverRating != null ? o.driverId : rv.driverId,
      commentHash: commentHashOf(next.comment, this.settings.get<number>('ratings.fraud.duplicateMinLength', 15)),
      editCount: rv.editCount + 1,
      editedAt: new Date(),
      history: [...(rv.history ?? []), prev],
    });
    const saved = await repo.save(rv);
    await this.fraud.evaluate(saved);
    this.emitter.emit('review.updated', { reviewId: saved.id, orderId, restaurantId: saved.restaurantId, driverId: saved.driverId });
    return this.shapeOwn((await repo.findOne({ where: { id: saved.id } }))!);
  }
}
