import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { PageQueryDto } from '../common/pagination';

const stars = () => [IsInt(), Min(1), Max(5)];
const apply = (...d: PropertyDecorator[]) => (t: any, k: string) => d.forEach((x) => x(t, k));

/** POST /customer/orders/:id/review */
export class CreateReviewDto {
  @IsOptional() @apply(...stars()) restaurantRating?: number;
  @IsOptional() @apply(...stars()) driverRating?: number;
  @IsOptional() @IsArray() @ArrayMaxSize(6) @IsString({ each: true }) @MaxLength(40, { each: true }) restaurantTags?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(6) @IsString({ each: true }) @MaxLength(40, { each: true }) driverTags?: string[];
  /** length is further limited by setting ratings.commentMaxLength */
  @IsOptional() @IsString() @MaxLength(2000) comment?: string;
  @IsOptional() @IsString() @MaxLength(2000) driverComment?: string;
}

/** PATCH /customer/orders/:id/review (same fields, all optional; the edit is allowed once) */
export class EditReviewDto extends CreateReviewDto {}

/** POST /driver/trip/:orderId/rate-customer and POST /restaurant/orders/:id/rate-customer */
export class RateCustomerDto {
  @apply(...stars()) rating: number;
  @IsOptional() @IsArray() @ArrayMaxSize(8) @IsString({ each: true }) @MaxLength(40, { each: true }) tags?: string[];
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

/** POST /admin/ratings/reviews/:id/moderate and POST /admin/restaurants/reviews/:id/moderate */
export class ModerateReviewActionDto {
  @IsIn(['HIDE', 'FLAG', 'RESTORE']) action: 'HIDE' | 'FLAG' | 'RESTORE';
  @IsString() @MinLength(3) @MaxLength(500) reason: string;
}

/** POST /restaurant/reviews/:id/report */
export class ReportReviewDto {
  @IsString() @MinLength(5) @MaxLength(500) reason: string;
}

export class AdminReviewsQuery extends PageQueryDto {
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsString() side?: string;
}

export class RatingWindowQuery {
  @IsOptional() @IsString() restaurantId?: string;
  @IsOptional() @IsString() weeks?: string;
}
