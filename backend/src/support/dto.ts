import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  ArrayMaxSize,
  MaxLength,
  Min,
} from 'class-validator';
import { CaseDecision, CaseTrigger, TicketCategory, TicketTier } from '../common/enums';
import { PageQueryDto } from '../common/pagination';

const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];
const CHARGED_TO = ['RESTAURANT', 'PLATFORM', 'DRIVER'];

// ------------------------------------------------------------------ queue / list
export class TicketQueueDto extends PageQueryDto {
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsString() tier?: string;
  @IsOptional() @IsString() priority?: string;
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsString() assignee?: string;
  @IsOptional() @IsString() slaBreached?: string;
  @IsOptional() @IsString() requesterType?: string;
  @IsOptional() @IsString() requesterId?: string;
  @IsOptional() @IsString() orderId?: string;
  @IsOptional() @IsString() orderCode?: string;
  @IsOptional() @IsString() restaurantId?: string;
  @IsOptional() @IsString() tag?: string;
  @IsOptional() @IsString() source?: string;
  @IsOptional() @IsString() from?: string;
  @IsOptional() @IsString() to?: string;
  @IsOptional() @IsString() open?: string;
}

export class RequesterTicketQueryDto extends PageQueryDto {
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsString() open?: string;
}

// ------------------------------------------------------------------ tickets
export class CreateTicketDto {
  @IsOptional() @IsUUID() orderId?: string;
  @IsOptional() @IsUUID() restaurantId?: string;
  @IsNotEmpty() @IsString() @MaxLength(200) subject: string;
  @IsOptional() @IsString() @MaxLength(4000) body?: string;
  @IsOptional() @IsIn(Object.values(TicketCategory)) category?: TicketCategory;
  @IsOptional() @IsArray() @ArrayMaxSize(5) @IsString({ each: true }) @MaxLength(500, { each: true }) attachments?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) @MaxLength(40, { each: true }) tags?: string[];
}

export class TicketMessageDto {
  @IsNotEmpty() @IsString() @MaxLength(4000) body: string;
  @IsOptional() @IsBoolean() internal?: boolean;
  @IsOptional() @IsArray() @ArrayMaxSize(5) @IsString({ each: true }) @MaxLength(500, { each: true }) attachments?: string[];
}

export class AssignTicketDto {
  @IsOptional() @IsUUID() assigneeId?: string | null;
}

export class EscalateTicketDto {
  @IsNotEmpty() @IsString() reason: string;
  @IsOptional() @IsIn(Object.values(TicketTier)) tier?: TicketTier;
}

export class ResolveTicketDto {
  @IsNotEmpty() @IsString() reasonCode: string;
  @IsIn(CHARGED_TO) chargedTo: 'RESTAURANT' | 'PLATFORM' | 'DRIVER';
  @IsOptional() @IsString() resolution?: string;
  @IsOptional() @IsString() message?: string;
}

export class CloseTicketDto {
  @IsOptional() @IsString() note?: string;
}

export class ReopenTicketDto {
  @IsOptional() @IsString() reason?: string;
}

export class SetStatusDto {
  @IsIn(['OPEN', 'PENDING']) status: 'OPEN' | 'PENDING';
}

export class UpdateTicketDto {
  @IsOptional() @IsString() @MaxLength(200) subject?: string;
  @IsOptional() @IsIn(Object.values(TicketCategory)) category?: TicketCategory;
  @IsOptional() @IsArray() tags?: string[];
  @IsOptional() @IsIn(PRIORITIES) priority?: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
  @IsOptional() @IsArray() addAttachments?: string[];
}

export class CsatDto {
  @IsInt() @Min(1) @Max(5) csat: number;
  @IsOptional() @IsString() comment?: string;
}

export class ConfirmTicketDto {
  @IsOptional() @IsInt() @Min(1) @Max(5) csat?: number;
  @IsOptional() @IsString() comment?: string;
}

export class RefundFromTicketDto {
  @IsNumber() @Min(0.01) amount: number;
  @IsIn(CHARGED_TO) chargedTo: 'RESTAURANT' | 'PLATFORM' | 'DRIVER';
  @IsNotEmpty() @IsString() reasonCode: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsIn(['REFUND', 'CREDIT']) type?: 'REFUND' | 'CREDIT';
}

export class ApproveRefundDto {
  @IsOptional() @IsString() notes?: string;
}

export class RejectRefundDto {
  @IsOptional() @IsString() reason?: string;
}

// ------------------------------------------------------------------ self-serve
export class ReportIssueDto {
  @IsUUID() orderId: string;
  @IsIn(Object.values(TicketCategory)) category: TicketCategory;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsUUID('all', { each: true }) itemIds?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(5) @IsString({ each: true }) @MaxLength(500, { each: true }) attachments?: string[];
  @IsOptional() @IsString() @MaxLength(200) deviceFingerprint?: string;
}

// ------------------------------------------------------------------ canned replies
export class UpdateCannedReplyDto {
  @IsOptional() @IsString() @MaxLength(120) title?: string;
  @IsOptional() @IsString() @MaxLength(4000) body?: string;
  @IsOptional() @IsIn(Object.values(TicketCategory)) category?: TicketCategory;
  @IsOptional() @IsIn(['ANY', 'CUSTOMER', 'RESTAURANT', 'DRIVER']) audience?: string;
  @IsOptional() @IsString() @MaxLength(40) shortcut?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class CannedReplyDto {
  @IsNotEmpty() @IsString() @MaxLength(120) title: string;
  @IsNotEmpty() @IsString() @MaxLength(4000) body: string;
  @IsOptional() @IsIn(Object.values(TicketCategory)) category?: TicketCategory;
  @IsOptional() @IsIn(['ANY', 'CUSTOMER', 'RESTAURANT', 'DRIVER']) audience?: string;
  @IsOptional() @IsString() shortcut?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

// ------------------------------------------------------------------ SOP-08 review cases
export class OpenReviewCaseDto {
  @IsIn(['DRIVER', 'RESTAURANT']) subjectType: 'DRIVER' | 'RESTAURANT';
  @IsUUID() subjectId: string;
  @IsIn(Object.values(CaseTrigger)) trigger: CaseTrigger;
  @IsNotEmpty() @IsString() details: string;
}

export class SendNoticeDto {
  @IsNotEmpty() @IsString() noticeBody: string;
  @IsOptional() @IsInt() @Min(1) responseDays?: number;
}

export class RespondCaseDto {
  @IsNotEmpty() @IsString() response: string;
}

export class AddEvidenceDto {
  @IsIn(['NOTE', 'PHOTO', 'RATING', 'DOCUMENT', 'ORDER', 'TICKET']) type: string;
  @IsOptional() @IsString() ref?: string;
  @IsOptional() @IsString() url?: string;
  @IsNotEmpty() @IsString() note: string;
}

export class DecideCaseDto {
  @IsIn(Object.values(CaseDecision)) decision: CaseDecision;
  @IsOptional() @IsString() notes?: string;
}

export class AppealRequestDto {
  @IsOptional() @IsString() notes?: string;
}

export class AppealDecisionDto {
  @IsIn(['UPHELD', 'OVERTURNED']) result: 'UPHELD' | 'OVERTURNED';
  @IsOptional() @IsString() notes?: string;
}

export class FinalPayoutDto {
  @IsNumber() @Min(0) amount: number;
}

export class CannedReplyQueryDto extends PageQueryDto {
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsString() audience?: string;
}

export class ReviewCaseQueryDto extends PageQueryDto {
  @IsOptional() @IsString() subjectType?: string;
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsString() decision?: string;
}
