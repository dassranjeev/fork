import React, { useEffect, useMemo, useRef, useState } from "react";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { STRIPE_APPEARANCE, getPaymentsConfig, getStripe, stripeMessage } from "../lib/payments";
import { errorMessage, money, sfHttp } from "../lib/sfApi";
import { Notice, Spinner } from "./ui";

/**
 * One self-contained payment: create a PaymentIntent (or SetupIntent) on the server, show the Stripe Payment Element, confirm it on the
 * page (no redirect), then tell the server so it can credit the wallet / issue the gift card / save the card.
 *   kind "payment": POST createUrl -> { intentId, clientSecret, mock } ; confirm -> POST confirmUrl { paymentIntentId }
 *   kind "setup"  : POST createUrl -> { clientSecret, mock } ; Stripe saves the card (webhook sets the default)
 */
function Form({ kind, clientSecret, intentId, confirmUrl, label, amount, onDone, onCancel }) {
  const stripe = useStripe();
  const elements = useElements();
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const lock = useRef(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!stripe || !elements || lock.current) return;
    lock.current = true;
    setBusy(true);
    setErr("");
    try {
      const s = await elements.submit();
      if (s.error) throw new Error(stripeMessage(s.error));
      const ret = { return_url: `${window.location.origin}/order/wallet` };
      if (kind === "setup") {
        const r = await stripe.confirmSetup({ elements, clientSecret, confirmParams: ret, redirect: "if_required" });
        if (r.error) throw new Error(stripeMessage(r.error));
        onDone({ setupIntent: r.setupIntent });
      } else {
        const r = await stripe.confirmPayment({ elements, clientSecret, confirmParams: ret, redirect: "if_required" });
        if (r.error) throw new Error(stripeMessage(r.error));
        if (r.paymentIntent.status !== "succeeded") throw new Error("Your payment is still processing. Check your wallet in a moment.");
        const result = await sfHttp.post(confirmUrl, { paymentIntentId: r.paymentIntent.id });
        onDone(result);
      }
    } catch (e2) {
      setErr(e2?.response ? errorMessage(e2) : e2.message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} data-testid="pay-form">
      {!ready && <div className="sf-muted"><Spinner size={16} /> Loading secure payment form...</div>}
      <div style={{ display: ready ? "block" : "none" }} data-testid="payment-element">
        <PaymentElement onReady={() => setReady(true)} options={{ layout: "tabs" }} />
      </div>
      {err && <Notice tone="danger" className="mt-2"><span data-testid="pay-error">{err}</span></Notice>}
      <div className="d-flex gap-2 mt-3">
        <button type="submit" className="sf-btn sf-btn-primary" disabled={!ready || busy} data-testid="pay-submit">
          {busy ? <Spinner size={16} /> : null} {busy ? "Processing..." : label || (amount ? `Pay ${money(amount)}` : "Save card")}
        </button>
        <button type="button" className="sf-btn sf-btn-light" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </form>
  );
}

export default function PayPanel({ kind = "payment", createUrl, body, confirmUrl, label, amount, onDone, onCancel }) {
  const [cfg, setCfg] = useState(null);
  const [intent, setIntent] = useState(null);
  const [err, setErr] = useState("");
  const [fail, setFail] = useState("");
  const bodyRef = useRef(body);
  bodyRef.current = body;

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const c = await getPaymentsConfig();
        if (!live) return;
        setCfg(c);
        if (c.provider === "none") return;
        const r = await sfHttp.post(createUrl, bodyRef.current || {});
        if (live) setIntent(r);
      } catch (e) {
        if (live) setErr(errorMessage(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [createUrl]);

  const stripePromise = useMemo(() => (cfg?.provider === "stripe" ? getStripe(cfg.publishableKey).catch(() => { setFail("The secure payment form could not be loaded. Check your connection or disable content blockers."); return null; }) : null), [cfg]);

  if (err) return <Notice tone="danger">{err} <button type="button" className="sf-btn sf-btn-sm sf-btn-light ms-2" onClick={onCancel}>Close</button></Notice>;
  if (!cfg || (!intent && cfg.provider !== "none")) return <div className="sf-muted"><Spinner size={16} /> Preparing...</div>;
  if (cfg.provider === "none") return <Notice tone="danger">Payments are not available right now. Please try again later.</Notice>;

  if (intent.mock) {
    return (
      <div>
        <Notice tone="warn"><b data-testid="test-payment">TEST payment (no Stripe keys configured).</b> No real card is charged.</Notice>
        <MockConfirm kind={kind} intent={intent} confirmUrl={confirmUrl} label={label} amount={amount} onDone={onDone} onCancel={onCancel} />
      </div>
    );
  }
  return (
    <div>
      {cfg.mode === "test" && <Notice tone="warn" className="mb-2"><b>Test mode.</b> Use card 4242 4242 4242 4242, any future expiry, any CVC.</Notice>}
      {fail && <Notice tone="danger" className="mb-2">{fail}</Notice>}
      {stripePromise && (
        <Elements stripe={stripePromise} options={{ clientSecret: intent.clientSecret, appearance: STRIPE_APPEARANCE }}>
          <Form kind={kind} clientSecret={intent.clientSecret} intentId={intent.intentId} confirmUrl={confirmUrl} label={label} amount={amount} onDone={onDone} onCancel={onCancel} />
        </Elements>
      )}
    </div>
  );
}

function MockConfirm({ kind, intent, confirmUrl, label, amount, onDone, onCancel }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const go = async () => {
    setBusy(true);
    setErr("");
    try {
      onDone(kind === "setup" ? { mock: true } : await sfHttp.post(confirmUrl, { paymentIntentId: intent.intentId }));
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-2">
      {err && <Notice tone="danger" className="mb-2">{err}</Notice>}
      <button type="button" className="sf-btn sf-btn-primary" onClick={go} disabled={busy} data-testid="pay-submit">{busy ? <Spinner size={16} /> : null} {label || (amount ? `Pay ${money(amount)} (test)` : "Save test card")}</button>{" "}
      <button type="button" className="sf-btn sf-btn-light" onClick={onCancel}>Cancel</button>
    </div>
  );
}
