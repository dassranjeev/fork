import React, { useCallback, useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import PayPanel from "../components/PayPanel";
import { ErrorBox, Loading, Notice, Ri, useToast } from "../components/ui";
import { getPaymentsConfig } from "../lib/payments";
import { errorMessage, money, sfHttp } from "../lib/sfApi";
import { useSfAuth } from "../lib/SfAuth";

const PRESETS = [10, 25, 50, 100];
const brandName = (b) => ({ visa: "Visa", mastercard: "Mastercard", amex: "American Express" }[b] || String(b || "Card").replace(/^./, (c) => c.toUpperCase()));

export default function Wallet() {
  const { user, loading } = useSfAuth();
  const toast = useToast();
  const [cfg, setCfg] = useState(null);
  const [balance, setBalance] = useState(null);
  const [txs, setTxs] = useState([]);
  const [cards, setCards] = useState(null);
  const [error, setError] = useState("");
  const [amount, setAmount] = useState(25);
  const [custom, setCustom] = useState("");
  const [topping, setTopping] = useState(false);
  const [addCard, setAddCard] = useState(false);
  const [code, setCode] = useState("");
  const [gcAmount, setGcAmount] = useState(25);
  const [gcEmail, setGcEmail] = useState("");
  const [gcBuy, setGcBuy] = useState(false);
  const [gcResult, setGcResult] = useState(null);
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    try {
      const [w, c] = await Promise.all([sfHttp.get("/customer/wallet", { limit: 10 }), sfHttp.get("/customer/cards").catch(() => ({ data: [] }))]);
      setBalance(Number(w.balance ?? 0));
      setTxs(w.transactions?.data || []);
      setCards(c.data || []);
      setError("");
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);
  useEffect(() => {
    if (user) {
      load();
      getPaymentsConfig().then(setCfg);
    }
  }, [user, load]);

  if (loading) return <div className="sf-container"><Loading /></div>;
  if (!user) return <Navigate to="/order/login?next=/order/wallet" replace />;

  const topAmount = custom ? Math.round(Number(custom) * 100) / 100 : amount;
  const min = cfg?.topUp?.min ?? 5;
  const max = cfg?.topUp?.max ?? 500;
  const topOk = Number.isFinite(topAmount) && topAmount >= min && topAmount <= max;

  const redeem = async (e) => {
    e.preventDefault();
    try {
      const r = await sfHttp.post("/customer/wallet/redeem-gift-card", { code: code.trim() });
      toast(`${money(r.amount)} added to your wallet`, "success");
      setCode("");
      load();
    } catch (err) {
      toast(errorMessage(err), "danger");
    }
  };

  return (
    <div className="sf-container sf-narrow">
      <h1 className="sf-h1">Wallet and cards</h1>
      {error && <ErrorBox message={error} onRetry={load} />}
      {note && <Notice tone="success" className="mb-3"><span data-testid="wallet-note">{note}</span></Notice>}

      <section className="sf-card sf-pad sf-section">
        <h2 className="sf-h3"><Ri name="wallet-3-line" /> FORKSY wallet</h2>
        <div className="sf-bigprice" data-testid="wallet-balance">{balance === null ? "..." : money(balance)}</div>
        <p className="sf-small sf-muted">Wallet credit is used at checkout before your card.</p>
        {cfg?.walletEnabled !== false && (
          topping ? (
            <PayPanel
              kind="payment"
              createUrl="/customer/wallet/top-up-intent"
              body={{ amount: topAmount }}
              confirmUrl="/customer/wallet/top-up/confirm"
              amount={topAmount}
              label={`Add ${money(topAmount)} to my wallet`}
              onCancel={() => setTopping(false)}
              onDone={(r) => {
                setTopping(false);
                setNote(r.status === "credited" ? `${money(r.amount)} was added to your wallet.` : "Your payment was received.");
                load();
              }}
            />
          ) : (
            <>
              <div className="sf-chips-sm" role="radiogroup" aria-label="Top-up amount">
                {PRESETS.map((p) => (
                  <button key={p} type="button" role="radio" aria-checked={!custom && amount === p} className={`sf-chip ${!custom && amount === p ? "on" : ""}`} onClick={() => { setAmount(p); setCustom(""); }}>{money(p)}</button>
                ))}
                <input className="sf-input" style={{ maxWidth: 130 }} inputMode="decimal" placeholder="Other" aria-label="Other amount" value={custom} onChange={(e) => setCustom(e.target.value.replace(/[^0-9.]/g, ""))} data-testid="topup-custom" />
              </div>
              {!topOk && <div className="sf-error">Top-ups are between {money(min)} and {money(max)}.</div>}
              <button type="button" className="sf-btn sf-btn-primary mt-2" disabled={!topOk || cfg?.provider === "none"} onClick={() => setTopping(true)} data-testid="topup-start">Add {topOk ? money(topAmount) : "money"} to wallet</button>
            </>
          )
        )}
        {txs.length > 0 && (
          <ul className="sf-list mt-3" aria-label="Recent wallet activity">
            {txs.map((t) => <li key={t.id} className="sf-row-between sf-small"><span>{t.note || t.type}</span><b className={Number(t.amount) < 0 ? "" : "sf-ok"}>{Number(t.amount) < 0 ? "-" : "+"}{money(Math.abs(t.amount))}</b></li>)}
          </ul>
        )}
      </section>

      <section className="sf-card sf-pad sf-section">
        <h2 className="sf-h3"><Ri name="gift-line" /> Gift cards</h2>
        <form onSubmit={redeem} className="sf-inline">
          <input className="sf-input" placeholder="Gift card code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={40} aria-label="Gift card code" />
          <button type="submit" className="sf-btn sf-btn-light" disabled={code.trim().length < 6}>Redeem</button>
        </form>
        {cfg?.giftCardsEnabled !== false && (
          <div className="mt-3">
            <h3 className="sf-h3">Buy a gift card</h3>
            {gcResult ? (
              <Notice tone="success"><span data-testid="gc-code">Gift card ready. Code: <b>{gcResult.giftCard?.code}</b></span> {gcEmail ? "(also emailed)" : ""} <button type="button" className="sf-btn sf-btn-sm sf-btn-light ms-2" onClick={() => { setGcResult(null); setGcBuy(false); }}>Done</button></Notice>
            ) : gcBuy ? (
              <PayPanel kind="payment" createUrl="/customer/gift-cards/purchase-intent" body={{ amount: gcAmount, recipientEmail: gcEmail || undefined }} confirmUrl="/customer/gift-cards/purchase/confirm" amount={gcAmount} onCancel={() => setGcBuy(false)} onDone={(r) => { setGcResult(r); load(); }} />
            ) : (
              <>
                <div className="sf-chips-sm" role="radiogroup" aria-label="Gift card amount">
                  {[10, 25, 50, 100].map((p) => <button key={p} type="button" role="radio" aria-checked={gcAmount === p} className={`sf-chip ${gcAmount === p ? "on" : ""}`} onClick={() => setGcAmount(p)}>{money(p)}</button>)}
                </div>
                <div className="sf-field mt-2"><label className="sf-label" htmlFor="gc-mail">Send it to (email, optional)</label><input id="gc-mail" className="sf-input" type="email" value={gcEmail} onChange={(e) => setGcEmail(e.target.value)} maxLength={200} /></div>
                <button type="button" className="sf-btn sf-btn-primary" disabled={cfg?.provider === "none"} onClick={() => setGcBuy(true)} data-testid="gc-start">Buy {money(gcAmount)} gift card</button>
              </>
            )}
          </div>
        )}
      </section>

      <section className="sf-card sf-pad sf-section">
        <h2 className="sf-h3"><Ri name="bank-card-line" /> Saved cards</h2>
        {cards === null ? <Loading /> : cards.length === 0 ? <p className="sf-muted">No saved cards. Tick "Save this card" at checkout, or add one here.</p> : (
          <ul className="sf-list" data-testid="cards-list">
            {cards.map((c) => (
              <li key={c.id} className="sf-row-between">
                <span><b>{brandName(c.brand)}</b> ending {c.last4} <span className="sf-muted sf-small">expires {String(c.expMonth).padStart(2, "0")}/{String(c.expYear).slice(-2)}</span> {c.isDefault && <span className="sf-tag sf-tag-ok">Default</span>}</span>
                <span className="d-flex gap-2">
                  {!c.isDefault && <button type="button" className="sf-btn sf-btn-sm sf-btn-light" onClick={async () => { try { await sfHttp.post(`/customer/cards/${c.id}/default`); load(); } catch (e) { toast(errorMessage(e), "danger"); } }}>Make default</button>}
                  <button type="button" className="sf-btn sf-btn-sm sf-btn-light" onClick={async () => { try { await sfHttp.del(`/customer/cards/${c.id}`); load(); } catch (e) { toast(errorMessage(e), "danger"); } }}>Remove</button>
                </span>
              </li>
            ))}
          </ul>
        )}
        {addCard ? (
          <PayPanel kind="setup" createUrl="/customer/cards/setup-intent" onCancel={() => setAddCard(false)} onDone={() => { setAddCard(false); setTimeout(load, 800); }} />
        ) : (
          <button type="button" className="sf-btn sf-btn-light mt-2" disabled={cfg?.provider === "none"} onClick={() => setAddCard(true)} data-testid="add-card">Add a card</button>
        )}
      </section>
    </div>
  );
}
