import { Injectable } from '@nestjs/common';
import { AuthUser } from '../common/auth.types';
import { AnalyticsFilterDto } from './analytics.dto';
import { AnalyticsBase } from './analytics.base';
import { GrowthService } from './growth.service';
import { Ctx, Params, WHERE, hasIssue, pct, r2, rangeConds, scopeConds } from './analytics.util';

export interface PilotKpi {
  key: string;
  label: string;
  value: number | null;
  unit: '%' | 'min' | '$';
  target: number;
  targetOp: '<=' | '>=' | '>';
  pass: boolean | null;
}

/**
 * Pilot exit KPIs (spec §14.2, Gate 3). Default window = trailing 4 weeks ending `to`
 * (spec: "expand once pilot KPIs hold for four straight weeks").
 */
@Injectable()
export class PilotKpisService {
  constructor(
    private readonly b: AnalyticsBase,
    private readonly growth: GrowthService,
  ) {}

  /** GET /admin/analytics/pilot-exit-kpis */
  async kpis(f: AnalyticsFilterDto, user: AuthUser) {
    const c = await this.b.ctx(f, user, { defaultDays: 28 });

    const p = new Params();
    const conds = [...rangeConds(p, 'o."createdAt"', c.from, c.to), ...scopeConds(c, p)];
    const [x] = await this.b.q(
      `SELECT COUNT(*)::int placed,
              COUNT(*) FILTER (WHERE o.status IN ('DELIVERED','COLLECTED'))::int completed,
              COUNT(*) FILTER (WHERE o.status IN ('ACCEPTED','DRIVER_ASSIGNED','PREPARING','READY','PICKED_UP','ON_THE_WAY','DELIVERED','COLLECTED'))::int accepted,
              COUNT(*) FILTER (WHERE o.status = 'REJECTED')::int rejected,
              COUNT(*) FILTER (WHERE o.type = 'DELIVERY' AND o.status = 'DELIVERED')::int delivered,
              COUNT(*) FILTER (WHERE o.type = 'DELIVERY' AND o.status = 'DELIVERED' AND o."deliveredAt" <= o."estimatedDeliveryAt")::int "onTime",
              COALESCE(AVG(EXTRACT(EPOCH FROM (o."deliveredAt" - o."createdAt")) / 60) FILTER (WHERE o.type = 'DELIVERY' AND o.status = 'DELIVERED'), 0)::float8 "avgDeliveryMin",
              COUNT(*) FILTER (WHERE o.type = 'DELIVERY' AND o.fulfilment = 'PLATFORM_DRIVER')::int "deliveryOrders",
              COUNT(*) FILTER (WHERE o.type = 'DELIVERY' AND o.fulfilment = 'PLATFORM_DRIVER' AND o."escalationLevel" >= 2)::int escalated,
              COUNT(*) FILTER (WHERE o.status IN ('DELIVERED','COLLECTED') AND ${hasIssue()})::int "withIssue"
       FROM orders o ${WHERE(conds)}`,
      p.v,
    );

    const margin = await this.b.orderKpis(c, c.from, c.to);
    const repeat = await this.growth.repeat30Trailing(c, c.to);

    const acceptanceRatePct = pct(x.accepted, x.accepted + x.rejected);
    const onTimePct = pct(x.onTime, x.delivered);
    const issuePct = pct(x.withIssue, x.completed);
    const escalationPct = pct(x.escalated, x.deliveryOrders);

    const rows: PilotKpi[] = [
      { key: 'avgDeliveryMin', label: 'Average delivery time', value: r2(x.avgDeliveryMin), unit: 'min', target: 40, targetOp: '<=', pass: x.avgDeliveryMin != null ? x.avgDeliveryMin <= 40 : null },
      { key: 'onTimeDeliveryPct', label: 'On-time delivery', value: onTimePct, unit: '%', target: 90, targetOp: '>=', pass: onTimePct != null ? onTimePct >= 90 : null },
      { key: 'restaurantAcceptancePct', label: 'Restaurant acceptance', value: acceptanceRatePct, unit: '%', target: 95, targetOp: '>=', pass: acceptanceRatePct != null ? acceptanceRatePct >= 95 : null },
      { key: 'issueRatePct', label: 'Orders with an issue', value: issuePct, unit: '%', target: 3, targetOp: '<=', pass: issuePct != null ? issuePct <= 3 : null },
      { key: 'unassignedEscalationPct', label: 'Unassigned-order escalations', value: escalationPct, unit: '%', target: 2, targetOp: '<=', pass: escalationPct != null ? escalationPct <= 2 : null },
      { key: 'repeatRate30dPct', label: 'Customer repeat rate within 30 days', value: repeat.ratePct, unit: '%', target: 35, targetOp: '>=', pass: repeat.ratePct != null ? repeat.ratePct >= 35 : null },
      { key: 'contributionMarginPerOrder', label: 'Contribution margin per order', value: margin.marginPerOrder, unit: '$', target: 0, targetOp: '>', pass: margin.marginPerOrder != null ? margin.marginPerOrder > 0 : null },
    ];

    return {
      range: this.b.rangeInfo(c),
      note: 'Spec §14.2 (Gate 3): pilot exits once every KPI holds for four straight weeks. Default window here is the trailing 28 days - re-run weekly and check four consecutive passing windows before treating the gate as cleared.',
      kpis: rows,
      allPass: rows.every((k) => k.pass === true),
      sampleSizes: { orders: x.placed, deliveryOrdersConsidered: x.delivered, completedOrders: x.completed },
    };
  }
}
