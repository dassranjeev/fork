import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { TicketCategory } from '../common/enums';

export class StartChatDto {
  @IsIn(Object.values(TicketCategory)) topic: string;
  @IsOptional() @IsUUID() orderId?: string;
  @IsString() @IsNotEmpty() @MaxLength(2500) message: string;
  @IsOptional() @IsArray() @ArrayMaxSize(3) attachments?: string[];
}

export class ChatMessageDto {
  @IsOptional() @IsString() @MaxLength(2500) body?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(3) attachments?: string[];
}

export class ChatTypingDto {
  @IsOptional() @IsBoolean() typing?: boolean;
}

export class ChatRateDto {
  @IsInt() @Min(1) @Max(5) rating: number;
  @IsOptional() @IsString() @MaxLength(1000) feedback?: string;
}

export class ChatEndDto {
  @IsOptional() @IsString() @MaxLength(500) note?: string;
  /** agent only: also resolve the ticket in the same step */
  @IsOptional() @IsString() reasonCode?: string;
  @IsOptional() @IsIn(['RESTAURANT', 'PLATFORM', 'DRIVER']) chargedTo?: 'RESTAURANT' | 'PLATFORM' | 'DRIVER';
  @IsOptional() @IsString() @MaxLength(1000) resolution?: string;
}

export class ChatMessagesQueryDto {
  /** message id or ISO timestamp: only newer messages are returned */
  @IsOptional() @IsString() after?: string;
}

export class ChatQueueQueryDto {
  /** comma list of WAITING,ACTIVE,ENDED,MISSED (default WAITING,ACTIVE; ENDED/MISSED are limited to the last 24h) */
  @IsOptional() @IsString() status?: string;
}

export class ChatTransferDto {
  @IsOptional() @IsUUID() agentId?: string;
  @IsOptional() @IsIn(['TIER2', 'FINANCE']) tier?: 'TIER2' | 'FINANCE';
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class ChatPresenceDto {
  @IsIn(['ONLINE', 'AWAY', 'OFFLINE']) status: 'ONLINE' | 'AWAY' | 'OFFLINE';
  @IsOptional() @IsInt() @Min(1) @Max(20) maxConcurrentChats?: number;
}
