/**
 * Unit tests for the money-back logic of PaymentsService (no server, no database, no Stripe: every dependency is a fake):
 *
 *   cd backend && npx ts-node --transpile-only test/payments-refund.test.ts
 *
 * The card is charged at checkout, so a rejected / cancelled order has to be REFUNDED. This covers what the end-to-end suite cannot reach:
 * the late-cancellation fee (kept out of the refund), an old manual-capture hold (released / partly captured), an extra tip that was charged
 * separately, and the guards of the clean-up that gives back payments which never became an order (never a top-up, never a young charge, never
 * twice). Prints PASS / FAIL per check and exits 1 on any FAIL.
 */
import 'reflect-metadata';
import { HttpException, BadRequestException } from '@nestjs/common';
import { PaymentsService, payError } from '../src/orders/payments.service';

let failed = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

// ------------------------------------------------------------------------------------------------ fakes
const isNullOp = (v: any) => v && typeof v === 'object' && (v.type === 'isNull' || v._type === 'isNull');
const matches = (row: any, where: Record<string, any> = {}) => Object.entries(where).every(([k, v]) => (isNullOp(v) ? row[k] == null : row[k] === v));

function world() {
  const payments: any[] = [];
  const intents: any[] = [];
  const existingOrders: string[] = []; // payment intent ids that an order already uses
  const calls: { kind: string; args: any[] }[] = [];
  const stripeIntents: Record<string, any> = {};
  let failNextRefund = false;

  const stripe = {
    refunds: {
      create: async (params: any, opts: any) => {
        calls.push({ kind: 'refund', args: [params, opts] });
        if (failNextRefund) {
          failNextRefund = false;
          throw Object.assign(new Error('network down'), { code: 'api_connection_error' });
        }
        return { id: `re_${calls.length}` };
      },
    },
    paymentIntents: {
      retrieve: async (id: string) => {
        const pi = stripeIntents[id];
        if (!pi) throw Object.assign(new Error('missing'), { code: 'resource_missing' });
        return pi;
      },
      cancel: async (id: string, p: any) => {
        calls.push({ kind: 'cancel', args: [id, p] });
        stripeIntents[id] = { ...stripeIntents[id], status: 'canceled' };
        return stripeIntents[id];
      },
      capture: async (id: string, p: any, o: any) => {
        calls.push({ kind: 'capture', args: [id, p, o] });
        return { id, status: 'succeeded', latest_charge: 'ch_captured', amount_received: p.amount_to_capture };
      },
    },
  };

  const paymentsRepo = {
    find: async ({ where }: any) => payments.filter((r) => matches(r, where)),
    exist: async ({ where }: any) => payments.some((r) => matches(r, where)),
    insert: async (row: any) => void payments.push({ ...row }),
    delete: async (where: any) => void payments.splice(0, payments.length, ...payments.filter((r) => !matches(r, where))),
  };
  const intentsRepo = {
    findOne: async ({ where }: any) => intents.find((r) => matches(r, where)) ?? null,
    exist: async ({ where }: any) => intents.some((r) => matches(r, where)),
    update: async (criteria: any, patch: any) => {
      const hit = intents.filter((r) => matches(r, criteria));
      hit.forEach((r) => Object.assign(r, patch));
      return { affected: hit.length };
    },
  };
  const ordersRepo = { exist: async ({ where }: any) => existingOrders.includes(where.paymentIntentId) };
  const stripeClient = { mockAllowed: () => false, provider: () => 'stripe', client: () => stripe, config: () => ({ currency: 'cad', publishableKey: 'pk_test_x' }) };
  const svc = new PaymentsService(paymentsRepo as any, {} as any, intentsRepo as any, ordersRepo as any, {} as any, stripeClient as any, {} as any);
  const refundCalls = () => calls.filter((c) => c.kind === 'refund');
  return { svc, payments, intents, existingOrders, calls, stripeIntents, refundCalls, failNextRefund: () => (failNextRefund = true) };
}

const order = (over: Record<string, any> = {}) => ({ id: 'o1', code: 'FK-1', customerId: 'c1', paymentIntentId: 'pi_1', total: 25.33, walletUsed: 0, tip: 1, paymentStatus: 'CAPTURED', ...over }) as any;
const capture = (amount: number, over: Record<string, any> = {}) => ({ orderId: 'o1', provider: 'stripe', kind: 'CAPTURE', amount, status: 'SUCCEEDED', externalId: 'ch_1', meta: null, ...over });
const sum = (rows: any[], kind: string) => Math.round(rows.filter((r) => r.kind === kind).reduce((a, r) => a + Number(r.amount), 0) * 100) / 100;

(async () => {
  // ---- a rejected / cancelled order that was charged at checkout --------------------------------------------------------------
  {
    const w = world();
    w.payments.push(capture(25.33));
    const r = await w.svc.refundOnCancel(order());
    const c = w.refundCalls();
    check('cancel / reject of a charged order: the whole charge goes back with ONE Stripe refund on the checkout payment', c.length === 1 && c[0].args[0].payment_intent === 'pi_1' && c[0].args[0].amount === 2533, c);
    check('...with an idempotency key tied to the order (a replay can never refund twice)', c[0].args[1].idempotencyKey === 'refund-cancel-o1', c[0].args);
    check('...recorded as one REFUND row for the same amount (reason ORDER_CANCELLED)', w.payments.filter((p) => p.kind === 'REFUND').length === 1 && sum(w.payments, 'REFUND') === 25.33 && w.payments.find((p) => p.kind === 'REFUND').meta.reason === 'ORDER_CANCELLED', w.payments);
    check('...and reports mode refunded, 25.33 back, nothing kept', r.mode === 'refunded' && r.refunded === 25.33 && r.kept === 0, r);
  }
  {
    const w = world();
    w.payments.push(capture(25.33));
    const r = await w.svc.refundOnCancel(order(), 10);
    check('late-cancellation fee of 10.00: only the rest (15.33) is refunded, the fee stays with FORKY', w.refundCalls().length === 1 && w.refundCalls()[0].args[0].amount === 1533 && r.refunded === 15.33 && r.kept === 10, { calls: w.refundCalls(), r });
  }
  {
    const w = world();
    w.payments.push(capture(25.33));
    const r = await w.svc.refundOnCancel(order(), 99);
    check('a fee larger than what was charged keeps everything and refunds nothing (no Stripe call)', w.refundCalls().length === 0 && r.refunded === 0 && r.kept === 25.33, { r, calls: w.calls });
  }
  {
    const w = world();
    const r = await w.svc.refundOnCancel(order({ paymentIntentId: null, walletUsed: 25.33 }));
    check('an order paid with wallet credit only has no card payment: nothing to refund (the caller returns the wallet credit)', r.mode === 'none' && w.calls.length === 0 && w.payments.length === 0, r);
  }
  {
    const w = world();
    w.payments.push(capture(25.33), { orderId: 'o1', provider: 'stripe', kind: 'REFUND', amount: 4.5, status: 'SUCCEEDED', externalId: 're_old', meta: null });
    const r = await w.svc.refundOnCancel(order());
    check('an order that was partly refunded before: only what is still on the card goes back (20.83)', w.refundCalls()[0].args[0].amount === 2083 && r.refunded === 20.83, { calls: w.refundCalls(), r });
    check('...and cardAtStake agrees (the card now holds 0.00 of it)', (await w.svc.cardAtStake(order())) === 0);
  }

  // ---- an extra tip that was charged separately (its own PaymentIntent) -------------------------------------------------------
  {
    const w = world();
    w.payments.push(capture(20), { orderId: 'o1', provider: 'stripe', kind: 'TIP_ADJUST', amount: 3, status: 'SUCCEEDED', externalId: 'pi_tip', meta: { phase: 'post', extraIntent: 'pi_tip' } });
    w.stripeIntents['pi_1'] = { id: 'pi_1', status: 'succeeded', amount_received: 2000, latest_charge: { amount_refunded: 0 } };
    w.stripeIntents['pi_tip'] = { id: 'pi_tip', status: 'succeeded', amount_received: 300, latest_charge: { amount_refunded: 0 } };
    const r = await w.svc.refundOnCancel(order());
    const c = w.refundCalls();
    check('checkout payment + a separately charged tip: the checkout payment is refunded first (20.00), the tip from its own charge (3.00)', c.length === 2 && c[0].args[0].payment_intent === 'pi_1' && c[0].args[0].amount === 2000 && c[1].args[0].payment_intent === 'pi_tip' && c[1].args[0].amount === 300, c.map((x) => x.args[0]));
    check('...two REFUND rows add up to everything that was charged (23.00)', sum(w.payments, 'REFUND') === 23 && r.refunded === 23, w.payments);
    check('...and the idempotency keys differ per charge', c[0].args[1].idempotencyKey === 'refund-cancel-o1' && c[1].args[1].idempotencyKey === `${c[0].args[1].idempotencyKey}-${c[1].args[0].payment_intent}`, c.map((x) => x.args[1]));
  }

  // ---- an order placed before "charge at checkout" is still a hold --------------------------------------------------------------
  {
    const w = world();
    const r = await w.svc.refundOnCancel(order({ paymentStatus: 'AUTHORIZED' }));
    check('an old manual-capture hold is RELEASED (cancelled at Stripe), nothing is refunded', r.mode === 'released' && w.calls.some((c) => c.kind === 'cancel' && c.args[0] === 'pi_1') && w.refundCalls().length === 0, { r, calls: w.calls });
    check('...and a RELEASE row is recorded', w.payments.some((p) => p.kind === 'RELEASE'), w.payments);
  }
  {
    const w = world();
    const r = await w.svc.refundOnCancel(order({ paymentStatus: 'AUTHORIZED' }), 10);
    const cap = w.calls.find((c) => c.kind === 'capture');
    check('an old hold with a late-cancellation fee: only the fee (10.00) is captured, Stripe releases the rest', r.mode === 'released' && cap && cap.args[1].amount_to_capture === 1000 && w.refundCalls().length === 0, { r, calls: w.calls });
  }

  // ---- a payment that never became an order ---------------------------------------------------------------------------------
  const orderIntent = (extra: Record<string, any> = {}) => ({ id: 'row1', intentId: 'pi_x', customerId: 'c1', purpose: 'ORDER', orderId: null, canceledAt: null, status: 'succeeded', meta: null, ...extra });
  const paid = (extra: Record<string, any> = {}) => ({ id: 'pi_x', status: 'succeeded', amount: 2533, amount_received: 2533, latest_charge: { amount_refunded: 0, created: Math.floor(Date.now() / 1000) - 3600 }, ...extra });
  {
    const w = world();
    w.intents.push(orderIntent());
    w.stripeIntents['pi_x'] = paid();
    const r = await w.svc.returnUnusedMoney('pi_x', 'ABANDONED');
    check('a charged payment with no order is refunded in full', r === 'refunded' && w.refundCalls().length === 1 && w.refundCalls()[0].args[0].amount === 2533 && w.refundCalls()[0].args[1].idempotencyKey === 'unused-pi_x-2533', { r, calls: w.refundCalls() });
    check('...and it is closed in our records with the refund id (it can never be bound to an order again)', w.intents[0].canceledAt && w.intents[0].meta?.returned?.refundId === 're_1', w.intents[0]);
    const again = await w.svc.returnUnusedMoney('pi_x', 'ABANDONED');
    check('asking again refunds nothing more', again === 'none' && w.refundCalls().length === 1, { again, calls: w.refundCalls().length });
  }
  {
    const w = world();
    w.intents.push(orderIntent({ purpose: 'TOPUP' }));
    w.stripeIntents['pi_x'] = paid();
    const r = await w.svc.returnUnusedMoney('pi_x', 'ABANDONED');
    check('a wallet top-up payment is NEVER refunded by this clean-up', r === 'none' && w.refundCalls().length === 0, { r, calls: w.calls });
  }
  {
    const w = world();
    w.intents.push(orderIntent());
    w.stripeIntents['pi_x'] = paid({ latest_charge: { amount_refunded: 0, created: Math.floor(Date.now() / 1000) - 60 } });
    check('a payment made a minute ago is left alone when the clean-up asks for 10 minutes', (await w.svc.returnUnusedMoney('pi_x', 'ABANDONED', { minAgeMinutes: 10 })) === 'none' && w.refundCalls().length === 0 && w.intents[0].canceledAt === null);
    check('...and refunded once it is old enough', (await w.svc.returnUnusedMoney('pi_x', 'ABANDONED', { minAgeMinutes: 0 })) === 'refunded' && w.refundCalls().length === 1);
  }
  {
    const w = world();
    w.intents.push(orderIntent());
    w.existingOrders.push('pi_x');
    w.stripeIntents['pi_x'] = paid();
    check('a payment that an order already uses is never refunded', (await w.svc.returnUnusedMoney('pi_x', 'ORDER_NOT_PLACED')) === 'none' && w.refundCalls().length === 0);
  }
  {
    const w = world();
    w.intents.push(orderIntent({ orderId: 'o9' }));
    w.stripeIntents['pi_x'] = paid();
    check('...neither one our records have linked to an order', (await w.svc.returnUnusedMoney('pi_x', 'ORDER_NOT_PLACED')) === 'none' && w.refundCalls().length === 0);
  }
  {
    const w = world();
    w.intents.push(orderIntent());
    w.stripeIntents['pi_x'] = paid({ latest_charge: { amount_refunded: 2533, created: 1 } });
    check('a charge that was already refunded in full (for example in the Stripe dashboard) is left alone and closed', (await w.svc.returnUnusedMoney('pi_x', 'ABANDONED')) === 'none' && w.refundCalls().length === 0 && !!w.intents[0].canceledAt);
  }
  {
    const w = world();
    w.intents.push(orderIntent({ status: 'requires_payment_method' }));
    w.stripeIntents['pi_x'] = { id: 'pi_x', status: 'requires_payment_method', amount: 2533 };
    const r = await w.svc.returnUnusedMoney('pi_x', 'ABANDONED');
    check('a payment attempt that was never paid is CANCELLED (nothing to refund)', r === 'cancelled' && w.calls.some((c) => c.kind === 'cancel') && w.refundCalls().length === 0 && w.intents[0].status === 'canceled', { r, calls: w.calls });
  }
  {
    const w = world();
    w.intents.push(orderIntent());
    w.stripeIntents['pi_x'] = paid();
    w.failNextRefund();
    let thrown: any = null;
    try {
      await w.svc.returnUnusedMoney('pi_x', 'ABANDONED');
    } catch (e) {
      thrown = e;
    }
    check('when Stripe refuses the refund the error is raised and the payment is NOT marked as returned (the next run tries again)', !!thrown && w.intents[0].canceledAt === null, { thrown: String(thrown), row: w.intents[0] });
    check('...and the retry then succeeds', (await w.svc.returnUnusedMoney('pi_x', 'ABANDONED')) === 'refunded');
  }

  // ---- order refused after the card was charged ---------------------------------------------------------------------------------
  {
    const w = world();
    w.intents.push(orderIntent());
    w.stripeIntents['pi_x'] = paid();
    const e = await w.svc.refundAfterRefusedOrder('c1', 'pi_x', new BadRequestException('Restaurant is closed'));
    check('a clear refusal (400) after paying: the charge is refunded and the error says so (code ORDER_NOT_PLACED_REFUNDED, same status)', e instanceof HttpException && e.getStatus() === 400 && (e.getResponse() as any).code === 'ORDER_NOT_PLACED_REFUNDED' && /Restaurant is closed\. Your card payment is being refunded automatically/.test((e.getResponse() as any).message) && w.refundCalls().length === 1, { e: e?.getResponse?.(), calls: w.refundCalls().length });
  }
  {
    const w = world();
    w.intents.push(orderIntent());
    w.stripeIntents['pi_x'] = paid();
    const original = new HttpException('boom', 503);
    const e = await w.svc.refundAfterRefusedOrder('c1', 'pi_x', original);
    check('an unexpected server error (5xx) keeps the payment for a retry: no refund, the original error is returned', e === original && w.refundCalls().length === 0);
  }
  {
    const w = world();
    w.intents.push(orderIntent());
    w.stripeIntents['pi_x'] = paid();
    const original = payError(409, 'PAYMENT_QUOTE_CHANGED', 'Your total changed');
    const e = await w.svc.refundAfterRefusedOrder('c1', 'pi_x', original);
    check('a payment check (code PAYMENT_*) has dealt with the money itself: nothing more is done', e === original && w.refundCalls().length === 0);
  }
  {
    const w = world();
    w.intents.push(orderIntent({ customerId: 'someone-else' }));
    w.stripeIntents['pi_x'] = paid();
    const original = new BadRequestException('Cart is empty');
    const e = await w.svc.refundAfterRefusedOrder('c1', 'pi_x', original);
    check("another customer's payment is never refunded through this path", e === original && w.refundCalls().length === 0);
    check('no payment id, or an error that is not an HTTP error: unchanged', (await w.svc.refundAfterRefusedOrder('c1', undefined, original)) === original && ((await w.svc.refundAfterRefusedOrder('c1', 'pi_x', new Error('x'))) as Error).message === 'x');
  }

  console.log(failed ? `\n${failed} check(s) FAILED` : '\nall payments-refund checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('CRASH', e);
  process.exit(2);
});
