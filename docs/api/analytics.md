# Analytics API

Common query filters (`AnalyticsFilterDto`) on every GET: `from`, `to` (YYYY-MM-DD city-local inclusive, or ISO), `cityId`, `zoneId`, `restaurantId`, `groupBy` (day|week|month), `page`, `limit` (<=1000), `search`, `sortBy`, `sortDir`, `cohorts` (customer-growth), `format` (export). Default range: last 30 days (pilot KPIs: 28). Most responses include `range {from,to,timezone,groupBy,previousFrom,previousTo}`; KPI objects are `{value, previous, changePct}`. Staff city/zone scope is applied automatically.

## Admin
| Method | Path | Permission | Key params | Response |
|---|---|---|---|---|
| GET | /admin/dashboard | dashboard:view | city/zone filters | `{live{byStatus,activeOrders,late,unassigned,escalated}, today{gmv,orders,completedOrders,aov,cancellations,cancellationRatePct}, gmvComparison, drivers{online,onTrip,idle}, openTickets{total,slaBreached}, pendingApprovals, topRestaurants, hourlyOrders{today,yesterday}, byCity, byZone}` |
| GET | /admin/analytics/live-ops | reports:view | city/zone | `{kpis, byStatus, timings, driversVsDemandByZone, needsAttention[], todayOrdersByHour}` |
| GET | /admin/analytics/executive | reports:view | range, groupBy | `{kpis{gmv,netRevenue,takeRatePct,orders,aov,activeCustomers,newCustomers,cac,ltv,ltvToCac,marginPerOrder,contributionMargin,cancellationRatePct}, marketingSpend, economics, series[], byCity[]}` |
| GET | /admin/analytics/restaurant-performance | reports:view | range, search, sortBy(gmv,orders,rating,cancellationRatePct,reliabilityScore,avgPrepMin), page, limit | `{range, kpis, data[{id,name,status,rating,orders,completed,cancelled,rejected,late,gmv,commission,payout,avgPrepMin,aov,cancellationRatePct,lateRatePct}], meta}` |
| GET | /admin/analytics/restaurant-performance/:id | reports:view | range | `{range, sales, topItems, peakHours, ratings}` |
| GET | /admin/analytics/driver-performance | reports:view | range, sortBy(trips,earnings,rating,onTimeRate,acceptanceRate), page, limit | `{range, fleet{active,online,avgRating,avgAcceptanceRate,avgOnTimeRate}, data[{id,name,status,vehicleType,rating,trips,onTimeTrips,earnings,avgTripMin,earningsPerTrip,...}], meta}` |
| GET | /admin/analytics/customer-growth | reports:view | range, cohorts | `{kpis, series, retentionCohorts, repeatRate, orderFrequency, topCuisines, promoRoi, referrals, funnel}` |
| GET | /admin/analytics/finance | reports:view | range | `{kpis, series, ledgerByType, refunds, payoutBatches, payouts, invoices}` (ledger/refund/payout/invoice sections are platform-wide; only `kpis` honour city/zone) |
| GET | /admin/analytics/support | reports:view | range | `{kpis{created,open,resolved,slaBreachPct,autoResolvedPct,avgFirstResponseMin,avgResolutionHours,avgCsat,...}, byCategory, byTier, openByPriority, series}` |
| GET | /admin/analytics/pilot-exit-kpis | reports:view | range (default 28d) | `{range, note, kpis[{key,label,value,unit,target,targetOp,pass}], allPass, sampleSizes}` Gate 3 targets: avg delivery <=40 min, on-time >=90%, acceptance >=95%, issues <=3%, unassigned escalations <=2%, 30d repeat >=35%, margin/order >0 |
| GET | /admin/reports/:dashboard/export | reports:export | `format=csv|xlsx` + filters; dashboard in `dashboard, live_ops, executive, restaurant_performance, driver_performance, customer_growth, finance, support, pilot_exit_kpis` | csv: `{filename,format,contentType,csv}`; xlsx: `{filename,format,contentType,base64}`. Audit-logged. |
| GET | /admin/reports/scheduled | reports:view | page,limit,search | paginated `ScheduledReport` |
| GET | /admin/reports/scheduled/:id | reports:view | | ScheduledReport |
| POST | /admin/reports/scheduled | reports:create | `{name, dashboard, frequency DAILY|WEEKLY|MONTHLY, recipients[emails], format? CSV|XLSX, filters? {cityId,zoneId,restaurantId,groupBy,range: yesterday|last7d|last30d|lastMonth|mtd}, active?}` | ScheduledReport |
| PATCH | /admin/reports/scheduled/:id | reports:edit | same, all optional | ScheduledReport |
| DELETE | /admin/reports/scheduled/:id | reports:delete | | `{deleted:true}` |
| POST | /admin/reports/scheduled/:id/run | reports:export | | `{sent:true}` |

Cron: daily 07:00, Mondays 07:00, 1st of month 07:00. Email goes through `NotificationsService.sendEmail` (plain text): CSV is inlined; XLSX is only announced (no attachment support).

## Restaurant portal (scoped to `user.restaurantIds`; payouts by `user.merchantId`; all restaurant roles)
| Method | Path | Params | Response |
|---|---|---|---|
| GET | /restaurant/reports/sales | range, groupBy, restaurantId | `{range, kpis{orders,completedOrders,gmv,payout,commission,aov,cancellationRatePct}, series[]}` |
| GET | /restaurant/reports/top-items | range, limit | `[{menuItemId,name,lines,qty,revenue,orders,avgPrice}]` |
| GET | /restaurant/reports/peak-hours | range | `{grid[{dow(0=Sun),hour,orders,gmv}], busiest[]}` |
| GET | /restaurant/reports/ratings | range | `{average,total,distribution,repliedPct,recent[]}` |
| GET | /restaurant/reports/payouts | page, limit | `{kpis{paid,pending}, data[], meta}` |
| GET | /restaurant/reports/promotions | range | `{range, owned[], platformImpact}` |
