import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FeatureFlag, Setting } from '../database/entities';

/** Every configurable platform setting with its default. Seeded on boot (existing values are never overwritten). */
export const SETTING_DEFINITIONS: any[] = [
  // ---- general ----
  { key: 'general.platformName', group: 'general', label: 'Platform name', value: 'FORKSY', inputType: 'text', isPublic: true },
  { key: 'general.supportEmail', group: 'general', label: 'Support email', value: 'support@forksy.ca', inputType: 'text', isPublic: true },
  { key: 'general.supportPhone', group: 'general', label: 'Support phone', value: '+1-800-555-0100', inputType: 'text', isPublic: true },
  { key: 'general.defaultLanguage', group: 'general', label: 'Default language', value: 'en', inputType: 'select', isPublic: true },
  { key: 'general.supportedLanguages', group: 'languages', label: 'Supported languages', value: ['en', 'fr'], inputType: 'json', isPublic: true },
  { key: 'general.currency', group: 'general', label: 'Currency', value: 'CAD', inputType: 'text', isPublic: true },
  { key: 'general.distanceUnit', group: 'general', label: 'Distance unit', value: 'km', inputType: 'select', isPublic: true },
  { key: 'general.maintenanceMode', group: 'general', label: 'Maintenance mode (blocks apps)', value: false, inputType: 'boolean', isPublic: true },
  { key: 'general.maintenanceMessage', group: 'general', label: 'Maintenance message', value: 'We will be back shortly.', inputType: 'textarea', isPublic: true },
  { key: 'general.statusBanner', group: 'general', label: 'Status banner text (shown in all apps)', value: '', inputType: 'text', isPublic: true },
  { key: 'general.forksyHstNumber', group: 'taxes', label: 'FORKSY HST registration number', value: '', inputType: 'text' },
  { key: 'general.legalName', group: 'general', label: 'Legal entity name', value: 'FORKSY Inc.', inputType: 'text' },
  // ---- orders ----
  { key: 'orders.autoRejectSeconds', group: 'orders', label: 'Auto-reject un-actioned orders after (sec)', value: 180, inputType: 'number' },
  { key: 'orders.newOrdersPaused', group: 'orders', label: 'New orders paused (set by SOP-10 incident)', value: false, inputType: 'boolean', isPublic: true },
  { key: 'orders.newOrdersPausedMessage', group: 'orders', label: 'Message shown while new orders are paused', value: '', inputType: 'text', isPublic: true },
  { key: 'operations.supplyOrdersPerDriverHour', group: 'dispatch', label: 'Supply forecast: orders one driver can serve per hour', value: 2.5, inputType: 'number' },
  {
    key: 'operations.checklistTemplates', group: 'dispatch', label: 'SOP-03 open/close checklist templates', inputType: 'json',
    value: {
      OPEN: [
        { key: 'system_health', label: 'Check system health (API, database, realtime)' },
        { key: 'payment_gateway', label: 'Check payment gateway status' },
        { key: 'supply_forecast', label: 'Review driver supply forecast per zone' },
        { key: 'supply_alerts', label: 'Send supply alerts / boosts to zones predicted short' },
        { key: 'restaurant_tablets', label: 'Call restaurants whose tablets are not online at opening' },
      ],
      CLOSE: [
        { key: 'no_open_orders', label: 'Confirm there are no open orders' },
        { key: 'review_late_orders', label: 'Review late orders' },
        { key: 'review_cancelled_refunded', label: 'Review cancelled and refunded orders' },
        { key: 'log_incidents', label: 'Log incidents' },
        { key: 'handover_notes', label: 'Write handover notes for the next shift' },
      ],
    },
  },
  { key: 'orders.freeCancelUntil', group: 'orders', label: 'Customers cancel free until status', value: 'ACCEPTED', inputType: 'select' },
  { key: 'orders.cancellationFeeMaxPctOfFood', group: 'orders', label: 'Max late-cancellation fee (% of food cost)', value: 100, inputType: 'number' },
  { key: 'orders.tipEditableMinutes', group: 'orders', label: 'Tip editable after delivery (min)', value: 60, inputType: 'number', isPublic: true },
  { key: 'orders.tipPresets', group: 'orders', label: 'Tip presets (%)', value: [10, 15, 20], inputType: 'json', isPublic: true },
  { key: 'orders.highValuePinThreshold', group: 'orders', label: 'Require delivery PIN above ($)', value: 100, inputType: 'number' },
  { key: 'orders.maxScheduleDays', group: 'orders', label: 'Max days ahead for scheduled orders', value: 3, inputType: 'number', isPublic: true },
  { key: 'orders.quotedEtaBufferMin', group: 'orders', label: 'ETA buffer added to quotes (min)', value: 5, inputType: 'number' },
  { key: 'orders.acceptCashPayments', group: 'orders', label: 'Allow cash payments', value: false, inputType: 'boolean' },
  { key: 'orders.partialApprovalMinutes', group: 'orders', label: 'Auto-approve item removal if customer silent (min)', value: 10, inputType: 'number' },
  { key: 'orders.driverCancelCompensation', group: 'orders', label: 'Driver compensation when order cancelled after assignment ($)', value: 3, inputType: 'number' },
  { key: 'orders.lateEtaExtensionMin', group: 'orders', label: 'ETA extension applied when an order is late (min)', value: 10, inputType: 'number' },
  { key: 'orders.reliabilityPenaltyPerCancel', group: 'orders', label: 'Restaurant reliability points lost per post-accept cancellation', value: 5, inputType: 'number' },
  { key: 'orders.chatWindowMinutes', group: 'orders', label: 'Order chat stays open after completion (min)', value: 60, inputType: 'number' },
  { key: 'orders.maxTip', group: 'orders', label: 'Maximum tip ($)', value: 200, inputType: 'number', isPublic: true },
  // ---- dispatch ----
  { key: 'dispatch.autoAssign', group: 'dispatch', label: 'Auto-assign drivers', value: true, inputType: 'boolean' },
  { key: 'dispatch.maxInitialRadiusKm', group: 'dispatch', label: 'Initial search radius (km)', value: 4, inputType: 'number' },
  { key: 'dispatch.readyMatchWindowMin', group: 'dispatch', label: 'Driver should arrive ≤ N min before food is ready', value: 2, inputType: 'number' },
  { key: 'dispatch.weights', group: 'dispatch', label: 'Scoring weights', value: { distance: 0.35, readyMatch: 0.25, vehicleFit: 0.1, load: 0.1, performance: 0.1, fairness: 0.1 }, inputType: 'json' },
  { key: 'dispatch.batching.enabled', group: 'dispatch', label: 'Order batching (phase 2)', value: false, inputType: 'boolean' },
  { key: 'dispatch.bikeMaxDistanceKm', group: 'dispatch', label: 'Bikes excluded above (km)', value: 4, inputType: 'number' },
  { key: 'dispatch.bikeMaxSubtotal', group: 'dispatch', label: 'Bikes excluded above order subtotal ($)', value: 80, inputType: 'number' },
  { key: 'dispatch.driverMissingAlertMin', group: 'dispatch', label: 'Driver stationary alert (min)', value: 10, inputType: 'number' },
  { key: 'dispatch.assumedPickupEtaMin', group: 'dispatch', label: 'Assumed driver pickup ETA before any candidate is known, for ready-time matching (min)', value: 8, inputType: 'number' },
  { key: 'dispatch.escalatedRetrySec', group: 'dispatch', label: 'Retry interval while an order is escalated to the dispatcher (sec)', value: 45, inputType: 'number' },
  // ---- payments ----
  { key: 'payments.provider', group: 'payments', label: 'Payment provider', value: 'stripe', inputType: 'select' },
  { key: 'payments.stripe.publishableKey', group: 'payments', label: 'Stripe publishable key', value: '', inputType: 'text', isPublic: true },
  { key: 'payments.stripe.secretKey', group: 'payments', label: 'Stripe secret key', value: '', inputType: 'password', isSecret: true },
  { key: 'payments.stripe.webhookSecret', group: 'payments', label: 'Stripe webhook secret', value: '', inputType: 'password', isSecret: true },
  { key: 'payments.applePayEnabled', group: 'payments', label: 'Apple Pay', value: true, inputType: 'boolean', isPublic: true },
  { key: 'payments.googlePayEnabled', group: 'payments', label: 'Google Pay', value: true, inputType: 'boolean', isPublic: true },
  { key: 'payments.walletEnabled', group: 'payments', label: 'FORKSY wallet / credits', value: true, inputType: 'boolean', isPublic: true },
  { key: 'payments.giftCardsEnabled', group: 'payments', label: 'Gift cards', value: true, inputType: 'boolean', isPublic: true },
  { key: 'payments.instantPayoutFeePct', group: 'payments', label: 'Instant cash-out fee (%)', value: 1.5, inputType: 'number' },
  { key: 'payments.instantPayoutFeeMin', group: 'payments', label: 'Instant cash-out min fee ($)', value: 0.5, inputType: 'number' },
  { key: 'payments.payoutWeekday', group: 'payments', label: 'Payout day (0=Sun..6=Sat)', value: 3, inputType: 'number' },
  { key: 'payments.reconciliationToleranceCad', group: 'payments', label: 'Reconciliation gap tolerance ($)', value: 1, inputType: 'number' },
  { key: 'payments.dailyPayoutsEnabled', group: 'payments', label: 'Pay DAILY-schedule restaurants automatically every day', value: true, inputType: 'boolean' },
  // ---- maps ----
  { key: 'maps.provider', group: 'maps', label: 'Maps provider', value: 'google', inputType: 'select' },
  { key: 'maps.googleApiKey', group: 'maps', label: 'Google Maps API key', value: '', inputType: 'password', isSecret: true },
  { key: 'maps.mapboxToken', group: 'maps', label: 'Mapbox token', value: '', inputType: 'password', isSecret: true },
  { key: 'maps.driverLocationIntervalSec', group: 'maps', label: 'Driver location refresh (sec)', value: 5, inputType: 'number', isPublic: true },
  // ---- notifications ----
  { key: 'notifications.smsProvider', group: 'notifications', label: 'SMS provider', value: 'twilio', inputType: 'select' },
  { key: 'notifications.emailProvider', group: 'notifications', label: 'Email provider', value: 'sendgrid', inputType: 'select' },
  { key: 'notifications.pushProvider', group: 'notifications', label: 'Push provider', value: 'fcm', inputType: 'select' },
  { key: 'notifications.twilioAccountSid', group: 'notifications', label: 'Twilio account SID', value: '', inputType: 'text', isSecret: true },
  { key: 'notifications.twilioAuthToken', group: 'notifications', label: 'Twilio auth token', value: '', inputType: 'password', isSecret: true },
  { key: 'notifications.twilioFrom', group: 'notifications', label: 'Twilio from number', value: '', inputType: 'text' },
  { key: 'notifications.sendgridApiKey', group: 'notifications', label: 'SendGrid API key', value: '', inputType: 'password', isSecret: true },
  { key: 'notifications.emailFrom', group: 'notifications', label: 'From email', value: 'no-reply@forksy.ca', inputType: 'text' },
  { key: 'notifications.fcmServerKey', group: 'notifications', label: 'FCM server key', value: '', inputType: 'password', isSecret: true },
  {
    key: 'notifications.matrix', group: 'notifications', label: 'Notification matrix (event -> audience -> channels)', inputType: 'json',
    value: {
      'order.placed': { CUSTOMER: ['PUSH', 'EMAIL', 'IN_APP'], RESTAURANT: ['PUSH', 'IN_APP'] },
      'order.accepted': { CUSTOMER: ['PUSH', 'IN_APP'] },
      'order.rejected': { CUSTOMER: ['PUSH', 'SMS', 'IN_APP'] },
      'driver.offer': { DRIVER: ['PUSH', 'IN_APP'] },
      'driver.assigned': { CUSTOMER: ['PUSH', 'IN_APP'], RESTAURANT: ['IN_APP'] },
      'order.ready': { CUSTOMER: ['PUSH', 'IN_APP'], DRIVER: ['PUSH', 'IN_APP'] },
      'order.picked_up': { CUSTOMER: ['PUSH', 'IN_APP'] },
      'order.delivered': { CUSTOMER: ['PUSH', 'EMAIL', 'IN_APP'], DRIVER: ['PUSH', 'IN_APP'], RESTAURANT: ['IN_APP'] },
      'order.late': { CUSTOMER: ['PUSH', 'IN_APP'], RESTAURANT: ['PUSH', 'IN_APP'], DRIVER: ['PUSH'], ADMIN: ['IN_APP'] },
      'order.no_driver': { CUSTOMER: ['PUSH', 'IN_APP'], RESTAURANT: ['IN_APP'], ADMIN: ['IN_APP'] },
      'document.expiring': { RESTAURANT: ['EMAIL'], DRIVER: ['PUSH', 'EMAIL'], ADMIN: ['IN_APP'] },
      'payout.sent': { RESTAURANT: ['EMAIL'], DRIVER: ['PUSH', 'EMAIL'] },
    },
  },
  // ---- taxes ----
  { key: 'taxes.defaultTaxClass', group: 'taxes', label: 'Default tax class code', value: 'HST_ON', inputType: 'text' },
  { key: 'taxes.taxOnFees', group: 'taxes', label: 'Apply HST to delivery / service / small-order fees', value: true, inputType: 'boolean' },
  { key: 'taxes.taxOnDeliveryFee', group: 'taxes', label: 'Apply HST to delivery fee', value: true, inputType: 'boolean' },
  // ---- security ----
  { key: 'security.enforce2faStaff', group: 'security', label: 'Require 2FA for staff', value: true, inputType: 'boolean' },
  { key: 'security.enforce2faRestaurantOwner', group: 'security', label: 'Require 2FA for restaurant owners', value: true, inputType: 'boolean' },
  { key: 'security.sessionTimeoutMin', group: 'security', label: 'Admin session idle timeout (min)', value: 60, inputType: 'number' },
  { key: 'security.passwordMinLength', group: 'security', label: 'Min password length', value: 10, inputType: 'number' },
  { key: 'security.ipAllowlist', group: 'security', label: 'Admin IP allow-list (empty = any)', value: [], inputType: 'json' },
  { key: 'security.refundFrequencyLimit30d', group: 'security', label: 'Refunds per account per 30 days before flag', value: 4, inputType: 'number' },
  // ---- support ----
  { key: 'support.tier1RefundLimit', group: 'support', label: 'Tier 1 refund limit ($)', value: 50, inputType: 'number' },
  { key: 'support.autoCreditMaxMissingItem', group: 'support', label: 'Self-serve instant credit: max missing item ($)', value: 15, inputType: 'number' },
  { key: 'support.slaFirstResponseMin', group: 'support', label: 'SLA first response (min)', value: 15, inputType: 'number' },
  { key: 'support.slaResolutionHours', group: 'support', label: 'SLA resolution (hours)', value: 24, inputType: 'number' },
  { key: 'support.lateCreditAmount', group: 'support', label: 'Standard credit when > 30 min late ($)', value: 5, inputType: 'number' },
  { key: 'support.veryLateMinutes', group: 'support', label: 'Very late = minutes past ETA', value: 30, inputType: 'number' },
  { key: 'support.autoCreditMaxFoodQuality', group: 'support', label: 'Self-serve instant credit: max food-quality credit ($)', value: 8, inputType: 'number' },
  { key: 'support.reviewLowRatingThreshold', group: 'support', label: 'SOP-08 detector: propose review below avg rating', value: 4.2, inputType: 'number' },
  { key: 'support.reviewMinRatings', group: 'support', label: 'SOP-08 detector: min ratings before low-rating trigger', value: 10, inputType: 'number' },
  { key: 'support.reviewCancellationThreshold', group: 'support', label: 'SOP-08 detector: cancellations before trigger', value: 5, inputType: 'number' },
  { key: 'support.reviewDetectorEnabled', group: 'support', label: 'SOP-08 auto-detector enabled', value: true, inputType: 'boolean' },
  // ---- driver ----
  { key: 'driver.trainingPassMark', group: 'driver', label: 'Training pass mark (%)', value: 80, inputType: 'number' },
  { key: 'driver.welcomeBoostAmount', group: 'driver', label: 'First-week boost ($/trip)', value: 2, inputType: 'number' },
  { key: 'driver.docExpiryReminderDays', group: 'driver', label: 'Document expiry reminders (days before)', value: [30, 14, 7, 1], inputType: 'json' },
  { key: 'driver.deactivationResponseDays', group: 'driver', label: 'Deactivation notice response period (days)', value: 7, inputType: 'number' },
  { key: 'driver.gpsCheckEnabled', group: 'driver', label: 'Enforce GPS proximity for status steps', value: true, inputType: 'boolean' },
  { key: 'driver.gpsToleranceMeters', group: 'driver', label: 'GPS tolerance for arrived/pickup/delivered (m)', value: 300, inputType: 'number' },
  { key: 'driver.firstWeekDays', group: 'driver', label: 'First-week boost duration (days)', value: 7, inputType: 'number' },
  { key: 'driver.offerTimeoutSec', group: 'driver', label: 'Offer accept window (sec)', value: 30, inputType: 'number', isPublic: true },
  { key: 'driver.requiredDocuments', group: 'driver', label: 'Required documents', value: ['LICENCE', 'VEHICLE_REGISTRATION', 'INSURANCE', 'PHOTO', 'WORK_ELIGIBILITY'], inputType: 'json' },
  // ---- restaurant ----
  { key: 'restaurant.requiredDocuments', group: 'restaurant', label: 'Required documents', value: ['BUSINESS_LICENCE', 'HEALTH_CERTIFICATE', 'VOID_CHEQUE'], inputType: 'json' },
  { key: 'restaurant.defaultPrepTimeMin', group: 'restaurant', label: 'Default prep time (min)', value: 20, inputType: 'number' },
  { key: 'restaurant.selfServePromosNeedApproval', group: 'restaurant', label: 'Restaurant promos need ops approval', value: false, inputType: 'boolean' },
  { key: 'restaurant.docExpiryReminderDays', group: 'restaurant', label: 'Document expiry reminders (days before)', value: [30, 14, 7, 1], inputType: 'json' },
  // ---- marketing ----
  { key: 'marketing.referralReferrerReward', group: 'marketing', label: 'Referral: reward for referrer ($)', value: 10, inputType: 'number' },
  { key: 'marketing.referralRefereeReward', group: 'marketing', label: 'Referral: reward for new customer ($)', value: 10, inputType: 'number' },
  { key: 'marketing.referralEnabled', group: 'marketing', label: 'Referral programme enabled', value: true, inputType: 'boolean', isPublic: true },
  { key: 'marketing.referralMinSubtotal', group: 'marketing', label: 'Referral: min first-order subtotal ($)', value: 0, inputType: 'number' },
  { key: 'marketing.loyaltyEnabled', group: 'marketing', label: 'Loyalty points (phase 2)', value: false, inputType: 'boolean', isPublic: true },
  { key: 'marketing.pointsPerDollar', group: 'marketing', label: 'Loyalty: points per $', value: 1, inputType: 'number' },
  // ---- customers ----
  { key: 'customers.walletAdjustApprovalThreshold', group: 'customers', label: 'Wallet adjustments above ($) need customers:approve', value: 100, inputType: 'number' },
  { key: 'customers.guestCheckoutEnabled', group: 'customers', label: 'Allow guest checkout on web', value: true, inputType: 'boolean', isPublic: true },
  // ---- compliance ----
  { key: 'compliance.dataRequestDays', group: 'compliance', label: 'PIPEDA data request response window (days)', value: 30, inputType: 'number' },
  { key: 'compliance.auditRetentionYears', group: 'compliance', label: 'Audit log retention (years)', value: 7, inputType: 'number' },
  { key: 'compliance.requireMarketingConsent', group: 'compliance', label: 'CASL: marketing needs opt-in', value: true, inputType: 'boolean' },
];

export const FEATURE_FLAG_DEFINITIONS = [
  { key: 'group_orders', enabled: false, description: 'Group order links (phase 2)' },
  { key: 'forksy_plus', enabled: false, description: 'FORKSY+ subscription (phase 2)' },
  { key: 'loyalty_points', enabled: false, description: 'Loyalty points (phase 2)' },
  { key: 'order_batching', enabled: false, description: 'Driver order batching (phase 2)' },
  { key: 'dine_in_qr', enabled: false, description: 'Dine-in QR ordering (phase 3)' },
  { key: 'sponsored_listings', enabled: false, description: 'Sponsored listings / ads' },
  { key: 'pos_integrations', enabled: false, description: 'POS integrations (Square, Toast, Clover)' },
  { key: 'scheduled_driver_shifts', enabled: true, description: 'Scheduled driver shifts in busy zones' },
  { key: 'guest_checkout_web', enabled: true, description: 'Guest checkout on web' },
  { key: 'alcohol_delivery', enabled: false, description: 'Alcohol delivery (needs AGCO licensing)' },
  { key: 'instant_payouts', enabled: true, description: 'Instant cash-out for drivers' },
  { key: 'auto_refund_rules', enabled: true, description: 'Self-serve automatic refund/credit rules' },
];

@Injectable()
export class SettingsService implements OnModuleInit {
  private cache = new Map<string, any>();
  private loadedAt = 0;

  constructor(
    @InjectRepository(Setting) private repo: Repository<Setting>,
    @InjectRepository(FeatureFlag) private flags: Repository<FeatureFlag>,
  ) {}

  async onModuleInit() {
    await this.ensureDefaults();
    await this.reload();
  }

  /** Insert missing defaults without touching admin-edited values. */
  async ensureDefaults() {
    const existing = new Set((await this.repo.find({ select: ['key'] })).map((s) => s.key));
    const missing = SETTING_DEFINITIONS.filter((d) => !existing.has(d.key));
    if (missing.length) await this.repo.insert(missing);
    const existingFlags = new Set((await this.flags.find({ select: ['key'] })).map((f) => f.key));
    const missingFlags = FEATURE_FLAG_DEFINITIONS.filter((d) => !existingFlags.has(d.key));
    if (missingFlags.length) await this.flags.insert(missingFlags);
  }

  async reload() {
    const all = await this.repo.find();
    this.cache = new Map(all.map((s) => [s.key, s.value]));
    this.loadedAt = Date.now();
  }

  /** Sync read from cache (refreshed on every write and every 60 s). */
  get<T = any>(key: string, fallback?: T): T {
    if (Date.now() - this.loadedAt > 60_000) this.reload().catch(() => undefined);
    return (this.cache.has(key) ? this.cache.get(key) : fallback) as T;
  }

  async set(key: string, value: any) {
    let s = await this.repo.findOne({ where: { key } });
    if (!s) s = this.repo.create({ key, group: key.split('.')[0] });
    s.value = value;
    await this.repo.save(s);
    this.cache.set(key, value);
    return s;
  }

  async isFeatureEnabled(key: string, cityId?: string): Promise<boolean> {
    const f = await this.flags.findOne({ where: { key } });
    if (!f || !f.enabled) return false;
    if (f.cityIds?.length && cityId && !f.cityIds.includes(cityId)) return false;
    return true;
  }

  async list(group?: string) {
    const rows = await this.repo.find({ where: group ? { group } : {}, order: { group: 'ASC', key: 'ASC' } });
    return rows.map((r) => this.mask(r));
  }

  mask(r: Setting) {
    if (!r.isSecret) return r;
    const has = r.value !== null && r.value !== undefined && r.value !== '';
    return { ...r, value: has ? '********' : '', hasValue: has };
  }

  /** Values flagged isPublic - safe to expose to mobile apps. */
  async publicConfig() {
    const rows = await this.repo.find({ where: { isPublic: true } });
    const out: Record<string, any> = {};
    for (const r of rows) out[r.key] = r.value;
    const flags = await this.flags.find();
    return { settings: out, featureFlags: Object.fromEntries(flags.map((f) => [f.key, f.enabled])) };
  }
}
