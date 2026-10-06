import { Type, Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { DropoffMethod, FulfilmentMode, OrderType, PaymentMethod } from '../common/enums';
import { PageQueryDto } from '../common/pagination';

// ------------------------------------------------------------------ profile
export class UpdateProfileDto {
  @IsOptional() @IsString() @MaxLength(80) firstName?: string;
  @IsOptional() @IsString() @MaxLength(80) lastName?: string;
  @IsOptional() @IsIn(['en', 'fr']) language?: string;
  @IsOptional() @IsString() avatarUrl?: string | null;
}

export class SetDietaryDto {
  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) dietaryPreferences?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) allergens?: string[];
}

export class SetConsentsDto {
  @IsOptional() @IsBoolean() marketingEmail?: boolean;
  @IsOptional() @IsBoolean() marketingSms?: boolean;
  @IsOptional() @IsBoolean() push?: boolean;
}

export class SetNotificationPrefsDto {
  @IsOptional() @IsBoolean() orderUpdates?: boolean;
  @IsOptional() @IsBoolean() promotions?: boolean;
  @IsOptional() @IsBoolean() newsletters?: boolean;
  @IsOptional() @IsBoolean() driverMessages?: boolean;
}

export class GuestUpgradeDto {
  @IsString() @MinLength(8) password: string;
  @IsOptional() @IsString() firstName?: string;
  @IsOptional() @IsString() lastName?: string;
  @IsOptional() @IsString() phone?: string;
}

// ------------------------------------------------------------------ addresses
export class AddressDto {
  @IsOptional() @IsString() @MaxLength(40) label?: string;
  @IsString() @IsNotEmpty() line1: string;
  @IsOptional() @IsString() line2?: string | null;
  @IsString() @IsNotEmpty() city: string;
  @IsOptional() @IsString() province?: string;
  @IsString() @IsNotEmpty() postalCode: string;
  @IsOptional() @IsNumber() @Min(-90) @Max(90) lat?: number | null;
  @IsOptional() @IsNumber() @Min(-180) @Max(180) lng?: number | null;
  /** default delivery instructions for the DRIVER at this address (max 300) */
  @IsOptional() @IsString() @MaxLength(300) dropoffNotes?: string | null;
  /** default handoff method at this address */
  @IsOptional() @IsIn(Object.values(DropoffMethod)) dropoffMethod?: DropoffMethod;
  /** default: use a private delivery PIN at this address */
  @IsOptional() @Transform(({ obj }) => obj.usePin) @IsBoolean() usePin?: boolean;
  /** buzzer / gate code (stored encrypted, masked in lists) */
  @IsOptional() @Matches(/^[A-Za-z0-9 #*\-_./]{1,40}$/, { message: 'accessCode: up to 40 letters, digits, space and # * - _ . /' }) accessCode?: string | null;
  @IsOptional() @IsBoolean() isDefault?: boolean;
}

export class UpdateAddressDto {
  @IsOptional() @IsString() @MaxLength(40) label?: string;
  @IsOptional() @IsString() line1?: string;
  @IsOptional() @IsString() line2?: string | null;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsString() province?: string;
  @IsOptional() @IsString() postalCode?: string;
  @IsOptional() @IsNumber() @Min(-90) @Max(90) lat?: number | null;
  @IsOptional() @IsNumber() @Min(-180) @Max(180) lng?: number | null;
  @IsOptional() @IsString() @MaxLength(300) dropoffNotes?: string | null;
  @IsOptional() @IsIn(Object.values(DropoffMethod)) dropoffMethod?: DropoffMethod;
  @IsOptional() @Transform(({ obj }) => obj.usePin) @IsBoolean() usePin?: boolean;
  /** null / empty string clears the saved code */
  @IsOptional() @ValidateIf((_o, v) => v !== null && v !== '') @Matches(/^[A-Za-z0-9 #*\-_./]{1,40}$/, { message: 'accessCode: up to 40 letters, digits, space and # * - _ . /' }) accessCode?: string | null;
  @IsOptional() @IsBoolean() isDefault?: boolean;
}

// ------------------------------------------------------------------ cart
export class CartItemDto {
  @IsUUID() menuItemId: string;
  @IsInt() @Min(1) @Max(50) quantity: number;
  @IsOptional() @IsArray() @IsUUID('all', { each: true }) modifierOptionIds?: string[];
  @IsOptional() @IsString() @MaxLength(300) notes?: string;
}

export class ReplaceCartDto {
  @IsUUID() restaurantId: string;
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CartItemDto)
  items: CartItemDto[];
  @IsOptional() @IsString() promoCode?: string | null;
}

export class AddCartItemDto extends CartItemDto {
  @IsOptional() @IsUUID() restaurantId?: string;
  @IsOptional() @IsBoolean() replaceCart?: boolean;
}

export class UpdateCartItemDto {
  @IsOptional() @IsInt() @Min(0) @Max(50) quantity?: number;
  @IsOptional() @IsArray() @IsUUID('all', { each: true }) modifierOptionIds?: string[];
  @IsOptional() @IsString() @MaxLength(300) notes?: string;
}

export class SetPromoDto {
  @IsOptional() @IsString() code?: string | null;
}

// ------------------------------------------------------------------ checkout
export class CheckoutQuoteDto {
  @IsIn(Object.values(OrderType)) type: OrderType;
  @IsOptional() @IsIn(Object.values(FulfilmentMode)) fulfilment?: FulfilmentMode;
  @IsOptional() @IsUUID() addressId?: string;
  @IsOptional() @IsNumber({ allowNaN: false, allowInfinity: false }) @Min(-90) @Max(90) lat?: number;
  @IsOptional() @IsNumber({ allowNaN: false, allowInfinity: false }) @Min(-180) @Max(180) lng?: number;
  @IsOptional() @IsNumber({ allowNaN: false, allowInfinity: false }) @Min(0) @Max(500) tip?: number;
  @IsOptional() @IsBoolean() useWallet?: boolean;
  @IsOptional() @IsString() @MaxLength(40) promoCode?: string;
  @IsOptional() @IsDateString() scheduledFor?: string;
  /** HAND_TO_ME (default) | LEAVE_AT_DOOR (contactless, photo proof) | MEET_OUTSIDE. Omitted = the chosen address's saved default. */
  @IsOptional() @IsIn(Object.values(DropoffMethod)) dropoffMethod?: DropoffMethod;
  /** Use a private 4-digit delivery PIN (default true). false = no PIN: the driver must photograph the delivered order. Omitted = the address's saved default. */
  @IsOptional() @Transform(({ obj }) => obj.usePin) @IsBoolean() usePin?: boolean;
  /** delivery instructions for the DRIVER, e.g. "Unit 5, use side door, dog in yard" (max 300). NOT the kitchen note. */
  @IsOptional() @IsString() @MaxLength(300) dropoffNotes?: string;
  /** buzzer / gate / door code (max 40, sensitive: shown only to the assigned driver after pickup) */
  @IsOptional() @Matches(/^[A-Za-z0-9 #*\-_./]{1,40}$/, { message: 'accessCode: up to 40 letters, digits, space and # * - _ . /' }) accessCode?: string;
}

export class PlaceOrderDto extends CheckoutQuoteDto {
  @IsIn(Object.values(PaymentMethod)) paymentMethod: PaymentMethod;
  @IsOptional() @IsString() @MaxLength(200) paymentToken?: string;
  @IsOptional() @IsString() @MaxLength(40) giftCardCode?: string;
  @IsOptional() @IsBoolean() contactless?: boolean;
  /** KITCHEN notes: a note for the restaurant (allergies, no onions...). Delivery instructions go in dropoffNotes. */
  @IsOptional() @IsString() @MaxLength(1000) customerNotes?: string;
}

export class UpdateDeliveryInstructionsDto {
  @IsOptional() @IsIn(Object.values(DropoffMethod)) dropoffMethod?: DropoffMethod;
  @IsOptional() @Transform(({ obj }) => obj.usePin) @IsBoolean() usePin?: boolean;
  @IsOptional() @IsString() @MaxLength(300) dropoffNotes?: string | null;
  @IsOptional() @ValidateIf((_o, v) => v !== null && v !== '') @Matches(/^[A-Za-z0-9 #*\-_./]{1,40}$/, { message: 'accessCode: up to 40 letters, digits, space and # * - _ . /' }) accessCode?: string | null;
}

// ------------------------------------------------------------------ orders
export class TipDto {
  @IsNumber({ allowNaN: false, allowInfinity: false }) @Min(0) @Max(500) tip: number;
}

export class ReviewDto {
  @IsOptional() @IsInt() @Min(1) @Max(5) restaurantRating?: number;
  @IsOptional() @IsInt() @Min(1) @Max(5) driverRating?: number;
  @IsOptional() @IsArray() @IsString({ each: true }) restaurantTags?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) driverTags?: string[];
  @IsOptional() @IsString() @MaxLength(1000) comment?: string;
  @IsOptional() @IsString() @MaxLength(1000) driverComment?: string;
}

export class ItemRemovalResponseDto {
  @IsBoolean() approve: boolean;
}

export class CustomerOrdersQuery extends PageQueryDto {
  @IsOptional() @IsString() status?: string;
}

// ------------------------------------------------------------------ privacy (PIPEDA)
export class DataRequestDto {
  @IsIn(['ACCESS', 'CORRECTION', 'CONSENT_WITHDRAWAL']) type: 'ACCESS' | 'CORRECTION' | 'CONSENT_WITHDRAWAL';
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}

export class DeletionRequestDto {
  @IsOptional() @IsString() @MaxLength(1000) reason?: string;
}

// ------------------------------------------------------------------ guest checkout
export class GuestSessionDto {
  @IsEmail() @MaxLength(254) email: string;
  @IsOptional() @IsString() @MaxLength(30) phone?: string;
  @IsOptional() @IsString() @MaxLength(80) firstName?: string;
  @IsOptional() @IsString() @MaxLength(80) lastName?: string;
}

// ------------------------------------------------------------------ admin
export class DataRequestsQuery extends PageQueryDto {
  @IsOptional() @IsString() @MaxLength(30) status?: string;
  @IsOptional() @IsString() @MaxLength(30) type?: string;
}

export class AdminCustomerListQuery extends PageQueryDto {
  @IsOptional() @IsIn(['true', 'false']) blocked?: string;
  @IsOptional() @IsIn(['true', 'false']) fraudFlag?: string;
}

export class WalletAdjustDto {
  /** positive = credit, negative = debit */
  @IsNumber() amount: number;
  @IsString() @IsNotEmpty() @MaxLength(500) reason: string;
}

export class BlockCustomerDto {
  @IsString() @IsNotEmpty() @MaxLength(500) reason: string;
}

export class SetFlagsDto {
  @IsOptional() @IsBoolean() fraudFlag?: boolean;
  @IsOptional() @IsString() @MaxLength(60) addFlag?: string;
  @IsOptional() @IsString() @MaxLength(60) removeFlag?: string;
}

export class SetNotesDto {
  @IsString() @MaxLength(2000) note: string;
}

export class ApproveDataRequestDto {
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}

export class RejectDataRequestDto {
  @IsString() @MaxLength(1000) reason: string;
}
