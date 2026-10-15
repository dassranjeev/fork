import { Module } from '../common/enums';

/**
 * THE NOTIFICATION EVENT REGISTRY (single source of truth, see docs/notifications.md).
 *
 * Every event the platform can raise is declared here once: who can receive it (audience), through which channels by default
 * (this becomes the platform default of the `notifications.matrix` setting), the SAFE push copy, which variables and data keys
 * may travel inside a push (allow-list), the deep link, urgency and whether it is critical (bypasses quiet hours).
 *
 * A push NEVER carries text that was not rendered from this registry (or an admin-edited PUSH template) with allow-listed
 * variables only, so a delivery PIN, access code, pickup code, phone number, address or card / proof data cannot leak into a
 * push even when the in-app text contains them. `scrubPush` is a second line of defence.
 */
export type Audience = 'CUSTOMER' | 'RESTAURANT' | 'DRIVER' | 'ADMIN';
export type Category = 'orders' | 'delivery' | 'payments' | 'support' | 'promotions' | 'system';
export type Urgency = 'very-low' | 'low' | 'normal' | 'high';
export type ChannelName = 'PUSH' | 'EMAIL' | 'SMS' | 'IN_APP';

export const CATEGORIES: { key: Category; label: string; description: string }[] = [
  { key: 'orders', label: 'Orders', description: 'New orders, status changes, cancellations, late orders, reviews' },
  { key: 'delivery', label: 'Delivery and drivers', description: 'Driver assignment, arrival, hand-off, delivery offers and instructions' },
  { key: 'payments', label: 'Payments and payouts', description: 'Refunds, credits, payouts, payment problems' },
  { key: 'support', label: 'Support', description: 'Tickets, live chat, safety (SOS)' },
  { key: 'promotions', label: 'Promotions', description: 'Offers and campaigns (marketing consent applies)' },
  { key: 'system', label: 'System and account', description: 'Documents, approvals, store status, incidents, security' },
];
export const CATEGORY_KEYS = CATEGORIES.map((c) => c.key);

export interface AudienceDef {
  /** default channels of the platform matrix (IN_APP is always stored) */
  channels: ChannelName[];
  /** safe push copy; may only use the event's pushVars */
  push?: { title: string; body: string };
  /** deep link template ({orderId} ... filled from the notification data); relative to the web origin */
  url?: string;
  /** critical: bypasses quiet hours (new order for a restaurant, driver offers, safety) */
  critical?: boolean;
  urgency?: Urgency;
  /** the OS notification stays on screen until it is dismissed */
  requireInteraction?: boolean;
  /** collapse key template, e.g. order:{orderId} (a newer push with the same tag replaces the older one) */
  tag?: string;
  /** push TTL in seconds (default by urgency) */
  ttl?: number;
}

export interface EventDef {
  category: Category;
  /** ADMIN audience: only staff whose role grants <module>:view receive it (SUPER_ADMIN always). Missing = all staff. */
  module?: Module;
  /** variables allowed inside the push text */
  pushVars?: string[];
  /** data keys allowed inside the push payload (primitive values only) */
  pushData?: string[];
  /** marketing: needs CASL consent */
  marketing?: boolean;
  /** never delivered by push, whatever the matrix says (one-time codes) */
  noPush?: boolean;
  audiences: Partial<Record<Audience, AudienceDef>>;
  /** in-app copy for events that DEFAULT_MESSAGES does not already carry */
  msg?: Partial<Record<Audience, { title: string; body: string }>>;
}

const IA: ChannelName[] = ['IN_APP'];
const PI: ChannelName[] = ['PUSH', 'IN_APP'];
const PIE: ChannelName[] = ['PUSH', 'EMAIL', 'IN_APP'];

/** deep links per audience */
export const BASE_URL: Record<Audience, string> = {
  CUSTOMER: '/order/notifications',
  RESTAURANT: '/portal/orders',
  DRIVER: '/driver-demo.html',
  ADMIN: '/inbox',
};
const C_TRACK = '/order/track/{orderId}';
const R_ORDER = '/portal/orders?order={orderId}';
const D_HOME = '/driver-demo.html';
const A_ORDER = '/orders/{orderId}';
const A_TICKET = '/support/tickets/{ticketId}';

export const EVENTS: Record<string, EventDef> = {
  // ------------------------------------------------------------------ order lifecycle
  'order.placed': {
    category: 'orders',
    pushVars: ['code', 'restaurant', 'total', 'type', 'itemCount', 'cancelNote'],
    pushData: ['orderId', 'cancelUntil'],
    audiences: {
      CUSTOMER: { channels: PIE, push: { title: 'Order placed', body: 'Order {{code}} was placed. {{cancelNote}}' }, url: C_TRACK, urgency: 'normal', tag: 'order:{orderId}' },
      // the restaurant is told when the customer's cancellation window closes (release): THE loud alert
      RESTAURANT: { channels: PI, push: { title: 'New order {{code}}', body: 'New {{type}} order, {{itemCount}} items. Open the portal to accept it.' }, url: R_ORDER, critical: true, urgency: 'high', requireInteraction: true, tag: 'order:{orderId}', ttl: 900 },
    },
  },
  'order.sent_to_restaurant': {
    category: 'orders',
    pushVars: ['code', 'restaurant'],
    pushData: ['orderId'],
    audiences: { CUSTOMER: { channels: PI, push: { title: 'Sent to the restaurant', body: 'Order {{code}} is with {{restaurant}} now.' }, url: C_TRACK, urgency: 'low', tag: 'order:{orderId}' } },
    msg: { CUSTOMER: { title: 'Sent to the restaurant', body: 'The cancellation window is over. Order {{code}} is with {{restaurant}} now.' } },
  },
  'order.accepted': {
    category: 'orders',
    pushVars: ['code', 'restaurant', 'prepMinutes'],
    pushData: ['orderId'],
    audiences: { CUSTOMER: { channels: PI, push: { title: 'Order accepted', body: '{{restaurant}} accepted order {{code}}. Ready in about {{prepMinutes}} min.' }, url: C_TRACK, tag: 'order:{orderId}' } },
  },
  'order.preparing': {
    category: 'orders',
    pushVars: ['code', 'restaurant'],
    pushData: ['orderId'],
    audiences: { CUSTOMER: { channels: PI, push: { title: 'Being prepared', body: '{{restaurant}} is preparing order {{code}}.' }, url: C_TRACK, urgency: 'low', tag: 'order:{orderId}' } },
    msg: { CUSTOMER: { title: 'Your order is being prepared', body: '{{restaurant}} is preparing order {{code}}.' } },
  },
  'order.rejected': {
    category: 'orders',
    pushVars: ['code', 'restaurant'],
    pushData: ['orderId'],
    audiences: { CUSTOMER: { channels: ['PUSH', 'SMS', 'IN_APP'], push: { title: 'Order declined', body: '{{restaurant}} could not take order {{code}}. Your payment is refunded in full.' }, url: C_TRACK, urgency: 'high', tag: 'order:{orderId}' } },
  },
  'order.ready': {
    category: 'orders',
    pushVars: ['code', 'restaurant'],
    pushData: ['orderId'],
    audiences: {
      CUSTOMER: { channels: PI, push: { title: 'Your order is ready', body: 'Order {{code}} is ready.' }, url: C_TRACK, tag: 'order:{orderId}' },
      DRIVER: { channels: PI, push: { title: 'Order ready for pickup', body: 'Order {{code}} is ready at {{restaurant}}.' }, url: D_HOME, urgency: 'high', tag: 'order:{orderId}' },
    },
  },
  'order.picked_up': {
    category: 'orders',
    pushVars: ['code', 'driverName'],
    pushData: ['orderId'],
    audiences: {
      CUSTOMER: { channels: PI, push: { title: 'Order picked up', body: 'Your driver picked up order {{code}} and is heading your way.' }, url: C_TRACK, tag: 'order:{orderId}' },
      RESTAURANT: { channels: IA, push: { title: 'Order picked up', body: 'The driver picked up order {{code}}.' }, url: R_ORDER, urgency: 'low', tag: 'order:{orderId}' },
    },
    msg: { RESTAURANT: { title: 'Order {{code}} picked up', body: '{{driverName}} picked up order {{code}}.' } },
  },
  'order.on_the_way': {
    category: 'orders',
    pushVars: ['code', 'eta'],
    pushData: ['orderId'],
    audiences: { CUSTOMER: { channels: PI, push: { title: 'On the way', body: 'Order {{code}} is on its way. {{eta}}' }, url: C_TRACK, tag: 'order:{orderId}' } },
    msg: { CUSTOMER: { title: 'Your order is on the way', body: 'Order {{code}} is on its way. {{eta}}' } },
  },
  'order.delivered': {
    category: 'orders',
    pushVars: ['code', 'earnings'],
    pushData: ['orderId'],
    audiences: {
      CUSTOMER: { channels: PIE, push: { title: 'Delivered - enjoy!', body: 'Order {{code}} was delivered. Rate your experience.' }, url: C_TRACK, tag: 'order:{orderId}' },
      DRIVER: { channels: PI, push: { title: 'Trip complete', body: 'You earned {{earnings}} for order {{code}}.' }, url: D_HOME, urgency: 'low', tag: 'order:{orderId}' },
      RESTAURANT: { channels: IA, url: R_ORDER },
    },
  },
  'order.cancelled': {
    category: 'orders',
    pushVars: ['code', 'refundNote'],
    pushData: ['orderId'],
    audiences: {
      CUSTOMER: { channels: PI, push: { title: 'Order cancelled', body: 'Order {{code}} was cancelled. {{refundNote}}' }, url: C_TRACK, urgency: 'high', tag: 'order:{orderId}' },
      RESTAURANT: { channels: PI, push: { title: 'Order {{code}} cancelled', body: 'Order {{code}} was cancelled. Stop preparing it.' }, url: R_ORDER, urgency: 'high', requireInteraction: true, tag: 'order:{orderId}' },
      DRIVER: { channels: PI, push: { title: 'Order {{code}} cancelled', body: 'Order {{code}} was cancelled. You will be compensated where applicable.' }, url: D_HOME, urgency: 'high', requireInteraction: true, tag: 'order:{orderId}' },
    },
  },
  'order.item_removed': {
    category: 'orders',
    pushVars: ['code', 'item', 'amount'],
    pushData: ['orderId'],
    audiences: { CUSTOMER: { channels: PI, push: { title: 'An item is unavailable', body: 'Order {{code}}: "{{item}}" is unavailable. Approve the change or cancel.' }, url: C_TRACK, urgency: 'high', requireInteraction: true, tag: 'order:{orderId}' } },
  },
  'order.partial_refund': {
    category: 'payments',
    pushVars: ['code', 'amount'],
    pushData: ['orderId'],
    audiences: { CUSTOMER: { channels: PI, push: { title: 'Order updated', body: 'Order {{code}} was updated and {{amount}} will be refunded.' }, url: C_TRACK } },
  },
  'order.tip_updated': {
    category: 'payments',
    pushVars: ['code', 'tip'],
    pushData: ['orderId'],
    audiences: {
      DRIVER: { channels: PI, push: { title: 'Tip updated', body: 'The tip for order {{code}} is now {{tip}}.' }, url: D_HOME, urgency: 'low' },
      CUSTOMER: { channels: IA, url: C_TRACK },
    },
    msg: { CUSTOMER: { title: 'Tip saved', body: 'Your tip for order {{code}} is now {{tip}}. Thank you!' } },
  },
  'order.late': {
    category: 'orders',
    module: Module.ORDERS,
    pushVars: ['code', 'eta'],
    pushData: ['orderId'],
    audiences: {
      CUSTOMER: { channels: PI, push: { title: 'Your order is running late', body: 'New ETA for order {{code}}: {{eta}}. Sorry for the wait.' }, url: C_TRACK, tag: 'order:{orderId}' },
      RESTAURANT: { channels: PI, push: { title: 'Order {{code}} is late', body: 'Order {{code}} is past its promised time.' }, url: R_ORDER, urgency: 'high', tag: 'order:{orderId}' },
      DRIVER: { channels: PI, push: { title: 'Order {{code}} is late', body: 'Please pick up / deliver order {{code}} as soon as possible.' }, url: D_HOME, urgency: 'high', tag: 'order:{orderId}' },
      ADMIN: { channels: PI, push: { title: 'Late order {{code}}', body: 'Order {{code}} is running late.' }, url: A_ORDER, tag: 'late:{orderId}' },
    },
  },
  'order.prep_overdue': {
    category: 'orders',
    pushVars: ['code', 'minutes'],
    pushData: ['orderId'],
    audiences: { RESTAURANT: { channels: PI, push: { title: 'Order {{code}} is overdue', body: 'The prep time for order {{code}} has passed. Mark it ready or extend the time.' }, url: R_ORDER, urgency: 'high', tag: 'order:{orderId}' } },
    msg: { RESTAURANT: { title: 'Order {{code}} is overdue', body: 'The prep time for order {{code}} has passed. Mark it ready or extend the time.' } },
  },
  'order.no_driver': {
    category: 'delivery',
    module: Module.ORDERS,
    pushVars: ['code'],
    pushData: ['orderId'],
    audiences: {
      CUSTOMER: { channels: PI, push: { title: 'Small delay finding a driver', body: 'We are still looking for a driver for order {{code}}.' }, url: C_TRACK, tag: 'order:{orderId}' },
      RESTAURANT: { channels: IA, url: R_ORDER },
      ADMIN: { channels: PI, push: { title: 'No driver found: {{code}}', body: 'Order {{code}} has no driver after escalation. Assign one manually.' }, url: A_ORDER, urgency: 'high', requireInteraction: true, tag: 'nodriver:{orderId}' },
    },
  },
  'order.stuck': {
    category: 'orders',
    module: Module.ORDERS,
    pushVars: ['code'],
    pushData: ['orderId'],
    audiences: { ADMIN: { channels: PI, push: { title: 'Order {{code}} needs attention', body: 'Open the order for details.' }, url: A_ORDER, urgency: 'high', tag: 'stuck:{orderId}' } },
  },
  'order.cancel_requested': {
    category: 'orders',
    pushVars: ['code'],
    pushData: ['orderId'],
    audiences: { RESTAURANT: { channels: PI, push: { title: 'Cancellation request: order {{code}}', body: 'FORKY support asks to cancel order {{code}}. Approve or decline in your portal.' }, url: R_ORDER, critical: true, urgency: 'high', requireInteraction: true, tag: 'cancelreq:{orderId}', ttl: 900 } },
  },
  'order.cancel_request_answered': {
    category: 'orders',
    module: Module.ORDERS,
    pushVars: ['code', 'decision'],
    pushData: ['orderId'],
    audiences: { ADMIN: { channels: PI, push: { title: 'Cancellation request {{decision}}', body: 'The restaurant {{decision}} the cancellation of order {{code}}.' }, url: A_ORDER, tag: 'cancelreq:{orderId}' } },
  },
  'order.reassigned': {
    category: 'delivery',
    pushVars: ['code'],
    pushData: ['orderId'],
    audiences: { DRIVER: { channels: PI, push: { title: 'Order {{code}} reassigned', body: 'Order {{code}} was moved to another driver. You can go back online.' }, url: D_HOME, urgency: 'high', requireInteraction: true, tag: 'order:{orderId}' } },
    msg: { DRIVER: { title: 'Order {{code}} reassigned', body: 'Order {{code}} was moved to another driver. {{reason}}' } },
  },
  'offer.accepted': {
    category: 'delivery',
    pushVars: ['code'],
    pushData: ['orderId'],
    audiences: { DRIVER: { channels: IA, url: D_HOME } },
    msg: { DRIVER: { title: 'You got the order', body: 'Order {{code}} is yours. Head to the restaurant.' } },
  },

  // ------------------------------------------------------------------ delivery
  'driver.offer': {
    category: 'delivery',
    pushVars: ['restaurant', 'pickupKm', 'dropKm', 'pay', 'seconds'],
    pushData: ['offerId', 'orderId', 'seconds', 'expiresAt'],
    audiences: { DRIVER: { channels: PI, push: { title: 'New delivery offer', body: '{{restaurant}} - {{pickupKm}} km to pickup. Est. pay {{pay}}. Respond in {{seconds}}s.' }, url: '/driver-demo.html?offer={offerId}', critical: true, urgency: 'high', requireInteraction: true, tag: 'offer:{offerId}', ttl: 60 } },
  },
  'driver.offer_expired': {
    category: 'delivery',
    pushVars: ['restaurant'],
    pushData: ['offerId', 'orderId'],
    audiences: { DRIVER: { channels: PI, push: { title: 'Offer expired', body: 'The delivery offer expired. Stay online for the next one.' }, url: D_HOME, urgency: 'low', tag: 'offer:{offerId}', ttl: 300 } },
    msg: { DRIVER: { title: 'Offer expired', body: 'The delivery offer from {{restaurant}} expired. Stay online for the next one.' } },
  },
  'driver.offer_cancelled': {
    category: 'delivery',
    pushVars: ['restaurant'],
    pushData: ['offerId', 'orderId'],
    audiences: { DRIVER: { channels: PI, push: { title: 'Offer cancelled', body: 'The delivery offer is no longer available.' }, url: D_HOME, urgency: 'low', tag: 'offer:{offerId}', ttl: 300 } },
    msg: { DRIVER: { title: 'Offer cancelled', body: 'The delivery offer from {{restaurant}} is no longer available.' } },
  },
  'driver.waiting': {
    category: 'delivery',
    pushVars: ['code'],
    pushData: ['orderId'],
    audiences: { RESTAURANT: { channels: PI, push: { title: 'Driver is waiting: order {{code}}', body: 'The driver for order {{code}} is waiting. Hand the order over now.' }, url: R_ORDER, urgency: 'high', requireInteraction: true, tag: 'order:{orderId}' } },
  },
  'wait.fee_charged': {
    category: 'payments',
    pushVars: ['code', 'minutes', 'amount'],
    pushData: ['orderId'],
    audiences: {
      RESTAURANT: { channels: PI, push: { title: 'Driver wait charge: order {{code}}', body: 'The driver waited {{minutes}} min for order {{code}}. {{amount}} is deducted from your payout.' }, url: R_ORDER, urgency: 'normal' },
      DRIVER: { channels: PI, push: { title: 'Wait-time pay: order {{code}}', body: 'You earned {{amount}} for waiting {{minutes}} min at the restaurant.' }, url: D_HOME, urgency: 'normal' },
    },
  },
  'driver.assigned': {
    category: 'delivery',
    pushVars: ['code', 'driverName', 'vehicle', 'etaMinutes'],
    pushData: ['orderId'],
    audiences: {
      CUSTOMER: { channels: PI, push: { title: 'Driver on the way to the restaurant', body: '{{driverName}} ({{vehicle}}) will pick up your order {{code}}.' }, url: C_TRACK, tag: 'order:{orderId}' },
      RESTAURANT: { channels: PI, push: { title: 'Driver assigned', body: '{{driverName}} is coming for order {{code}}.' }, url: R_ORDER, urgency: 'low', tag: 'order:{orderId}' },
    },
  },
  'driver.arrived_restaurant': {
    category: 'delivery',
    pushVars: ['code', 'driverName', 'restaurant'],
    pushData: ['orderId'],
    audiences: {
      CUSTOMER: { channels: PI, push: { title: 'Driver at the restaurant', body: '{{driverName}} has arrived at {{restaurant}} for order {{code}}.' }, url: C_TRACK, urgency: 'low', tag: 'order:{orderId}' },
      RESTAURANT: { channels: PI, push: { title: 'Driver is here', body: '{{driverName}} has arrived for order {{code}}.' }, url: R_ORDER, urgency: 'high', requireInteraction: true, tag: 'order:{orderId}' },
    },
    msg: {
      CUSTOMER: { title: 'Driver at the restaurant', body: '{{driverName}} has arrived at {{restaurant}} for order {{code}}.' },
      RESTAURANT: { title: 'Driver is here', body: '{{driverName}} has arrived to pick up order {{code}}.' },
    },
  },
  'delivery.driver_arrived': {
    category: 'delivery',
    pushVars: ['code', 'methodNote'],
    pushData: ['orderId'],
    audiences: { CUSTOMER: { channels: PI, push: { title: 'Your driver has arrived', body: 'Order {{code}}: {{methodNote}}' }, url: C_TRACK, urgency: 'high', requireInteraction: true, tag: 'order:{orderId}' } },
  },
  'delivery.left_at_door': {
    category: 'delivery',
    pushVars: ['code'],
    pushData: ['orderId'],
    audiences: { CUSTOMER: { channels: PI, push: { title: 'Your order was left at your door', body: 'Order {{code}} was left at your door. A photo was saved in the app.' }, url: C_TRACK, urgency: 'high', tag: 'order:{orderId}' } },
  },
  'delivery.instructions_changed': {
    category: 'delivery',
    pushVars: ['code'],
    pushData: ['orderId'],
    audiences: { DRIVER: { channels: PI, push: { title: 'Delivery instructions updated', body: 'The customer changed the instructions for order {{code}}. Open the app to read them.' }, url: D_HOME, urgency: 'high', tag: 'order:{orderId}' } },
  },
  'driver.supply_alert': {
    category: 'delivery',
    pushVars: ['zone', 'boost'],
    pushData: ['zoneId'],
    audiences: { DRIVER: { channels: PI, push: { title: 'Extra pay is live near you', body: 'Demand is high in your area. Go online for a boost.' }, url: D_HOME, urgency: 'normal', tag: 'supply', ttl: 1800 } },
  },
  'driver.welcome': {
    category: 'system',
    audiences: { DRIVER: { channels: PI, push: { title: 'Welcome to FORKY!', body: 'Your account is active. Go online in your zones to start earning.' }, url: D_HOME } },
  },

  // ------------------------------------------------------------------ payments
  'refund.issued': {
    category: 'payments',
    pushVars: ['code', 'amount'],
    pushData: ['orderId'],
    audiences: { CUSTOMER: { channels: PIE, push: { title: 'Refund issued', body: 'We refunded {{amount}} for order {{code}}.' }, url: C_TRACK } },
  },
  'refund.rejected': {
    category: 'payments',
    pushVars: ['code'],
    pushData: ['orderId'],
    audiences: { CUSTOMER: { channels: PI, push: { title: 'Refund request update', body: 'Your refund request for order {{code}} was not approved.' }, url: C_TRACK } },
  },
  'credit.issued': {
    category: 'payments',
    pushVars: ['amount'],
    audiences: { CUSTOMER: { channels: PI, push: { title: 'FORKY credit added', body: '{{amount}} of credit was added to your wallet.' }, url: '/order/notifications' } },
  },
  'refund.pending_approval': {
    category: 'payments',
    module: Module.FINANCE,
    pushVars: ['code', 'amount'],
    pushData: ['orderId'],
    audiences: { ADMIN: { channels: PI, push: { title: 'Refund needs approval', body: 'A refund on order {{code}} is waiting for approval.' }, url: '/finance/refunds', tag: 'refundapproval:{orderId}' } },
  },
  'finance.refund_pending': {
    category: 'payments',
    module: Module.FINANCE,
    pushVars: ['code', 'amount'],
    audiences: { ADMIN: { channels: PI, push: { title: 'Refund awaiting approval', body: 'A refund on order {{code}} needs approval.' }, url: '/finance/refunds' } },
  },
  'payment.failed': {
    category: 'payments',
    module: Module.FINANCE,
    pushVars: ['code'],
    pushData: ['orderId'],
    audiences: { ADMIN: { channels: PI, push: { title: 'Payment problem', body: 'Order {{code}} has a payment problem. Open the order.' }, url: A_ORDER, urgency: 'high', tag: 'payfail:{orderId}' } },
  },
  'payment.issue': {
    category: 'payments',
    pushVars: ['code'],
    pushData: ['orderId'],
    audiences: { CUSTOMER: { channels: PI, push: { title: 'Payment problem', body: 'We could not complete the payment for order {{code}}. Please check your payment method.' }, url: C_TRACK, urgency: 'high', requireInteraction: true, tag: 'payfail:{orderId}' } },
    msg: { CUSTOMER: { title: 'Payment problem', body: 'We could not complete the payment for order {{code}}. Please check your payment method or contact support.' } },
  },
  'payout.sent': {
    category: 'payments',
    pushVars: ['amount', 'period'],
    audiences: {
      RESTAURANT: { channels: PIE, push: { title: 'Payout sent', body: 'Your payout of {{amount}} for {{period}} has been sent.' }, url: '/portal/finance', urgency: 'normal' },
      DRIVER: { channels: PIE, push: { title: 'Payout sent', body: 'Your payout of {{amount}} has been sent.' }, url: D_HOME, urgency: 'normal' },
    },
  },
  'finance.payout_failed': {
    category: 'payments',
    module: Module.FINANCE,
    pushVars: ['party'],
    audiences: { ADMIN: { channels: PI, push: { title: 'Payout failed', body: 'A payout to {{party}} failed. Open Finance for details.' }, url: '/finance/payouts', urgency: 'high' } },
    msg: { ADMIN: { title: 'Payout failed', body: 'Payout to {{party}} ({{amount}}) failed: {{reason}}' } },
  },
  'finance.payout_waiting_account': {
    category: 'payments',
    module: Module.FINANCE,
    audiences: { ADMIN: { channels: IA, url: '/finance/payouts' } },
  },
  'finance.dispute': {
    category: 'payments',
    module: Module.FINANCE,
    pushVars: ['status', 'code'],
    audiences: { ADMIN: { channels: PI, push: { title: 'Card dispute (chargeback)', body: 'A card dispute was {{status}} on order {{code}}. Respond before the deadline in Stripe.' }, url: '/finance/refunds', urgency: 'high', requireInteraction: true, tag: 'dispute' } },
  },
  'finance.stripe_alert': {
    category: 'payments',
    module: Module.FINANCE,
    audiences: { ADMIN: { channels: PI, push: { title: 'Stripe payment alert', body: 'Open System > Integrations or Finance for details.' }, url: '/finance', urgency: 'high', tag: 'stripealert' } },
  },
  'payout.account_not_ready': {
    category: 'payments',
    pushVars: ['amount'],
    audiences: {
      RESTAURANT: { channels: PIE, push: { title: 'Finish your payout account', body: 'Money is waiting for you. Finish the payout account setup to receive it.' }, url: '/portal/finance', urgency: 'normal' },
      DRIVER: { channels: PIE, push: { title: 'Finish your payout account', body: 'Money is waiting for you. Finish the payout account setup to receive it.' }, url: D_HOME, urgency: 'normal' },
    },
  },
  'payout.bank_failed': {
    category: 'payments',
    audiences: {
      RESTAURANT: { channels: PIE, push: { title: 'Payout failed at the bank', body: 'Your payout could not be delivered. Check your bank details.' }, url: '/portal/finance', urgency: 'high' },
      DRIVER: { channels: PIE, push: { title: 'Payout failed at the bank', body: 'Your payout could not be delivered. Check your bank details.' }, url: D_HOME, urgency: 'high' },
    },
  },
  'finance.batch_draft': { category: 'payments', module: Module.FINANCE, audiences: { ADMIN: { channels: IA, url: '/finance/batches' } } },
  'finance.batch_ready': {
    category: 'payments',
    module: Module.FINANCE,
    audiences: { ADMIN: { channels: IA, url: '/finance/batches' } },
    msg: { ADMIN: { title: 'Payout batch ready', body: 'Payout batch for {{period}} is ready for review ({{total}}).' } },
  },
  'finance.reconciliation_gap': {
    category: 'payments',
    module: Module.FINANCE,
    audiences: { ADMIN: { channels: PI, push: { title: 'Reconciliation gap', body: 'A payout batch has a reconciliation gap. Open Finance.' }, url: '/finance/batches', urgency: 'high' } },
    msg: { ADMIN: { title: 'Reconciliation gap', body: 'Payout batch {{period}} has a reconciliation gap of {{gap}}.' } },
  },

  // ------------------------------------------------------------------ support
  'ticket.update': {
    category: 'support',
    module: Module.SUPPORT,
    pushVars: ['number'],
    pushData: ['ticketId'],
    audiences: {
      CUSTOMER: { channels: PI, push: { title: 'Support update', body: 'There is an update on ticket {{number}}.' }, url: '/order/notifications', tag: 'ticket:{ticketId}' },
      RESTAURANT: { channels: PI, push: { title: 'Support update', body: 'There is an update on ticket {{number}}.' }, url: '/portal', tag: 'ticket:{ticketId}' },
      DRIVER: { channels: PI, push: { title: 'Support update', body: 'There is an update on ticket {{number}}.' }, url: D_HOME, tag: 'ticket:{ticketId}' },
      ADMIN: { channels: PI, push: { title: 'Ticket {{number}}', body: 'A support ticket was created, escalated or updated.' }, url: A_TICKET, tag: 'ticket:{ticketId}' },
    },
  },
  'chat.message': {
    category: 'support',
    pushData: ['chatSessionId', 'ticketId'],
    audiences: {
      CUSTOMER: { channels: PI, push: { title: 'FORKY Support replied', body: 'You have a new message from support.' }, url: '/order/notifications', urgency: 'high', tag: 'chat:{chatSessionId}' },
      RESTAURANT: { channels: PI, push: { title: 'FORKY Support replied', body: 'You have a new message from support.' }, url: '/portal', urgency: 'high', tag: 'chat:{chatSessionId}' },
      DRIVER: { channels: PI, push: { title: 'FORKY Support replied', body: 'You have a new message from support.' }, url: D_HOME, urgency: 'high', tag: 'chat:{chatSessionId}' },
    },
  },
  'chat.waiting': {
    category: 'support',
    module: Module.SUPPORT,
    pushVars: ['who'],
    pushData: ['sessionId'],
    audiences: { ADMIN: { channels: PI, push: { title: 'Customer waiting in live chat', body: 'Someone is waiting for an agent.' }, url: '/support/chat', urgency: 'high', requireInteraction: true, tag: 'chatwait:{sessionId}' } },
    msg: { ADMIN: { title: 'Live chat waiting', body: '{{who}} is waiting for an agent in live chat.' } },
  },
  'sos.alert': {
    category: 'support',
    module: Module.DRIVERS,
    pushData: ['driverId', 'orderId'],
    audiences: { ADMIN: { channels: PI, push: { title: 'SOS: driver needs help', body: 'A driver triggered the safety button. Open the SOS board now.' }, url: '/driver-ops/sos', critical: true, urgency: 'high', requireInteraction: true, tag: 'sos:{sosId}', ttl: 3600 } },
  },
  'sos.acknowledged': {
    category: 'support',
    audiences: { DRIVER: { channels: PI, push: { title: 'Help is on the way', body: 'Dispatch has your SOS alert and is responding.' }, url: D_HOME, critical: true, urgency: 'high', requireInteraction: true, tag: 'sos', ttl: 3600 } },
  },

  // ------------------------------------------------------------------ ratings / reviews
  'rating.prompt': {
    category: 'orders',
    pushVars: ['code', 'restaurant'],
    pushData: ['orderId'],
    audiences: { CUSTOMER: { channels: PI, push: { title: 'How was your order?', body: 'Tell us about order {{code}} from {{restaurant}}. It takes 10 seconds.' }, url: C_TRACK, urgency: 'low', ttl: 86400, tag: 'rate:{orderId}' } },
  },
  'rating.reminder': {
    category: 'orders',
    pushVars: ['code', 'restaurant'],
    pushData: ['orderId'],
    audiences: { CUSTOMER: { channels: PI, push: { title: 'Still thinking about {{restaurant}}?', body: 'Rate order {{code}} - your feedback helps other customers.' }, url: C_TRACK, urgency: 'very-low', ttl: 86400, tag: 'rate:{orderId}' } },
  },
  'rating.prompt_partner': {
    category: 'orders',
    pushVars: ['code'],
    pushData: ['orderId'],
    audiences: {
      DRIVER: { channels: IA, url: D_HOME },
      RESTAURANT: { channels: IA, url: R_ORDER },
    },
  },
  'rating.driver_warn': {
    category: 'orders',
    module: Module.DRIVERS,
    audiences: {
      DRIVER: { channels: PI, push: { title: 'Your rating needs attention', body: 'Your recent rating is below target. Open the app for tips.' }, url: D_HOME, urgency: 'low' },
      ADMIN: { channels: IA, url: '/analytics/ratings' },
    },
  },
  'rating.restaurant_warn': {
    category: 'orders',
    module: Module.RESTAURANTS,
    audiences: {
      RESTAURANT: { channels: PI, push: { title: 'Your rating needs attention', body: 'Your recent rating is below target. Open the portal for tips.' }, url: '/portal/reviews', urgency: 'normal' },
      ADMIN: { channels: IA, url: '/analytics/ratings' },
    },
  },
  'rating.customer_safety': { category: 'support', module: Module.CUSTOMERS, audiences: { ADMIN: { channels: IA, url: '/customers' } } },
  'review.received': {
    category: 'orders',
    pushVars: ['rating', 'code'],
    pushData: ['reviewId', 'orderId'],
    audiences: { RESTAURANT: { channels: PI, push: { title: 'New review', body: 'A customer left a {{rating}}-star review.' }, url: '/portal/reviews', urgency: 'low', tag: 'review:{reviewId}' } },
    msg: { RESTAURANT: { title: 'New review', body: 'A customer left a {{rating}}-star review for order {{code}}.' } },
  },
  'review.reply': {
    category: 'orders',
    pushVars: ['restaurant'],
    pushData: ['orderId'],
    audiences: { CUSTOMER: { channels: PI, push: { title: 'The restaurant replied to your review', body: 'Open FORKY to read the reply.' }, url: C_TRACK, urgency: 'low' } },
  },
  'review.flagged': { category: 'orders', module: Module.RESTAURANTS, audiences: { ADMIN: { channels: IA, url: '/restaurants/reviews' } } },
  'review.reported': { category: 'orders', module: Module.RESTAURANTS, audiences: { ADMIN: { channels: IA, url: '/restaurants/reviews' } } },

  // ------------------------------------------------------------------ accounts, documents, menu, store
  'account.approved': {
    category: 'system',
    pushVars: ['name'],
    audiences: {
      RESTAURANT: { channels: PIE, push: { title: 'You are live on FORKY', body: 'Your store is now live. Welcome aboard!' }, url: '/portal' },
      DRIVER: { channels: PIE, push: { title: 'You are approved!', body: 'Welcome to FORKY. You can go online in your approved zones.' }, url: D_HOME },
    },
  },
  'account.rejected': {
    category: 'system',
    pushVars: ['name'],
    audiences: {
      RESTAURANT: { channels: PIE, push: { title: 'Application update', body: 'There is an update on your application. Open the portal.' }, url: '/portal' },
      DRIVER: { channels: PIE, push: { title: 'Application update', body: 'There is an update on your application. Open the app.' }, url: D_HOME },
    },
  },
  'account.deactivation_notice': {
    category: 'system',
    pushVars: ['respondBy'],
    audiences: {
      RESTAURANT: { channels: PIE, push: { title: 'Account review notice', body: 'Your store is under review. Please respond by {{respondBy}}.' }, url: '/portal', urgency: 'high', requireInteraction: true },
      DRIVER: { channels: PIE, push: { title: 'Account review notice', body: 'Your account is under review. Please respond by {{respondBy}}.' }, url: D_HOME, urgency: 'high', requireInteraction: true },
    },
  },
  'document.expiring': {
    category: 'system',
    module: Module.RESTAURANTS,
    pushVars: ['docType', 'expiresAt', 'days'],
    audiences: {
      RESTAURANT: { channels: PIE, push: { title: 'Document expiring', body: 'Your {{docType}} is about to expire. Upload a new one to stay live.' }, url: '/portal/store', urgency: 'normal' },
      DRIVER: { channels: PIE, push: { title: 'Document expiring', body: 'Your {{docType}} is about to expire. Upload a renewed copy to keep driving.' }, url: D_HOME, urgency: 'normal' },
      ADMIN: { channels: IA, url: '/driver-documents/expiring' },
    },
  },
  'document.expired': {
    category: 'system',
    module: Module.DRIVERS,
    pushVars: ['docType'],
    audiences: {
      DRIVER: { channels: PIE, push: { title: 'Document expired', body: 'Your {{docType}} has expired. Upload a renewed copy to keep driving.' }, url: D_HOME, urgency: 'high' },
      ADMIN: { channels: IA, url: '/driver-documents/expiring' },
    },
    msg: { DRIVER: { title: 'Document expired', body: 'Your {{docType}} has expired. Upload a renewed copy to keep driving.' }, ADMIN: { title: 'Driver document expired', body: 'A driver document expired ({{docType}}).' } },
  },
  'document.rejected': {
    category: 'system',
    pushVars: ['docType'],
    audiences: { DRIVER: { channels: PI, push: { title: 'Document rejected', body: 'Your {{docType}} was rejected. Open the app to upload a corrected copy.' }, url: D_HOME, urgency: 'high' } },
    msg: { DRIVER: { title: 'Document rejected', body: 'Your {{docType}} was rejected: {{reason}}' } },
  },
  'restaurant.document_rejected': {
    category: 'system',
    audiences: { RESTAURANT: { channels: PI, push: { title: 'A document was rejected', body: 'Open the portal to upload a corrected copy.' }, url: '/portal/store', urgency: 'high' } },
    msg: { RESTAURANT: { title: 'A document was rejected', body: 'One of your documents was rejected. Please upload a corrected copy.' } },
  },
  'document.uploaded': { category: 'system', module: Module.DRIVERS, audiences: { ADMIN: { channels: IA, url: '/driver-pipeline' } }, msg: { ADMIN: { title: 'Driver document uploaded', body: 'A driver uploaded a document for review.' } } },
  'restaurant.document_uploaded': { category: 'system', module: Module.RESTAURANTS, audiences: { ADMIN: { channels: IA, url: '/restaurants/onboarding' } }, msg: { ADMIN: { title: 'Restaurant document uploaded', body: '{{name}} uploaded {{docType}} for review.' } } },
  'driver.applied': { category: 'system', module: Module.DRIVERS, audiences: { ADMIN: { channels: PI, push: { title: 'New driver application', body: 'A new driver applied. Review it in the pipeline.' }, url: '/driver-pipeline', urgency: 'low' } }, msg: { ADMIN: { title: 'New driver application', body: '{{name}} applied to drive.' } } },
  'restaurant.applied': { category: 'system', module: Module.RESTAURANTS, audiences: { ADMIN: { channels: PI, push: { title: 'New restaurant application', body: 'A new restaurant applied. Review it in onboarding.' }, url: '/restaurants/onboarding', urgency: 'low' } }, msg: { ADMIN: { title: 'New restaurant application', body: '{{name}} applied to join FORKY.' } } },
  'driver.training_completed': { category: 'system', module: Module.DRIVERS, audiences: { ADMIN: { channels: IA, url: '/driver-training' } } },
  'driver.background_check': { category: 'system', module: Module.DRIVERS, audiences: { ADMIN: { channels: IA, url: '/driver-pipeline' } } },
  // ------------------------------------------------------------------ registration and verification (docs/verification.md)
  'verification.required': {
    category: 'system',
    pushVars: ['deadline'],
    audiences: {
      DRIVER: { channels: PIE, push: { title: 'Verification required', body: 'Please verify your account{{deadline}}. Open the app to see how.' }, url: D_HOME, urgency: 'high' },
      RESTAURANT: { channels: PIE, push: { title: 'Verification required', body: 'Please verify your business{{deadline}}. Open the portal to see how.' }, url: '/portal', urgency: 'high' },
    },
    msg: {
      DRIVER: { title: 'Verification required', body: 'We need to verify your driver account{{deadline}}. {{steps}}' },
      RESTAURANT: { title: 'Verification required', body: 'We need to verify your business{{deadline}}. {{steps}}' },
    },
  },
  'verification.verified': {
    category: 'system',
    audiences: {
      DRIVER: { channels: PIE, push: { title: 'You are verified', body: 'Thank you: your account is verified.' }, url: D_HOME },
      RESTAURANT: { channels: PIE, push: { title: 'You are verified', body: 'Thank you: your business is verified.' }, url: '/portal' },
    },
    msg: {
      DRIVER: { title: 'You are verified', body: 'Your driver account is verified. Thank you!' },
      RESTAURANT: { title: 'You are verified', body: '{{name}} is verified. Thank you!' },
    },
  },
  'driver.instant_activated': {
    category: 'system',
    module: Module.DRIVERS,
    audiences: { ADMIN: { channels: IA, url: '/drivers' } },
    msg: { ADMIN: { title: 'New driver, active but unverified', body: '{{name}} signed up and is active straight away (instant registration). Verify them from the driver page or force verification.' } },
  },
  'restaurant.instant_activated': {
    category: 'system',
    module: Module.RESTAURANTS,
    audiences: { ADMIN: { channels: IA, url: '/restaurants' } },
    msg: { ADMIN: { title: 'New restaurant, live but unverified', body: '{{name}} signed up and is live straight away (instant registration). Verify it from the restaurant page or force verification.' } },
  },
  'restaurant.background_check': {
    category: 'system',
    module: Module.RESTAURANTS,
    audiences: { ADMIN: { channels: IA, url: '/restaurants/merchants' } },
    msg: { ADMIN: { title: 'Owner background check {{status}}', body: '{{name}}: the background check of the owner is {{status}}.' } },
  },
  'menu.access_requested': { category: 'system', module: Module.RESTAURANTS, audiences: { ADMIN: { channels: IA, url: '/restaurants/menu-access' } } },
  'menu.access_decided': {
    category: 'system',
    pushVars: ['decision', 'name'],
    audiences: { RESTAURANT: { channels: PI, push: { title: 'Menu editing {{decision}}', body: 'FORKY has {{decision}} menu editing for {{name}}.' }, url: '/portal/menu' } },
  },
  'menu.approved': {
    category: 'system',
    audiences: { RESTAURANT: { channels: PI, push: { title: 'Menu approved', body: 'Your menu was approved. Next: complete a test order to go live.' }, url: '/portal/menu' } },
  },
  'menu.changes_requested': {
    category: 'system',
    audiences: { RESTAURANT: { channels: PI, push: { title: 'Menu changes requested', body: 'Please update your menu so we can continue onboarding.' }, url: '/portal/menu' } },
  },
  'menu.item_restocked': {
    category: 'system',
    pushVars: ['count', 'items'],
    audiences: { RESTAURANT: { channels: PI, push: { title: 'Items are available again', body: '{{items}} came back automatically after being marked out of stock.' }, url: '/portal/menu', urgency: 'low', tag: 'restock' } },
    msg: { RESTAURANT: { title: 'Items are available again', body: '{{items}} came back automatically after being marked out of stock.' } },
  },
  'store.paused': {
    category: 'system',
    pushVars: ['mode', 'resumeAt'],
    audiences: { RESTAURANT: { channels: PI, push: { title: 'Your store is not taking orders', body: '{{mode}}' }, url: '/portal/store', urgency: 'high', tag: 'storemode' } },
    msg: { RESTAURANT: { title: 'Your store is not taking orders', body: '{{mode}}' } },
  },
  'store.resumed': {
    category: 'system',
    pushVars: ['mode'],
    audiences: { RESTAURANT: { channels: PI, push: { title: 'Your store is open again', body: '{{mode}}' }, url: '/portal/store', urgency: 'normal', tag: 'storemode' } },
    msg: { RESTAURANT: { title: 'Your store is open again', body: '{{mode}}' } },
  },
  'assistant.training.requested': {
    category: 'system',
    audiences: { ADMIN: { channels: PI, push: { title: 'Bot training approval needed', body: 'A restaurant asks to publish its trained bot. Review it in Assistant > Training.' }, url: '/assistant/restaurants', urgency: 'low', tag: 'bottraining' } },
    msg: { ADMIN: { title: 'Bot training approval: {{name}}', body: '{{name}} asks to publish its trained bot ({{entries}} answers). Review it in Assistant > Training.' } },
  },
  'assistant.training.decided': {
    category: 'system',
    pushVars: ['decision'],
    audiences: { RESTAURANT: { channels: PI, push: { title: 'Bot training {{decision}}', body: 'FORKY reviewed your trained bot. Open the portal for the details.' }, url: '/portal/assistant', urgency: 'normal' } },
    msg: { RESTAURANT: { title: 'Bot training {{decision}}', body: 'FORKY reviewed your trained bot: {{decision}}. {{note}}' } },
  },
  'promo.pending': { category: 'system', module: Module.PROMOTIONS, audiences: { ADMIN: { channels: IA, url: '/promotions' } } },
  'promo.approved': {
    category: 'promotions',
    pushVars: ['name'],
    audiences: { RESTAURANT: { channels: PI, push: { title: 'Promotion approved', body: 'Your promotion "{{name}}" was approved and is now live.' }, url: '/portal/promotions', urgency: 'low' } },
  },
  'promo.rejected': {
    category: 'promotions',
    pushVars: ['name'],
    audiences: { RESTAURANT: { channels: PI, push: { title: 'Promotion not approved', body: 'Your promotion "{{name}}" was not approved.' }, url: '/portal/promotions', urgency: 'low' } },
  },
  'campaign.message': {
    category: 'promotions',
    marketing: true,
    pushVars: ['title', 'body'],
    audiences: {
      CUSTOMER: { channels: PI, push: { title: '{{title}}', body: '{{body}}' }, url: '/order', urgency: 'very-low', ttl: 86400 },
      DRIVER: { channels: PI, push: { title: '{{title}}', body: '{{body}}' }, url: D_HOME, urgency: 'very-low', ttl: 86400 },
      RESTAURANT: { channels: PI, push: { title: '{{title}}', body: '{{body}}' }, url: '/portal', urgency: 'very-low', ttl: 86400 },
    },
  },
  'incident.opened': { category: 'system', module: Module.OPERATIONS, audiences: { ADMIN: { channels: PI, push: { title: 'Incident opened', body: 'A platform incident was opened. Open the incident board.' }, url: '/incidents', urgency: 'high', requireInteraction: true } } },
  'incident.resolved': { category: 'system', module: Module.OPERATIONS, audiences: { ADMIN: { channels: IA, url: '/incidents' } } },
  'case.opened': { category: 'support', module: Module.SUPPORT, audiences: { ADMIN: { channels: IA, url: '/support/cases' } } },
  'proof.exception': { category: 'orders', module: Module.ORDERS, audiences: { ADMIN: { channels: IA, url: '/orders' } } },
  'otp.code': {
    category: 'system',
    noPush: true,
    audiences: { CUSTOMER: { channels: IA }, DRIVER: { channels: IA }, RESTAURANT: { channels: IA }, ADMIN: { channels: IA } },
  },
  'notification.test': {
    category: 'system',
    pushVars: ['message'],
    audiences: {
      CUSTOMER: { channels: PI, push: { title: 'FORKY test notification', body: '{{message}}' }, url: '/order/notifications', urgency: 'normal', tag: 'test' },
      RESTAURANT: { channels: PI, push: { title: 'FORKY test notification', body: '{{message}}' }, url: '/portal/notifications', urgency: 'normal', tag: 'test' },
      DRIVER: { channels: PI, push: { title: 'FORKY test notification', body: '{{message}}' }, url: D_HOME, urgency: 'normal', tag: 'test' },
      ADMIN: { channels: PI, push: { title: 'FORKY test notification', body: '{{message}}' }, url: '/inbox', urgency: 'normal', tag: 'test' },
    },
    msg: {
      CUSTOMER: { title: 'Test notification', body: '{{message}}' },
      RESTAURANT: { title: 'Test notification', body: '{{message}}' },
      DRIVER: { title: 'Test notification', body: '{{message}}' },
      ADMIN: { title: 'Test notification', body: '{{message}}' },
    },
  },
};

// ------------------------------------------------------------------ lookups
export const eventDef = (event: string): EventDef | undefined => EVENTS[event];
export const audienceDef = (event: string, aud: Audience): AudienceDef | undefined => EVENTS[event]?.audiences[aud];

/** Category of an event (registry, else guessed from the prefix so unknown events still land in a sensible bucket). */
export function categoryOf(event: string): Category {
  const d = EVENTS[event];
  if (d) return d.category;
  const p = event.split('.')[0];
  if (['order', 'rating', 'review'].includes(p)) return 'orders';
  if (['driver', 'delivery', 'offer'].includes(p)) return 'delivery';
  if (['refund', 'credit', 'payout', 'payment', 'finance'].includes(p)) return 'payments';
  if (['ticket', 'chat', 'sos', 'case'].includes(p)) return 'support';
  if (['campaign'].includes(p)) return 'promotions';
  return 'system';
}

/** The platform default of the `notifications.matrix` setting, derived from the registry: { event: { AUDIENCE: [channels] } }. */
export function defaultMatrix(): Record<string, Record<string, string[]>> {
  const out: Record<string, Record<string, string[]>> = {};
  for (const [event, def] of Object.entries(EVENTS)) {
    out[event] = {};
    for (const [aud, a] of Object.entries(def.audiences)) out[event][aud] = [...a!.channels];
  }
  return out;
}

/** Fill {placeholders} of a deep-link / tag template from the data; returns null when a placeholder is missing. */
export function fillTemplate(tpl: string, data: Record<string, any> = {}): string | null {
  let missing = false;
  const s = tpl.replace(/\{(\w+)\}/g, (_m, k) => {
    const v = data[k];
    if (v === undefined || v === null || v === '') {
      missing = true;
      return '';
    }
    return encodeURIComponent(String(v));
  });
  return missing ? null : s;
}

/** Deep link for a notification (relative to the web origin). Falls back to the audience's base page. */
export function urlFor(event: string, aud: Audience, data: Record<string, any> = {}): string {
  const tpl = audienceDef(event, aud)?.url;
  return (tpl && fillTemplate(tpl, data)) || BASE_URL[aud];
}

// ------------------------------------------------------------------ push sanitising (allow-list + scrub)
/** Primitive-only copy of the allow-listed data keys. */
export function pickAllowed(src: Record<string, any> | undefined | null, allow: string[] = []): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!src) return out;
  for (const k of allow) {
    const v = src[k];
    if (typeof v === 'string' && v.length <= 200) out[k] = v;
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
  }
  return out;
}

/**
 * Last line of defence on push text: removes things that look like a PIN / code, an e-mail address, a phone number or a long
 * number. The allow-list above is the real protection; this catches an admin-edited template that interpolates a free-text variable.
 */
export function scrubPush(text: string): string {
  return String(text ?? '')
    .replace(/\b(pin|passcode|pass code|access code|gate code|door code|buzzer|pickup code|verification code|otp|code)\b[\s:#=-]*\d{3,8}\b/gi, '$1 [hidden]')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/\+?\d[\d\s().-]{8,}\d/g, '[number]')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export const PUSH_BODY_MAX = 180;
export const PUSH_TITLE_MAX = 80;
export const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

export const URGENCY_TTL: Record<Urgency, number> = { high: 3600, normal: 21600, low: 43200, 'very-low': 86400 };

// ------------------------------------------------------------------ preferences model
export type ChannelToggles = { inApp: boolean; push: boolean; email: boolean; sms: boolean };
export interface QuietHours { enabled: boolean; start: string; end: string; timezone: string }
export interface Preferences {
  /** master switch for push (every device) */
  pushEnabled: boolean;
  /** critical alerts (new order for a restaurant, driver offers, SOS) ignore quiet hours */
  criticalBypassQuietHours: boolean;
  /** restaurant portal: ring / chime for new orders */
  soundEnabled: boolean;
  /** 0-100 */
  soundVolume: number;
  categories: Record<Category, ChannelToggles>;
  quietHours: QuietHours;
}

/** Channels a category can never switch off (the in-app inbox always keeps order / delivery / payment / support records). */
export const LOCKED_IN_APP: Category[] = ['orders', 'delivery', 'payments', 'support'];

export function defaultPreferences(audience: Audience): Preferences {
  const cat = (push: boolean, email = true, sms = true): ChannelToggles => ({ inApp: true, push, email, sms });
  return {
    pushEnabled: true,
    criticalBypassQuietHours: true,
    soundEnabled: true,
    soundVolume: 80,
    categories: {
      orders: cat(true),
      delivery: cat(true),
      payments: cat(true),
      support: cat(true),
      // promotions: customers opt in explicitly (CASL); staff / partners default on for push
      promotions: cat(audience !== 'CUSTOMER', audience !== 'CUSTOMER', false),
      system: cat(true),
    },
    quietHours: { enabled: false, start: '22:00', end: '07:00', timezone: 'America/Toronto' },
  };
}

/** Is `now` inside the quiet-hours window of the user (handles windows that cross midnight)? */
export function inQuietHours(q: QuietHours | undefined, now = new Date()): boolean {
  if (!q?.enabled || !/^\d{2}:\d{2}$/.test(q.start) || !/^\d{2}:\d{2}$/.test(q.end)) return false;
  let hhmm: string;
  try {
    hhmm = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: q.timezone || 'America/Toronto' }).format(now);
  } catch {
    hhmm = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Toronto' }).format(now);
  }
  const cur = hhmm.replace(/^24/, '00');
  if (q.start === q.end) return false;
  return q.start < q.end ? cur >= q.start && cur < q.end : cur >= q.start || cur < q.end;
}

export function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
