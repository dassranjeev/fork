import React from "react";
import { FormModal, NumberInput, TextArea } from "../../ui";
import { http } from "../../lib/api";
import { useForm, useSubmit } from "../../lib/hooks";
import { money } from "../../lib/format";

/** Adjust a payout's amount (allowed while its batch is DRAFT / LOCKED). */
export default function PayoutAdjustModal({ payout, onClose, onDone }) {
  const f = useForm({ amount: "", reason: "" });
  const { busy, run } = useSubmit();
  const v = f.values;
  return (
    <FormModal
      open
      onClose={onClose}
      title={`Adjust payout - ${payout.partyName}`}
      busy={busy}
      submitText="Apply adjustment"
      disabled={v.amount === "" || Number(v.amount) === 0 || v.reason.trim().length < 3}
      onSubmit={() => run(() => http.post(`/admin/finance/payouts/${payout.id}/adjust`, { amount: Number(v.amount), reason: v.reason }), { success: "Payout adjusted", onDone })}
    >
      <p className="text-secondary-light text-sm">Current net {money(payout.net)}. Use a negative amount to reduce the payout.</p>
      <NumberInput label="Adjustment" prefix="$" step="0.01" required {...f.bind("amount")} />
      <TextArea label="Reason" required {...f.bind("reason")} />
    </FormModal>
  );
}
