/**
 * Storefront payments helpers: the public payment configuration (Stripe publishable key / mock / none) and the Stripe.js loader.
 * Card details are typed into Stripe's own iframes (Payment Element): they never reach FORKSY's page code or API.
 * Stripe.js is loaded from https://js.stripe.com by the official loader; the CSP allows exactly that (see docs/security-frontend.md).
 */
// the "pure" entry: Stripe.js is downloaded only when loadStripe() is called (checkout / wallet), never when a page merely imports this file
import { loadStripe } from "@stripe/stripe-js/pure";
import { sfHttp } from "./sfApi";

let cfgPromise = null;
/** { provider: 'stripe'|'mock'|'none', publishableKey, mode, mock, walletEnabled, giftCardsEnabled, topUp:{min,max}, addressSearch } */
export function getPaymentsConfig(force = false) {
  if (!cfgPromise || force) {
    cfgPromise = sfHttp
      .get("/public/payments/config", undefined, { noAuth: true })
      .catch(() => {
        cfgPromise = null;
        return { provider: "none", unreachable: true };
      });
  }
  return cfgPromise;
}

const stripes = {};
/** One Stripe.js instance per publishable key; resolves to null when Stripe.js cannot be loaded (blocked / offline). */
export function getStripe(publishableKey) {
  if (!publishableKey) return Promise.resolve(null);
  if (!stripes[publishableKey]) {
    stripes[publishableKey] = loadStripe(publishableKey).catch((e) => {
      delete stripes[publishableKey];
      throw e;
    });
  }
  return stripes[publishableKey];
}

/** Brand look for the Payment Element. */
export const STRIPE_APPEARANCE = {
  theme: "stripe",
  variables: { colorPrimary: "#f95a16", colorText: "#201a17", colorDanger: "#c0392b", borderRadius: "12px", fontFamily: "Inter, system-ui, sans-serif", spacingUnit: "4px" },
};

/** A readable message for a Stripe.js error object. Never shows raw codes to customers. */
export function stripeMessage(err) {
  if (!err) return "The payment could not be completed. Please try again.";
  switch (err.code) {
    case "card_declined":
      return err.decline_code === "insufficient_funds" ? "Your card has insufficient funds. Please use another card." : "Your card was declined. Please use another card or payment method.";
    case "expired_card":
      return "Your card has expired. Please use another card.";
    case "incorrect_cvc":
    case "invalid_cvc":
      return "The security code (CVC) is not correct.";
    case "incorrect_number":
    case "invalid_number":
      return "The card number is not correct.";
    case "processing_error":
      return "Your bank could not process the card. Please try again or use another card.";
    case "payment_intent_authentication_failure":
      return "We could not verify this payment with your bank (3-D Secure). Please try again or use another card.";
    default:
      return err.message || "The payment could not be completed. Please try again.";
  }
}

/** Error with a machine code the page reacts to. */
export function payFail(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}
