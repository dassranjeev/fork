import { Transform, Type } from 'class-transformer';
import { PageQueryDto } from '../common/pagination';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateIf, ValidateNested } from 'class-validator';

// ------------------------------------------------------------------ public chat
export class AssistantConfigQuery {
  @IsOptional() @IsString() @MaxLength(64) botKey?: string;
  @IsOptional() @IsString() @Matches(/^[a-z0-9][a-z0-9-]{0,80}$/, { message: 'restaurantSlug is invalid' }) restaurantSlug?: string;
}

export class AssistantChatDto {
  @IsOptional() @IsString() @MaxLength(64) botKey?: string;
  @IsOptional() @IsString() @Matches(/^[a-z0-9][a-z0-9-]{0,80}$/, { message: 'restaurantSlug is invalid' }) restaurantSlug?: string;
  @IsOptional() @IsUUID() sessionId?: string;
  @IsString() @MinLength(1) @MaxLength(500) message: string;
  /** opaque chip payload previously returned by the bot ("add:<id>", "opt:<id>", "restaurant:<slug>", "checkout", ...) */
  @IsOptional() @IsString() @MaxLength(160) quick?: string;
  /** optional visitor position for "near me" (central bot only); never stored */
  @IsOptional() @Type(() => Number) @IsNumber() @Min(-90) @Max(90) lat?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(-180) @Max(180) lng?: number;
}

export class AssistantHandoffDto {
  @IsUUID() sessionId: string;
  @IsOptional() @IsString() @MaxLength(64) botKey?: string;
}

export class AssistantFeedbackDto {
  @IsUUID() sessionId: string;
  @IsOptional() @IsString() @MaxLength(64) messageId?: string;
  @IsIn(['up', 'down']) rating: 'up' | 'down';
  @IsOptional() @IsString() @MaxLength(500) comment?: string;
}

export class ImportHandoffDto {
  @IsString() @MinLength(20) @MaxLength(128) token: string;
}

// ------------------------------------------------------------------ restaurant / admin configuration
export class FaqDto {
  @IsString() @MinLength(1) @MaxLength(120) q: string;
  @IsString() @MinLength(1) @MaxLength(500) a: string;
}

/**
 * What a RESTAURANT may change (portal PATCH /restaurant/assistant): only its FAQs and the websites allowed to show the bot.
 * The look of the assistant (name, greeting, colour, logo, on/off) is set by FORKSY staff; those fields are rejected here by the
 * global whitelist (forbidNonWhitelisted -> 400).
 */
export class UpdateAssistantDto {
  @IsOptional() @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => FaqDto) faqs?: FaqDto[];
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) @MaxLength(200, { each: true }) allowedOrigins?: string[];
}

/** What FORKSY staff may change (PATCH /admin/restaurants/:id/assistant): everything. */
export class AdminUpdateAssistantDto extends UpdateAssistantDto {
  @IsOptional() @Transform(({ obj }) => obj.enabled) @IsBoolean() enabled?: boolean;
  @IsOptional() @IsString() @MaxLength(40) name?: string;
  @IsOptional() @IsString() @MaxLength(200) greeting?: string;
  /** "#RRGGBB" or null to use the default colour */
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsString() @Matches(/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/, { message: 'color must be a hex colour like #FF6917' }) color?: string | null;
  /** an own-origin upload (POST /uploads): <api>/uploads/<uuid>.(png|jpg|jpeg|webp), or null to fall back to the restaurant logo */
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsString() @MaxLength(300) logoUrl?: string | null;
  @IsOptional() @Transform(({ obj }) => obj.forcedOff) @IsBoolean() forcedOff?: boolean;
}

// ------------------------------------------------------------------ admin console: central bot + restaurant bot list
export class ChipDto {
  @IsString() @MinLength(1) @MaxLength(30) label: string;
  /** search text the chip sends (payload "find:<query>"): letters, digits, space and , . ' - */
  @IsString() @MinLength(1) @MaxLength(60) @Matches(/^[A-Za-z0-9 ,.'-]+$/, { message: "query may only contain letters, digits, spaces and , . ' -" }) query: string;
}

export class CentralUpdateDto {
  @IsOptional() @Transform(({ obj }) => obj.enabled) @IsBoolean() enabled?: boolean;
  @IsOptional() @IsString() @MaxLength(40) name?: string;
  @IsOptional() @IsString() @MaxLength(200) greeting?: string;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsString() @Matches(/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/, { message: 'color must be a hex colour like #FF6917' }) color?: string | null;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsString() @MaxLength(300) logoUrl?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => FaqDto) faqs?: FaqDto[];
  @IsOptional() @IsArray() @ArrayMaxSize(6) @ValidateNested({ each: true }) @Type(() => ChipDto) chips?: ChipDto[];
}

export class AssistantRestaurantsQuery extends PageQueryDto {
  /** active | disabled (switched off by the restaurant's setting) | forced_off (by FORKSY) */
  @IsOptional() @IsIn(['active', 'disabled', 'forced_off']) status?: 'active' | 'disabled' | 'forced_off';
  @IsOptional() @IsIn(['name', 'chats7d', 'handoffs7d', 'lastActivityAt']) declare sortBy?: string;
}
