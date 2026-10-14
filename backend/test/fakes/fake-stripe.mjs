#!/usr/bin/env node
/**
 * FAKE Stripe API server for FORKY's automated tests (plain node:http, no dependencies besides the `stripe` package that is
 * already a backend dependency - it is only used to sign webhook payloads exactly like Stripe does).
 *
 *   node backend/test/fakes/fake-stripe.mjs            (port 4242, override with PORT)
 *   STRIPE_API_BASE=http://localhost:4242  STRIPE_SECRET_KEY=sk_test_fake...   -> point the FORKY API at it
 *
 * It is NOT Stripe: it implements only the endpoints FORKY calls, with realistic object shapes and state, so the code can be exercised
 * end to end without keys. Anything that only the real Stripe does (3-D Secure UI, card networks, fraud rules, real balances) is
 * simulated crudely through the /_fake/* control routes below. Everything proven against this fake still has to be re-proven with
 * real Stripe TEST keys.
 *
 * Control routes (JSON bodies):
 *   GET  /_fake/state                         everything in memory
 *   POST /_fake/reset
 *   POST /_fake/config   { incrementAuth, connectEnabled, platformBalance, autoEvents, webhookUrl, webhookSecret }
 *   POST /_fake/pm       { customer?, brand?, last4?, wallet?, instant? }   -> a payment method (as if typed in the Payment Element)
 *   POST /_fake/confirm/:pi { payment_method?, scenario?: 'ok'|'declined'|'3ds'|'3ds_fail' }   -> what Stripe.js does in the browser
 *   POST /_fake/authenticate/:pi { success? }   complete a 3-D Secure challenge
 *   POST /_fake/webhook  { type, object, account?, url?, secret?, tamper?, badSignature?, id? }   deliver a signed event
 *   POST /_fake/account/:id/complete { debitCard?, restricted? }   finish onboarding (account.updated is delivered)
 *   POST /_fake/dispute  { payment_intent, reason?, amount?, status? }   open a dispute (charge.dispute.created is delivered)
 *   POST /_fake/dispute/:id/close { status: 'won'|'lost' }
 *   POST /_fake/transfer/:id/reverse { amount? }
 *   POST /_fake/payout/:id/fail
 *   POST /_fake/fail-next { path, status?, code?, message? }   make the next call to a path fail
 *   POST /_fake/webhook-endpoint { url, enabled_events, status }
 */
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Stripe = require('stripe');
const stripeLib = new (Stripe.default ?? Stripe)('sk_test_fake_signing_only');

const PORT = Number(process.env.PORT || 4242);
const rid = (p, n = 24) => `${p}_${randomBytes(n).toString('base64url').replace(/[-_]/g, 'x').slice(0, n)}`;
const now = () => Math.floor(Date.now() / 1000);

let S;
function fresh() {
  return {
    config: { incrementAuth: false, connectEnabled: true, platformBalance: 100_000_00, autoEvents: true, webhookUrl: process.env.FAKE_WEBHOOK_URL || '', webhookSecret: process.env.FAKE_WEBHOOK_SECRET || '' },
    customers: {}, pms: {}, intents: {}, charges: {}, refunds: {}, setups: {}, accounts: {}, transfers: {}, reversals: {}, payouts: {}, disputes: {}, bts: [], events: [], idem: {}, failNext: [], webhookEndpoints: [], log: [],
  };
}
S = fresh();

// ------------------------------------------------------------------------------------------------ helpers
/** application/x-www-form-urlencoded with Stripe's bracket syntax -> nested object */
function parseForm(str) {
  const out = {};
  for (const pair of String(str).split('&')) {
    if (!pair) continue;
    const [rk, rv = ''] = pair.split('=');
    const k = decodeURIComponent(rk.replace(/\+/g, ' '));
    const v = decodeURIComponent(rv.replace(/\+/g, ' '));
    const path = k.replace(/\]/g, '').split('[');
    let cur = out;
    path.forEach((seg, i) => {
      const last = i === path.length - 1;
      const nextIsIndex = !last && /^\d*$/.test(path[i + 1]);
      if (last) cur[seg] = v;
      else {
        if (cur[seg] === undefined) cur[seg] = nextIsIndex ? [] : {};
        cur = cur[seg];
      }
    });
  }
  return out;
}
const bool = (v) => v === true || v === 'true';
const int = (v) => (v === undefined || v === '' ? undefined : Number(v));
const arr = (v) => (Array.isArray(v) ? v : v === undefined ? [] : Object.values(v));

class Err extends Error {
  constructor(status, type, code, message, param) {
    super(message);
    this.status = status; this.type = type; this.code = code; this.param = param;
  }
}
const bad = (message, code = 'parameter_invalid_empty', param) => new Err(400, 'invalid_request_error', code, message, param);
const missing = (id, what = 'object') => new Err(404, 'invalid_request_error', 'resource_missing', `No such ${what}: '${id}'`, what);

function ensureCustomerPm(pm, customer) {
  if (pm.customer && pm.customer !== customer) throw bad('The payment method belongs to a different customer.', 'payment_method_customer_mismatch');
}

// ------------------------------------------------------------------------------------------------ objects
function chargeObj(c) {
  return { id: c.id, object: 'charge', amount: c.amount, amount_captured: c.captured ? c.amount_captured : 0, amount_refunded: c.amount_refunded, captured: c.captured, currency: 'cad', customer: c.customer, payment_intent: c.payment_intent, payment_method: c.payment_method, paid: true, refunded: c.amount_refunded >= c.amount_captured && c.amount_captured > 0, status: 'succeeded', created: c.created, livemode: false, metadata: c.metadata ?? {}, payment_method_details: { type: 'card', card: { brand: c.pm?.card?.brand ?? 'visa', last4: c.pm?.card?.last4 ?? '4242', wallet: c.pm?.card?.wallet ?? null } } };
}
function piObj(pi, expand = []) {
  const o = {
    id: pi.id, object: 'payment_intent', amount: pi.amount, amount_capturable: pi.amount_capturable, amount_received: pi.amount_received, currency: pi.currency,
    status: pi.status, capture_method: pi.capture_method, client_secret: pi.client_secret, customer: pi.customer ?? null, payment_method: pi.payment_method ?? null,
    latest_charge: pi.latest_charge ?? null, metadata: pi.metadata ?? {}, description: pi.description ?? null, livemode: false, created: pi.created,
    setup_future_usage: pi.setup_future_usage ?? null, transfer_group: pi.transfer_group ?? null, canceled_at: pi.canceled_at ?? null, cancellation_reason: pi.cancellation_reason ?? null,
    last_payment_error: pi.last_payment_error ?? null, automatic_payment_methods: pi.automatic_payment_methods ?? null, next_action: pi.status === 'requires_action' ? { type: 'use_stripe_sdk' } : null,
    receipt_email: pi.receipt_email ?? null,
  };
  if (expand.includes('latest_charge') && pi.latest_charge) o.latest_charge = chargeObj(S.charges[pi.latest_charge]);
  return o;
}
const pmObj = (p) => ({ id: p.id, object: 'payment_method', type: 'card', customer: p.customer ?? null, created: p.created, livemode: false, card: { brand: p.card.brand, last4: p.card.last4, exp_month: 12, exp_year: new Date().getFullYear() + 3, wallet: p.card.wallet ?? null, funding: 'credit', country: 'CA' } });
const custObj = (c) => ({ id: c.id, object: 'customer', email: c.email ?? null, name: c.name ?? null, metadata: c.metadata ?? {}, invoice_settings: { default_payment_method: c.default_pm ?? null }, created: c.created, livemode: false, deleted: undefined });
function acctObj(a) {
  return {
    id: a.id, object: 'account', type: 'express', country: a.country, email: a.email ?? null, business_type: a.business_type, charges_enabled: a.charges_enabled, payouts_enabled: a.payouts_enabled,
    details_submitted: a.details_submitted, default_currency: 'cad', metadata: a.metadata ?? {}, created: a.created,
    capabilities: { transfers: a.transfers_status }, requirements: { currently_due: a.currently_due, past_due: a.past_due ?? [], eventually_due: a.currently_due, disabled_reason: a.disabled_reason },
    external_accounts: { object: 'list', data: a.external.map(extObj), has_more: false, url: `/v1/accounts/${a.id}/external_accounts` },
    business_profile: { name: a.business_name ?? null },
  };
}
const extObj = (e) => (e.object === 'card' ? { id: e.id, object: 'card', brand: e.brand, last4: e.last4, funding: 'debit', currency: 'cad', available_payout_methods: e.instant ? ['standard', 'instant'] : ['standard'] } : { id: e.id, object: 'bank_account', last4: e.last4, bank_name: 'TEST BANK', currency: 'cad', country: 'CA' });
const trObj = (t) => ({ id: t.id, object: 'transfer', amount: t.amount, amount_reversed: t.amount_reversed, currency: 'cad', destination: t.destination, transfer_group: t.transfer_group ?? null, metadata: t.metadata ?? {}, reversed: t.amount_reversed >= t.amount, description: t.description ?? null, created: t.created, livemode: false, balance_transaction: t.bt });
const poObj = (p) => ({ id: p.id, object: 'payout', amount: p.amount, currency: 'cad', method: p.method, status: p.status, failure_code: p.failure_code ?? null, failure_message: p.failure_message ?? null, metadata: p.metadata ?? {}, created: p.created, arrival_date: now(), livemode: false });
const refObj = (r) => ({ id: r.id, object: 'refund', amount: r.amount, currency: 'cad', payment_intent: r.payment_intent, charge: r.charge, status: 'succeeded', metadata: r.metadata ?? {}, reason: null, created: r.created });
const disObj = (d) => ({ id: d.id, object: 'dispute', amount: d.amount, currency: 'cad', charge: d.charge, payment_intent: d.payment_intent, reason: d.reason, status: d.status, evidence_details: { due_by: now() + 7 * 86400, has_evidence: false, submission_count: 0 }, created: d.created, livemode: false });

function bt(type, amount, source, extra = {}) {
  const row = { id: rid('txn'), object: 'balance_transaction', type, amount, currency: 'cad', fee: 0, net: amount, source, created: now(), ...extra };
  S.bts.push(row);
  return row.id;
}

// ------------------------------------------------------------------------------------------------ events / webhooks
function makeEvent(type, object, account, extra = {}) {
  return { id: extra.id || rid('evt', 24), object: 'event', api_version: '2026-08-26.dahlia', created: now(), livemode: false, type, account, data: { object }, pending_webhooks: 1, request: { id: null, idempotency_key: null } };
}
async function deliver(event, { url, secret, tamper, badSignature } = {}) {
  const target = url || S.config.webhookUrl;
  const sec = secret || S.config.webhookSecret;
  if (!target || !sec) return { delivered: false, reason: 'no webhook url / secret configured' };
  const payload = JSON.stringify(event);
  let header = stripeLib.webhooks.generateTestHeaderString({ payload, secret: sec });
  if (badSignature) header = header.replace(/v1=[0-9a-f]+/, 'v1=' + '0'.repeat(64));
  const body = tamper ? payload.replace('"livemode":false', '"livemode":false ') : payload;
  try {
    const r = await fetch(target, { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8', 'stripe-signature': header, 'user-agent': 'Stripe/1.0 (+https://stripe.com/docs/webhooks)' }, body });
    S.events.push({ id: event.id, type: event.type, status: r.status, at: now() });
    return { delivered: true, status: r.status, body: await r.text().catch(() => '') };
  } catch (e) {
    return { delivered: false, reason: String(e.message) };
  }
}
function emit(type, object, account) {
  const ev = makeEvent(type, object, account);
  if (S.config.autoEvents && S.config.webhookUrl) deliver(ev).catch(() => undefined);
  else S.events.push({ id: ev.id, type, status: 'not-delivered', at: now() });
  return ev;
}

// ------------------------------------------------------------------------------------------------ the API
function mkIntent(p, hdr) {
  const amount = int(p.amount);
  if (!Number.isInteger(amount) || amount < 50) throw bad('Amount must be at least $0.50 cad', 'amount_too_small', 'amount');
  if (String(p.currency).toLowerCase() !== 'cad') throw bad('This fake only supports cad', 'parameter_invalid_enum', 'currency');
  if (p.customer && !S.customers[p.customer]) throw missing(p.customer, 'customer');
  const id = rid('pi');
  const pi = {
    id, amount, amount_capturable: 0, amount_received: 0, currency: 'cad', status: 'requires_payment_method', capture_method: p.capture_method || 'automatic', client_secret: `${id}_secret_${rid('x', 16)}`,
    customer: p.customer, payment_method: p.payment_method, metadata: p.metadata ?? {}, description: p.description, created: now(), setup_future_usage: p.setup_future_usage || null,
    transfer_group: p.transfer_group, automatic_payment_methods: p.automatic_payment_methods ? { enabled: bool(p.automatic_payment_methods.enabled), allow_redirects: p.automatic_payment_methods.allow_redirects ?? 'always' } : null, latest_charge: null,
  };
  if (p.payment_method) { const pm = S.pms[p.payment_method]; if (!pm) throw missing(p.payment_method, 'payment_method'); ensureCustomerPm(pm, p.customer); }
  S.intents[id] = pi;
  if (bool(p.confirm)) confirmIntent(pi, { payment_method: p.payment_method, off_session: bool(p.off_session), scenario: 'ok' });
  return pi;
}

/** what the browser (Stripe.js) does when the customer pays; also used for server-side confirm */
function confirmIntent(pi, { payment_method, scenario = 'ok', off_session = false } = {}) {
  if (!['requires_payment_method', 'requires_confirmation', 'requires_action'].includes(pi.status)) throw new Err(400, 'invalid_request_error', 'payment_intent_unexpected_state', `This PaymentIntent's status is ${pi.status}.`);
  const pmId = payment_method || pi.payment_method;
  const pm = S.pms[pmId];
  if (!pm) throw bad('A payment method is required to confirm.', 'parameter_missing', 'payment_method');
  if (pi.customer) ensureCustomerPm(pm, pi.customer);
  pi.payment_method = pmId;
  if (scenario === 'declined' || pm.card.last4 === '0002') {
    pi.status = 'requires_payment_method';
    pi.last_payment_error = { code: 'card_declined', decline_code: 'generic_decline', message: 'Your card was declined.', type: 'card_error' };
    emit('payment_intent.payment_failed', piObj(pi));
    if (off_session) throw new Err(402, 'card_error', 'card_declined', 'Your card was declined.');
    return pi;
  }
  if ((scenario === '3ds' || scenario === '3ds_fail' || pm.card.last4 === '3155') && !pi.authenticated) {
    pi.status = 'requires_action';
    pi.scenario = scenario;
    if (off_session) throw new Err(402, 'card_error', 'authentication_required', 'This payment requires authentication.');
    return pi;
  }
  // attach to the customer when the customer wanted to save it
  if (pi.customer && pi.setup_future_usage) pm.customer = pi.customer;
  const chId = rid('ch');
  S.charges[chId] = { id: chId, amount: pi.amount, amount_captured: pi.capture_method === 'manual' ? 0 : pi.amount, amount_refunded: 0, captured: pi.capture_method !== 'manual', payment_intent: pi.id, customer: pi.customer, payment_method: pmId, pm, created: now(), metadata: pi.metadata };
  pi.latest_charge = chId;
  pi.last_payment_error = null;
  if (pi.capture_method === 'manual') {
    pi.status = 'requires_capture';
    pi.amount_capturable = pi.amount;
    emit('payment_intent.amount_capturable_updated', piObj(pi));
  } else {
    pi.status = 'succeeded';
    pi.amount_received = pi.amount;
    S.charges[chId].bt = bt('charge', pi.amount, chId);
    emit('payment_intent.succeeded', piObj(pi));
  }
  return pi;
}

const routes = [];
const route = (method, re, fn) => routes.push({ method, re, fn });

// ---- platform account / balance
route('GET', /^\/v1\/account$/, () => ({ id: 'acct_platform_fake', object: 'account', country: 'CA', charges_enabled: true, payouts_enabled: true, details_submitted: true, default_currency: 'cad', business_profile: { name: 'FORKY (fake Stripe)' }, settings: { dashboard: { display_name: 'FORKY test' } } }));
route('GET', /^\/v1\/balance$/, () => ({ object: 'balance', livemode: false, available: [{ amount: S.config.platformBalance, currency: 'cad' }], pending: [{ amount: 0, currency: 'cad' }] }));
route('GET', /^\/v1\/balance_transactions$/, (m, q) => {
  let rows = S.bts.filter((b) => (!q.created?.gte || b.created >= Number(q.created.gte)) && (!q.created?.lt || b.created < Number(q.created.lt)));
  if (q.starting_after) { const i = rows.findIndex((r) => r.id === q.starting_after); rows = rows.slice(i + 1); }
  const limit = Number(q.limit || 10);
  return { object: 'list', data: rows.slice(0, limit), has_more: rows.length > limit, url: '/v1/balance_transactions' };
});
route('GET', /^\/v1\/webhook_endpoints$/, () => ({ object: 'list', data: S.webhookEndpoints, has_more: false, url: '/v1/webhook_endpoints' }));

// ---- customers
route('POST', /^\/v1\/customers$/, (m, p) => { const id = rid('cus', 14); S.customers[id] = { id, email: p.email, name: p.name, metadata: p.metadata ?? {}, created: now() }; return custObj(S.customers[id]); });
route('GET', /^\/v1\/customers\/([^/]+)$/, (m) => { const c = S.customers[m[1]]; if (!c) throw missing(m[1], 'customer'); return custObj(c); });
route('POST', /^\/v1\/customers\/([^/]+)$/, (m, p) => { const c = S.customers[m[1]]; if (!c) throw missing(m[1], 'customer'); if (p.invoice_settings?.default_payment_method) c.default_pm = p.invoice_settings.default_payment_method; if (p.email) c.email = p.email; return custObj(c); });

// ---- payment methods
route('GET', /^\/v1\/payment_methods$/, (m, q) => ({ object: 'list', data: Object.values(S.pms).filter((p) => p.customer === q.customer).map(pmObj), has_more: false, url: '/v1/payment_methods' }));
route('GET', /^\/v1\/payment_methods\/([^/]+)$/, (m) => { const p = S.pms[m[1]]; if (!p) throw missing(m[1], 'payment_method'); return pmObj(p); });
route('POST', /^\/v1\/payment_methods\/([^/]+)\/detach$/, (m) => { const p = S.pms[m[1]]; if (!p) throw missing(m[1], 'payment_method'); if (!p.customer) throw bad('The payment method is not attached to a customer.', 'payment_method_unattached'); p.customer = null; return pmObj(p); });

// ---- payment intents
route('POST', /^\/v1\/payment_intents$/, (m, p, h) => piObj(mkIntent(p, h)));
route('GET', /^\/v1\/payment_intents\/([^/]+)$/, (m, q) => { const pi = S.intents[m[1]]; if (!pi) throw missing(m[1], 'payment_intent'); return piObj(pi, arr(q.expand)); });
route('POST', /^\/v1\/payment_intents\/([^/]+)$/, (m, p) => {
  const pi = S.intents[m[1]]; if (!pi) throw missing(m[1], 'payment_intent');
  if (p.amount !== undefined) {
    if (pi.status !== 'requires_payment_method' && pi.status !== 'requires_confirmation') throw new Err(400, 'invalid_request_error', 'payment_intent_unexpected_state', `You cannot update the amount of a PaymentIntent in status ${pi.status}.`);
    pi.amount = int(p.amount);
  }
  if (p.metadata) pi.metadata = { ...pi.metadata, ...p.metadata };
  if (p.description !== undefined) pi.description = p.description;
  if (p.transfer_group !== undefined) pi.transfer_group = p.transfer_group;
  if (p.setup_future_usage !== undefined) pi.setup_future_usage = p.setup_future_usage || null;
  if (p.payment_method) { const pm = S.pms[p.payment_method]; if (!pm) throw missing(p.payment_method, 'payment_method'); pi.payment_method = p.payment_method; }
  return piObj(pi);
});
route('POST', /^\/v1\/payment_intents\/([^/]+)\/confirm$/, (m, p) => { const pi = S.intents[m[1]]; if (!pi) throw missing(m[1], 'payment_intent'); return piObj(confirmIntent(pi, { payment_method: p.payment_method })); });
route('POST', /^\/v1\/payment_intents\/([^/]+)\/capture$/, (m, p) => {
  const pi = S.intents[m[1]]; if (!pi) throw missing(m[1], 'payment_intent');
  if (pi.status !== 'requires_capture') throw new Err(400, 'invalid_request_error', 'payment_intent_unexpected_state', `This PaymentIntent could not be captured because it has a status of ${pi.status}. Only a PaymentIntent with one of the following statuses may be captured: requires_capture.`);
  const amt = p.amount_to_capture !== undefined ? int(p.amount_to_capture) : pi.amount_capturable;
  if (!(amt > 0) || amt > pi.amount_capturable) throw bad(`Amount to capture must be between 1 and ${pi.amount_capturable}.`, 'amount_too_large', 'amount_to_capture');
  const ch = S.charges[pi.latest_charge];
  ch.captured = true; ch.amount_captured = amt; ch.bt = bt('charge', amt, ch.id);
  pi.status = 'succeeded'; pi.amount_received = amt; pi.amount_capturable = 0;
  emit('payment_intent.succeeded', piObj(pi));
  return piObj(pi);
});
route('POST', /^\/v1\/payment_intents\/([^/]+)\/cancel$/, (m, p) => {
  const pi = S.intents[m[1]]; if (!pi) throw missing(m[1], 'payment_intent');
  if (!['requires_payment_method', 'requires_capture', 'requires_confirmation', 'requires_action', 'processing'].includes(pi.status)) throw new Err(400, 'invalid_request_error', 'payment_intent_unexpected_state', `You cannot cancel this PaymentIntent because it has a status of ${pi.status}. Only a PaymentIntent with one of the following statuses may be canceled: requires_payment_method, requires_capture, requires_confirmation, requires_action, processing.`);
  pi.status = 'canceled'; pi.canceled_at = now(); pi.cancellation_reason = p.cancellation_reason ?? null; pi.amount_capturable = 0;
  emit('payment_intent.canceled', piObj(pi));
  return piObj(pi);
});
route('POST', /^\/v1\/payment_intents\/([^/]+)\/increment_authorization$/, (m, p) => {
  const pi = S.intents[m[1]]; if (!pi) throw missing(m[1], 'payment_intent');
  if (!S.config.incrementAuth) throw new Err(400, 'invalid_request_error', 'payment_intent_incremental_authorization_not_supported', 'Incremental authorization is not supported for this PaymentIntent.');
  if (pi.status !== 'requires_capture') throw new Err(400, 'invalid_request_error', 'payment_intent_unexpected_state', `status is ${pi.status}`);
  pi.amount = int(p.amount); pi.amount_capturable = pi.amount; S.charges[pi.latest_charge].amount = pi.amount;
  return piObj(pi);
});

// ---- refunds
route('POST', /^\/v1\/refunds$/, (m, p) => {
  const pi = S.intents[p.payment_intent]; if (!pi) throw missing(p.payment_intent, 'payment_intent');
  const ch = S.charges[pi.latest_charge];
  if (!ch || !ch.captured) throw new Err(400, 'invalid_request_error', 'charge_not_refundable', 'The charge has not been captured, so it cannot be refunded.');
  const amt = p.amount !== undefined ? int(p.amount) : ch.amount_captured - ch.amount_refunded;
  if (!(amt > 0) || amt > ch.amount_captured - ch.amount_refunded) throw new Err(400, 'invalid_request_error', 'charge_already_refunded', `Refund amount (${amt}) is greater than unrefunded amount on charge (${ch.amount_captured - ch.amount_refunded}).`);
  ch.amount_refunded += amt;
  const id = rid('re', 20);
  S.refunds[id] = { id, amount: amt, payment_intent: pi.id, charge: ch.id, metadata: p.metadata ?? {}, created: now() };
  bt('refund', -amt, id);
  emit('charge.refunded', chargeObj(ch));
  return refObj(S.refunds[id]);
});

// ---- setup intents
route('POST', /^\/v1\/setup_intents$/, (m, p) => { const id = rid('seti'); S.setups[id] = { id, customer: p.customer, status: 'requires_payment_method', client_secret: `${id}_secret_${rid('x', 16)}`, usage: p.usage, metadata: p.metadata ?? {}, created: now() }; const s = S.setups[id]; return { id, object: 'setup_intent', customer: s.customer, status: s.status, client_secret: s.client_secret, usage: s.usage, metadata: s.metadata, payment_method: null, created: s.created }; });

// ---- connect: accounts
route('GET', /^\/v1\/accounts$/, () => { if (!S.config.connectEnabled) throw new Err(403, 'invalid_request_error', 'platform_account_required', 'You can only create new accounts if you\'ve signed up for Connect, which you can do at https://dashboard.stripe.com/connect.'); return { object: 'list', data: Object.values(S.accounts).slice(0, 1).map(acctObj), has_more: false, url: '/v1/accounts' }; });
route('POST', /^\/v1\/accounts$/, (m, p) => {
  if (!S.config.connectEnabled) throw new Err(403, 'invalid_request_error', 'platform_account_required', 'Connect is not enabled on this account.');
  const id = rid('acct', 16);
  S.accounts[id] = { id, country: p.country || 'CA', email: p.email, business_type: p.business_type, metadata: p.metadata ?? {}, created: now(), charges_enabled: false, payouts_enabled: false, details_submitted: false, transfers_status: 'inactive', currently_due: ['external_account', 'tos_acceptance.date', 'individual.verification.document'], past_due: [], disabled_reason: 'requirements.past_due', external: [], business_name: p.business_profile?.name };
  if (!bool(p.capabilities?.transfers?.requested)) throw bad('The transfers capability must be requested.', 'parameter_missing', 'capabilities');
  return acctObj(S.accounts[id]);
});
route('GET', /^\/v1\/accounts\/([^/]+)$/, (m) => { const a = S.accounts[m[1]]; if (!a) throw missing(m[1], 'account'); return acctObj(a); });
route('GET', /^\/v1\/accounts\/([^/]+)\/external_accounts$/, (m, q) => { const a = S.accounts[m[1]]; if (!a) throw missing(m[1], 'account'); return { object: 'list', data: a.external.filter((e) => !q.object || e.object === q.object).map(extObj), has_more: false, url: `/v1/accounts/${a.id}/external_accounts` }; });
route('POST', /^\/v1\/accounts\/([^/]+)\/login_links$/, (m) => { const a = S.accounts[m[1]]; if (!a) throw missing(m[1], 'account'); if (!a.details_submitted) throw bad('Cannot create a login link for an account that has not completed onboarding.', 'invalid_request'); return { object: 'login_link', created: now(), url: `http://localhost:${PORT}/_fake/express/${a.id}` }; });
route('POST', /^\/v1\/account_links$/, (m, p) => { const a = S.accounts[p.account]; if (!a) throw missing(p.account, 'account'); if (p.type !== 'account_onboarding') throw bad('Unsupported type for the fake.', 'parameter_invalid_enum', 'type'); if (!p.return_url || !p.refresh_url) throw bad('return_url and refresh_url are required.', 'parameter_missing'); return { object: 'account_link', created: now(), expires_at: now() + 300, url: `http://localhost:${PORT}/_fake/onboard/${a.id}` }; });

// ---- transfers / payouts
route('POST', /^\/v1\/transfers$/, (m, p) => {
  const a = S.accounts[p.destination]; if (!a) throw new Err(400, 'invalid_request_error', 'resource_missing', `No such destination: '${p.destination}'`, 'destination');
  if (a.transfers_status !== 'active') throw new Err(400, 'invalid_request_error', 'insufficient_capabilities_for_transfer', 'Your destination account needs to have at least one of the following capabilities enabled: transfers, crypto_transfers, legacy_payments', 'destination');
  const amt = int(p.amount);
  if (!(amt > 0)) throw bad('Invalid amount', 'parameter_invalid_integer', 'amount');
  if (amt > S.config.platformBalance) throw new Err(400, 'invalid_request_error', 'balance_insufficient', 'You have insufficient funds in your Stripe account for this transfer.');
  S.config.platformBalance -= amt;
  const id = rid('tr', 20);
  S.transfers[id] = { id, amount: amt, amount_reversed: 0, destination: a.id, transfer_group: p.transfer_group, metadata: p.metadata ?? {}, description: p.description, created: now() };
  S.transfers[id].bt = bt('transfer', -amt, id);
  a.balance = (a.balance ?? 0) + amt;
  emit('transfer.created', trObj(S.transfers[id]));
  return trObj(S.transfers[id]);
});
route('GET', /^\/v1\/transfers\/([^/]+)$/, (m) => { const t = S.transfers[m[1]]; if (!t) throw missing(m[1], 'transfer'); return trObj(t); });
route('POST', /^\/v1\/payouts$/, (m, p, h) => {
  const acctId = h['stripe-account']; const a = S.accounts[acctId];
  if (!a) throw bad('Payouts must be created on a connected account (Stripe-Account header).', 'parameter_missing');
  const amt = int(p.amount);
  if ((a.balance ?? 0) < amt) throw new Err(400, 'invalid_request_error', 'balance_insufficient', 'You have insufficient funds in your Stripe account for this payout.');
  if (p.method === 'instant' && !a.external.some((e) => e.object === 'card' && e.instant)) throw new Err(400, 'invalid_request_error', 'instant_payouts_unsupported', 'Your external account does not support instant payouts.');
  a.balance -= amt;
  const id = rid('po', 20);
  S.payouts[id] = { id, amount: amt, method: p.method || 'standard', status: 'in_transit', metadata: p.metadata ?? {}, created: now(), account: a.id };
  return poObj(S.payouts[id]);
});
route('POST', /^\/v1\/transfers\/([^/]+)\/reversals$/, (m, p) => { const t = S.transfers[m[1]]; if (!t) throw missing(m[1], 'transfer'); return reverseTransfer(t, p.amount !== undefined ? int(p.amount) : t.amount - t.amount_reversed); });

function reverseTransfer(t, amt) {
  if (amt > t.amount - t.amount_reversed) throw bad('Reversal amount is greater than the unreversed amount.', 'amount_too_large');
  t.amount_reversed += amt; S.config.platformBalance += amt;
  const id = rid('trr', 20); S.reversals[id] = { id, transfer: t.id, amount: amt };
  emit('transfer.reversed', trObj(t));
  return { id, object: 'transfer_reversal', amount: amt, transfer: t.id, created: now() };
}

// ------------------------------------------------------------------------------------------------ fake control routes
const control = [];
const ctl = (method, re, fn) => control.push({ method, re, fn });
ctl('GET', /^\/_fake\/state$/, () => ({ ...S, idem: Object.keys(S.idem), idemKeys: Object.keys(S.idem) }));
ctl('POST', /^\/_fake\/reset$/, () => { const keep = S.config; S = fresh(); S.config = { ...S.config, webhookUrl: keep.webhookUrl, webhookSecret: keep.webhookSecret }; return { ok: true }; });
ctl('POST', /^\/_fake\/config$/, (m, b) => { Object.assign(S.config, b); return S.config; });
ctl('POST', /^\/_fake\/pm$/, (m, b) => {
  const id = rid('pm', 16);
  S.pms[id] = { id, customer: b.customer ?? null, created: now(), card: { brand: b.brand || 'visa', last4: b.last4 || '4242', wallet: b.wallet ? { type: b.wallet } : null } };
  return pmObj(S.pms[id]);
});
ctl('POST', /^\/_fake\/confirm\/([^/]+)$/, (m, b) => {
  const pi = S.intents[m[1]]; if (!pi) throw missing(m[1], 'payment_intent');
  let pmId = b.payment_method;
  if (!pmId) { const last4 = b.scenario === 'declined' ? '0002' : b.scenario?.startsWith('3ds') ? '3155' : '4242'; pmId = rid('pm', 16); S.pms[pmId] = { id: pmId, customer: null, created: now(), card: { brand: 'visa', last4, wallet: b.wallet ? { type: b.wallet } : null } }; }
  return piObj(confirmIntent(pi, { payment_method: pmId, scenario: b.scenario || 'ok' }));
});
ctl('POST', /^\/_fake\/authenticate\/([^/]+)$/, (m, b) => {
  const pi = S.intents[m[1]]; if (!pi) throw missing(m[1], 'payment_intent');
  if (pi.status !== 'requires_action') throw bad('Not waiting for authentication', 'payment_intent_unexpected_state');
  if (b.success === false || pi.scenario === '3ds_fail') { pi.status = 'requires_payment_method'; pi.last_payment_error = { code: 'payment_intent_authentication_failure', message: 'We are unable to authenticate your payment method.', type: 'invalid_request_error' }; emit('payment_intent.payment_failed', piObj(pi)); return piObj(pi); }
  pi.authenticated = true; pi.status = 'requires_confirmation';
  return piObj(confirmIntent(pi, { payment_method: pi.payment_method }));
});
ctl('POST', /^\/_fake\/webhook$/, async (m, b) => {
  const ev = makeEvent(b.type, b.object ?? {}, b.account, { id: b.id });
  return deliver(ev, { url: b.url, secret: b.secret, tamper: b.tamper, badSignature: b.badSignature }).then((r) => ({ ...r, event: ev }));
});
ctl('POST', /^\/_fake\/webhook-endpoint$/, (m, b) => { S.webhookEndpoints = [{ id: rid('we', 14), object: 'webhook_endpoint', url: b.url, status: b.status || 'enabled', enabled_events: b.enabled_events || ['*'] }]; return S.webhookEndpoints[0]; });
ctl('POST', /^\/_fake\/account\/([^/]+)\/complete$/, (m, b) => {
  const a = S.accounts[m[1]]; if (!a) throw missing(m[1], 'account');
  if (b.restricted) { a.details_submitted = true; a.payouts_enabled = false; a.transfers_status = 'inactive'; a.currently_due = ['individual.verification.document']; a.past_due = ['individual.verification.document']; a.disabled_reason = 'requirements.past_due'; }
  else if (b.pending) { a.details_submitted = true; a.currently_due = []; a.disabled_reason = 'requirements.pending_verification'; }
  else { a.details_submitted = true; a.payouts_enabled = true; a.charges_enabled = false; a.transfers_status = 'active'; a.currently_due = []; a.past_due = []; a.disabled_reason = null; if (!a.external.length) a.external.push({ id: rid('ba', 12), object: 'bank_account', last4: '6789' }); }
  if (b.debitCard) a.external.push({ id: rid('card', 12), object: 'card', brand: 'Visa', last4: '5556', instant: true });
  emit('account.updated', acctObj(a), a.id);
  return acctObj(a);
});
ctl('POST', /^\/_fake\/dispute$/, (m, b) => {
  const pi = S.intents[b.payment_intent]; if (!pi) throw missing(b.payment_intent, 'payment_intent');
  const id = rid('dp', 16);
  S.disputes[id] = { id, amount: b.amount ?? pi.amount_received, charge: pi.latest_charge, payment_intent: pi.id, reason: b.reason || 'fraudulent', status: b.status || 'needs_response', created: now() };
  bt('adjustment', -S.disputes[id].amount, id);
  emit('charge.dispute.created', disObj(S.disputes[id]));
  return disObj(S.disputes[id]);
});
ctl('POST', /^\/_fake\/dispute\/([^/]+)\/close$/, (m, b) => { const d = S.disputes[m[1]]; if (!d) throw missing(m[1], 'dispute'); d.status = b.status || 'lost'; if (d.status === 'won') bt('adjustment', d.amount, d.id); emit('charge.dispute.closed', disObj(d)); return disObj(d); });
ctl('POST', /^\/_fake\/transfer\/([^/]+)\/reverse$/, (m, b) => { const t = S.transfers[m[1]]; if (!t) throw missing(m[1], 'transfer'); return reverseTransfer(t, b.amount !== undefined ? Number(b.amount) : t.amount - t.amount_reversed); });
ctl('POST', /^\/_fake\/payout\/([^/]+)\/fail$/, (m) => { const p = S.payouts[m[1]]; if (!p) throw missing(m[1], 'payout'); p.status = 'failed'; p.failure_code = 'account_closed'; p.failure_message = 'The bank account has been closed.'; emit('payout.failed', poObj(p), p.account); return poObj(p); });
ctl('POST', /^\/_fake\/fail-next$/, (m, b) => { S.failNext.push(b); return { queued: S.failNext.length }; });
ctl('GET', /^\/_fake\/onboard\/([^/]+)$/, (m) => ({ message: 'Fake Stripe-hosted onboarding page. POST /_fake/account/' + m[1] + '/complete to finish it.' }));
ctl('GET', /^\/_fake\/express\/([^/]+)$/, (m) => ({ message: 'Fake Stripe Express dashboard for ' + m[1] }));

// ------------------------------------------------------------------------------------------------ server
function send(res, status, body, extra = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'request-id': rid('req', 12), ...extra });
  res.end(text);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  const path = url.pathname;
  try {
    if (path.startsWith('/_fake/')) {
      const body = raw ? (req.headers['content-type'] || '').includes('json') ? JSON.parse(raw) : parseForm(raw) : {};
      for (const c of control) {
        const m = c.re.exec(path);
        if (c.method === req.method && m) return send(res, 200, await c.fn(m, body));
      }
      return send(res, 404, { error: 'unknown control route' });
    }
    // ---- auth
    const auth = String(req.headers.authorization || '');
    const key = auth.replace(/^Bearer\s+/i, '');
    if (!key) return send(res, 401, { error: { type: 'invalid_request_error', message: 'You did not provide an API key.' } });
    if (/invalid|revoked/i.test(key) || !/^(sk|rk)_(test|live)_/.test(key)) return send(res, 401, { error: { type: 'invalid_request_error', code: 'api_key_expired', message: `Invalid API Key provided: ${key.slice(0, 8)}***` } });
    const query = parseForm(url.searchParams.toString());
    const body = req.method === 'GET' || req.method === 'DELETE' ? query : parseForm(raw);
    // ---- injected failures
    const fi = S.failNext.findIndex((f) => path.includes(f.path));
    if (fi >= 0) { const f = S.failNext.splice(fi, 1)[0]; return send(res, f.status || 500, { error: { type: f.type || 'api_error', code: f.code, message: f.message || 'Injected failure' } }); }
    // ---- idempotency
    const ik = req.headers['idempotency-key'];
    const fp = req.method + ' ' + path + ' ' + raw;
    if (ik && req.method === 'POST') {
      const prev = S.idem[ik];
      if (prev) {
        if (prev.fp !== fp) return send(res, 400, { error: { type: 'idempotency_error', message: `Keys for idempotent requests can only be used with the same parameters they were first used with. Try using a key other than '${ik}' if you meant to execute a different request.` } });
        return send(res, prev.status, prev.body, { 'idempotent-replayed': 'true' });
      }
    }
    for (const r of routes) {
      const m = r.re.exec(path);
      if (r.method === req.method && m) {
        let out; let status = 200;
        try { out = await r.fn(m, body, req.headers); } catch (e) {
          if (!(e instanceof Err)) throw e;
          status = e.status; out = { error: { type: e.type, code: e.code, message: e.message, param: e.param } };
          S.log.push({ path, status, code: e.code });
        }
        if (ik && req.method === 'POST' && status < 500) S.idem[ik] = { fp, status, body: out };
        return send(res, status, out);
      }
    }
    return send(res, 404, { error: { type: 'invalid_request_error', code: 'resource_missing', message: `Unrecognized request URL (${req.method}: ${path}). The fake implements only what FORKY calls.` } });
  } catch (e) {
    console.error('fake-stripe error', e);
    return send(res, 500, { error: { type: 'api_error', message: String(e.message) } });
  }
});

server.listen(PORT, () => console.log(`FAKE Stripe listening on http://localhost:${PORT} (webhook target: ${S.config.webhookUrl || 'none yet - POST /_fake/config'})`));
