import { Type } from 'class-transformer';
import { ArrayNotEmpty, IsArray, IsBoolean, IsEmail, IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

/** Common filters accepted by every analytics endpoint. Dates: YYYY-MM-DD (city local, inclusive) or ISO timestamps. */
export class AnalyticsFilterDto {
  @IsOptional() @IsString() from?: string;
  @IsOptional() @IsString() to?: string;
  @IsOptional() @IsUUID() cityId?: string;
  @IsOptional() @IsUUID() zoneId?: string;
  @IsOptional() @IsUUID() restaurantId?: string;
  @IsOptional() @IsIn(['day', 'week', 'month']) groupBy?: 'day' | 'week' | 'month';

  // table paging / sorting (ranking tables)
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000) limit?: number;
  @IsOptional() @IsString() search?: string;
  @IsOptional() @IsString() sortBy?: string;
  @IsOptional() @IsIn(['ASC', 'DESC', 'asc', 'desc']) sortDir?: string;

  /** customer-growth: number of weekly cohorts in the retention matrix */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(26) cohorts?: number;
  /** export format */
  @IsOptional() @IsIn(['csv', 'xlsx']) format?: string;
}

export class ScheduledReportDto {
  @IsString() name: string;
  @IsString() dashboard: string;
  @IsIn(['DAILY', 'WEEKLY', 'MONTHLY']) frequency: 'DAILY' | 'WEEKLY' | 'MONTHLY';
  @IsArray() @ArrayNotEmpty() @IsEmail({}, { each: true }) recipients: string[];
  @IsOptional() @IsIn(['CSV', 'XLSX']) format?: 'CSV' | 'XLSX';
  /** { cityId?, zoneId?, restaurantId?, groupBy?, range?: 'yesterday'|'last7d'|'last30d'|'lastMonth'|'mtd' } */
  @IsOptional() @IsObject() filters?: Record<string, any>;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class UpdateScheduledReportDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() dashboard?: string;
  @IsOptional() @IsIn(['DAILY', 'WEEKLY', 'MONTHLY']) frequency?: 'DAILY' | 'WEEKLY' | 'MONTHLY';
  @IsOptional() @IsArray() @IsEmail({}, { each: true }) recipients?: string[];
  @IsOptional() @IsIn(['CSV', 'XLSX']) format?: 'CSV' | 'XLSX';
  @IsOptional() @IsObject() filters?: Record<string, any>;
  @IsOptional() @IsBoolean() active?: boolean;
}
