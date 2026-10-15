import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { STRIPE_APPEARANCE, getPaymentsConfig, getStripe, payFail, stripeMessage } from "../lib/payments";
import { errorCode, errorMessage, sfHttp } from "../lib/sfApi";
import { Ri, Notice, Spinner } from "./ui";

const brandName = (b) => ({ visa: "Visa", mastercard: "Mastercard", amex: "American Express", discover: "Discover", diners: "Diners Club", jcb: "JCB", unionpay: "UnionPay" }[b] || String(b || "Card").replace(/^./, (c) => c.toUpperCase()));

/** Lives inside <Elements>: owns the Stripe objects and tells the parent how to confirm the payment. */
function Confirmer({ clientSecret, choice, register, children }) {
  const stripe = useStripe();
  const elements = useElements();
  useEffect(() => {
    register({
      elements,
      confirm: async () => {
        if (!stripe) throw payFail("The secure payment form is still loading. Please wait a moment.", "not_ready");
        if (choice === "new") {
          if (!elements) throw payFail("The secure payment form is still loading. Please wait a moment.", "not_ready");
          const submitted = await elements.submit();
          if (submitted.error) throw payFail(stripeMessage(submitted.error), "validation");
          const r = await stripe.confirmPayment({ elements, clientSecret, confirmParams: { return_url: `${window.location.origin}/order/checkout` }, redirect: "if_required" });
          if (r.error) throw payFail(stripeMessage(r.error), r.error.code || "payment_failed");
          return r.paymentIntent;
        }
        const r = await stripe.confirmCardPayment(clientSecret, { payment_method: choice });
        if (r.error) throw payFail(stripeMessage(r.error), r.error.code || "payment_failed");
        return r.paymentIntent;
      },
    });
    return () => register(null);
  }, [stripe, elements, clientSecret, choice, register]);
  return children;
}

/**
 * The Payment step of checkout.
 *  - Stripe configured: Payment Element (cards, Apple Pay, Google Pay; 3-D Secure handled by Stripe.js, no redirect) or a saved card.
 *  - No Stripe keys but the development mock is on: the amber "TEST payment" notice, exactly as before.
 *  - Nothing configured: a clear "cannot pay right now" message.
 * The parent calls ref.pay() when the customer presses "Pay and place order"; it resolves to { intentId } (or { none:true } when no card is needed).
 */
const PaymentSection = forwardRef(function PaymentSection({ quoteBody, quoteReady, cardAmount, onState }, ref) {
  const [cfg, setCfg] = useState(null);
  const [cards, setCards] = useState([]);
  const [choice, setChoice] = useState("new");
  const [saveCard, setSaveCard] = useState(false);
  const [intent, setIntent] = useState(null); // { intentId, clientSecret, mock }
  const [intentErr, setIntentErr] = useState("");
  const [creating, setCreating] = useState(false);
  const [ready, setReady] = useState(false);
  const [elementErr, setElementErr] = useState("");
  const [stripeFail, setStripeFail] = useState("");
  const confirmer = useRef(null);
  const pending = useRef(null);
  const confirmed = useRef(null); // intent id whose payment already went through (the card was charged)
  const [paidId, setPaidId] = useState(null); // the same, for rendering
  const intentRef = useRef(null);
  intentRef.current = intent;
  const seq = useRef(0);
  const touched = useRef(false);
  const lastChoice = useRef("new");

  useEffect(() => {
    getPaymentsConfig().then(setCfg);
  }, []);
  const stripeMode = cfg?.provider === "stripe";
  const mockMode = cfg?.provider === "mock";
  const needsCard = cardAmount > 0.009;

  const loadCards = useCallback(() => {
    sfHttp.get("/customer/cards").then((r) => setCards(r?.data || [])).catch(() => setCards([]));
  }, []);
  useEffect(() => {
    if (stripeMode) loadCards();
  }, [stripeMode, loadCards]);
  useEffect(() => {
    // pick the default saved card the first time cards arrive
    if (cards.length && choice === "new" && !touched.current) setChoice((cards.find((c) => c.isDefault) || cards[0]).id);
  }, [cards]); // eslint-disable-line react-hooks/exhaustive-deps
  const stripePromise = useMemo(() => (stripeMode ? getStripe(cfg.publishableKey).catch((e) => { setStripeFail("The secure payment form could not be loaded. Check your connection or disable content blockers, then try again."); return null; }) : null), [stripeMode, cfg?.publishableKey]);

  // ---- keep one PaymentIntent in step with the current quote
  const bodyKey = JSON.stringify(quoteBody || {});
  const makeIntent = useCallback(
    async (opts = {}) => {
      const my = ++seq.current;
      setCreating(true);
      setIntentErr("");
      const run = (async () => {
        const cur = intentRef.current;
        const body = { ...(quoteBody || {}), saveCard: choice === "new" && saveCard ? true : undefined, paymentMethodId: choice !== "new" ? choice : undefined, intentId: !opts.fresh && cur && lastChoice.current === choice ? cur.intentId : undefined };
        lastChoice.current = choice;
        const r = await sfHttp.post("/customer/payments/intent", body);
        if (my !== seq.current) return null;
        if (r.required === false) {
          setIntent(null);
          return r;
        }
        const next = { intentId: r.intentId, clientSecret: r.clientSecret, mock: !!r.mock };
        if (!cur || cur.intentId !== next.intentId) {
          confirmed.current = null;
          setPaidId(null);
          setReady(false);
        } else if (r.updated && confirmer.current?.elements) {
          confirmer.current.elements.fetchUpdates?.().catch(() => undefined);
        }
        // the customer has already paid for exactly this cart (an earlier try failed after the card was charged): no second payment, just place the order
        if (r.alreadyPaid) {
          confirmed.current = r.intentId;
          setPaidId(r.intentId);
        }
        setIntent(next);
        return r;
      })();
      pending.current = run;
      try {
        return await run;
      } catch (e) {
        if (my === seq.current) setIntentErr(errorMessage(e));
        throw e;
      } finally {
        if (my === seq.current) setCreating(false);
      }
    },
    [bodyKey, choice, saveCard] // eslint-disable-line react-hooks/exhaustive-deps
  );

  useEffect(() => {
    if (!cfg || !(stripeMode || mockMode) || !quoteReady || !needsCard) return undefined;
    const t = setTimeout(() => makeIntent().catch(() => undefined), 400);
    return () => clearTimeout(t);
  }, [cfg, stripeMode, mockMode, quoteReady, needsCard, bodyKey, choice, saveCard]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    onState?.({ provider: cfg?.provider, stripeReady: stripeMode ? !!intent && (choice !== "new" || ready || paidId === intent.intentId) : true, loading: !cfg || creating, error: intentErr || stripeFail });
  }, [cfg, stripeMode, intent, choice, ready, paidId, creating, intentErr, stripeFail]); // eslint-disable-line react-hooks/exhaustive-deps

  const register = useCallback((c) => {
    confirmer.current = c;
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      /** Confirm the payment with Stripe (3-D Secure included) and return what POST /customer/orders needs. */
      async pay() {
        if (!needsCard) return { none: true };
        if (!cfg || cfg.provider === "none") throw payFail("Card payments are not available right now. Please try again later.", "unavailable");
        try {
          await pending.current; // a quote change may still be updating the intent
        } catch (e) {
          throw payFail(errorMessage(e), errorCode(e) || "intent");
        }
        const cur = intentRef.current;
        if (!cur) throw payFail("The payment form is not ready yet. Please wait a moment.", "not_ready");
        if (cur.mock) return { intentId: cur.intentId, mock: true };
        if (confirmed.current === cur.intentId) return { intentId: cur.intentId }; // already paid (a previous try failed after the card was charged): do not charge again
        if (!confirmer.current) throw payFail("The secure payment form is still loading. Please wait a moment.", "not_ready");
        const pi = await confirmer.current.confirm();
        // "succeeded" = the card was charged just now; "requires_capture" only for an intent created by an older version of the page
        if (pi.status === "succeeded" || pi.status === "requires_capture") {
          confirmed.current = pi.id;
          setPaidId(pi.id);
          return { intentId: pi.id };
        }
        if (pi.status === "processing") throw payFail("Your payment is still processing. Please wait a moment and try again.", "processing");
        if (pi.status === "requires_action" || pi.status === "requires_confirmation") throw payFail("Your bank needs you to verify this payment. Please try again.", "action");
        throw payFail("Your payment was not completed. Please try again.", pi.status || "payment_failed");
      },
      /** The server refused the old intent (the price changed): start over with a new one. */
      async reset() {
        confirmed.current = null;
        setPaidId(null);
        setReady(false);
        setIntent(null);
        await makeIntent({ fresh: true }).catch(() => undefined);
      },
      cardsChanged: loadCards,
    }),
    [cfg, needsCard, makeIntent, loadCards]
  );

  if (!cfg) return <div className="sf-muted"><Spinner size={16} /> Loading payment options...</div>;

  if (cfg.provider === "none") {
    return (
      <Notice tone="danger" icon="bank-card-line">
        <b data-testid="pay-unavailable">Card payments are not available right now.</b> {cfg.unreachable ? "We could not reach the payment service. Please try again in a moment." : "Please try again later."}
      </Notice>
    );
  }

  if (mockMode) {
    return (
      <>
        <Notice tone="warn" icon="bank-card-line">
          <b data-testid="test-payment">TEST payment (no Stripe keys configured).</b> No real card is charged. This site is running with the development mock payment provider until the Stripe keys are added by an administrator.
        </Notice>
        {needsCard ? (
          <div className="sf-paycard">
            <Ri name="bank-card-line" /> <b>Test card</b> <span className="sf-muted">- mock payment of ${cardAmount.toFixed(2)}</span>
          </div>
        ) : (
          <p className="sf-small sf-muted mt-2 mb-0">Your wallet credit covers this order. No card is needed.</p>
        )}
      </>
    );
  }

  // ---- Stripe
  if (!needsCard) {
    return (
      <Notice tone="success" icon="wallet-3-line">
        <span data-testid="pay-wallet-only">Your wallet credit covers this order. No card is needed.</span>
      </Notice>
    );
  }
  return (
    <div data-testid="stripe-payment">
      {cfg.mode === "test" && (
        <Notice tone="warn" icon="flask-line" className="mb-2">
          <b data-testid="test-mode-banner">Test mode.</b> Pay with the test card 4242 4242 4242 4242, any future expiry and any CVC. No real money moves.
        </Notice>
      )}
      {cards.length > 0 && (
        <div className="sf-list mb-2" role="radiogroup" aria-label="Saved cards">
          {cards.map((c) => (
            <button key={c.id} type="button" role="radio" aria-checked={choice === c.id} className={`sf-listbtn ${choice === c.id ? "on" : ""}`} onClick={() => { touched.current = true; setChoice(c.id); }} data-testid="saved-card">
              <Ri name={choice === c.id ? "radio-button-line" : "checkbox-blank-circle-line"} />
              <span><b>{brandName(c.brand)}</b> ending {c.last4} <span className="sf-muted sf-small">expires {String(c.expMonth).padStart(2, "0")}/{String(c.expYear).slice(-2)}{c.isDefault ? " - default" : ""}</span></span>
            </button>
          ))}
          <button type="button" role="radio" aria-checked={choice === "new"} className={`sf-listbtn ${choice === "new" ? "on" : ""}`} onClick={() => { touched.current = true; setChoice("new"); }} data-testid="new-card">
            <Ri name={choice === "new" ? "radio-button-line" : "checkbox-blank-circle-line"} /> <span>Use a different card or wallet</span>
          </button>
        </div>
      )}
      {stripeFail && <Notice tone="danger" className="mb-2">{stripeFail} <button type="button" className="sf-btn sf-btn-sm sf-btn-light ms-2" onClick={() => window.location.reload()}>Reload</button></Notice>}
      {intentErr && (
        <Notice tone="danger" className="mb-2">
          <span data-testid="intent-error">{intentErr}</span>{" "}
          <button type="button" className="sf-btn sf-btn-sm sf-btn-light ms-2" onClick={() => makeIntent({ fresh: true }).catch(() => undefined)}>Try again</button>
        </Notice>
      )}
      {!intent && !intentErr && !stripeFail && (
        <div className="sf-muted" data-testid="pay-preparing"><Spinner size={16} /> Preparing the secure payment form...</div>
      )}
      {intent && paidId === intent.intentId && (
        <Notice tone="success" icon="bank-card-line" className="mb-2">
          <span data-testid="pay-received">Your payment of ${cardAmount.toFixed(2)} was received. Press the button to finish placing your order. You will not be charged again.</span>
        </Notice>
      )}
      {intent && paidId !== intent.intentId && stripePromise && (
        <Elements key={intent.intentId} stripe={stripePromise} options={{ clientSecret: intent.clientSecret, appearance: STRIPE_APPEARANCE }}>
          <Confirmer clientSecret={intent.clientSecret} choice={choice} register={register}>
            {choice === "new" ? (
              <>
                {!ready && !stripeFail && <div className="sf-muted"><Spinner size={16} /> Loading secure payment form...</div>}
                <div className="sf-stripe-el" data-testid="payment-element" style={{ display: ready ? "block" : "none" }}>
                  <PaymentElement onReady={() => setReady(true)} onLoadError={() => setStripeFail("The secure payment form could not be loaded. Please reload the page.")} options={{ layout: "tabs" }} />
                </div>
                {ready && (
                  <label className="sf-check mt-2">
                    <input type="checkbox" checked={saveCard} onChange={(e) => setSaveCard(e.target.checked)} data-testid="save-card" /> Save this card for next time
                  </label>
                )}
                {elementErr && <div className="sf-error">{elementErr}</div>}
              </>
            ) : (
              <p className="sf-small sf-muted mb-0">Your card is charged when you place the order. If your bank asks, you will be able to verify the payment here.</p>
            )}
          </Confirmer>
        </Elements>
      )}
      <p className="sf-small sf-muted mt-2 mb-0">
        <Ri name="lock-line" /> Secure payment by Stripe. FORKSY never sees your card number. Your card is <b>charged</b> when you place the order, and refunded in full if the restaurant cannot take it.
      </p>
    </div>
  );
});

export default PaymentSection;
