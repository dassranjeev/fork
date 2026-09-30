import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsEnum, IsNumber, IsOptional, IsString, MinLength } from 'class-validator';
import { PartyType } from '../common/enums';

export class GenerateBatchDto {
  /** YYYY-MM-DD, both required together. Omit to use the previous Mon..Sun week. */
  @IsOptional()
  @IsString()
  periodStart?: string;

  @IsOptional()
  @IsString()
  periodEnd?: string;
}

export class ResolveGapDto {
  @IsString()
  @MinLength(3)
  notes: string;
}

export class PayoutAdjustDto {
  @Type(() => Number)
  @IsNumber()
  amount: number;

  @IsString()
  @MinLength(3)
  reason: string;
}

export class ManualAdjustmentDto {
  @IsEnum(PartyType)
  partyType: PartyType;

  @IsString()
  partyId: string;

  @Type(() => Number)
  @IsNumber()
  amount: number;

  @IsString()
  @MinLength(3)
  reason: string;

  @IsOptional()
  @IsString()
  restaurantId?: string;
}

export class HoldDto {
  @IsOptional()
  @IsString()
  reason?: string;
}

export class VoidInvoiceDto {
  @IsString()
  @MinLength(3)
  reason: string;
}

export class RefundDecisionDto {
  @IsOptional()
  @IsString()
  notes?: string;
}

export class BankDetailsDto {
  @IsOptional()
  @IsString()
  institution?: string;

  @IsOptional()
  @IsString()
  transit?: string;

  @IsOptional()
  @IsString()
  accountNumber?: string;

  @IsOptional()
  @IsString()
  holder?: string;

  @IsOptional()
  @IsString()
  debitCardLast4?: string;
}

export class BankVerifyConfirmDto {
  @IsArray()
  @ArrayMinSize(2)
  @Type(() => Number)
  @IsNumber({}, { each: true })
  amounts: number[];
}

export class ReleaseBatchDto {
  @IsOptional()
  @IsString()
  note?: string;
}
