import React from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Ri } from "../components/ui";

/**
 * Where Stripe sends a driver (or a restaurant owner) after the hosted payout-account onboarding.
 * Public page, no sign-in: it only explains what happened. The real state is read from Stripe by the API (webhook / sync).
 * The driver app will deep-link here later (the app opens this URL in a browser for now).
 */
export default function PayoutReturn() {
  const [q] = useSearchParams();
  const refresh = q.get("status") === "refresh";
  const who = q.get("for") === "restaurant" ? "restaurant" : "driver";
  return (
    <div className="sf-container sf-narrow">
      <div className="sf-center py-5" data-testid="payout-return">
        <Ri name={refresh ? "refresh-line" : "checkbox-circle-line"} className="sf-bigicon" />
        <h1 className="sf-h2 mt-2">{refresh ? "That link has expired" : "Thanks, your payout account is being checked"}</h1>
        {refresh ? (
          <p className="sf-muted">The secure setup link can only be used once and for a short time. Go back to the FORKSY {who === "driver" ? "driver app" : "restaurant portal"} and tap <b>Continue payout setup</b> to get a new one.</p>
        ) : (
          <>
            <p className="sf-muted">Stripe is verifying your details. This usually takes a few minutes; we update your account automatically and start sending your payouts once it is ready.</p>
            <p className="sf-muted">You can close this page and return to the FORKSY {who === "driver" ? "driver app" : "restaurant portal"}. If the app does not open by itself, open it manually: your payout account status refreshes there.</p>
          </>
        )}
        <Link to="/order" className="sf-btn sf-btn-light">Go to FORKSY</Link>
      </div>
    </div>
  );
}
