import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Order } from '../database/entities';
import { ActorType, RefundType, TicketCategory, TicketTier } from '../common/enums';
import { SettingsService } from '../settings/settings.service';
import { TicketsService } from './tickets.service';
import { OrderContextService, Suggestion } from './order-context.service';
import { RefundGateway } from './refund-gateway.service';
import { DeliveryDisputesService } from './delivery-disputes.service';
import { AUTO_MESSAGES, CUSTOMER_ISSUE_TYPES, round2 } from './support.constants';

export interface ReportIssueInput {
  orderId: string;
  category: TicketCategory;
  description?: string;
  itemIds?: string[];
  attachments?: string[];
  deviceFingerprint?: string;
}

const AUTO_APPLY_ACTIONS = ['ITEM_REFUND', 'FULL_REFUND', 'DELIVERY_FEE_REFUND_AND_CREDIT', 'PARTIAL_CREDIT'];

/**
 * Self-serve issue reporting with the automatic rule table (spec 9.2/9.3).
 * `OrderContextService.suggest()` holds the rule table itself (missing item / never arrived / very late / food
 * quality / restaurant cancelled); this service decides whether the customer's account is eligible for an
 * automatic decision (good history, device not suspicious, amount under the self-serve ceiling) and, if so,
 * issues the refund/credit via `RefundGateway` and auto-resolves the ticket. Otherwise it routes to Tier 1/2
 * for a human, same as a manually-opened ticket.
 */
@Injectable()
export class SelfServeService {
  constructor(
    private settings: SettingsService,
    private tickets: TicketsService,
    private orderContext: OrderContextService,
    private refundGateway: RefundGateway,
    private disputes: DeliveryDisputesService,
    @InjectRepository(Order) private orders: Repository<Order>,
  ) {}

  private issueType(category: TicketCategory) {
    return CUSTOMER_ISSUE_TYPES.find((t) => t.category === category);
  }

  /** Self-serve auto-credit ceiling by category (spec 9.2: missing item < $15 & good history -> instant credit). */
  private autoCreditCap(category: TicketCategory): number | null {
    if (category === TicketCategory.MISSING_ITEM || category === TicketCategory.WRONG_ITEM) {
      return this.settings.get<number>('support.autoCreditMaxMissingItem', 15);
    }
    if (category === TicketCategory.FOOD_QUALITY) return this.settings.get<number>('support.autoCreditMaxFoodQuality', 8);
    return null;
  }

  async reportIssue(customerId: string, input: ReportIssueInput): Promise<{ ticket: any; auto: boolean; suggestion: Suggestion | null }> {
    const type = this.issueType(input.category);
    if (!type) throw new BadRequestException('Unsupported issue category');
    const order = await this.orders.findOne({ where: { id: input.orderId } });
    if (!order) throw new NotFoundException('Order not found');
    if (order.customerId !== customerId) throw new ForbiddenException('Not your order');

    const history = await this.orderContext.goodHistory(customerId);
    const device = input.deviceFingerprint ? await this.orderContext.deviceCheck(customerId, input.deviceFingerprint) : null;
    const flagged = !history.good || !!device?.suspicious;

    const ticket = await this.tickets.create({
      requesterType: 'CUSTOMER',
      requesterId: customerId,
      subject: `${type.label} - order ${order.code}`,
      body: input.description,
      category: input.category,
      orderId: order.id,
      attachments: input.attachments,
      tier: TicketTier.SELF_SERVE,
      source: 'SELF_SERVE',
      flaggedAccount: flagged,
      meta: {
        itemIds: input.itemIds ?? [],
        deviceFingerprint: input.deviceFingerprint ?? null,
        goodHistory: history.good,
        historyReasons: history.reasons,
        deviceSuspicious: device?.suspicious ?? false,
        deviceReasons: device?.reasons ?? [],
      },
    });

    // Delivery evidence beats the claim: valid proof (PIN / clean in-geofence photo) -> NO auto-refund, Tier 2 with the evidence attached.
    // Missing / weak / flagged proof -> refund path stays and the driver gets a delivery-dispute strike.
    if (input.category === TicketCategory.NEVER_ARRIVED) {
      const d = await this.disputes.onNeverArrivedClaim(order, ticket);
      if (d.validProof) {
        await this.tickets.addMessage(ticket.id, { type: 'SYSTEM' }, { body: AUTO_MESSAGES.en.evidenceReview(order.code) });
        return { ticket: await this.tickets.get(ticket.id), auto: false, suggestion: await this.orderContext.suggest(order.id, input.category, [], ticket.id) };
      }
    }

    // Fraud flag / refund-frequency limit / device mismatch -> routeTier() inside create() already escalated to TIER2.
    if (ticket.tier !== TicketTier.SELF_SERVE) {
      await this.tickets.addMessage(ticket.id, { type: 'SYSTEM' }, { body: AUTO_MESSAGES.en.review(order.code) });
      return { ticket: await this.tickets.get(ticket.id), auto: false, suggestion: null };
    }

    const autoRulesEnabled = await this.settings.isFeatureEnabled('auto_refund_rules');
    const suggestion = await this.orderContext.suggest(order.id, input.category, input.itemIds ?? [], ticket.id);
    const cap = this.autoCreditCap(input.category);
    const withinCap = cap === null || suggestion.totalAmount <= cap;
    const canAutoApply =
      autoRulesEnabled && !flagged && suggestion.autoEligible && suggestion.lines.length > 0 && withinCap && AUTO_APPLY_ACTIONS.includes(suggestion.action);

    if (!canAutoApply) {
      const msg = suggestion.action === 'EVIDENCE_CONTRADICTS' ? AUTO_MESSAGES.en.evidenceReview(order.code) : AUTO_MESSAGES.en.review(order.code);
      await this.tickets.addMessage(ticket.id, { type: 'SYSTEM' }, { body: msg });
      if (suggestion.lines.length && !withinCap) {
        await this.tickets.sysNote(ticket.id, `Suggested amount $${suggestion.totalAmount.toFixed(2)} exceeds the self-serve auto-credit ceiling ($${cap!.toFixed(2)}) - routed to an agent`);
      }
      return { ticket: await this.tickets.get(ticket.id), auto: false, suggestion };
    }

    let total = 0;
    for (const line of suggestion.lines) {
      await this.refundGateway.issue({
        orderId: order.id,
        amount: line.amount,
        type: line.type,
        chargedTo: this.orderContext.chargedToEnum(line.chargedTo),
        reasonCode: line.reasonCode,
        notes: line.note,
        ticketId: ticket.id,
        actor: { type: ActorType.SYSTEM, id: null, staff: false },
        auto: true,
      });
      total = round2(total + line.amount);
    }
    await this.tickets.tickets.update(ticket.id, { refundedTotal: total });

    const money = (n: number) => `$${n.toFixed(2)}`;
    const refundLine = suggestion.lines.find((l) => l.type === RefundType.REFUND);
    const creditLine = suggestion.lines.find((l) => l.type === RefundType.CREDIT);
    let message: string;
    if (refundLine && creditLine) message = AUTO_MESSAGES.en.both(money(refundLine.amount), money(creditLine.amount), order.code, suggestion.summary);
    else if (refundLine) message = AUTO_MESSAGES.en.refund(money(refundLine.amount), order.code, suggestion.summary);
    else message = AUTO_MESSAGES.en.credit(money(creditLine?.amount ?? total), order.code, suggestion.summary);

    const resolved = await this.tickets.resolve(
      ticket.id,
      { type: 'SYSTEM' },
      {
        reasonCode: suggestion.lines[0].reasonCode,
        chargedTo: suggestion.lines[0].chargedTo,
        resolution: suggestion.summary,
        message,
        autoResolved: true,
      },
    );
    return { ticket: resolved, auto: true, suggestion };
  }
}
