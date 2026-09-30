import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { DocStatus, DriverDocType, DriverStatus, VehicleType } from '../common/enums';
import { PageQueryDto } from '../common/pagination';

// ------------------------------------------------------------------ admin: drivers
export class DriverListQuery extends PageQueryDto {
  @IsOptional() @IsEnum(DriverStatus) status?: DriverStatus;
  @IsOptional() @IsUUID() cityId?: string;
  @IsOptional() @IsUUID() zoneId?: string;
  @IsOptional() @IsEnum(VehicleType) vehicleType?: VehicleType;
  /** 'true' | 'false' */
  @IsOptional() @IsString() online?: string;
  @IsOptional() @Type(() => Number) @IsNumber() ratingMin?: number;
  @IsOptional() @Type(() => Number) @IsNumber() ratingMax?: number;
  /** documents expiring within N days (or already expired) */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) expiringDays?: number;
  @IsOptional() @IsString() backgroundCheck?: string;
}

export class CreateDriverDto {
  @IsEmail() email: string;
  @IsString() firstName: string;
  @IsString() lastName: string;
  @IsString() phone: string;
  @IsOptional() @IsString() @MinLength(8) password?: string;
  @IsUUID() cityId: string;
  @IsOptional() @IsEnum(VehicleType) vehicleType?: VehicleType;
  @IsOptional() @IsString() vehicleMake?: string;
  @IsOptional() @IsString() vehicleModel?: string;
  @IsOptional() @IsString() vehicleColor?: string;
  @IsOptional() @IsString() licensePlate?: string;
}

export class UpdateDriverDto {
  @IsOptional() @IsString() firstName?: string;
  @IsOptional() @IsString() lastName?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsUUID() cityId?: string;
  @IsOptional() @IsEnum(VehicleType) vehicleType?: VehicleType;
  @IsOptional() @IsString() vehicleMake?: string;
  @IsOptional() @IsString() vehicleModel?: string;
  @IsOptional() @IsString() vehicleColor?: string;
  @IsOptional() @IsString() licensePlate?: string;
  @IsOptional() @IsIn(['WEEKLY', 'INSTANT']) payoutSchedule?: 'WEEKLY' | 'INSTANT';
  @IsOptional() @IsBoolean() insulatedBagConfirmed?: boolean;
  @IsOptional() @IsString() notes?: string;
}

export class ReviewDocumentDto {
  @IsIn([DocStatus.APPROVED, DocStatus.REJECTED]) status: DocStatus.APPROVED | DocStatus.REJECTED;
  /** required when rejecting (e.g. "Blurry image", "Document expired") */
  @IsOptional() @IsString() rejectReason?: string;
  /** YYYY-MM-DD; required to approve licence / insurance / registration */
  @IsOptional() @IsDateString() expiresAt?: string;
}

export class InsuranceDto {
  @IsBoolean() coversDelivery: boolean;
  @IsDateString() expiresAt: string;
  @IsOptional() @IsString() provider?: string;
  @IsOptional() @IsString() policyNumber?: string;
}

export class BackgroundOverrideDto {
  @IsIn(['CLEAR', 'CONSIDER', 'FAILED']) status: 'CLEAR' | 'CONSIDER' | 'FAILED';
  @IsString() @MinLength(3) note: string;
}

export class ApproveDto {
  /** approve and activate in one step when zoneIds are supplied */
  @IsOptional() @IsArray() @IsUUID('all', { each: true }) zoneIds?: string[];
  @IsOptional() @IsBoolean() insulatedBagConfirmed?: boolean;
  @IsOptional() @IsString() note?: string;
  /** bypass checklist gates (Super Admin / audit-logged) */
  @IsOptional() @IsBoolean() override?: boolean;
}

export class ActivateDto {
  @IsArray() @ArrayMaxSize(50) @IsUUID('all', { each: true }) zoneIds: string[];
  @IsBoolean() insulatedBagConfirmed: boolean;
}

export class ReasonDto {
  @IsString() @MinLength(3) reason: string;
  /** deactivation / suspension: days the driver has to respond (default setting driver.deactivationResponseDays) */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(60) respondWithinDays?: number;
  @IsOptional() @IsString() evidence?: string;
}

export class OptionalReasonDto {
  @IsOptional() @IsString() reason?: string;
}

export class ZonesDto {
  @IsArray() @ArrayMaxSize(50) @IsUUID('all', { each: true }) zoneIds: string[];
}

// ------------------------------------------------------------------ admin: incentives / shifts / training / sos
export class IncentiveListQuery extends PageQueryDto {
  @IsOptional() @IsUUID() zoneId?: string;
  @IsOptional() @IsUUID() cityId?: string;
  @IsOptional() @IsUUID() driverId?: string;
  @IsOptional() @IsIn(['PEAK_BOOST', 'QUEST', 'FIRST_WEEK', 'WEATHER', 'SUPPLY_ALERT']) type?: string;
  /** 'true' | 'false' */
  @IsOptional() @IsString() active?: string;
}

export class IncentiveDto {
  @IsString() name: string;
  @IsOptional() @IsString() description?: string;
  @IsIn(['PEAK_BOOST', 'QUEST', 'FIRST_WEEK', 'WEATHER', 'SUPPLY_ALERT']) type: 'PEAK_BOOST' | 'QUEST' | 'FIRST_WEEK' | 'WEATHER' | 'SUPPLY_ALERT';
  @IsOptional() @IsUUID() zoneId?: string | null;
  @IsOptional() @IsUUID() cityId?: string | null;
  @IsOptional() @IsUUID() driverId?: string | null;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) amountPerTrip?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) percentBoost?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) questTrips?: number | null;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) bonusAmount?: number;
  @IsDateString() startsAt: string;
  @IsDateString() endsAt: string;
  @IsOptional() @IsArray() daysOfWeek?: number[];
  @IsOptional() @IsString() startTime?: string | null;
  @IsOptional() @IsString() endTime?: string | null;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class UpdateIncentiveDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsUUID() zoneId?: string | null;
  @IsOptional() @IsUUID() cityId?: string | null;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) amountPerTrip?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) percentBoost?: number;
  @IsOptional() @Type(() => Number) @IsInt() questTrips?: number | null;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) bonusAmount?: number;
  @IsOptional() @IsDateString() startsAt?: string;
  @IsOptional() @IsDateString() endsAt?: string;
  @IsOptional() @IsArray() daysOfWeek?: number[];
  @IsOptional() @IsString() startTime?: string | null;
  @IsOptional() @IsString() endTime?: string | null;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class SupplyAlertDto {
  @IsUUID() zoneId: string;
  /** $ per trip boost while the alert is live */
  @Type(() => Number) @IsNumber() @Min(0) boostAmount: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(5) @Max(720) durationMinutes?: number;
  @IsOptional() @IsString() message?: string;
  /** also push to drivers that are currently online (default true) */
  @IsOptional() @IsBoolean() includeOnline?: boolean;
}

export class ShiftSlotDto {
  @IsUUID() zoneId: string;
  @IsDateString() startsAt: string;
  @IsDateString() endsAt: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(500) capacity: number;
}

export class UpdateSlotDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) capacity?: number;
  @IsOptional() @IsDateString() startsAt?: string;
  @IsOptional() @IsDateString() endsAt?: string;
}

export class ShiftListQuery extends PageQueryDto {
  @IsOptional() @IsUUID() zoneId?: string;
  @IsOptional() @IsUUID() driverId?: string;
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
}

export class QuizQuestionDto {
  @IsString() question: string;
  @IsArray() @IsString({ each: true }) options: string[];
  @Type(() => Number) @IsInt() @Min(0) correctIndex: number;
}

export class TrainingModuleDto {
  @IsString() title: string;
  @IsString() content: string;
  @IsOptional() @Type(() => Number) @IsInt() sortOrder?: number;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => QuizQuestionDto) quiz?: QuizQuestionDto[];
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) @Max(100) passMark?: number;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class UpdateTrainingModuleDto {
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsString() content?: string;
  @IsOptional() @Type(() => Number) @IsInt() sortOrder?: number;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => QuizQuestionDto) quiz?: QuizQuestionDto[];
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) @Max(100) passMark?: number;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class SosListQuery extends PageQueryDto {
  @IsOptional() @IsIn(['OPEN', 'ACKNOWLEDGED', 'RESOLVED']) status?: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED';
  @IsOptional() @IsUUID() driverId?: string;
}

export class SosActionDto {
  @IsOptional() @IsString() note?: string;
}

export class AnalyticsQuery {
  @IsOptional() @IsUUID() cityId?: string;
  @IsOptional() @IsUUID() zoneId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(365) days?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

export class ExpiringDocsQuery extends PageQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) days?: number;
  @IsOptional() @IsEnum(DriverDocType) type?: DriverDocType;
}

// ------------------------------------------------------------------ driver app
export class UpdateProfileDto {
  @IsOptional() @IsString() firstName?: string;
  @IsOptional() @IsString() lastName?: string;
  @IsOptional() @IsString() language?: string;
  @IsOptional() @IsString() avatarUrl?: string;
  @IsOptional() @IsEnum(VehicleType) vehicleType?: VehicleType;
  @IsOptional() @IsString() vehicleMake?: string;
  @IsOptional() @IsString() vehicleModel?: string;
  @IsOptional() @IsString() vehicleColor?: string;
  @IsOptional() @IsString() licensePlate?: string;
  @IsOptional() @IsIn(['WEEKLY', 'INSTANT']) payoutSchedule?: 'WEEKLY' | 'INSTANT';
}

export class UploadDocumentDto {
  @IsEnum(DriverDocType) type: DriverDocType;
  @IsString() fileUrl: string;
  @IsOptional() @IsString() fileName?: string;
  /** YYYY-MM-DD as printed on the document (ops verifies it during review) */
  @IsOptional() @IsDateString() expiresAt?: string;
}

export class ReplaceDocumentDto {
  @IsString() fileUrl: string;
  @IsOptional() @IsString() fileName?: string;
  @IsOptional() @IsDateString() expiresAt?: string;
}

export class BankDto {
  @IsOptional() @IsString() institution?: string;
  @IsOptional() @IsString() transit?: string;
  /** full number is never stored - only the last 4 digits are kept */
  @IsOptional() @IsString() accountNumber?: string;
  @IsOptional() @IsString() holder?: string;
  @IsOptional() @IsString() debitCardLast4?: string;
}

export class TaxInfoDto {
  /** SIN: only the last 3 digits are stored */
  @IsString() sin: string;
  @IsString() legalName: string;
  @IsString() address: string;
}

export class QuizSubmitDto {
  @IsArray() @IsInt({ each: true }) answers: number[];
}

export class GoOnlineDto {
  @IsOptional() @IsUUID() zoneId?: string;
  @IsOptional() @Type(() => Number) @IsNumber() lat?: number;
  @IsOptional() @Type(() => Number) @IsNumber() lng?: number;
}

export class DriverZonesDto {
  @IsArray() @ArrayMaxSize(20) @IsUUID('all', { each: true }) zoneIds: string[];
}

export class LocationDto {
  @Type(() => Number) @IsNumber() @Min(-90) @Max(90) lat: number;
  @Type(() => Number) @IsNumber() @Min(-180) @Max(180) lng: number;
  @IsOptional() @Type(() => Number) @IsNumber() heading?: number;
  @IsOptional() @Type(() => Number) @IsNumber() speed?: number;
  @IsOptional() @IsUUID() orderId?: string;
}

export class DeclineOfferDto {
  @IsOptional() @IsString() reason?: string;
}

export class StepDto {
  @IsOptional() @Type(() => Number) @IsNumber() lat?: number;
  @IsOptional() @Type(() => Number) @IsNumber() lng?: number;
}

export class PickupDto extends StepDto {
  /** order code the restaurant shows / reads out */
  @IsString() code: string;
}

export class DeliverDto extends StepDto {
  @IsOptional() @IsString() proofPhotoUrl?: string;
  /** customer PIN for high-value orders */
  @IsOptional() @IsString() pin?: string;
  @IsOptional() @IsString() note?: string;
}

export class CallDto {
  @IsIn(['CUSTOMER', 'RESTAURANT']) party: 'CUSTOMER' | 'RESTAURANT';
}

export class SosDto {
  @IsOptional() @IsUUID() orderId?: string;
  @IsOptional() @Type(() => Number) @IsNumber() lat?: number;
  @IsOptional() @Type(() => Number) @IsNumber() lng?: number;
  @IsOptional() @IsString() message?: string;
}

export class TripQuery extends PageQueryDto {
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
}

export class AvailableShiftsQuery {
  @IsOptional() @IsUUID() zoneId?: string;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
}
