import { BadRequestException } from '@nestjs/common';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { FundedBy, OrderType, PromoType } from '../common/enums';
import { PageQueryDto } from '../common/pagination';
import { Promotion } from '../database/entities';

export class PromotionDto {
  /** optional; upper-cased. Omit for auto-apply deals. */
  @IsOptional() @IsString() @MaxLength(40) code?: string | null;
  @IsString() @MaxLength(120) name: string;
  @IsOptional() @IsString() description?: string | null;
  @IsEnum(PromoType) type: PromoType;
  /** PERCENT: 0-100, FIXED: dollars. Ignored for FREE_DELIVERY / BOGO / FREE_ITEM. */
  @IsOptional() @IsNumber() @Min(0) value?: number;
  @IsOptional() @IsNumber() @Min(0) maxDiscount?: number | null;
  @IsOptional() @IsNumber() @Min(0) minSubtotal?: number;
  @IsOptional() @IsEnum(FundedBy) fundedBy?: FundedBy;
  @IsOptional() @IsUUID() restaurantId?: string | null;
  @IsOptional() @IsUUID() cityId?: string | null;
  @IsOptional() @IsArray() @IsUUID('all', { each: true }) zoneIds?: string[];
  @IsOptional() @IsUUID() menuItemId?: string | null;
  @IsOptional() @IsArray() @IsIn([OrderType.DELIVERY, OrderType.PICKUP], { each: true }) orderTypes?: string[];
  @IsOptional() @IsDateString() startsAt?: string | null;
  @IsOptional() @IsDateString() endsAt?: string | null;
  @IsOptional() @IsInt() @Min(1) usageLimit?: number | null;
  /** 0 = unlimited per customer */
  @IsOptional() @IsInt() @Min(0) perUserLimit?: number;
  @IsOptional() @IsBoolean() firstOrderOnly?: boolean;
  @IsOptional() @IsBoolean() autoApply?: boolean;
  @IsOptional() @IsBoolean() active?: boolean;
  /** 0 = unlimited */
  @IsOptional() @IsNumber() @Min(0) budget?: number;
}

export class UpdatePromotionDto {
  @IsOptional() @IsString() @MaxLength(40) code?: string | null;
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsString() description?: string | null;
  @IsOptional() @IsEnum(PromoType) type?: PromoType;
  @IsOptional() @IsNumber() @Min(0) value?: number;
  @IsOptional() @IsNumber() @Min(0) maxDiscount?: number | null;
  @IsOptional() @IsNumber() @Min(0) minSubtotal?: number;
  @IsOptional() @IsEnum(FundedBy) fundedBy?: FundedBy;
  @IsOptional() @IsUUID() restaurantId?: string | null;
  @IsOptional() @IsUUID() cityId?: string | null;
  @IsOptional() @IsArray() @IsUUID('all', { each: true }) zoneIds?: string[];
  @IsOptional() @IsUUID() menuItemId?: string | null;
  @IsOptional() @IsArray() @IsIn([OrderType.DELIVERY, OrderType.PICKUP], { each: true }) orderTypes?: string[];
  @IsOptional() @IsDateString() startsAt?: string | null;
  @IsOptional() @IsDateString() endsAt?: string | null;
  @IsOptional() @IsInt() @Min(1) usageLimit?: number | null;
  @IsOptional() @IsInt() @Min(0) perUserLimit?: number;
  @IsOptional() @IsBoolean() firstOrderOnly?: boolean;
  @IsOptional() @IsBoolean() autoApply?: boolean;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsNumber() @Min(0) budget?: number;
}

export class BatchPromotionDto extends PromotionDto {
  /** code prefix, e.g. SPRING -> SPRING-7K2QX9 */
  @IsString() @MaxLength(20) prefix: string;
  @IsInt() @Min(1) @Max(1000) count: number;
}

export class RejectDto {
  @IsString() @MaxLength(500) reason: string;
}

export class PromotionQuery extends PageQueryDto {
  /** ACTIVE | INACTIVE | SCHEDULED | EXPIRED | PENDING_APPROVAL */
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsEnum(PromoType) type?: PromoType;
  @IsOptional() @IsEnum(FundedBy) fundedBy?: FundedBy;
  @IsOptional() @IsUUID() restaurantId?: string;
  @IsOptional() @IsString() batchId?: string;
  /** true = only promos that have a code, false = only auto-apply deals */
  @IsOptional() @IsString() hasCode?: string;
}

export class RedemptionQuery extends PageQueryDto {
  @IsOptional() @IsUUID() promotionId?: string;
}

/** Self-serve promo created by a restaurant (spec 4.7). */
export class RestaurantPromotionDto {
  /** only when the user manages several locations */
  @IsOptional() @IsUUID() restaurantId?: string;
  @IsString() @MaxLength(120) name: string;
  @IsOptional() @IsString() description?: string | null;
  @IsIn([PromoType.PERCENT, PromoType.BOGO, PromoType.FREE_ITEM, PromoType.FREE_DELIVERY]) type: PromoType;
  /** PERCENT only (1-100) */
  @IsOptional() @IsNumber() @Min(0) value?: number;
  @IsOptional() @IsNumber() @Min(0) maxDiscount?: number | null;
  @IsOptional() @IsNumber() @Min(0) minSubtotal?: number;
  /** required for FREE_ITEM, optional for BOGO */
  @IsOptional() @IsUUID() menuItemId?: string | null;
  @IsOptional() @IsArray() @IsIn([OrderType.DELIVERY, OrderType.PICKUP], { each: true }) orderTypes?: string[];
  @IsOptional() @IsDateString() startsAt?: string | null;
  @IsOptional() @IsDateString() endsAt?: string | null;
  @IsOptional() @IsInt() @Min(1) usageLimit?: number | null;
  @IsOptional() @IsInt() @Min(0) perUserLimit?: number;
  @IsOptional() @IsNumber() @Min(0) budget?: number;
  /** optional promo code; without a code the deal auto-applies for every customer */
  @IsOptional() @IsString() @MaxLength(40) code?: string | null;
}

export class RestaurantPromotionQuery extends PageQueryDto {
  @IsOptional() @IsUUID() restaurantId?: string;
  @IsOptional() @IsString() status?: string;
}

/** Validate cross-field rules and normalise a promotion payload. Throws BadRequest. */
export function validatePromotionFields(p: Partial<Promotion> & { type: PromoType }) {
  if (p.type === PromoType.PERCENT) {
    if (!(p.value! > 0 && p.value! <= 100)) throw new BadRequestException('Percent promotions need a value between 0 and 100');
  } else if (p.type === PromoType.FIXED) {
    if (!(p.value! > 0)) throw new BadRequestException('Fixed promotions need a value greater than 0');
  } else if (p.type === PromoType.FREE_ITEM) {
    if (!p.menuItemId) throw new BadRequestException('Free item promotions need a menuItemId');
  }
  if (p.startsAt && p.endsAt && p.endsAt <= p.startsAt) throw new BadRequestException('endsAt must be after startsAt');
  if (p.fundedBy === FundedBy.RESTAURANT && !p.restaurantId) {
    throw new BadRequestException('Restaurant-funded promotions must be linked to a restaurant');
  }
}

export const normCode = (c?: string | null) => {
  const v = c?.trim().toUpperCase().replace(/\s+/g, '');
  return v ? v : null;
};

export const toDate = (v?: string | null) => (v ? new Date(v) : null);
