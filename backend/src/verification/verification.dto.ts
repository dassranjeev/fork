import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsEnum, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { PageQueryDto } from '../common/pagination';
import { VerificationAudience, VerificationMethod, VerificationStatus } from '../common/enums';
import { FORCE_MAX_GRACE_DAYS, FORCE_MAX_IDS } from './verification-policy';

const CHOICES = [VerificationMethod.MANUAL, VerificationMethod.AUTOMATIC];

/**
 * The global validation pipe converts values to the declared type (`enableImplicitConversion`), so the string "false" becomes the boolean
 * true. These switches change who may work on the platform, so keep the raw value and let @IsBoolean() refuse anything but true / false.
 */
const StrictBoolean = () => Transform(({ obj, key }) => obj[key]);

/** The policy of one audience. Send only what changes. */
export class AudiencePolicyDto {
  /** Instant registration: a new account is active at once, with no verification step (recorded as unverified). */
  @IsOptional() @StrictBoolean() @IsBoolean() instant?: boolean;
  /** MANUAL = staff review (documents, SOP-01 / SOP-02). AUTOMATIC = Certn identity and criminal-record check. */
  @IsOptional() @IsIn(CHOICES) method?: VerificationMethod.MANUAL | VerificationMethod.AUTOMATIC;
}

export class UpdatePolicyDto {
  @IsOptional() @ValidateNested() @Type(() => AudiencePolicyDto) drivers?: AudiencePolicyDto;
  @IsOptional() @ValidateNested() @Type(() => AudiencePolicyDto) businesses?: AudiencePolicyDto;
}

/** Force verification: put UNVERIFIED accounts through the enabled verification method. Send `ids` OR `all: true`. */
export class ForceVerificationDto {
  @IsEnum(VerificationAudience) audience: VerificationAudience;
  /** driver profile ids (drivers) or merchant ids (businesses) */
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(FORCE_MAX_IDS) @IsUUID('all', { each: true }) ids?: string[];
  /** every unverified account of the audience */
  @IsOptional() @StrictBoolean() @IsBoolean() all?: boolean;
  /** days the accounts keep working while they verify; 0 (default) = they are taken off the road at once until verified */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(FORCE_MAX_GRACE_DAYS) graceDays?: number;
  /** default: the verification method of the policy */
  @IsOptional() @IsIn(CHOICES) method?: VerificationMethod.MANUAL | VerificationMethod.AUTOMATIC;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class VerifyDto {
  @IsOptional() @IsString() @MaxLength(500) note?: string;
  /** Super Admin only: verify even though the checklist is incomplete (a note is then required). */
  @IsOptional() @StrictBoolean() @IsBoolean() override?: boolean;
}

export class RejectVerificationDto {
  @IsString() @MinLength(3) @MaxLength(500) reason: string;
}

export class SubjectsQuery extends PageQueryDto {
  @IsEnum(VerificationAudience) audience: VerificationAudience;
  @IsOptional() @IsEnum(VerificationStatus) status?: VerificationStatus;
}
